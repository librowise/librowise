"""Serials control: subscriptions, issue prediction, receiving, late detection and claims.

Prediction model
----------------
* **Frequency** gives the publication rhythm: a step of N days or N months from the first issue date
  (``first_issue_on``, defaulting to ``start_date``). Month steps are computed from the anchor date
  (``anchor + k months``, clamped to month end) so a 31st never drifts to the 28th. Day-based
  frequencies may skip weekdays (e.g. a daily that does not publish on Sunday). ``irregular``
  subscriptions are not predicted; staff add issues manually.
* **Numbering** has up to three levels X (outermost), Y and Z and works like an odometer: the
  innermost defined level advances by its ``increment`` on every issue; when it passes ``max`` it
  goes back to ``reset`` and carries one increment into the next level out. A level flagged
  ``yearly`` instead resets (and carries) whenever the calendar year changes — e.g. a weekly whose
  issue numbers restart each January. A level with ``labels`` renders as ``labels[(value - 1) % n]``
  (seasonal names such as Spring/Summer/Autumn/Winter).
* The **pattern** is free text with placeholders ``{X}``, ``{Y}``, ``{Z}`` and the chronology tokens
  ``{YEAR}``, ``{MONTH}``, ``{MON}`` and ``{DAY}`` taken from the expected date.

Issues that staff have acted on (received, missing, claimed, not published, linked to an item or
added by hand) are *locked*: regenerating predictions never changes or deletes them.
"""

from __future__ import annotations

import calendar
import re
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..errors import Conflict, NotFound, PolicyBlocked
from ..models import (
    Biblio,
    Branch,
    Budget,
    ItemStatus,
    ItemType,
    Loan,
    Patron,
    SerialClaim,
    SerialIssue,
    SerialIssueStatus,
    SerialRouting,
    Subscription,
    SubscriptionStatus,
    Vendor,
    utcnow,
)
from . import audit, catalog

# ------------------------------------------------------------------ constants

#: frequency -> (unit, step) ; ``every_n_*`` multiply the step by ``frequency_interval``.
FREQUENCIES: dict[str, tuple[str, int] | None] = {
    "daily": ("day", 1),
    "weekly": ("day", 7),
    "fortnightly": ("day", 14),
    "monthly": ("month", 1),
    "bimonthly": ("month", 2),
    "quarterly": ("month", 3),
    "semiannual": ("month", 6),
    "annual": ("month", 12),
    "irregular": None,
    "every_n_days": ("day", 1),
    "every_n_weeks": ("day", 7),
    "every_n_months": ("month", 1),
}
FREQUENCY_LABELS = {
    "daily": "Daily",
    "weekly": "Weekly",
    "fortnightly": "Fortnightly (every 2 weeks)",
    "monthly": "Monthly",
    "bimonthly": "Bimonthly (every 2 months)",
    "quarterly": "Quarterly",
    "semiannual": "Semiannual (twice a year)",
    "annual": "Annual",
    "irregular": "Irregular (no prediction)",
    "every_n_days": "Every N days",
    "every_n_weeks": "Every N weeks",
    "every_n_months": "Every N months",
}
LEVELS = ("X", "Y", "Z")
DATE_TOKENS = ("YEAR", "MONTH", "MON", "DAY")
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
PLACEHOLDER = re.compile(r"\{([A-Z]+)\}")

PATTERN_PRESETS = [
    {"key": "vol_no", "label": "Vol. X, No. Y (12 per volume)", "pattern": "Vol. {X}, No. {Y}",
     "numbering": {"X": {"start": 1}, "Y": {"start": 1, "max": 12}}},
    {"key": "vol_no_yearly", "label": "Vol. X, No. Y (numbers restart each year)", "pattern": "Vol. {X}, No. {Y}",
     "numbering": {"X": {"start": 1}, "Y": {"start": 1, "yearly": True}}},
    {"key": "number", "label": "No. X (continuous)", "pattern": "No. {X}", "numbering": {"X": {"start": 1}}},
    {"key": "vol_no_part", "label": "Vol. X, No. Y, Pt. Z", "pattern": "Vol. {X}, No. {Y}, Pt. {Z}",
     "numbering": {"X": {"start": 1}, "Y": {"start": 1, "max": 4}, "Z": {"start": 1, "max": 2}}},
    {"key": "seasonal", "label": "Season Year (quarterly)", "pattern": "{Y} {YEAR}",
     "numbering": {"Y": {"start": 1, "max": 4, "labels": ["Spring", "Summer", "Autumn", "Winter"]}}},
    {"key": "month_year", "label": "Month Year (chronology only)", "pattern": "{MONTH} {YEAR}", "numbering": {}},
]

