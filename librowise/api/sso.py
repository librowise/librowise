"""OpenID Connect single sign-on endpoints, linked identities, and provider administration."""

from __future__ import annotations

import hmac
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import client_ip, interactive_user, optional_user, require
from ..errors import NotFound
from ..models import Patron, UserIdentity
from ..schemas import StrictModel
from ..security import sign, unsign
from ..services import audit, identity, oidc

router = APIRouter(tags=["single sign-on"])

STATE_COOKIE = "sw_oidc"
STATE_PATH = "/api/v1/auth/sso"
STATE_TTL = 600
PID = r"^[a-z0-9][a-z0-9_-]{1,39}$"


def safe_next(value: str | None) -> str | None:
    """Only same-site relative paths are acceptable redirect targets (no open redirects)."""
    if not value or not isinstance(value, str) or len(value) > 512:
        return None
    if not value.startswith("/") or value.startswith("//") or "\\" in value or any(ord(c) < 32 for c in value):
        return None
    return value


def _redirect_uri(request: Request, pid: str) -> str:
    return f"{identity.public_base(request)}{STATE_PATH}/{pid}/callback"


def _state_cookie(response: Response, payload: dict) -> None:
    s = get_settings()
    response.set_cookie(STATE_COOKIE, sign("oidc-state", payload), max_age=STATE_TTL, httponly=True,
                        secure=s.cookie_secure, samesite="lax", path=STATE_PATH)


def _start(db: Session, request: Request, pid: str, next_url: str | None, link_uid: int | None) -> tuple[str, dict]:
    provider = oidc.get_provider(db, pid)
    if provider is None:
        raise NotFound("Unknown sign-in provider")
    try:
        url, secrets_ = oidc.authorization_request(provider, _redirect_uri(request, pid))
    except oidc.OidcError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Sign-in provider unavailable ({exc.code})") from None
    return url, {**secrets_, "provider": pid, "next": safe_next(next_url), "link_uid": link_uid}


@router.get("/auth/sso/providers")
def sso_providers(db: Session = Depends(get_db)):
    return {"results": oidc.public_list(db)}


@router.get("/auth/sso/{pid}/login")
def sso_login(pid: str, request: Request, next: str | None = None, db: Session = Depends(get_db)):
    url, state = _start(db, request, pid, next, None)
    resp = RedirectResponse(url, status_code=303)
    _state_cookie(resp, state)
    return resp


@router.post("/auth/sso/{pid}/link")
def sso_link(pid: str, request: Request, response: Response, user: Patron = Depends(interactive_user),
             db: Session = Depends(get_db)):
    """Begin linking an external identity to the signed-in account (CSRF-protected POST; the browser then
    navigates to the returned URL)."""
    back = "/staff/security" if user.is_staff else "/account#settings"
    url, state = _start(db, request, pid, back, user.id)
    _state_cookie(response, state)
    return {"redirect": url}


def _fail(db: Session, request: Request, reason: str, pid: str, link: bool, back: str | None) -> RedirectResponse:
    audit.record(db, "sso_failed", "patron", None, ip=client_ip(request), provider=pid, reason=reason)
    db.commit()
    target = back if link and back else "/login"
    sep = "&" if "?" in target.split("#")[0] else "?"
    path, _, frag = target.partition("#")
    resp = RedirectResponse(f"{path}{sep}sso_error={reason}{'#' + frag if frag else ''}", status_code=303)
    resp.delete_cookie(STATE_COOKIE, path=STATE_PATH)
    return resp


@router.get("/auth/sso/{pid}/callback")
def sso_callback(pid: str, request: Request, code: str | None = None, state: str | None = None,
                 error: str | None = None, db: Session = Depends(get_db),
                 current: Patron | None = Depends(optional_user)):
    st = unsign("oidc-state", request.cookies.get(STATE_COOKIE, ""), STATE_TTL)
    link_uid = st.get("link_uid") if st else None
    back = st.get("next") if st else None
    if not st or st.get("provider") != pid or not state or not hmac.compare_digest(str(st.get("state")), state):
        return _fail(db, request, "state", pid, bool(link_uid), back)
    if error or not code:
        return _fail(db, request, "denied", pid, bool(link_uid), back)
    provider = oidc.get_provider(db, pid)
    if provider is None:
        return _fail(db, request, "provider", pid, bool(link_uid), back)
    link_user = None
    if link_uid:
        # Linking must complete in the same browser session that started it.
        if current is None or current.id != link_uid:
            return _fail(db, request, "link_session", pid, True, back)
        link_user = current
    try:
        tokens = oidc.exchange_code(provider, code, st["verifier"], _redirect_uri(request, pid))
        claims = oidc.validate_id_token(provider, tokens["id_token"], st["nonce"])
        if not claims.get("email") and tokens.get("access_token"):
            info = oidc.fetch_userinfo(provider, tokens["access_token"], str(claims["sub"]))
            claims = {**claims, **{k: info[k] for k in ("email", "email_verified", "given_name", "family_name", "name")
                                   if k in info}}
        user, created = oidc.resolve_user(db, provider, claims, link_user=link_user)
    except oidc.OidcError as exc:
        db.rollback()
        return _fail(db, request, exc.code, pid, bool(link_uid), back)
    ip = client_ip(request)
    if created:
        audit.record(db, "create", "patron", user.id, ip=ip, via=f"sso:{pid}")
    if link_user is not None:
        audit.record(db, "identity_linked", "patron", user.id, actor=user, ip=ip, provider=pid)
        db.commit()
        resp = RedirectResponse(back or "/", status_code=303)
        resp.delete_cookie(STATE_COOKIE, path=STATE_PATH)
        return resp
    if identity.is_locked(user):
        identity.record_login(db, user, request, False, f"sso:{pid}", "locked")
        return _fail(db, request, "locked", pid, False, None)
    target = back or ("/staff" if user.is_staff else "/account")
    if identity.mfa_enabled(db, user):
        mfa_token = identity.issue_token(db, user, "mfa", identity.MFA_TOKEN_TTL, {"method": f"sso:{pid}", "next": target})
        audit.record(db, "login_mfa_challenge", "patron", user.id, actor=user, ip=ip, provider=pid)
        db.commit()
        resp = RedirectResponse(f"/login#mfa={mfa_token}", status_code=303)
    else:
        resp = RedirectResponse(target, status_code=303)
        identity.complete_login(db, user, request, resp, f"sso:{pid}")
        db.commit()
    resp.delete_cookie(STATE_COOKIE, path=STATE_PATH)
    return resp


