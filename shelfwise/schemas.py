"""Request schemas (validated by Pydantic) and response serialisers."""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from .models import Biblio, Hold, Item, Loan, Patron


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ------------------------------------------------------------------ auth


class LoginIn(StrictModel):
    username: str = Field(min_length=1, max_length=160, description="Card number or email")
    password: str = Field(min_length=1, max_length=256)


class PasswordChangeIn(StrictModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=256)


class PreferencesIn(StrictModel):
    theme: str | None = Field(default=None, pattern="^(system|light|dark|contrast|sepia)$")
    density: str | None = Field(default=None, pattern="^(comfortable|compact)$")
    font_scale: float | None = Field(default=None, ge=0.8, le=1.6)
    language: str | None = Field(default=None, max_length=8)
    keep_history: bool | None = None


# ------------------------------------------------------------------ catalogue


class BiblioIn(StrictModel):
    title: str = Field(min_length=1, max_length=500)
    subtitle: str | None = Field(default=None, max_length=500)
    authors: list[str] = Field(default_factory=list, max_length=50)
    isbn: str | None = Field(default=None, max_length=20)
    issn: str | None = Field(default=None, max_length=20)
    publisher: str | None = Field(default=None, max_length=255)
    pub_year: int | None = Field(default=None, ge=0, le=2100)
    edition: str | None = Field(default=None, max_length=80)
    language: str = Field(default="en", max_length=8)
    material_type: str = Field(default="book", max_length=32)
    subjects: list[str] = Field(default_factory=list, max_length=50)
    series: str | None = Field(default=None, max_length=255)
    pages: int | None = Field(default=None, ge=0, le=100000)
    description: str | None = Field(default=None, max_length=20000)
    classification: str | None = Field(default=None, max_length=40)
    audience: str | None = Field(default=None, pattern="^(children|young_adult|adult)$")
    cover_url: str | None = Field(default=None, max_length=500)

    @field_validator("cover_url")
    @classmethod
    def _https_only(cls, v: str | None) -> str | None:
        if v and not v.startswith(("https://", "http://")):
            raise ValueError("cover_url must be an http(s) URL")
        return v


class BiblioPatch(BiblioIn):
    title: str | None = Field(default=None, min_length=1, max_length=500)  # type: ignore[assignment]
    language: str | None = Field(default=None, max_length=8)  # type: ignore[assignment]
    material_type: str | None = Field(default=None, max_length=32)  # type: ignore[assignment]
    authors: list[str] | None = None  # type: ignore[assignment]
    subjects: list[str] | None = None  # type: ignore[assignment]
    ai_enriched: bool | None = None


class ItemIn(StrictModel):
    barcode: str | None = Field(default=None, max_length=32, pattern=r"^[A-Za-z0-9\-_.]*$")
    branch_id: int
    item_type_id: int
    call_number: str | None = Field(default=None, max_length=64)
    shelf_location: str | None = Field(default=None, max_length=64)
    price: int | None = Field(default=None, ge=0)
    acquired_on: date | None = None
    notes: str | None = Field(default=None, max_length=2000)
    status: str = "available"


class ItemPatch(StrictModel):
    branch_id: int | None = None
    item_type_id: int | None = None
    call_number: str | None = Field(default=None, max_length=64)
    shelf_location: str | None = Field(default=None, max_length=64)
    price: int | None = Field(default=None, ge=0)
    notes: str | None = Field(default=None, max_length=2000)
    status: str | None = Field(default=None, pattern="^(available|processing|lost|damaged|withdrawn)$")


# ------------------------------------------------------------------ patrons


class PatronIn(StrictModel):
    card_number: str | None = Field(default=None, max_length=32, pattern=r"^[A-Za-z0-9\-]*$")
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=40)
    address: str | None = Field(default=None, max_length=255)
    date_of_birth: date | None = None
    category_id: int
    home_branch_id: int
    role: str = Field(default="patron", pattern="^(patron|librarian|admin)$")
    password: str | None = Field(default=None, max_length=256)
    expires_on: date | None = None
    notes: str | None = Field(default=None, max_length=2000)


