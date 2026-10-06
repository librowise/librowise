"""Audit trail for every privileged mutation."""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import AuditLog, Patron


def record(
    db: Session,
    action: str,
    entity: str,
    entity_id: int | None = None,
    *,
    actor: Patron | None = None,
    ip: str | None = None,
    **details,
) -> None:
    db.add(
        AuditLog(
            action=action,
            entity=entity,
            entity_id=entity_id,
            actor_id=actor.id if actor else None,
            ip=ip,
            details={k: v for k, v in details.items() if v is not None},
        )
    )
