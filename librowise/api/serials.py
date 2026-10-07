"""Serials control: subscriptions, predicted issues, receiving, claims and renewal alerts."""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..errors import NotFound, PolicyBlocked
from ..models import (
    Biblio,
    Patron,
    SerialClaim,
    SerialIssue,
    SerialIssueStatus,
    Subscription,
    SubscriptionStatus,
    Vendor,
    utcnow,
)
from ..schemas import StrictModel, money
from ..services import audit, catalog
from ..services import serials as svc
from ..services import settings as settings_svc

router = APIRouter(prefix="/serials", tags=["serials"])

FREQ_PATTERN = "^(" + "|".join(svc.FREQUENCIES) + ")$"

# ------------------------------------------------------------------ schemas


class LevelIn(StrictModel):
    start: int = Field(default=1, ge=0, le=1_000_000)
    increment: int = Field(default=1, ge=1, le=1000)
    max: int | None = Field(default=None, ge=1, le=1_000_000, description="Rollover: after this value reset and carry")
    reset: int = Field(default=1, ge=0, le=1_000_000)
    yearly: bool = Field(default=False, description="Reset (and carry) when the calendar year changes")
    labels: list[str] = Field(default_factory=list, max_length=24, description="Seasonal/named labels")


class PatternIn(StrictModel):
    frequency: str = Field(default="monthly", pattern=FREQ_PATTERN)
    frequency_interval: int = Field(default=1, ge=1, le=366)
    skip_weekdays: list[int] = Field(default_factory=list, max_length=6)
    numbering_pattern: str = Field(default="No. {X}", min_length=1, max_length=160)
    numbering: dict[str, LevelIn] = Field(default_factory=lambda: {"X": LevelIn()})
    start_date: date
    first_issue_on: date | None = None
    end_date: date | None = None


class PreviewIn(PatternIn):
    count: int = Field(default=6, ge=1, le=60)


class NewSerialIn(StrictModel):
    title: str = Field(min_length=1, max_length=500)
    issn: str | None = Field(default=None, max_length=20)
    publisher: str | None = Field(default=None, max_length=255)


class SubscriptionIn(PatternIn):
    biblio_id: int | None = None
    new_biblio: NewSerialIn | None = Field(default=None, description="Create a serial record instead of linking one")
    vendor_id: int | None = None
    budget_id: int | None = None
    branch_id: int
    grace_days: int = Field(default=7, ge=0, le=365)
    create_items: bool = True
    item_type_id: int | None = None
    shelf_location: str | None = Field(default=None, max_length=64)
    call_number: str | None = Field(default=None, max_length=48)
    price: int | None = Field(default=None, ge=0, description="Annual cost in minor units")
    vendor_reference: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=4000)


class GenerateIn(StrictModel):
    horizon_days: int = Field(default=svc.DEFAULT_HORIZON_DAYS, ge=0, le=3660)


class CancelIn(StrictModel):
    reason: str | None = Field(default=None, max_length=255)


class RenewIn(StrictModel):
    end_date: date


class RoutingEntryIn(StrictModel):
    patron_id: int
    notes: str | None = Field(default=None, max_length=255)


class RoutingIn(StrictModel):
    entries: list[RoutingEntryIn] = Field(default_factory=list, max_length=100)


class ManualIssueIn(StrictModel):
    expected_on: date
    enumeration: str | None = Field(default=None, max_length=160)
    chronology: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=255)


class ReceiveIn(StrictModel):
    received_on: date | None = None
    create_item: bool | None = None
    barcode: str | None = Field(default=None, max_length=32, pattern=r"^[A-Za-z0-9\-_.]*$")
    call_number: str | None = Field(default=None, max_length=64)
    item_type_id: int | None = None
    shelf_location: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=255)


class BulkReceiveIn(StrictModel):
    issue_ids: list[int] = Field(min_length=1, max_length=500)
    received_on: date | None = None
    create_item: bool | None = None


class StatusIn(StrictModel):
    issue_ids: list[int] = Field(min_length=1, max_length=500)
    status: str = Field(pattern="^(missing|not_published|expected)$")
    note: str | None = Field(default=None, max_length=255)


class ClaimIn(StrictModel):
    issue_ids: list[int] = Field(min_length=1, max_length=500)
    note: str | None = Field(default=None, max_length=500)


# ------------------------------------------------------------------ serialisers


