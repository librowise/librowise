"""ORM models.

Design notes vs. Koha's schema (200+ tables):
* One ``biblios`` table (Koha splits biblio / biblioitems / biblio_metadata).
* Soft deletes via ``deleted_at`` instead of shadow ``deleted*`` tables.
* Money is stored as integer minor units (paise/cents) — no float rounding.
* A partial unique index guarantees an item can only have one open loan.
* Circulation rules are a single wildcard matrix resolved by specificity.
"""

from __future__ import annotations

import enum
from datetime import UTC, date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )


# ---------------------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------------------


class Role(enum.StrEnum):
    patron = "patron"
    librarian = "librarian"
    admin = "admin"


class ItemStatus(enum.StrEnum):
    available = "available"
    on_loan = "on_loan"
    on_hold_shelf = "on_hold_shelf"
    in_transit = "in_transit"
    processing = "processing"
    lost = "lost"
    damaged = "damaged"
    withdrawn = "withdrawn"


class HoldStatus(enum.StrEnum):
    queued = "queued"
    ready = "ready"
    fulfilled = "fulfilled"
    cancelled = "cancelled"
    expired = "expired"


class LedgerKind(enum.StrEnum):
    overdue = "overdue"
    lost = "lost"
    manual = "manual"
    payment = "payment"
    waiver = "waiver"


class OrderStatus(enum.StrEnum):
    draft = "draft"
    ordered = "ordered"
    received = "received"
    cancelled = "cancelled"


# ---------------------------------------------------------------------------------------
# Library structure
# ---------------------------------------------------------------------------------------


class Branch(TimestampMixin, Base):
    __tablename__ = "branches"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    address: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(40))


class ItemType(TimestampMixin, Base):
    __tablename__ = "item_types"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    holdable: Mapped[bool] = mapped_column(Boolean, default=True)
    replacement_cost: Mapped[int] = mapped_column(Integer, default=50000)  # minor units


class PatronCategory(TimestampMixin, Base):
    __tablename__ = "patron_categories"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    max_loans: Mapped[int] = mapped_column(Integer, default=10)
    max_holds: Mapped[int] = mapped_column(Integer, default=5)
    enrollment_months: Mapped[int] = mapped_column(Integer, default=12)
    block_fine_threshold: Mapped[int] = mapped_column(Integer, default=50000)


class CirculationRule(TimestampMixin, Base):
    """NULL in branch/category/item_type means "any". Most specific rule wins."""

    __tablename__ = "circulation_rules"
    __table_args__ = (UniqueConstraint("branch_id", "category_id", "item_type_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id", ondelete="CASCADE"))
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("patron_categories.id", ondelete="CASCADE")
    )
    item_type_id: Mapped[int | None] = mapped_column(ForeignKey("item_types.id", ondelete="CASCADE"))
    loan_days: Mapped[int] = mapped_column(Integer, default=14)
    max_renewals: Mapped[int] = mapped_column(Integer, default=2)
    fine_per_day: Mapped[int] = mapped_column(Integer, default=200)  # minor units
    fine_cap: Mapped[int] = mapped_column(Integer, default=10000)
    grace_days: Mapped[int] = mapped_column(Integer, default=0)
    hold_pickup_days: Mapped[int] = mapped_column(Integer, default=7)

    branch: Mapped[Branch | None] = relationship()
    category: Mapped[PatronCategory | None] = relationship()
    item_type: Mapped[ItemType | None] = relationship()


# ---------------------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------------------


class Patron(TimestampMixin, Base):
    __tablename__ = "patrons"
    id: Mapped[int] = mapped_column(primary_key=True)
    card_number: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(160), unique=True, index=True)
    first_name: Mapped[str] = mapped_column(String(80))
    last_name: Mapped[str] = mapped_column(String(80), index=True)
    phone: Mapped[str | None] = mapped_column(String(40))
    address: Mapped[str | None] = mapped_column(String(255))
    date_of_birth: Mapped[date | None] = mapped_column(Date)
    category_id: Mapped[int] = mapped_column(ForeignKey("patron_categories.id"))
    home_branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id"))
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.patron, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    expires_on: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str | None] = mapped_column(Text)
    preferences: Mapped[dict] = mapped_column(JSON, default=dict)  # theme, language, notifications
    keep_history: Mapped[bool] = mapped_column(Boolean, default=True)  # privacy opt-out
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    category: Mapped[PatronCategory] = relationship(lazy="joined")
    home_branch: Mapped[Branch] = relationship(lazy="joined")

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()

    @property
    def is_staff(self) -> bool:
        return self.role in (Role.librarian, Role.admin)


