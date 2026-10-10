"""Reports. Unlike Koha's free-form SQL reports, every report here is a vetted, parameterised
query — no user-supplied SQL ever reaches the database. Any report can be exported as CSV.

Every report has a catalogue entry (:data:`REPORT_DEFS`: theme group, one-line description, whether it
covers a period or is a point-in-time snapshot) and returns typed column metadata plus per-row
references (record / patron / branch / category ids) so the staff UI can humanise values and link each
row to the screen it is about. The original ``name``/``headers``/``rows`` response keys are unchanged.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import i18n as i18n_mod
from ..ai import copilot, insights
from ..db import get_db
from ..deps import require
from ..models import (
    Biblio,
    Branch,
    Hold,
    HoldStatus,
    Item,
    ItemType,
    LedgerEntry,
    Loan,
    Patron,
    PatronCategory,
    Role,
    utcnow,
)
from ..schemas import money
from ..security import has_permission
from ..services import analytics as svc

router = APIRouter(prefix="/reports", tags=["reports"])


# ------------------------------------------------------------------ catalogue

#: key → name, theme group, one-line description and whether the report is bounded by a period.
REPORT_DEFS: dict[str, dict] = {
    "overdues": {"name": "Overdue loans", "group": "circulation", "dated": False,
                 "description": "Every loan past its due date, oldest first, with the borrower to contact."},
    "circulation_by_branch": {"name": "Checkouts by branch", "group": "circulation", "dated": True,
                              "description": "How many items each branch lent in the period."},
    "circulation_by_category": {"name": "Checkouts by patron category", "group": "circulation", "dated": True,
                                "description": "Which kinds of members borrowed in the period."},
    "top_titles": {"name": "Most borrowed titles", "group": "circulation", "dated": True,
                   "description": "The 100 titles lent most often in the period."},
    "collection_by_type": {"name": "Collection by item type & status", "group": "collection", "dated": False,
                           "description": "Items on the shelf, on loan, in transit or missing, by item type."},
    "weeding": {"name": "Weeding candidates (idle 2+ years)", "group": "collection", "dated": False,
                "description": "Items held two years or more that nobody has borrowed in two years."},
    "expired_patrons": {"name": "Expired memberships", "group": "patrons", "dated": False,
                        "description": "Members whose library card has expired, most recent first."},
    "new_patrons": {"name": "New registrations", "group": "patrons", "dated": True,
                    "description": "Members who joined in the period."},
    "fines": {"name": "Patrons with outstanding charges", "group": "finance", "dated": False,
              "description": "Everyone who owes the library money, largest balance first."},
}
#: Backwards-compatible ``key → name`` mapping.
REPORTS = {k: v["name"] for k, v in REPORT_DEFS.items()}
GROUPS = ("circulation", "collection", "patrons", "finance")


@dataclass(frozen=True)
class Period:
    """Report window: UTC bounds plus the library-local dates they came from (for display)."""

    start_utc: datetime
    end_utc: datetime
    start: date
    end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1


def _period(days: int, start: date | None, end: date | None) -> Period:
    """``start``/``end`` (library-local, inclusive) win over the legacy ``days`` window."""
    try:
        w = svc.make_window(start, end) if (start or end) else svc.make_window(
            svc.local_today() - timedelta(days=days - 1), svc.local_today())
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return Period(w.start_utc, w.end_utc, w.start, w.end)


def _col(key: str, label: str, type_: str = "text", link: str | None = None, **extra) -> dict:
    out = {"key": key, "label": label, "type": type_, **extra}
    if link:
        out["link"] = link
    return out


def _report(db: Session, name: str, p: Period, branch_id: int | None) -> dict:
    """``{"columns": [...], "rows": [[...]], "refs": [{...}]}`` for one report."""
    if name == "overdues":
        now = utcnow()
        stmt = (select(Loan.id, Loan.due_at, Loan.patron_id, Item.id, Item.barcode, Biblio.id, Biblio.title,
                       Patron.first_name, Patron.last_name, Patron.card_number)
                .join(Item, Item.id == Loan.item_id).join(Biblio, Biblio.id == Item.biblio_id)
                .outerjoin(Patron, Patron.id == Loan.patron_id)
                .where(Loan.returned_at.is_(None), Loan.due_at < now).order_by(Loan.due_at))
        if branch_id:
            stmt = stmt.where(Loan.branch_id == branch_id)
        rows, refs = [], []
        for _lid, due, pid, iid, barcode, bid, title, fn, ln, card in db.execute(stmt):
            rows.append([barcode, title, f"{fn or ''} {ln or ''}".strip(), card or "", due.date().isoformat(), (now - due).days])
            refs.append({"biblio": bid, "patron": pid, "item": iid})
        return {"columns": [_col("barcode", "Barcode", "code", "biblio"), _col("title", "Title", "text", "biblio"),
                            _col("patron", "Patron", "text", "patron"), _col("card", "Card", "code", "patron"),
                            _col("due", "Due", "date"), _col("days_overdue", "Days overdue", "number")],
                "rows": rows, "refs": refs}
    if name == "circulation_by_branch":
        stmt = (select(Branch.id, Branch.name, func.count(Loan.id)).join(Loan, Loan.branch_id == Branch.id)
                .where(Loan.issued_at >= p.start_utc, Loan.issued_at < p.end_utc)
                .group_by(Branch.id, Branch.name).order_by(func.count(Loan.id).desc()))
        if branch_id:
            stmt = stmt.where(Branch.id == branch_id)
        data = db.execute(stmt).all()
        return {"columns": [_col("branch", "Branch", "text", "branch"), _col("checkouts", "Checkouts", "number")],
                "rows": [[n, c] for _, n, c in data], "refs": [{"branch": i} for i, _, _ in data]}
    if name == "circulation_by_category":
        stmt = (select(PatronCategory.id, PatronCategory.name, func.count(Loan.id))
                .join(Patron, Patron.category_id == PatronCategory.id).join(Loan, Loan.patron_id == Patron.id)
                .where(Loan.issued_at >= p.start_utc, Loan.issued_at < p.end_utc)
                .group_by(PatronCategory.id, PatronCategory.name).order_by(func.count(Loan.id).desc()))
        if branch_id:
            stmt = stmt.where(Loan.branch_id == branch_id)
        data = db.execute(stmt).all()
        return {"columns": [_col("category", "Patron category", "text", "category"), _col("checkouts", "Checkouts", "number")],
                "rows": [[n, c] for _, n, c in data], "refs": [{"category": i} for i, _, _ in data]}
    if name == "top_titles":
        stmt = (select(Biblio.id, Biblio.title, func.count(Loan.id)).join(Item, Item.biblio_id == Biblio.id)
                .join(Loan, Loan.item_id == Item.id).where(Loan.issued_at >= p.start_utc, Loan.issued_at < p.end_utc)
                .group_by(Biblio.id, Biblio.title).order_by(func.count(Loan.id).desc()).limit(100))
        if branch_id:
            stmt = stmt.where(Loan.branch_id == branch_id)
        data = db.execute(stmt).all()
        return {"columns": [_col("title", "Title", "text", "biblio"), _col("checkouts", "Checkouts", "number")],
                "rows": [[t, c] for _, t, c in data], "refs": [{"biblio": i} for i, _, _ in data]}
    if name == "collection_by_type":
        stmt = (select(ItemType.name, Item.status, func.count(Item.id)).join(Item, Item.item_type_id == ItemType.id)
                .where(Item.deleted_at.is_(None)).group_by(ItemType.name, Item.status).order_by(ItemType.name))
        if branch_id:
            stmt = stmt.where(Item.branch_id == branch_id)
        data = db.execute(stmt).all()
        return {"columns": [_col("item_type", "Item type"), _col("status", "Status", "status", kind="item"),
                            _col("items", "Items", "number")],
                "rows": [[t, s.value, n] for t, s, n in data], "refs": [{} for _ in data]}
    if name == "fines":
        stmt = (select(Patron.id, Patron.card_number, Patron.first_name, Patron.last_name, func.sum(LedgerEntry.amount))
                .join(LedgerEntry, LedgerEntry.patron_id == Patron.id).group_by(Patron.id)
                .having(func.sum(LedgerEntry.amount) > 0).order_by(func.sum(LedgerEntry.amount).desc()))
        if branch_id:
            stmt = stmt.where(Patron.home_branch_id == branch_id)
        data = db.execute(stmt).all()
        return {"columns": [_col("card", "Card", "code", "patron"), _col("first_name", "First name", "text", "patron"),
                            _col("last_name", "Last name", "text", "patron"), _col("balance", "Balance", "money")],
                "rows": [[c, f, ln, money(b)] for _, c, f, ln, b in data], "refs": [{"patron": i} for i, *_ in data]}
    if name == "weeding":
        cands = insights.weeding_candidates(db, limit=1000)
        meta = {i: (b, br) for i, b, br in db.execute(select(Item.id, Item.biblio_id, Item.branch_id)
                                                      .where(Item.id.in_([c["item_id"] for c in cands])))} if cands else {}
        if branch_id:
            cands = [c for c in cands if meta.get(c["item_id"], (None, None))[1] == branch_id]
        return {"columns": [_col("barcode", "Barcode", "code", "biblio"), _col("title", "Title", "text", "biblio"),
                            _col("last_borrowed", "Last borrowed", "date"), _col("times_borrowed", "Times borrowed", "number")],
                "rows": [[c["barcode"], c["title"], c["last_borrowed"] or "never", c["times_borrowed"]] for c in cands],
                "refs": [{"biblio": meta.get(c["item_id"], (None, None))[0], "item": c["item_id"]} for c in cands]}
    if name in ("expired_patrons", "new_patrons"):
        stmt = (select(Patron.id, Patron.card_number, Patron.first_name, Patron.last_name, PatronCategory.name, Branch.name,
                       Patron.expires_on, Patron.created_at)
                .join(PatronCategory, PatronCategory.id == Patron.category_id).join(Branch, Branch.id == Patron.home_branch_id)
                .where(Patron.deleted_at.is_(None), Patron.role == Role.patron))
        if name == "expired_patrons":
            stmt = stmt.where(Patron.expires_on < svc.local_today()).order_by(Patron.expires_on.desc())
        else:
            stmt = stmt.where(Patron.created_at >= p.start_utc, Patron.created_at < p.end_utc).order_by(Patron.created_at.desc())
        if branch_id:
            stmt = stmt.where(Patron.home_branch_id == branch_id)
        data = db.execute(stmt.limit(2000)).all()
        last = (_col("expired_on", "Expired on", "date") if name == "expired_patrons" else _col("registered", "Registered", "date"))
        return {"columns": [_col("name", "Name", "text", "patron"), _col("card", "Card", "code", "patron"),
                            _col("category", "Patron category"), _col("home_branch", "Home branch"), last],
                "rows": [[f"{f} {ln}".strip(), c, cat, br, (exp.isoformat() if name == "expired_patrons" else created.date().isoformat())]
                         for _, c, f, ln, cat, br, exp, created in data],
                "refs": [{"patron": r[0]} for r in data]}
    raise HTTPException(404, "Unknown report")


def _report_rows(db: Session, name: str, days: int) -> tuple[list[str], list[list]]:
    """Backwards-compatible helper: ``(headers, rows)`` for the last ``days`` days, all branches."""
    data = _report(db, name, _period(days, None, None), None)
    return [c["label"] for c in data["columns"]], data["rows"]


def _check_branch(db: Session, branch_id: int | None) -> None:
    if branch_id is not None and db.get(Branch, branch_id) is None:
        raise HTTPException(422, "Unknown branch")


# ------------------------------------------------------------------ CSV (localised, humanised)


def _csv_safe(c):
    """Neutralise spreadsheet formula injection."""
    return f"'{c}" if isinstance(c, str) and c[:1] in "=+-@\t\r" else c


def humanise_header(lang: str, label: str) -> str:
    """Translate an English column header (``insights.csv.<slug>``), falling back to the English text."""
    slug = "".join(ch if ch.isalnum() else "_" for ch in label.lower()).strip("_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    return i18n_mod.translate(lang, f"insights.csv.{slug}", label)


def _csv_value(lang: str, col: dict, v):
    if col["type"] == "status" and isinstance(v, str):
        return i18n_mod.translate(lang, f"status.{v}", v.replace("_", " ").capitalize())
    if col["type"] == "date" and v == "never":
        return i18n_mod.translate(lang, "insights.reports.never", "Never")
    if col["type"] == "date" and isinstance(v, datetime):
        return v.date().isoformat()
    return v


def csv_response(filename: str, headers: list[str], rows: list[list]) -> StreamingResponse:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(headers)
    for r in rows:
        w.writerow([_csv_safe(c) for c in r])
    return StreamingResponse(iter(["﻿" + buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ------------------------------------------------------------------ endpoints


def _granularity(days: int) -> str:
    return "day" if days <= 92 else "week" if days <= 400 else "month"


@router.get("/dashboard")
def dashboard(start: date | None = None, end: date | None = None, branch_id: int | None = Query(default=None, ge=1),
              db: Session = Depends(get_db), _: Patron = Depends(require("reports:read"))):
    """Library snapshot. ``kpis`` (added) covers ``start``–``end`` (default: last 30 days) and an optional branch,
    with the previous period of equal length for comparison."""
    _check_branch(db, branch_id)
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
            "risk": insights.overdue_risk(db, 5),
            "kpis": period_kpis(db, start, end, branch_id)}


@router.get("/kpis")
def kpis(start: date | None = None, end: date | None = None, branch_id: int | None = Query(default=None, ge=1),
         db: Session = Depends(get_db), _: Patron = Depends(require("reports:read"))):
    """Headline numbers only (cheaper than ``/dashboard``): see :func:`period_kpis`."""
    _check_branch(db, branch_id)
    return period_kpis(db, start, end, branch_id)


def period_kpis(db: Session, start: date | None, end: date | None, branch_id: int | None) -> dict:
    """Headline numbers for the Reports page: period figures (with the previous period) and live snapshot counts."""
    try:
        w = svc.make_window(start, end, "day", branch_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    w = svc.Window(w.start, w.end, _granularity(w.days), branch_id, w.offset_minutes)
    now = utcnow()
    loan_b = [Loan.branch_id == branch_id] if branch_id else []
    hold_b = [Hold.pickup_branch_id == branch_id] if branch_id else []
    open_loans = db.scalar(select(func.count()).select_from(Loan).where(Loan.returned_at.is_(None), *loan_b)) or 0
    overdue = db.scalar(select(func.count()).select_from(Loan).where(Loan.returned_at.is_(None), Loan.due_at < now, *loan_b)) or 0
    owed = select(func.coalesce(func.sum(LedgerEntry.amount), 0))
    if branch_id:
        owed = owed.select_from(LedgerEntry).join(Patron, Patron.id == LedgerEntry.patron_id).where(Patron.home_branch_id == branch_id)
    pat_b = [Patron.home_branch_id == branch_id] if branch_id else []
    expired = db.scalar(select(func.count()).select_from(Patron).where(
        Patron.deleted_at.is_(None), Patron.role == Role.patron, Patron.expires_on < svc.local_today(), *pat_b)) or 0
    return {
        "range": {"start": w.start, "end": w.end, "days": w.days, "previous_start": w.previous().start,
                  "previous_end": w.previous().end, "granularity": w.granularity, "branch_id": branch_id},
        "checkouts": {"value": svc.count_checkouts(db, w), "previous": svc.count_checkouts(db, w.previous()),
                      "spark": svc._align(w, svc._series(db, w, Loan.issued_at, *loan_b))},
        "active_patrons": {"value": svc.count_active_patrons(db, w), "previous": svc.count_active_patrons(db, w.previous())},
        "new_patrons": {"value": svc.count_new_patrons(db, w), "previous": svc.count_new_patrons(db, w.previous())},
        "open_loans": {"value": open_loans},
        "overdue": {"value": overdue, "rate": round(overdue / open_loans, 4) if open_loans else 0},
        "holds_queued": {"value": db.scalar(select(func.count()).select_from(Hold).where(Hold.status == HoldStatus.queued, *hold_b)) or 0,
                         "ready": db.scalar(select(func.count()).select_from(Hold).where(Hold.status == HoldStatus.ready, *hold_b)) or 0},
        "fines_outstanding": {"value": round((db.scalar(owed) or 0) / 100, 2), "money": True},
        "expired_patrons": {"value": expired},
    }


@router.get("")
def list_reports(_: Patron = Depends(require("reports:read"))):
    return {"results": [{"key": k, "name": v["name"], "group": v["group"], "description": v["description"], "dated": v["dated"]}
                        for k, v in REPORT_DEFS.items()],
            "groups": list(GROUPS)}


@router.get("/run/{name}")
def run(name: str, request: Request, days: int = Query(default=30, ge=1, le=3650),
        start: date | None = None, end: date | None = None, branch_id: int | None = Query(default=None, ge=1),
        fmt: str = Query(default="json", pattern="^(json|csv)$"),
        db: Session = Depends(get_db), user: Patron = Depends(require("reports:read"))):
    """Run one report. ``start``/``end`` (library-local dates) override ``days``; ``branch_id`` narrows it to a branch."""
    if name not in REPORT_DEFS:
        raise HTTPException(404, "Unknown report")
    if fmt == "csv" and not has_permission(user, "reports:export"):
        raise HTTPException(403, "Missing permission: reports:export")
    _check_branch(db, branch_id)
    meta = REPORT_DEFS[name]
    p = _period(days, start, end)
    data = _report(db, name, p, branch_id)
    headers = [c["label"] for c in data["columns"]]
    if fmt == "csv":
        lang = i18n_mod.request_language(request, user)
        rows = [[_csv_value(lang, c, v) for c, v in zip(data["columns"], r, strict=False)] for r in data["rows"]]
        suffix = f"-{p.start.isoformat()}-{p.end.isoformat()}" if meta["dated"] else f"-{svc.local_today().isoformat()}"
        return csv_response(f"librowise-{name}{suffix}.csv", [humanise_header(lang, h) for h in headers], rows)
    return {"name": meta["name"], "headers": headers, "rows": data["rows"],
            "key": name, "group": meta["group"], "description": meta["description"], "dated": meta["dated"],
            "columns": data["columns"], "refs": data["refs"], "branch_id": branch_id,
            "period": {"start": p.start, "end": p.end, "days": p.days} if meta["dated"] else None,
            "generated_at": utcnow()}


# ------------------------------------------------------------------ AI insights data


@router.get("/insights/risk")
def risk(branch_id: int | None = Query(default=None, ge=1), db: Session = Depends(get_db),
         _: Patron = Depends(require("reports:read"))):
    """Open loans scored by late-return risk (top 100). Each row also carries ``biblio_id``, ``item_id`` and
    ``branch_id`` (added) so the UI can link to the record; ``branch_id`` filters to one lending branch."""
    _check_branch(db, branch_id)
    rows = insights.overdue_risk(db, 2000 if branch_id else 100)
    if rows:
        meta = {lid: (iid, bid, br) for lid, iid, bid, br in db.execute(
            select(Loan.id, Loan.item_id, Item.biblio_id, Loan.branch_id).join(Item, Item.id == Loan.item_id)
            .where(Loan.id.in_([r["loan_id"] for r in rows])))}
        for r in rows:
            r["item_id"], r["biblio_id"], r["branch_id"] = meta.get(r["loan_id"], (None, None, None))
    if branch_id:
        rows = [r for r in rows if r.get("branch_id") == branch_id][:100]
    return {"results": rows}


@router.get("/insights/duplicates")
def duplicates(db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    """Likely duplicate records. ``reason_code`` (``isbn`` | ``similar``) and ``isbn`` are added for localised display."""
    out = insights.duplicate_candidates(db)
    for d in out:
        reason = d.get("reason") or ""
        d["reason_code"] = "isbn" if reason.startswith("Same ISBN") else "similar"
        if d["reason_code"] == "isbn":
            d["isbn"] = reason.split()[-1]
    return {"results": out}


@router.get("/insights/weeding")
def weeding(branch_id: int | None = Query(default=None, ge=1), db: Session = Depends(get_db),
            _: Patron = Depends(require("catalog:read"))):
    """Weeding candidates (top 50) with ``biblio_id`` and ``branch_id`` (added); ``branch_id`` filters by holding branch."""
    _check_branch(db, branch_id)
    rows = insights.weeding_candidates(db, limit=1000 if branch_id else 50)
    if rows:
        meta = {i: (b, br) for i, b, br in db.execute(select(Item.id, Item.biblio_id, Item.branch_id)
                                                      .where(Item.id.in_([r["item_id"] for r in rows])))}
        for r in rows:
            r["biblio_id"], r["branch_id"] = meta.get(r["item_id"], (None, None))
    if branch_id:
        rows = [r for r in rows if r.get("branch_id") == branch_id][:50]
    return {"results": rows}