class PatronPatch(StrictModel):
    first_name: str | None = Field(default=None, min_length=1, max_length=80)
    last_name: str | None = Field(default=None, min_length=1, max_length=80)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=40)
    address: str | None = Field(default=None, max_length=255)
    category_id: int | None = None
    home_branch_id: int | None = None
    role: str | None = Field(default=None, pattern="^(patron|librarian|admin)$")
    expires_on: date | None = None
    is_active: bool | None = None
    notes: str | None = Field(default=None, max_length=2000)
    password: str | None = Field(default=None, max_length=256)


class MoneyIn(StrictModel):
    amount: int = Field(gt=0, le=10_000_000, description="Minor units (paise/cents)")
    note: str | None = Field(default=None, max_length=255)


# ------------------------------------------------------------------ circulation


class CheckoutIn(StrictModel):
    patron_card: str = Field(min_length=1, max_length=32)
    barcode: str = Field(min_length=1, max_length=32)
    branch_id: int | None = None
    override: bool = False
    due_at: datetime | None = None


class CheckinIn(StrictModel):
    barcode: str = Field(min_length=1, max_length=32)
    branch_id: int | None = None


class RenewIn(StrictModel):
    override: bool = False


class HoldIn(StrictModel):
    biblio_id: int
    pickup_branch_id: int
    patron_card: str | None = Field(default=None, max_length=32, description="Staff only")
    override: bool = False
    notes: str | None = Field(default=None, max_length=255)


class ReviewIn(StrictModel):
    rating: int = Field(ge=1, le=5)
    body: str | None = Field(default=None, max_length=4000)


