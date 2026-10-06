"""Library calendar: weekly closed days and dated closures, per branch.

Circulation consults the calendar of the *issuing* (or pickup) branch to:

* move a computed due date that lands on a closed day to the next open day,
* count only open days when charging overdue fines (policy ``fines_skip_closed_days``),
* count only open days in the hold-shelf pickup window.

Resolution order for a given day (first match wins):

1. a branch-specific entry for that exact date,
2. a branch-specific entry repeating yearly on that month/day,
3. an all-branches entry for that exact date,
4. an all-branches entry repeating yearly,
5. the branch's weekly pattern.

An entry with ``open_override`` is a special opening (open even on a weekly closed day).
A calendar that is closed every day can never block circulation: lookups give up after
``MAX_SCAN_DAYS`` and fall back to the unadjusted date.
"""

from __future__ import annotations

import calendar as pycal
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..errors import NotFound, PolicyBlocked
from ..models import Branch, BranchCalendar, CalendarClosure, Patron
from . import audit

MAX_SCAN_DAYS = 3 * 366
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


@dataclass(frozen=True)
class DayStatus:
    day: date
    open: bool
    reason: str | None = None
    closure_id: int | None = None
    all_branches: bool = False
    repeats_yearly: bool = False
    open_override: bool = False
    weekly: bool = False  # closed because of the weekly pattern


class Calendar:
    """In-memory view of one branch's calendar (two queries, then pure date math)."""

    def __init__(self, db: Session, branch_id: int | None):
        self.branch_id = branch_id
        row = db.get(BranchCalendar, branch_id) if branch_id else None
        stored = (row.closed_weekdays if row else None) or []
        self.closed_weekdays: frozenset[int] = frozenset(d for d in stored if isinstance(d, int) and 0 <= d <= 6)
        conds = [CalendarClosure.branch_id.is_(None)]
        if branch_id:
            conds.append(CalendarClosure.branch_id == branch_id)
        self._exact_b: dict[date, CalendarClosure] = {}
        self._yearly_b: dict[tuple[int, int], CalendarClosure] = {}
        self._exact_all: dict[date, CalendarClosure] = {}
        self._yearly_all: dict[tuple[int, int], CalendarClosure] = {}
        for e in db.scalars(select(CalendarClosure).where(or_(*conds)).order_by(CalendarClosure.id)):
            specific = e.branch_id is not None
            if e.repeats_yearly:
                (self._yearly_b if specific else self._yearly_all)[(e.day.month, e.day.day)] = e
            else:
                (self._exact_b if specific else self._exact_all)[e.day] = e

    # -------------------------------------------------------------- lookups

    def entry(self, d: date) -> CalendarClosure | None:
        md = (d.month, d.day)
        return self._exact_b.get(d) or self._yearly_b.get(md) or self._exact_all.get(d) or self._yearly_all.get(md)

    def status(self, d: date) -> DayStatus:
        e = self.entry(d)
        if e is not None:
            return DayStatus(day=d, open=e.open_override, reason=e.description or None, closure_id=e.id,
                             all_branches=e.branch_id is None, repeats_yearly=e.repeats_yearly,
                             open_override=e.open_override)
        if d.weekday() in self.closed_weekdays:
            return DayStatus(day=d, open=False, reason=f"Closed on {WEEKDAYS[d.weekday()]}s", weekly=True)
        return DayStatus(day=d, open=True)

    def is_open(self, d: date) -> bool:
        e = self.entry(d)
        if e is not None:
            return e.open_override
        return d.weekday() not in self.closed_weekdays

    @property
    def always_open(self) -> bool:
        return not (self.closed_weekdays or self._exact_b or self._yearly_b or self._exact_all or self._yearly_all)

    # -------------------------------------------------------------- date math

    def next_open_day(self, d: date) -> date:
        """``d`` itself when open, otherwise the first open day after it."""
        if self.always_open:
            return d
        cur = d
        for _ in range(MAX_SCAN_DAYS):
            if self.is_open(cur):
                return cur
            cur += timedelta(days=1)
        return d  # misconfigured calendar (closed every day): never block circulation

    def add_open_days(self, start: date, n: int) -> date:
        """The ``n``-th open day after ``start`` (``n <= 0`` → next open day from ``start``)."""
        if n <= 0:
            return self.next_open_day(start)
        if self.always_open:
            return start + timedelta(days=n)
        cur, counted = start, 0
        for _ in range(MAX_SCAN_DAYS + n):
            cur += timedelta(days=1)
            if self.is_open(cur):
                counted += 1
                if counted == n:
                    return cur
        return start + timedelta(days=n)

    def open_days_between(self, start: date, end: date) -> int:
        """Number of open days ``d`` with ``start < d <= end`` (0 when ``end <= start``)."""
        span = (end - start).days
        if span <= 0:
            return 0
        if self.always_open:
            return span
        return sum(1 for i in range(1, span + 1) if self.is_open(start + timedelta(days=i)))


def for_branch(db: Session, branch_id: int | None) -> Calendar:
    return Calendar(db, branch_id)


def is_open(db: Session, branch_id: int, d: date) -> bool:
    return Calendar(db, branch_id).is_open(d)


def next_open_day(db: Session, branch_id: int, d: date) -> date:
    return Calendar(db, branch_id).next_open_day(d)


