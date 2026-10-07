"""Library analytics: aggregate queries behind the staff Analytics page and dashboard.

Every query aggregates in SQL and is portable across SQLite and PostgreSQL: the only
dialect-specific pieces (shifting UTC timestamps into library-local time and truncating them to
day/week/month buckets) are isolated in :func:`local_time` and :func:`bucket_expr`. Constants inside
those expressions are server-controlled integers rendered as literals, so GROUP BY works on both
dialects. Results are bounded (top-N lists, fixed-size matrices, one row per time bucket).

Timestamps are stored as naive UTC; date ranges are *library-local* calendar dates, using the
UTC offset of the configured ``SHELFWISE_TIMEZONE``.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from functools import lru_cache

from sqlalchemy import and_, case, distinct, exists, extract, func, literal_column, or_, select, text
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import (
    AuditLog,
    Biblio,
    Branch,
    Budget,
    Hold,
    HoldStatus,
    Item,
    ItemStatus,
    ItemType,
    LedgerEntry,
    LedgerKind,
    Loan,
    Notification,
    OrderStatus,
    Patron,
    PatronCategory,
    PurchaseOrder,
    Role,
    utcnow,
)

GRANULARITIES = ("day", "week", "month")
MAX_RANGE_DAYS = 3 * 366
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
CHARGE_KINDS = (LedgerKind.overdue, LedgerKind.lost, LedgerKind.manual)
INACTIVE_ITEM = (ItemStatus.withdrawn,)


# ------------------------------------------------------------------ time handling


@lru_cache
def _zone_offset_minutes(tz_name: str, day: date) -> int:
    try:
        from zoneinfo import ZoneInfo

        off = ZoneInfo(tz_name).utcoffset(datetime.combine(day, time(12)))
        return int(off.total_seconds() // 60) if off is not None else 0
    except Exception:  # unknown zone or no tz database: fall back to UTC
        return 0


def local_offset_minutes(day: date | None = None) -> int:
    """UTC offset (minutes) of the library's timezone on ``day`` (default: today)."""
    return _zone_offset_minutes(get_settings().timezone, day or utcnow().date())


def local_today() -> date:
    return (utcnow() + timedelta(minutes=local_offset_minutes())).date()


@dataclass(frozen=True)
class Window:
    """An inclusive range of library-local dates plus the filters every panel shares."""

    start: date
    end: date
    granularity: str = "day"
    branch_id: int | None = None
    offset_minutes: int = 0

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def start_utc(self) -> datetime:
        return datetime.combine(self.start, time()) - timedelta(minutes=self.offset_minutes)

    @property
    def end_utc(self) -> datetime:
        """Exclusive upper bound."""
        return datetime.combine(self.end + timedelta(days=1), time()) - timedelta(minutes=self.offset_minutes)

    def previous(self) -> Window:
        prev_end = self.start - timedelta(days=1)
        return Window(prev_end - timedelta(days=self.days - 1), prev_end, self.granularity, self.branch_id,
                      self.offset_minutes)

    def bucket_keys(self) -> list[str]:
        out: list[str] = []
        if self.granularity == "day":
            d = self.start
            while d <= self.end:
                out.append(d.isoformat())
                d += timedelta(days=1)
        elif self.granularity == "week":
            d = self.start - timedelta(days=self.start.weekday())
            while d <= self.end:
                out.append(d.isoformat())
                d += timedelta(days=7)
        else:
            d = self.start.replace(day=1)
            while d <= self.end:
                out.append(d.isoformat())
                d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
        return out


def make_window(start: date | None, end: date | None, granularity: str = "day",
                branch_id: int | None = None) -> Window:
    today = local_today()
    end = end or today
    start = start or end - timedelta(days=29)
    if start > end:
        raise ValueError("start must be on or before end")
    if (end - start).days + 1 > MAX_RANGE_DAYS:
        raise ValueError(f"date range is limited to {MAX_RANGE_DAYS} days")
    if granularity not in GRANULARITIES:
        raise ValueError("granularity must be day, week or month")
    return Window(start, end, granularity, branch_id, local_offset_minutes(end))


def _dialect(db: Session) -> str:
    return db.get_bind().dialect.name


def local_time(db: Session, col, minutes: int):
    """SQL expression converting a naive-UTC timestamp column to library-local time."""
    minutes = int(minutes)
    if not minutes:
        return col
    if _dialect(db) == "sqlite":
        return func.datetime(col, literal_column(f"'{minutes:+d} minutes'"))
    return col + literal_column(f"INTERVAL '{minutes} minutes'")