class ListIn(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    is_public: bool = False


# ------------------------------------------------------------------ admin


class BranchIn(StrictModel):
    code: str = Field(min_length=1, max_length=16, pattern=r"^[A-Z0-9_]+$")
    name: str = Field(min_length=1, max_length=120)
    address: str | None = None
    email: str | None = None
    phone: str | None = None


class ItemTypeIn(StrictModel):
    code: str = Field(min_length=1, max_length=16, pattern=r"^[A-Z0-9_]+$")
    name: str = Field(min_length=1, max_length=80)
    holdable: bool = True
    replacement_cost: int = Field(default=50000, ge=0)


class CategoryIn(StrictModel):
    code: str = Field(min_length=1, max_length=16, pattern=r"^[A-Z0-9_]+$")
    name: str = Field(min_length=1, max_length=80)
    max_loans: int = Field(default=10, ge=0, le=500)
    max_holds: int = Field(default=5, ge=0, le=500)
    enrollment_months: int = Field(default=12, ge=1, le=1200)
    block_fine_threshold: int = Field(default=50000, ge=0)


class RuleIn(StrictModel):
    branch_id: int | None = None
    category_id: int | None = None
    item_type_id: int | None = None
    loan_days: int = Field(default=14, ge=0, le=3650)
    max_renewals: int = Field(default=2, ge=0, le=100)
    fine_per_day: int = Field(default=200, ge=0)
    fine_cap: int = Field(default=10000, ge=0)
    grace_days: int = Field(default=0, ge=0, le=365)
    hold_pickup_days: int = Field(default=7, ge=1, le=365)


class SettingIn(StrictModel):
    value: bool | int | float | str


class VendorIn(StrictModel):
    name: str = Field(min_length=1, max_length=160)
    email: str | None = None
    phone: str | None = None
    discount_pct: float = Field(default=0, ge=0, le=100)


class BudgetIn(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    fiscal_year: int = Field(ge=2000, le=2100)
    allocated: int = Field(ge=0)
    branch_id: int | None = None


class OrderIn(StrictModel):
    vendor_id: int
    budget_id: int
    title: str = Field(min_length=1, max_length=500)
    isbn: str | None = None
    biblio_id: int | None = None
    quantity: int = Field(default=1, ge=1, le=1000)
    unit_price: int = Field(ge=0)
    notes: str | None = None


class ReceiveIn(StrictModel):
    branch_id: int
    item_type_id: int


# ------------------------------------------------------------------ AI


class AskIn(StrictModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[dict] = Field(default_factory=list, max_length=20)


class CatalogAssistIn(StrictModel):
    id: int | None = None
    title: str | None = None
    subtitle: str | None = None
    authors: list[str] = Field(default_factory=list)
    description: str | None = None
    subjects: list[str] = Field(default_factory=list)
    publisher: str | None = None
    pub_year: int | None = None
    isbn: str | None = None


# ------------------------------------------------------------------ serialisers


def money(v: int | None) -> float:
    return round((v or 0) / 100, 2)


def patron_out(p: Patron, *, private: bool = True) -> dict:
    out = {
        "id": p.id, "card_number": p.card_number, "first_name": p.first_name,
        "last_name": p.last_name, "full_name": p.full_name, "role": p.role.value,
        "category": {"id": p.category.id, "code": p.category.code, "name": p.category.name},
        "home_branch": {"id": p.home_branch.id, "code": p.home_branch.code, "name": p.home_branch.name},
        "is_active": p.is_active, "expires_on": p.expires_on,
    }
    if private:
        out.update(email=p.email, phone=p.phone, address=p.address, date_of_birth=p.date_of_birth,
                   notes=p.notes, preferences=p.preferences or {}, keep_history=p.keep_history,
                   created_at=p.created_at, last_login_at=p.last_login_at)
    return out


def biblio_out(b: Biblio, avail: dict | None = None, *, full: bool = False) -> dict:
    out = {
        "id": b.id, "title": b.title, "subtitle": b.subtitle, "authors": b.authors or [],
        "isbn": b.isbn, "publisher": b.publisher, "pub_year": b.pub_year,
        "language": b.language, "material_type": b.material_type, "subjects": b.subjects or [],
        "classification": b.classification, "audience": b.audience, "cover_url": b.cover_url,
        "series": b.series,
    }
    if avail is not None:
        out["availability"] = avail
    if full:
        out.update(description=b.description, edition=b.edition, pages=b.pages, issn=b.issn,
                   ai_enriched=b.ai_enriched, created_at=b.created_at, updated_at=b.updated_at,
                   has_marc=bool(b.marc_xml))
    return out


def item_out(i: Item, *, with_biblio: bool = False) -> dict:
    out = {
        "id": i.id, "biblio_id": i.biblio_id, "barcode": i.barcode, "status": i.status.value,
        "branch": {"id": i.branch.id, "code": i.branch.code, "name": i.branch.name},
        "item_type": {"id": i.item_type.id, "code": i.item_type.code, "name": i.item_type.name},
        "call_number": i.call_number, "shelf_location": i.shelf_location, "price": money(i.price) if i.price else None,
        "times_borrowed": i.times_borrowed, "acquired_on": i.acquired_on, "notes": i.notes,
    }
    if with_biblio:
        out["biblio"] = {"id": i.biblio.id, "title": i.biblio.title, "authors": i.biblio.authors}
    return out


def loan_out(l: Loan, *, now: datetime | None = None) -> dict:
    from .models import utcnow

    now = now or utcnow()
    return {
        "id": l.id, "issued_at": l.issued_at, "due_at": l.due_at, "returned_at": l.returned_at,
        "renewals": l.renewals, "overdue": l.returned_at is None and l.due_at < now,
        "days_overdue": max(0, (now.date() - l.due_at.date()).days) if l.returned_at is None else 0,
        "fine_charged": money(l.fine_charged),
        "item": item_out(l.item, with_biblio=True),
        "patron": {"id": l.patron.id, "card_number": l.patron.card_number, "full_name": l.patron.full_name}
        if l.patron else None,
    }


def hold_out(h: Hold, position: int | None = None) -> dict:
    return {
        "id": h.id, "status": h.status.value, "created_at": h.created_at, "ready_at": h.ready_at,
        "expires_at": h.expires_at, "queue_position": position, "notes": h.notes,
        "biblio": {"id": h.biblio.id, "title": h.biblio.title, "authors": h.biblio.authors},
        "patron": {"id": h.patron.id, "card_number": h.patron.card_number, "full_name": h.patron.full_name},
        "pickup_branch": {"id": h.pickup_branch.id, "name": h.pickup_branch.name},
        "item": {"id": h.item.id, "barcode": h.item.barcode} if h.item else None,
    }