LOCKED_STATUSES = {SerialIssueStatus.arrived, SerialIssueStatus.missing, SerialIssueStatus.claimed,
                   SerialIssueStatus.not_published}
OUTSTANDING_STATUSES = (SerialIssueStatus.late, SerialIssueStatus.claimed, SerialIssueStatus.missing)
CLAIMABLE_STATUSES = {SerialIssueStatus.late, SerialIssueStatus.missing, SerialIssueStatus.claimed}
DEFAULT_HORIZON_DAYS = 180
MAX_ISSUES = 3000  # hard cap per subscription prediction run (≈8 years of a daily)


# ------------------------------------------------------------------ prediction (pure functions)


@dataclass(frozen=True)
class Level:
    start: int = 1
    increment: int = 1
    max: int | None = None
    reset: int = 1
    yearly: bool = False
    labels: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, d: dict | None) -> Level:
        d = d or {}
        return cls(
            start=int(d.get("start", 1) if d.get("start") is not None else 1),
            increment=int(d.get("increment") or 1),
            max=int(d["max"]) if d.get("max") not in (None, "", 0) else None,
            reset=int(d.get("reset", 1) if d.get("reset") is not None else 1),
            yearly=bool(d.get("yearly", False)),
            labels=tuple(str(x).strip() for x in (d.get("labels") or []) if str(x).strip()),
        )

    def as_dict(self) -> dict:
        return {"start": self.start, "increment": self.increment, "max": self.max, "reset": self.reset,
                "yearly": self.yearly, "labels": list(self.labels)}


@dataclass
class SerialSpec:
    """Everything prediction needs; built from a Subscription or from an unsaved form (preview)."""

    frequency: str
    anchor: date
    interval: int = 1
    skip_weekdays: list[int] = field(default_factory=list)
    pattern: str = "No. {X}"
    numbering: dict = field(default_factory=dict)
    end_date: date | None = None

    @property
    def levels(self) -> dict[str, Level]:
        return {k: Level.from_dict(self.numbering[k]) for k in LEVELS if k in (self.numbering or {})}

    @classmethod
    def of(cls, sub: Subscription) -> SerialSpec:
        return cls(frequency=sub.frequency, anchor=sub.first_issue_on or sub.start_date,
                   interval=sub.frequency_interval or 1, skip_weekdays=list(sub.skip_weekdays or []),
                   pattern=sub.numbering_pattern, numbering=dict(sub.numbering or {}), end_date=sub.end_date)


@dataclass
class Predicted:
    sequence: int
    numbers: list[int]
    enumeration: str
    chronology: str
    expected_on: date

    def as_dict(self) -> dict:
        return {"sequence": self.sequence, "numbers": self.numbers, "enumeration": self.enumeration,
                "chronology": self.chronology, "expected_on": self.expected_on}


def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def step_of(frequency: str, interval: int = 1) -> tuple[str, int] | None:
    if frequency not in FREQUENCIES:
        raise PolicyBlocked(f"Unknown frequency '{frequency}'")
    base = FREQUENCIES[frequency]
    if base is None:
        return None
    unit, n = base
    if frequency.startswith("every_n_"):
        n *= max(1, int(interval or 1))
    return unit, n


def issue_dates(spec: SerialSpec) -> Iterator[date]:
    """Expected publication dates, in order, starting with the first issue (infinite for regular serials)."""
    st = step_of(spec.frequency, spec.interval)
    if st is None:
        return
    unit, n = st
    skip = {int(w) for w in spec.skip_weekdays or []} if unit == "day" else set()
    k, skipped_in_row = 0, 0
    while True:
        d = spec.anchor + timedelta(days=k * n) if unit == "day" else add_months(spec.anchor, k * n)
        k += 1
        if d.weekday() in skip:
            skipped_in_row += 1
            if skipped_in_row >= 7:  # every candidate falls on a skipped weekday
                return
            continue
        skipped_in_row = 0
        yield d


def initial_numbers(levels: dict[str, Level]) -> list[int]:
    return [lvl.start for lvl in levels.values()]


