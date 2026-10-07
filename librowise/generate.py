"""Fast synthetic data generator for load and performance testing.

``python -m librowise generate --biblios 100000 --patrons 20000 --loans 300000``

Bulk Core inserts (no ORM objects, no per-row index maintenance) with realistic shapes:
Zipf-distributed subject usage and title popularity, a long tail of light readers and a few
heavy ones, 1–4 copies per title, five years of circulation with ~4% of loans still open (some
overdue), late returns with fines and payments, and queued holds on popular titles. The
full-text index is rebuilt once at the end with a single ``INSERT … SELECT``.
"""

from __future__ import annotations

import bisect
import itertools
import random
import time
from array import array
from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy import func, insert, select, text

from .db import SessionLocal, get_engine
from .models import (
    Biblio,
    Branch,
    Hold,
    HoldStatus,
    Item,
    ItemStatus,
    ItemType,
    LedgerEntry,
    LedgerKind,
    Loan,
    Patron,
    PatronCategory,
    Role,
    utcnow,
)
from .seed_data import FIRST_NAMES, LAST_NAMES

SUBJECTS = [
    "Fiction", "Mystery fiction", "Detective and mystery stories", "Science fiction", "Fantasy fiction",
    "Romance fiction", "Historical fiction", "Thrillers (Fiction)", "Horror tales", "Short stories",
    "Poetry", "Drama", "Humorous stories", "Children's stories", "Picture books", "Young adult fiction",
    "Biography", "Autobiography", "Memoirs", "History", "World history", "India -- History",
    "Military history", "Ancient civilization", "Philosophy", "Ethics", "Religion", "Mythology",
    "Psychology", "Self-help", "Education", "Economics", "Finance, Personal", "Investing", "Business",
    "Management", "Marketing", "Entrepreneurship", "Political science", "Law", "Sociology",
    "Anthropology", "Mathematics", "Statistics", "Physics", "Quantum theory", "Chemistry", "Biology",
    "Evolution (Biology)", "Genetics", "Medicine", "Nutrition", "Health", "Fitness", "Astronomy",
    "Space exploration", "Earth sciences", "Climate change", "Ecology", "Environment", "Wildlife",
    "Botany", "Computer science", "Programming languages", "Python (Computer program language)",
    "Artificial intelligence", "Machine learning", "Data science", "Software engineering",
    "Computer networks", "Cybersecurity", "Robotics", "Engineering", "Architecture", "Art", "Painting",
    "Photography", "Music", "Film", "Cooking", "Baking", "Travel", "Gardening", "Sports", "Cricket",
    "Chess", "Language and languages", "English language -- Grammar", "Linguistics", "Literature",
    "Literary criticism", "Comics and graphic novels", "Adventure stories", "Sea stories", "Folklore",
    "Parenting", "Family", "Relationships", "Urban planning", "Transportation", "Agriculture",
]
DEWEY = {"Fiction": "823", "Poetry": "821", "History": "909", "Biography": "920", "Philosophy": "100",
         "Psychology": "150", "Religion": "200", "Economics": "330", "Law": "340", "Education": "370",
         "Mathematics": "510", "Astronomy": "520", "Physics": "530", "Chemistry": "540", "Biology": "570",
         "Medicine": "610", "Engineering": "620", "Cooking": "641.5", "Business": "650", "Art": "700",
         "Music": "780", "Sports": "796", "Literature": "800", "Travel": "910", "Computer science": "004"}