# ------------------------------------------------------------------ linked identities (self-service)


@router.get("/auth/identities")
def my_identities(user: Patron = Depends(interactive_user), db: Session = Depends(get_db)):
    labels = {p["id"]: p["label"] for p in oidc.public_list(db)}
    rows = db.scalars(select(UserIdentity).where(UserIdentity.user_id == user.id).order_by(UserIdentity.created_at))
    return {"results": [{"id": i.id, "provider": i.provider, "label": labels.get(i.provider, i.provider),
                         "email": i.email, "created_at": i.created_at, "last_login_at": i.last_login_at} for i in rows],
            "providers": oidc.public_list(db), "has_password": bool(user.password_hash)}


@router.delete("/auth/identities/{identity_id}")
def unlink_identity(identity_id: int, request: Request, user: Patron = Depends(interactive_user),
                    db: Session = Depends(get_db)):
    row = db.get(UserIdentity, identity_id)
    if row is None or row.user_id != user.id:
        raise NotFound("Linked account not found")
    others = db.scalar(select(func.count()).select_from(UserIdentity).where(
        UserIdentity.user_id == user.id, UserIdentity.id != row.id)) or 0
    if not user.password_hash and not others:
        raise HTTPException(status.HTTP_409_CONFLICT, "Set a password first — this is your only way to sign in")
    db.delete(row)
    audit.record(db, "identity_unlinked", "patron", user.id, actor=user, ip=client_ip(request), provider=row.provider)
    db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ provider administration

SETTINGS = require("settings:manage")


class ProviderIn(StrictModel):
    label: str = Field(min_length=1, max_length=60)
    issuer: str = Field(min_length=8, max_length=300)
    client_id: str = Field(min_length=1, max_length=300)
    client_secret: str | None = Field(default=None, max_length=500, description="Leave empty to keep the stored secret")
    client_secret_env: str | None = Field(default=None, max_length=80, pattern=r"^[A-Z_][A-Z0-9_]*$")
    scopes: str = Field(default="openid email profile", max_length=200)
    allowed_domains: list[str] = Field(default_factory=list, max_length=50)
    auto_create: bool = False
    default_category: str | None = Field(default=None, max_length=16)
    default_branch: str | None = Field(default=None, max_length=16)
    allow_staff: bool = True
    allow_patrons: bool = True
    enabled: bool = True

    @field_validator("issuer")
    @classmethod
    def https_issuer(cls, v: str) -> str:
        v = v.rstrip("/")
        if not (v.startswith("https://") or re.match(r"^http://(localhost|127\.0\.0\.1)(:\d+)?(/|$)", v)):
            raise ValueError("issuer must be an https:// URL")
        return v

    @field_validator("scopes")
    @classmethod
    def has_openid(cls, v: str) -> str:
        if "openid" not in v.split():
            raise ValueError("scopes must include 'openid'")
        return v

    @field_validator("allowed_domains")
    @classmethod
    def domains(cls, v: list[str]) -> list[str]:
        out = [d.strip().lower().lstrip("@") for d in v if d.strip()]
        if any(not re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", d) for d in out):
            raise ValueError("invalid domain")
        return out


@router.get("/admin/sso/providers")
def admin_providers(db: Session = Depends(get_db), _: Patron = Depends(SETTINGS)):
    return {"results": [oidc.masked(pid, p) for pid, p in sorted(oidc.providers(db).items())],
            "redirect_uri_template": f"{STATE_PATH}/{{id}}/callback"}


@router.put("/admin/sso/providers/{pid}")
def admin_put_provider(pid: str, body: ProviderIn, request: Request, db: Session = Depends(get_db),
                       user: Patron = Depends(SETTINGS)):
    if not re.match(PID, pid):
        raise HTTPException(422, "Provider id must be 2–40 lowercase letters, digits, '-' or '_'")
    p = oidc.upsert_provider(db, pid, body.model_dump())
    oidc.clear_cache()
    audit.record(db, "sso_provider_saved", "settings", None, actor=user, ip=client_ip(request), provider=pid,
                 issuer=body.issuer, secret_changed=bool(body.client_secret))
    db.commit()
    return oidc.masked(pid, p)


@router.delete("/admin/sso/providers/{pid}")
def admin_delete_provider(pid: str, request: Request, db: Session = Depends(get_db), user: Patron = Depends(SETTINGS)):
    if not oidc.delete_provider(db, pid):
        raise NotFound("Unknown provider")
    audit.record(db, "sso_provider_deleted", "settings", None, actor=user, ip=client_ip(request), provider=pid)
    db.commit()
    return {"ok": True}
