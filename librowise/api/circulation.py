from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..errors import NotFound, PolicyBlocked
from ..models import Branch, Hold, HoldStatus, Item, ItemStatus, Loan, Patron, utcnow
from ..schemas import (
    CheckinIn,
    CheckoutIn,
    HoldIn,
    RenewIn,
    StrictModel,
    hold_out,
    item_out,
    loan_out,
    money,
)
from ..security import has_permission
from ..services import catalog, circulation
from ..services import holds as holds_svc

router = APIRouter(tags=["circulation"])


def _branch(db: Session, branch_id: int | None, user: Patron) -> int:
    bid = branch_id or user.home_branch_id
    if not db.get(Branch, bid):
        raise HTTPException(422, "Unknown branch")
    return bid


def _patron_by_card(db: Session, card: str) -> Patron:
    p = db.scalar(select(Patron).where(Patron.card_number == card.strip(), Patron.deleted_at.is_(None)))
    if p is None:
        raise NotFound(f"No patron with card {card!r}")
    return p


def _can_override(user: Patron, requested: bool) -> bool:
    if requested and not has_permission(user, "circulation:override"):
        raise HTTPException(403, "Missing permission: circulation:override")
    return requested


def _branch_out(b: Branch | None) -> dict | None:
    return {"id": b.id, "code": b.code, "name": b.name} if b is not None else None


def _patron_brief(p: Patron | None) -> dict | None:
    return {"id": p.id, "card_number": p.card_number, "full_name": p.full_name} if p is not None else None


