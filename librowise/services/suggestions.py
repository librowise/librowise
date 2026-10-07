"""Patron purchase suggestions (Koha "suggestions"): OPAC form → staff review → optional draft order.

Workflow: ``pending`` → ``accepted`` (optionally ``ordered`` when a draft purchase order is created)
or ``rejected`` (with a reason). Patrons may withdraw a pending suggestion. Every status change queues a
PURCHASE_SUGGESTION_UPDATE notice (subject to the patron's messaging preference).
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..errors import Conflict, Forbidden, NotFound, PolicyBlocked
from ..models import (
    Biblio,
    Budget,
    OrderStatus,
    Patron,
    PurchaseOrder,
    PurchaseSuggestion,
    SuggestionStatus,
    Vendor,
    utcnow,
)
from . import audit, catalog, notices
from . import settings as settings_svc

MAX_OPEN_PER_PATRON = 10
FORMATS = ("book", "ebook", "audiobook", "dvd", "serial", "comic", "other")


def suggestion_out(s: PurchaseSuggestion, *, staff: bool = False) -> dict:
    out = {"id": s.id, "title": s.title, "author": s.author, "isbn": s.isbn, "format": s.format,
           "reason": s.reason, "status": s.status.value,
           "status_label": notices.SUGGESTION_LABELS.get(s.status.value, s.status.value),
           "decision_note": s.decision_note, "created_at": s.created_at, "reviewed_at": s.reviewed_at,
           "order_id": s.order_id}
    if staff:
        out["patron"] = ({"id": s.patron.id, "card_number": s.patron.card_number, "full_name": s.patron.full_name}
                         if s.patron else None)
        out["reviewed_by"] = s.reviewed_by.full_name if s.reviewed_by else None
        out["holdings"] = None
    return out


def _notify(db: Session, s: PurchaseSuggestion) -> None:
    if s.patron is None or not s.patron.is_active:
        return
    notices.queue(db, s.patron, "PURCHASE_SUGGESTION_UPDATE", {"suggestion": {
        "title": s.title, "author": s.author or "", "status": s.status.value,
        "status_label": notices.SUGGESTION_LABELS.get(s.status.value, s.status.value),
        "note": s.decision_note or ""}})


def create(db: Session, patron: Patron, data: dict) -> PurchaseSuggestion:
    if not settings_svc.get(db, "allow_purchase_suggestions"):
        raise Forbidden("Purchase suggestions are currently closed")
    title = data["title"].strip()
    fmt = data.get("format") or "book"
    if fmt not in FORMATS:
        raise PolicyBlocked("Unknown format")
    open_count = db.scalar(select(func.count()).select_from(PurchaseSuggestion).where(
        PurchaseSuggestion.patron_id == patron.id, PurchaseSuggestion.status == SuggestionStatus.pending)) or 0
    if open_count >= MAX_OPEN_PER_PATRON:
        raise PolicyBlocked(f"You already have {open_count} suggestions under review — please wait for a decision")
    dup = db.scalar(select(PurchaseSuggestion.id).where(
        PurchaseSuggestion.patron_id == patron.id, PurchaseSuggestion.status == SuggestionStatus.pending,
        func.lower(PurchaseSuggestion.title) == title.lower()))
    if dup:
        raise Conflict("You have already suggested this title")
    raw_isbn = (data.get("isbn") or "").strip() or None
    s = PurchaseSuggestion(patron_id=patron.id, title=title, author=(data.get("author") or "").strip() or None,
                           isbn=catalog.normalize_isbn(raw_isbn) or raw_isbn, format=fmt,
                           reason=(data.get("reason") or "").strip() or None)
    db.add(s)
    db.flush()
    audit.record(db, "suggestion_created", "suggestion", s.id, actor=patron)
    return s


def get(db: Session, suggestion_id: int) -> PurchaseSuggestion:
    s = db.get(PurchaseSuggestion, suggestion_id)
    if s is None:
        raise NotFound("Suggestion not found")
    return s


def withdraw(db: Session, s: PurchaseSuggestion, *, patron: Patron) -> PurchaseSuggestion:
    if s.patron_id != patron.id:
        raise NotFound("Suggestion not found")
    if s.status != SuggestionStatus.pending:
        raise Conflict("Only suggestions still under review can be withdrawn")
    s.status = SuggestionStatus.withdrawn
    db.flush()
    audit.record(db, "suggestion_withdrawn", "suggestion", s.id, actor=patron)
    return s


def _committed(db: Session, budget_id: int) -> int:
    return int(db.scalar(select(func.coalesce(func.sum(PurchaseOrder.unit_price * PurchaseOrder.quantity), 0)).where(
        PurchaseOrder.budget_id == budget_id, PurchaseOrder.status != OrderStatus.cancelled)) or 0)


def accept(db: Session, s: PurchaseSuggestion, *, actor: Patron, note: str | None = None,
           order: dict | None = None) -> PurchaseSuggestion:
    """Accept a suggestion; with ``order`` (vendor_id, budget_id, quantity, unit_price) also create a
    **draft** purchase order that acquisitions staff can review and place."""
    if s.status != SuggestionStatus.pending:
        raise Conflict(f"Suggestion is already {s.status.value}")
    if order:
        vendor, budget = db.get(Vendor, order["vendor_id"]), db.get(Budget, order["budget_id"])
        if vendor is None or budget is None:
            raise NotFound("Unknown vendor or budget")
        qty, price = int(order.get("quantity") or 1), int(order["unit_price"])
        if _committed(db, budget.id) + qty * price > budget.allocated:
            raise Conflict(f"Order exceeds the remaining budget ({(budget.allocated - _committed(db, budget.id)) / 100:.2f})")
        po = PurchaseOrder(vendor_id=vendor.id, budget_id=budget.id, title=s.title, isbn=s.isbn, quantity=qty,
                           unit_price=price, status=OrderStatus.draft,
                           notes=f"From patron suggestion #{s.id}"[:255])
        db.add(po)
        db.flush()
        s.order_id = po.id
        s.status = SuggestionStatus.ordered
        audit.record(db, "create", "order", po.id, actor=actor, total=qty * price, suggestion=s.id, draft=True)
    else:
        s.status = SuggestionStatus.accepted
    s.decision_note = (note or "").strip()[:500] or None
    s.reviewed_by, s.reviewed_at = actor, utcnow()
    db.flush()
    _notify(db, s)
    audit.record(db, "suggestion_accepted", "suggestion", s.id, actor=actor, order=s.order_id)
    return s


def reject(db: Session, s: PurchaseSuggestion, *, actor: Patron, reason: str) -> PurchaseSuggestion:
    reason = (reason or "").strip()
    if not reason:
        raise PolicyBlocked("Please give a reason — the patron will see it")
    if s.status not in (SuggestionStatus.pending, SuggestionStatus.accepted):
        raise Conflict(f"Suggestion is already {s.status.value}")
    s.status = SuggestionStatus.rejected
    s.decision_note = reason[:500]
    s.reviewed_by, s.reviewed_at = actor, utcnow()
    db.flush()
    _notify(db, s)
    audit.record(db, "suggestion_rejected", "suggestion", s.id, actor=actor)
    return s


def for_patron(db: Session, patron: Patron) -> list[dict]:
    rows = db.scalars(select(PurchaseSuggestion).where(PurchaseSuggestion.patron_id == patron.id)
                      .order_by(PurchaseSuggestion.created_at.desc()).limit(200)).all()
    return [suggestion_out(s) for s in rows]


def staff_list(db: Session, status: str | None = None) -> dict:
    stmt = select(PurchaseSuggestion)
    if status:
        stmt = stmt.where(PurchaseSuggestion.status == SuggestionStatus(status))
    rows = db.scalars(stmt.order_by(PurchaseSuggestion.created_at.desc()).limit(500)).all()
    counts = {k.value: v for k, v in db.execute(select(PurchaseSuggestion.status, func.count())
                                                 .group_by(PurchaseSuggestion.status)).all()}
    out = [suggestion_out(s, staff=True) for s in rows]
    # Does the library already hold it? (matched by ISBN, then exact title)
    for d in out:
        bid = None
        if d["isbn"]:
            bid = db.scalar(select(Biblio.id).where(Biblio.isbn == d["isbn"], Biblio.deleted_at.is_(None)).limit(1))
        if bid is None:
            bid = db.scalar(select(Biblio.id).where(func.lower(Biblio.title) == d["title"].lower(),
                                                    Biblio.deleted_at.is_(None)).limit(1))
        d["holdings"] = bid
    return {"counts": counts, "results": out}