# ---------------------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------------------


class Biblio(TimestampMixin, Base):
    __tablename__ = "biblios"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(500), index=True)
    subtitle: Mapped[str | None] = mapped_column(String(500))
    authors: Mapped[list] = mapped_column(JSON, default=list)
    isbn: Mapped[str | None] = mapped_column(String(20), index=True)
    issn: Mapped[str | None] = mapped_column(String(20))
    publisher: Mapped[str | None] = mapped_column(String(255))
    pub_year: Mapped[int | None] = mapped_column(Integer, index=True)
    edition: Mapped[str | None] = mapped_column(String(80))
    language: Mapped[str] = mapped_column(String(8), default="en", index=True)
    material_type: Mapped[str] = mapped_column(String(32), default="book", index=True)
    subjects: Mapped[list] = mapped_column(JSON, default=list)
    series: Mapped[str | None] = mapped_column(String(255))
    pages: Mapped[int | None] = mapped_column(Integer)
    description: Mapped[str | None] = mapped_column(Text)
    classification: Mapped[str | None] = mapped_column(String(40))  # e.g. Dewey 823.912
    audience: Mapped[str | None] = mapped_column(String(20))  # children | young_adult | adult
    cover_url: Mapped[str | None] = mapped_column(String(500))
    marc_xml: Mapped[str | None] = mapped_column(Text)  # preserved verbatim on import
    ai_enriched: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    items: Mapped[list[Item]] = relationship(back_populates="biblio", lazy="selectin")

    @property
    def author_display(self) -> str:
        return "; ".join(self.authors or [])


class Item(TimestampMixin, Base):
    __tablename__ = "items"
    id: Mapped[int] = mapped_column(primary_key=True)
    biblio_id: Mapped[int] = mapped_column(ForeignKey("biblios.id", ondelete="CASCADE"), index=True)
    barcode: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id"), index=True)
    item_type_id: Mapped[int] = mapped_column(ForeignKey("item_types.id"))
    call_number: Mapped[str | None] = mapped_column(String(64))
    shelf_location: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[ItemStatus] = mapped_column(
        Enum(ItemStatus), default=ItemStatus.available, index=True
    )
    price: Mapped[int | None] = mapped_column(Integer)
    acquired_on: Mapped[date | None] = mapped_column(Date)
    times_borrowed: Mapped[int] = mapped_column(Integer, default=0)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)
    notes: Mapped[str | None] = mapped_column(Text)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    biblio: Mapped[Biblio] = relationship(back_populates="items")
    branch: Mapped[Branch] = relationship(lazy="joined")
    item_type: Mapped[ItemType] = relationship(lazy="joined")


# ---------------------------------------------------------------------------------------
# Circulation
# ---------------------------------------------------------------------------------------


class Loan(TimestampMixin, Base):
    __tablename__ = "loans"
    __table_args__ = (
        # An item can have at most one open loan — enforced by the database, not app code.
        Index(
            "uq_open_loan_per_item",
            "item_id",
            unique=True,
            sqlite_where=text("returned_at IS NULL"),
            postgresql_where=text("returned_at IS NULL"),
        ),
        Index("ix_loans_patron_open", "patron_id", "returned_at"),
        Index("ix_loans_due", "due_at"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    patron_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="SET NULL"))
    branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id"))
    issued_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    due_at: Mapped[datetime] = mapped_column(DateTime)
    returned_at: Mapped[datetime | None] = mapped_column(DateTime)
    renewals: Mapped[int] = mapped_column(Integer, default=0)
    fine_charged: Mapped[int] = mapped_column(Integer, default=0)
    issued_by_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="SET NULL"))

    item: Mapped[Item] = relationship(lazy="joined")
    patron: Mapped[Patron | None] = relationship(foreign_keys=[patron_id], lazy="joined")


