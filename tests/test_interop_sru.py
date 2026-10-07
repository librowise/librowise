"""SRU server and CQL parser."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest

from shelfwise.interop import cql

SRW = "{http://www.loc.gov/zing/srw/}"
SRU2 = "{http://docs.oasis-open.org/ns/search-ws/sruResponse}"
DIAG = "{http://www.loc.gov/zing/srw/diagnostic/}"
MARC = "{http://www.loc.gov/MARC21/slim}"
DC = "{http://purl.org/dc/elements/1.1/}"
ZR = "{http://explain.z3950.org/dtd/2.0/}"


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    from shelfwise.interop.ratelimit import limiter

    limiter.reset()


@pytest.fixture()
def books(make_book, db):
    from shelfwise.services import catalog

    hobbit, _ = make_book("The Hobbit", authors=["Tolkien, J. R. R."], isbn="0-261-10334-2", pub_year=1937,
                          subjects=["Fantasy", "Dragons"], publisher="Allen & Unwin", subtitle="There and back again")
    rings, _ = make_book("The Lord of the Rings", authors=["Tolkien, J. R. R."], pub_year=1954,
                         subjects=["Fantasy"], language="en")
    dune, _ = make_book("Dune", authors=["Herbert, Frank"], pub_year=1965, subjects=["Science fiction"],
                        isbn="9780441013593", language="fr", material_type="book")
    film, _ = make_book("Spirited Away", authors=["Miyazaki, Hayao"], pub_year=2001, material_type="dvd", itype="DVD")
    gone, _ = make_book("Deleted Dragons", authors=["Nobody"], subjects=["Dragons"])
    catalog.delete_biblio(db, gone)
    db.commit()
    return {"hobbit": hobbit, "rings": rings, "dune": dune, "film": film, "gone": gone}


def sru(client, **params):
    r = client.get("/sru", params=params)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/xml")
    return ET.fromstring(r.content)


def search(client, query, **params):
    params = {"version": "1.2", "operation": "searchRetrieve", "query": query, **params}
    return sru(client, **params)


def count(root, ns=SRW) -> int:
    return int(root.find(f"{ns}numberOfRecords").text)


def titles(root, ns=SRW) -> list[str]:
    out = []
    for rec in root.iter(f"{MARC}record"):
        for df in rec.iter(f"{MARC}datafield"):
            if df.get("tag") == "245":
                out.append(df.find(f"{MARC}subfield[@code='a']").text)
    return out


def diag(root, ns=SRW) -> int | None:
    uri = root.find(f"{ns}diagnostics/{DIAG}diagnostic/{DIAG}uri")
    return int(uri.text.rsplit("/", 1)[1]) if uri is not None else None


# ------------------------------------------------------------------ parser unit tests


def test_cql_parser_shapes():
    n = cql.parse('dc.title = "lord of the rings" and (dc.creator=tolkien or bath.isbn==123) not dc.subject any "a b"')
    assert isinstance(n, cql.Boolean) and n.op == "not"
    assert isinstance(n.left, cql.Boolean) and n.left.op == "and"
    assert n.left.left == cql.Clause("dc.title", "=", "lord of the rings")
    inner = n.left.right
    assert inner.op == "or" and inner.right == cql.Clause("bath.isbn", "==", "123")
    assert n.right == cql.Clause("dc.subject", "any", "a b")
    assert cql.parse("dragon") == cql.Clause(None, None, "dragon")
    assert cql.parse('"and"') == cql.Clause(None, None, "and")
    m = cql.parse("dc.title =/relevant hobbit")
    assert m.modifiers == ["relevant"]
    assert cql.parse('title="say \\"hi\\""').term == 'say "hi"'


@pytest.mark.parametrize("bad,code", [
    ("", 27), ("dc.title=", 10), ("(dragon", 13), ("dragon)", 10), ('"unterminated', 10), ("a and", 10),
    ("dragon sortby dc.title", 80), ("= dragon", 10),
])
def test_cql_parser_errors(bad, code):
    with pytest.raises(cql.CQLError) as exc:
        cql.parse(bad)
    assert exc.value.code == code


def test_fts_expression_only_contains_quoted_tokens():
    expr = cql.fts_expression("title", "all", 'x") OR rowid=1 -- NEAR(* hob*')
    assert expr == '{title} : ("x" AND "or" AND "rowid" AND "1" AND "near"* AND "hob"*)'
    assert cql.fts_expression(None, "adj", "lord rings") == '("lord rings")'
    assert cql.fts_expression(None, "any", "a b") == '("a" OR "b")'
    assert cql.fts_expression(None, "=", "!!!") is None


# ------------------------------------------------------------------ explain


def test_explain_is_default_operation(client, lib):
    root = sru(client)
    assert root.tag == f"{SRW}explainResponse"
    assert root.find(f"{SRW}version").text == "1.2"
    explain = root.find(f"{SRW}record/{SRW}recordData/{ZR}explain")
    assert explain is not None
    assert explain.find(f"{ZR}serverInfo/{ZR}database").text == "sru"
    names = {n.text for n in explain.iter(f"{ZR}name")}
    assert {"title", "creator", "isbn", "serverChoice"} <= names
    schemas = {s.get("name") for s in explain.iter(f"{ZR}schema")}
    assert schemas == {"marcxml", "dc"}
    v2 = sru(client, version="2.0", operation="explain")
    assert v2.tag == f"{SRU2}explainResponse"


# ------------------------------------------------------------------ searchRetrieve


def test_search_marcxml(client, books):
    root = search(client, "dc.title=hobbit")
    assert root.tag == f"{SRW}searchRetrieveResponse" and count(root) == 1
    rec = root.find(f"{SRW}records/{SRW}record")
    assert rec.find(f"{SRW}recordSchema").text == "info:srw/schema/1/marcxml-v1.1"
    assert rec.find(f"{SRW}recordPacking").text == "xml"
    assert rec.find(f"{SRW}recordPosition").text == "1"
    assert titles(root) == ["The Hobbit"]
    echo = root.find(f"{SRW}echoedSearchRetrieveRequest/{SRW}query")
    assert echo.text == "dc.title=hobbit"


@pytest.mark.parametrize("query,expected", [
    ("tolkien", {"The Hobbit", "The Lord of the Rings"}),
    ("cql.serverChoice all \"tolkien fantasy\"", {"The Hobbit", "The Lord of the Rings"}),
    ("dc.creator=tolkien and dc.title=hobbit", {"The Hobbit"}),
    ("dc.creator=tolkien not dc.title=hobbit", {"The Lord of the Rings"}),
    ("dc.title=dune or dc.title=hobbit", {"Dune", "The Hobbit"}),
    ("(dc.title=dune or dc.title=hobbit) and dc.date<1950", {"The Hobbit"}),
    ('dc.title adj "lord of the rings"', {"The Lord of the Rings"}),
    ('dc.title == "rings lord"', set()),
    ("dc.title any \"dune spirited\"", {"Dune", "Spirited Away"}),
    ("dc.title=hob*", {"The Hobbit"}),
    ("dc.subject=dragons", {"The Hobbit"}),  # the deleted record is never returned
    ("bath.isbn=0261103342", {"The Hobbit"}),
    ("bath.isbn=978-0-261-10334-4", {"The Hobbit"}),
    ("dc.identifier=\"URN:ISBN:9780441013593\"", {"Dune"}),
    ("dc.date>=1954 and dc.date<=1965", {"The Lord of the Rings", "Dune"}),
    ("dc.date<>1937 and dc.creator=tolkien", {"The Lord of the Rings"}),
    ("dc.language=fre", {"Dune"}),
    ("dc.type=dvd", {"Spirited Away"}),
    ("cql.allRecords=1", {"The Hobbit", "The Lord of the Rings", "Dune", "Spirited Away"}),
    ("dc.publisher=unwin", {"The Hobbit"}),
])
def test_cql_queries(client, books, query, expected):
    root = search(client, query, maximumRecords="20")
    assert diag(root) is None, ET.tostring(root)
    assert set(titles(root)) == expected
    assert count(root) == len(expected)


def test_rec_id_and_dublin_core(client, books):
    hid = books["hobbit"].id
    root = search(client, f"rec.id={hid}", recordSchema="dc")
    rec = root.find(f"{SRW}records/{SRW}record")
    assert rec.find(f"{SRW}recordSchema").text == "info:srw/schema/1/dc-v1.1"
    dc = rec.find(f"{SRW}recordData/{{info:srw/schema/1/dc-schema}}dc")
    assert dc.find(f"{DC}title").text == "The Hobbit : There and back again"
    assert dc.find(f"{DC}creator").text == "Tolkien, J. R. R."
    assert dc.find(f"{DC}date").text == "1937"
    ids = [e.text for e in dc.findall(f"{DC}identifier")]
    assert "URN:ISBN:9780261103344" in ids and any(i.endswith(f"/record/{hid}") for i in ids)


def test_record_packing_string(client, books):
    root = search(client, "dc.title=hobbit", recordPacking="string")
    data = root.find(f"{SRW}records/{SRW}record/{SRW}recordData")
    assert len(data) == 0 and data.text.startswith("<marc:record")
    inner = ET.fromstring(data.text)
    assert inner.tag == f"{MARC}record"


def test_paging(client, books):
    root = search(client, "cql.allRecords=1", maximumRecords="2")
    assert count(root) == 4 and len(titles(root)) == 2
    assert root.find(f"{SRW}nextRecordPosition").text == "3"
    root = search(client, "cql.allRecords=1", maximumRecords="2", startRecord="3")
    assert len(titles(root)) == 2 and root.find(f"{SRW}nextRecordPosition") is None
    positions = [r.text for r in root.iter(f"{SRW}recordPosition")]
    assert positions == ["3", "4"]
    root = search(client, "cql.allRecords=1", maximumRecords="0")
    assert count(root) == 4 and root.find(f"{SRW}records") is None


def test_sru_2_0(client, books):
    root = sru(client, version="2.0", query="dc.title=dune", recordXMLEscaping="xml")
    assert root.tag == f"{SRU2}searchRetrieveResponse"
    assert root.find(f"{SRU2}version").text == "2.0"
    assert root.find(f"{SRU2}resultCountPrecision") is not None
    rec = root.find(f"{SRU2}records/{SRU2}record")
    assert rec.find(f"{SRU2}recordXMLEscaping").text == "xml"
    assert titles(root) == ["Dune"]
    bad = sru(client, version="2.0", query="dc.nope=x")
    assert int(bad.find(f"{SRU2}diagnostics/{{http://docs.oasis-open.org/ns/search-ws/diagnostic}}diagnostic/"
                        "{http://docs.oasis-open.org/ns/search-ws/diagnostic}uri").text.rsplit("/", 1)[1]) == 16


def test_post_request(client, books):
    r = client.post("/sru", data={"version": "1.2", "operation": "searchRetrieve", "query": "dc.title=dune"})
    assert r.status_code == 200
    assert titles(ET.fromstring(r.content)) == ["Dune"]


@pytest.mark.parametrize("params,code", [
    ({"query": "dc.nonsense=x"}, 16),
    ({"query": "dc.title<x"}, 19),
    ({"query": "dc.title=/fuzzy x"}, 20),
    ({"query": "a prox b"}, 37),
    ({"query": "dc.title=\"\""}, 27),
    ({"query": "dc.date=abc"}, 36),
    ({"query": "((("}, 10),
    ({"query": "dc.title=x", "recordSchema": "mods"}, 66),
    ({"query": "dc.title=x", "recordPacking": "zip"}, 71),
    ({"query": "dc.title=hobbit", "startRecord": "5"}, 61),
    ({"query": "dc.title=x", "maximumRecords": "lots"}, 6),
    ({"query": "dc.title=x", "startRecord": "0"}, 6),
    ({"query": "dc.title=x", "sortKeys": "title"}, 80),
    ({"query": "dc.title=x", "stylesheet": "x.xsl"}, 110),
    ({"query": "dc.title=x", "recordXPath": "/a"}, 72),
    ({"query": "dc.title=x", "bogus": "1"}, 8),
    ({"operation": "searchRetrieve"}, 7),
    ({"operation": "scan", "scanClause": "dc.title=a"}, 4),
    ({"query": "x", "version": "3.0"}, 5),
])
def test_diagnostics(client, books, params, code):
    root = sru(client, **({"version": "1.2", "operation": "searchRetrieve"} | params))
    assert diag(root) == code, ET.tostring(root)
    assert count(root) == 0 and root.find(f"{SRW}records") is None


def test_injection_attempts_are_harmless(client, books):
    for q in ['dc.title="x\') OR 1=1 --"', 'dc.title="title:* NEAR("', "dc.title=\"robust\\\" AND \\\"x\"",
              "cql.anywhere=\"'; DROP TABLE biblios; --\""]:
        root = search(client, q)
        assert diag(root) in (None, 10)
    assert count(search(client, "dc.title=hobbit")) == 1


def test_rate_limit(client, lib, monkeypatch):
    from shelfwise.interop import ratelimit
    from shelfwise.security import SlidingWindowLimiter

    monkeypatch.setattr(ratelimit, "limiter", SlidingWindowLimiter(2))
    assert client.get("/sru").status_code == 200
    assert client.get("/sru").status_code == 200
    r = client.get("/sru")
    assert r.status_code == 503 and r.headers["retry-after"] == "60"