def next_numbers(levels: dict[str, Level], nums: list[int], prev: date | None, nxt: date) -> list[int]:
    """Advance the odometer by one issue published on ``nxt`` (previous issue on ``prev``)."""
    lv = list(levels.values())
    out = list(nums)
    new_year = prev is not None and nxt.year != prev.year
    carry = True  # the innermost level advances on every issue
    for i in reversed(range(len(lv))):
        lvl = lv[i]
        if lvl.yearly and new_year:
            out[i] = lvl.reset
            carry = True
            continue
        if not carry:
            continue
        out[i] += lvl.increment
        if not lvl.yearly and lvl.max is not None and out[i] > lvl.max:
            out[i] = lvl.reset
            carry = True
        else:
            carry = False
    return out


def render(pattern: str, levels: dict[str, Level], nums: list[int], d: date) -> str:
    keys = list(levels)

    def sub(m: re.Match) -> str:
        tok = m.group(1)
        if tok in levels:
            lvl, v = levels[tok], nums[keys.index(tok)]
            return lvl.labels[(v - 1) % len(lvl.labels)] if lvl.labels else str(v)
        if tok == "YEAR":
            return str(d.year)
        if tok == "MONTH":
            return MONTHS[d.month - 1]
        if tok == "MON":
            return MONTHS[d.month - 1][:3]
        if tok == "DAY":
            return str(d.day)
        return m.group(0)

    return PLACEHOLDER.sub(sub, pattern).strip()


def chronology(frequency: str, interval: int, d: date) -> str:
    st = step_of(frequency, interval)
    if st is None or st[0] == "day":
        return f"{d.day} {MONTHS[d.month - 1][:3]} {d.year}"
    if st[1] % 12 == 0:
        return str(d.year)
    return f"{MONTHS[d.month - 1][:3]} {d.year}"


def validate_spec(spec: SerialSpec) -> None:
    """Raise PolicyBlocked with a readable message if the pattern cannot be used."""
    step_of(spec.frequency, spec.interval)
    if not 1 <= int(spec.interval or 1) <= 366:
        raise PolicyBlocked("Frequency interval must be between 1 and 366")
    if any(int(w) not in range(7) for w in spec.skip_weekdays or []):
        raise PolicyBlocked("Skipped weekdays must be 0 (Monday) to 6 (Sunday)")
    if len(set(spec.skip_weekdays or [])) >= 7:
        raise PolicyBlocked("At least one weekday must be a publication day")
    unknown = [k for k in (spec.numbering or {}) if k not in LEVELS]
    if unknown:
        raise PolicyBlocked(f"Unknown numbering level(s): {', '.join(unknown)} (use X, Y, Z)")
    levels = spec.levels
    for name, lvl in levels.items():
        if lvl.increment < 1:
            raise PolicyBlocked(f"Level {name}: increment must be at least 1")
        if lvl.max is not None and (lvl.max < lvl.reset or lvl.max < lvl.start):
            raise PolicyBlocked(f"Level {name}: rollover value must be ≥ its start and reset values")
    for tok in PLACEHOLDER.findall(spec.pattern or ""):
        if tok in LEVELS and tok not in levels:
            raise PolicyBlocked(f"The pattern uses {{{tok}}} but level {tok} is not configured")
        if tok not in LEVELS and tok not in DATE_TOKENS:
            raise PolicyBlocked(f"Unknown placeholder {{{tok}}} in the numbering pattern")
    if not (spec.pattern or "").strip():
        raise PolicyBlocked("A numbering pattern is required")
    if spec.end_date and spec.end_date < spec.anchor:
        raise PolicyBlocked("The subscription ends before its first issue")


def predict(spec: SerialSpec, *, until: date | None = None, min_sequence: int = -1,
            limit: int = MAX_ISSUES) -> Iterator[Predicted]:
    """Yield predicted issues in order. Stops at the end date, at ``limit`` issues, and at ``until`` —
    but never before reaching ``min_sequence`` (so existing predictions are always recomputed)."""
    levels = spec.levels
    nums: list[int] = []
    prev: date | None = None
    for seq, d in enumerate(issue_dates(spec)):
        if seq >= limit or (spec.end_date and d > spec.end_date):
            return
        if until is not None and d > until and seq > min_sequence:
            return
        nums = initial_numbers(levels) if seq == 0 else next_numbers(levels, nums, prev, d)
        prev = d
        yield Predicted(seq, list(nums), render(spec.pattern, levels, nums, d),
                        chronology(spec.frequency, spec.interval, d), d)


