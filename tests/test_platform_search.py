"""Search internals on both databases, semantic index maintenance, recommendations, generator."""

from __future__ import annotations

import random
from collections import Counter
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from shelfwise.ai import recommend, semantic
from shelfwise.config import get_settings
from shelfwise.db import search_backend
from shelfwise.models import Biblio, Item, ItemStatus, Loan, utcnow
from shelfwise.services import catalog, circulation


@pytest.fixture()
def shelf(db, make_book):
    make_book("The Hobbit", authors=["Tolkien, J. R. R."], subjects=["Fantasy fiction", "Dragons"], pub_year=1937)
    make_book("A Hobbit's Guide to Gardening", authors=["Green, Pat"], subjects=["Gardening"], pub_year=2020,
              material_type="book", language="en")
    make_book("Dune", authors=["Herbert, Frank"], subjects=["Science fiction"], pub_year=1965)
    make_book("Dune Messiah", authors=["Herbert, Frank"], subjects=["Science fiction"], pub_year=1969)
    make_book("Ögedei Khan", authors=["Ünal, Öykü"], subjects=["Mongolia — History"], pub_year=2011, language="tr")
    make_book("Cosmos", authors=["Sagan, Carl"], subjects=["Astronomy", "Science fiction"], pub_year=1980,
              material_type="dvd", description="A personal voyage through the universe.")
    return db


def titles(db, ids):
    return [b.title for b in catalog.load_biblios(db, ids)]


def test_counts_sorting_and_pagination_in_sql(shelf):
    db = shelf
    r = catalog.search(db, None, sort="title", per_page=2)
    assert r.total == 6 and titles(db, r.ids) == ["A Hobbit's Guide to Gardening", "Cosmos"]
    r2 = catalog.search(db, None, sort="title", per_page=2, page=3)
    assert set(titles(db, r2.ids)) == {"Ögedei Khan", "The Hobbit"}  # order of Ö depends on the collation
    assert titles(db, catalog.search(db, None, sort="year_desc", per_page=1).ids) == ["A Hobbit's Guide to Gardening"]
    assert titles(db, catalog.search(db, None, sort="year_asc", per_page=1).ids) == ["The Hobbit"]
    assert catalog.search(db, None, page=99).ids == []


def test_facets_are_exact_and_ordered(shelf):
    r = catalog.search(shelf, None)
    f = r.facets
    assert dict(f["material_type"]) == {"book": 5, "dvd": 1}
    assert f["subject"][0] == ("Science fiction", 3)
    assert ("Herbert, Frank", 2) in f["author"]
    assert f["decade"][0] == ("2020s", 1) and ("1960s", 2) in f["decade"]
    assert catalog.search(shelf, None, facets=False).facets == {}


def test_json_array_filters(shelf):
    db = shelf
    assert catalog.search(db, None, catalog.SearchFilters(subject="science FICTION")).total == 3
    assert catalog.search(db, None, catalog.SearchFilters(author="herbert")).total == 2
    assert catalog.search(db, None, catalog.SearchFilters(author="öykü")).total == 1  # Unicode case folding
    assert catalog.search(db, None, catalog.SearchFilters(subject="mongolia — history")).total == 1
    assert catalog.search(db, None, catalog.SearchFilters(author="100%_")).total == 0  # LIKE wildcards escaped
    r = catalog.search(db, "dune", catalog.SearchFilters(author="herbert", year_from=1966))
    assert titles(db, r.ids) == ["Dune Messiah"]


def test_availability_and_branch_filters(shelf, lib):
    db = shelf
    hobbit = db.scalar(select(Biblio).where(Biblio.title == "The Hobbit"))
    item = hobbit.items[0]
    circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id)
    db.commit()
    assert catalog.search(db, None, catalog.SearchFilters(available_only=True)).total == 5
    east = lib["branches"]["EAST"].id
    assert catalog.search(db, None, catalog.SearchFilters(branch_id=east)).total == 0
    item.branch_id = east
    db.commit()
    assert titles(db, catalog.search(db, None, catalog.SearchFilters(branch_id=east)).ids) == ["The Hobbit"]


