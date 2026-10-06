"""FastAPI dependencies: current user, permission checks, client IP."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from .db import get_db
from .models import Patron
from .security import SESSION_COOKIE, has_permission, read_session_token, token_matches_user


def _token_from_request(request: Request) -> tuple[str | None, str]:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip(), "bearer"
    return request.cookies.get(SESSION_COOKIE), "cookie"


def optional_user(request: Request, db: Session = Depends(get_db)) -> Patron | None:
    cached = getattr(request.state, "user", None)
    if cached is not None:
        return cached
    token, _ = _token_from_request(request)
    if not token:
        return None
    data = read_session_token(token)
    if not data:
        return None
    user = db.get(Patron, data["uid"])
    if user is None or not user.is_active or user.deleted_at is not None or not token_matches_user(data, user):
        return None
    request.state.user = user
    return user


def current_user(user: Patron | None = Depends(optional_user)) -> Patron:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentication required",
                            headers={"WWW-Authenticate": "Bearer"})
    return user


def require(permission: str) -> Callable[..., Patron]:
    def checker(user: Patron = Depends(current_user)) -> Patron:
        if not has_permission(user, permission):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Missing permission: {permission}")
        return user

    checker.__name__ = f"require_{permission.replace(':', '_')}"
    return checker


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"