def preview(spec: SerialSpec, *, count: int = 6, today: date | None = None) -> dict:
    """The next ``count`` issues on or after today (or from the first issue if it is in the future)."""
    validate_spec(spec)
    today = today or utcnow().date()
    if step_of(spec.frequency, spec.interval) is None:
        return {"issues": [], "irregular": True, "per_year": None}
    out: list[Predicted] = []
    for p in predict(spec, limit=MAX_ISSUES):
        if p.expected_on >= today:
            out.append(p)
        if len(out) >= count:
            break
    per_year = sum(1 for p in predict(spec, until=spec.anchor + timedelta(days=364)))
    return {"issues": [p.as_dict() for p in out], "irregular": False, "per_year": per_year}


# ------------------------------------------------------------------ subscriptions


def get_subscription(db: Session, sub_id: int) -> Subscription:
    sub = db.get(Subscription, sub_id)
    if sub is None:
        raise NotFound(f"Subscription {sub_id} not found")
    return sub


def get_issue(db: Session, issue_id: int) -> SerialIssue:
    issue = db.get(SerialIssue, issue_id)
    if issue is None:
        raise NotFound(f"Issue {issue_id} not found")
    return issue


PATTERN_FIELDS = ("frequency", "frequency_interval", "skip_weekdays", "numbering_pattern", "numbering",
                  "start_date", "first_issue_on", "end_date")
EDITABLE_FIELDS = PATTERN_FIELDS + ("vendor_id", "budget_id", "branch_id", "grace_days", "create_items",
                                    "item_type_id", "shelf_location", "call_number", "price", "vendor_reference",
                                    "notes")


def apply_subscription_data(db: Session, sub: Subscription, data: dict) -> bool:
    """Validate and copy editable fields onto ``sub``. Returns True if prediction-relevant fields changed."""
    data = {k: v for k, v in data.items() if k in EDITABLE_FIELDS}
    if "numbering" in data:
        data["numbering"] = {k: Level.from_dict(v).as_dict() for k, v in (data["numbering"] or {}).items()}
    if "skip_weekdays" in data:
        data["skip_weekdays"] = sorted({int(w) for w in data["skip_weekdays"] or []})
    for fk, model, label in (("vendor_id", Vendor, "vendor"), ("budget_id", Budget, "budget"),
                             ("branch_id", Branch, "branch"), ("item_type_id", ItemType, "item type")):
        if data.get(fk) is not None and db.get(model, data[fk]) is None:
            raise NotFound(f"Unknown {label}")
    changed = any(k in data and getattr(sub, k) != data[k] for k in PATTERN_FIELDS)
    for k, v in data.items():
        setattr(sub, k, v)
    if sub.start_date is None:
        raise PolicyBlocked("A start date is required")
    if sub.end_date and sub.end_date < sub.start_date:
        raise PolicyBlocked("The end date must be on or after the start date")
    if sub.create_items and not sub.item_type_id:
        raise PolicyBlocked("Choose an item type for the items created when issues are received")
    validate_spec(SerialSpec.of(sub))
    return changed


def create_subscription(db: Session, biblio: Biblio, data: dict, *, actor: Patron | None = None,
                        generate: bool = True, today: date | None = None) -> Subscription:
    if biblio.deleted_at is not None:
        raise NotFound("Record not found")
    if biblio.material_type != "serial":
        raise PolicyBlocked(f"“{biblio.title}” is catalogued as '{biblio.material_type}', not a serial")
    sub = Subscription(biblio_id=biblio.id, status=SubscriptionStatus.active)
    sub.biblio = biblio
    db.add(sub)
    apply_subscription_data(db, sub, data)
    db.flush()
    stats = generate_issues(db, sub, today=today) if generate else None
    audit.record(db, "create", "subscription", sub.id, actor=actor, biblio=biblio.id,
                 predicted=stats["created"] if stats else None)
    return sub


def _is_locked(issue: SerialIssue) -> bool:
    return (issue.status in LOCKED_STATUSES or issue.claim_count > 0 or issue.item_id is not None
            or issue.manual or issue.sequence is None)


def _open_status(issue: SerialIssue, grace_days: int, today: date) -> SerialIssueStatus:
    """Status of an issue that has not been received/acted on, given today's date."""
    if issue.claim_count:
        return SerialIssueStatus.claimed
    if issue.expected_on + timedelta(days=grace_days or 0) < today:
        return SerialIssueStatus.late
    return SerialIssueStatus.expected


