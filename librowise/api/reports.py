"""Reports. Unlike Koha's free-form SQL reports, every report here is a vetted, parameterised
query — no user-supplied SQL ever reaches the database. Any report can be exported as CSV."""

from __future__ import annotations

import csv
import io
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..ai import copilot, insights
from ..db import get_db
from ..deps import require
from ..models import Biblio, Branch, Item, ItemType, Loan, Patron, PatronCategory, utcnow
from ..schemas import money
from ..security import has_permission

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), _: Patron = Depends(require("reports:read"))):
    stats = copilot.tool_library_stats(db)
    trend = copilot.tool_circulation_trend(db, 30)
    since = utcnow() - timedelta(days=30)
    by_branch = db.execute(
        select(Branch.name, func.count(Loan.id)).join(Loan, Loan.branch_id == Branch.id)
        .where(Loan.issued_at >= since).group_by(Branch.name)).all()
    by_type = db.execute(
        select(Biblio.material_type, func.count(Biblio.id)).where(Biblio.deleted_at.is_(None))
        .group_by(Biblio.material_type)).all()
    return {"stats": stats, "trend": trend["checkouts_per_day"],
            "by_branch": [{"label": n, "value": c} for n, c in by_branch],
            "by_material": [{"label": n, "value": c} for n, c in by_type],
            "top_titles": copilot.tool_popular_titles(db, 30, 8)["titles"],
            "risk": insights.overdue_risk(db, 5)}


def _report_rows(db: Session, name: str, days: int) -> tuple[list[str], list[list]]:
    since = utcnow() - timedelta(days=days)
    if name == "overdues":
        now = utcnow()
        rows = db.scalars(select(Loan).where(Loan.returned_at.is_(None), Loan.due_at < now).order_by(Loan.due_at))
        return (["Barcode", "Title", "Patron", "Card", "Due", "Days overdue"],
                [[l.item.barcode, l.item.biblio.title, l.patron.full_name if l.patron else "", l.patron.card_number if l.patron else "",
                  l.due_at.date().isoformat(), (now - l.due_at).days] for l in rows])
    if name == "circulation_by_branch":
        rows = db.execute(select(Branch.name, func.count(Loan.id)).join(Loan, Loan.branch_id == Branch.id)
                          .where(Loan.issued_at >= since).group_by(Branch.name).order_by(func.count(Loan.id).desc()))
        return ["Branch", "Checkouts"], [list(r) for r in rows]
    if name == "circulation_by_category":
        rows = db.execute(select(PatronCategory.name, func.count(Loan.id)).join(Patron, Patron.category_id == PatronCategory.id)
                          .join(Loan, Loan.patron_id == Patron.id).where(Loan.issued_at >= since)
                          .group_by(PatronCategory.name))
        return ["Patron category", "Checkouts"], [list(r) for r in rows]
    if name == "top_titles":
        rows = db.execute(select(Biblio.title, func.count(Loan.id)).join(Item, Item.biblio_id == Biblio.id)
                          .join(Loan, Loan.item_id == Item.id).where(Loan.issued_at >= since)
                          .group_by(Biblio.id, Biblio.title).order_by(func.count(Loan.id).desc()).limit(100))
        return ["Title", "Checkouts"], [list(r) for r in rows]
    if name == "collection_by_type":
        rows = db.execute(select(ItemType.name, Item.status, func.count(Item.id)).join(Item, Item.item_type_id == ItemType.id)
                          .where(Item.deleted_at.is_(None)).group_by(ItemType.name, Item.status))
        return ["Item type", "Status", "Items"], [[t, s.value, n] for t, s, n in rows]
    if name == "fines":
        from ..models import LedgerEntry
        rows = db.execute(select(Patron.card_number, Patron.first_name, Patron.last_name, func.sum(LedgerEntry.amount))
                          .join(LedgerEntry, LedgerEntry.patron_id == Patron.id).group_by(Patron.id)
                          .having(func.sum(LedgerEntry.amount) > 0).order_by(func.sum(LedgerEntry.amount).desc()))
        return ["Card", "First name", "Last name", "Balance"], [[c, f, l, money(b)] for c, f, l, b in rows]
    if name == "weeding":
        rows = insights.weeding_candidates(db, limit=1000)
        return ["Barcode", "Title", "Last borrowed", "Times borrowed"], [
            [r["barcode"], r["title"], r["last_borrowed"] or "never", r["times_borrowed"]] for r in rows]
    raise HTTPException(404, "Unknown report")


REPORTS = {
    "overdues": "Overdue loans",
    "circulation_by_branch": "Checkouts by branch",
    "circulation_by_category": "Checkouts by patron category",
    "top_titles": "Most borrowed titles",
    "collection_by_type": "Collection by item type & status",
    "fines": "Patrons with outstanding charges",
    "weeding": "Weeding candidates (idle 2+ years)",
}


@router.get("")
def list_reports(_: Patron = Depends(require("reports:read"))):
    return {"results": [{"key": k, "name": v} for k, v in REPORTS.items()]}


@router.get("/run/{name}")
def run(name: str, days: int = Query(default=30, ge=1, le=3650), fmt: str = Query(default="json", pattern="^(json|csv)$"),
        db: Session = Depends(get_db), user: Patron = Depends(require("reports:read"))):
    if fmt == "csv" and not has_permission(user, "reports:export"):
        raise HTTPException(403, "Missing permission: reports:export")
    headers, rows = _report_rows(db, name, days)
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(headers)
        for r in rows:
            # neutralise spreadsheet formula injection
            w.writerow([f"'{c}" if isinstance(c, str) and c[:1] in "=+-@" else c for c in r])
        buf.seek(0)
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})
    return {"name": REPORTS.get(name, name), "headers": headers, "rows": rows}


@router.get("/insights/risk")
def risk(db: Session = Depends(get_db), _: Patron = Depends(require("reports:read"))):
    return {"results": insights.overdue_risk(db, 100)}


@router.get("/insights/duplicates")
def duplicates(db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    return {"results": insights.duplicate_candidates(db)}


@router.get("/insights/weeding")
def weeding(db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    return {"results": insights.weeding_candidates(db)}
