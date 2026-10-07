"""OPAC patron self-registration and the staff approval queue.

A self-registration creates a normal ``Patron`` row that is **inactive** with ``registration_status =
"pending"`` plus a ``PatronRegistration`` review record. Staff approve (account activated, membership
period starts, REGISTRATION_APPROVED notice) or reject (REGISTRATION_REJECTED notice with the reason).
Pending/rejected accounts cannot sign in; the login endpoint explains why once the password is verified.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..errors import Conflict, Forbidden, NotFound, PolicyBlocked
from ..models import Branch, Patron, PatronCategory, PatronRegistration, Role, utcnow
from ..security import SlidingWindowLimiter, hash_password, password_problems
from . import audit, notices
from . import settings as settings_svc

PENDING, APPROVED, REJECTED = "pending", "approved", "rejected"

# Per-IP limit on submissions (in-process; use a shared store when running several workers).
registration_limiter = SlidingWindowLimiter(get_settings().registrations_per_hour, 3600)


def _new_card_number(db: Session) -> str:
    while True:
        card = f"{secrets.randbelow(10**10):010d}"
        if not db.scalar(select(Patron.id).where(Patron.card_number == card)):
            return card


def default_category(db: Session) -> PatronCategory:
    code = str(settings_svc.get(db, "self_registration_category") or "").strip()
    cat = db.scalar(select(PatronCategory).where(PatronCategory.code == code)) if code else None
    cat = cat or db.scalar(select(PatronCategory).where(PatronCategory.code != "STAFF").order_by(PatronCategory.id))
    if cat is None:
        raise PolicyBlocked("Self-registration is not configured (no patron categories)")
    return cat


def registration_password_problems(password: str, *, email: str, first_name: str, last_name: str) -> list[str]:
    problems = password_problems(password)
    low = password.lower()
    personal = [email.split("@")[0], first_name, last_name]
    if any(p and len(p) >= 4 and p.lower() in low for p in personal):
        problems.append("must not contain your name or email address")
    return problems


def register(db: Session, data: dict, *, ip: str | None = None) -> Patron:
    """Create a pending (inactive) account from an OPAC registration form."""
    if not settings_svc.get(db, "allow_self_registration"):
        raise Forbidden("Online registration is not available — please visit a branch to join")
    email = data["email"].strip().lower()
    first, last = data["first_name"].strip(), data["last_name"].strip()
    if db.scalar(select(Patron.id).where(func.lower(Patron.email) == email)):
        raise Conflict("An account with this email address already exists. Sign in, or ask library staff "
                       "to reset your password.", code="email_registered")
    if problems := registration_password_problems(data["password"], email=email, first_name=first, last_name=last):
        raise PolicyBlocked("Password " + "; ".join(problems), code="weak_password")
    branch = db.get(Branch, data["home_branch_id"])
    if branch is None:
        raise NotFound("Unknown branch")
    dob: date | None = data.get("date_of_birth")
    if dob and (dob > utcnow().date() or dob.year < 1900):
        raise PolicyBlocked("Please check the date of birth")
    category = default_category(db)
    patron = Patron(card_number=_new_card_number(db), email=email, first_name=first, last_name=last,
                    phone=data.get("phone") or None, address=data.get("address") or None, date_of_birth=dob,
                    category_id=category.id, home_branch_id=branch.id, role=Role.patron,
                    password_hash=hash_password(data["password"]), is_active=False, registration_status=PENDING)
    db.add(patron)
    db.flush()
    db.add(PatronRegistration(patron_id=patron.id, status=PENDING, ip=ip))
    audit.record(db, "self_register", "patron", patron.id, ip=ip, branch=branch.code)
    db.flush()
    return patron


def _pending_patron(db: Session, patron_id: int, *, allow: tuple[str, ...] = (PENDING,)) -> tuple[Patron, PatronRegistration]:
    patron = db.get(Patron, patron_id)
    if patron is None or patron.deleted_at is not None or patron.registration_status is None:
        raise NotFound("Registration not found")
    if patron.registration_status not in allow:
        raise Conflict(f"Registration is already {patron.registration_status}")
    reg = db.scalar(select(PatronRegistration).where(PatronRegistration.patron_id == patron.id))
    if reg is None:
        reg = PatronRegistration(patron_id=patron.id, status=patron.registration_status)
        db.add(reg)
    return patron, reg


def approve(db: Session, patron_id: int, *, actor: Patron, category_id: int | None = None,
            home_branch_id: int | None = None, note: str | None = None) -> Patron:
    patron, reg = _pending_patron(db, patron_id, allow=(PENDING, REJECTED))
    if category_id is not None:
        cat = db.get(PatronCategory, category_id)
        if cat is None:
            raise NotFound("Unknown patron category")
        patron.category = cat
    if home_branch_id is not None:
        branch = db.get(Branch, home_branch_id)
        if branch is None:
            raise NotFound("Unknown branch")
        patron.home_branch = branch
    db.flush()
    category = db.get(PatronCategory, patron.category_id)
    patron.is_active = True
    patron.registration_status = APPROVED
    patron.expires_on = (utcnow() + timedelta(days=30 * category.enrollment_months)).date()
    reg.status, reg.reviewed_by, reg.reviewed_at, reg.decision_note = APPROVED, actor, utcnow(), note
    db.flush()
    notices.queue(db, patron, "REGISTRATION_APPROVED")
    audit.record(db, "registration_approved", "patron", patron.id, actor=actor, category=category.code)
    return patron


def reject(db: Session, patron_id: int, *, actor: Patron, reason: str) -> Patron:
    reason = (reason or "").strip()
    if not reason:
        raise PolicyBlocked("Please give a reason — it is sent to the applicant")
    patron, reg = _pending_patron(db, patron_id)
    patron.is_active = False
    patron.registration_status = REJECTED
    reg.status, reg.reviewed_by, reg.reviewed_at, reg.decision_note = REJECTED, actor, utcnow(), reason[:500]
    db.flush()
    notices.queue(db, patron, "REGISTRATION_REJECTED", {"registration": {"reason": reason[:500]}})
    audit.record(db, "registration_rejected", "patron", patron.id, actor=actor)
    return patron


def registration_out(patron: Patron, reg: PatronRegistration | None) -> dict:
    return {
        "patron_id": patron.id, "card_number": patron.card_number, "full_name": patron.full_name,
        "first_name": patron.first_name, "last_name": patron.last_name, "email": patron.email,
        "phone": patron.phone, "address": patron.address, "date_of_birth": patron.date_of_birth,
        "home_branch": {"id": patron.home_branch.id, "name": patron.home_branch.name},
        "category": {"id": patron.category.id, "name": patron.category.name},
        "status": patron.registration_status, "submitted_at": reg.created_at if reg else patron.created_at,
        "reviewed_at": reg.reviewed_at if reg else None,
        "reviewed_by": reg.reviewed_by.full_name if reg and reg.reviewed_by else None,
        "decision_note": reg.decision_note if reg else None,
        "duplicates": [],
    }


def list_registrations(db: Session, status: str | None = PENDING, limit: int = 200) -> list[dict]:
    stmt = select(Patron).where(Patron.registration_status.is_not(None), Patron.deleted_at.is_(None))
    if status:
        stmt = stmt.where(Patron.registration_status == status)
    patrons = db.scalars(stmt.order_by(Patron.created_at.desc()).limit(limit)).all()
    regs = {r.patron_id: r for r in db.scalars(select(PatronRegistration).where(
        PatronRegistration.patron_id.in_([p.id for p in patrons])))} if patrons else {}
    out = []
    for p in patrons:
        row = registration_out(p, regs.get(p.id))
        if p.registration_status == PENDING:  # help staff spot people who already hold a card
            dupes = db.scalars(select(Patron).where(
                Patron.id != p.id, Patron.deleted_at.is_(None),
                func.lower(Patron.last_name) == p.last_name.lower(),
                func.lower(Patron.first_name) == p.first_name.lower()).limit(5)).all()
            row["duplicates"] = [{"id": d.id, "card_number": d.card_number, "full_name": d.full_name} for d in dupes]
        out.append(row)
    return out


def pending_count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(Patron).where(
        Patron.registration_status == PENDING, Patron.deleted_at.is_(None))) or 0


def login_block_message(patron: Patron) -> str | None:
    """Explanation shown at sign-in for accounts that exist but cannot be used yet."""
    if patron.registration_status == PENDING:
        return "Your registration is awaiting approval by library staff. We'll email you as soon as it's approved."
    if patron.registration_status == REJECTED:
        return "Your registration was not approved. Please contact the library for help."
    return None
