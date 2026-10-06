"""Identity & access services: sessions, API tokens, lockout, login history, TOTP 2FA,
one-time tokens and password reset.

Security notes
* Session tokens are signed (itsdangerous) *and* backed by a ``UserSession`` row, so they can be listed
  and revoked individually. Personal API tokens are random 256-bit strings; only SHA-256 hashes are stored.
* One-time tokens (MFA challenges, password resets) are signed, expire quickly and are backed by an
  ``AuthToken`` row that is marked used, so they cannot be replayed.
* TOTP secrets are encrypted at rest (AES-GCM, key derived from ``SHELFWISE_SECRET_KEY``); recovery codes
  are stored as keyed hashes. Rotating the secret key therefore invalidates enrolled authenticators.
"""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import Request, Response
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import (
    ApiToken,
    AuthToken,
    LoginEvent,
    MfaRecoveryCode,
    MfaTotp,
    Notification,
    Patron,
    UserSession,
    utcnow,
)
from ..permissions import ALL, PERMISSION_CODES
from ..security import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    create_session_token,
    effective_permissions,
    keyed_hash,
    new_csrf_token,
    seal,
    sha256_hex,
    sign,
    unseal,
    verify_password,
)
from . import audit, totp
from . import settings as settings_svc

log = logging.getLogger("shelfwise.identity")

# ------------------------------------------------------------------ security policy settings

POLICY_DEFAULTS = {
    "require_2fa_for_staff": (False, "Staff accounts must enrol in two-factor authentication at their next sign-in"),
    "lockout_threshold": (5, "Failed sign-in attempts before an account is temporarily locked (0 = never lock)"),
    "lockout_minutes": (15, "How long an account stays locked after too many failed sign-ins"),
    "session_idle_timeout_minutes": (0, "Sign out sessions idle for longer than this many minutes (0 = no idle timeout)"),
    "notify_new_signin": (False, "Queue a notice when an account signs in from a new device or network"),
    "password_reset_enabled": (True, "Allow self-service password reset by email from the sign-in page"),
}
for _k, _v in POLICY_DEFAULTS.items():
    settings_svc.DEFAULTS.setdefault(_k, _v)


def policy(db: Session, key: str):
    value = settings_svc.get(db, key)
    return POLICY_DEFAULTS[key][0] if value is None else value


SESSION_TOUCH_SECONDS = 60
MFA_TOKEN_TTL = 5 * 60
MFA_MAX_ATTEMPTS = 5
RESET_TOKEN_TTL = 30 * 60
API_TOKEN_PREFIX = "swt_"
RECOVERY_CODE_COUNT = 10


def _naive(dt: datetime) -> datetime:
    return dt.astimezone(UTC).replace(tzinfo=None) if dt.tzinfo else dt


def client_meta(request: Request | None) -> tuple[str | None, str | None]:
    if request is None:
        return None, None
    ip = request.client.host if request.client else None
    return ip, (request.headers.get("user-agent") or "")[:255] or None


# ------------------------------------------------------------------ notifications


def notify(db: Session, user: Patron, subject: str, body: str) -> None:
    """Queue an e-mail notice (delivered by the notices subsystem)."""
    db.add(Notification(patron_id=user.id, channel="email", subject=subject[:255], body=body))


# ------------------------------------------------------------------ sessions


def start_session(db: Session, user: Patron, request: Request | None, method: str) -> tuple[UserSession, str]:
    ip, ua = client_meta(request)
    now = utcnow()
    s = UserSession(sid=secrets.token_urlsafe(24), user_id=user.id, created_at=now, last_seen_at=now,
                    expires_at=now + timedelta(seconds=get_settings().session_max_age), ip=ip, user_agent=ua,
                    method=method[:40])
    db.add(s)
    db.flush()
    return s, create_session_token(user, s.sid)


LEGACY_SESSION = object()  # a valid token minted without a server-side session row


