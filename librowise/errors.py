"""Domain errors. Services raise these; the API layer maps them to HTTP responses."""

from __future__ import annotations


class DomainError(Exception):
    status_code = 400
    code = "domain_error"

    def __init__(self, message: str, *, code: str | None = None, details: dict | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details or {}


class NotFound(DomainError):
    status_code = 404
    code = "not_found"


class Conflict(DomainError):
    status_code = 409
    code = "conflict"


class PolicyBlocked(DomainError):
    """A circulation policy prevents the action (limits, fines, expiry...). Staff may override."""

    status_code = 422
    code = "policy_blocked"


class Forbidden(DomainError):
    status_code = 403
    code = "forbidden"
