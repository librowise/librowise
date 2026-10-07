"""FastAPI dependencies: current user, permission checks, client IP.

Authentication sources
* Session tokens (HttpOnly cookie for the web UI, or ``Authorization: Bearer``) — signed and backed by
  a server-side ``UserSession`` row, so revoked/expired sessions are rejected.
* Personal API tokens (``Authorization: Bearer swt_…``) — hashed, named, revocable and scoped; the
  effective permissions are the account's permissions ∩ the token's scopes.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from .db import get_db
from .models import Patron
from .security import (
    RESTRICTED_ATTR,
    SCOPES_ATTR,
    SESSION_COOKIE,
    has_permission,
    read_session_token,
    token_matches_user,
)
from .services import identity


def _token_from_request(request: Request) -> tuple[str | None, str]:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip(), "bearer"
    return request.cookies.get(SESSION_COOKIE), "cookie"


def optional_user(request: Request, db: Session = Depends(get_db)) -> Patron | None:
    cached = getattr(request.state, "user", None)
    if cached is not None:
        return cached
    token, kind = _token_from_request(request)
    if not token:
        return None
    if token.startswith(identity.API_TOKEN_PREFIX):
        if kind != "bearer":  # API tokens are never accepted from cookies
            return None
        auth = identity.resolve_api_token(db, token, client_ip(request))
        if auth is None:
            return None
        user = auth.user
        setattr(user, SCOPES_ATTR, auth.scopes)
        request.state.auth_kind, request.state.api_token_id = "api_token", auth.token.id
    else:
        data = read_session_token(token)
        if not data:
            return None
        user = db.get(Patron, data["uid"])
        if user is None or not user.is_active or user.deleted_at is not None or not token_matches_user(data, user):
            return None
        session = identity.check_session(db, user, data)
        if session is None:
            return None
        request.state.auth_kind = "session"
        request.state.session_sid = None if session is identity.LEGACY_SESSION else session.sid
        if identity.mfa_enrollment_required(db, user):
            setattr(user, RESTRICTED_ATTR, True)
    request.state.user = user
    return user


def authenticated_user(user: Patron | None = Depends(optional_user)) -> Patron:
    """Any valid credential (session or API token, whatever its scopes)."""
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentication required",
                            headers={"WWW-Authenticate": "Bearer"})
    return user


def current_user(user: Patron = Depends(authenticated_user)) -> Patron:
    """Self-service (OPAC) access: sessions, or API tokens carrying the ``opac`` scope."""
    scopes = getattr(user, SCOPES_ATTR, None)
    if scopes is not None and "opac" not in scopes:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "API token lacks the 'opac' scope")
    return user


def interactive_user(request: Request, user: Patron = Depends(authenticated_user)) -> Patron:
    """Account-security operations (password, 2FA, sessions, API tokens, linked identities) require an
    interactive sign-in; personal API tokens can never manage credentials."""
    if getattr(request.state, "auth_kind", None) != "session":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This action requires an interactive sign-in, not an API token")
    return user


def require(permission: str) -> Callable[..., Patron]:
    def checker(user: Patron = Depends(authenticated_user)) -> Patron:
        if not has_permission(user, permission):
            if getattr(user, RESTRICTED_ATTR, False):
                raise HTTPException(status.HTTP_403_FORBIDDEN,
                                    "Two-factor authentication must be set up before using staff features")
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Missing permission: {permission}")
        return user

    checker.__name__ = f"require_{permission.replace(':', '_')}"
    return checker


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"
