"""Holds depth: item-level holds, suspension, "not needed after" dates and hold notes.

Semantics (mirroring Koha):

* **Item-level hold** — ``Hold.requested_item_id`` names the one copy the patron wants. Only that copy
  can fill it. (``Hold.item_id`` keeps its meaning: the copy *assigned* to the hold once routed.)
* **Suspension** — a suspended hold keeps its queue position but is skipped by routing, the pull list and
  renewal checks. With ``suspended_until`` it resumes automatically on that date (routing already treats it
  as active from that day; the nightly job clears the flag).
* **Not needed after** — a queued hold whose date has passed is skipped by routing and expired nightly.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from ..errors import Conflict, NotFound, PolicyBlocked
from ..models import Biblio, Branch, Hold, HoldStatus, Item, ItemStatus, Patron, utcnow
from . import audit


def routable(item_id: int | None, today: date) -> list:
    """SQL conditions for queued holds that may be filled *now* (optionally by a specific copy)."""
    conds = [
        Hold.status == HoldStatus.queued,
        or_(Hold.suspended.is_(False), and_(Hold.suspended_until.is_not(None), Hold.suspended_until <= today)),
        or_(Hold.not_needed_after.is_(None), Hold.not_needed_after >= today),
    ]
    if item_id is not None:
        conds.append(or_(Hold.requested_item_id.is_(None), Hold.requested_item_id == item_id))
    return conds


def is_routable(hold: Hold, today: date, item_id: int | None = None) -> bool:
    """Python twin of :func:`routable` for already-loaded holds."""
    if hold.status != HoldStatus.queued:
        return False
    if hold.suspended and not (hold.suspended_until and hold.suspended_until <= today):
        return False
    if hold.not_needed_after and hold.not_needed_after < today:
        return False
    return item_id is None or hold.requested_item_id in (None, item_id)


def validate_requested_item(db: Session, biblio: Biblio, item_id: int) -> Item:
    item = db.get(Item, item_id)
    if item is None or item.biblio_id != biblio.id or item.deleted_at is not None:
        raise NotFound("That copy does not belong to this title")
    if not item.item_type.holdable:
        raise PolicyBlocked(f"Copy {item.barcode} cannot be placed on hold ({item.item_type.name})")
    if item.status in (ItemStatus.withdrawn, ItemStatus.lost):
        raise PolicyBlocked(f"Copy {item.barcode} is {item.status.value}")
    return item


def validate_not_needed_after(d: date | None, today: date | None = None) -> date | None:
    if d is not None and d < (today or utcnow().date()):
        raise PolicyBlocked("“Not needed after” must be today or later")
    return d


# ------------------------------------------------------------------ actions


def suspend(db: Session, hold: Hold, *, until: date | None = None, actor: Patron | None = None,
            today: date | None = None) -> Hold:
    today = today or utcnow().date()
    if hold.status != HoldStatus.queued:
        raise Conflict("Only holds still waiting in the queue can be suspended")
    if hold.item_id is not None:
        raise Conflict("A copy is already on its way for this hold — it can no longer be suspended")
    if until is not None and until <= today:
        raise PolicyBlocked("The resume date must be in the future")
    hold.suspended = True
    hold.suspended_until = until
    db.flush()
    audit.record(db, "hold_suspended", "hold", hold.id, actor=actor, until=until.isoformat() if until else None)
    return hold


def resume(db: Session, hold: Hold, *, actor: Patron | None = None) -> Hold:
    if not hold.suspended:
        raise Conflict("Hold is not suspended")
    hold.suspended = False
    hold.suspended_until = None
    db.flush()
    audit.record(db, "hold_resumed", "hold", hold.id, actor=actor)
    return hold


_UNSET = object()


def update(db: Session, hold: Hold, *, actor: Patron | None = None, notes=_UNSET, not_needed_after=_UNSET,
           pickup_branch_id=_UNSET) -> Hold:
    """Edit a hold's note, "not needed after" date or (while still unrouted) its pickup branch."""
    from .circulation import ACTIVE_HOLD_STATUSES

    if hold.status not in ACTIVE_HOLD_STATUSES:
        raise Conflict("Hold is not active")
    changed = []
    if notes is not _UNSET:
        hold.notes = (notes or "").strip()[:255] or None
        changed.append("notes")
    if not_needed_after is not _UNSET:
        hold.not_needed_after = validate_not_needed_after(not_needed_after)
        changed.append("not_needed_after")
    if pickup_branch_id is not _UNSET and pickup_branch_id != hold.pickup_branch_id:
        if hold.status != HoldStatus.queued or hold.item_id is not None:
            raise Conflict("The pickup branch cannot change once a copy has been assigned")
        branch = db.get(Branch, pickup_branch_id)
        if branch is None:
            raise NotFound("Unknown pickup branch")
        hold.pickup_branch = branch
        changed.append("pickup_branch")
    db.flush()
    audit.record(db, "hold_updated", "hold", hold.id, actor=actor, fields=changed or None)
    return hold


def run_nightly(db: Session, *, now: datetime | None = None) -> dict:
    """Resume suspensions whose date has come; expire queued holds past "not needed after"."""
    from .circulation import cancel_hold

    now = now or utcnow()
    today = now.date()
    stats = {"holds_resumed": 0, "holds_not_needed": 0}
    for hold in db.scalars(select(Hold).where(Hold.status == HoldStatus.queued, Hold.suspended.is_(True),
                                              Hold.suspended_until.is_not(None), Hold.suspended_until <= today)):
        hold.suspended, hold.suspended_until = False, None
        audit.record(db, "hold_resumed", "hold", hold.id, automatic=True)
        stats["holds_resumed"] += 1
    for hold in db.scalars(select(Hold).where(Hold.status == HoldStatus.queued, Hold.not_needed_after.is_not(None),
                                              Hold.not_needed_after < today)).all():
        cancel_hold(db, hold, now=now, status=HoldStatus.expired)
        stats["holds_not_needed"] += 1
    db.flush()
    return stats