def check_session(db: Session, user: Patron, data: dict):
    """Validate the server-side state of a decoded session token. Returns the ``UserSession``,
    ``LEGACY_SESSION`` for sid-less tokens, or ``None`` when revoked/expired."""
    now = utcnow()
    sid = data.get("sid")
    if not sid:
        cutoff = user.sessions_revoked_at
        if cutoff is not None and data.get("iat", 0) <= int(cutoff.replace(tzinfo=UTC).timestamp()):
            return None
        return LEGACY_SESSION
    s = db.scalar(select(UserSession).where(UserSession.sid == str(sid)))
    if s is None or s.user_id != user.id or s.revoked_at is not None or s.expires_at <= now:
        return None
    idle = int(policy(db, "session_idle_timeout_minutes") or 0)
    if idle and s.last_seen_at < now - timedelta(minutes=idle):
        s.revoked_at = now
        db.commit()
        return None
    if (now - s.last_seen_at).total_seconds() > SESSION_TOUCH_SECONDS:  # throttled activity tracking
        s.last_seen_at = now
        db.commit()
    return s


def revoke_all_sessions(db: Session, user: Patron, *, except_sid: str | None = None) -> int:
    now = utcnow()
    stmt = update(UserSession).where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
    if except_sid:
        stmt = stmt.where(UserSession.sid != except_sid)
    n = db.execute(stmt.values(revoked_at=now)).rowcount or 0
    user.sessions_revoked_at = now  # also invalidates any legacy (sid-less) tokens
    return n


def active_sessions(db: Session, user: Patron) -> list[UserSession]:
    now = utcnow()
    return list(db.scalars(select(UserSession).where(
        UserSession.user_id == user.id, UserSession.revoked_at.is_(None), UserSession.expires_at > now,
    ).order_by(UserSession.last_seen_at.desc())))


def session_out(s: UserSession, current_sid: str | None = None) -> dict:
    return {"id": s.id, "created_at": s.created_at, "last_seen_at": s.last_seen_at, "expires_at": s.expires_at,
            "ip": s.ip, "user_agent": s.user_agent, "method": s.method, "current": s.sid == current_sid}


