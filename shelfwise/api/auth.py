from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import _token_from_request, authenticated_user, client_ip, current_user, interactive_user
from ..models import Patron, UserSession, utcnow
from ..schemas import LoginIn, PasswordChangeIn, PreferencesIn, StrictModel, patron_out
from ..security import (
    ALL,
    CSRF_COOKIE,
    RESTRICTED_ATTR,
    SCOPES_ATTR,
    SESSION_COOKIE,
    effective_permissions,
    hash_password,
    login_limiter,
    mfa_limiter,
    needs_rehash,
    password_problems,
    read_session_token,
    verify_password,
)
from ..services import audit, identity

router = APIRouter(prefix="/auth", tags=["auth"])

INVALID_LOGIN = "Invalid card number/email or password"


def _set_session(response: Response, user: Patron, db: Session, request: Request | None, method: str = "password") -> str:
    _session, token = identity.start_session(db, user, request, method)
    identity.set_session_cookies(response, token)
    return token


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    """Password sign-in. When the account has two-factor authentication enabled the response is
    ``{"mfa_required": true, "mfa_token": …}`` and the sign-in is completed with ``POST /auth/mfa``."""
    ip = client_ip(request)
    if not login_limiter.allow(f"{ip}:{body.username.lower()}") or not login_limiter.allow(f"ip:{ip}"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many login attempts. Try again in a minute.")
    user = db.scalar(select(Patron).where(
        or_(Patron.card_number == body.username, Patron.email == body.username.lower()),
        Patron.deleted_at.is_(None)))
    if user is not None and identity.is_locked(user):
        verify_password(None, body.password)  # same work as a normal attempt; locked state is not revealed
        identity.record_login(db, user, request, False, "password", "locked")
        audit.record(db, "login_failed", "patron", user.id, ip=ip, username=body.username[:64], reason="locked")
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, INVALID_LOGIN)
    if user is None or not verify_password(user.password_hash, body.password) or not user.is_active:
        if user is not None:
            identity.register_failure(db, user, request, "password", "inactive" if not user.is_active else "bad_password")
        audit.record(db, "login_failed", "patron", user.id if user else None, ip=ip, username=body.username[:64])
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, INVALID_LOGIN)
    if needs_rehash(user.password_hash or ""):
        user.password_hash = hash_password(body.password)
    if identity.mfa_enabled(db, user):
        mfa_token = identity.issue_token(db, user, "mfa", identity.MFA_TOKEN_TTL, {"method": "password"})
        audit.record(db, "login_mfa_challenge", "patron", user.id, actor=user, ip=ip)
        db.commit()
        return {"mfa_required": True, "mfa_token": mfa_token, "methods": ["totp", "recovery_code"],
                "expires_in": identity.MFA_TOKEN_TTL}
    token = identity.complete_login(db, user, request, response, "password")
    db.commit()
    return {"token": token, "user": _me(user, db), "mfa_enrollment_required": identity.mfa_enrollment_required(db, user)}


class MfaVerifyIn(StrictModel):
    mfa_token: str = Field(min_length=10, max_length=512)
    code: str = Field(min_length=6, max_length=32, description="6-digit authenticator code or a recovery code")


