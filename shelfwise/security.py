"""Authentication, authorisation, CSRF and rate limiting.

* Passwords: Argon2id (memory-hard) with transparent re-hashing when parameters change.
* Sessions: signed, time-limited tokens (itsdangerous). The same token works as an HttpOnly
  cookie for the web UI and as a ``Bearer`` token for API clients. Tokens embed a password
  fingerprint so changing a password revokes every existing session.
* CSRF: double-submit token, required for every state-changing request authenticated by cookie.
* RBAC: roles map to explicit permission strings checked on every endpoint.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import get_settings
from .models import Patron, Role

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
    return URLSafeTimedSerializer(get_settings().secret_key, salt="shelfwise.session.v1")


def _password_fingerprint(user: Patron) -> str:
    return hashlib.sha256((user.password_hash or "").encode()).hexdigest()[:16]


def create_session_token(user: Patron) -> str:
    return _serializer().dumps({"uid": user.id, "pf": _password_fingerprint(user)})


def read_session_token(token: str) -> dict | None:
    try:
        data = _serializer().loads(token, max_age=get_settings().session_max_age)
    except (BadSignature, SignatureExpired):
        return None
    return data if isinstance(data, dict) and "uid" in data else None


def token_matches_user(data: dict, user: Patron) -> bool:
    return hmac.compare_digest(str(data.get("pf", "")), _password_fingerprint(user))


def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def csrf_valid(cookie_value: str | None, header_value: str | None) -> bool:
    return bool(cookie_value and header_value and hmac.compare_digest(cookie_value, header_value))


# ------------------------------------------------------------------ permissions

ALL = "*"

ROLE_PERMISSIONS: dict[Role, set[str]] = {
    Role.patron: {"opac"},
    Role.librarian: {
        "opac",
        "catalog:read",
        "catalog:write",
        "circulation",
        "patrons:read",
        "patrons:write",
        "holds:manage",
        "acquisitions:read",
        "acquisitions:write",
        "reports:read",
        "ai:staff",
        # cataloguing tools
        "authorities:write",
        "items:batch",
        "inventory",
        "labels",
    },
    Role.admin: {ALL},
}


def has_permission(user: Patron | None, permission: str) -> bool:
    if user is None or not user.is_active or user.deleted_at is not None:
        return False
    perms = ROLE_PERMISSIONS.get(user.role, set())
    return ALL in perms or permission in perms


# ------------------------------------------------------------------ rate limiting


class SlidingWindowLimiter:
    """Small in-process sliding-window limiter (swap for Redis in multi-process deployments)."""

    def __init__(self, limit: int, window_seconds: float = 60.0) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
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


login_limiter = SlidingWindowLimiter(get_settings().login_attempts_per_minute)
ai_limiter = SlidingWindowLimiter(30)
