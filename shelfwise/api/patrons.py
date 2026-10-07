from __future__ import annotations

import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..ai import recommend
from ..db import get_db
from ..deps import client_ip, require
from ..errors import NotFound
from ..models import Hold, LedgerEntry, Loan, Patron, PatronCategory, Role, utcnow
from ..schemas import MoneyIn, PatronIn, PatronPatch, biblio_out, hold_out, loan_out, money, patron_out
from ..security import ROLE_PERMISSIONS, can_manage_account, has_permission, hash_password, holds_all, password_problems
from ..services import audit, catalog, circulation, identity, notices

router = APIRouter(prefix="/patrons", tags=["patrons"])


def get_patron(db: Session, patron_id: int) -> Patron:
    p = db.get(Patron, patron_id)
    if p is None or p.deleted_at is not None:
        raise NotFound("Patron not found")
    return p


def _guard_role_change(actor: Patron, new_role: str | None) -> None:
    if new_role and new_role != "patron" and not (
            has_permission(actor, "patrons:manage_staff") and holds_all(actor, ROLE_PERMISSIONS[Role(new_role)])):
        raise HTTPException(403, "Only administrators can create or promote staff accounts")


def _guard_staff_target(actor: Patron, target: Patron, verb: str) -> None:
    if target.is_staff and not can_manage_account(actor, target):
        raise HTTPException(403, f"Only administrators can {verb} staff accounts")


def new_card_number(db: Session) -> str:
    while True:
        card = f"{secrets.randbelow(10**10):010d}"
        if not db.scalar(select(Patron.id).where(Patron.card_number == card)):
            return card


PATRON_SORTS = {
    "name": (Patron.last_name, Patron.first_name), "-name": (Patron.last_name.desc(), Patron.first_name.desc()),
    "card": (Patron.card_number,), "-card": (Patron.card_number.desc(),),
    "expires": (Patron.expires_on, Patron.last_name), "-expires": (Patron.expires_on.desc(), Patron.last_name),
    "created": (Patron.created_at, Patron.id), "-created": (Patron.created_at.desc(), Patron.id.desc()),
}


@router.get("")
def list_patrons(q: str | None = Query(default=None, max_length=120), role: str | None = Query(default=None, pattern="^(patron|librarian|admin|staff)$"),
                 category_id: int | None = Query(default=None, ge=1), branch_id: int | None = Query(default=None, ge=1),
                 status: str | None = Query(default=None, pattern="^(active|inactive|expired|expiring|owing)$"),
                 sort: str = Query(default="name", pattern="^-?(name|card|expires|created)$"),
                 page: int = Query(default=1, ge=1), per_page: int = Query(default=25, ge=1, le=200),
                 db: Session = Depends(get_db), _: Patron = Depends(require("patrons:read"))):
    """Search patrons. Filters: role (``staff`` = librarians + admins), category, home branch and status
    (``expiring`` = membership ends within 30 days, ``owing`` = positive balance)."""
    stmt = select(Patron).where(Patron.deleted_at.is_(None))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Patron.card_number == q.strip(), Patron.last_name.ilike(like),
                              Patron.first_name.ilike(like), Patron.email.ilike(like),
                              (Patron.first_name + " " + Patron.last_name).ilike(like)))
    if role == "staff":
        stmt = stmt.where(Patron.role.in_((Role.librarian, Role.admin)))
    elif role:
        stmt = stmt.where(Patron.role == Role(role))
    if category_id:
        stmt = stmt.where(Patron.category_id == category_id)
    if branch_id:
        stmt = stmt.where(Patron.home_branch_id == branch_id)
    today = utcnow().date()
    if status == "active":
        stmt = stmt.where(Patron.is_active.is_(True), or_(Patron.expires_on.is_(None), Patron.expires_on >= today))
    elif status == "inactive":
        stmt = stmt.where(Patron.is_active.is_(False))
    elif status == "expired":
        stmt = stmt.where(Patron.expires_on < today)
    elif status == "expiring":
        stmt = stmt.where(Patron.expires_on >= today, Patron.expires_on <= today + timedelta(days=30))
    elif status == "owing":
        owing = select(LedgerEntry.patron_id).group_by(LedgerEntry.patron_id).having(func.sum(LedgerEntry.amount) > 0)
        stmt = stmt.where(Patron.id.in_(owing))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(*PATRON_SORTS[sort])
                      .offset((page - 1) * per_page).limit(per_page)).all()
    ids = [p.id for p in rows]
    loans = dict(db.execute(select(Loan.patron_id, func.count()).where(
        Loan.patron_id.in_(ids), Loan.returned_at.is_(None)).group_by(Loan.patron_id)).all()) if ids else {}
    bal = dict(db.execute(select(LedgerEntry.patron_id, func.sum(LedgerEntry.amount)).where(
        LedgerEntry.patron_id.in_(ids)).group_by(LedgerEntry.patron_id)).all()) if ids else {}
    results = []
    for p in rows:
        d = patron_out(p)
        d["open_loans"] = loans.get(p.id, 0)
        d["balance"] = money(bal.get(p.id, 0))
        results.append(d)
    return {"total": total, "page": page, "results": results}


