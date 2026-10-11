"""First-launch setup: the browser wizard at /setup.

Two ways in:

* **Bootstrap** - the database has no administrator (``pip install`` + ``librowise run``, a fresh Docker
  container). Anyone who can reach the server could otherwise claim it, so the wizard asks for a one-time
  *setup code* that only the operator can see: it is written to the server log at start-up and printed by
  ``librowise setup-code``. Finishing creates the first administrator and signs them in.
* **Admin** - an administrator exists but the library is not configured yet (``librowise instance create``
  arms this). After signing in, the administrator is taken to the wizard, which can also be skipped.

Finishing applies everything in one transaction: library name, branches, item types and patron
categories for the chosen kind of library, the default lending rule, and optionally a sample catalogue.
"""

from __future__ import annotations

import hmac
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import Biblio, Branch, CirculationRule, ItemType, Patron, PatronCategory, Role, Setting, utcnow
from ..security import hash_password, password_problems, seal, unseal
from . import settings as settings_svc

log = logging.getLogger("librowise.setup")

STATE_KEY = "setup"  # {"status": "pending" | "skipped" | "completed", "at": iso, "by": patron id}
CODE_KEY = "setup_code"  # {"sealed": ..., "created": iso} while no administrator exists
_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"  # no 0/O, 1/I
CODE_RE = re.compile(r"^[A-Z0-9]{8}$")
BRANCH_CODE_RE = re.compile(r"^[A-Z0-9_-]{1,16}$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9._@-]{3,64}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
STARTS = ("empty", "sample", "import")


class SetupError(ValueError):
    """A validation problem; ``field`` names the wizard field it belongs to."""

    def __init__(self, field: str, message: str, code: str = "invalid") -> None:
        super().__init__(message)
        self.field = field
        self.code = code


# ------------------------------------------------------------------ presets (kinds of library)


@dataclass(frozen=True)
class Preset:
    key: str
    item_types: tuple[tuple[str, str, bool, int], ...]  # code, name, holdable, replacement cost (minor units)
    categories: tuple[tuple[str, str, int, int, int], ...]  # code, name, max loans, max holds, membership months
    loan_days: int
    max_renewals: int
    fine_per_day: int  # minor units
    fine_cap: int
    hold_pickup_days: int
    # extra rules: (category code | None, item type code | None, loan days, renewals, fine/day, fine cap)
    rules: tuple[tuple[str | None, str | None, int, int, int, int], ...] = ()

    @property
    def primary_category(self) -> str:
        return self.categories[0][0]


_STAFF = ("STAFF", "Library staff", 50, 20, 120)
PRESETS: dict[str, Preset] = {
    "public": Preset(
        "public",
        item_types=(("BOOK", "Book", True, 50000), ("REF", "Reference", False, 150000), ("DVD", "DVD", True, 80000),
                    ("MAG", "Magazine", False, 20000), ("AUDIO", "Audiobook", True, 60000)),
        categories=(("ADULT", "Adult", 10, 5, 24), ("CHILD", "Child", 5, 3, 12), _STAFF),
        loan_days=14, max_renewals=2, fine_per_day=200, fine_cap=10000, hold_pickup_days=7,
        rules=((None, "DVD", 7, 1, 500, 15000), (None, "REF", 1, 0, 1000, 20000), (None, "MAG", 7, 0, 100, 2000),
               ("CHILD", None, 14, 2, 0, 0)),
    ),
    "academic": Preset(
        "academic",
        item_types=(("BOOK", "Book", True, 50000), ("REF", "Reference", False, 150000), ("THESIS", "Thesis", False, 0),
                    ("MAG", "Journal issue", False, 20000), ("DVD", "DVD", True, 80000)),
        categories=(("STUDENT", "Student", 8, 5, 12), ("FACULTY", "Faculty", 30, 15, 36), _STAFF),
        loan_days=21, max_renewals=3, fine_per_day=100, fine_cap=5000, hold_pickup_days=5,
        rules=(("FACULTY", None, 60, 5, 0, 0), (None, "REF", 1, 0, 1000, 20000), (None, "MAG", 3, 0, 100, 2000)),
    ),
    "school": Preset(
        "school",
        item_types=(("BOOK", "Book", True, 30000), ("REF", "Reference", False, 80000), ("MAG", "Magazine", False, 10000)),
        categories=(("PUPIL", "Pupil", 3, 2, 12), ("TEACHER", "Teacher", 20, 10, 36), _STAFF),
        loan_days=14, max_renewals=1, fine_per_day=0, fine_cap=0, hold_pickup_days=5,
        rules=(("TEACHER", None, 30, 3, 0, 0), (None, "REF", 1, 0, 0, 0)),
    ),
    "special": Preset(
        "special",
        item_types=(("BOOK", "Book", True, 80000), ("REF", "Reference", False, 150000), ("REPORT", "Report", True, 0)),
        categories=(("MEMBER", "Member", 15, 10, 36), _STAFF),
        loan_days=28, max_renewals=3, fine_per_day=0, fine_cap=0, hold_pickup_days=7,
        rules=((None, "REF", 3, 0, 0, 0),),
    ),
}


def preset_out(p: Preset) -> dict:
    return {"key": p.key, "loan_days": p.loan_days, "max_renewals": p.max_renewals, "fine_per_day": p.fine_per_day,
            "fine_cap": p.fine_cap, "hold_pickup_days": p.hold_pickup_days,
            "max_loans": p.categories[0][2], "primary_category": p.primary_category,
            "item_types": [{"code": c, "name": n, "holdable": h} for c, n, h, _ in p.item_types],
            "categories": [{"code": c, "name": n, "max_loans": m} for c, n, m, _, _ in p.categories]}


# ------------------------------------------------------------------ state


def has_admin(db: Session) -> bool:
    return bool(db.scalar(select(Patron.id).where(Patron.role == Role.admin, Patron.deleted_at.is_(None)).limit(1)))


def state(db: Session) -> dict:
    row = db.get(Setting, STATE_KEY)
    return dict(row.value) if row is not None and isinstance(row.value, dict) else {}


def status(db: Session) -> str:
    """``bootstrap`` (no administrator yet), ``pending``, ``skipped``, ``completed`` or ``none`` (never armed:
    databases configured before the wizard existed, and the test suite)."""
    if not has_admin(db):
        return "bootstrap"
    return state(db).get("status") or "none"


def _put(db: Session, key: str, value: Any) -> None:
    row = db.get(Setting, key)
    if row is None:
        db.add(Setting(key=key, value=value, description="First-launch setup (managed by the setup wizard)"))
    else:
        row.value = value
    db.flush()


def arm_if_new(db: Session) -> bool:
    """Mark setup as pending for a database nobody has configured (no lending rules yet).

    Called when the first administrator is created outside the wizard (``instance create``, ``create-admin``)."""
    if db.get(Setting, STATE_KEY) is not None or db.scalar(select(CirculationRule.id).limit(1)):
        return False
    _put(db, STATE_KEY, {"status": "pending", "at": utcnow().isoformat()})
    return True


def mark(db: Session, status_: str, actor: Patron | None = None, **extra: Any) -> None:
    _put(db, STATE_KEY, {**state(db), "status": status_, "at": utcnow().isoformat(),
                         "by": actor.id if actor else None, **extra})


# ------------------------------------------------------------------ one-time setup code


def _new_code() -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))