def bucket_expr(db: Session, col, w: Window):
    """SQL expression yielding the ISO date (YYYY-MM-DD) of the bucket a timestamp falls in."""
    local = local_time(db, col, w.offset_minutes)
    if _dialect(db) == "sqlite":
        if w.granularity == "day":
            return func.date(local)
        if w.granularity == "week":  # Monday of the ISO week
            return func.date(local, literal_column("'weekday 0'"), literal_column("'-6 days'"))
        return func.strftime(literal_column("'%Y-%m-01'"), local)
    return func.to_char(func.date_trunc(literal_column(f"'{w.granularity}'"), local), literal_column("'YYYY-MM-DD'"))


def _series(db: Session, w: Window, col, *where, joins=(), value=None) -> dict[str, float]:
    """``{bucket: aggregate}`` for rows whose ``col`` lies inside the window."""
    b = bucket_expr(db, col, w).label("bkt")
    stmt = select(b, value if value is not None else func.count())
    for target, on in joins:
        stmt = stmt.join(target, on)
    stmt = stmt.where(col >= w.start_utc, col < w.end_utc, *where).group_by(text("bkt"))
    return {str(k)[:10]: v or 0 for k, v in db.execute(stmt).all()}


def _align(w: Window, counts: dict[str, float]) -> list[float]:
    return [counts.get(k, 0) for k in w.bucket_keys()]


def _table(headers: list[str], rows: list[list]) -> dict:
    return {"headers": headers, "rows": rows}


def _money(v) -> float:
    return round((v or 0) / 100, 2)


def _branch_loans(w: Window):
    return [Loan.branch_id == w.branch_id] if w.branch_id else []


# ------------------------------------------------------------------ shared counters


def count_checkouts(db: Session, w: Window) -> int:
    return db.scalar(select(func.count()).select_from(Loan).where(
        Loan.issued_at >= w.start_utc, Loan.issued_at < w.end_utc, *_branch_loans(w))) or 0


def count_returns(db: Session, w: Window) -> int:
    return db.scalar(select(func.count()).select_from(Loan).where(
        Loan.returned_at >= w.start_utc, Loan.returned_at < w.end_utc, *_branch_loans(w))) or 0


def _renewal_filter(w: Window):
    return [AuditLog.action == "renew", AuditLog.entity == "loan", *_branch_loans(w)]


def count_renewals(db: Session, w: Window) -> int:
    return db.scalar(select(func.count()).select_from(AuditLog).join(Loan, Loan.id == AuditLog.entity_id).where(
        AuditLog.at >= w.start_utc, AuditLog.at < w.end_utc, *_renewal_filter(w))) or 0


def count_active_patrons(db: Session, w: Window) -> int:
    return db.scalar(select(func.count(distinct(Loan.patron_id))).where(
        Loan.issued_at >= w.start_utc, Loan.issued_at < w.end_utc, Loan.patron_id.is_not(None), *_branch_loans(w))) or 0


def _patron_filter(w: Window):
    out = [Patron.deleted_at.is_(None), Patron.role == Role.patron]
    if w.branch_id:
        out.append(Patron.home_branch_id == w.branch_id)
    return out


def count_new_patrons(db: Session, w: Window) -> int:
    return db.scalar(select(func.count()).select_from(Patron).where(
        Patron.created_at >= w.start_utc, Patron.created_at < w.end_utc, *_patron_filter(w))) or 0


def count_holds_placed(db: Session, w: Window) -> int:
    where = [Hold.created_at >= w.start_utc, Hold.created_at < w.end_utc]
    if w.branch_id:
        where.append(Hold.pickup_branch_id == w.branch_id)
    return db.scalar(select(func.count()).select_from(Hold).where(*where)) or 0


def _ledger_sums(db: Session, w: Window) -> dict[str, int]:
    stmt = select(LedgerEntry.kind, func.sum(LedgerEntry.amount)).where(
        LedgerEntry.created_at >= w.start_utc, LedgerEntry.created_at < w.end_utc)
    if w.branch_id:
        stmt = stmt.join(Patron, Patron.id == LedgerEntry.patron_id).where(Patron.home_branch_id == w.branch_id)
    sums = {k: int(v or 0) for k, v in db.execute(stmt.group_by(LedgerEntry.kind)).all()}
    return {"charged": sum(sums.get(k, 0) for k in CHARGE_KINDS),
            "paid": -sums.get(LedgerKind.payment, 0), "waived": -sums.get(LedgerKind.waiver, 0)}


def _with_previous(fn, db: Session, w: Window) -> dict:
    return {"value": fn(db, w), "previous": fn(db, w.previous())}


# ------------------------------------------------------------------ panels