def _spec(body: PatternIn) -> svc.SerialSpec:
    return svc.SerialSpec(frequency=body.frequency, anchor=body.first_issue_on or body.start_date,
                          interval=body.frequency_interval, skip_weekdays=body.skip_weekdays,
                          pattern=body.numbering_pattern,
                          numbering={k: v.model_dump() for k, v in body.numbering.items()}, end_date=body.end_date)


def frequency_label(frequency: str, interval: int) -> str:
    label = svc.FREQUENCY_LABELS.get(frequency, frequency)
    return label.replace("N ", f"{interval} ") if frequency.startswith("every_n_") else label


def issue_out(i: SerialIssue, today: date | None = None) -> dict:
    today = today or utcnow().date()
    sub = i.subscription
    days_late = (today - i.expected_on).days if i.status in svc.OUTSTANDING_STATUSES else 0
    return {
        "id": i.id, "subscription_id": i.subscription_id, "sequence": i.sequence, "enumeration": i.enumeration,
        "chronology": i.chronology, "expected_on": i.expected_on, "received_on": i.received_on,
        "status": i.status.value, "manual": i.manual, "claim_count": i.claim_count,
        "last_claimed_at": i.last_claimed_at, "notes": i.notes, "days_late": max(0, days_late),
        "claim_due": i.status in svc.OUTSTANDING_STATUSES,
        "item": {"id": i.item.id, "barcode": i.item.barcode, "status": i.item.status.value,
                 "call_number": i.item.call_number} if i.item else None,
        "grace_days": sub.grace_days,
    }


def _routing_out(sub: Subscription) -> list[dict]:
    return [{"patron_id": r.patron_id, "name": r.patron.full_name, "card_number": r.patron.card_number,
             "position": r.position, "notes": r.notes} for r in sub.routing]


def subscription_out(s: Subscription, *, next_issue: SerialIssue | None = None, counts: dict | None = None,
                     full: bool = False) -> dict:
    today = utcnow().date()
    out = {
        "id": s.id, "status": s.status.value,
        "biblio": {"id": s.biblio.id, "title": s.biblio.title, "issn": s.biblio.issn, "publisher": s.biblio.publisher},
        "vendor": {"id": s.vendor.id, "name": s.vendor.name} if s.vendor else None,
        "branch": {"id": s.branch.id, "name": s.branch.name, "code": s.branch.code},
        "budget": {"id": s.budget.id, "name": s.budget.name, "fiscal_year": s.budget.fiscal_year} if s.budget else None,
        "start_date": s.start_date, "end_date": s.end_date,
        "days_to_end": (s.end_date - today).days if s.end_date else None,
        "frequency": s.frequency, "frequency_interval": s.frequency_interval,
        "frequency_label": frequency_label(s.frequency, s.frequency_interval),
        "numbering_pattern": s.numbering_pattern, "grace_days": s.grace_days,
        "next_issue": {"id": next_issue.id, "enumeration": next_issue.enumeration,
                       "expected_on": next_issue.expected_on} if next_issue else None,
        "counts": counts or {},
    }
    if full:
        out.update(
            first_issue_on=s.first_issue_on, skip_weekdays=s.skip_weekdays or [], numbering=s.numbering or {},
            create_items=s.create_items, item_type_id=s.item_type_id,
            item_type={"id": s.item_type.id, "name": s.item_type.name} if s.item_type else None,
            shelf_location=s.shelf_location, call_number=s.call_number,
            price=money(s.price) if s.price is not None else None, vendor_reference=s.vendor_reference,
            notes=s.notes, cancelled_at=s.cancelled_at, created_at=s.created_at, updated_at=s.updated_at,
            routing=_routing_out(s),
        )
    return out


def _issues(db: Session, ids: list[int]) -> list[SerialIssue]:
    rows = {i.id: i for i in db.scalars(select(SerialIssue).where(SerialIssue.id.in_(ids)))}
    missing = [i for i in ids if i not in rows]
    if missing:
        raise NotFound(f"Issue(s) not found: {', '.join(map(str, missing[:10]))}")
    return [rows[i] for i in dict.fromkeys(ids)]


# ------------------------------------------------------------------ reference data & preview


@router.get("/meta")
def meta(_: Patron = Depends(require("serials:read"))):
    """Frequencies, statuses and numbering presets for building subscription forms."""
    return {
        "frequencies": [{"key": k, "label": v} for k, v in svc.FREQUENCY_LABELS.items()],
        "issue_statuses": [s.value for s in SerialIssueStatus],
        "subscription_statuses": [s.value for s in SubscriptionStatus],
        "presets": svc.PATTERN_PRESETS,
        "placeholders": list(svc.LEVELS) + list(svc.DATE_TOKENS),
        "default_horizon_days": svc.DEFAULT_HORIZON_DAYS,
    }