def format_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def normalise_code(value: str) -> str:
    return re.sub(r"[\s-]", "", value or "").upper()


def ensure_code(db: Session, *, rotate: bool = False) -> str | None:
    """The current setup code (created if needed) while no administrator exists; ``None`` afterwards."""
    if has_admin(db):
        return None
    row = db.get(Setting, CODE_KEY)
    if row is not None and not rotate and isinstance(row.value, dict):
        code = unseal(str(row.value.get("sealed", "")), "setup-code")
        if code:
            return code
    code = _new_code()
    value = {"sealed": seal(code, "setup-code"), "created": utcnow().isoformat()}
    try:
        with db.begin_nested():
            _put(db, CODE_KEY, value)
    except IntegrityError:  # another worker created it first: use theirs
        db.expire_all()
        return ensure_code(db)
    return code


def check_code(db: Session, value: str) -> bool:
    row = db.get(Setting, CODE_KEY)
    if row is None or not isinstance(row.value, dict):
        return False
    expected = unseal(str(row.value.get("sealed", "")), "setup-code") or ""
    given = normalise_code(value)
    return bool(expected) and hmac.compare_digest(given.encode(), expected.encode())


def announce_code(db: Session) -> None:
    """Start-up hook: put the setup code in the server log while the server is unclaimed."""
    code = ensure_code(db)
    if code:
        db.commit()
        log.warning("No administrator yet. Open /setup in a browser and enter the setup code %s "
                    "(also shown by `librowise setup-code`).", format_code(code))