def generate_issues(db: Session, sub: Subscription, *, horizon_days: int = DEFAULT_HORIZON_DAYS,
                    today: date | None = None) -> dict:
    """Create/refresh predicted issues up to ``today + horizon_days`` (and the subscription end date).

    Idempotent and safe to repeat: locked issues are never touched, untouched predictions are updated
    in place to match the current pattern, and stale predictions beyond the end of the run are removed."""
    stats = {"created": 0, "updated": 0, "removed": 0}
    if sub.status != SubscriptionStatus.active or step_of(sub.frequency, sub.frequency_interval) is None:
        return stats
    today = today or utcnow().date()
    spec = SerialSpec.of(sub)
    validate_spec(spec)
    existing = {i.sequence: i for i in db.scalars(select(SerialIssue).where(
        SerialIssue.subscription_id == sub.id, SerialIssue.sequence.is_not(None)))}
    max_unlocked = max((s for s, i in existing.items() if not _is_locked(i)), default=-1)
    seen: set[int] = set()
    for p in predict(spec, until=today + timedelta(days=max(0, horizon_days)), min_sequence=max_unlocked):
        seen.add(p.sequence)
        issue = existing.get(p.sequence)
        if issue is None:
            issue = SerialIssue(subscription_id=sub.id, sequence=p.sequence, numbers=p.numbers,
                                enumeration=p.enumeration, chronology=p.chronology, expected_on=p.expected_on,
                                claim_count=0)
            issue.status = _open_status(issue, sub.grace_days, today)
            db.add(issue)
            stats["created"] += 1
        elif not _is_locked(issue):
            values = {"numbers": p.numbers, "enumeration": p.enumeration, "chronology": p.chronology,
                      "expected_on": p.expected_on}
            if any(getattr(issue, k) != v for k, v in values.items()):
                for k, v in values.items():
                    setattr(issue, k, v)
                stats["updated"] += 1
            status = _open_status(issue, sub.grace_days, today)
            if status != issue.status:
                issue.status = status
    for seq, issue in existing.items():
        if seq not in seen and not _is_locked(issue):
            db.delete(issue)
            stats["removed"] += 1
    db.flush()
    return stats


def add_manual_issue(db: Session, sub: Subscription, *, expected_on: date, enumeration: str | None = None,
                     chronology_text: str | None = None, notes: str | None = None,
                     actor: Patron | None = None, today: date | None = None) -> SerialIssue:
    """Add an issue by hand: the normal way for irregular serials, or a special issue/supplement.

    For irregular subscriptions without an explicit enumeration the numbering continues from the
    last numbered issue."""
    today = today or utcnow().date()
    irregular = step_of(sub.frequency, sub.frequency_interval) is None
    spec = SerialSpec.of(sub)
    levels = spec.levels
    numbers: list[int] = []
    sequence = None
    if irregular:
        last = db.scalar(select(SerialIssue).where(SerialIssue.subscription_id == sub.id,
                                                   SerialIssue.sequence.is_not(None))
                         .order_by(SerialIssue.sequence.desc()).limit(1))
        if last is None:
            sequence, numbers = 0, initial_numbers(levels)
        else:
            sequence = last.sequence + 1
            numbers = next_numbers(levels, list(last.numbers or initial_numbers(levels)), last.expected_on, expected_on)
        if not enumeration:
            enumeration = render(spec.pattern, levels, numbers, expected_on)
    if not enumeration:
        raise PolicyBlocked("Enter the issue's enumeration (e.g. “Special issue”)")
    issue = SerialIssue(subscription_id=sub.id, sequence=sequence, numbers=numbers, enumeration=enumeration[:160],
                        chronology=(chronology_text or chronology(sub.frequency, sub.frequency_interval, expected_on))[:64],
                        expected_on=expected_on, manual=True, claim_count=0, notes=notes)
    issue.status = _open_status(issue, sub.grace_days, today)
    db.add(issue)
    db.flush()
    audit.record(db, "add_issue", "subscription", sub.id, actor=actor, issue=issue.id, enumeration=issue.enumeration)
    return issue