@router.post("/preview")
def preview(body: PreviewIn, _: Patron = Depends(require("serials:read"))):
    """Predict the next issues for an unsaved pattern (live preview in the subscription form). Read-only."""
    return svc.preview(_spec(body), count=body.count)


@router.get("/stats")
def stats(db: Session = Depends(get_db), _: Patron = Depends(require("serials:read"))):
    today = utcnow().date()
    count = lambda stmt: int(db.scalar(stmt) or 0)  # noqa: E731
    issues = select(func.count()).select_from(SerialIssue).join(Subscription)
    return {
        "active": count(select(func.count()).select_from(Subscription).where(
            Subscription.status == SubscriptionStatus.active)),
        "late": count(issues.where(SerialIssue.status == SerialIssueStatus.late,
                                   Subscription.status != SubscriptionStatus.cancelled)),
        "claimed": count(issues.where(SerialIssue.status == SerialIssueStatus.claimed,
                                      Subscription.status != SubscriptionStatus.cancelled)),
        "missing": count(issues.where(SerialIssue.status == SerialIssueStatus.missing,
                                      Subscription.status != SubscriptionStatus.cancelled)),
        "expected_week": count(issues.where(SerialIssue.status == SerialIssueStatus.expected,
                                            SerialIssue.expected_on <= today + timedelta(days=7),
                                            Subscription.status == SubscriptionStatus.active)),
        "received_30d": count(issues.where(SerialIssue.status == SerialIssueStatus.arrived,
                                           SerialIssue.received_on >= today - timedelta(days=30))),
        "expiring": len([s for s in svc.expiring(db, days=60, today=today) if s.status == SubscriptionStatus.active]),
    }


# ------------------------------------------------------------------ subscriptions


@router.get("/subscriptions")
def list_subscriptions(q: str | None = Query(default=None, max_length=200), status: str | None = Query(
        default=None, pattern="^(active|expired|cancelled)$"), vendor_id: int | None = None, branch_id: int | None = None,
        biblio_id: int | None = None, db: Session = Depends(get_db), _: Patron = Depends(require("serials:read"))):
    stmt = select(Subscription).join(Biblio)
    if status:
        stmt = stmt.where(Subscription.status == SubscriptionStatus(status))
    if vendor_id:
        stmt = stmt.where(Subscription.vendor_id == vendor_id)
    if branch_id:
        stmt = stmt.where(Subscription.branch_id == branch_id)
    if biblio_id:
        stmt = stmt.where(Subscription.biblio_id == biblio_id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Biblio.title.ilike(like), Biblio.issn == q.strip(),
                              Subscription.vendor_reference.ilike(like)))
    subs = db.scalars(stmt.order_by(Biblio.title, Subscription.id).limit(500)).unique().all()
    ids = [s.id for s in subs]
    nxt, counts = svc.next_expected(db, ids), svc.status_counts(db, ids)
    return {"total": len(subs), "results": [subscription_out(s, next_issue=nxt.get(s.id), counts=counts.get(s.id))
                                            for s in subs]}


def _resolve_biblio(db: Session, body: SubscriptionIn, user: Patron) -> Biblio:
    if body.new_biblio is not None:
        b = catalog.create_biblio(db, {**body.new_biblio.model_dump(), "material_type": "serial"})
        audit.record(db, "create", "biblio", b.id, actor=user, title=b.title, via="serials")
        return b
    if not body.biblio_id:
        raise PolicyBlocked("Choose the serial record this subscription is for")
    return catalog.get_biblio(db, body.biblio_id)


def _data(body: SubscriptionIn) -> dict:
    data = body.model_dump(exclude={"biblio_id", "new_biblio"})
    data["numbering"] = {k: v.model_dump() for k, v in body.numbering.items()}
    return data


@router.post("/subscriptions", status_code=201)
def create_subscription(body: SubscriptionIn, db: Session = Depends(get_db),
                        user: Patron = Depends(require("serials:write"))):
    biblio = _resolve_biblio(db, body, user)
    sub = svc.create_subscription(db, biblio, _data(body), actor=user)
    db.commit()
    return subscription_out(sub, next_issue=svc.next_expected(db, [sub.id]).get(sub.id),
                            counts=svc.status_counts(db, [sub.id])[sub.id], full=True)


