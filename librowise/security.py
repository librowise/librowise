"""Authentication, authorisation, CSRF and rate limiting.

* Passwords: Argon2id (memory-hard) with transparent re-hashing when parameters change.
* Sessions: signed, time-limited tokens (itsdangerous). The same token works as an HttpOnly
  cookie for the web UI and as a ``Bearer`` token for API clients. Tokens embed a password
  fingerprint so changing a password revokes every existing session, and a ``sid`` that links them to a
  server-side ``UserSession`` row (individual revocation, idle timeout; see ``services/identity.py``).
* CSRF: double-submit token, required for every state-changing request authenticated by cookie.
* RBAC: roles map to explicit permission strings checked on every endpoint.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
import threading
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import get_settings
from .models import Patron, Role
from .permissions import ALL, BUILTIN_ROLE_PERMISSIONS

SESSION_COOKIE = "sw_session"
CSRF_COOKIE = "sw_csrf"
CSRF_HEADER = "x-csrf-token"

_hasher = PasswordHasher()


# ------------------------------------------------------------------ passwords


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    if not password_hash:
        # Run a dummy verification so timing does not reveal whether the account exists.
        try:
            _hasher.verify(_DUMMY_HASH, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            pass
        return False
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


_DUMMY_HASH = _hasher.hash(secrets.token_hex(8))


def password_problems(password: str) -> list[str]:
    """Return a list of human-readable reasons a password is too weak (empty = OK)."""
    problems = []
    if len(password) < 10:
        problems.append("must be at least 10 characters")
    classes = sum(
        [
            any(c.islower() for c in password),
            any(c.isupper() for c in password),
            any(c.isdigit() for c in password),
            any(not c.isalnum() for c in password),
        ]
    )
    if classes < 3:
        problems.append("must mix at least three of: lowercase, uppercase, digits, symbols")
    if password.lower() in {"password123", "librarian1", "qwertyuiop", "1234567890"}:
        problems.append("is too common")
    return problems


# ------------------------------------------------------------------ session tokens


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="librowise.session.v1")


def _password_fingerprint(user: Patron) -> str:
    return hashlib.sha256((user.password_hash or "").encode()).hexdigest()[:16]


def create_session_token(user: Patron, sid: str | None = None) -> str:
    """Sign a session token. ``sid`` links it to a server-side ``UserSession`` row (see
    :mod:`librowise.services.identity`), which makes it individually revocable."""
    payload = {"uid": user.id, "pf": _password_fingerprint(user)}
    if sid:
        payload["sid"] = sid
    return _serializer().dumps(payload)


def read_session_token(token: str) -> dict | None:
    try:
        data, issued = _serializer().loads(token, max_age=get_settings().session_max_age, return_timestamp=True)
    except (BadSignature, SignatureExpired):
        return None
    if not isinstance(data, dict) or "uid" not in data:
        return None
    data["iat"] = int(issued.timestamp())
    return data


def token_matches_user(data: dict, user: Patron) -> bool:
    return hmac.compare_digest(str(data.get("pf", "")), _password_fingerprint(user))


def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def csrf_valid(cookie_value: str | None, header_value: str | None) -> bool:
    return bool(cookie_value and header_value and hmac.compare_digest(cookie_value, header_value))


# ------------------------------------------------------------------ permissions

# Built-in role sets and the permission catalogue live in :mod:`librowise.permissions`.
ROLE_PERMISSIONS: dict[Role, set[str]] = BUILTIN_ROLE_PERMISSIONS

# Per-request attributes set on the (request-scoped) user object by ``deps.optional_user``:
SCOPES_ATTR = "_sw_token_scopes"  # set[str] when authenticated with a personal API token
RESTRICTED_ATTR = "_sw_mfa_enrollment_required"  # staff must enrol in 2FA before using staff permissions


def effective_permissions(user: Patron | None) -> set[str]:
    """Built-in role permissions ∪ custom staff-role permissions (ignores API-token scopes)."""
    if user is None:
        return set()
    perms = set(ROLE_PERMISSIONS.get(user.role, set()))
    if user.staff_role_id is not None and user.staff_role is not None:
        perms.update(p for p in (user.staff_role.permissions or []) if isinstance(p, str) and p != ALL)
    return perms


def has_permission(user: Patron | None, permission: str) -> bool:
    if user is None or not user.is_active or user.deleted_at is not None:
        return False
    if getattr(user, RESTRICTED_ATTR, False) and permission != "opac":
        return False
    scopes = getattr(user, SCOPES_ATTR, None)
    if scopes is not None and permission not in scopes:
        return False
    perms = effective_permissions(user)
    return ALL in perms or permission in perms


def holds_all(actor: Patron, permissions: set[str] | list[str]) -> bool:
    """True if ``actor`` already holds every permission in ``permissions`` (no privilege escalation)."""
    perms = effective_permissions(actor)
    if ALL in perms:
        return True
    return ALL not in permissions and set(permissions) <= perms


def can_manage_account(actor: Patron, target: Patron) -> bool:
    """Staff-account management rule: needs ``patrons:manage_staff`` for staff targets, and the actor
    must hold every permission the target holds (a delegated manager cannot touch an administrator)."""
    if not target.is_staff:
        return has_permission(actor, "patrons:write")
    return has_permission(actor, "patrons:manage_staff") and holds_all(actor, effective_permissions(target))


# ------------------------------------------------------------------ generic signed tokens & secrets


def sign(purpose: str, payload: dict) -> str:
    return URLSafeTimedSerializer(get_settings().secret_key, salt=f"librowise.{purpose}.v1").dumps(payload)


def unsign(purpose: str, token: str, max_age: int) -> dict | None:
    try:
        data = URLSafeTimedSerializer(get_settings().secret_key, salt=f"librowise.{purpose}.v1").loads(
            token, max_age=max_age)
    except (BadSignature, SignatureExpired):
        return None
    return data if isinstance(data, dict) else None


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def keyed_hash(value: str, purpose: str) -> str:
    """HMAC-SHA256 with a key derived from the deployment secret (for high-entropy one-time codes)."""
    key = hashlib.sha256(f"{purpose}:{get_settings().secret_key}".encode()).digest()
    return hmac.new(key, value.encode(), hashlib.sha256).hexdigest()


def _aead_key(purpose: str) -> bytes:
    return hashlib.sha256(f"librowise.seal.{purpose}:{get_settings().secret_key}".encode()).digest()


def seal(plaintext: str, purpose: str) -> str:
    """Encrypt a small secret (e.g. a TOTP seed) at rest with AES-256-GCM."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = secrets.token_bytes(12)
    ct = AESGCM(_aead_key(purpose)).encrypt(nonce, plaintext.encode(), purpose.encode())
    return "v1:" + base64.urlsafe_b64encode(nonce + ct).decode()


