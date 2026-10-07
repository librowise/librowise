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
    # OPAC self-registration: None (staff-created) | pending | approved | rejected
    registration_status: Mapped[str | None] = mapped_column(String(16), index=True)
    # Identity & access (see the "identity & access" section at the end of this module).
    staff_role_id: Mapped[int | None] = mapped_column(ForeignKey("staff_roles.id", ondelete="SET NULL"), index=True)
    failed_logins: Mapped[int | None] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime)
    sessions_revoked_at: Mapped[datetime | None] = mapped_column(DateTime)

    category: Mapped[PatronCategory] = relationship(lazy="joined")
    home_branch: Mapped[Branch] = relationship(lazy="joined")
    staff_role: Mapped[StaffRole | None] = relationship(lazy="select")

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()

    @property
    def is_staff(self) -> bool:
        # A custom staff role makes an account a staff account even with the base "patron" role.
        return self.role in (Role.librarian, Role.admin) or self.staff_role_id is not None


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
    # Holds depth: item-level requests, suspension and "not needed after" (see services/holds.py).
    requested_item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"))
    suspended: Mapped[bool] = mapped_column(Boolean, default=False)
    suspended_until: Mapped[date | None] = mapped_column(Date)
    not_needed_after: Mapped[date | None] = mapped_column(Date)

    biblio: Mapped[Biblio] = relationship(lazy="joined")
    patron: Mapped[Patron] = relationship(lazy="joined")
    item: Mapped[Item | None] = relationship(foreign_keys=[item_id], lazy="joined")
    requested_item: Mapped[Item | None] = relationship(foreign_keys=[requested_item_id], lazy="joined")
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
    # Outbox delivery (services/notices.py): template code, recipient and retry bookkeeping.
    code: Mapped[str | None] = mapped_column(String(40), index=True)
    to_address: Mapped[str | None] = mapped_column(String(160))
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    last_error: Mapped[str | None] = mapped_column(Text)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    patron: Mapped[Patron] = relationship(lazy="joined")


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


# ---- circulation services ----
# Library calendar, notice templates & messaging preferences, self-registration, purchase suggestions.