def set_session_cookies(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(SESSION_COOKIE, token, max_age=s.session_max_age, httponly=True,
                        secure=s.cookie_secure, samesite="lax", path="/")
    response.set_cookie(CSRF_COOKIE, new_csrf_token(), max_age=s.session_max_age, httponly=False,
                        secure=s.cookie_secure, samesite="strict", path="/")


def complete_login(db: Session, user: Patron, request: Request | None, response: Response, method: str) -> str:
    """Final step of every successful sign-in (password, password+2FA, SSO): creates the server-side
    session, sets cookies, resets the lockout counter, records history/audit and new-device notices."""
    ip, ua = client_meta(request)
    if policy(db, "notify_new_signin"):
        seen = db.scalar(select(LoginEvent.id).where(LoginEvent.user_id == user.id, LoginEvent.success.is_(True),
                                                     LoginEvent.ip == ip, LoginEvent.user_agent == ua).limit(1))
        had_any = db.scalar(select(LoginEvent.id).where(LoginEvent.user_id == user.id,
                                                        LoginEvent.success.is_(True)).limit(1))
        if had_any and not seen:
            notify(db, user, "New sign-in to your library account",
                   f"Your account was signed in to at {utcnow():%Y-%m-%d %H:%M} UTC from {ip or 'an unknown address'} "
                   f"({ua or 'unknown device'}). If this wasn't you, reset your password and sign out all sessions.")
    _session, token = start_session(db, user, request, method)
    user.failed_logins = 0
    user.locked_until = None
    user.last_login_at = utcnow()
    record_login(db, user, request, True, method)
    audit.record(db, "login", "patron", user.id, actor=user, ip=ip, method=method)
    set_session_cookies(response, token)
    return token


# ------------------------------------------------------------------ login history & lockout


def record_login(db: Session, user: Patron | None, request: Request | None, success: bool, method: str,
                 reason: str | None = None, username: str | None = None) -> None:
    ip, ua = client_meta(request)
    db.add(LoginEvent(user_id=user.id if user else None, username=(username or (user.card_number if user else None) or "")[:64],
                      ip=ip, user_agent=ua, success=success, method=method[:40], reason=reason))


def is_locked(user: Patron) -> bool:
    return user.locked_until is not None and user.locked_until > utcnow()


def register_failure(db: Session, user: Patron, request: Request | None, method: str, reason: str) -> bool:
    """Count a failed attempt; lock the account when the threshold is reached. Returns True if locked now."""
    ip, _ = client_meta(request)
    record_login(db, user, request, False, method, reason)
    threshold = int(policy(db, "lockout_threshold") or 0)
    user.failed_logins = (user.failed_logins or 0) + 1
    if threshold and user.failed_logins >= threshold:
        minutes = int(policy(db, "lockout_minutes") or 15)
        user.locked_until = utcnow() + timedelta(minutes=minutes)
        user.failed_logins = 0
        audit.record(db, "login_locked", "patron", user.id, ip=ip, minutes=minutes)
        notify(db, user, "Your library account was temporarily locked",
               f"After {threshold} failed sign-in attempts your account is locked for {minutes} minutes. "
               "If this wasn't you, consider resetting your password.")
        return True
    return False


def unlock(user: Patron) -> None:
    user.locked_until = None
    user.failed_logins = 0


def login_history(db: Session, user: Patron, limit: int = 50) -> list[dict]:
    rows = db.scalars(select(LoginEvent).where(LoginEvent.user_id == user.id)
                      .order_by(LoginEvent.at.desc(), LoginEvent.id.desc()).limit(limit))
    return [{"id": e.id, "at": e.at, "ip": e.ip, "user_agent": e.user_agent, "success": e.success,
             "method": e.method, "reason": e.reason} for e in rows]


# ------------------------------------------------------------------ personal API tokens


@dataclass
class TokenAuth:
    user: Patron
    scopes: set[str]
    token: ApiToken


def grantable_scopes(user: Patron) -> list[str]:
    perms = effective_permissions(user)
    return sorted(PERMISSION_CODES) if ALL in perms else sorted(p for p in perms if p in PERMISSION_CODES)


def create_api_token(db: Session, user: Patron, name: str, scopes: list[str], expires_days: int | None) -> tuple[ApiToken, str]:
    allowed = set(grantable_scopes(user))
    bad = sorted(set(scopes) - allowed)
    if bad:
        raise ValueError(f"Scopes not available to this account: {', '.join(bad)}")
    plaintext = API_TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = ApiToken(user_id=user.id, name=name, prefix=plaintext[:12], token_hash=sha256_hex(plaintext),
                   scopes=sorted(set(scopes)),
                   expires_at=utcnow() + timedelta(days=expires_days) if expires_days else None)
    db.add(row)
    db.flush()
    return row, plaintext


def resolve_api_token(db: Session, plaintext: str, ip: str | None) -> TokenAuth | None:
    row = db.scalar(select(ApiToken).where(ApiToken.token_hash == sha256_hex(plaintext)))
    now = utcnow()
    if row is None or row.revoked_at is not None or (row.expires_at is not None and row.expires_at <= now):
        return None
    user = db.get(Patron, row.user_id)
    if user is None or not user.is_active or user.deleted_at is not None:
        return None
    if row.last_used_at is None or (now - row.last_used_at).total_seconds() > SESSION_TOUCH_SECONDS:
        row.last_used_at, row.last_used_ip = now, ip
        db.commit()
    return TokenAuth(user=user, scopes=set(row.scopes or []), token=row)


def api_token_out(t: ApiToken) -> dict:
    return {"id": t.id, "name": t.name, "prefix": t.prefix, "scopes": t.scopes or [], "created_at": t.created_at,
            "last_used_at": t.last_used_at, "last_used_ip": t.last_used_ip, "expires_at": t.expires_at,
            "revoked_at": t.revoked_at}


# ------------------------------------------------------------------ one-time tokens


def issue_token(db: Session, user: Patron, purpose: str, ttl: int, data: dict | None = None) -> str:
    jti = secrets.token_urlsafe(24)
    db.add(AuthToken(user_id=user.id, purpose=purpose, jti_hash=sha256_hex(jti),
                     expires_at=utcnow() + timedelta(seconds=ttl), data=data or {}))
    db.flush()
    return sign(f"auth-{purpose}", {"jti": jti, "uid": user.id})


def load_token(db: Session, token: str, purpose: str, ttl: int) -> AuthToken | None:
    """Return the unused, unexpired token row for a signed one-time token, else None."""
    from ..security import unsign

    data = unsign(f"auth-{purpose}", token or "", ttl)
    if not data or "jti" not in data:
        return None
    row = db.scalar(select(AuthToken).where(AuthToken.jti_hash == sha256_hex(str(data["jti"])),
                                            AuthToken.purpose == purpose))
    if row is None or row.used_at is not None or row.expires_at <= utcnow() or row.user_id != data.get("uid"):
        return None
    return row


# ------------------------------------------------------------------ TOTP two-factor authentication

_SEAL = "totp"


def mfa_row(db: Session, user: Patron) -> MfaTotp | None:
    return db.get(MfaTotp, user.id)


def mfa_enabled(db: Session, user: Patron) -> bool:
    row = mfa_row(db, user)
    return bool(row and row.confirmed_at)


def mfa_enrollment_required(db: Session, user: Patron) -> bool:
    return bool(user.is_staff and policy(db, "require_2fa_for_staff") and not mfa_enabled(db, user))


def begin_enrollment(db: Session, user: Patron, issuer: str) -> dict:
    row = mfa_row(db, user)
    if row and row.confirmed_at:
        raise ValueError("Two-factor authentication is already enabled")
    secret = totp.new_secret()
    if row is None:
        row = MfaTotp(user_id=user.id, secret_enc=seal(secret, _SEAL))
        db.add(row)
    else:
        row.secret_enc, row.created_at, row.last_used_step = seal(secret, _SEAL), utcnow(), None
    uri = totp.provisioning_uri(secret, user.email or user.card_number, issuer)
    return {"secret": secret, "otpauth_uri": uri, "qr_svg": totp.qr_svg_data_uri(uri)}


def _check_totp(row: MfaTotp, code: str, at: float | None = None) -> bool:
    secret = unseal(row.secret_enc, _SEAL)
    if not secret:
        return False
    step = totp.verify(secret, code, at=at, last_step=row.last_used_step)
    if step is None:
        return False
    row.last_used_step = step  # replay protection: this and earlier steps are now spent
    return True


def _new_recovery_codes(db: Session, user: Patron) -> list[str]:
    db.execute(delete(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user.id))
    codes = []
    for _ in range(RECOVERY_CODE_COUNT):
        c = secrets.token_hex(5)  # 40 bits each, shown as xxxxx-xxxxx
        codes.append(f"{c[:5]}-{c[5:]}")
        db.add(MfaRecoveryCode(user_id=user.id, code_hash=keyed_hash(c, "recovery")))
    return codes


def activate(db: Session, user: Patron, code: str, at: float | None = None) -> list[str]:
    row = mfa_row(db, user)
    if row is None or row.confirmed_at is not None:
        raise ValueError("Start two-factor setup first")
    if not _check_totp(row, code, at):
        raise PermissionError("That code is not valid. Check your authenticator's clock and try again.")
    row.confirmed_at = utcnow()
    return _new_recovery_codes(db, user)


def regenerate_recovery_codes(db: Session, user: Patron) -> list[str]:
    return _new_recovery_codes(db, user)


def verify_second_factor(db: Session, user: Patron, code: str, at: float | None = None) -> str | None:
    """Check a TOTP or recovery code. Returns "totp" / "recovery" on success (consuming it), else None."""
    row = mfa_row(db, user)
    if row is None or row.confirmed_at is None:
        return None
    cleaned = (code or "").strip().replace(" ", "")
    if cleaned.isdigit() and len(cleaned) == totp.DIGITS:
        return "totp" if _check_totp(row, cleaned, at) else None
    normalized = cleaned.replace("-", "").lower()
    if len(normalized) != 10:
        return None
    rc = db.scalar(select(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user.id,
                                                 MfaRecoveryCode.code_hash == keyed_hash(normalized, "recovery"),
                                                 MfaRecoveryCode.used_at.is_(None)))
    if rc is None:
        return None
    rc.used_at = utcnow()
    return "recovery"


def disable_mfa(db: Session, user: Patron) -> None:
    db.execute(delete(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user.id))
    db.execute(delete(MfaTotp).where(MfaTotp.user_id == user.id))


def mfa_status(db: Session, user: Patron) -> dict:
    row = mfa_row(db, user)
    remaining = 0
    if row and row.confirmed_at:
        remaining = len(db.scalars(select(MfaRecoveryCode.id).where(MfaRecoveryCode.user_id == user.id,
                                                                    MfaRecoveryCode.used_at.is_(None))).all())
    return {"enabled": bool(row and row.confirmed_at), "pending": bool(row and not row.confirmed_at),
            "enabled_at": row.confirmed_at if row else None, "recovery_codes_remaining": remaining,
            "required": bool(user.is_staff and policy(db, "require_2fa_for_staff"))}


def reauthenticate(db: Session, user: Patron, password: str | None, code: str | None = None, *,
                   need_code: bool = False) -> bool:
    """Step-up check for sensitive changes: the password (if the account has one) and, when asked,
    a current second factor."""
    if user.password_hash and not verify_password(user.password_hash, password or ""):
        return False
    return not (need_code and verify_second_factor(db, user, code or "") is None)


def erase_credentials(db: Session, user: Patron) -> None:
    """Remove every way of signing in to an account (used by GDPR erasure)."""
    from ..models import UserIdentity

    revoke_all_sessions(db, user)
    db.execute(update(ApiToken).where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None)).values(revoked_at=utcnow()))
    db.execute(update(AuthToken).where(AuthToken.user_id == user.id, AuthToken.used_at.is_(None)).values(used_at=utcnow()))
    db.execute(delete(UserIdentity).where(UserIdentity.user_id == user.id))
    disable_mfa(db, user)