def adjust_due(db: Session, branch_id: int, due: datetime) -> datetime:
    """Move a due timestamp that falls on a closed day to the same time on the next open day."""
    d = Calendar(db, branch_id).next_open_day(due.date())
    return datetime.combine(d, due.time())


def days_late(db: Session, branch_id: int, due: datetime, when: datetime, *, skip_closed: bool = True) -> int:
    """Days an item is late at ``when``. With ``skip_closed`` only days the branch is open count."""
    if not skip_closed:
        return (when.date() - due.date()).days
    return Calendar(db, branch_id).open_days_between(due.date(), when.date())


def pickup_deadline(db: Session, branch_id: int, start: date, days: int) -> date:
    """Last day a hold may be collected: ``days`` open days after ``start``."""
    return Calendar(db, branch_id).add_open_days(start, days)


# ------------------------------------------------------------------ management (staff API)


def _branch(db: Session, branch_id: int) -> Branch:
    b = db.get(Branch, branch_id)
    if b is None:
        raise NotFound("Branch not found")
    return b


def closure_out(e: CalendarClosure) -> dict:
    return {"id": e.id, "branch_id": e.branch_id, "branch": e.branch.name if e.branch else None,
            "date": e.day, "description": e.description, "repeats_yearly": e.repeats_yearly,
            "open_override": e.open_override, "all_branches": e.branch_id is None}


def month_view(db: Session, branch_id: int, year: int, month: int) -> dict:
    if not (1 <= month <= 12) or not (1900 <= year <= 2200):
        raise PolicyBlocked("Invalid month")
    branch = _branch(db, branch_id)
    cal = Calendar(db, branch_id)
    days = []
    for n in range(1, pycal.monthrange(year, month)[1] + 1):
        s = cal.status(date(year, month, n))
        days.append({"date": s.day, "open": s.open, "reason": s.reason, "closure_id": s.closure_id,
                     "all_branches": s.all_branches, "repeats_yearly": s.repeats_yearly,
                     "open_override": s.open_override, "weekly": s.weekly})
    return {"branch": {"id": branch.id, "name": branch.name}, "year": year, "month": month,
            "closed_weekdays": sorted(cal.closed_weekdays), "days": days,
            "closed_count": sum(1 for d in days if not d["open"])}


def set_closed_weekdays(db: Session, branch_id: int, weekdays: list[int], *, actor: Patron | None) -> list[int]:
    _branch(db, branch_id)
    clean = sorted({int(d) for d in weekdays})
    if any(d < 0 or d > 6 for d in clean):
        raise PolicyBlocked("Weekdays must be 0 (Monday) … 6 (Sunday)")
    if len(clean) == 7:
        raise PolicyBlocked("A branch cannot be closed every day of the week")
    row = db.get(BranchCalendar, branch_id)
    if row is None:
        row = BranchCalendar(branch_id=branch_id, closed_weekdays=clean)
        db.add(row)
    else:
        row.closed_weekdays = clean
    audit.record(db, "calendar_weekdays", "branch", branch_id, actor=actor, closed=[WEEKDAYS[d] for d in clean])
    db.flush()
    return clean


def add_closure(db: Session, *, branch_id: int | None, day: date, description: str = "",
                repeats_yearly: bool = False, open_override: bool = False,
                actor: Patron | None = None) -> CalendarClosure:
    """Create (or update in place) the entry for ``branch_id``/``day``/recurrence."""
    if branch_id is not None:
        _branch(db, branch_id)
    existing = db.scalar(select(CalendarClosure).where(
        CalendarClosure.branch_id.is_(None) if branch_id is None else CalendarClosure.branch_id == branch_id,
        CalendarClosure.day == day, CalendarClosure.repeats_yearly == repeats_yearly))
    e = existing or CalendarClosure(branch_id=branch_id, day=day, repeats_yearly=repeats_yearly)
    e.description = (description or "").strip()[:160]
    e.open_override = open_override
    if existing is None:
        db.add(e)
    db.flush()
    audit.record(db, "calendar_closure_set", "calendar_closure", e.id, actor=actor, branch=branch_id,
                 day=day.isoformat(), yearly=repeats_yearly or None, open=open_override or None)
    return e


def delete_closure(db: Session, closure_id: int, *, actor: Patron | None = None) -> None:
    e = db.get(CalendarClosure, closure_id)
    if e is None:
        raise NotFound("Calendar entry not found")
    audit.record(db, "calendar_closure_deleted", "calendar_closure", e.id, actor=actor, branch=e.branch_id,
                 day=e.day.isoformat())
    db.delete(e)
    db.flush()


def list_closures(db: Session, branch_id: int | None = None, *, start: date | None = None,
                  end: date | None = None) -> list[dict]:
    """Entries relevant to a branch (its own + all-branch ones). Yearly entries are always included."""
    stmt = select(CalendarClosure)
    if branch_id is not None:
        stmt = stmt.where(or_(CalendarClosure.branch_id == branch_id, CalendarClosure.branch_id.is_(None)))
    rows = db.scalars(stmt.order_by(CalendarClosure.day)).all()
    out = []
    for e in rows:
        if not e.repeats_yearly and ((start and e.day < start) or (end and e.day > end)):
            continue
        out.append(closure_out(e))
    return out