# ------------------------------------------------------------------ wizard data


def snapshot(db: Session) -> dict:
    """What the wizard pre-fills from: existing name, branches, rules and catalogue size."""
    default_rule = db.scalar(select(CirculationRule).where(
        CirculationRule.branch_id.is_(None), CirculationRule.category_id.is_(None), CirculationRule.item_type_id.is_(None)))
    return {
        "library_name": settings_svc.get(db, "library_name") or "",
        "branches": [{"id": b.id, "code": b.code, "name": b.name, "address": b.address or "", "email": b.email or "",
                      "phone": b.phone or ""} for b in db.scalars(select(Branch).order_by(Branch.id))],
        "item_types": [t.code for t in db.scalars(select(ItemType).order_by(ItemType.id))],
        "categories": [c.code for c in db.scalars(select(PatronCategory).order_by(PatronCategory.id))],
        "default_rule": None if default_rule is None else {
            "loan_days": default_rule.loan_days, "max_renewals": default_rule.max_renewals,
            "fine_per_day": default_rule.fine_per_day, "fine_cap": default_rule.fine_cap,
            "hold_pickup_days": default_rule.hold_pickup_days},
        "records": db.scalar(select(func.count()).select_from(Biblio).where(Biblio.deleted_at.is_(None))) or 0,
    }