def overview(db: Session, w: Window) -> dict:
    spark = _align(w, _series(db, w, Loan.issued_at, *_branch_loans(w)))
    fines, prev_fines = _ledger_sums(db, w), _ledger_sums(db, w.previous())
    kpis = {
        "checkouts": {**_with_previous(count_checkouts, db, w), "spark": spark},
        "returns": _with_previous(count_returns, db, w),
        "renewals": _with_previous(count_renewals, db, w),
        "active_patrons": _with_previous(count_active_patrons, db, w),
        "new_patrons": _with_previous(count_new_patrons, db, w),
        "holds_placed": _with_previous(count_holds_placed, db, w),
        "fines_charged": {"value": _money(fines["charged"]), "previous": _money(prev_fines["charged"]), "money": True},
        "fines_paid": {"value": _money(fines["paid"]), "previous": _money(prev_fines["paid"]), "money": True},
    }
    return {"kpis": kpis, "table": _table(["Metric", "This period", "Previous period"],
                                          [[k.replace("_", " ").capitalize(), v["value"], v["previous"]] for k, v in kpis.items()])}


def circulation(db: Session, w: Window) -> dict:
    prev = w.previous()
    checkouts = _align(w, _series(db, w, Loan.issued_at, *_branch_loans(w)))
    previous = _align(prev, _series(db, prev, Loan.issued_at, *_branch_loans(prev)))
    previous = (previous + [None] * len(checkouts))[: len(checkouts)]
    returns = _align(w, _series(db, w, Loan.returned_at, *_branch_loans(w)))
    renewals = _align(w, _series(db, w, AuditLog.at, *_renewal_filter(w), joins=[(Loan, Loan.id == AuditLog.entity_id)]))
    labels = w.bucket_keys()
    return {
        "labels": labels, "checkouts": checkouts, "previous_checkouts": previous, "returns": returns, "renewals": renewals,
        "previous_labels": prev.bucket_keys(),
        "totals": {"checkouts": sum(checkouts), "returns": sum(returns), "renewals": sum(renewals),
                   "previous_checkouts": sum(v or 0 for v in previous)},
        "table": _table(["Period", "Checkouts", "Previous period checkouts", "Returns", "Renewals"],
                        [[labels[i], checkouts[i], previous[i] if previous[i] is not None else "", returns[i], renewals[i]]
                         for i in range(len(labels))]),
    }


def heatmap(db: Session, w: Window) -> dict:
    local = local_time(db, Loan.issued_at, w.offset_minutes)
    dow, hour = extract("dow", local).label("dow"), extract("hour", local).label("hr")
    rows = db.execute(select(dow, hour, func.count()).where(
        Loan.issued_at >= w.start_utc, Loan.issued_at < w.end_utc, *_branch_loans(w)).group_by(text("dow"), text("hr"))).all()
    matrix = [[0] * 24 for _ in range(7)]
    for d, h, n in rows:
        matrix[(int(d) + 6) % 7][int(h)] += n  # SQL dow: 0 = Sunday → row 6
    busiest = max(((matrix[r][c], r, c) for r in range(7) for c in range(24)), default=(0, 0, 0))
    return {"rows": list(WEEKDAYS), "cols": list(range(24)), "values": matrix,
            "busiest": {"day": WEEKDAYS[busiest[1]], "hour": busiest[2], "count": busiest[0]} if busiest[0] else None,
            "table": _table(["Day", *[f"{h:02d}:00" for h in range(24)]], [[WEEKDAYS[r], *matrix[r]] for r in range(7)])}


def _item_filter(w: Window):
    out = [Item.deleted_at.is_(None), Item.status.not_in(INACTIVE_ITEM)]
    if w.branch_id:
        out.append(Item.branch_id == w.branch_id)
    return out


def _loans_in(w: Window):
    return [Loan.issued_at >= w.start_utc, Loan.issued_at < w.end_utc]