@router.post("", status_code=201)
def create_patron(body: PatronIn, request: Request, db: Session = Depends(get_db),
                  actor: Patron = Depends(require("patrons:write"))):
    _guard_role_change(actor, body.role)
    category = db.get(PatronCategory, body.category_id)
    if category is None:
        raise HTTPException(422, "Unknown patron category")
    if body.email and db.scalar(select(Patron.id).where(Patron.email == body.email.lower())):
        raise HTTPException(409, "Email already registered")
    card = body.card_number or new_card_number(db)
    if db.scalar(select(Patron.id).where(Patron.card_number == card)):
        raise HTTPException(409, "Card number already in use")
    data = body.model_dump(exclude={"password", "card_number", "role", "email"})
    p = Patron(**data, card_number=card, role=Role(body.role),
               email=body.email.lower() if body.email else None)
    if body.password:
        if problems := password_problems(body.password):
            raise HTTPException(422, "Password " + "; ".join(problems))
        p.password_hash = hash_password(body.password)
    if not p.expires_on:
        p.expires_on = (utcnow() + timedelta(days=30 * category.enrollment_months)).date()
    db.add(p)
    db.flush()
    audit.record(db, "create", "patron", p.id, actor=actor, ip=client_ip(request), role=body.role)
    if p.role == Role.patron and (p.email or p.phone):
        notices.queue(db, p, "WELCOME")
    db.commit()
    return patron_out(p)


class RenewIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)


@router.post("/renew")
def renew_memberships(body: RenewIn, request: Request, db: Session = Depends(get_db),
                      actor: Patron = Depends(require("patrons:write"))):
    """Bulk-renew memberships: each patron's expiry moves forward by their category's enrolment period,
    counted from today or from the current expiry date, whichever is later. Staff accounts the caller may
    not manage are skipped and reported."""
    today = utcnow().date()
    renewed, skipped = [], []
    for p in db.scalars(select(Patron).where(Patron.id.in_(set(body.ids)), Patron.deleted_at.is_(None))):
        if p.is_staff and not can_manage_account(actor, p):
            skipped.append({"id": p.id, "reason": "staff account"})
            continue
        start = max(today, p.expires_on or today)
        previous = p.expires_on
        p.expires_on = start + timedelta(days=30 * (p.category.enrollment_months or 12))
        audit.record(db, "renew_membership", "patron", p.id, actor=actor, ip=client_ip(request),
                     previous=previous.isoformat() if previous else None, expires_on=p.expires_on.isoformat())
        renewed.append({"id": p.id, "expires_on": p.expires_on})
    db.commit()
    return {"renewed": renewed, "skipped": skipped}


@router.get("/by-card/{card}")
def by_card(card: str, db: Session = Depends(get_db), _: Patron = Depends(require("patrons:read"))):
    p = db.scalar(select(Patron).where(Patron.card_number == card.strip(), Patron.deleted_at.is_(None)))
    if p is None:
        raise NotFound("No patron with that card number")
    return patron_detail(p.id, db)


@router.get("/{patron_id}")
def patron_detail(patron_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("patrons:read"))):
    p = get_patron(db, patron_id)
    out = patron_out(p)
    out["balance"] = money(circulation.balance(db, p.id))
    out["blocks"] = circulation.patron_blocks(db, p)
    out["loans"] = [loan_out(l) for l in circulation.open_loans(db, p.id)]
    holds = db.scalars(select(Hold).where(Hold.patron_id == p.id, Hold.status.in_(circulation.ACTIVE_HOLD_STATUSES))
                       .order_by(Hold.created_at)).all()
    out["holds"] = [hold_out(h, circulation.hold_queue_position(db, h)) for h in holds]
    return out