def unseal(sealed: str, purpose: str) -> str | None:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not sealed.startswith("v1:"):
        return None
    try:
        raw = base64.urlsafe_b64decode(sealed[3:])
        return AESGCM(_aead_key(purpose)).decrypt(raw[:12], raw[12:], purpose.encode()).decode()
    except (InvalidTag, ValueError):
        return None


# ------------------------------------------------------------------ rate limiting


class SlidingWindowLimiter:
    """Sliding-window rate limiter with a pluggable store (see :mod:`librowise.ratelimit`).

    ``LIBROWISE_RATE_LIMIT_BACKEND=memory`` (default) keeps exact windows in this process;
    ``database`` shares counters between all processes/hosts. ``name`` namespaces the shared
    counters and must be stable across processes."""

    def __init__(self, limit: int, window_seconds: float = 60.0, name: str | None = None) -> None:
        self.limit = limit
        self.window = window_seconds
        self.name = name or f"rl{limit}x{int(window_seconds)}"
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        from . import ratelimit

        if ratelimit.backend() == "database":
            try:
                return ratelimit.db_allow(f"{self.name}:{key}", self.limit, self.window)
            except Exception:  # degrade to the per-process limiter rather than failing open
                logging.getLogger("librowise.ratelimit").exception("database rate limiter unavailable")
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
        from . import ratelimit

        if ratelimit.backend() == "database":
            try:
                ratelimit.db_reset(f"{self.name}:")
            except Exception:  # pragma: no cover - table may not exist yet
                pass


login_limiter = SlidingWindowLimiter(get_settings().login_attempts_per_minute, name="login")
ai_limiter = SlidingWindowLimiter(30, name="ai")
mfa_limiter = SlidingWindowLimiter(20, name="mfa")  # second-factor attempts per IP per minute
reset_limiter = SlidingWindowLimiter(5, 15 * 60, name="password_reset")  # reset requests per IP / identifier


def reset_limiters() -> None:
    """Clear every in-process limiter (used by tests)."""
    for limiter in (login_limiter, ai_limiter, mfa_limiter, reset_limiter):
        limiter.reset()