class BranchCalendar(Base):
    """Per-branch weekly pattern: weekdays (0 = Monday … 6 = Sunday) on which the branch is closed."""

    __tablename__ = "branch_calendars"
    branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id", ondelete="CASCADE"), primary_key=True)
    closed_weekdays: Mapped[list] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class CalendarClosure(TimestampMixin, Base):
    """A dated exception to the weekly pattern.

    ``branch_id`` NULL applies to every branch. ``repeats_yearly`` matches the same month/day every year.
    ``open_override`` marks a special opening on a normally closed weekday (Koha's "exception").
    Branch-specific entries win over all-branch entries; exact dates win over yearly ones.
    """

    __tablename__ = "calendar_closures"
    __table_args__ = (Index("ix_calendar_closures_day", "branch_id", "day"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id", ondelete="CASCADE"))
    day: Mapped[date] = mapped_column(Date)
    description: Mapped[str] = mapped_column(String(160), default="")
    repeats_yearly: Mapped[bool] = mapped_column(Boolean, default=False)
    open_override: Mapped[bool] = mapped_column(Boolean, default=False)

    branch: Mapped[Branch | None] = relationship(lazy="joined")


class NoticeTemplate(TimestampMixin, Base):
    """Editable notice text, rendered in a Jinja2 *sandbox* from plain-dict context."""

    __tablename__ = "notice_templates"
    __table_args__ = (UniqueConstraint("code", "channel"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(40), index=True)
    channel: Mapped[str] = mapped_column(String(16), default="email")  # email | sms
    subject: Mapped[str] = mapped_column(String(255), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="SET NULL"))


class MessagePreference(Base):
    """Patron messaging preference per notice type: email | sms | none."""

    __tablename__ = "message_preferences"
    __table_args__ = (UniqueConstraint("patron_id", "code"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    patron_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(40))
    channel: Mapped[str] = mapped_column(String(16), default="email")


class PatronRegistration(TimestampMixin, Base):
    """Review trail for an OPAC self-registration (the account itself is a normal, inactive Patron)."""

    __tablename__ = "patron_registrations"
    id: Mapped[int] = mapped_column(primary_key=True)
    patron_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    ip: Mapped[str | None] = mapped_column(String(64))
    reviewed_by_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="SET NULL"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    decision_note: Mapped[str | None] = mapped_column(String(500))

    patron: Mapped[Patron] = relationship(foreign_keys=[patron_id], lazy="joined")
    reviewed_by: Mapped[Patron | None] = relationship(foreign_keys=[reviewed_by_id], lazy="joined")


class SuggestionStatus(enum.StrEnum):
    pending = "pending"
    accepted = "accepted"
    ordered = "ordered"
    rejected = "rejected"
    withdrawn = "withdrawn"


class PurchaseSuggestion(TimestampMixin, Base):
    __tablename__ = "purchase_suggestions"
    id: Mapped[int] = mapped_column(primary_key=True)
    patron_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="SET NULL"), index=True)
    title: Mapped[str] = mapped_column(String(500))
    author: Mapped[str | None] = mapped_column(String(255))
    isbn: Mapped[str | None] = mapped_column(String(20))
    format: Mapped[str] = mapped_column(String(32), default="book")
    reason: Mapped[str | None] = mapped_column(Text)
    status: Mapped[SuggestionStatus] = mapped_column(
        Enum(SuggestionStatus), default=SuggestionStatus.pending, index=True
    )
    decision_note: Mapped[str | None] = mapped_column(String(500))
    reviewed_by_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="SET NULL"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_orders.id", ondelete="SET NULL"))

    patron: Mapped[Patron | None] = relationship(foreign_keys=[patron_id], lazy="joined")
    reviewed_by: Mapped[Patron | None] = relationship(foreign_keys=[reviewed_by_id], lazy="joined")

# ---- serials & course reserves ----
# Serials control (subscriptions, predicted issues, claims) and course reserves. Koha equivalents:
# subscription / serial / claims and course_reserves / course_items.


class SubscriptionStatus(enum.StrEnum):
    active = "active"
    expired = "expired"
    cancelled = "cancelled"


class SerialIssueStatus(enum.StrEnum):
    expected = "expected"
    arrived = "arrived"
    late = "late"
    missing = "missing"
    claimed = "claimed"
    not_published = "not_published"


class Subscription(TimestampMixin, Base):
    """A standing order for a serial title. ``numbering`` holds the enumeration levels, outermost first:
    ``{"X": {"start": 1, "increment": 1, "max": None, "reset": 1, "yearly": False, "labels": []}, ...}``."""

    __tablename__ = "serial_subscriptions"
    id: Mapped[int] = mapped_column(primary_key=True)
    biblio_id: Mapped[int] = mapped_column(ForeignKey("biblios.id", ondelete="CASCADE"), index=True)
    vendor_id: Mapped[int | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), index=True)
    budget_id: Mapped[int | None] = mapped_column(ForeignKey("budgets.id", ondelete="SET NULL"))
    branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id"), index=True)
    status: Mapped[SubscriptionStatus] = mapped_column(
        Enum(SubscriptionStatus), default=SubscriptionStatus.active, index=True
    )
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date, index=True)
    first_issue_on: Mapped[date | None] = mapped_column(Date)  # defaults to start_date
    frequency: Mapped[str] = mapped_column(String(20), default="monthly")
    frequency_interval: Mapped[int] = mapped_column(Integer, default=1)  # N for every_n_* frequencies
    skip_weekdays: Mapped[list] = mapped_column(JSON, default=list)  # 0=Mon … 6=Sun (day-based only)
    numbering_pattern: Mapped[str] = mapped_column(String(160), default="No. {X}")
    numbering: Mapped[dict] = mapped_column(JSON, default=dict)
    grace_days: Mapped[int] = mapped_column(Integer, default=7)
    create_items: Mapped[bool] = mapped_column(Boolean, default=True)
    item_type_id: Mapped[int | None] = mapped_column(ForeignKey("item_types.id", ondelete="SET NULL"))
    shelf_location: Mapped[str | None] = mapped_column(String(64))
    call_number: Mapped[str | None] = mapped_column(String(48))  # prefix; the issue enumeration is appended
    price: Mapped[int | None] = mapped_column(Integer)  # annual cost in minor units (informational)
    vendor_reference: Mapped[str | None] = mapped_column(String(64))  # the vendor's subscription number
    notes: Mapped[str | None] = mapped_column(Text)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime)

    biblio: Mapped[Biblio] = relationship(lazy="joined")
    vendor: Mapped[Vendor | None] = relationship(lazy="joined")
    budget: Mapped[Budget | None] = relationship(lazy="joined")
    branch: Mapped[Branch] = relationship(lazy="joined")
    item_type: Mapped[ItemType | None] = relationship(lazy="joined")
    routing: Mapped[list[SerialRouting]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by="SerialRouting.position"
    )