def test_keyword_ranking_prefix_isbn_and_reindex(shelf, make_book):
    db = shelf
    b, _ = make_book("Prefix Test", isbn="9780306406157")
    assert titles(db, catalog.search(db, "hobb").ids)[0] == "The Hobbit"
    assert catalog.search(db, "9780306406157").ids == [b.id]
    assert catalog.search(db, "dune mess").total == 1  # AND + prefix on the last term
    assert catalog.search(db, "universe").ids  # description field is indexed
    assert catalog.search(db, "tolkien").total == 1
    assert catalog.search(db, "!!!").total == 7  # no searchable terms → browse
    n = catalog.reindex_all(db)
    db.commit()
    assert n == 7
    assert catalog.search(db, "gardening").total == 1
    assert catalog.search(db, "carl sagan").total == 1
    assert catalog._candidate_ids(db, "science")


def test_update_and_delete_keep_index_in_sync(db, make_book):
    b, _ = make_book("Original Wording")
    catalog.update_biblio(db, b, {"title": "Completely Revised"})
    db.commit()
    assert catalog.search(db, "original").total == 0 and catalog.search(db, "revised").total == 1
    catalog.delete_biblio(db, b)
    db.commit()
    assert catalog.search(db, "revised").total == 0
    assert catalog.reindex_all(db) == 0


def test_postgres_websearch_syntax(shelf):
    if search_backend(shelf) != "tsvector":
        pytest.skip("PostgreSQL tsvector search")
    db = shelf
    assert titles(db, catalog.search(db, "hobbit -gardening").ids) == ["The Hobbit"]
    assert catalog.search(db, '"dune messiah"').total == 1
    assert catalog.search(db, "cosmos OR gardening").total == 2
    assert catalog.search(db, "dragons").total == 1  # subjects weight C
    assert catalog.pg_tsquery("hello world")[1]["tsq_last"] == "world:*"


def test_filter_ids_and_smart_search_filters_only(shelf, client):
    db = shelf
    ids = list(db.scalars(select(Biblio.id)))
    assert catalog.filter_ids(db, catalog.SearchFilters(material_type="dvd"), ids + [999999]) == {
        db.scalar(select(Biblio.id).where(Biblio.title == "Cosmos"))}
    r = client.get("/api/v1/search/smart", params={"q": "dvds"}).json()
    assert r["total"] == 1 and r["results"][0]["title"] == "Cosmos"


# ------------------------------------------------------------------ semantic index


def test_semantic_index_is_incremental(db, make_book):
    a, _ = make_book("Stars and Galaxies", subjects=["Astronomy"])
    assert semantic.index.search(db, "astronomy")[0][0] == a.id
    view = semantic.index.get(db)
    base = view.base
    b, _ = make_book("Planets for Beginners", subjects=["Astronomy"], description="Planets and stars")
    hits = [i for i, _ in semantic.index.search(db, "planets")]
    assert hits[0] == b.id
    view = semantic.index.get(db)
    assert view.base is base and b.id in view.overlay and view.live == 2  # no rebuild
    catalog.update_biblio(db, a, {"title": "Cookery Basics", "subjects": ["Cooking"]})
    db.commit()
    assert a.id not in [i for i, _ in semantic.index.search(db, "galaxies")]
    assert semantic.index.search(db, "cookery")[0][0] == a.id
    catalog.delete_biblio(db, b)
    db.commit()
    assert b.id not in [i for i, _ in semantic.index.search(db, "planets")]
    assert semantic.index.get(db).live == 1
    sim = semantic.index.similar(db, a.id)
    assert all(i != a.id for i, _ in sim)


def test_semantic_snapshot_roundtrip_and_tamper_check(db, make_book, tmp_path, monkeypatch):
    monkeypatch.setenv("SHELFWISE_CACHE_DIR", str(tmp_path))
    get_settings.cache_clear()
    make_book("Ocean Voyages", subjects=["Sea stories"], description="Sailing ships and whales.")
    make_book("Desert Roads", subjects=["Travel"])
    info = semantic.index.warm(db)
    assert info["docs"] == 2 and info["snapshot_bytes"] > 0
    key = semantic.index._db_key(db)
    loaded = semantic.load_snapshot(key)
    current = semantic.index.get(db).base
    assert loaded is not None and loaded.n_docs == 2 and set(loaded.postings) == set(current.postings)
    assert list(loaded.postings["ocean"][0]) == list(current.postings["ocean"][0])
    path = semantic._snapshot_path(key)
    data = bytearray(path.read_bytes())
    data[-5] ^= 0xFF
    path.write_bytes(bytes(data))
    assert semantic.load_snapshot(key) is None  # HMAC mismatch: never unpickled
    semantic.index.invalidate(hard=True)
    assert semantic.index.search(db, "sea")  # rebuilt from the database
    get_settings.cache_clear()