@router.get("/subscriptions/{sub_id}")
def get_subscription(sub_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("serials:read"))):
    sub = svc.get_subscription(db, sub_id)
    return subscription_out(sub, next_issue=svc.next_expected(db, [sub.id]).get(sub.id),
                            counts=svc.status_counts(db, [sub.id])[sub.id], full=True)


@router.put("/subscriptions/{sub_id}")
def update_subscription(sub_id: int, body: SubscriptionIn, db: Session = Depends(get_db),
                        user: Patron = Depends(require("serials:write"))):
    sub = svc.get_subscription(db, sub_id)
    if body.biblio_id and body.biblio_id != sub.biblio_id:
        raise PolicyBlocked("A subscription cannot be moved to another record; create a new subscription instead")
    changed = svc.apply_subscription_data(db, sub, _data(body))
    stats = svc.generate_issues(db, sub) if changed else None
    audit.record(db, "update", "subscription", sub.id, actor=user, regenerated=stats)
    db.commit()
    return {**get_subscription(sub_id, db, user), "regenerated": stats}


@router.post("/subscriptions/{sub_id}/generate")
def generate(sub_id: int, body: GenerateIn, db: Session = Depends(get_db),
             user: Patron = Depends(require("serials:write"))):
    """(Re)generate predicted issues. Received, claimed, missing and manual issues are never changed."""
    sub = svc.get_subscription(db, sub_id)
    if sub.status != SubscriptionStatus.active:
        raise PolicyBlocked(f"Subscription is {sub.status.value}; renew it to predict more issues")
    if svc.step_of(sub.frequency, sub.frequency_interval) is None:
        raise PolicyBlocked("Irregular subscriptions are not predicted — add issues manually")
    stats = svc.generate_issues(db, sub, horizon_days=body.horizon_days)
    audit.record(db, "generate", "subscription", sub.id, actor=user, **stats)
    db.commit()
    return stats


@router.post("/subscriptions/{sub_id}/cancel")
def cancel(sub_id: int, body: CancelIn, db: Session = Depends(get_db),
           user: Patron = Depends(require("serials:write"))):
    sub = svc.get_subscription(db, sub_id)
    removed = svc.cancel_subscription(db, sub, actor=user, reason=body.reason)
    db.commit()
    return {"status": sub.status.value, "removed": removed}


@router.post("/subscriptions/{sub_id}/renew")
def renew(sub_id: int, body: RenewIn, db: Session = Depends(get_db), user: Patron = Depends(require("serials:write"))):
    sub = svc.get_subscription(db, sub_id)
    stats = svc.renew_subscription(db, sub, body.end_date, actor=user)
    db.commit()
    return {"status": sub.status.value, "end_date": sub.end_date, **stats}


@router.put("/subscriptions/{sub_id}/routing")
def routing(sub_id: int, body: RoutingIn, db: Session = Depends(get_db),
            user: Patron = Depends(require("serials:write"))):
    sub = svc.get_subscription(db, sub_id)
    svc.set_routing(db, sub, [e.model_dump() for e in body.entries], actor=user)
    db.commit()
    db.refresh(sub)
    return {"routing": _routing_out(sub)}


# ------------------------------------------------------------------ issues


@router.get("/subscriptions/{sub_id}/issues")
def list_issues(sub_id: int, status: str | None = Query(default=None, max_length=80), year: int | None = None,
                db: Session = Depends(get_db), _: Patron = Depends(require("serials:read"))):
    """Issues, newest expected first. ``status`` may be a comma-separated list or ``outstanding``."""
    svc.get_subscription(db, sub_id)
    stmt = select(SerialIssue).where(SerialIssue.subscription_id == sub_id)
    if status:
        wanted = ([s.value for s in svc.OUTSTANDING_STATUSES] if status == "outstanding"
                  else [s.strip() for s in status.split(",") if s.strip()])
        try:
            stmt = stmt.where(SerialIssue.status.in_([SerialIssueStatus(s) for s in wanted]))
        except ValueError as exc:
            raise PolicyBlocked(f"Unknown issue status in '{status}'") from exc
    if year:
        stmt = stmt.where(SerialIssue.expected_on >= date(year, 1, 1), SerialIssue.expected_on <= date(year, 12, 31))
    today = utcnow().date()
    rows = db.scalars(stmt.order_by(SerialIssue.expected_on.desc(), SerialIssue.id.desc()).limit(2000)).all()
    years = sorted({d.year for d in db.scalars(select(SerialIssue.expected_on).where(
        SerialIssue.subscription_id == sub_id))}, reverse=True)
    return {"results": [issue_out(i, today) for i in rows], "years": years}


