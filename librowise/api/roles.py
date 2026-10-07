"""Administration of custom staff roles, staff role assignment and per-user access controls
(effective permissions, 2FA reset, session revocation, unlock, sign-in history)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import Field, field_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import client_ip, require
from ..errors import NotFound
from ..models import ApiToken, Patron, Role, StaffRole, UserIdentity, utcnow
from ..permissions import ALL, BUILTIN_ROLE_PERMISSIONS, PERMISSION_CODES, grouped
from ..schemas import StrictModel
from ..security import can_manage_account, effective_permissions, has_permission, holds_all
from ..services import audit, identity

router = APIRouter(prefix="/admin", tags=["roles & access"])
MANAGE = require("patrons:manage_staff")


def _role_out(r: StaffRole, members: int | None = None) -> dict:
    return {"id": r.id, "name": r.name, "description": r.description, "permissions": sorted(r.permissions or []),
            "members": members, "updated_at": r.updated_at}


class StaffRoleIn(StrictModel):
    name: str = Field(min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=255)
    permissions: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("permissions")
    @classmethod
    def known(cls, v: list[str]) -> list[str]:
        unknown = sorted(set(v) - PERMISSION_CODES)
        if unknown:
            raise ValueError(f"unknown permission(s): {', '.join(unknown)}")
        return sorted(set(v))


def _guard_grant(actor: Patron, perms: list[str]) -> None:
    if not holds_all(actor, perms):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only grant permissions you hold yourself")


@router.get("/permissions")
def permission_catalogue(_: Patron = Depends(MANAGE)):
    return {"groups": grouped(),
            "builtin_roles": {role.value: sorted(perms) for role, perms in BUILTIN_ROLE_PERMISSIONS.items()}}


@router.get("/roles")
def list_roles(db: Session = Depends(get_db), _: Patron = Depends(MANAGE)):
    counts = dict(db.execute(select(Patron.staff_role_id, func.count()).where(
        Patron.staff_role_id.is_not(None), Patron.deleted_at.is_(None)).group_by(Patron.staff_role_id)).all())
    return {"results": [_role_out(r, counts.get(r.id, 0)) for r in db.scalars(select(StaffRole).order_by(StaffRole.name))]}


@router.post("/roles", status_code=201)
def create_role(body: StaffRoleIn, request: Request, db: Session = Depends(get_db), actor: Patron = Depends(MANAGE)):
    _guard_grant(actor, body.permissions)
    role = StaffRole(name=body.name, description=body.description, permissions=body.permissions)
    db.add(role)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "A role with that name already exists") from None
    audit.record(db, "create", "staff_role", role.id, actor=actor, ip=client_ip(request), name=role.name,
                 permissions=role.permissions)
    db.commit()
    return _role_out(role, 0)


def _get_role(db: Session, role_id: int) -> StaffRole:
    role = db.get(StaffRole, role_id)
    if role is None:
        raise NotFound("Role not found")
    return role


@router.put("/roles/{role_id}")
def update_role(role_id: int, body: StaffRoleIn, request: Request, db: Session = Depends(get_db),
                actor: Patron = Depends(MANAGE)):
    role = _get_role(db, role_id)
    # Changing a role changes the access of everyone holding it: the actor must hold both old and new sets.
    _guard_grant(actor, sorted(set(body.permissions) | set(role.permissions or [])))
    before = sorted(role.permissions or [])
    role.name, role.description, role.permissions = body.name, body.description, body.permissions
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "A role with that name already exists") from None
    audit.record(db, "update", "staff_role", role.id, actor=actor, ip=client_ip(request), name=role.name,
                 added=sorted(set(body.permissions) - set(before)), removed=sorted(set(before) - set(body.permissions)))
    db.commit()
    return _role_out(role)


@router.delete("/roles/{role_id}")
def delete_role(role_id: int, request: Request, db: Session = Depends(get_db), actor: Patron = Depends(MANAGE)):
    role = _get_role(db, role_id)
    _guard_grant(actor, role.permissions or [])
    n = db.execute(update(Patron).where(Patron.staff_role_id == role.id).values(staff_role_id=None)).rowcount
    db.delete(role)
    audit.record(db, "delete", "staff_role", role_id, actor=actor, ip=client_ip(request), name=role.name, unassigned=n)
    db.commit()
    return {"ok": True, "unassigned": n}


# ------------------------------------------------------------------ staff accounts


def _access_out(db: Session, p: Patron) -> dict:
    perms = effective_permissions(p)
    builtin = BUILTIN_ROLE_PERMISSIONS.get(p.role, set())
    custom = set(p.staff_role.permissions or []) if p.staff_role_id is not None and p.staff_role else set()
    if ALL in perms:
        listed = [{"code": ALL, "sources": [f"role:{p.role.value}"]}]
    else:
        listed = [{"code": c, "sources": ([f"role:{p.role.value}"] if c in builtin else [])
                   + ([f"custom:{p.staff_role.name}"] if c in custom else [])} for c in sorted(perms)]
    return {
        "id": p.id, "card_number": p.card_number, "full_name": p.full_name, "email": p.email, "role": p.role.value,
        "is_staff": p.is_staff, "is_active": p.is_active,
        "staff_role": {"id": p.staff_role.id, "name": p.staff_role.name} if p.staff_role_id and p.staff_role else None,
        "effective_permissions": listed,
        "mfa": identity.mfa_status(db, p),
        "active_sessions": len(identity.active_sessions(db, p)),
        "api_tokens": db.scalar(select(func.count()).select_from(ApiToken).where(
            ApiToken.user_id == p.id, ApiToken.revoked_at.is_(None))) or 0,
        "identities": [{"id": i.id, "provider": i.provider, "email": i.email, "created_at": i.created_at,
                        "last_login_at": i.last_login_at}
                       for i in db.scalars(select(UserIdentity).where(UserIdentity.user_id == p.id))],
        "locked_until": p.locked_until if identity.is_locked(p) else None,
        "failed_logins": p.failed_logins or 0,
        "last_login_at": p.last_login_at,
    }


@router.get("/staff")
def list_staff(db: Session = Depends(get_db), _: Patron = Depends(MANAGE)):
    rows = db.scalars(select(Patron).where(
        Patron.deleted_at.is_(None),
        or_(Patron.role.in_([Role.librarian, Role.admin]), Patron.staff_role_id.is_not(None)),
    ).order_by(Patron.last_name, Patron.first_name)).all()
    return {"results": [{"id": p.id, "card_number": p.card_number, "full_name": p.full_name, "role": p.role.value,
                         "staff_role": {"id": p.staff_role.id, "name": p.staff_role.name} if p.staff_role_id and p.staff_role else None,
                         "is_active": p.is_active, "mfa_enabled": identity.mfa_enabled(db, p),
                         "last_login_at": p.last_login_at, "locked": identity.is_locked(p)} for p in rows]}


def _target(db: Session, patron_id: int) -> Patron:
    p = db.get(Patron, patron_id)
    if p is None or p.deleted_at is not None:
        raise NotFound("Patron not found")
    return p


def _guard_target(actor: Patron, target: Patron) -> None:
    if not can_manage_account(actor, target):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not allowed to manage this account")


@router.get("/users/{patron_id}/access")
def user_access(patron_id: int, db: Session = Depends(get_db), actor: Patron = Depends(require("patrons:read"))):
    p = _target(db, patron_id)
    if p.is_staff and not has_permission(actor, "patrons:manage_staff"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing permission: patrons:manage_staff")
    return _access_out(db, p)


class AssignRoleIn(StrictModel):
    staff_role_id: int | None = None


@router.put("/users/{patron_id}/staff-role")
def assign_role(patron_id: int, body: AssignRoleIn, request: Request, db: Session = Depends(get_db),
                actor: Patron = Depends(MANAGE)):
    p = _target(db, patron_id)
    if p.is_staff:
        _guard_target(actor, p)
    role = _get_role(db, body.staff_role_id) if body.staff_role_id is not None else None
    if role is not None:
        _guard_grant(actor, role.permissions or [])
    before = p.staff_role.name if p.staff_role_id and p.staff_role else None
    p.staff_role_id = role.id if role else None
    p.staff_role = role
    if role is None and before is not None:
        identity.revoke_all_sessions(db, p)  # access reduced: force a fresh sign-in
    audit.record(db, "staff_role_assigned", "patron", p.id, actor=actor, ip=client_ip(request),
                 before=before, after=role.name if role else None)
    db.commit()
    return _access_out(db, p)


@router.post("/users/{patron_id}/mfa/reset")
def reset_mfa(patron_id: int, request: Request, db: Session = Depends(get_db),
              actor: Patron = Depends(require("patrons:write"))):
    """Remove a user's authenticator and recovery codes (e.g. a lost phone) and end their sessions."""
    p = _target(db, patron_id)
    _guard_target(actor, p)
    identity.disable_mfa(db, p)
    n = identity.revoke_all_sessions(db, p)
    identity.notify(db, p, "Two-factor authentication was reset",
                    "A library administrator reset two-factor authentication on your account. "
                    "Set it up again from your account's security settings.")
    audit.record(db, "mfa_reset", "patron", p.id, actor=actor, ip=client_ip(request), sessions_revoked=n)
    db.commit()
    return _access_out(db, p)