def delete_manual_issue(db: Session, issue: SerialIssue, *, actor: Patron | None = None) -> None:
    if not issue.manual:
        raise Conflict("Only manually added issues can be deleted; mark predicted issues as not published instead")
    if issue.status == SerialIssueStatus.arrived or issue.item_id:
        raise Conflict("Undo the receipt before deleting this issue")
    audit.record(db, "delete_issue", "subscription", issue.subscription_id, actor=actor, issue=issue.id,
                 enumeration=issue.enumeration)
    db.delete(issue)
    db.flush()


def cancel_subscription(db: Session, sub: Subscription, *, actor: Patron | None = None, reason: str | None = None,
                        today: date | None = None) -> int:
    """Cancel and drop untouched future predictions. Returns the number of predictions removed."""
    if sub.status == SubscriptionStatus.cancelled:
        raise Conflict("Subscription is already cancelled")
    today = today or utcnow().date()
    sub.status = SubscriptionStatus.cancelled
    sub.cancelled_at = utcnow()
    removed = 0
    for issue in db.scalars(select(SerialIssue).where(SerialIssue.subscription_id == sub.id,
                                                      SerialIssue.expected_on > today)):
        if not _is_locked(issue):
            db.delete(issue)
            removed += 1
    db.flush()
    audit.record(db, "cancel", "subscription", sub.id, actor=actor, reason=reason, removed=removed)
    return removed


def renew_subscription(db: Session, sub: Subscription, end_date: date, *, actor: Patron | None = None,
                       today: date | None = None) -> dict:
    if sub.end_date and end_date <= sub.end_date and sub.status == SubscriptionStatus.active:
        raise PolicyBlocked("The new end date must be later than the current one")
    if end_date < sub.start_date:
        raise PolicyBlocked("The new end date is before the subscription start")
    previous = sub.end_date
    sub.end_date = end_date
    sub.status = SubscriptionStatus.active
    sub.cancelled_at = None
    stats = generate_issues(db, sub, today=today)
    audit.record(db, "renew", "subscription", sub.id, actor=actor,
                 previous_end=previous.isoformat() if previous else None, end=end_date.isoformat())
    return stats


def set_routing(db: Session, sub: Subscription, entries: list[dict], *, actor: Patron | None = None) -> None:
    ids = [int(e["patron_id"]) for e in entries]
    if len(set(ids)) != len(ids):
        raise PolicyBlocked("A person can appear on a routing list only once")
    found = {p.id for p in db.scalars(select(Patron).where(Patron.id.in_(ids), Patron.deleted_at.is_(None)))} if ids else set()
    missing = [i for i in ids if i not in found]
    if missing:
        raise NotFound(f"Unknown patron(s): {', '.join(map(str, missing))}")
    sub.routing.clear()
    db.flush()
    for pos, e in enumerate(entries):
        sub.routing.append(SerialRouting(patron_id=int(e["patron_id"]), position=pos, notes=e.get("notes") or None))
    db.flush()
    audit.record(db, "routing", "subscription", sub.id, actor=actor, patrons=ids)


# ------------------------------------------------------------------ receiving & issue status


def receive_issue(db: Session, issue: SerialIssue, *, received_on: date | None = None, create_item: bool | None = None,
                  barcode: str | None = None, call_number: str | None = None, item_type_id: int | None = None,
                  shelf_location: str | None = None, branch_id: int | None = None, notes: str | None = None,
                  actor: Patron | None = None) -> SerialIssue:
    if issue.status == SerialIssueStatus.arrived:
        raise Conflict(f"{issue.enumeration} has already been received")
    if issue.status == SerialIssueStatus.not_published:
        raise Conflict(f"{issue.enumeration} is marked as not published — reopen it first")
    sub = issue.subscription
    received_on = received_on or utcnow().date()
    want_item = sub.create_items if create_item is None else create_item
    if want_item:
        itype = item_type_id or sub.item_type_id
        if not itype or db.get(ItemType, itype) is None:
            raise PolicyBlocked("Choose an item type for the new item")
        prefix = sub.call_number or sub.biblio.classification or ""
        item = catalog.create_item(db, sub.biblio, {
            "barcode": barcode, "branch_id": branch_id or sub.branch_id, "item_type_id": itype,
            "call_number": (call_number or f"{prefix} {issue.enumeration}".strip())[:64],
            "shelf_location": shelf_location if shelf_location is not None else sub.shelf_location,
            "acquired_on": received_on, "notes": f"Serial issue: {issue.enumeration} ({issue.chronology or ''})"[:2000],
        })
        issue.item = item
    issue.status = SerialIssueStatus.arrived
    issue.received_on = received_on
    if notes:
        issue.notes = notes[:255]
    db.flush()
    audit.record(db, "receive_issue", "subscription", sub.id, actor=actor, issue=issue.id,
                 enumeration=issue.enumeration, barcode=issue.item.barcode if issue.item else None)
    return issue