@router.post("/subscriptions/{sub_id}/issues", status_code=201)
def add_issue(sub_id: int, body: ManualIssueIn, db: Session = Depends(get_db),
              user: Patron = Depends(require("serials:write"))):
    sub = svc.get_subscription(db, sub_id)
    if sub.status == SubscriptionStatus.cancelled:
        raise PolicyBlocked("Subscription is cancelled")
    issue = svc.add_manual_issue(db, sub, expected_on=body.expected_on, enumeration=body.enumeration,
                                 chronology_text=body.chronology, notes=body.notes, actor=user)
    db.commit()
    return issue_out(issue)


@router.delete("/issues/{issue_id}")
def delete_issue(issue_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("serials:write"))):
    svc.delete_manual_issue(db, svc.get_issue(db, issue_id), actor=user)
    db.commit()
    return {"ok": True}


@router.post("/issues/{issue_id}/receive")
def receive(issue_id: int, body: ReceiveIn, db: Session = Depends(get_db),
            user: Patron = Depends(require("serials:write"))):
    issue = svc.get_issue(db, issue_id)
    svc.receive_issue(db, issue, actor=user, **body.model_dump())
    db.commit()
    sub = issue.subscription
    return {"issue": issue_out(issue), "routing": _routing_out(sub)}


@router.post("/issues/receive")
def receive_many(body: BulkReceiveIn, db: Session = Depends(get_db), user: Patron = Depends(require("serials:write"))):
    """Bulk receive: every issue gets the same date; items get automatic barcodes."""
    issues = _issues(db, body.issue_ids)
    for issue in issues:
        svc.receive_issue(db, issue, received_on=body.received_on, create_item=body.create_item, actor=user)
    db.commit()
    return {"received": len(issues), "results": [issue_out(i) for i in issues]}


@router.post("/issues/{issue_id}/undo-receive")
def undo_receive(issue_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("serials:write"))):
    issue = svc.get_issue(db, issue_id)
    svc.undo_receive(db, issue, actor=user)
    db.commit()
    return issue_out(issue)


@router.post("/issues/status")
def set_status(body: StatusIn, db: Session = Depends(get_db), user: Patron = Depends(require("serials:write"))):
    """Mark issues missing / not published, or reopen them (``expected``)."""
    issues = _issues(db, body.issue_ids)
    target = SerialIssueStatus(body.status)
    for issue in issues:
        svc.set_issue_status(db, issue, target, actor=user, note=body.note)
    db.commit()
    return {"updated": len(issues), "results": [issue_out(i) for i in issues]}


# ------------------------------------------------------------------ late issues & claims


def _vendor_out(v: Vendor | None) -> dict:
    return ({"id": v.id, "name": v.name, "email": v.email, "phone": v.phone} if v
            else {"id": 0, "name": "No vendor", "email": None, "phone": None})


@router.get("/late")
def late(vendor_id: int | None = None, db: Session = Depends(get_db), _: Patron = Depends(require("serials:read"))):
    """Outstanding (late, claimed, missing) issues grouped by vendor."""
    today = utcnow().date()
    groups: dict[int, dict] = {}
    for issue in svc.late_issues(db, vendor_id=vendor_id, today=today):
        sub = issue.subscription
        g = groups.setdefault(sub.vendor_id or 0, {"vendor": _vendor_out(sub.vendor), "issues": []})
        g["issues"].append({**issue_out(issue, today), "title": sub.biblio.title, "issn": sub.biblio.issn,
                            "vendor_reference": sub.vendor_reference, "branch": sub.branch.name})
    out = sorted(groups.values(), key=lambda g: (g["vendor"]["id"] == 0, g["vendor"]["name"].lower()))
    return {"total": sum(len(g["issues"]) for g in out), "groups": out}


def _claim_out(c: SerialClaim) -> dict:
    sub = c.issue.subscription
    return {"id": c.id, "batch": c.batch, "claimed_at": c.claimed_at, "note": c.note,
            "by": c.claimed_by.full_name if c.claimed_by else None, "vendor": _vendor_out(c.vendor),
            "issue": {"id": c.issue.id, "enumeration": c.issue.enumeration, "chronology": c.issue.chronology,
                      "expected_on": c.issue.expected_on, "status": c.issue.status.value,
                      "claim_count": c.issue.claim_count},
            "subscription": {"id": sub.id, "title": sub.biblio.title, "issn": sub.biblio.issn,
                             "vendor_reference": sub.vendor_reference}}