@router.post("/mfa")
def mfa_verify(body: MfaVerifyIn, request: Request, response: Response, db: Session = Depends(get_db)):
    """Second step of a sign-in: exchange the single-use ``mfa_token`` and a TOTP/recovery code for a session."""
    ip = client_ip(request)
    if not mfa_limiter.allow(f"ip:{ip}"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts. Try again in a minute.")
    row = identity.load_token(db, body.mfa_token, "mfa", identity.MFA_TOKEN_TTL)
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "This sign-in attempt has expired. Please sign in again.")
    user = db.get(Patron, row.user_id)
    now = utcnow()
    if user is None or not user.is_active or user.deleted_at is not None or identity.is_locked(user):
        row.used_at = now
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "This sign-in attempt has expired. Please sign in again.")
    factor = identity.verify_second_factor(db, user, body.code)
    if factor is None:
        row.attempts = (row.attempts or 0) + 1
        if row.attempts >= identity.MFA_MAX_ATTEMPTS:
            row.used_at = now  # burn the challenge; the user must start again with the password
        identity.register_failure(db, user, request, "2fa", "bad_code")
        audit.record(db, "mfa_failed", "patron", user.id, ip=ip, attempts=row.attempts)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid authentication code")
    row.used_at = now
    first = (row.data or {}).get("method", "password")
    token = identity.complete_login(db, user, request, response, f"{first}+{factor}")
    remaining = identity.mfa_status(db, user)["recovery_codes_remaining"]
    if factor == "recovery":
        audit.record(db, "mfa_recovery_code_used", "patron", user.id, actor=user, ip=ip, remaining=remaining)
        identity.notify(db, user, "A recovery code was used to sign in",
                        f"A two-factor recovery code was used to sign in to your account. {remaining} code(s) remain. "
                        "If this wasn't you, change your password and regenerate your recovery codes.")
    db.commit()
    return {"token": token, "user": _me(user, db), "next": (row.data or {}).get("next"),
            "recovery_codes_remaining": remaining}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token, _ = _token_from_request(request)
    data = read_session_token(token) if token and not token.startswith(identity.API_TOKEN_PREFIX) else None
    if data and data.get("sid"):
        s = db.scalar(select(UserSession).where(UserSession.sid == str(data["sid"]), UserSession.revoked_at.is_(None)))
        if s is not None and s.user_id == data.get("uid"):
            s.revoked_at = utcnow()
            audit.record(db, "logout", "patron", s.user_id, ip=client_ip(request))
            db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    return {"ok": True}


def _me(user: Patron, db: Session | None = None) -> dict:
    out = patron_out(user)
    perms = effective_permissions(user)
    scopes = getattr(user, SCOPES_ATTR, None)
    if scopes is not None:
        perms = set(scopes) if ALL in perms else perms & scopes
    restricted = getattr(user, RESTRICTED_ATTR, False) or bool(db is not None and identity.mfa_enrollment_required(db, user))
    if restricted:
        perms = perms & {"opac"} if ALL not in perms else {"opac"}
    out["permissions"] = sorted(perms)
    out["is_staff"] = user.is_staff
    out["staff_role"] = ({"id": user.staff_role.id, "name": user.staff_role.name}
                         if user.staff_role_id is not None and user.staff_role is not None else None)
    out["mfa_enabled"] = identity.mfa_enabled(db, user) if db is not None else None
    out["mfa_enrollment_required"] = restricted
    out["has_password"] = bool(user.password_hash)
    return out


@router.get("/me")
def me(user: Patron = Depends(authenticated_user), db: Session = Depends(get_db)):
    return _me(user, db)


@router.post("/password")
def change_password(body: PasswordChangeIn, request: Request, response: Response,
                    user: Patron = Depends(interactive_user), db: Session = Depends(get_db)):
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    if problems := password_problems(body.new_password):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Password " + "; ".join(problems))
    user.password_hash = hash_password(body.new_password)
    revoked = identity.revoke_all_sessions(db, user)  # every other session (and this one) ends …
    token = _set_session(response, user, db, request, "password_change")  # … and this browser gets a fresh one
    identity.notify(db, user, "Your library password was changed",
                    "The password for your library account was just changed. If this wasn't you, contact the library.")
    audit.record(db, "password_changed", "patron", user.id, actor=user, ip=client_ip(request), sessions_revoked=revoked)
    db.commit()
    return {"ok": True, "token": token}


@router.patch("/preferences")
def preferences(body: PreferencesIn, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    prefs = dict(user.preferences or {})
    data = body.model_dump(exclude_none=True)
    if "keep_history" in data:
        user.keep_history = data.pop("keep_history")
    prefs.update(data)
    user.preferences = prefs
    db.commit()
    return _me(user, db)