class SerialRouting(Base):
    """Ordered routing list: each received issue is passed from person to person in this order."""

    __tablename__ = "serial_routing"
    __table_args__ = (UniqueConstraint("subscription_id", "patron_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        ForeignKey("serial_subscriptions.id", ondelete="CASCADE"), index=True
    )
    patron_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str | None] = mapped_column(String(255))

    patron: Mapped[Patron] = relationship(lazy="joined")


class SerialIssue(TimestampMixin, Base):
    __tablename__ = "serial_issues"
    __table_args__ = (
        UniqueConstraint("subscription_id", "sequence"),
        Index("ix_serial_issues_status_expected", "status", "expected_on"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        ForeignKey("serial_subscriptions.id", ondelete="CASCADE"), index=True
    )
    sequence: Mapped[int | None] = mapped_column(Integer)  # 0-based position in the prediction; NULL = manual
    numbers: Mapped[list] = mapped_column(JSON, default=list)  # numbering-level values, outermost first
    enumeration: Mapped[str] = mapped_column(String(160))
    chronology: Mapped[str | None] = mapped_column(String(64))
    expected_on: Mapped[date] = mapped_column(Date)
    received_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[SerialIssueStatus] = mapped_column(
        Enum(SerialIssueStatus), default=SerialIssueStatus.expected
    )
    manual: Mapped[bool] = mapped_column(Boolean, default=False)
    claim_count: Mapped[int] = mapped_column(Integer, default=0)
    last_claimed_at: Mapped[datetime | None] = mapped_column(DateTime)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="SET NULL"))
    notes: Mapped[str | None] = mapped_column(String(255))

    subscription: Mapped[Subscription] = relationship(lazy="joined")
    item: Mapped[Item | None] = relationship(lazy="joined")


class SerialClaim(Base):
    """One claim sent to a vendor for a late or missing issue. Claims generated together share a batch."""

    __tablename__ = "serial_claims"
    id: Mapped[int] = mapped_column(primary_key=True)
    batch: Mapped[str] = mapped_column(String(32), index=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("serial_issues.id", ondelete="CASCADE"), index=True)
    vendor_id: Mapped[int | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"))
    claimed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    claimed_by_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="SET NULL"))
    note: Mapped[str | None] = mapped_column(String(500))

    issue: Mapped[SerialIssue] = relationship(lazy="joined")
    vendor: Mapped[Vendor | None] = relationship(lazy="joined")
    claimed_by: Mapped[Patron | None] = relationship(lazy="joined")


class CourseInstructor(Base):
    __tablename__ = "course_instructors"
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), primary_key=True)
    patron_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), primary_key=True)

    patron: Mapped[Patron] = relationship(lazy="joined")