def turnover(db: Session, w: Window) -> dict:
    items_by_type = dict(db.execute(select(ItemType.name, func.count(Item.id)).join(Item, Item.item_type_id == ItemType.id)
                                    .where(*_item_filter(w)).group_by(ItemType.name)).all())
    loans_by_type = dict(db.execute(select(ItemType.name, func.count(Loan.id)).join(Item, Item.item_type_id == ItemType.id)
                                    .join(Loan, Loan.item_id == Item.id).where(*_loans_in(w), *_item_filter(w))
                                    .group_by(ItemType.name)).all())
    by_type = sorted(({"label": t, "items": n, "loans": loans_by_type.get(t, 0),
                       "turnover": round(loans_by_type.get(t, 0) / n, 3) if n else 0} for t, n in items_by_type.items()),
                     key=lambda r: -r["turnover"])
    # Subjects are JSON arrays: aggregate per biblio in SQL, then roll up to top-level subjects.
    items_by_biblio = dict(db.execute(select(Item.biblio_id, func.count()).where(*_item_filter(w)).group_by(Item.biblio_id)).all())
    loans_by_biblio = dict(db.execute(select(Item.biblio_id, func.count(Loan.id)).join(Loan, Loan.item_id == Item.id)
                                      .where(*_loans_in(w), *_item_filter(w)).group_by(Item.biblio_id)).all())
    subj_items: Counter = Counter()
    subj_loans: Counter = Counter()
    for bid, subjects in db.execute(select(Biblio.id, Biblio.subjects).where(Biblio.id.in_(select(Item.biblio_id).where(*_item_filter(w))),
                                                                              Biblio.deleted_at.is_(None))):
        for s in {x.split(" -- ")[0].strip() for x in (subjects or []) if x}:
            subj_items[s] += items_by_biblio.get(bid, 0)
            subj_loans[s] += loans_by_biblio.get(bid, 0)
    by_subject = [{"label": s, "items": subj_items[s], "loans": n, "turnover": round(n / subj_items[s], 3) if subj_items[s] else 0}
                  for s, n in subj_loans.most_common(12) if n]
    total_items, total_loans = sum(items_by_type.values()), sum(loans_by_type.values())
    return {"by_type": by_type, "by_subject": by_subject,
            "overall": round(total_loans / total_items, 3) if total_items else 0,
            "table": _table(["Group", "Name", "Items", "Loans", "Loans per item"],
                            [["Item type", r["label"], r["items"], r["loans"], r["turnover"]] for r in by_type]
                            + [["Subject", r["label"], r["items"], r["loans"], r["turnover"]] for r in by_subject])}