def undo_receive(db: Session, issue: SerialIssue, *, actor: Patron | None = None, today: date | None = None) -> None:
    if issue.status != SerialIssueStatus.arrived:
        raise Conflict(f"{issue.enumeration} has not been received")
    item = issue.item
    barcode = None
    if item is not None:
        if db.scalar(select(func.count()).select_from(Loan).where(Loan.item_id == item.id)):
            raise Conflict("This issue's item has already circulated, so the receipt cannot be undone")
        if item.status not in (ItemStatus.available, ItemStatus.processing):
            raise Conflict(f"This issue's item is '{item.status.value}' — resolve that first")
        barcode = item.barcode
        issue.item = None
        db.flush()
        db.delete(item)
        db.flush()
        db.expire(issue.subscription.biblio, ["items"])
    issue.received_on = None
    issue.status = _open_status(issue, issue.subscription.grace_days, today or utcnow().date())
    db.flush()
    audit.record(db, "undo_receive", "subscription", issue.subscription_id, actor=actor, issue=issue.id,
                 barcode=barcode)


#: target status -> statuses it may be set from
STATUS_TRANSITIONS = {
    SerialIssueStatus.missing: {SerialIssueStatus.expected, SerialIssueStatus.late, SerialIssueStatus.claimed},
    SerialIssueStatus.not_published: {SerialIssueStatus.expected, SerialIssueStatus.late, SerialIssueStatus.claimed,
                                      SerialIssueStatus.missing},
    SerialIssueStatus.expected: {SerialIssueStatus.missing, SerialIssueStatus.not_published},  # "reopen"
}


def set_issue_status(db: Session, issue: SerialIssue, status: SerialIssueStatus, *, actor: Patron | None = None,
                     note: str | None = None, today: date | None = None) -> SerialIssue:
    allowed = STATUS_TRANSITIONS.get(status)
    if allowed is None:
        raise PolicyBlocked(f"Use the receive or claim actions to set '{status.value}'")
    if issue.status not in allowed:
        raise Conflict(f"{issue.enumeration} is '{issue.status.value}' and cannot become '{status.value}'")
    before = issue.status
    issue.status = (_open_status(issue, issue.subscription.grace_days, today or utcnow().date())
                    if status == SerialIssueStatus.expected else status)
    if note:
        issue.notes = note[:255]
    db.flush()
    audit.record(db, "issue_status", "subscription", issue.subscription_id, actor=actor, issue=issue.id,
                 before=before.value, after=issue.status.value)
    return issue


# ------------------------------------------------------------------ late detection & claims


def mark_late_issues(db: Session, now: datetime | None = None) -> int:
    """Flag expected issues of active subscriptions whose expected date + grace period has passed."""
    today = (now or utcnow()).date()
    n = 0
    rows = db.execute(select(SerialIssue, Subscription.grace_days).join(Subscription).where(
        SerialIssue.status == SerialIssueStatus.expected, SerialIssue.expected_on < today,
        Subscription.status == SubscriptionStatus.active)).all()
    for issue, grace in rows:
        if issue.expected_on + timedelta(days=grace or 0) < today:
            issue.status = SerialIssueStatus.late
            n += 1
    db.flush()
    return n


def expire_subscriptions(db: Session, today: date | None = None) -> int:
    today = today or utcnow().date()
    n = 0
    for sub in db.scalars(select(Subscription).where(Subscription.status == SubscriptionStatus.active,
                                                     Subscription.end_date < today)):
        sub.status = SubscriptionStatus.expired
        audit.record(db, "expire", "subscription", sub.id)
        n += 1
    db.flush()
    return n


def nightly(db: Session, now: datetime) -> dict:
    """Nightly job hook (see services.circulation.NIGHTLY_HOOKS): expiry, prediction top-up, late flags."""
    today = now.date()
    late = mark_late_issues(db, now)
    expired = expire_subscriptions(db, today)
    predicted = 0
    for sub in db.scalars(select(Subscription).where(Subscription.status == SubscriptionStatus.active)):
        if step_of(sub.frequency, sub.frequency_interval) is not None:
            predicted += generate_issues(db, sub, today=today)["created"]
    return {"serials_late": late, "serials_expired": expired, "serials_predicted": predicted}