class Course(TimestampMixin, Base):
    __tablename__ = "courses"
    __table_args__ = (UniqueConstraint("code", "section", "term"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), index=True)
    section: Mapped[str] = mapped_column(String(16), default="")
    name: Mapped[str] = mapped_column(String(200))
    department: Mapped[str | None] = mapped_column(String(120), index=True)
    term: Mapped[str] = mapped_column(String(40), default="", index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    public_notes: Mapped[str | None] = mapped_column(Text)
    staff_notes: Mapped[str | None] = mapped_column(Text)

    instructors: Mapped[list[CourseInstructor]] = relationship(cascade="all, delete-orphan", lazy="selectin")
    reserves: Mapped[list[CourseReserve]] = relationship(
        back_populates="course", cascade="all, delete-orphan", lazy="selectin"
    )


class CourseItem(TimestampMixin, Base):
    """Reserve settings for one item (or a whole title when ``item_id`` is NULL), shared by every course
    that reserves it. While any of those courses is active the overrides are applied to the item and the
    item's previous values are kept in ``original_*`` so they can be restored afterwards."""

    __tablename__ = "course_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    biblio_id: Mapped[int] = mapped_column(ForeignKey("biblios.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"), unique=True)
    item_type_id: Mapped[int | None] = mapped_column(ForeignKey("item_types.id", ondelete="SET NULL"))
    shelf_location: Mapped[str | None] = mapped_column(String(64))
    swapped: Mapped[bool] = mapped_column(Boolean, default=False)
    original_item_type_id: Mapped[int | None] = mapped_column(ForeignKey("item_types.id", ondelete="SET NULL"))
    original_shelf_location: Mapped[str | None] = mapped_column(String(64))

    biblio: Mapped[Biblio] = relationship(lazy="joined")
    item: Mapped[Item | None] = relationship(lazy="joined")
    item_type: Mapped[ItemType | None] = relationship(foreign_keys=[item_type_id], lazy="joined")
    original_item_type: Mapped[ItemType | None] = relationship(foreign_keys=[original_item_type_id], lazy="joined")
    reserves: Mapped[list[CourseReserve]] = relationship(back_populates="course_item", lazy="selectin")


class CourseReserve(TimestampMixin, Base):
    __tablename__ = "course_reserves"
    __table_args__ = (UniqueConstraint("course_id", "course_item_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    course_item_id: Mapped[int] = mapped_column(ForeignKey("course_items.id", ondelete="CASCADE"), index=True)
    public_note: Mapped[str | None] = mapped_column(String(500))
    staff_note: Mapped[str | None] = mapped_column(String(500))

    course: Mapped[Course] = relationship(back_populates="reserves", lazy="joined")
    course_item: Mapped[CourseItem] = relationship(back_populates="reserves", lazy="joined")

# ---- identity & access ----
# Custom staff roles, server-side sessions, personal API tokens, TOTP two-factor authentication,
# one-time tokens (MFA challenges, password resets), login history and SSO identities.


class StaffRole(TimestampMixin, Base):
    """A named, admin-defined set of permissions. Effective permissions are the union of the
    built-in role (``Patron.role``) and the assigned custom role."""

    __tablename__ = "staff_roles"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    description: Mapped[str | None] = mapped_column(String(255))
    permissions: Mapped[list] = mapped_column(JSON, default=list)


class UserSession(Base):
    """Server-side registry of sign-ins. Session tokens embed ``sid``; revoking the row ends the session."""

    __tablename__ = "user_sessions"
    __table_args__ = (Index("ix_user_sessions_user_active", "user_id", "revoked_at"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    sid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))
    method: Mapped[str] = mapped_column(String(40), default="password")
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)


class ApiToken(Base):
    """Long-lived personal API token for integrations. Only a SHA-256 hash is stored."""

    __tablename__ = "api_tokens"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    prefix: Mapped[str] = mapped_column(String(16))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    scopes: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_used_ip: Mapped[str | None] = mapped_column(String(64))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)


class MfaTotp(Base):
    """RFC 6238 TOTP credential. ``confirmed_at`` is NULL while enrolment is pending."""

    __tablename__ = "mfa_totp"
    user_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), primary_key=True)
    secret_enc: Mapped[str] = mapped_column(String(255))  # AES-GCM encrypted base32 secret
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_used_step: Mapped[int | None] = mapped_column(Integer)


class MfaRecoveryCode(Base):
    __tablename__ = "mfa_recovery_codes"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)


