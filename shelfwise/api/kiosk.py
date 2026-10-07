"""Self-checkout kiosk API.

Security model
* A kiosk *device* authenticates with a random token sent in the ``X-Kiosk-Token`` header (provisioned
  by staff; only its SHA-256 is stored). Cookies and staff bearer tokens are never consulted here, so a
  staff session left open in the kiosk browser grants nothing.
* A patron signs in with card number + password and receives a short-lived kiosk session token
  (``X-Kiosk-Session``): sliding idle timeout, absolute lifetime cap, bound to the device, revoked on
  "finish". Sessions live server-side so they can be ended and audited.
* Circulation goes through the normal services with ``override=False`` — every policy block applies,
  including holds: an item reserved for someone else (on the hold shelf, or wanted by the head of the
  title's queue) cannot be self-checked out.
* Requests are rate-limited per device, sign-in attempts per device and per card.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import client_ip, require
from ..errors import NotFound, PolicyBlocked
from ..models import Branch, Hold, HoldStatus, KioskDevice, KioskSession, Loan, Patron, utcnow
from ..schemas import money
from ..security import SlidingWindowLimiter, verify_password
from ..services import audit, catalog, circulation
from ..services import settings as settings_svc

router = APIRouter(prefix="/kiosk", tags=["kiosk"])

DEVICE_HEADER = "X-Kiosk-Token"
SESSION_HEADER = "X-Kiosk-Session"
SESSION_IDLE = timedelta(minutes=3)
SESSION_MAX = timedelta(minutes=20)

device_limiter = SlidingWindowLimiter(180)  # requests per device per minute
signin_limiter = SlidingWindowLimiter(8)  # sign-in attempts per device / per card per minute


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _new_token(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class DeviceIn(_In):
    name: str = Field(min_length=1, max_length=120)
    branch_id: int


class DevicePatch(_In):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    branch_id: int | None = None
    active: bool | None = None


class SignInIn(_In):
    card: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=256)


class BarcodeIn(_In):
    barcode: str = Field(min_length=1, max_length=32)


class RenewKioskIn(_In):
    loan_id: int


# ------------------------------------------------------------------ dependencies


def kiosk_device(request: Request, db: Session = Depends(get_db)) -> KioskDevice:
    token = request.headers.get(DEVICE_HEADER, "").strip()
    if not token:
        raise HTTPException(401, "This kiosk has not been set up", headers={"WWW-Authenticate": "KioskToken"})
    device = db.scalar(select(KioskDevice).where(KioskDevice.token_hash == _hash(token)))
    if device is None or not device.active:
        raise HTTPException(401, "Invalid or deactivated kiosk token", headers={"WWW-Authenticate": "KioskToken"})
    if not device_limiter.allow(f"device:{device.id}"):
        raise HTTPException(429, "Too many requests from this kiosk; please wait a moment")
    now = utcnow()
    if device.last_seen_at is None or now - device.last_seen_at > timedelta(seconds=30):
        device.last_seen_at = now
        device.last_ip = client_ip(request)
        db.commit()
    return device


def kiosk_session(request: Request, device: KioskDevice = Depends(kiosk_device),
                  db: Session = Depends(get_db)) -> KioskSession:
    token = request.headers.get(SESSION_HEADER, "").strip()
    session = db.scalar(select(KioskSession).where(KioskSession.token_hash == _hash(token))) if token else None
    now = utcnow()
    if (session is None or session.device_id != device.id or session.ended_at is not None
            or now - session.last_active_at > SESSION_IDLE or now - session.created_at > SESSION_MAX):
        raise HTTPException(401, "Your session has ended — please sign in again", headers={"WWW-Authenticate": "KioskSession"})
    patron = session.patron
    if patron is None or not patron.is_active or patron.deleted_at is not None:
        raise HTTPException(401, "Account unavailable")
    session.last_active_at = now
    return session


# ------------------------------------------------------------------ device management (staff)


def _device_out(d: KioskDevice) -> dict:
    return {"id": d.id, "name": d.name, "active": d.active, "token_hint": d.token_hint,
            "branch": {"id": d.branch.id, "name": d.branch.name}, "last_seen_at": d.last_seen_at,
            "last_ip": d.last_ip, "created_at": d.created_at}


def _issue_token(d: KioskDevice) -> str:
    token = _new_token("kiosk")
    d.token_hash = _hash(token)
    d.token_hint = token[:10]
    return token


@router.get("/devices")
def list_devices(db: Session = Depends(get_db), _: Patron = Depends(require("kiosks:manage"))):
    return {"results": [_device_out(d) for d in db.scalars(select(KioskDevice).order_by(KioskDevice.name))]}


@router.post("/devices", status_code=201)
def create_device(body: DeviceIn, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(require("kiosks:manage"))):
    if db.get(Branch, body.branch_id) is None:
        raise HTTPException(422, "Unknown branch")
    d = KioskDevice(name=body.name, branch_id=body.branch_id, created_by_id=user.id, token_hash="", token_hint="")
    token = _issue_token(d)
    db.add(d)
    db.flush()
    audit.record(db, "kiosk_create", "kiosk", d.id, actor=user, ip=client_ip(request), name=d.name)
    db.commit()
    return {**_device_out(d), "token": token}


def _get_device(db: Session, device_id: int) -> KioskDevice:
    d = db.get(KioskDevice, device_id)
    if d is None:
        raise NotFound("Kiosk not found")
    return d


@router.patch("/devices/{device_id}")
def update_device(device_id: int, body: DevicePatch, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(require("kiosks:manage"))):
    d = _get_device(db, device_id)
    data = body.model_dump(exclude_unset=True)
    if "branch_id" in data and db.get(Branch, data["branch_id"]) is None:
        raise HTTPException(422, "Unknown branch")
    for k, v in data.items():
        setattr(d, k, v)
    if data.get("active") is False:  # deactivating ends any patron session on the device
        for s in db.scalars(select(KioskSession).where(KioskSession.device_id == d.id, KioskSession.ended_at.is_(None))):
            s.ended_at = utcnow()
    audit.record(db, "kiosk_update", "kiosk", d.id, actor=user, ip=client_ip(request), fields=sorted(data))
    db.commit()
    db.refresh(d)
    return _device_out(d)


@router.post("/devices/{device_id}/rotate")
def rotate_token(device_id: int, request: Request, db: Session = Depends(get_db),
                 user: Patron = Depends(require("kiosks:manage"))):
    d = _get_device(db, device_id)
    token = _issue_token(d)
    for s in db.scalars(select(KioskSession).where(KioskSession.device_id == d.id, KioskSession.ended_at.is_(None))):
        s.ended_at = utcnow()
    audit.record(db, "kiosk_rotate", "kiosk", d.id, actor=user, ip=client_ip(request))
    db.commit()
    return {**_device_out(d), "token": token}


@router.delete("/devices/{device_id}")
def delete_device(device_id: int, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(require("kiosks:manage"))):
    d = _get_device(db, device_id)
    audit.record(db, "kiosk_delete", "kiosk", d.id, actor=user, ip=client_ip(request), name=d.name)
    for s in db.scalars(select(KioskSession).where(KioskSession.device_id == d.id)):
        db.delete(s)
    db.delete(d)
    db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ kiosk endpoints (device token only)


@router.get("/hello")
def hello(device: KioskDevice = Depends(kiosk_device), db: Session = Depends(get_db)):
    return {"device": {"id": device.id, "name": device.name}, "branch": {"id": device.branch.id, "name": device.branch.name},
            "library_name": settings_svc.get(db, "library_name"),
            "allow_renewal": bool(settings_svc.get(db, "allow_patron_self_renewal")),
            "session_idle_seconds": int(SESSION_IDLE.total_seconds())}


def _mask(card: str) -> str:
    return "•" * max(0, len(card) - 4) + card[-4:]


def _loan_line(db: Session, loan: Loan, patron: Patron) -> dict:
    blocks = circulation.renewal_blocks(db, loan)
    now = utcnow()
    return {"id": loan.id, "title": loan.item.biblio.title, "authors": loan.item.biblio.authors or [],
            "barcode": loan.item.barcode, "issued_at": loan.issued_at, "due_at": loan.due_at, "renewals": loan.renewals,
            "overdue": loan.due_at < now, "can_renew": not blocks, "renew_blocks": blocks}


def _summary(db: Session, session: KioskSession) -> dict:
    p = session.patron
    holds = db.scalars(select(Hold).where(Hold.patron_id == p.id, Hold.status == HoldStatus.ready).order_by(Hold.expires_at)).all()
    return {
        "patron": {"first_name": p.first_name, "card": _mask(p.card_number), "category": p.category.name},
        "loans": [_loan_line(db, loan, p) for loan in circulation.open_loans(db, p.id)],
        "holds_ready": [{"id": h.id, "title": h.biblio.title, "pickup": h.pickup_branch.name, "expires_at": h.expires_at,
                         "here": h.pickup_branch_id == session.device.branch_id} for h in holds],
        "balance": money(circulation.balance(db, p.id)),
        "blocks": circulation.patron_blocks(db, p),
        "max_loans": p.category.max_loans,
        "activity": session.activity or [],
        "expires_in": int(SESSION_IDLE.total_seconds()),
    }


@router.post("/session", status_code=201)
def sign_in(body: SignInIn, request: Request, device: KioskDevice = Depends(kiosk_device), db: Session = Depends(get_db)):
    card = body.card.strip()
    if not signin_limiter.allow(f"dev:{device.id}") or not signin_limiter.allow(f"card:{card.lower()}"):
        raise HTTPException(429, "Too many sign-in attempts. Please wait a minute or ask staff for help.")
    patron = db.scalar(select(Patron).where(Patron.card_number == card, Patron.deleted_at.is_(None)))
    if patron is None or not verify_password(patron.password_hash, body.password) or not patron.is_active:
        audit.record(db, "kiosk_login_failed", "patron", patron.id if patron else None, ip=client_ip(request),
                     kiosk=device.id)
        db.commit()
        raise HTTPException(401, "Card number or password not recognised")
    # One patron per kiosk at a time: end anything still open on this device.
    for s in db.scalars(select(KioskSession).where(KioskSession.device_id == device.id, KioskSession.ended_at.is_(None))):
        s.ended_at = utcnow()
    token = _new_token("ks")
    session = KioskSession(device_id=device.id, patron_id=patron.id, token_hash=_hash(token), activity=[])
    db.add(session)
    db.flush()
    audit.record(db, "kiosk_login", "patron", patron.id, actor=patron, ip=client_ip(request), kiosk=device.id)
    db.commit()
    db.refresh(session)
    return {"session_token": token, **_summary(db, session)}


@router.get("/me")
def me(session: KioskSession = Depends(kiosk_session), db: Session = Depends(get_db)):
    out = _summary(db, session)
    db.commit()  # persist the sliding idle timeout
    return out


def _log(session: KioskSession, kind: str, loan: Loan) -> None:
    session.activity = [*(session.activity or []), {"kind": kind, "loan_id": loan.id, "at": utcnow().isoformat()}]


def _reserved_for_someone_else(db: Session, item, patron: Patron) -> bool:
    """True when the hold queue (or hold shelf) says this copy belongs to another patron."""
    ready = db.scalar(select(Hold).where(Hold.item_id == item.id, Hold.status == HoldStatus.ready))
    if ready is not None:
        return ready.patron_id != patron.id
    head = db.scalar(select(Hold).where(
        Hold.biblio_id == item.biblio_id, Hold.status == HoldStatus.queued,
        (Hold.item_id.is_(None)) | (Hold.item_id == item.id)).order_by(Hold.created_at, Hold.id).limit(1))
    return head is not None and head.patron_id != patron.id


@router.post("/checkout")
def checkout(body: BarcodeIn, request: Request, session: KioskSession = Depends(kiosk_session), db: Session = Depends(get_db)):
    patron, device = session.patron, session.device
    item = catalog.item_by_barcode(db, body.barcode)
    if _reserved_for_someone_else(db, item, patron):
        raise PolicyBlocked("This item is reserved for another reader. Please hand it to library staff.", code="reserved")
    res = circulation.checkout(db, patron, item, branch_id=device.branch_id, actor=patron, override=False)
    _log(session, "checkout", res.loan)
    audit.record(db, "kiosk_checkout", "loan", res.loan.id, actor=patron, ip=client_ip(request), kiosk=device.id,
                 item=item.barcode)
    db.commit()
    return {"loan": _loan_line(db, res.loan, patron), "warnings": res.warnings}


@router.post("/renew")
def renew(body: RenewKioskIn, request: Request, session: KioskSession = Depends(kiosk_session), db: Session = Depends(get_db)):
    if not settings_svc.get(db, "allow_patron_self_renewal"):
        raise HTTPException(403, "Renewal at the kiosk is disabled — please ask staff")
    loan = db.get(Loan, body.loan_id)
    if loan is None or loan.patron_id != session.patron_id or loan.returned_at is not None:
        raise NotFound("Loan not found")
    circulation.renew(db, loan, actor=session.patron, override=False)
    _log(session, "renew", loan)
    audit.record(db, "kiosk_renew", "loan", loan.id, actor=session.patron, ip=client_ip(request), kiosk=session.device_id)
    db.commit()
    return {"loan": _loan_line(db, loan, session.patron)}


def _receipt(db: Session, session: KioskSession) -> dict:
    lines = []
    for entry in session.activity or []:
        loan = db.get(Loan, entry.get("loan_id"))
        if loan is None:
            continue
        lines.append({"kind": entry.get("kind"), "title": loan.item.biblio.title, "barcode": loan.item.barcode,
                      "due_at": loan.due_at, "at": entry.get("at")})
    return {"library_name": settings_svc.get(db, "library_name"), "branch": session.device.branch.name,
            "kiosk": session.device.name, "patron": {"first_name": session.patron.first_name, "card": _mask(session.patron.card_number)},
            "generated_at": utcnow(), "lines": lines,
            "open_loans": [{"title": loan.item.biblio.title, "due_at": loan.due_at}
                           for loan in circulation.open_loans(db, session.patron_id)]}


@router.get("/receipt")
def receipt(session: KioskSession = Depends(kiosk_session), db: Session = Depends(get_db)):
    out = _receipt(db, session)
    db.commit()
    return out


@router.post("/session/end")
def end_session(request: Request, session: KioskSession = Depends(kiosk_session), db: Session = Depends(get_db)):
    out = _receipt(db, session)
    session.ended_at = utcnow()
    audit.record(db, "kiosk_logout", "patron", session.patron_id, actor=session.patron, ip=client_ip(request),
                 kiosk=session.device_id, items=len(out["lines"]))
    db.commit()
    return out