# ------------------------------------------------------------------ password reset


def find_account(db: Session, identifier: str) -> Patron | None:
    from sqlalchemy import or_

    ident = identifier.strip()
    return db.scalar(select(Patron).where(or_(Patron.card_number == ident, Patron.email == ident.lower()),
                                          Patron.deleted_at.is_(None), Patron.is_active.is_(True)))


def public_base(request: Request | None) -> str:
    configured = getattr(get_settings(), "public_url", "") or ""
    if configured:
        return configured.rstrip("/")
    return str(request.base_url).rstrip("/") if request is not None else ""


def request_password_reset(db: Session, user: Patron, request: Request | None) -> str:
    # Only the newest link is valid.
    db.execute(update(AuthToken).where(AuthToken.user_id == user.id, AuthToken.purpose == "reset",
                                       AuthToken.used_at.is_(None)).values(used_at=utcnow()))
    token = issue_token(db, user, "reset", RESET_TOKEN_TTL, {"pf": sha256_hex(user.password_hash or "")[:16]})
    link = f"{public_base(request)}/reset-password#token={token}"
    notify(db, user, "Reset your library password",
           f"Someone (hopefully you) asked to reset the password for card {user.card_number}.\n\n"
           f"Open this link within 30 minutes to choose a new password:\n{link}\n\n"
           "If you didn't ask for this, you can ignore this message — your password has not changed.")
    if get_settings().environment == "development":
        log.warning("DEVELOPMENT ONLY — password reset link for %s: %s", user.card_number, link)
    return token


def consume_reset_token(db: Session, token: str) -> tuple[AuthToken, Patron] | None:
    row = load_token(db, token, "reset", RESET_TOKEN_TTL)
    if row is None:
        return None
    user = db.get(Patron, row.user_id)
    if user is None or user.deleted_at is not None or not user.is_active:
        return None
    # A password change since the link was issued invalidates it.
    if (row.data or {}).get("pf") != sha256_hex(user.password_hash or "")[:16]:
        return None
    return row, user