def collection(db: Session, w: Window) -> dict:
    year = extract("year", Item.acquired_on).label("yr")
    acquired = sorted(((int(y) if y is not None else None, n) for y, n in db.execute(
        select(year, func.count()).where(*_item_filter(w)).group_by(text("yr"))).all()), key=lambda r: (r[0] is None, r[0] or 0))
    pub = db.execute(select(Biblio.pub_year, func.count(Item.id)).join(Item, Item.biblio_id == Biblio.id)
                     .where(*_item_filter(w)).group_by(Biblio.pub_year)).all()
    decades: Counter = Counter()
    unknown_pub = 0
    for y, n in pub:
        if y:
            decades[y // 10 * 10] += n
        else:
            unknown_pub += n
    total = sum(n for _, n in acquired)
    never = db.scalar(select(func.count()).select_from(Item).where(*_item_filter(w), Item.times_borrowed == 0)) or 0
    loaned_in_window = exists().where(Loan.item_id == Item.id, *_loans_in(w))
    idle = db.scalar(select(func.count()).select_from(Item).where(*_item_filter(w), ~loaned_in_window)) or 0
    by_pub = [{"label": f"{d}s", "value": decades[d]} for d in sorted(decades)]
    if unknown_pub:
        by_pub.append({"label": "Unknown", "value": unknown_pub})
    by_acq = [{"label": str(y) if y else "Unknown", "value": n} for y, n in acquired]
    return {"total_items": total, "never_borrowed": never, "never_borrowed_share": round(never / total, 4) if total else 0,
            "not_borrowed_in_period": idle, "idle_share": round(idle / total, 4) if total else 0,
            "by_acquisition_year": by_acq, "by_publication_decade": by_pub,
            "table": _table(["Dimension", "Bucket", "Items"],
                            [["Acquired", r["label"], r["value"]] for r in by_acq]
                            + [["Published", r["label"], r["value"]] for r in by_pub]
                            + [["Never borrowed", "", never], ["Not borrowed in period", "", idle]])}


def holds(db: Session, w: Window) -> dict:
    branch = [Hold.pickup_branch_id == w.branch_id] if w.branch_id else []
    placed = _align(w, _series(db, w, Hold.created_at, *branch))
    filled = _align(w, _series(db, w, Hold.ready_at, *branch))
    pairs = db.execute(select(Hold.created_at, Hold.ready_at).where(
        Hold.ready_at >= w.start_utc, Hold.ready_at < w.end_utc, Hold.ready_at >= Hold.created_at, *branch).limit(50000)).all()
    waits = [(r - c).total_seconds() / 86400 for c, r in pairs]
    queued = db.scalar(select(func.count()).select_from(Hold).where(Hold.status == HoldStatus.queued, *branch)) or 0
    ready = db.scalar(select(func.count()).select_from(Hold).where(Hold.status == HoldStatus.ready, *branch)) or 0
    labels = w.bucket_keys()
    prev = w.previous()
    return {"labels": labels, "placed": placed, "filled": filled,
            "totals": {"placed": sum(placed), "filled": sum(filled), "previous_placed": count_holds_placed(db, prev)},
            "median_days_to_ready": round(statistics.median(waits), 1) if waits else None,
            "fill_rate": round(sum(filled) / sum(placed), 3) if sum(placed) else None,
            "queued_now": queued, "ready_now": ready,
            "table": _table(["Period", "Placed", "Filled (ready for pickup)"], [[labels[i], placed[i], filled[i]] for i in range(len(labels))])}


def patrons(db: Session, w: Window) -> dict:
    registered_by_cat = dict(db.execute(select(PatronCategory.name, func.count(Patron.id)).join(Patron, Patron.category_id == PatronCategory.id)
                                        .where(*_patron_filter(w), Patron.created_at < w.end_utc).group_by(PatronCategory.name)).all())
    active_by_cat = dict(db.execute(select(PatronCategory.name, func.count(distinct(Loan.patron_id)))
                                    .join(Patron, Patron.category_id == PatronCategory.id).join(Loan, Loan.patron_id == Patron.id)
                                    .where(*_loans_in(w), *_branch_loans(w)).group_by(PatronCategory.name)).all())
    new = _align(w, _series(db, w, Patron.created_at, *_patron_filter(w)))
    registered = sum(registered_by_cat.values())
    active = count_active_patrons(db, w)
    cats = sorted(set(registered_by_cat) | set(active_by_cat))
    labels = w.bucket_keys()
    return {"registered": registered, "active": active, "active_share": round(active / registered, 4) if registered else 0,
            "previous_active": count_active_patrons(db, w.previous()),
            "new_total": sum(new), "previous_new": count_new_patrons(db, w.previous()),
            "labels": labels, "new": new,
            "by_category": [{"label": c, "registered": registered_by_cat.get(c, 0), "active": active_by_cat.get(c, 0)} for c in cats],
            "table": _table(["Category", "Registered", "Active in period"],
                            [[c, registered_by_cat.get(c, 0), active_by_cat.get(c, 0)] for c in cats])}


def fines(db: Session, w: Window) -> dict:
    b = bucket_expr(db, LedgerEntry.created_at, w).label("bkt")
    stmt = select(b, LedgerEntry.kind, func.sum(LedgerEntry.amount)).where(
        LedgerEntry.created_at >= w.start_utc, LedgerEntry.created_at < w.end_utc)
    if w.branch_id:
        stmt = stmt.join(Patron, Patron.id == LedgerEntry.patron_id).where(Patron.home_branch_id == w.branch_id)
    series: dict[str, dict[str, int]] = {"charged": defaultdict(int), "paid": defaultdict(int), "waived": defaultdict(int)}
    for bucket, kind, amount in db.execute(stmt.group_by(text("bkt"), LedgerEntry.kind)).all():
        key = str(bucket)[:10]
        if kind in CHARGE_KINDS:
            series["charged"][key] += int(amount or 0)
        elif kind == LedgerKind.payment:
            series["paid"][key] -= int(amount or 0)
        elif kind == LedgerKind.waiver:
            series["waived"][key] -= int(amount or 0)
    labels = w.bucket_keys()
    out = {k: [_money(v.get(lbl, 0)) for lbl in labels] for k, v in series.items()}
    totals = _ledger_sums(db, w)
    outstanding = db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).select_from(LedgerEntry).join(
        Patron, Patron.id == LedgerEntry.patron_id).where(Patron.home_branch_id == w.branch_id) if w.branch_id
        else select(func.coalesce(func.sum(LedgerEntry.amount), 0)))
    return {"labels": labels, **out, "totals": {k: _money(v) for k, v in totals.items()},
            "previous_totals": {k: _money(v) for k, v in _ledger_sums(db, w.previous()).items()},
            "outstanding": _money(outstanding),
            "table": _table(["Period", "Charged", "Paid", "Waived"],
                            [[labels[i], out["charged"][i], out["paid"][i], out["waived"][i]] for i in range(len(labels))])}