WORDS = (
    "shadow river garden empire secret silent last first winter summer city night ocean mountain stars "
    "memory journey stone fire glass paper golden broken hidden lost forgotten distant northern southern "
    "kingdom house road letter song light dark storm island forest desert machine code signal pattern "
    "theory history story science world mind heart life time age future past dream truth power game "
    "voyage harbour monsoon temple market river valley bridge tower clock library map compass atlas "
    "algorithm network data quantum atom cell gene planet galaxy orbit engine robot language number "
    "colour spice kitchen feast harvest field village school teacher student doctor soldier king queen"
).split()
DESCRIPTION_TEMPLATES = [
    "A {adj} {noun} about {topic} and the {noun2} that changes everything.",
    "An accessible introduction to {topic}, covering {topic2} and practical {noun2}s.",
    "This {adj} book explores {topic} through the eyes of a {noun} and a {noun2}.",
    "Winner of several awards, it blends {topic} with {topic2} in a {adj} narrative.",
    "A comprehensive guide to {topic} for readers new to {topic2}.",
    "Set in a {adj} {noun}, the story follows a search for a lost {noun2}.",
]
ADJECTIVES = ("gripping", "luminous", "definitive", "witty", "haunting", "practical", "lyrical", "brisk",
              "sweeping", "intimate", "rigorous", "playful", "timely", "classic")
PUBLISHERS = ["Penguin Random House", "HarperCollins", "Oxford University Press", "Cambridge University Press",
              "Rupa Publications", "Pan Macmillan", "MIT Press", "Bloomsbury", "Hachette", "Simon & Schuster",
              "Scholastic", "O'Reilly Media", "Springer", "Wiley", "Westland", "Aleph Book Company"]
LANGUAGES = [("en", 82), ("hi", 7), ("fr", 2), ("es", 2), ("de", 1), ("ta", 2), ("bn", 2), ("mr", 1), ("ur", 1)]
MATERIALS = [("book", 80), ("ebook", 7), ("audiobook", 4), ("dvd", 4), ("serial", 3), ("comic", 2)]
AUDIENCES = [("adult", 70), ("young_adult", 10), ("children", 20)]
MATERIAL_ITYPE = {"book": "BOOK", "ebook": "BOOK", "comic": "BOOK", "dvd": "DVD", "serial": "MAG", "audiobook": "AUDIO"}

CHUNK = 5000


def _weighted(rng: random.Random, pairs):
    values, weights = zip(*pairs, strict=True)
    return lambda: rng.choices(values, weights)[0]


class _Zipf:
    """Sample indexes 0..n-1 with P(i) ∝ 1/(i+1)^s (fast via cumulative weights + bisect)."""

    def __init__(self, n: int, s: float, rng: random.Random) -> None:
        self.cum = list(itertools.accumulate(1.0 / (i + 1) ** s for i in range(n)))
        self.total = self.cum[-1]
        self.rng = rng

    def __call__(self) -> int:
        return min(bisect.bisect_left(self.cum, self.rng.random() * self.total), len(self.cum) - 1)


def _isbn13(n: int) -> str:
    core = f"978{n % 10**9:09d}"
    total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(core))
    return core + str((10 - total % 10) % 10)


def _bulk(conn, model, rows: list[dict]) -> None:
    for i in range(0, len(rows), CHUNK):
        conn.execute(insert(model.__table__), rows[i:i + CHUNK])


def _next_id(conn, model) -> int:
    return int(conn.scalar(select(func.coalesce(func.max(model.id), 0))) or 0) + 1


def _fix_sequences(conn) -> None:
    if conn.dialect.name != "postgresql":
        return
    for table in ("biblios", "items", "patrons", "loans", "holds", "ledger"):
        conn.execute(text(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                          f"(SELECT coalesce(max(id), 1) FROM {table}))"))