class Hold(TimestampMixin, Base):
    __tablename__ = "holds"
    __table_args__ = (Index("ix_holds_queue", "biblio_id", "status", "created_at"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    biblio_id: Mapped[int] = mapped_column(ForeignKey("biblios.id", ondelete="CASCADE"))
    patron_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="SET NULL"))
    pickup_branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id"))
    status: Mapped[HoldStatus] = mapped_column(Enum(HoldStatus), default=HoldStatus.queued)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    notes: Mapped[str | None] = mapped_column(String(255))

    biblio: Mapped[Biblio] = relationship(lazy="joined")
    patron: Mapped[Patron] = relationship(lazy="joined")
    item: Mapped[Item | None] = relationship(lazy="joined")
    pickup_branch: Mapped[Branch] = relationship(lazy="joined")


class LedgerEntry(Base):
    """Append-only patron account ledger. Positive = owed, negative = credit/payment."""

    __tablename__ = "ledger"
    id: Mapped[int] = mapped_column(primary_key=True)
    patron_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    loan_id: Mapped[int | None] = mapped_column(ForeignKey("loans.id", ondelete="SET NULL"))
    kind: Mapped[LedgerKind] = mapped_column(Enum(LedgerKind))
    amount: Mapped[int] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="SET NULL"))


# ---------------------------------------------------------------------------------------
# Acquisitions
# ---------------------------------------------------------------------------------------


class Vendor(TimestampMixin, Base):
    __tablename__ = "vendors"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), unique=True)
    email: Mapped[str | None] = mapped_column(String(160))
    phone: Mapped[str | None] = mapped_column(String(40))
    discount_pct: Mapped[float] = mapped_column(default=0.0)


class Budget(TimestampMixin, Base):
    __tablename__ = "budgets"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    fiscal_year: Mapped[int] = mapped_column(Integer)
    allocated: Mapped[int] = mapped_column(Integer)  # minor units
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"))


