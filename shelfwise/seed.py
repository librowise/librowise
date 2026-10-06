"""Demo data generator: branches, rules, ~100 titles, patrons and a year of circulation history.

Demo accounts (local development only — change or remove in production):

    admin      / Shelfwise#Admin2026    (administrator)
    librarian  / Shelfwise#Staff2026    (librarian)
    1000000001 / Reader#Demo2026        (patron "Ananya Iyer")
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    Branch,
    Budget,
    CirculationRule,
    Hold,
    HoldStatus,
    Item,
    ItemStatus,
    ItemType,
    Loan,
    OrderStatus,
    Patron,
    PatronCategory,
    PurchaseOrder,
    Review,
    Role,
    Vendor,
    utcnow,
)
from .security import hash_password
from .seed_data import BOOKS, FIRST_NAMES, LAST_NAMES
from .services import catalog, circulation

DEMO_ACCOUNTS = {
    "admin": "Shelfwise#Admin2026",
    "librarian": "Shelfwise#Staff2026",
    "1000000001": "Reader#Demo2026",
}

MATERIAL_TO_ITYPE = {"book": "BOOK", "dvd": "DVD", "serial": "MAG", "audiobook": "AUDIO", "comic": "BOOK", "ebook": "BOOK"}


def seed_structure(db: Session) -> dict:
    branches = [
        Branch(code="MAIN", name="Central Library", address="1 Library Square", email="central@shelfwise.local", phone="+91 11 2345 0001"),
        Branch(code="EAST", name="East Branch", address="42 Lake Road", email="east@shelfwise.local", phone="+91 11 2345 0002"),
        Branch(code="UNIV", name="University Campus Library", address="Campus Block C", email="campus@shelfwise.local", phone="+91 11 2345 0003"),
    ]
    itypes = [
        ItemType(code="BOOK", name="Book", replacement_cost=50000),
        ItemType(code="REF", name="Reference", holdable=False, replacement_cost=150000),
        ItemType(code="DVD", name="DVD", replacement_cost=80000),
        ItemType(code="MAG", name="Magazine", holdable=False, replacement_cost=20000),
        ItemType(code="AUDIO", name="Audiobook", replacement_cost=60000),
    ]
    cats = [
        PatronCategory(code="ADULT", name="Adult", max_loans=10, max_holds=5, enrollment_months=24),
        PatronCategory(code="CHILD", name="Child", max_loans=5, max_holds=3, enrollment_months=12, block_fine_threshold=20000),
        PatronCategory(code="STUDENT", name="Student", max_loans=8, max_holds=5, enrollment_months=12),
        PatronCategory(code="FACULTY", name="Faculty", max_loans=30, max_holds=15, enrollment_months=36),
        PatronCategory(code="STAFF", name="Library staff", max_loans=50, max_holds=20, enrollment_months=120),
    ]
    db.add_all(branches + itypes + cats)
    db.flush()
    t = {i.code: i for i in itypes}
    c = {x.code: x for x in cats}
    b = {x.code: x for x in branches}
    db.add_all([
        CirculationRule(loan_days=14, max_renewals=2, fine_per_day=200, fine_cap=10000),
        CirculationRule(item_type_id=t["DVD"].id, loan_days=7, max_renewals=1, fine_per_day=500, fine_cap=15000),
        CirculationRule(item_type_id=t["REF"].id, loan_days=1, max_renewals=0, fine_per_day=1000, fine_cap=20000),
        CirculationRule(item_type_id=t["MAG"].id, loan_days=7, max_renewals=0, fine_per_day=100, fine_cap=2000),
        CirculationRule(category_id=c["STUDENT"].id, loan_days=21, max_renewals=3, fine_per_day=100, fine_cap=5000),
        CirculationRule(category_id=c["FACULTY"].id, loan_days=60, max_renewals=5, fine_per_day=0, fine_cap=0),
        CirculationRule(category_id=c["CHILD"].id, loan_days=14, max_renewals=2, fine_per_day=0, fine_cap=0),
        CirculationRule(branch_id=b["UNIV"].id, category_id=c["STUDENT"].id, loan_days=28, max_renewals=3, fine_per_day=100, fine_cap=5000),
    ])
    db.flush()
    return {"branches": b, "itypes": t, "cats": c}


def seed(db: Session, *, patrons: int = 60, history_days: int = 365, rng_seed: int = 42) -> dict:
    if db.scalar(select(Branch.id).limit(1)):
        raise RuntimeError("Database already contains data; use `reset` first")
    rng = random.Random(rng_seed)
    s = seed_structure(db)
    branches, itypes, cats = s["branches"], s["itypes"], s["cats"]
    branch_list = list(branches.values())
    today = utcnow().date()

    staff = [
        Patron(card_number="admin", email="admin@shelfwise.local", first_name="Ada", last_name="Admin", role=Role.admin,
               category_id=cats["STAFF"].id, home_branch_id=branches["MAIN"].id,
               password_hash=hash_password(DEMO_ACCOUNTS["admin"]), expires_on=today + timedelta(days=3650)),
        Patron(card_number="librarian", email="librarian@shelfwise.local", first_name="Lina", last_name="Librarian",
               role=Role.librarian, category_id=cats["STAFF"].id, home_branch_id=branches["MAIN"].id,
               password_hash=hash_password(DEMO_ACCOUNTS["librarian"]), expires_on=today + timedelta(days=3650)),
    ]
    db.add_all(staff)

    # ------------------------------------------------------------ catalogue
    biblios = []
    for title, authors, year, subjects, desc, material, audience, lang, ddc, isbn in BOOKS:
        b = catalog.create_biblio(db, {
            "title": title, "authors": authors, "pub_year": year if year and year > 1400 else None,
            "subjects": subjects, "description": desc, "material_type": material, "audience": audience,
            "language": lang, "classification": ddc, "isbn": isbn,
            "publisher": rng.choice(["Penguin Classics", "HarperCollins", "Vintage", "Oxford University Press",
                                     "Rupa Publications", "Pan Macmillan", "MIT Press", "Bloomsbury"]) if material == "book" else None,
            "pages": rng.randint(120, 900) if material in ("book", "comic") else None,
            "cover_url": f"https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg?default=false" if isbn else None,
        })
        b.created_at = utcnow() - timedelta(days=rng.randint(0, 900))
        biblios.append(b)
        n_copies = rng.choice([1, 1, 2, 2, 3]) if material == "book" else 1
        for _ in range(n_copies):
            itype = itypes[MATERIAL_TO_ITYPE.get(material, "BOOK")]
            catalog.create_item(db, b, {
                "branch_id": rng.choice(branch_list).id, "item_type_id": itype.id,
                "call_number": f"{ddc} {authors[0][:3].upper()}", "price": rng.choice([29900, 39900, 49900, 59900, 89900]),
                "acquired_on": today - timedelta(days=rng.randint(30, 2500)),
                "shelf_location": rng.choice(["Stacks", "New books", "Children's corner", "Quiet floor", None]),
            })
        if material == "book" and rng.random() < 0.15:  # a reference copy for some titles
            catalog.create_item(db, b, {"branch_id": branches["MAIN"].id, "item_type_id": itypes["REF"].id,
                                        "call_number": f"R {ddc}", "shelf_location": "Reference"})
    db.flush()
    for item in db.scalars(select(Item)):
        item.created_at = datetime.combine(item.acquired_on or today, datetime.min.time())

    # ------------------------------------------------------------ patrons
    people = []
    demo = Patron(card_number="1000000001", email="ananya@example.org", first_name="Ananya", last_name="Iyer",
                  category_id=cats["ADULT"].id, home_branch_id=branches["MAIN"].id, phone="+91 98765 43210",
                  password_hash=hash_password(DEMO_ACCOUNTS["1000000001"]), expires_on=today + timedelta(days=500))
    db.add(demo)
    people.append(demo)
    cat_weights = [("ADULT", 5), ("STUDENT", 4), ("CHILD", 2), ("FACULTY", 1)]
    for n in range(patrons - 1):
        fn, ln = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        code = rng.choices([c for c, _ in cat_weights], [w for _, w in cat_weights])[0]
        p = Patron(card_number=f"{1000000002 + n}", email=f"{fn.lower()}.{ln.lower()}{n}@example.org",
                   first_name=fn, last_name=ln, category_id=cats[code].id,
                   home_branch_id=rng.choice(branch_list).id,
                   expires_on=today + timedelta(days=rng.randint(-40, 700)),
                   keep_history=rng.random() > 0.08)
        db.add(p)
        people.append(p)
    db.flush()
    for p in people:
        p.created_at = utcnow() - timedelta(days=rng.randint(30, 900))

    # ------------------------------------------------------------ circulation history
    # Patrons have "taste" in a few subjects so recommendations have signal to learn from.
    loanable = [i for i in db.scalars(select(Item)) if i.item_type.code not in ("REF", "MAG")]
    by_subject: dict[str, list[Item]] = {}
    for i in loanable:
        for subj in i.biblio.subjects or []:
            by_subject.setdefault(subj.split(" -- ")[0], []).append(i)
    genres = [k for k, v in by_subject.items() if len(v) >= 3]
    librarian = staff[1]
    now = utcnow()
    events = []
    for p in people:
        taste = rng.sample(genres, k=min(3, len(genres)))
        lateness = rng.choice([0.05, 0.1, 0.1, 0.2, 0.45])
        for _ in range(rng.randint(2, 18)):
            pool = by_subject[rng.choice(taste)] if rng.random() < 0.75 else loanable
            events.append((now - timedelta(days=rng.randint(1, history_days), hours=rng.randint(0, 9)),
                           p, rng.choice(pool), lateness))
    events.sort(key=lambda e: e[0])
    for when, p, item, lateness in events:
        if item.status != ItemStatus.available or p.expires_on < when.date():
            continue
        try:
            res = circulation.checkout(db, p, item, branch_id=item.branch_id, actor=librarian, now=when, override=True)
        except Exception:
            continue
        period = (res.loan.due_at - when).days
        keep_days = rng.randint(3, max(4, period)) if rng.random() > lateness else period + rng.randint(1, 20)
        returned = when + timedelta(days=keep_days, hours=rng.randint(0, 8))
        if returned < now:
            circulation.checkin(db, item, branch_id=item.branch_id, actor=librarian, now=returned)
    db.flush()

    # ------------------------------------------------------------ holds, reviews, acquisitions
    popular = sorted(biblios, key=lambda b: -sum(i.times_borrowed for i in b.items))[:12]
    for rank, b in enumerate(popular[:8]):
        for p in rng.sample(people[1:], k=rng.randint(4, 7) if rank < 3 else rng.randint(1, 3)):
            try:
                circulation.place_hold(db, p, b, pickup_branch_id=p.home_branch_id, override=True)
            except Exception:
                pass
    for h in db.scalars(select(Hold).where(Hold.status == HoldStatus.queued)):
        h.created_at = now - timedelta(days=rng.randint(0, 20))
    for b in rng.sample(biblios, k=40):
        for p in rng.sample(people, k=rng.randint(1, 4)):
            rating = rng.choices([5, 4, 3, 2], [5, 4, 2, 1])[0]
            body = rng.choice(["Loved it — couldn't put it down.", "A classic for good reason.",
                               "Slow start but worth it.", "Great for book club discussion.", None, None])
            db.add(Review(patron_id=p.id, biblio_id=b.id, rating=rating, body=body))
    vendors = [Vendor(name="Rupa Book Distributors", email="orders@rupa.example", discount_pct=12.5),
               Vendor(name="Global Academic Supply", email="sales@gas.example", discount_pct=8),
               Vendor(name="MediaWorld AV", email="b2b@mediaworld.example", discount_pct=5)]
    db.add_all(vendors)
    budgets = [Budget(name="Adult fiction", fiscal_year=today.year, allocated=50_000_00),
               Budget(name="Children's", fiscal_year=today.year, allocated=25_000_00),
               Budget(name="Academic & reference", fiscal_year=today.year, allocated=120_000_00, branch_id=branches["UNIV"].id)]
    db.add_all(budgets)
    db.flush()
    for title, isbn, v, bud, qty, price, status in [
        ("Project Hail Mary", "9780593135204", 0, 0, 2, 69900, OrderStatus.ordered),
        ("The Midnight Library", "9780525559474", 0, 0, 3, 49900, OrderStatus.ordered),
        ("Designing Data-Intensive Applications", "9781449373320", 1, 2, 2, 349900, OrderStatus.ordered),
        ("The Gruffalo", "9780333710937", 0, 1, 4, 29900, OrderStatus.ordered),
        ("Oppenheimer (Blu-ray)", None, 2, 0, 1, 99900, OrderStatus.cancelled),
    ]:
        db.add(PurchaseOrder(vendor_id=vendors[v].id, budget_id=budgets[bud].id, title=title, isbn=isbn,
                             quantity=qty, unit_price=price, status=status))
    circulation.run_nightly(db)
    db.flush()
    seed_interop(db)
    return {
        "titles": len(biblios), "items": db.query(Item).count(), "patrons": len(people) + len(staff),
        "loans": db.query(Loan).count(), "open_loans": db.query(Loan).filter(Loan.returned_at.is_(None)).count(),
    }


# ---- interoperability ----

DEMO_SIP_ACCOUNT = ("selfcheck", "SelfCheck#Demo2026")  # local development only


def seed_interop(db: Session) -> None:
    """A demo SIP2 self-check account and the Library of Congress copy-cataloguing target."""
    from .interop.copycat import DEFAULT_TARGET
    from .models import CopyCatTarget, SipAccount

    main = db.scalar(select(Branch).where(Branch.code == "MAIN")) or db.scalar(select(Branch).limit(1))
    if main is not None and not db.scalar(select(SipAccount.id).where(SipAccount.login == DEMO_SIP_ACCOUNT[0])):
        db.add(SipAccount(login=DEMO_SIP_ACCOUNT[0], password_hash=hash_password(DEMO_SIP_ACCOUNT[1]),
                          name="Self-check kiosk (demo)", institution_id="SHELFWISE", branch_id=main.id,
                          allow_holds=True, allow_fee_paid=True, sort_bins={"hold": "2", "transfer": "3", "default": "1"}))
    if not db.scalar(select(CopyCatTarget.id).limit(1)):
        db.add(CopyCatTarget(**DEFAULT_TARGET))
    db.flush()

