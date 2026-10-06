from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..errors import NotFound
from ..models import Branch, Hold, HoldStatus, Loan, Patron, Role, utcnow
from ..schemas import CheckinIn, CheckoutIn, HoldIn, RenewIn, hold_out, item_out, loan_out, money
from ..services import catalog, circulation

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
    if requested and user.role not in (Role.librarian, Role.admin):
        raise HTTPException(403, "Override requires staff privileges")
    return requested


@router.post("/circulation/checkout")
def checkout(body: CheckoutIn, request: Request, db: Session = Depends(get_db),
             user: Patron = Depends(require("circulation"))):
    patron = _patron_by_card(db, body.patron_card)
    item = catalog.item_by_barcode(db, body.barcode)
    res = circulation.checkout(db, patron, item, branch_id=_branch(db, body.branch_id, user), actor=user,
                               override=_can_override(user, body.override), due_at=body.due_at)
    db.commit()
    return {"loan": loan_out(res.loan), "warnings": res.warnings,
            "patron_open_loans": len(circulation.open_loans(db, patron.id))}


@router.post("/circulation/checkin")
def checkin(body: CheckinIn, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    item = catalog.item_by_barcode(db, body.barcode)
    res = circulation.checkin(db, item, branch_id=_branch(db, body.branch_id, user), actor=user)
    db.commit()
    return {
        "item": item_out(res.item, with_biblio=True),
        "loan": loan_out(res.loan) if res.loan else None,
        "fine": money(res.fine),
        "hold": hold_out(res.hold) if res.hold else None,
        "messages": res.messages,
    }


@router.post("/circulation/transfer/receive")
def receive(body: CheckinIn, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    item = catalog.item_by_barcode(db, body.barcode)
    res = circulation.receive_transfer(db, item, branch_id=_branch(db, body.branch_id, user), actor=user)
    db.commit()
    return {"item": item_out(res.item, with_biblio=True), "hold": hold_out(res.hold) if res.hold else None,
            "messages": res.messages}


@router.post("/loans/{loan_id}/renew")
def renew(loan_id: int, body: RenewIn, db: Session = Depends(get_db), user: Patron = Depends(require("circulation"))):
    loan = db.get(Loan, loan_id)
    if loan is None:
        raise NotFound("Loan not found")
    circulation.renew(db, loan, actor=user, override=_can_override(user, body.override))
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


# ------------------------------------------------------------------ holds (staff)


@router.get("/holds")
def holds(status: str | None = Query(default=None, pattern="^(queued|ready|fulfilled|cancelled|expired)$"),
          branch_id: int | None = None, db: Session = Depends(get_db), _: Patron = Depends(require("holds:manage"))):
    stmt = select(Hold)
    stmt = stmt.where(Hold.status == HoldStatus(status)) if status else stmt.where(Hold.status.in_(circulation.ACTIVE_HOLD_STATUSES))
    if branch_id:
        stmt = stmt.where(Hold.pickup_branch_id == branch_id)
    rows = db.scalars(stmt.order_by(Hold.created_at).limit(500)).all()
    return {"results": [hold_out(h, circulation.hold_queue_position(db, h)) for h in rows]}


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
