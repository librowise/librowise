"""Circulation: checkout, check-in, renewals, fines and the holds queue.

All state transitions happen inside the caller's transaction; the partial unique index on
``loans(item_id) WHERE returned_at IS NULL`` makes double checkout impossible even under races.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..errors import Conflict, NotFound, PolicyBlocked
from ..models import (
    Biblio,
    Branch,
    CirculationRule,
    Hold,
    HoldStatus,
    Item,
    ItemStatus,
    LedgerEntry,
    LedgerKind,
    Loan,
    Notification,
    Patron,
    utcnow,
)
from . import audit

ACTIVE_HOLD_STATUSES = (HoldStatus.queued, HoldStatus.ready)

# ------------------------------------------------------------------ rules


@dataclass(frozen=True)
class EffectiveRule:
    loan_days: int = 14
    max_renewals: int = 2
    fine_per_day: int = 200
    fine_cap: int = 10000
    grace_days: int = 0
    hold_pickup_days: int = 7
    source_rule_id: int | None = None


def resolve_rule(db: Session, branch_id: int, category_id: int, item_type_id: int) -> EffectiveRule:
    """Most specific matching rule wins: item type (4) > patron category (2) > branch (1)."""
    rules = db.scalars(
        select(CirculationRule).where(
            (CirculationRule.branch_id == branch_id) | CirculationRule.branch_id.is_(None),
            (CirculationRule.category_id == category_id) | CirculationRule.category_id.is_(None),
            (CirculationRule.item_type_id == item_type_id) | CirculationRule.item_type_id.is_(None),
        )
    ).all()
    if not rules:
        return EffectiveRule()

    def specificity(r: CirculationRule) -> int:
        return (4 if r.item_type_id else 0) + (2 if r.category_id else 0) + (1 if r.branch_id else 0)

    r = max(rules, key=specificity)
    return EffectiveRule(
        loan_days=r.loan_days,
        max_renewals=r.max_renewals,
        fine_per_day=r.fine_per_day,
        fine_cap=r.fine_cap,
        grace_days=r.grace_days,
        hold_pickup_days=r.hold_pickup_days,
        source_rule_id=r.id,
    )


def end_of_day(d: date) -> datetime:
    return datetime.combine(d, time(23, 59, 0))


# ------------------------------------------------------------------ patron account


def balance(db: Session, patron_id: int) -> int:
    return int(
        db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(
            LedgerEntry.patron_id == patron_id
        ))
        or 0
    )


def open_loans(db: Session, patron_id: int) -> list[Loan]:
    return list(
        db.scalars(
            select(Loan)
            .where(Loan.patron_id == patron_id, Loan.returned_at.is_(None))
            .order_by(Loan.due_at)
        )
    )


def patron_blocks(db: Session, patron: Patron, *, today: date | None = None) -> list[str]:
    """Reasons a patron cannot borrow. Empty list = may borrow."""
    today = today or utcnow().date()
    reasons = []
    if not patron.is_active or patron.deleted_at is not None:
        reasons.append("Account is inactive")
    if patron.expires_on and patron.expires_on < today:
        reasons.append(f"Membership expired on {patron.expires_on.isoformat()}")
    owed = balance(db, patron.id)
    if owed >= patron.category.block_fine_threshold:
        reasons.append(f"Outstanding charges ({owed / 100:.2f}) exceed the limit")
    return reasons


def pay(db: Session, patron: Patron, amount: int, actor: Patron | None, note: str | None = None) -> int:
    if amount <= 0:
        raise PolicyBlocked("Payment amount must be positive")
    db.add(
        LedgerEntry(
            patron_id=patron.id,
            kind=LedgerKind.payment,
            amount=-amount,
            note=note or "Payment",
            created_by_id=actor.id if actor else None,
        )
    )
    audit.record(db, "payment", "patron", patron.id, actor=actor, amount=amount)
    db.flush()
    return balance(db, patron.id)


def waive(db: Session, patron: Patron, amount: int, actor: Patron, note: str) -> int:
    if amount <= 0:
        raise PolicyBlocked("Waiver amount must be positive")
    db.add(
        LedgerEntry(
            patron_id=patron.id, kind=LedgerKind.waiver, amount=-amount, note=note,
            created_by_id=actor.id,
        )
    )
    audit.record(db, "waive", "patron", patron.id, actor=actor, amount=amount, note=note)
    db.flush()
    return balance(db, patron.id)


def charge(db: Session, patron: Patron, amount: int, actor: Patron, note: str) -> int:
    db.add(
        LedgerEntry(
            patron_id=patron.id, kind=LedgerKind.manual, amount=amount, note=note,
            created_by_id=actor.id,
        )
    )
    audit.record(db, "charge", "patron", patron.id, actor=actor, amount=amount, note=note)
    db.flush()
    return balance(db, patron.id)


# ------------------------------------------------------------------ checkout


@dataclass
class CheckoutResult:
    loan: Loan
    warnings: list[str] = field(default_factory=list)


def checkout(
    db: Session,
    patron: Patron,
    item: Item,
    *,
    branch_id: int,
    actor: Patron | None = None,
    override: bool = False,
    now: datetime | None = None,
    due_at: datetime | None = None,
) -> CheckoutResult:
    now = now or utcnow()
    warnings: list[str] = []
    blocks = patron_blocks(db, patron, today=now.date())

    if item.deleted_at is not None or item.status in (ItemStatus.withdrawn,):
        raise Conflict("Item has been withdrawn from circulation")
    if item.status == ItemStatus.on_loan:
        current = db.scalar(select(Loan).where(Loan.item_id == item.id, Loan.returned_at.is_(None)))
        if current and current.patron_id == patron.id:
            raise Conflict("Item is already on loan to this patron — renew it instead", code="already_on_loan")
        raise Conflict("Item is on loan to another patron — check it in first", code="on_loan")
    if item.status in (ItemStatus.lost, ItemStatus.damaged, ItemStatus.processing, ItemStatus.in_transit):
        blocks.append(f"Item status is '{item.status.value}'")

    # Holds: an item waiting on the hold shelf is reserved for exactly one patron.
    ready_hold = db.scalar(
        select(Hold).where(Hold.item_id == item.id, Hold.status == HoldStatus.ready)
    )
    if ready_hold and ready_hold.patron_id != patron.id:
        blocks.append("Item is waiting on the hold shelf for another patron")
    queued_others = db.scalar(
        select(func.count()).select_from(Hold).where(
            Hold.biblio_id == item.biblio_id,
            Hold.status == HoldStatus.queued,
            Hold.patron_id != patron.id,
        )
    )
    if queued_others and not ready_hold:
        warnings.append(f"{queued_others} other patron(s) have holds on this title")

    loans_now = len(open_loans(db, patron.id))
    if loans_now >= patron.category.max_loans:
        blocks.append(f"Loan limit reached ({patron.category.max_loans})")

    if blocks and not override:
        raise PolicyBlocked("; ".join(blocks), code="checkout_blocked", details={"reasons": blocks})
    if blocks:
        warnings.extend(f"Overridden: {b}" for b in blocks)

    rule = resolve_rule(db, branch_id, patron.category_id, item.item_type_id)
    due = due_at or end_of_day((now + timedelta(days=rule.loan_days)).date())
    if patron.expires_on and due.date() > patron.expires_on:
        due = end_of_day(patron.expires_on)
        warnings.append("Due date shortened to membership expiry")

    loan = Loan(
        item_id=item.id,
        patron_id=patron.id,
        branch_id=branch_id,
        issued_at=now,
        due_at=due,
        issued_by_id=actor.id if actor else None,
    )
    db.add(loan)
    item.status = ItemStatus.on_loan
    item.times_borrowed = (item.times_borrowed or 0) + 1
    item.last_seen_at = now
    for hold in db.scalars(
        select(Hold).where(
            Hold.patron_id == patron.id,
            Hold.biblio_id == item.biblio_id,
            Hold.status.in_(ACTIVE_HOLD_STATUSES),
        )
    ):
        hold.status = HoldStatus.fulfilled
        hold.item = item
    try:
        db.flush()
    except IntegrityError as exc:  # concurrent checkout of the same item
        db.rollback()
        raise Conflict("Item was just checked out by another transaction") from exc
    audit.record(db, "checkout", "loan", loan.id, actor=actor, item=item.barcode,
                 patron=patron.card_number, override=override or None)
    return CheckoutResult(loan=loan, warnings=warnings)


# ------------------------------------------------------------------ check-in


@dataclass
class CheckinResult:
    item: Item
    loan: Loan | None = None
    fine: int = 0
    hold: Hold | None = None
    messages: list[str] = field(default_factory=list)


def overdue_fine(loan: Loan, rule: EffectiveRule, when: datetime) -> int:
    days_late = (when.date() - loan.due_at.date()).days
    if days_late <= rule.grace_days:
        return 0
    return min(days_late * rule.fine_per_day, rule.fine_cap)


def checkin(
    db: Session,
    item: Item,
    *,
    branch_id: int,
    actor: Patron | None = None,
    now: datetime | None = None,
) -> CheckinResult:
    now = now or utcnow()
    result = CheckinResult(item=item)
    loan = db.scalar(select(Loan).where(Loan.item_id == item.id, Loan.returned_at.is_(None)))
    if loan is not None:
        patron = db.get(Patron, loan.patron_id) if loan.patron_id else None
        if patron:
            rule = resolve_rule(db, loan.branch_id, patron.category_id, item.item_type_id)
            fine = overdue_fine(loan, rule, now) - loan.fine_charged
            if fine > 0:
                db.add(LedgerEntry(patron_id=patron.id, loan_id=loan.id, kind=LedgerKind.overdue,
                                   amount=fine, note=f"Overdue: {item.biblio.title[:120]}",
                                   created_by_id=actor.id if actor else None))
                loan.fine_charged += fine
                result.fine = fine
                result.messages.append(f"Overdue fine charged: {fine / 100:.2f}")
            if not patron.keep_history:
                loan.patron_id = None  # privacy: patron opted out of reading history
        loan.returned_at = now
        result.loan = loan
    elif item.status == ItemStatus.lost:
        result.messages.append("Lost item found and returned to circulation")
    elif item.status == ItemStatus.on_hold_shelf:
        result.messages.append("Item is already on the hold shelf")
        result.hold = db.scalar(select(Hold).where(Hold.item_id == item.id, Hold.status == HoldStatus.ready))
        return result

    item.last_seen_at = now
    result.hold = _route_to_next_hold(db, item, branch_id=branch_id, now=now)
    if result.hold:
        where = result.hold.pickup_branch.name
        if result.hold.pickup_branch_id == branch_id:
            result.messages.append(f"Hold found — place on hold shelf for {result.hold.patron.full_name}")
        else:
            result.messages.append(f"Hold found — transfer to {where} for {result.hold.patron.full_name}")
    else:
        item.status = ItemStatus.available
        if item.branch_id != branch_id:
            home = db.get(Branch, item.branch_id)
            result.messages.append(f"Return item to its home branch: {home.name if home else item.branch_id}")
    db.flush()
    audit.record(db, "checkin", "item", item.id, actor=actor, barcode=item.barcode,
                 fine=result.fine or None, hold=result.hold.id if result.hold else None)
    return result


def _route_to_next_hold(db: Session, item: Item, *, branch_id: int, now: datetime) -> Hold | None:
    if not item.item_type.holdable:
        return None
    hold = db.scalar(
        select(Hold)
        .where(
            Hold.biblio_id == item.biblio_id,
            Hold.status == HoldStatus.queued,
            (Hold.item_id.is_(None)) | (Hold.item_id == item.id),
        )
        .order_by(Hold.created_at, Hold.id)
        .limit(1)
    )
    if hold is None:
        return None
    rule = resolve_rule(db, hold.pickup_branch_id, hold.patron.category_id, item.item_type_id)
    hold.item = item  # assign the relationship (not just the FK) so loaded objects stay consistent
    if hold.pickup_branch_id == branch_id:
        hold.status = HoldStatus.ready
        hold.ready_at = now
        hold.expires_at = end_of_day((now + timedelta(days=rule.hold_pickup_days)).date())
        item.status = ItemStatus.on_hold_shelf
        notify(db, hold.patron, "Your hold is ready for pickup",
               f"'{item.biblio.title}' is waiting for you at {hold.pickup_branch.name} until "
               f"{hold.expires_at:%d %b %Y}.")
    else:
        item.status = ItemStatus.in_transit
    return hold


def receive_transfer(db: Session, item: Item, *, branch_id: int, actor: Patron | None = None,
                     now: datetime | None = None) -> CheckinResult:
    """Item arrives at a branch while in transit — completes routing to its hold."""
    now = now or utcnow()
    if item.status != ItemStatus.in_transit:
        raise Conflict("Item is not in transit")
    hold = db.scalar(select(Hold).where(Hold.item_id == item.id, Hold.status == HoldStatus.queued))
    result = CheckinResult(item=item)
    if hold and hold.pickup_branch_id == branch_id:
        rule = resolve_rule(db, branch_id, hold.patron.category_id, item.item_type_id)
        hold.status = HoldStatus.ready
        hold.ready_at = now
        hold.expires_at = end_of_day((now + timedelta(days=rule.hold_pickup_days)).date())
        item.status = ItemStatus.on_hold_shelf
        result.hold = hold
        result.messages.append(f"Place on hold shelf for {hold.patron.full_name}")
        notify(db, hold.patron, "Your hold is ready for pickup",
               f"'{item.biblio.title}' is waiting for you at {hold.pickup_branch.name}.")
    else:
        item.status = ItemStatus.available
        result.messages.append("Item received and available")
    audit.record(db, "transfer_received", "item", item.id, actor=actor)
    db.flush()
    return result


# ------------------------------------------------------------------ renewals


def renewal_blocks(db: Session, loan: Loan, *, now: datetime | None = None) -> list[str]:
    now = now or utcnow()
    reasons = []
    if loan.returned_at is not None:
        return ["Loan is already closed"]
    patron = db.get(Patron, loan.patron_id) if loan.patron_id else None
    if patron is None:
        return ["Loan has no patron"]
    rule = resolve_rule(db, loan.branch_id, patron.category_id, loan.item.item_type_id)
    if loan.renewals >= rule.max_renewals:
        reasons.append(f"Renewal limit reached ({rule.max_renewals})")
    queued = db.scalar(
        select(func.count()).select_from(Hold).where(
            Hold.biblio_id == loan.item.biblio_id,
            Hold.status == HoldStatus.queued,
            Hold.patron_id != patron.id,
        )
    )
    if queued:
        reasons.append("Another patron is waiting for this title")
    reasons.extend(patron_blocks(db, patron, today=now.date()))
    return reasons


def renew(db: Session, loan: Loan, *, actor: Patron | None = None, override: bool = False,
          now: datetime | None = None) -> Loan:
    now = now or utcnow()
    blocks = renewal_blocks(db, loan, now=now)
    if blocks and not override:
        raise PolicyBlocked("; ".join(blocks), code="renewal_blocked", details={"reasons": blocks})
    patron = db.get(Patron, loan.patron_id)
    assert patron is not None
    rule = resolve_rule(db, loan.branch_id, patron.category_id, loan.item.item_type_id)
    # Charge any fine accrued so far before moving the due date.
    fine = overdue_fine(loan, rule, now) - loan.fine_charged
    if fine > 0:
        db.add(LedgerEntry(patron_id=patron.id, loan_id=loan.id, kind=LedgerKind.overdue,
                           amount=fine, note=f"Overdue at renewal: {loan.item.biblio.title[:100]}"))
        loan.fine_charged += fine
    base = max(now, loan.due_at) if loan.due_at > now else now
    new_due = end_of_day((base + timedelta(days=rule.loan_days)).date())
    if patron.expires_on and new_due.date() > patron.expires_on:
        new_due = end_of_day(patron.expires_on)
    loan.due_at = new_due
    loan.renewals += 1
    db.flush()
    audit.record(db, "renew", "loan", loan.id, actor=actor, due=new_due.isoformat())
    return loan


def mark_lost(db: Session, loan: Loan, *, actor: Patron) -> int:
    item = loan.item
    cost = item.price or item.item_type.replacement_cost
    if loan.patron_id:
        db.add(LedgerEntry(patron_id=loan.patron_id, loan_id=loan.id, kind=LedgerKind.lost,
                           amount=cost, note=f"Lost: {item.biblio.title[:120]}", created_by_id=actor.id))
    loan.returned_at = utcnow()
    item.status = ItemStatus.lost
    audit.record(db, "mark_lost", "item", item.id, actor=actor, charged=cost)
    db.flush()
    return cost


# ------------------------------------------------------------------ holds


def hold_queue_position(db: Session, hold: Hold) -> int | None:
    if hold.status != HoldStatus.queued:
        return None
    return 1 + (db.scalar(
        select(func.count()).select_from(Hold).where(
            Hold.biblio_id == hold.biblio_id,
            Hold.status == HoldStatus.queued,
            (Hold.created_at < hold.created_at)
            | ((Hold.created_at == hold.created_at) & (Hold.id < hold.id)),
        )
    ) or 0)


def place_hold(db: Session, patron: Patron, biblio: Biblio, *, pickup_branch_id: int,
               actor: Patron | None = None, override: bool = False, notes: str | None = None) -> Hold:
    blocks = patron_blocks(db, patron)
    if biblio.deleted_at is not None:
        raise NotFound("Record not found")
    holdable = [i for i in biblio.items if i.deleted_at is None and i.item_type.holdable
                and i.status not in (ItemStatus.withdrawn, ItemStatus.lost)]
    if not holdable:
        raise PolicyBlocked("This title has no holdable copies")
    existing = db.scalar(select(Hold).where(
        Hold.patron_id == patron.id, Hold.biblio_id == biblio.id,
        Hold.status.in_(ACTIVE_HOLD_STATUSES)))
    if existing:
        raise Conflict("You already have a hold on this title")
    on_loan_to_patron = db.scalar(
        select(func.count()).select_from(Loan).join(Item).where(
            Loan.patron_id == patron.id, Loan.returned_at.is_(None), Item.biblio_id == biblio.id))
    if on_loan_to_patron:
        blocks.append("You already have this title on loan")
    active = db.scalar(select(func.count()).select_from(Hold).where(
        Hold.patron_id == patron.id, Hold.status.in_(ACTIVE_HOLD_STATUSES))) or 0
    if active >= patron.category.max_holds:
        blocks.append(f"Hold limit reached ({patron.category.max_holds})")
    if blocks and not override:
        raise PolicyBlocked("; ".join(blocks), code="hold_blocked", details={"reasons": blocks})
    hold = Hold(biblio_id=biblio.id, patron_id=patron.id, pickup_branch_id=pickup_branch_id,
                notes=notes, created_at=utcnow())
    db.add(hold)
    db.flush()
    audit.record(db, "place_hold", "hold", hold.id, actor=actor or patron, biblio=biblio.id)
    return hold


def cancel_hold(db: Session, hold: Hold, *, actor: Patron | None = None,
                now: datetime | None = None, status: HoldStatus = HoldStatus.cancelled) -> None:
    if hold.status not in ACTIVE_HOLD_STATUSES:
        raise Conflict("Hold is not active")
    was_ready = hold.status == HoldStatus.ready
    hold.status = status
    item = db.get(Item, hold.item_id) if hold.item_id else None
    if item is not None and (was_ready or item.status == ItemStatus.in_transit):
        db.flush()
        nxt = _route_to_next_hold(db, item, branch_id=hold.pickup_branch_id, now=now or utcnow())
        if nxt is None:
            item.status = ItemStatus.available
    db.flush()
    audit.record(db, f"hold_{status.value}", "hold", hold.id, actor=actor)


def holds_to_pull(db: Session, branch_id: int | None = None) -> list[dict]:
    """Queued holds that could be filled right now from an available copy on the shelf."""
    holds = db.scalars(select(Hold).where(Hold.status == HoldStatus.queued).order_by(Hold.created_at))
    out, claimed = [], set()
    for h in holds:
        candidates = [i for i in h.biblio.items
                      if i.status == ItemStatus.available and i.deleted_at is None
                      and i.id not in claimed and (branch_id is None or i.branch_id == branch_id)]
        if candidates:
            item = sorted(candidates, key=lambda i: i.branch_id != h.pickup_branch_id)[0]
            claimed.add(item.id)
            out.append({"hold": h, "item": item})
    return out


# ------------------------------------------------------------------ notices & nightly jobs


def notify(db: Session, patron: Patron, subject: str, body: str) -> None:
    db.add(Notification(patron_id=patron.id, subject=subject, body=body))


def run_nightly(db: Session, *, now: datetime | None = None) -> dict:
    """Overdue/courtesy notices, hold expiry, accrued fines and privacy anonymisation."""
    from . import settings as settings_svc

    now = now or utcnow()
    stats = {"courtesy": 0, "overdue": 0, "holds_expired": 0, "anonymized": 0, "auto_renewed": 0}
    tomorrow = now.date() + timedelta(days=1)
    for loan in db.scalars(select(Loan).where(Loan.returned_at.is_(None))):
        if not loan.patron:
            continue
        if loan.due_at.date() == tomorrow:
            if settings_svc.get(db, "auto_renew_when_no_holds") and not renewal_blocks(db, loan, now=now):
                renew(db, loan, now=now)
                stats["auto_renewed"] += 1
                continue
            notify(db, loan.patron, "Due tomorrow", f"'{loan.item.biblio.title}' is due tomorrow.")
            stats["courtesy"] += 1
        elif loan.due_at < now and (now.date() - loan.due_at.date()).days in (1, 7, 14):
            notify(db, loan.patron, "Overdue item",
                   f"'{loan.item.biblio.title}' was due on {loan.due_at:%d %b %Y}. Please return it.")
            stats["overdue"] += 1
    for hold in db.scalars(select(Hold).where(Hold.status == HoldStatus.ready, Hold.expires_at < now)):
        cancel_hold(db, hold, now=now, status=HoldStatus.expired)
        stats["holds_expired"] += 1
    days = int(settings_svc.get(db, "anonymize_history_after_days") or 0)
    if days:
        cutoff = now - timedelta(days=days)
        for loan in db.scalars(select(Loan).where(Loan.returned_at < cutoff, Loan.patron_id.is_not(None))):
            loan.patron_id = None
            stats["anonymized"] += 1
    db.flush()
    stats.update(run_nightly_hooks(db, now))
    return stats


# Nightly jobs contributed by other modules, as "module:function" paths resolved lazily (no import-time
# coupling). Each hook is called as ``fn(db, now) -> dict`` inside a SAVEPOINT; a failing hook is logged
# and rolled back without aborting the rest of the nightly run. Append new hooks here.
NIGHTLY_HOOKS: list[str] = [
    "shelfwise.services.serials:nightly",  # serials: expire subscriptions, top up predictions, flag late issues
]


def run_nightly_hooks(db: Session, now: datetime) -> dict:
    import importlib
    import logging

    stats: dict = {}
    for path in NIGHTLY_HOOKS:
        module_name, _, func_name = path.partition(":")
        try:
            fn = getattr(importlib.import_module(module_name), func_name)
            with db.begin_nested():
                stats.update(fn(db, now) or {})
        except Exception:  # one broken hook must not stop the circulation jobs
            logging.getLogger("shelfwise.nightly").exception("Nightly hook %s failed", path)
            stats[f"failed:{path}"] = 1
    return stats