@router.get("/circulation/patrons/{patron_id}/context")
def patron_context(patron_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    """Everything the desk's patron panel shows: the patron record with loans, holds and balance (as
    ``GET /patrons/{id}``) plus structured, translatable block reasons and what the caller may override."""
    from .patrons import patron_detail

    if not has_permission(user, "patrons:read"):
        raise HTTPException(403, "Missing permission: patrons:read")
    out = patron_detail(patron_id, db)
    p = db.get(Patron, patron_id)
    out["block_reasons"] = circulation.patron_block_reasons(db, p)
    out["max_loans"] = p.category.max_loans
    out["can_override"] = has_permission(user, "circulation:override")
    out["can_take_payment"] = True  # the desk permission ("circulation") covers payments
    return out


@router.get("/circulation/patrons/by-card/{card}/context")
def patron_context_by_card(card: str, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    """:func:`patron_context` for a scanned library card (404 ``not_found`` when no patron has it)."""
    return patron_context(_patron_by_card(db, card).id, db, user)


@router.post("/circulation/checkout")
def checkout(body: CheckoutIn, request: Request, db: Session = Depends(get_db),
             user: Patron = Depends(require("circulation"))):
    patron = _patron_by_card(db, body.patron_card)
    item = catalog.item_by_barcode(db, body.barcode)
    res = circulation.checkout(db, patron, item, branch_id=_branch(db, body.branch_id, user), actor=user,
                               override=_can_override(user, body.override), due_at=body.due_at,
                               override_reason=body.override_reason)
    db.commit()
    return {"loan": loan_out(res.loan), "warnings": res.warnings, "warning_codes": res.warning_codes,
            "patron_open_loans": len(circulation.open_loans(db, patron.id)), "undo_token": res.undo_token}


def _checkin_out(res: circulation.CheckinResult) -> dict:
    return {
        "item": item_out(res.item, with_biblio=True),
        "loan": loan_out(res.loan) if res.loan else None,
        "fine": money(res.fine),
        "hold": hold_out(res.hold) if res.hold else None,
        "messages": res.messages,
        # what to do with the item now: hold_shelf · transit · home_branch · reshelve · already_on_hold_shelf
        "routing": res.routing,
        "to_branch": _branch_out(res.to_branch),
        "lost_found": res.lost_found,
        "undo_token": res.undo_token,
    }


@router.post("/circulation/checkin")
def checkin(body: CheckinIn, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    item = catalog.item_by_barcode(db, body.barcode)
    res = circulation.checkin(db, item, branch_id=_branch(db, body.branch_id, user), actor=user)
    db.commit()
    return _checkin_out(res)


@router.post("/circulation/transfer/receive")
def receive(body: CheckinIn, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    item = catalog.item_by_barcode(db, body.barcode)
    res = circulation.receive_transfer(db, item, branch_id=_branch(db, body.branch_id, user), actor=user)
    db.commit()
    out = _checkin_out(res)
    out.pop("undo_token", None)
    return out


class RenewByBarcodeIn(StrictModel):
    barcode: str = Field(min_length=1, max_length=32)
    override: bool = False
    override_reason: str | None = Field(default=None, max_length=255)


@router.post("/circulation/renew")
def renew_by_barcode(body: RenewByBarcodeIn, db: Session = Depends(get_db),
                     user: Patron = Depends(require("circulation"))):
    """Renew whatever open loan the scanned item is on (the desk's renew mode, F4)."""
    item = catalog.item_by_barcode(db, body.barcode)
    loan = db.scalar(select(Loan).where(Loan.item_id == item.id, Loan.returned_at.is_(None)))
    if loan is None:
        raise PolicyBlocked("This item is not on loan", code="not_on_loan")
    circulation.renew(db, loan, actor=user, override=_can_override(user, body.override),
                      override_reason=body.override_reason)
    db.commit()
    return loan_out(loan)


class UndoIn(StrictModel):
    token: int = Field(gt=0, description="The undo_token returned by checkout or check-in")


@router.post("/circulation/undo")
def undo(body: UndoIn, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    """Undo a checkout or check-in made in the last 30 seconds (same staff member; audited)."""
    res = circulation.undo(db, body.token, actor=user, may_undo_others=has_permission(user, "circulation:override"))
    db.commit()
    return {"undone": res["undone"], "item": item_out(res["item"], with_biblio=True),
            "patron": _patron_brief(res.get("patron")), "notice_sent": bool(res.get("notice_sent")),
            "window_seconds": int(circulation.UNDO_WINDOW.total_seconds())}


class ReceiptLine(StrictModel):
    loan_id: int
    kind: str = Field(default="checkout", pattern="^(checkout|renew)$")


class ReceiptIn(StrictModel):
    patron_id: int
    lines: list[ReceiptLine] = Field(min_length=1, max_length=200)


@router.post("/circulation/receipt")
def email_receipt(body: ReceiptIn, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    """Email a transaction receipt (this visit's loans and renewals) to the patron."""
    patron = db.get(Patron, body.patron_id)
    if patron is None or patron.deleted_at is not None:
        raise NotFound("Patron not found")
    if not patron.email:
        raise PolicyBlocked("This patron has no email address", code="no_email")
    lines = []
    for line in body.lines:
        loan = db.get(Loan, line.loan_id)
        if loan is None or loan.patron_id != patron.id:
            raise NotFound("Loan not found")
        verb = "Renewed" if line.kind == "renew" else "Borrowed"
        lines.append(f"- {loan.item.biblio.title} ({loan.item.barcode}): {verb}, due {loan.due_at:%d %b %Y}")
    from ..services import settings as settings_svc

    library = settings_svc.library_name(db)
    body_text = (f"Dear {patron.first_name},\n\nThank you for visiting {library}. This is your receipt for "
                 f"{utcnow():%d %b %Y}:\n\n" + "\n".join(lines) + "\n\nPlease keep this message for your records.")
    circulation.notify(db, patron, f"Your receipt from {library}", body_text)
    from ..services import audit

    audit.record(db, "receipt_emailed", "patron", patron.id, actor=user, loans=[line.loan_id for line in body.lines])
    db.commit()
    name, _, domain = patron.email.partition("@")
    return {"queued": True, "to": f"{name[:2]}…@{domain}"}


@router.post("/loans/{loan_id}/renew")
def renew(loan_id: int, body: RenewIn, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    loan = db.get(Loan, loan_id)
    if loan is None:
        raise NotFound("Loan not found")
    circulation.renew(db, loan, actor=user, override=_can_override(user, body.override),
                      override_reason=body.override_reason)
    db.commit()
    return loan_out(loan)


@router.post("/loans/{loan_id}/lost")
def lost(loan_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    loan = db.get(Loan, loan_id)
    if loan is None or loan.returned_at is not None:
        raise NotFound("Open loan not found")
    cost = circulation.mark_lost(db, loan, actor=user)
    db.commit()
    return {"charged": money(cost)}


@router.get("/loans")
def loans(overdue: bool = False, branch_id: int | None = None,
          page: int = Query(default=1, ge=1), per_page: int = Query(default=50, ge=1, le=500),
          db: Session = Depends(get_db), _: Patron = Depends(require("circulation"))):
    stmt = select(Loan).where(Loan.returned_at.is_(None))
    if overdue:
        stmt = stmt.where(Loan.due_at < utcnow())
    if branch_id:
        stmt = stmt.where(Loan.branch_id == branch_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Loan.due_at).offset((page - 1) * per_page).limit(per_page)).all()
    return {"total": total, "results": [loan_out(l) for l in rows]}


@router.get("/circulation/recent")
def recent(limit: int = Query(default=20, le=100), db: Session = Depends(get_db),
           _: Patron = Depends(require("circulation"))):
    rows = db.scalars(select(Loan).order_by(Loan.updated_at.desc()).limit(limit)).all()
    return {"results": [loan_out(l) for l in rows]}


@router.get("/circulation/today")
def today(branch_id: int | None = Query(default=None, ge=1), db: Session = Depends(get_db),
          user: Patron = Depends(require("catalog:read"))):
    """Desk tasks for the staff Home page: counts that deep-link into filtered pages, filtered by what the
    caller may do (a task the user cannot act on is not listed)."""
    from ..models import Notification, PatronRegistration, PurchaseSuggestion, SuggestionStatus

    now = utcnow()
    tasks: list[dict] = []

    def task(id_: str, count: int, href: str, tone: str, icon: str, **params):
        tasks.append({"id": id_, "count": count, "href": href, "tone": tone if count else "neutral", "icon": icon,
                      "params": params})

    hold_branch = [Hold.pickup_branch_id == branch_id] if branch_id else []
    if has_permission(user, "holds:manage"):
        task("holds_to_pull", len(circulation.holds_to_pull(db, branch_id)), "/staff/holds#pull", "info", "bookmark")
        expiring = db.scalar(select(func.count()).select_from(Hold).where(
            Hold.status == HoldStatus.ready, Hold.expires_at.is_not(None), Hold.expires_at <= now + timedelta(days=2),
            *hold_branch)) or 0
        task("holds_expiring", expiring, "/staff/holds?expiring=1#ready", "warning", "clock")
        transit = db.scalar(select(func.count()).select_from(Hold).join(Item, Item.id == Hold.item_id).where(
            Hold.status == HoldStatus.queued, Item.status == ItemStatus.in_transit, *hold_branch)) or 0
        task("in_transit", transit, "/staff/holds#transit", "info", "map")
    if has_permission(user, "circulation"):
        loan_branch = [Loan.branch_id == branch_id] if branch_id else []
        overdue = db.scalar(select(func.count()).select_from(Loan).where(
            Loan.returned_at.is_(None), Loan.due_at < now, *loan_branch)) or 0
        task("overdue", overdue, "/staff/reports#overdues", "danger", "alert")
    if has_permission(user, "patrons:approve"):
        pending = db.scalar(select(func.count()).select_from(PatronRegistration).where(
            PatronRegistration.status == "pending")) or 0
        task("registrations", pending, "/staff/requests", "info", "user-plus")
    if has_permission(user, "suggestions:manage"):
        pending = db.scalar(select(func.count()).select_from(PurchaseSuggestion).where(
            PurchaseSuggestion.status == SuggestionStatus.pending)) or 0
        task("suggestions", pending, "/staff/requests#suggestions", "info", "cart")
    if has_permission(user, "notices:outbox"):
        failed = db.scalar(select(func.count()).select_from(Notification).where(
            Notification.status == "failed", Notification.created_at >= now - timedelta(days=7))) or 0
        task("notices_failed", failed, "/staff/notices", "danger", "send")
    return {"generated_at": now, "branch_id": branch_id, "tasks": tasks}


# ------------------------------------------------------------------ holds (staff)


def _transit_conds() -> list:
    return [Hold.status == HoldStatus.queued, Hold.item_id.is_not(None), Item.status == ItemStatus.in_transit]


@router.get("/holds")
def holds(status: str | None = Query(default=None, pattern="^(queued|ready|fulfilled|cancelled|expired)$"),
          branch_id: int | None = None, biblio_id: int | None = None,
          transit: bool = Query(default=False, description="Only holds whose copy is in transit to the pickup branch"),
          db: Session = Depends(get_db), _: Patron = Depends(require("holds:manage"))):
    stmt = select(Hold)
    if transit:
        stmt = stmt.join(Item, Item.id == Hold.item_id).where(*_transit_conds())
    else:
        stmt = stmt.where(Hold.status == HoldStatus(status)) if status else stmt.where(
            Hold.status.in_(circulation.ACTIVE_HOLD_STATUSES))
    if branch_id:
        stmt = stmt.where(Hold.pickup_branch_id == branch_id)
    if biblio_id:
        stmt = stmt.where(Hold.biblio_id == biblio_id)
    rows = db.scalars(stmt.order_by(Hold.created_at).limit(500)).all()
    return {"results": [hold_out(h, circulation.hold_queue_position(db, h)) for h in rows]}


@router.get("/holds/counts")
def hold_counts(branch_id: int | None = None, db: Session = Depends(get_db),
                _: Patron = Depends(require("holds:manage"))):
    """Badge counts for the Holds page tabs in one request."""
    now = utcnow()
    where = [Hold.pickup_branch_id == branch_id] if branch_id else []
    count = lambda *conds: db.scalar(select(func.count()).select_from(Hold).where(*conds, *where)) or 0  # noqa: E731
    transit = db.scalar(select(func.count()).select_from(Hold).join(Item, Item.id == Hold.item_id)
                        .where(*_transit_conds(), *where)) or 0
    return {
        "queue": count(Hold.status.in_(circulation.ACTIVE_HOLD_STATUSES)),
        "queued": count(Hold.status == HoldStatus.queued),
        "suspended": count(Hold.status == HoldStatus.queued, Hold.suspended.is_(True)),
        "pull": len(circulation.holds_to_pull(db, branch_id)),
        "ready": count(Hold.status == HoldStatus.ready),
        "expiring": count(Hold.status == HoldStatus.ready, Hold.expires_at.is_not(None),
                          Hold.expires_at <= now + timedelta(days=2)),
        "expired_on_shelf": count(Hold.status == HoldStatus.ready, Hold.expires_at.is_not(None), Hold.expires_at < now),
        "transit": transit,
        "routable_today": count(*holds_svc.routable(None, now.date())),
    }


@router.get("/holds/to-pull")
def to_pull(branch_id: int | None = None, db: Session = Depends(get_db), _: Patron = Depends(require("holds:manage"))):
    return {"results": [{"hold": hold_out(r["hold"]), "item": item_out(r["item"])}
                        for r in circulation.holds_to_pull(db, branch_id)]}


@router.post("/holds", status_code=201)
def place_hold(body: HoldIn, request: Request, db: Session = Depends(get_db),
               user: Patron = Depends(require("holds:manage"))):
    if not body.patron_card:
        raise HTTPException(422, "patron_card is required")
    patron = _patron_by_card(db, body.patron_card)
    biblio = catalog.get_biblio(db, body.biblio_id)
    hold = circulation.place_hold(db, patron, biblio, pickup_branch_id=body.pickup_branch_id, actor=user,
                                  override=_can_override(user, body.override), notes=body.notes,
                                  item_id=body.item_id, not_needed_after=body.not_needed_after)
    db.commit()
    return hold_out(hold, circulation.hold_queue_position(db, hold))


@router.delete("/holds/{hold_id}")
def cancel_hold(hold_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("holds:manage"))):
    hold = db.get(Hold, hold_id)
    if hold is None:
        raise NotFound("Hold not found")
    circulation.cancel_hold(db, hold, actor=user)
    db.commit()
    return {"ok": True}
