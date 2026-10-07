"""Hold actions beyond place/cancel: suspend, resume and edit (staff and patron self-service)."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends
from pydantic import Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..errors import NotFound
from ..models import Hold, Patron
from ..schemas import StrictModel, hold_out
from ..services import circulation
from ..services import holds as holds_svc

router = APIRouter(tags=["holds"])


class SuspendIn(StrictModel):
    until: date | None = Field(default=None, description="Resume automatically on this date (omit = indefinitely)")


class HoldPatch(StrictModel):
    notes: str | None = Field(default=None, max_length=255)
    not_needed_after: date | None = None
    pickup_branch_id: int | None = None


def _out(db: Session, hold: Hold) -> dict:
    return hold_out(hold, circulation.hold_queue_position(db, hold))


def _hold(db: Session, hold_id: int, owner: Patron | None = None) -> Hold:
    hold = db.get(Hold, hold_id)
    if hold is None or (owner is not None and hold.patron_id != owner.id):
        raise NotFound("Hold not found")
    return hold


def _patch(db: Session, hold: Hold, body: HoldPatch, actor: Patron) -> Hold:
    fields = body.model_dump(exclude_unset=True)
    if fields.get("pickup_branch_id") is None:
        fields.pop("pickup_branch_id", None)
    return holds_svc.update(db, hold, actor=actor, **fields)


# ------------------------------------------------------------------ staff


@router.post("/holds/{hold_id}/suspend")
def suspend(hold_id: int, body: SuspendIn, db: Session = Depends(get_db),
            user: Patron = Depends(require("holds:manage"))):
    hold = holds_svc.suspend(db, _hold(db, hold_id), until=body.until, actor=user)
    db.commit()
    return _out(db, hold)


@router.post("/holds/{hold_id}/resume")
def resume(hold_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("holds:manage"))):
    hold = holds_svc.resume(db, _hold(db, hold_id), actor=user)
    db.commit()
    return _out(db, hold)


@router.patch("/holds/{hold_id}")
def update(hold_id: int, body: HoldPatch, db: Session = Depends(get_db),
           user: Patron = Depends(require("holds:manage"))):
    hold = _patch(db, _hold(db, hold_id), body, user)
    db.commit()
    return _out(db, hold)


# ------------------------------------------------------------------ patron (OPAC)


@router.post("/opac/me/holds/{hold_id}/suspend")
def suspend_own(hold_id: int, body: SuspendIn, db: Session = Depends(get_db), user: Patron = Depends(require("opac"))):
    hold = holds_svc.suspend(db, _hold(db, hold_id, user), until=body.until, actor=user)
    db.commit()
    return _out(db, hold)


@router.post("/opac/me/holds/{hold_id}/resume")
def resume_own(hold_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("opac"))):
    hold = holds_svc.resume(db, _hold(db, hold_id, user), actor=user)
    db.commit()
    return _out(db, hold)


@router.patch("/opac/me/holds/{hold_id}")
def update_own(hold_id: int, body: HoldPatch, db: Session = Depends(get_db), user: Patron = Depends(require("opac"))):
    hold = _patch(db, _hold(db, hold_id, user), body, user)
    db.commit()
    return _out(db, hold)