def _clean(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def validate(db: Session, data: dict, *, need_admin: bool) -> dict:
    """Normalise the wizard's payload; raises :class:`SetupError` on the first problem."""
    lib = data.get("library") or {}
    name = _clean(lib.get("name"), 200)
    if not name:
        raise SetupError("library.name", "Enter your library's name.", "required")
    if len(name) > 120:
        raise SetupError("library.name", "Keep the name to 120 characters or fewer.", "too_long")
    kind = lib.get("kind") or "public"
    if kind not in PRESETS:
        raise SetupError("library.kind", "Choose a kind of library.", "invalid")

    admin = None
    if need_admin:
        a = data.get("admin") or {}
        admin = {k: _clean(a.get(k), 120) for k in ("first_name", "last_name", "username", "email")}
        admin["password"] = str(a.get("password") or "")
        for key in ("first_name", "username", "email"):
            if not admin[key]:
                raise SetupError(f"admin.{key}", "This field is required.", "required")
        if not USERNAME_RE.match(admin["username"]):
            raise SetupError("admin.username", "Use 3-64 letters, digits, dots, hyphens or underscores.", "username")
        if not EMAIL_RE.match(admin["email"]):
            raise SetupError("admin.email", "Enter a valid e-mail address.", "email")
        if problems := password_problems(admin["password"]):
            raise SetupError("admin.password", "Password " + "; ".join(problems) + ".", "weak_password")
        lowered = admin["password"].lower()
        if any(len(s) >= 3 and s.lower() in lowered for s in (admin["username"], admin["first_name"],
                                                                admin["email"].split("@")[0])):
            raise SetupError("admin.password", "The password must not contain your name or username.", "personal")
        taken = db.scalar(select(Patron.id).where((Patron.card_number == admin["username"]) |
                                                  (Patron.email == admin["email"].lower())).limit(1))
        if taken:
            raise SetupError("admin.username", "An account with this username or e-mail already exists.", "taken")

    branches_in = data.get("branches") or []
    if not branches_in:
        raise SetupError("branches", "Add at least one branch.", "required")
    if len(branches_in) > 50:
        raise SetupError("branches", "Add up to 50 branches here; more can be added later.", "too_many")
    existing = {b.id: b for b in db.scalars(select(Branch))}
    branches, codes = [], set()
    for i, b in enumerate(branches_in):
        bid = b.get("id")
        if bid is not None and bid not in existing:
            raise SetupError(f"branches.{i}.id", "That branch no longer exists. Reload the page.", "stale")
        code = _clean(b.get("code"), 16).upper()
        bname = _clean(b.get("name"), 120)
        if not bname:
            raise SetupError(f"branches.{i}.name", "Enter the branch name.", "required")
        if not BRANCH_CODE_RE.match(code):
            raise SetupError(f"branches.{i}.code", "Use 1-16 capital letters, digits, hyphens or underscores.", "code")
        if code in codes:
            raise SetupError(f"branches.{i}.code", "Each branch needs a different code.", "duplicate")
        clash = next((x for x in existing.values() if x.code == code and x.id != bid), None)
        if clash is not None:
            raise SetupError(f"branches.{i}.code", "Another branch already uses this code.", "duplicate")
        email = _clean(b.get("email"), 120)
        if email and not EMAIL_RE.match(email):
            raise SetupError(f"branches.{i}.email", "Enter a valid e-mail address.", "email")
        codes.add(code)
        branches.append({"id": bid, "code": code, "name": bname, "address": _clean(b.get("address"), 255) or None,
                         "email": email or None, "phone": _clean(b.get("phone"), 40) or None})

    preset = PRESETS[kind]
    loans_in = data.get("loans") or {}
    limits = {"loan_days": (1, 365), "max_renewals": (0, 20), "max_loans": (1, 500), "hold_pickup_days": (1, 60),
              "fine_per_day": (0, 10_000_00), "fine_cap": (0, 1_000_000_00)}
    defaults = preset_out(preset)
    loans = {}
    for key, (lo, hi) in limits.items():
        raw = loans_in.get(key, defaults[key])
        try:
            value = int(raw)
        except (TypeError, ValueError):
            raise SetupError(f"loans.{key}", "Enter a whole number.", "number") from None
        if not lo <= value <= hi:
            raise SetupError(f"loans.{key}", f"Enter a number from {lo} to {hi}.", "range")
        loans[key] = value

    start = data.get("start") or "empty"
    if start not in STARTS:
        raise SetupError("start", "Choose how to start.", "invalid")
    if start == "sample" and snapshot(db)["records"]:
        raise SetupError("start", "The catalogue already has records, so the sample catalogue is not offered.", "not_empty")
    return {"library": {"name": name, "kind": kind}, "admin": admin, "branches": branches, "loans": loans, "start": start}


def apply(db: Session, clean: dict, actor: Patron | None) -> dict:
    """Write the validated configuration; returns ``{"admin": Patron | None, "summary": {...}}``."""
    from . import audit

    preset = PRESETS[clean["library"]["kind"]]
    settings_svc.set_value(db, "library_name", clean["library"]["name"])

    # branches: update the ones the wizard edited, add the new ones
    branch_rows = []
    for b in clean["branches"]:
        row = db.get(Branch, b["id"]) if b["id"] else None
        if row is None:
            row = Branch(code=b["code"], name=b["name"])
            db.add(row)
        row.code, row.name, row.address, row.email, row.phone = b["code"], b["name"], b["address"], b["email"], b["phone"]
        branch_rows.append(row)
    db.flush()

    created = {"item_types": [], "categories": [], "rules": 0}
    itypes = {t.code: t for t in db.scalars(select(ItemType))}
    for code, name, holdable, cost in preset.item_types:
        if code not in itypes:
            itypes[code] = ItemType(code=code, name=name, holdable=holdable, replacement_cost=cost)
            db.add(itypes[code])
            created["item_types"].append(code)
    cats = {c.code: c for c in db.scalars(select(PatronCategory))}
    for code, name, max_loans, max_holds, months in preset.categories:
        if code not in cats:
            cats[code] = PatronCategory(code=code, name=name, max_loans=max_loans, max_holds=max_holds,
                                        enrollment_months=months)
            db.add(cats[code])
            created["categories"].append(code)
    db.flush()
    loans = clean["loans"]
    cats[preset.primary_category].max_loans = loans["max_loans"]

    rules = {(r.branch_id, r.category_id, r.item_type_id): r for r in db.scalars(select(CirculationRule))}
    default = rules.get((None, None, None))
    if default is None:
        default = CirculationRule()
        db.add(default)
        created["rules"] += 1
    for key in ("loan_days", "max_renewals", "fine_per_day", "fine_cap", "hold_pickup_days"):
        setattr(default, key, loans[key])
    for cat_code, itype_code, days, renewals, fine, cap in preset.rules:
        key = (None, cats[cat_code].id if cat_code else None, itypes[itype_code].id if itype_code else None)
        if key not in rules:
            db.add(CirculationRule(category_id=key[1], item_type_id=key[2], loan_days=days, max_renewals=renewals,
                                   fine_per_day=fine, fine_cap=cap, hold_pickup_days=loans["hold_pickup_days"]))
            created["rules"] += 1
    settings_svc.set_value(db, "self_registration_category", preset.primary_category)
    db.flush()

    admin = None
    if clean["admin"]:
        a = clean["admin"]
        admin = Patron(card_number=a["username"], email=a["email"].lower(), first_name=a["first_name"],
                       last_name=a["last_name"] or "", role=Role.admin, category_id=cats["STAFF"].id,
                       home_branch_id=branch_rows[0].id, password_hash=hash_password(a["password"]),
                       expires_on=utcnow().date() + timedelta(days=3650))
        db.add(admin)
        db.flush()
        row = db.get(Setting, CODE_KEY)
        if row is not None:
            db.delete(row)  # the code has done its job

    sample = 0
    if clean["start"] == "sample":
        sample = load_sample_catalogue(db, branch_rows, itypes)

    summary = {"library_name": clean["library"]["name"], "kind": preset.key, "branches": len(branch_rows),
               "created": created, "sample_records": sample, "start": clean["start"]}
    by = actor or admin
    mark(db, "completed", by, summary=summary)
    audit.record(db, "setup_completed", "settings", None, actor=by, **{k: v for k, v in summary.items() if k != "created"})
    return {"admin": admin, "summary": summary}


def load_sample_catalogue(db: Session, branches: list[Branch], itypes: dict[str, ItemType]) -> int:
    """About a hundred well-known titles with one or two copies each, spread over the branches.

    Bibliographic data only - no patrons, loans or demo passwords - so it is safe on a real server and can be
    deleted later like any other records."""
    from ..seed_data import BOOKS
    from . import catalog

    material_itype = {"dvd": "DVD", "serial": "MAG", "audiobook": "AUDIO"}
    fallback = itypes.get("BOOK") or next(iter(itypes.values()))
    count = 0
    for n, (title, authors, year, subjects, desc, material, audience, lang, ddc, isbn) in enumerate(BOOKS):
        b = catalog.create_biblio(db, {
            "title": title, "authors": authors, "pub_year": year if year and year > 1400 else None,
            "subjects": subjects, "description": desc, "material_type": material, "audience": audience,
            "language": lang, "classification": ddc, "isbn": isbn,
            "cover_url": f"https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg?default=false" if isbn else None,
        })
        itype = itypes.get(material_itype.get(material, "BOOK")) or fallback
        for copy in range(2 if material == "book" and n % 3 == 0 else 1):
            catalog.create_item(db, b, {"branch_id": branches[(n + copy) % len(branches)].id, "item_type_id": itype.id,
                                        "call_number": f"{ddc} {authors[0][:3].upper()}" if ddc and authors else None})
        count += 1
    db.flush()
    return count
