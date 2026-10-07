"""Self-service account security: two-factor authentication, active sessions, sign-in history,
personal API tokens and password reset."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import client_ip, interactive_user
from ..errors import NotFound
from ..models import ApiToken, Patron, UserSession, utcnow
from ..permissions import describe
from ..schemas import StrictModel
from ..security import hash_password, password_problems, reset_limiter
from ..services import audit, identity
from ..services import settings as settings_svc

router = APIRouter(prefix="/auth", tags=["account security"])


def _sid(request: Request) -> str | None:
    return getattr(request.state, "session_sid", None)


# ------------------------------------------------------------------ two-factor authentication


class PasswordIn(StrictModel):
    password: str = Field(default="", max_length=256)


class CodeIn(StrictModel):
    code: str = Field(min_length=6, max_length=32)


class PasswordCodeIn(StrictModel):
    password: str = Field(default="", max_length=256)
    code: str = Field(min_length=6, max_length=32)


@router.get("/mfa")
def mfa_status(user: Patron = Depends(interactive_user), db: Session = Depends(get_db)):
    return identity.mfa_status(db, user)


@router.post("/mfa/setup")
def mfa_setup(body: PasswordIn, request: Request, user: Patron = Depends(interactive_user), db: Session = Depends(get_db)):
    """Start enrolment: returns the secret, an ``otpauth://`` URI and a QR code (SVG data URI)."""
    if not identity.reauthenticate(db, user, body.password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password is incorrect")
    try:
        out = identity.begin_enrollment(db, user, settings_svc.get(db, "library_name") or "Shelfwise")
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    audit.record(db, "mfa_setup_started", "patron", user.id, actor=user, ip=client_ip(request))
    db.commit()
    return out


@router.post("/mfa/activate")
def mfa_activate(body: CodeIn, request: Request, user: Patron = Depends(interactive_user), db: Session = Depends(get_db)):
    """Confirm enrolment with a current code. Returns 10 single-use recovery codes (shown only once)."""
    try:
        codes = identity.activate(db, user, body.code)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    except PermissionError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    audit.record(db, "mfa_enabled", "patron", user.id, actor=user, ip=client_ip(request))
    identity.notify(db, user, "Two-factor authentication enabled",
                    "Two-factor authentication is now required to sign in to your library account.")
    db.commit()
    return {"enabled": True, "recovery_codes": codes}


@router.post("/mfa/recovery-codes")
def mfa_recovery_codes(body: PasswordCodeIn, request: Request, user: Patron = Depends(interactive_user),
                       db: Session = Depends(get_db)):
    if not identity.mfa_enabled(db, user):
        raise HTTPException(status.HTTP_409_CONFLICT, "Two-factor authentication is not enabled")
    if not identity.reauthenticate(db, user, body.password, body.code, need_code=True):
        db.commit()  # persist replay-protection state
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password or authentication code is incorrect")
    codes = identity.regenerate_recovery_codes(db, user)
    audit.record(db, "mfa_recovery_codes_regenerated", "patron", user.id, actor=user, ip=client_ip(request))
    db.commit()
    return {"recovery_codes": codes}


@router.post("/mfa/disable")
def mfa_disable(body: PasswordCodeIn, request: Request, user: Patron = Depends(interactive_user),
                db: Session = Depends(get_db)):
    if not identity.mfa_enabled(db, user):
        raise HTTPException(status.HTTP_409_CONFLICT, "Two-factor authentication is not enabled")
    if identity.mfa_status(db, user)["required"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your library requires two-factor authentication for staff accounts")
    if not identity.reauthenticate(db, user, body.password, body.code, need_code=True):
        db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password or authentication code is incorrect")
    identity.disable_mfa(db, user)
    audit.record(db, "mfa_disabled", "patron", user.id, actor=user, ip=client_ip(request))
    identity.notify(db, user, "Two-factor authentication disabled",
                    "Two-factor authentication was turned off for your library account. If this wasn't you, contact the library.")
    db.commit()
    return {"enabled": False}


# ------------------------------------------------------------------ sessions & sign-in history


@router.get("/sessions")
def my_sessions(request: Request, user: Patron = Depends(interactive_user), db: Session = Depends(get_db)):
    sid = _sid(request)
    return {"results": [identity.session_out(s, sid) for s in identity.active_sessions(db, user)]}


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: int, request: Request, user: Patron = Depends(interactive_user),
                   db: Session = Depends(get_db)):
    s = db.get(UserSession, session_id)
    if s is None or s.user_id != user.id or s.revoked_at is not None:
        raise NotFound("Session not found")
    s.revoked_at = utcnow()
    audit.record(db, "session_revoked", "patron", user.id, actor=user, ip=client_ip(request), session_id=s.id)
    db.commit()
    return {"ok": True, "current": s.sid == _sid(request)}


class RevokeAllIn(StrictModel):
    include_current: bool = False


@router.post("/sessions/revoke-all")
def revoke_all(body: RevokeAllIn, request: Request, user: Patron = Depends(interactive_user),
               db: Session = Depends(get_db)):
    """"Sign out everywhere": ends every other session (and this one with ``include_current``)."""
    n = identity.revoke_all_sessions(db, user, except_sid=None if body.include_current else _sid(request))
    audit.record(db, "sessions_revoked_all", "patron", user.id, actor=user, ip=client_ip(request), count=n,
                 include_current=body.include_current)
    db.commit()
    return {"revoked": n}


@router.get("/logins")
def my_logins(limit: int = 30, user: Patron = Depends(interactive_user), db: Session = Depends(get_db)):
    return {"results": identity.login_history(db, user, max(1, min(limit, 100)))}


# ------------------------------------------------------------------ personal API tokens


class ApiTokenIn(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    scopes: list[str] = Field(min_length=1, max_length=64)
    expires_days: int | None = Field(default=90, ge=1, le=3650)


@router.get("/scopes")
def my_scopes(user: Patron = Depends(interactive_user)):
    """Scopes this account may put on a personal API token (its own effective permissions)."""
    return {"results": [{"code": c, "description": describe(c)} for c in identity.grantable_scopes(user)]}


@router.get("/tokens")
def my_tokens(user: Patron = Depends(interactive_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(ApiToken).where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
                      .order_by(ApiToken.created_at.desc()))
    return {"results": [identity.api_token_out(t) for t in rows]}


@router.post("/tokens", status_code=201)
def create_token(body: ApiTokenIn, request: Request, user: Patron = Depends(interactive_user),
                 db: Session = Depends(get_db)):
    try:
        row, plaintext = identity.create_api_token(db, user, body.name, body.scopes, body.expires_days)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    audit.record(db, "api_token_created", "patron", user.id, actor=user, ip=client_ip(request), token_id=row.id,
                 name=row.name, scopes=row.scopes)
    db.commit()
    return {**identity.api_token_out(row), "token": plaintext}


@router.delete("/tokens/{token_id}")
def revoke_token(token_id: int, request: Request, user: Patron = Depends(interactive_user),
                 db: Session = Depends(get_db)):
    row = db.get(ApiToken, token_id)
    if row is None or row.user_id != user.id or row.revoked_at is not None:
        raise NotFound("Token not found")
    row.revoked_at = utcnow()
    audit.record(db, "api_token_revoked", "patron", user.id, actor=user, ip=client_ip(request), token_id=row.id)
    db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ password reset (unauthenticated)

RESET_MESSAGE = ("If an account matches what you entered and has an e-mail address, we've sent a link to reset "
                 "the password. The link expires in 30 minutes.")


class ResetRequestIn(StrictModel):
    identifier: str = Field(min_length=1, max_length=160, description="Card number or e-mail address")


class ResetConfirmIn(StrictModel):
    token: str = Field(min_length=10, max_length=512)
    new_password: str = Field(min_length=10, max_length=256)


@router.post("/password-reset")
def password_reset_request(body: ResetRequestIn, request: Request, db: Session = Depends(get_db)):
    """Always returns the same response whether or not the account exists (no user enumeration)."""
    ip = client_ip(request)
    if not reset_limiter.allow(f"ip:{ip}") or not reset_limiter.allow(f"id:{body.identifier.lower()}"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many reset requests. Try again later.")
    if not identity.policy(db, "password_reset_enabled"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Self-service password reset is disabled. Please contact the library.")
    user = identity.find_account(db, body.identifier)
    if user is not None and user.email:
        identity.request_password_reset(db, user, request)
        audit.record(db, "password_reset_requested", "patron", user.id, ip=ip)
        db.commit()
    return {"ok": True, "message": RESET_MESSAGE}


@router.post("/password-reset/confirm")
def password_reset_confirm(body: ResetConfirmIn, request: Request, db: Session = Depends(get_db)):
    ip = client_ip(request)
    if not reset_limiter.allow(f"confirm:{ip}"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts. Try again later.")
    found = identity.consume_reset_token(db, body.token)
    if found is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This reset link is invalid, already used or expired. Request a new one.")
    if problems := password_problems(body.new_password):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Password " + "; ".join(problems))
    row, user = found
    row.used_at = utcnow()
    user.password_hash = hash_password(body.new_password)
    identity.unlock(user)
    n = identity.revoke_all_sessions(db, user)
    identity.record_login(db, user, request, True, "password_reset")
    identity.notify(db, user, "Your library password was reset",
                    "Your password was reset using an e-mailed link and all sessions were signed out. "
                    "If this wasn't you, contact the library immediately.")
    audit.record(db, "password_reset", "patron", user.id, actor=user, ip=ip, sessions_revoked=n)
    db.commit()
    return {"ok": True}