def top(db: Session, w: Window, limit: int = 10) -> dict:
    loans_by_biblio = db.execute(select(Item.biblio_id, func.count(Loan.id)).join(Loan, Loan.item_id == Item.id)
                                 .where(*_loans_in(w), *_branch_loans(w)).group_by(Item.biblio_id)
                                 .order_by(func.count(Loan.id).desc()).limit(5000)).all()
    counts = dict(loans_by_biblio)
    info = {b.id: b for b in db.execute(select(Biblio.id, Biblio.title, Biblio.authors, Biblio.subjects)
                                        .where(Biblio.id.in_(list(counts)))).all()} if counts else {}
    titles = [{"id": bid, "label": info[bid].title, "value": n} for bid, n in loans_by_biblio[:limit] if bid in info]
    authors: Counter = Counter()
    subjects: Counter = Counter()
    for bid, n in counts.items():
        b = info.get(bid)
        if not b:
            continue
        for a in b.authors or []:
            authors[a] += n
        for s in {x.split(" -- ")[0].strip() for x in (b.subjects or []) if x}:
            subjects[s] += n
    return {"titles": titles,
            "authors": [{"label": a, "value": n} for a, n in authors.most_common(limit)],
            "subjects": [{"label": s, "value": n} for s, n in subjects.most_common(limit)],
            "table": _table(["Kind", "Name", "Loans"], [["Title", r["label"], r["value"]] for r in titles]
                            + [["Author", a, n] for a, n in authors.most_common(limit)]
                            + [["Subject", s, n] for s, n in subjects.most_common(limit)])}


def branches(db: Session, w: Window) -> dict:
    def per_branch(stmt) -> dict[int, int]:
        return {k: v or 0 for k, v in db.execute(stmt).all()}

    loans_in = _loans_in(w)
    checkouts = per_branch(select(Loan.branch_id, func.count()).where(*loans_in).group_by(Loan.branch_id))
    returns = per_branch(select(Loan.branch_id, func.count()).where(Loan.returned_at >= w.start_utc, Loan.returned_at < w.end_utc)
                         .group_by(Loan.branch_id))
    active = per_branch(select(Loan.branch_id, func.count(distinct(Loan.patron_id))).where(*loans_in, Loan.patron_id.is_not(None))
                        .group_by(Loan.branch_id))
    holds_placed = per_branch(select(Hold.pickup_branch_id, func.count()).where(Hold.created_at >= w.start_utc, Hold.created_at < w.end_utc)
                              .group_by(Hold.pickup_branch_id))
    items = per_branch(select(Item.branch_id, func.count()).where(Item.deleted_at.is_(None), Item.status.not_in(INACTIVE_ITEM))
                       .group_by(Item.branch_id))
    now = utcnow()
    overdue = per_branch(select(Loan.branch_id, func.count()).where(Loan.returned_at.is_(None), Loan.due_at < now).group_by(Loan.branch_id))
    open_loans = per_branch(select(Loan.branch_id, func.count()).where(Loan.returned_at.is_(None)).group_by(Loan.branch_id))
    rows = []
    for b in db.scalars(select(Branch).order_by(Branch.name)):
        n_items = items.get(b.id, 0)
        rows.append({"id": b.id, "name": b.name, "code": b.code, "checkouts": checkouts.get(b.id, 0), "returns": returns.get(b.id, 0),
                     "active_patrons": active.get(b.id, 0), "holds_placed": holds_placed.get(b.id, 0), "items": n_items,
                     "turnover": round(checkouts.get(b.id, 0) / n_items, 3) if n_items else 0,
                     "open_loans": open_loans.get(b.id, 0), "overdue": overdue.get(b.id, 0),
                     "overdue_rate": round(overdue.get(b.id, 0) / open_loans[b.id], 4) if open_loans.get(b.id) else 0,
                     "selected": b.id == w.branch_id})
    keys = ["checkouts", "returns", "active_patrons", "holds_placed", "items", "turnover", "open_loans", "overdue", "overdue_rate"]
    return {"branches": rows,
            "table": _table(["Branch", "Checkouts", "Returns", "Active patrons", "Holds placed", "Items", "Loans per item",
                             "Open loans", "Overdue now", "Overdue rate"], [[r["name"], *[r[k] for k in keys]] for r in rows])}


PANELS = {
    "overview": overview, "circulation": circulation, "heatmap": heatmap, "turnover": turnover,
    "collection": collection, "holds": holds, "patrons": patrons, "fines": fines, "top": top, "branches": branches,
}


# ------------------------------------------------------------------ staff dashboard


def _day_window(db: Session, day: date, branch_id: int | None) -> Window:
    return Window(day, day, "day", branch_id, local_offset_minutes(day))


