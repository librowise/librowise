from shelfwise.ai import cataloging, copilot, insights, nlsearch, recommend, semantic
from shelfwise.services import catalog, circulation, marc


def test_isbn_normalisation():
    assert catalog.normalize_isbn("0-306-40615-2") == "9780306406157"
    assert catalog.normalize_isbn("978-0-306-40615-7") == "9780306406157"
    assert catalog.normalize_isbn("978-0-306-40615-8") is None  # bad checksum
    assert catalog.normalize_isbn("080442957X") == "9780804429573"
    assert catalog.normalize_isbn("hello") is None


def test_fts_query_is_safely_quoted():
    assert catalog.fts_query('dune" OR 1=1') == '"dune" "1" "1"'
    assert catalog.fts_query("NEAR(title) AND foo") == '"title" "foo"*'
    assert catalog.fts_query("!!!") is None


def test_search_ranking_prefix_and_filters(db, make_book):
    make_book("The Hobbit", authors=["Tolkien, J. R. R."], subjects=["Fantasy fiction"], pub_year=1937)
    make_book("A Hobbit's Guide to Gardening", subjects=["Gardening"], pub_year=2020)
    make_book("Dune", subjects=["Science fiction"], pub_year=1965, language="en")
    r = catalog.search(db, "hobb")  # prefix match
    assert r.total == 2
    titles = [b.title for b in catalog.load_biblios(db, r.ids)]
    assert titles[0] == "The Hobbit"  # title + shorter field ranks first
    r = catalog.search(db, "tolkien")
    assert r.total == 1
    r = catalog.search(db, "hobbit", catalog.SearchFilters(year_from=2000))
    assert r.total == 1
    r = catalog.search(db, None, catalog.SearchFilters(subject="Science fiction"))
    assert r.total == 1
    assert dict(r.facets["material_type"]) == {"book": 1}


def test_deleted_records_disappear_from_search(db, make_book):
    b, _ = make_book("Ephemeral Title")
    assert catalog.search(db, "ephemeral").total == 1
    catalog.delete_biblio(db, b)
    db.commit()
    assert catalog.search(db, "ephemeral").total == 0


def test_availability(db, make_book, lib):
    b, items = make_book(copies=3)
    circulation.checkout(db, lib["patron"], items[0], branch_id=items[0].branch_id)
    assert catalog.availability(db, [b.id])[b.id] == {"total": 3, "available": 2}


def test_nl_parse_local():
    pq = nlsearch.parse_local("funny books for kids about space published after 2015")
    assert pq.audience == "children" and pq.year_from == 2016 and "space" in pq.keywords and "funny" in pq.keywords
    pq = nlsearch.parse_local("detective novels by Agatha Christie in English from the 1930s")
    assert pq.author == "Agatha Christie" and pq.language == "en" and (pq.year_from, pq.year_to) == (1930, 1939)
    pq = nlsearch.parse_local("dvds about nature available now")
    assert pq.material_type == "dvd" and pq.available_only


def test_semantic_concept_expansion(db, make_book):
    make_book("Cosmos", subjects=["Astronomy"], description="A journey through the universe and the stars.")
    make_book("Gardening Basics", subjects=["Gardening"])
    hits = semantic.index.search(db, "space")
    assert hits and catalog.load_biblios(db, [hits[0][0]])[0].title == "Cosmos"


def test_smart_search_end_to_end(client, make_book):
    make_book("Matilda", subjects=["Humorous stories", "Children's stories"], audience="children")
    make_book("Serious Adult Novel", subjects=["Humorous stories"], audience="adult")
    r = client.get("/api/v1/search/smart", params={"q": "funny books for kids"}).json()
    assert [x["title"] for x in r["results"]] == ["Matilda"]
    assert r["parsed"]["audience"] == "children"