class AuthToken(Base):
    """Single-use, short-lived tokens (``mfa`` login challenges, ``reset`` password resets)."""

    __tablename__ = "auth_tokens"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    purpose: Mapped[str] = mapped_column(String(16), index=True)
    jti_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    data: Mapped[dict] = mapped_column(JSON, default=dict)


class LoginEvent(Base):
    """Sign-in history (successes and failures), visible to the account holder."""

    __tablename__ = "login_events"
    __table_args__ = (Index("ix_login_events_user_at", "user_id", "at"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"))
    username: Mapped[str | None] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))
    success: Mapped[bool] = mapped_column(Boolean, default=False)
    method: Mapped[str] = mapped_column(String(40), default="password")
    reason: Mapped[str | None] = mapped_column(String(64))


class UserIdentity(Base):
    """An external (OpenID Connect) identity linked to a local account."""

    __tablename__ = "user_identities"
    __table_args__ = (UniqueConstraint("provider", "subject"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(40))
    subject: Mapped[str] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(160))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)

# ---- interoperability (SIP2, SRU, OAI-PMH, copy cataloguing) ----


class SipAccount(TimestampMixin, Base):
    """A SIP2 login used by a self-check kiosk, security gate, AMH sorter or e-book platform."""

    __tablename__ = "sip_accounts"
    id: Mapped[int] = mapped_column(primary_key=True)
    login: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str | None] = mapped_column(String(120))  # human label, e.g. "Kiosk 1, ground floor"
    institution_id: Mapped[str] = mapped_column(String(64), default="SHELFWISE")
    branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Transport options (applied after a successful login)
    delimiter: Mapped[str] = mapped_column(String(1), default="|")
    encoding: Mapped[str] = mapped_column(String(16), default="utf-8")
    error_detection: Mapped[bool] = mapped_column(Boolean, default=False)  # require AY/AZ checksums
    idle_timeout: Mapped[int] = mapped_column(Integer, default=600)  # seconds
    allowed_networks: Mapped[str | None] = mapped_column(String(500))  # comma-separated CIDRs; empty = any
    # Behaviour flags
    allow_checkout: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_checkin: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_renew: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_patron_info: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_holds: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_fee_paid: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_block_patron: Mapped[bool] = mapped_column(Boolean, default=True)
    require_patron_password: Mapped[bool] = mapped_column(Boolean, default=False)
    checked_in_ok: Mapped[bool] = mapped_column(Boolean, default=True)  # ok=1 when the item was not on loan
    sort_bins: Mapped[dict] = mapped_column(JSON, default=dict)  # {"hold": "1", "transfer": "2", "default": "3"}
    notes: Mapped[str | None] = mapped_column(Text)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_login_ip: Mapped[str | None] = mapped_column(String(64))

    branch: Mapped[Branch] = relationship(lazy="joined")


class SipPatronBlock(Base):
    """A block placed by a SIP2 terminal (message 01). Cleared by Patron Enable (25)."""

    __tablename__ = "sip_patron_blocks"
    id: Mapped[int] = mapped_column(primary_key=True)
    patron_id: Mapped[int] = mapped_column(ForeignKey("patrons.id", ondelete="CASCADE"), index=True)
    sip_account_id: Mapped[int | None] = mapped_column(ForeignKey("sip_accounts.id", ondelete="SET NULL"))
    card_retained: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    cleared_at: Mapped[datetime | None] = mapped_column(DateTime)


class CopyCatTarget(TimestampMixin, Base):
    """A remote SRU server used for copy cataloguing (e.g. the Library of Congress)."""

    __tablename__ = "copycat_targets"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    url: Mapped[str] = mapped_column(String(500))
    sru_version: Mapped[str] = mapped_column(String(8), default="1.1")
    record_schema: Mapped[str] = mapped_column(String(64), default="marcxml")
    title_index: Mapped[str] = mapped_column(String(40), default="dc.title")
    author_index: Mapped[str] = mapped_column(String(40), default="dc.creator")
    isbn_index: Mapped[str] = mapped_column(String(40), default="bath.isbn")
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=10)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