def dashboard(db: Session, branch_id: int | None) -> dict:
    """Operational snapshot for the staff home page (all numbers for one branch or the whole library)."""
    from . import circulation as circ_svc

    now = utcnow()
    today = local_today()
    offset = local_offset_minutes(today)
    last14 = Window(today - timedelta(days=13), today, "day", branch_id, offset)
    week = Window(today - timedelta(days=6), today, "day", branch_id, offset)
    today_w = _day_window(db, today, branch_id)
    same_day_last_week = _day_window(db, today - timedelta(days=7), branch_id)

    checkouts_14 = _align(last14, _series(db, last14, Loan.issued_at, *_branch_loans(last14)))
    returns_14 = _align(last14, _series(db, last14, Loan.returned_at, *_branch_loans(last14)))
    loan_branch = [Loan.branch_id == branch_id] if branch_id else []
    open_loans = db.scalar(select(func.count()).select_from(Loan).where(Loan.returned_at.is_(None), *loan_branch)) or 0
    overdue = db.scalar(select(func.count()).select_from(Loan).where(Loan.returned_at.is_(None), Loan.due_at < now, *loan_branch)) or 0
    hold_branch = [Hold.pickup_branch_id == branch_id] if branch_id else []
    queued = db.scalar(select(func.count()).select_from(Hold).where(Hold.status == HoldStatus.queued, *hold_branch)) or 0
    ready = db.scalar(select(func.count()).select_from(Hold).where(Hold.status == HoldStatus.ready, *hold_branch)) or 0
    soon = now + timedelta(days=2)
    expiring = db.scalars(select(Hold).where(Hold.status == HoldStatus.ready, Hold.expires_at.is_not(None), Hold.expires_at <= soon,
                                             *hold_branch).order_by(Hold.expires_at).limit(8)).all()
    stale_cutoff = now - timedelta(days=7)
    transit_where = [Item.deleted_at.is_(None), Item.status == ItemStatus.in_transit,
                     func.coalesce(Item.last_seen_at, Item.updated_at) < stale_cutoff]
    if branch_id:
        transit_where.append(Item.branch_id == branch_id)
    in_transit = db.scalars(select(Item).where(*transit_where).order_by(func.coalesce(Item.last_seen_at, Item.updated_at)).limit(8)).all()
    in_transit_total = db.scalar(select(func.count()).select_from(Item).where(*transit_where)) or 0
    to_pull = circ_svc.holds_to_pull(db, branch_id)
    new_patrons_30 = count_new_patrons(db, Window(today - timedelta(days=29), today, "day", branch_id, offset))
    new_patrons_prev = count_new_patrons(db, Window(today - timedelta(days=59), today - timedelta(days=30), "day", branch_id, offset))
    active_week = count_active_patrons(db, week)

    kpis = {
        "checkouts_7d": {"value": sum(checkouts_14[7:]), "previous": sum(checkouts_14[:7]), "spark": checkouts_14},
        "returns_7d": {"value": sum(returns_14[7:]), "previous": sum(returns_14[:7]), "spark": returns_14},
        "open_loans": {"value": open_loans},
        "overdue": {"value": overdue, "rate": round(overdue / open_loans, 4) if open_loans else 0},
        "holds_queued": {"value": queued, "ready": ready},
        "active_patrons_7d": {"value": active_week, "previous": count_active_patrons(db, week.previous())},
        "new_patrons_30d": {"value": new_patrons_30, "previous": new_patrons_prev},
    }
    desk = {
        "checkouts_today": count_checkouts(db, today_w), "checkouts_same_day_last_week": count_checkouts(db, same_day_last_week),
        "checkins_today": count_returns(db, today_w), "checkins_same_day_last_week": count_returns(db, same_day_last_week),
        "holds_to_pull": len(to_pull),
        "holds_to_pull_sample": [{"hold_id": r["hold"].id, "title": r["hold"].biblio.title, "barcode": r["item"].barcode,
                                  "call_number": r["item"].call_number, "patron": r["hold"].patron.full_name,
                                  "pickup": r["hold"].pickup_branch.name} for r in to_pull[:6]],
        "holds_ready": ready,
        "holds_expiring": [{"hold_id": h.id, "title": h.biblio.title, "patron": h.patron.full_name, "patron_id": h.patron_id,
                            "expires_at": h.expires_at} for h in expiring],
        "in_transit_stale": in_transit_total,
        "in_transit_sample": [{"barcode": i.barcode, "title": i.biblio.title, "since": i.last_seen_at or i.updated_at,
                               "home": i.branch.name} for i in in_transit],
    }
    return {"generated_at": now, "branch_id": branch_id, "kpis": kpis, "desk": desk, "alerts": alerts(db, branch_id, now=now),
            "hourly_today": _hourly_today(db, today_w)}


def _hourly_today(db: Session, w: Window) -> list[int]:
    local = local_time(db, Loan.issued_at, w.offset_minutes)
    hour = extract("hour", local).label("hr")
    out = [0] * 24
    for h, n in db.execute(select(hour, func.count()).where(Loan.issued_at >= w.start_utc, Loan.issued_at < w.end_utc,
                                                            *_branch_loans(w)).group_by(text("hr"))).all():
        out[int(h)] = n
    return out


