from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import client_ip, current_user
from ..models import Patron, utcnow
from ..schemas import LoginIn, PasswordChangeIn, PreferencesIn, patron_out
from ..security import (
    CSRF_COOKIE,
    ROLE_PERMISSIONS,
    SESSION_COOKIE,
    create_session_token,
    hash_password,
    login_limiter,
    needs_rehash,
    new_csrf_token,
    password_problems,
    verify_password,
)
from ..services import audit

router = APIRouter(prefix="/auth", tags=["auth"])


def _set_session(response: Response, user: Patron) -> str:
    s = get_settings()
    token = create_session_token(user)
    response.set_cookie(SESSION_COOKIE, token, max_age=s.session_max_age, httponly=True,
                        secure=s.cookie_secure, samesite="lax", path="/")
    response.set_cookie(CSRF_COOKIE, new_csrf_token(), max_age=s.session_max_age, httponly=False,
                        secure=s.cookie_secure, samesite="strict", path="/")
    return token


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = client_ip(request)
    if not login_limiter.allow(f"{ip}:{body.username.lower()}") or not login_limiter.allow(f"ip:{ip}"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many login attempts. Try again in a minute.")
    user = db.scalar(select(Patron).where(
        or_(Patron.card_number == body.username, Patron.email == body.username.lower()),
        Patron.deleted_at.is_(None)))
    if user is None or not verify_password(user.password_hash, body.password) or not user.is_active:
        audit.record(db, "login_failed", "patron", user.id if user else None, ip=ip, username=body.username[:64])
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid card number/email or password")
    if needs_rehash(user.password_hash or ""):
        user.password_hash = hash_password(body.password)
    user.last_login_at = utcnow()
    audit.record(db, "login", "patron", user.id, actor=user, ip=ip)
    db.commit()
    token = _set_session(response, user)
    return {"token": token, "user": _me(user)}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    return {"ok": True}


def _me(user: Patron) -> dict:
    out = patron_out(user)
    perms = ROLE_PERMISSIONS.get(user.role, set())
    out["permissions"] = sorted(perms)
    out["is_staff"] = user.is_staff
    return out


@router.get("/me")
def me(user: Patron = Depends(current_user)):
    return _me(user)


@router.post("/password")
def change_password(body: PasswordChangeIn, response: Response, user: Patron = Depends(current_user),
                    db: Session = Depends(get_db)):
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    if problems := password_problems(body.new_password):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Password " + "; ".join(problems))
    user.password_hash = hash_password(body.new_password)
    audit.record(db, "password_changed", "patron", user.id, actor=user)
    db.commit()
    _set_session(response, user)  # old sessions are revoked by the new password fingerprint
    return {"ok": True}


@router.patch("/preferences")
def preferences(body: PreferencesIn, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    prefs = dict(user.preferences or {})
    data = body.model_dump(exclude_none=True)
    if "keep_history" in data:
        user.keep_history = data.pop("keep_history")
    prefs.update(data)
    user.preferences = prefs
    db.commit()
    return _me(user)