@router.post("/users/{patron_id}/sessions/revoke")
def revoke_user_sessions(patron_id: int, request: Request, db: Session = Depends(get_db),
                         actor: Patron = Depends(require("patrons:write"))):
    p = _target(db, patron_id)
    _guard_target(actor, p)
    n = identity.revoke_all_sessions(db, p)
    audit.record(db, "sessions_revoked_all", "patron", p.id, actor=actor, ip=client_ip(request), count=n)
    db.commit()
    return {"revoked": n}


@router.post("/users/{patron_id}/api-tokens/revoke")
def revoke_user_tokens(patron_id: int, request: Request, db: Session = Depends(get_db),
                       actor: Patron = Depends(require("patrons:write"))):
    p = _target(db, patron_id)
    _guard_target(actor, p)
    n = db.execute(update(ApiToken).where(ApiToken.user_id == p.id, ApiToken.revoked_at.is_(None))
                   .values(revoked_at=utcnow())).rowcount
    audit.record(db, "api_tokens_revoked_all", "patron", p.id, actor=actor, ip=client_ip(request), count=n)
    db.commit()
    return {"revoked": n}


@router.post("/users/{patron_id}/unlock")
def unlock_user(patron_id: int, request: Request, db: Session = Depends(get_db),
                actor: Patron = Depends(require("patrons:write"))):
    p = _target(db, patron_id)
    _guard_target(actor, p)
    identity.unlock(p)
    audit.record(db, "unlock", "patron", p.id, actor=actor, ip=client_ip(request))
    db.commit()
    return _access_out(db, p)


@router.get("/users/{patron_id}/logins")
def user_logins(patron_id: int, db: Session = Depends(get_db), actor: Patron = Depends(require("patrons:read"))):
    p = _target(db, patron_id)
    if p.is_staff and not has_permission(actor, "patrons:manage_staff"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing permission: patrons:manage_staff")
    return {"results": identity.login_history(db, p, 100)}