class PurchaseOrder(TimestampMixin, Base):
    __tablename__ = "purchase_orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    vendor_id: Mapped[int] = mapped_column(ForeignKey("vendors.id"))
    budget_id: Mapped[int] = mapped_column(ForeignKey("budgets.id"))
    biblio_id: Mapped[int | None] = mapped_column(ForeignKey("biblios.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(500))
    isbn: Mapped[str | None] = mapped_column(String(20))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    unit_price: Mapped[int] = mapped_column(Integer)
    status: Mapped[OrderStatus] = mapped_column(Enum(OrderStatus), default=OrderStatus.ordered)
    received_at: Mapped[datetime | None] = mapped_column(DateTime)
    notes: Mapped[str | None] = mapped_column(String(255))

    vendor: Mapped[Vendor] = relationship(lazy="joined")
    budget: Mapped[Budget] = relationship(lazy="joined")


# ---------------------------------------------------------------------------------------
# Patron engagement
# ---------------------------------------------------------------------------------------


class Review(TimestampMixin, Base):
    __tablename__ = "reviews"
    __table_args__ = (UniqueConstraint("patron_id", "biblio_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    patron_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"))
    biblio_id: Mapped[int] = mapped_column(ForeignKey("biblios.id", ondelete="CASCADE"), index=True)
    rating: Mapped[int] = mapped_column(Integer)
    body: Mapped[str | None] = mapped_column(Text)
    approved: Mapped[bool] = mapped_column(Boolean, default=True)

    patron: Mapped[Patron] = relationship(lazy="joined")


class ReadingList(TimestampMixin, Base):
    __tablename__ = "reading_lists"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)
    entries: Mapped[list[ReadingListEntry]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )


class ReadingListEntry(Base):
    __tablename__ = "reading_list_entries"
    __table_args__ = (UniqueConstraint("list_id", "biblio_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    list_id: Mapped[int] = mapped_column(ForeignKey("reading_lists.id", ondelete="CASCADE"))
    biblio_id: Mapped[int] = mapped_column(ForeignKey("biblios.id", ondelete="CASCADE"))
    added_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    biblio: Mapped[Biblio] = relationship(lazy="joined")


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    patron_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    channel: Mapped[str] = mapped_column(String(16), default="email")
    subject: Mapped[str] = mapped_column(String(255))
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime)


# ---------------------------------------------------------------------------------------
# Administration
# ---------------------------------------------------------------------------------------


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[dict | list | str | int | float | bool | None] = mapped_column(JSON)
    description: Mapped[str | None] = mapped_column(String(255))


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[int | None] = mapped_column(Integer)
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    ip: Mapped[str | None] = mapped_column(String(64))

    actor: Mapped[Patron | None] = relationship(lazy="joined")


# ---- platform & operations ----
from sqlalchemy import func as _sa_func  # noqa: E402  (kept local to this section)

# Background jobs, scheduler bookkeeping, worker heartbeats, shared rate-limit counters and
# extra indexes that keep catalogue/circulation queries fast at 100k+ records.


class Job(Base):
    """A unit of background work. Claimed by workers with SKIP LOCKED (PostgreSQL) or an atomic
    compare-and-set UPDATE (SQLite); retried with exponential backoff until ``max_attempts``."""

    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_claim", "status", "run_at", "priority"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    # queued | running | succeeded | failed (will retry) | dead (gave up) | cancelled
    status: Mapped[str] = mapped_column(String(16), default="queued")
    priority: Mapped[int] = mapped_column(Integer, default=0)  # higher runs first
    run_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    last_error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSON)
    locked_by: Mapped[str | None] = mapped_column(String(128))
    locked_at: Mapped[datetime | None] = mapped_column(DateTime)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    schedule: Mapped[str | None] = mapped_column(String(64))  # schedule that enqueued it, if any
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class ScheduleRun(Base):
    """One row per (schedule, slot): the unique key makes each cron slot fire exactly once, no
    matter how many workers run the scheduler."""

    __tablename__ = "schedule_runs"
    __table_args__ = (UniqueConstraint("name", "slot_at", name="uq_schedule_slot"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    slot_at: Mapped[datetime] = mapped_column(DateTime)  # UTC
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeats"
    worker_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    hostname: Mapped[str] = mapped_column(String(255))
    pid: Mapped[int] = mapped_column(Integer)
    concurrency: Mapped[int] = mapped_column(Integer, default=1)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    jobs_succeeded: Mapped[int] = mapped_column(Integer, default=0)
    jobs_failed: Mapped[int] = mapped_column(Integer, default=0)
    current_jobs: Mapped[list] = mapped_column(JSON, default=list)
    stopping: Mapped[bool] = mapped_column(Boolean, default=False)


class RateLimitCounter(Base):
    """Fixed-window hit counters shared by every process (database rate-limit backend)."""

    __tablename__ = "rate_limit_counters"
    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    window_start: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)  # unix seconds
    hits: Mapped[int] = mapped_column(Integer, default=0)


class BiblioFacet(Base):
    """Subjects and authors of live records, one row per value (maintained with the full-text
    index by ``services.catalog.index_biblio``). Turns subject/author filters into index
    lookups and facet counts into a single GROUP BY instead of parsing JSON per record."""

    __tablename__ = "biblio_facets"
    __table_args__ = (
        Index("ix_biblio_facets_lookup", "kind", "value_norm", "biblio_id"),
        Index("ix_biblio_facets_biblio", "biblio_id", "kind", "value"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    biblio_id: Mapped[int] = mapped_column(ForeignKey("biblios.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(1))  # "s" subject | "a" author
    value: Mapped[str] = mapped_column(Text)
    value_norm: Mapped[str] = mapped_column(Text)  # lower-cased for case-insensitive filters


# Indexes for large catalogues and circulation histories. Covering indexes let the hot
# aggregate queries (trending, co-borrowing, late-return statistics, overdue lists) run as
# index-only scans.
Index("ix_biblios_created_at", Biblio.created_at)
Index("ix_biblios_updated_at", Biblio.updated_at)
Index("ix_biblios_title_lower", _sa_func.lower(Biblio.title))
Index("ix_items_status_deleted", Item.status, Item.deleted_at)
Index("ix_loans_item_activity", Loan.item_id, Loan.issued_at, Loan.patron_id)
Index("ix_loans_issued_cover", Loan.issued_at, Loan.item_id, Loan.branch_id)
Index("ix_loans_patron_activity", Loan.patron_id, Loan.issued_at, Loan.item_id)
Index("ix_loans_patron_returns", Loan.patron_id, Loan.returned_at, Loan.due_at)
Index("ix_loans_due_open", Loan.due_at, sqlite_where=text("returned_at IS NULL"),
      postgresql_where=text("returned_at IS NULL"))
Index("ix_loans_updated_at", Loan.updated_at)