def test_catalog_suggestions_local(db, make_book):
    make_book("Cosmos", subjects=["Astronomy", "Space"], classification="520", description="Planets and stars.")
    make_book("Pale Blue Dot", subjects=["Astronomy", "Planets"], classification="520", description="Space exploration and planets.")
    s = cataloging.suggest_local(db, {"title": "The Martian", "description": "An astronaut stranded on Mars, far from the planets of home."})
    assert s["engine"] == "local"
    assert "Astronomy" in s["subjects"]
    assert s["classification"].startswith("520")


def test_recommendations_collaborative_and_content(db, lib, make_book):
    a, (ia,) = make_book("Dune", subjects=["Science fiction", "Space"])
    b, (ib,) = make_book("Foundation", subjects=["Science fiction", "Space"])
    c, (ic,) = make_book("Cookbook", subjects=["Cooking"])
    for p in (lib["patron"], lib["patron2"]):
        for it in (ia, ib):
            circulation.checkout(db, p, it, branch_id=it.branch_id)
            circulation.checkin(db, it, branch_id=it.branch_id)
    db.commit()
    rec = recommend.for_biblio(db, a.id)
    assert rec["ids"][0] == b.id
    mine = recommend.for_patron(db, lib["patron"].id)
    assert a.id not in mine["ids"] and b.id not in mine["ids"]


def test_overdue_risk_and_purchase_suggestions(db, lib, make_book):
    biblio, (item,) = make_book()
    circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id)
    for n in range(3):
        u = lib["make_user"](f"waiter{n}")
        circulation.place_hold(db, u, biblio, pickup_branch_id=item.branch_id)
    db.commit()
    risk = insights.overdue_risk(db)
    assert risk and 0 < risk[0]["risk"] < 1
    sug = insights.purchase_suggestions(db)
    assert sug[0]["biblio_id"] == biblio.id and sug[0]["holds"] == 3


def test_duplicate_detection(db, make_book):
    make_book("The Lord of the Rings", authors=["Tolkien, J. R. R."])
    make_book("Lord of the Rings", authors=["Tolkien, J.R.R."])
    make_book("Completely Different", authors=["Someone"])
    d = insights.duplicate_candidates(db)
    assert len(d) == 1 and d[0]["score"] >= 90


def test_copilot_local_engine(db, lib, make_book):
    make_book("Artificial Intelligence: A Modern Approach", subjects=["Artificial intelligence"])
    out = copilot.ask(db, "give me library stats")
    assert out["engine"] == "local" and "titles" in out["answer"]
    out = copilot.ask(db, "find books about artificial intelligence")
    assert "Artificial Intelligence" in out["answer"]
    out = copilot.ask(db, "patron reader1")
    assert "Reader1" in out["answer"]


def test_copilot_tools_are_strict_and_read_only():
    defs = copilot.tool_definitions()
    assert {d["name"] for d in defs} == set(copilot.TOOLS)
    for d in defs:
        assert d["strict"] is True and d["input_schema"]["additionalProperties"] is False


def test_marc_roundtrip_with_koha_holdings(db, lib, make_book):
    b, (item,) = make_book("Roundtrip Title", authors=["Writer, Ann"], subjects=["Testing"], isbn="9780306406157",
                           publisher="Test Press", pub_year=2001, description="About tests.")
    data = marc.export(db, [b], "xml")
    assert b"Roundtrip Title" in data and b"952" in data
    catalog.delete_biblio(db, b)
    item.barcode = "OLD-" + item.barcode  # free the barcode so the import can recreate it
    db.commit()
    stats = marc.import_marc(db, data, default_branch_id=lib["branches"]["MAIN"].id,
                             default_item_type_id=lib["itypes"]["BOOK"].id)
    assert stats["created"] == 1 and stats["items"] == 1, stats
    r = catalog.search(db, "roundtrip")
    new = catalog.load_biblios(db, r.ids)[0]
    assert new.authors == ["Writer, Ann"] and new.pub_year == 2001 and new.isbn == "9780306406157"
    assert new.marc_xml
    # Binary MARC21 export works too
    assert marc.export(db, [new], "mrc")[5:6] in (b"n", b"c", b" ")