@router.post("/claims", status_code=201)
def create_claims(body: ClaimIn, db: Session = Depends(get_db), user: Patron = Depends(require("serials:write"))):
    """Claim late/missing issues from their vendors. Returns a batch id for the printable claim letters."""
    issues = _issues(db, body.issue_ids)
    batch = svc.claim_issues(db, issues, actor=user, note=body.note)
    db.commit()
    vendors = {i.subscription.vendor_id or 0 for i in issues}
    return {"batch": batch, "claimed": len(issues), "vendors": len(vendors),
            "letter_url": f"/staff/serials/claims/{batch}"}


@router.get("/claims")
def claim_history(subscription_id: int | None = None, vendor_id: int | None = None, issue_id: int | None = None,
                  limit: int = Query(default=200, ge=1, le=1000), db: Session = Depends(get_db),
                  _: Patron = Depends(require("serials:read"))):
    stmt = select(SerialClaim).join(SerialIssue)
    if subscription_id:
        stmt = stmt.where(SerialIssue.subscription_id == subscription_id)
    if vendor_id:
        stmt = stmt.where(SerialClaim.vendor_id == vendor_id)
    if issue_id:
        stmt = stmt.where(SerialClaim.issue_id == issue_id)
    rows = db.scalars(stmt.order_by(SerialClaim.claimed_at.desc(), SerialClaim.id.desc()).limit(limit)).all()
    return {"results": [_claim_out(c) for c in rows]}


@router.get("/claims/batches/{batch}")
def claim_batch(batch: str, db: Session = Depends(get_db), _: Patron = Depends(require("serials:read"))):
    """Claim-letter data: one letter per vendor in the batch."""
    claims = db.scalars(select(SerialClaim).where(SerialClaim.batch == batch[:32]).order_by(SerialClaim.id)).all()
    if not claims:
        raise NotFound("Claim batch not found")
    letters: dict[int, dict] = {}
    for c in claims:
        sub = c.issue.subscription
        letter = letters.setdefault(c.vendor_id or 0, {
            "vendor": _vendor_out(c.vendor),
            "branch": {"name": sub.branch.name, "address": sub.branch.address, "email": sub.branch.email,
                       "phone": sub.branch.phone},
            "claims": []})
        letter["claims"].append(_claim_out(c))
    first = claims[0]
    return {"batch": batch, "claimed_at": first.claimed_at, "note": first.note,
            "by": first.claimed_by.full_name if first.claimed_by else None,
            "library_name": settings_svc.get(db, "library_name"),
            "letters": sorted(letters.values(), key=lambda g: g["vendor"]["name"].lower())}


@router.get("/expiring")
def expiring(days: int = Query(default=60, ge=1, le=730), db: Session = Depends(get_db),
             _: Patron = Depends(require("serials:read"))):
    """Renewal alerts: subscriptions ending within ``days`` (and those that lapsed in the last 30 days)."""
    subs = svc.expiring(db, days=days)
    return {"results": [subscription_out(s) for s in subs]}


# ------------------------------------------------------------------ public (OPAC)


@router.get("/public/biblios/{biblio_id}/issues")
def public_issues(biblio_id: int, limit: int = Query(default=12, ge=1, le=50), db: Session = Depends(get_db)):
    """Latest received issues of a serial for the public catalogue (no authentication)."""
    b = catalog.get_biblio(db, biblio_id)
    active = db.scalars(select(Subscription).where(Subscription.biblio_id == b.id,
                                                   Subscription.status == SubscriptionStatus.active)).all()
    nxt = svc.next_expected(db, [s.id for s in active])
    upcoming = min((i.expected_on for i in nxt.values()), default=None)
    return {
        "biblio_id": b.id, "subscribed": bool(active), "next_expected_on": upcoming,
        "frequency": frequency_label(active[0].frequency, active[0].frequency_interval) if active else None,
        "results": [{"enumeration": i.enumeration, "chronology": i.chronology, "received_on": i.received_on,
                     "branch": i.subscription.branch.name,
                     "status": i.item.status.value if i.item and i.item.deleted_at is None else None}
                    for i in svc.latest_received(db, b.id, limit=limit)],
    }