@router.patch("/{patron_id}")
def update_patron(patron_id: int, body: PatronPatch, request: Request, db: Session = Depends(get_db),
                  actor: Patron = Depends(require("patrons:write"))):
    p = get_patron(db, patron_id)
    data = body.model_dump(exclude_unset=True)
    _guard_staff_target(actor, p, "modify")
    _guard_role_change(actor, data.get("role"))
    if pw := data.pop("password", None):
        if problems := password_problems(pw):
            raise HTTPException(422, "Password " + "; ".join(problems))
        p.password_hash = hash_password(pw)
    if "role" in data:
        data["role"] = Role(data["role"])
    if data.get("email"):
        data["email"] = data["email"].lower()
    for k, v in data.items():
        setattr(p, k, v)
    audit.record(db, "update", "patron", p.id, actor=actor, ip=client_ip(request),
                 fields=sorted(data) + (["password"] if pw else []))
    db.commit()
    return patron_out(p)


@router.delete("/{patron_id}", status_code=204)
def delete_patron(patron_id: int, db: Session = Depends(get_db), actor: Patron = Depends(require("patrons:delete"))):
    p = get_patron(db, patron_id)
    if circulation.open_loans(db, p.id):
        raise HTTPException(409, "Patron still has items on loan")
    if circulation.balance(db, p.id) > 0:
        raise HTTPException(409, "Patron has outstanding charges")
    _guard_staff_target(actor, p, "remove")
    # GDPR-style erasure: keep the row for referential integrity, scrub personal data.
    p.deleted_at = utcnow()
    p.is_active = False
    p.email = None
    p.phone = p.address = p.notes = None
    p.date_of_birth = None
    p.first_name, p.last_name = "Deleted", f"Patron #{p.id}"
    p.password_hash = None
    identity.erase_credentials(db, p)  # sessions, API tokens, 2FA, linked SSO identities
    db.query(Loan).filter(Loan.patron_id == p.id, Loan.returned_at.is_not(None)).update({"patron_id": None})
    audit.record(db, "erase", "patron", p.id, actor=actor)
    db.commit()
    return Response(status_code=204)


@router.get("/{patron_id}/history")
def history(patron_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("patrons:read"))):
    get_patron(db, patron_id)
    loans = db.scalars(select(Loan).where(Loan.patron_id == patron_id, Loan.returned_at.is_not(None))
                       .order_by(Loan.returned_at.desc()).limit(200)).all()
    return {"results": [loan_out(l) for l in loans]}


@router.get("/{patron_id}/ledger")
def ledger(patron_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("patrons:read"))):
    get_patron(db, patron_id)
    rows = db.scalars(select(LedgerEntry).where(LedgerEntry.patron_id == patron_id)
                      .order_by(LedgerEntry.created_at.desc())).all()
    return {"balance": money(circulation.balance(db, patron_id)),
            "entries": [{"id": e.id, "kind": e.kind.value, "amount": money(e.amount), "note": e.note,
                         "created_at": e.created_at} for e in rows]}


@router.post("/{patron_id}/pay")
def pay(patron_id: int, body: MoneyIn, db: Session = Depends(get_db), actor: Patron = Depends(require("circulation"))):
    p = get_patron(db, patron_id)
    bal = circulation.pay(db, p, body.amount, actor, body.note)
    db.commit()
    return {"balance": money(bal)}


@router.post("/{patron_id}/waive")
def waive(patron_id: int, body: MoneyIn, db: Session = Depends(get_db), actor: Patron = Depends(require("fines:waive"))):
    p = get_patron(db, patron_id)
    bal = circulation.waive(db, p, body.amount, actor, body.note or "Waived")
    db.commit()
    return {"balance": money(bal)}


@router.post("/{patron_id}/charge")
def charge(patron_id: int, body: MoneyIn, db: Session = Depends(get_db), actor: Patron = Depends(require("fines:charge"))):
    p = get_patron(db, patron_id)
    bal = circulation.charge(db, p, body.amount, actor, body.note or "Manual charge")
    db.commit()
    return {"balance": money(bal)}


@router.get("/{patron_id}/recommendations")
def patron_recs(patron_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("patrons:read"))):
    get_patron(db, patron_id)
    rec = recommend.for_patron(db, patron_id)
    avail = catalog.availability(db, rec["ids"])
    return {"reason": rec["reason"], "results": [biblio_out(b, avail.get(b.id)) for b in catalog.load_biblios(db, rec["ids"])]}
