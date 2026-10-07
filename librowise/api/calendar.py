"""Library calendar API: weekly closed days and dated closures per branch."""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..errors import PolicyBlocked
from ..models import Patron, utcnow
from ..schemas import StrictModel
from ..services import calendar as cal

router = APIRouter(prefix="/calendar", tags=["calendar"])
MAX_RANGE_DAYS = 120


class WeekdaysIn(StrictModel):
    closed_weekdays: list[int] = Field(default_factory=list, max_length=7, description="0 = Monday … 6 = Sunday")


class ClosureIn(StrictModel):
    branch_id: int | None = Field(default=None, description="Omit / null for every branch")
    day: date
    end_day: date | None = Field(default=None, description="Close a whole range (inclusive)")
    description: str = Field(default="", max_length=160)
    repeats_yearly: bool = False
    open_override: bool = Field(default=False, description="Special opening on a normally closed day")


@router.get("/{branch_id}/month")
def month(branch_id: int, year: int = Query(ge=1900, le=2200), month: int = Query(ge=1, le=12),
          db: Session = Depends(get_db), _: Patron = Depends(require("circulation"))):
    return cal.month_view(db, branch_id, year, month)


@router.get("/{branch_id}/check")
def check(branch_id: int, day: date | None = Query(default=None, alias="date"), db: Session = Depends(get_db),
          _: Patron = Depends(require("circulation"))):
    """Is the branch open on a day, and if not, when does it next open?"""
    c = cal.for_branch(db, branch_id)
    d = day or utcnow().date()
    s = c.status(d)
    return {"date": d, "open": s.open, "reason": s.reason, "next_open": c.next_open_day(d)}


@router.put("/{branch_id}/weekdays")
def set_weekdays(branch_id: int, body: WeekdaysIn, db: Session = Depends(get_db),
                 user: Patron = Depends(require("calendar:manage"))):
    closed = cal.set_closed_weekdays(db, branch_id, body.closed_weekdays, actor=user)
    db.commit()
    return {"branch_id": branch_id, "closed_weekdays": closed}


@router.get("/closures")
def closures(branch_id: int | None = None, start: date | None = None, end: date | None = None,
             db: Session = Depends(get_db), _: Patron = Depends(require("circulation"))):
    return {"results": cal.list_closures(db, branch_id, start=start, end=end)}


@router.post("/closures", status_code=201)
def add_closure(body: ClosureIn, db: Session = Depends(get_db), user: Patron = Depends(require("calendar:manage"))):
    last = body.end_day or body.day
    if last < body.day:
        raise PolicyBlocked("The end date is before the start date")
    span = (last - body.day).days
    if span > MAX_RANGE_DAYS:
        raise PolicyBlocked(f"Close at most {MAX_RANGE_DAYS} days at once")
    if span and body.repeats_yearly:
        raise PolicyBlocked("Yearly closures are single days")
    rows = [cal.add_closure(db, branch_id=body.branch_id, day=body.day + timedelta(days=i),
                            description=body.description, repeats_yearly=body.repeats_yearly,
                            open_override=body.open_override, actor=user) for i in range(span + 1)]
    db.commit()
    return {"results": [cal.closure_out(r) for r in rows]}


@router.delete("/closures/{closure_id}")
def delete_closure(closure_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("calendar:manage"))):
    cal.delete_closure(db, closure_id, actor=user)
    db.commit()
    return {"ok": True}