def generate(*, biblios: int = 100_000, patrons: int = 20_000, loans: int = 300_000, seed: int = 7,
             index: bool = True, progress: Callable[[str], None] | None = None) -> dict:
    say = progress or (lambda _m: None)
    rng = random.Random(seed)
    started = time.perf_counter()
    now = utcnow().replace(microsecond=0)
    today = now.date()
    engine = get_engine()

    # Library structure (branches, item types, categories, rules) — reuse or create.
    db = SessionLocal()
    try:
        if not db.scalar(select(Branch.id).limit(1)):
            from .seed import seed_structure

            seed_structure(db)
            db.commit()
        branch_ids = list(db.scalars(select(Branch.id)))
        itypes = {t.code: t.id for t in db.scalars(select(ItemType))}
        cats = {c.code: c.id for c in db.scalars(select(PatronCategory))}
    finally:
        db.close()
    default_itype = itypes.get("BOOK") or next(iter(itypes.values()))
    pick_lang = _weighted(rng, LANGUAGES)
    pick_material = _weighted(rng, MATERIALS)
    pick_audience = _weighted(rng, AUDIENCES)
    subject_zipf = _Zipf(len(SUBJECTS), 1.05, rng)
    branch_weights = [max(1, 6 - i) for i in range(len(branch_ids))]
    author_pool = [f"{rng.choice(LAST_NAMES)}, {rng.choice(FIRST_NAMES)}" for _ in range(max(500, biblios // 8))]
    author_zipf = _Zipf(len(author_pool), 0.9, rng)
    stats: dict = {}

    with engine.begin() as conn:
        first_biblio = _next_id(conn, Biblio)
        first_item = _next_id(conn, Item)
        first_patron = _next_id(conn, Patron)
        first_loan = _next_id(conn, Loan)
        first_ledger = _next_id(conn, LedgerEntry)
        first_hold = _next_id(conn, Hold)

        # ------------------------------------------------------------------ plan (compact arrays)
        # Copies per title, then which item/patron each loan touches — decided up front so items
        # are inserted once with final borrow counters and statuses.
        copies = array("b", (1 + int(rng.random() < 0.35) + int(rng.random() < 0.12) + int(rng.random() < 0.05)
                             for _ in range(biblios)))
        cum_copies = list(itertools.accumulate(copies))
        n_items = cum_copies[-1] if cum_copies else 0
        item_order = list(range(n_items))
        rng.shuffle(item_order)  # popularity rank -> item offset
        patron_order = list(range(patrons))
        rng.shuffle(patron_order)
        item_zipf = _Zipf(max(n_items, 1), 0.8, rng)
        patron_zipf = _Zipf(max(patrons, 1), 0.6, rng)
        loan_item, loan_patron = array("i"), array("i")
        times_borrowed = array("i", bytes(4 * n_items))
        open_items: set[int] = set()
        open_loans: set[int] = set()
        n_open_target = int(loans * 0.04)
        for n in range(loans if n_items and patrons else 0):
            off = item_order[item_zipf()]
            loan_item.append(off)
            loan_patron.append(patron_order[patron_zipf()])
            times_borrowed[off] += 1
            if len(open_loans) < n_open_target and off not in open_items and rng.random() < 0.3:
                open_items.add(off)
                open_loans.add(n)

        # ------------------------------------------------------------------ catalogue
        t0 = time.perf_counter()
        biblio_rows, item_rows = [], []
        item_off = 0
        for n in range(biblios):
            bid = first_biblio + n
            material = pick_material()
            subjects = list(dict.fromkeys(SUBJECTS[subject_zipf()] for _ in range(rng.choice((1, 2, 2, 3)))))
            authors = list(dict.fromkeys(author_pool[author_zipf()] for _ in range(rng.choice((1, 1, 1, 2)))))
            w = rng.sample(WORDS, 4)
            title = rng.choice((
                f"The {w[0].title()} {w[1].title()}", f"{w[0].title()} of the {w[1].title()}",
                f"A {w[0].title()} {w[1].title()} {w[2].title()}", f"{w[0].title()} and {w[1].title()}",
                f"Introduction to {subjects[0].split(' (')[0].split(' --')[0]}", f"The {w[2].title()} Book of {w[3].title()}",
            ))
            topic, topic2 = subjects[0].lower(), SUBJECTS[subject_zipf()].lower()
            desc = " ".join(rng.choice(DESCRIPTION_TEMPLATES).format(
                adj=rng.choice(ADJECTIVES), noun=rng.choice(WORDS), noun2=rng.choice(WORDS), topic=topic, topic2=topic2)
                for _ in range(rng.choice((1, 2, 2, 3))))
            year = int(min(today.year, max(1850, rng.triangular(1900, today.year + 1, today.year - 4))))
            created = now - timedelta(days=rng.triangular(0, 5 * 365, 30), seconds=rng.randint(0, 86399))
            biblio_rows.append({
                "id": bid, "title": title, "subtitle": None, "authors": authors,
                "isbn": _isbn13(seed * 10_000_000 + bid) if rng.random() < 0.9 else None, "issn": None,
                "publisher": rng.choice(PUBLISHERS), "pub_year": year, "edition": None, "language": pick_lang(),
                "material_type": material, "subjects": subjects,
                "series": None if rng.random() < 0.9 else f"{w[3].title()} series",
                "pages": rng.randint(48, 900) if material in ("book", "comic") else None, "description": desc,
                "classification": DEWEY.get(subjects[0].split(" ")[0], f"{rng.randint(0, 999):03d}"),
                "audience": pick_audience(), "cover_url": None, "marc_xml": None, "ai_enriched": False,
                "deleted_at": None, "created_at": created, "updated_at": created,
            })
            for _ in range(copies[n]):
                iid = first_item + item_off
                item_rows.append({
                    "id": iid, "biblio_id": bid, "barcode": f"GB{iid:010d}",
                    "branch_id": rng.choices(branch_ids, branch_weights)[0],
                    "item_type_id": itypes.get(MATERIAL_ITYPE[material], default_itype),
                    "call_number": None, "shelf_location": None,
                    "status": (ItemStatus.on_loan if item_off in open_items else ItemStatus.available).name,
                    "price": rng.randint(150, 2500) * 100, "acquired_on": created.date(),
                    "times_borrowed": times_borrowed[item_off], "last_seen_at": None, "notes": None,
                    "deleted_at": None, "created_at": created, "updated_at": created,
                })
                item_off += 1
            if len(biblio_rows) >= CHUNK:
                _bulk(conn, Biblio, biblio_rows)
                _bulk(conn, Item, item_rows)
                biblio_rows, item_rows = [], []
        _bulk(conn, Biblio, biblio_rows)
        _bulk(conn, Item, item_rows)
        say(f"catalogue: {biblios:,} titles, {n_items:,} items in {time.perf_counter() - t0:.1f}s")

        # ------------------------------------------------------------------ patrons
        t0 = time.perf_counter()
        cat_codes = [c for c in ("ADULT", "STUDENT", "CHILD", "FACULTY") if c in cats] or list(cats)
        cat_weights = {"ADULT": 60, "STUDENT": 25, "CHILD": 10, "FACULTY": 5}
        patron_rows = []
        for n in range(patrons):
            pid = first_patron + n
            fn, ln = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
            created = now - timedelta(days=rng.randint(0, 6 * 365))
            patron_rows.append({
                "id": pid, "card_number": f"7{pid:09d}", "email": f"{fn.lower()}.{ln.lower()}.{pid}@example.invalid",
                "first_name": fn, "last_name": ln, "phone": None, "address": None, "date_of_birth": None,
                "category_id": cats[rng.choices(cat_codes, [cat_weights.get(c, 10) for c in cat_codes])[0]],
                "home_branch_id": rng.choices(branch_ids, branch_weights)[0], "role": Role.patron.name,
                "password_hash": None, "expires_on": today + timedelta(days=rng.randint(-60, 900)),
                "is_active": rng.random() > 0.01, "notes": None, "preferences": {},
                "keep_history": rng.random() > 0.05, "last_login_at": None, "deleted_at": None,
                "created_at": created, "updated_at": created,
            })
            if len(patron_rows) >= CHUNK:
                _bulk(conn, Patron, patron_rows)
                patron_rows = []
        _bulk(conn, Patron, patron_rows)
        say(f"patrons: {patrons:,} in {time.perf_counter() - t0:.1f}s")

        # ------------------------------------------------------------------ circulation
        t0 = time.perf_counter()
        loan_rows, ledger_rows = [], []
        n_ledger = 0
        for n in range(len(loan_item)):
            lid, iid, pid = first_loan + n, first_item + loan_item[n], first_patron + loan_patron[n]
            is_open = n in open_loans
            issued = now - timedelta(days=rng.uniform(0, 45) if is_open else rng.uniform(1, 5 * 365))
            due = datetime.combine((issued + timedelta(days=rng.choice((14, 14, 21, 28)))).date(),
                                   datetime.min.time()) + timedelta(hours=23, minutes=59)
            returned, fine = None, 0
            if not is_open:
                late = rng.random() < 0.15
                returned = due + timedelta(days=rng.uniform(1, 30)) if late else issued + timedelta(days=rng.uniform(1, 13))
                returned = min(returned, now - timedelta(minutes=1))
                if late and returned > due:
                    fine = min((returned.date() - due.date()).days * 200, 10000)
            loan_rows.append({
                "id": lid, "item_id": iid, "patron_id": pid, "branch_id": rng.choice(branch_ids), "issued_at": issued,
                "due_at": due, "returned_at": returned, "renewals": int(rng.random() < 0.2), "fine_charged": fine,
                "issued_by_id": None, "created_at": issued, "updated_at": returned or issued,
            })
            if fine:
                ledger_rows.append({"id": first_ledger + n_ledger, "patron_id": pid, "loan_id": lid,
                                    "kind": LedgerKind.overdue.name, "amount": fine, "note": "Overdue",
                                    "created_at": returned, "created_by_id": None})
                n_ledger += 1
                if rng.random() < 0.7:
                    ledger_rows.append({"id": first_ledger + n_ledger, "patron_id": pid, "loan_id": None,
                                        "kind": LedgerKind.payment.name, "amount": -fine, "note": "Payment",
                                        "created_at": returned + timedelta(days=rng.randint(0, 20)), "created_by_id": None})
                    n_ledger += 1
            if len(loan_rows) >= CHUNK:
                _bulk(conn, Loan, loan_rows)
                _bulk(conn, LedgerEntry, ledger_rows)
                loan_rows, ledger_rows = [], []
        _bulk(conn, Loan, loan_rows)
        _bulk(conn, LedgerEntry, ledger_rows)
        say(f"loans: {len(loan_item):,} ({len(open_loans):,} open) in {time.perf_counter() - t0:.1f}s")

        # Holds: queued requests concentrated on popular titles
        hold_rows, seen = [], set()
        popular = [first_biblio + bisect.bisect_right(cum_copies, item_order[i]) for i in range(min(2000, n_items))]
        for _ in range(min(patrons // 10, 5000) if popular else 0):
            pid, bid = first_patron + patron_order[patron_zipf()], rng.choice(popular)
            if (pid, bid) in seen:
                continue
            seen.add((pid, bid))
            hold_rows.append({"id": first_hold + len(hold_rows), "biblio_id": bid, "patron_id": pid, "item_id": None,
                              "pickup_branch_id": rng.choice(branch_ids), "status": HoldStatus.queued.name,
                              "ready_at": None, "expires_at": None, "notes": None,
                              "created_at": now - timedelta(days=rng.uniform(0, 60)), "updated_at": now})
        _bulk(conn, Hold, hold_rows)
        _fix_sequences(conn)
    stats.update(biblios=biblios, items=n_items, patrons=patrons, loans=len(loan_item), open_loans=len(open_loans),
                 ledger_entries=n_ledger, holds=len(hold_rows))

    if index:
        t0 = time.perf_counter()
        from .services.catalog import reindex_all

        db = SessionLocal()
        try:
            stats["indexed"] = reindex_all(db)
            db.commit()
        finally:
            db.close()
        say(f"search index: {stats['indexed']:,} records in {time.perf_counter() - t0:.1f}s")
    with engine.begin() as conn:  # refresh planner statistics
        conn.execute(text("ANALYZE"))
    stats["seconds"] = round(time.perf_counter() - started, 1)
    return stats