def claim_issues(db: Session, issues: list[SerialIssue], *, actor: Patron | None = None, note: str | None = None,
                 now: datetime | None = None) -> str:
    """Record a claim for each issue (one batch). Returns the batch id used by the claim-letter page."""
    if not issues:
        raise PolicyBlocked("Select at least one issue to claim")
    bad = [i for i in issues if i.status not in CLAIMABLE_STATUSES]
    if bad:
        raise Conflict("Only late, missing or previously claimed issues can be claimed: "
                       + ", ".join(f"{i.enumeration} ({i.status.value})" for i in bad[:5]))
    now = now or utcnow()
    batch = uuid.uuid4().hex
    for issue in issues:
        sub = issue.subscription
        db.add(SerialClaim(batch=batch, issue_id=issue.id, vendor_id=sub.vendor_id, claimed_at=now,
                           claimed_by_id=actor.id if actor else None, note=note))
        issue.claim_count = (issue.claim_count or 0) + 1
        issue.last_claimed_at = now
        issue.status = SerialIssueStatus.claimed
        audit.record(db, "claim_issue", "subscription", sub.id, actor=actor, issue=issue.id,
                     vendor=sub.vendor_id, claim=issue.claim_count, batch=batch)
    db.flush()
    return batch


def late_issues(db: Session, *, vendor_id: int | None = None, today: date | None = None) -> list[SerialIssue]:
    stmt = (select(SerialIssue).join(Subscription).where(
        SerialIssue.status.in_(OUTSTANDING_STATUSES),
        Subscription.status != SubscriptionStatus.cancelled).order_by(SerialIssue.expected_on))
    if vendor_id == 0:  # 0 = subscriptions without a vendor
        stmt = stmt.where(Subscription.vendor_id.is_(None))
    elif vendor_id is not None:
        stmt = stmt.where(Subscription.vendor_id == vendor_id)
    return list(db.scalars(stmt))


def expiring(db: Session, *, days: int = 60, today: date | None = None) -> list[Subscription]:
    """Active subscriptions ending within ``days`` plus those that expired in the last 30 days."""
    today = today or utcnow().date()
    return list(db.scalars(select(Subscription).where(
        Subscription.status.in_((SubscriptionStatus.active, SubscriptionStatus.expired)),
        Subscription.end_date.is_not(None),
        Subscription.end_date <= today + timedelta(days=days),
        Subscription.end_date >= today - timedelta(days=30),
    ).order_by(Subscription.end_date)))


def latest_received(db: Session, biblio_id: int, *, limit: int = 12) -> list[SerialIssue]:
    return list(db.scalars(select(SerialIssue).join(Subscription).where(
        Subscription.biblio_id == biblio_id, SerialIssue.status == SerialIssueStatus.arrived)
        .order_by(SerialIssue.received_on.desc(), SerialIssue.expected_on.desc()).limit(limit)))


def next_expected(db: Session, sub_ids: list[int]) -> dict[int, SerialIssue]:
    """{subscription_id: earliest issue still expected} in two queries."""
    if not sub_ids:
        return {}
    firsts = (select(SerialIssue.subscription_id, func.min(SerialIssue.expected_on).label("d"))
              .where(SerialIssue.subscription_id.in_(sub_ids), SerialIssue.status == SerialIssueStatus.expected)
              .group_by(SerialIssue.subscription_id).subquery())
    out: dict[int, SerialIssue] = {}
    for issue in db.scalars(select(SerialIssue).join(firsts, (SerialIssue.subscription_id == firsts.c.subscription_id)
                                                     & (SerialIssue.expected_on == firsts.c.d))
                            .where(SerialIssue.status == SerialIssueStatus.expected)
                            .order_by(SerialIssue.id)):
        out.setdefault(issue.subscription_id, issue)
    return out


def status_counts(db: Session, sub_ids: list[int]) -> dict[int, dict[str, int]]:
    out: dict[int, dict[str, int]] = {i: {} for i in sub_ids}
    if not sub_ids:
        return out
    for sid, st, n in db.execute(select(SerialIssue.subscription_id, SerialIssue.status, func.count())
                                 .where(SerialIssue.subscription_id.in_(sub_ids))
                                 .group_by(SerialIssue.subscription_id, SerialIssue.status)):
        out[sid][st.value] = n
    return out