def _late_rate(db: Session, start: datetime, end: datetime, now: datetime, branch_id: int | None) -> tuple[int, int]:
    """(late, total) for loans that fell due in [start, end)."""
    where = [Loan.due_at >= start, Loan.due_at < end]
    if branch_id:
        where.append(Loan.branch_id == branch_id)
    late = case((or_(Loan.returned_at > Loan.due_at, and_(Loan.returned_at.is_(None), Loan.due_at < now)), 1), else_=0)
    total, n_late = db.execute(select(func.count(), func.coalesce(func.sum(late), 0)).where(*where)).one()
    return int(n_late or 0), int(total or 0)


def alerts(db: Session, branch_id: int | None, *, now: datetime | None = None) -> list[dict]:
    """Actionable warnings: overdue-rate spike, budgets nearly spent, long hold queues, failed notices."""
    now = now or utcnow()
    out: list[dict] = []
    late_7, due_7 = _late_rate(db, now - timedelta(days=7), now, now, branch_id)
    late_28, due_28 = _late_rate(db, now - timedelta(days=35), now - timedelta(days=7), now, branch_id)
    rate_7 = late_7 / due_7 if due_7 else 0
    rate_28 = late_28 / due_28 if due_28 else 0
    if due_7 >= 5 and rate_7 >= 0.1 and rate_7 >= 1.5 * rate_28:
        out.append({"kind": "overdue_spike", "level": "bad", "value": round(rate_7, 3), "baseline": round(rate_28, 3),
                    "params": {"rate": f"{rate_7:.0%}", "baseline": f"{rate_28:.0%}"},
                    "message": f"Late returns spiked: {rate_7:.0%} of loans due this week were late (vs {rate_28:.0%} over the previous four weeks).",
                    "href": "/staff/reports#overdues"})

    spent = (select(PurchaseOrder.budget_id, func.sum(PurchaseOrder.unit_price * PurchaseOrder.quantity).label("spent"))
             .where(PurchaseOrder.status != OrderStatus.cancelled).group_by(PurchaseOrder.budget_id).subquery())
    budget_q = select(Budget.name, Budget.allocated, spent.c.spent).join(spent, spent.c.budget_id == Budget.id).where(
        Budget.allocated > 0, spent.c.spent >= Budget.allocated * 0.9)
    if branch_id:
        budget_q = budget_q.where(or_(Budget.branch_id == branch_id, Budget.branch_id.is_(None)))
    for name, allocated, used in db.execute(budget_q.limit(5)).all():
        out.append({"kind": "budget", "level": "warn", "value": round(used / allocated, 3),
                    "params": {"name": name, "pct": f"{used / allocated:.0%}"},
                    "message": f"Budget “{name}” is {used / allocated:.0%} committed.", "href": "/staff/acquisitions"})

    holdable_items = (select(Item.biblio_id, func.count().label("copies")).join(ItemType, ItemType.id == Item.item_type_id)
                      .where(Item.deleted_at.is_(None), ItemType.holdable.is_(True),
                             Item.status.not_in((ItemStatus.withdrawn, ItemStatus.lost)))
                      .group_by(Item.biblio_id).subquery())
    hold_where = [Hold.status == HoldStatus.queued]
    if branch_id:
        hold_where.append(Hold.pickup_branch_id == branch_id)
    queues = (select(Hold.biblio_id, func.count().label("queued")).where(*hold_where).group_by(Hold.biblio_id).subquery())
    long_queues = db.execute(select(Biblio.id, Biblio.title, queues.c.queued, func.coalesce(holdable_items.c.copies, 0))
                             .join(queues, queues.c.biblio_id == Biblio.id)
                             .outerjoin(holdable_items, holdable_items.c.biblio_id == Biblio.id)
                             .where(queues.c.queued >= 3 * func.coalesce(holdable_items.c.copies, 0), queues.c.queued >= 3)
                             .order_by(queues.c.queued.desc()).limit(3)).all()
    for bid, title, queued, copies in long_queues:
        out.append({"kind": "holds_ratio", "level": "warn", "value": queued, "biblio_id": bid,
                    "params": {"title": title, "queued": queued, "copies": copies, "count": copies},
                    "message": f"“{title}” has {queued} holds for {copies} cop{'y' if copies == 1 else 'ies'} — consider buying more.",
                    "href": f"/staff/catalog/{bid}"})

    failed = db.scalar(select(func.count()).select_from(Notification).where(
        Notification.status == "failed", Notification.created_at >= now - timedelta(days=7))) or 0
    if failed:
        out.append({"kind": "failed_notices", "level": "bad", "value": failed, "params": {"count": failed},
                    "message": f"{failed} patron notice{'s' if failed != 1 else ''} failed to send in the last 7 days.", "href": "/staff/admin"})
    return out
