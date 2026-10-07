"""Helpers that run *inside* an instance's environment.

The instance tool starts ``python -m librowise instance _probe`` / ``_bootstrap-admin`` as the
service user with the instance's env file loaded, so these functions see that instance's
database through the ordinary application settings. Output is one JSON object on stdout.
"""

from __future__ import annotations

import secrets
import string


def generate_password(length: int = 20) -> str:
    """A random password that satisfies :func:`librowise.security.password_problems`."""
    from ..security import password_problems

    alphabet = string.ascii_letters + string.digits + "#%+-=@_"
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if (any(c.islower() for c in pw) and any(c.isupper() for c in pw) and any(c.isdigit() for c in pw)
                and not password_problems(pw)):
            return pw


def probe() -> dict:
    """Database connectivity, schema revision, administrators and worker heartbeat."""
    out: dict = {"database": False}
    try:
        from sqlalchemy import func, select, text

        from ..db import get_engine, session_scope

        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        out["database"] = True
        from ..migrations import current_revision, head_revision

        out["revision"], out["head"] = current_revision(), head_revision()
        try:
            from .. import jobs
            from ..models import Patron, Role

            with session_scope() as db:
                out["admins"] = db.scalar(select(func.count(Patron.id)).where(Patron.role == Role.admin,
                                                                              Patron.deleted_at.is_(None)))
                out["worker_heartbeat_age"] = jobs.latest_heartbeat_age(db)
        except Exception as exc:  # schema not migrated yet
            out["detail"] = f"{type(exc).__name__}: {str(exc)[:200]}"
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {str(exc)[:300]}"
    return out


def bootstrap_admin(username: str, email: str) -> dict:
    """Create the first administrator unless one exists.

    With SMTP configured, the account gets an unknown random password and a password-reset link
    is e-mailed; otherwise a one-time password is returned for the operator to hand over.
    """
    from sqlalchemy import select

    from ..config import get_settings
    from ..db import session_scope
    from ..models import Branch, Patron, PatronCategory, Role
    from ..security import hash_password

    settings = get_settings()
    with session_scope() as db:
        if db.scalar(select(Patron.id).where(Patron.role == Role.admin, Patron.deleted_at.is_(None)).limit(1)):
            return {"created": False, "reason": "an administrator already exists"}
        if db.scalar(select(Patron.id).where(Patron.card_number == username).limit(1)):
            return {"created": False, "reason": f"an account named {username!r} already exists"}
        branch = db.scalar(select(Branch).limit(1)) or Branch(code="MAIN", name="Main Library")
        cat = db.scalar(select(PatronCategory).where(PatronCategory.code == "STAFF")) or \
            PatronCategory(code="STAFF", name="Staff")
        db.add_all([branch, cat])
        db.flush()
        password = generate_password()
        user = Patron(card_number=username, email=email.lower(), first_name="Library", last_name="Administrator",
                      role=Role.admin, category_id=cat.id, home_branch_id=branch.id,
                      password_hash=hash_password(password))
        db.add(user)
        db.flush()
        emailed = False
        if settings.email_backend == "smtp" and email:
            try:
                from ..services import identity
                from ..services.notices import deliver_pending

                identity.request_password_reset(db, user, None)
                db.flush()
                result = deliver_pending(db, 20)
                emailed = bool(result.get("sent")) if isinstance(result, dict) else bool(result)
            except Exception:  # fall back to showing the password
                emailed = False
    out = {"created": True, "username": username, "email": email, "emailed": emailed}
    if not emailed:
        out["password"] = password
    return out