def test_large_catalogue_builds_in_background(db, make_book, monkeypatch, tmp_path):
    monkeypatch.setenv("SHELFWISE_SEMANTIC_SYNC_BUILD_LIMIT", "1")
    monkeypatch.setenv("SHELFWISE_CACHE_DIR", str(tmp_path))
    get_settings.cache_clear()
    make_book("Alpha Centauri", subjects=["Astronomy"])
    make_book("Beta Pictoris", subjects=["Astronomy"])
    semantic.index.invalidate(hard=True)
    first = semantic.index.search(db, "astronomy")  # never blocks: empty until the build finishes
    import time

    for _ in range(100):
        if semantic.index.status()["ready"]:
            break
        time.sleep(0.05)
    assert semantic.index.status()["ready"]
    assert len(semantic.index.search(db, "astronomy")) == 2 and first in ([], semantic.index.search(db, "astronomy"))
    assert list(tmp_path.glob("semantic-*.idx"))  # snapshot persisted for other processes
    get_settings.cache_clear()


# ------------------------------------------------------------------ recommendations


def _old_also_borrowed(db, biblio_id, limit=10):
    since = utcnow() - timedelta(days=730)
    pairs = db.execute(select(Loan.patron_id, Item.biblio_id).join(Item, Item.id == Loan.item_id)
                       .where(Loan.patron_id.is_not(None), Loan.issued_at >= since)).all()
    readers = {p for p, b in pairs if b == biblio_id}
    if not readers:
        return []
    popularity = Counter(b for _, b in pairs)
    co = Counter(b for p, b in pairs if p in readers and b != biblio_id)
    co = Counter({b: c for b, c in co.items() if c >= 2 or len(readers) < 3})
    return {b: c / (popularity[b] ** 0.5) for b, c in co.items()}


def test_also_borrowed_matches_reference_implementation(db, lib, make_book):
    rng = random.Random(3)
    books = [make_book(f"Book {i}", copies=2)[1] for i in range(8)]
    patrons = [lib["patron"], lib["patron2"]] + [lib["make_user"](f"p{i}") for i in range(6)]
    db.commit()
    now = utcnow()
    for _ in range(90):
        item = rng.choice(rng.choice(books))
        db.add(Loan(item_id=item.id, patron_id=rng.choice(patrons).id, branch_id=item.branch_id,
                    issued_at=now - timedelta(days=rng.randint(1, 600)), due_at=now, returned_at=now))
    db.commit()
    for items in books:
        bid = items[0].biblio_id
        expected = _old_also_borrowed(db, bid)
        got = recommend.also_borrowed(db, bid, limit=100)
        assert {b: round(s, 9) for b, s in got} == {b: round(s, 9) for b, s in expected.items()}


# ------------------------------------------------------------------ generator


def test_generator_produces_consistent_data(db, client):
    from shelfwise.generate import generate

    stats = generate(biblios=300, patrons=60, loans=900, seed=11)
    assert stats["biblios"] == 300 and stats["patrons"] == 60 and stats["loans"] == 900 and stats["indexed"] == 300
    assert db.scalar(select(func.count()).select_from(Biblio)) == 300
    open_loans = db.scalar(select(func.count()).select_from(Loan).where(Loan.returned_at.is_(None)))
    on_loan = db.scalar(select(func.count()).select_from(Item).where(Item.status == ItemStatus.on_loan))
    assert open_loans == on_loan == stats["open_loans"] > 0
    total_borrowed = db.scalar(select(func.sum(Item.times_borrowed)))
    assert total_borrowed == 900
    assert catalog.search(db, "introduction").total > 0
    # Sequences continue after explicit ids (PostgreSQL) — new rows insert normally
    b = catalog.create_biblio(db, {"title": "After Generation"})
    db.commit()
    assert b.id == 301
    assert client.get("/api/v1/search", params={"q": "history"}).status_code == 200
