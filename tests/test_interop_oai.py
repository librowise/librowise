"""OAI-PMH 2.0 data provider."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

import pytest

OAI = "{http://www.openarchives.org/OAI/2.0/}"
OAI_DC = "{http://www.openarchives.org/OAI/2.0/oai_dc/}"
DC = "{http://purl.org/dc/elements/1.1/}"
MARC = "{http://www.loc.gov/MARC21/slim}"
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    from librowise.interop.ratelimit import limiter

    limiter.reset()


@pytest.fixture()
def repo(make_book, db):
    """Five records with distinct datestamps (one per day in January 2026), one deleted, one DVD."""
    from librowise.models import Biblio
    from librowise.services import catalog

    made = []
    for i, (title, mt) in enumerate([("Alpha", "book"), ("Bravo", "book"), ("Charlie", "dvd"),
                                     ("Delta", "book"), ("Echo", "book")]):
        b, _ = make_book(title, material_type=mt, itype="DVD" if mt == "dvd" else "BOOK", pub_year=2000 + i,
                         isbn=None)
        made.append(b.id)
    catalog.delete_biblio(db, db.get(Biblio, made[3]))  # Delta is deleted
    db.commit()
    for i, bid in enumerate(made):
        db.get(Biblio, bid).updated_at = datetime(2026, 1, 1 + i, 12, 0, 0, 500000)
    db.commit()
    return made


def oai(client, method="get", **params):
    r = client.post("/oai", data=params) if method == "post" else client.get("/oai", params=params)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/xml")
    root = ET.fromstring(r.content)  # well-formed
    assert root.tag == f"{OAI}OAI-PMH"
    assert STAMP.match(root.find(f"{OAI}responseDate").text)
    assert root.find(f"{OAI}request").text.endswith("/oai")
    return root


def error(root) -> str | None:
    e = root.find(f"{OAI}error")
    return e.get("code") if e is not None else None


def ids(root, verb) -> list[str]:
    return [h.find(f"{OAI}identifier").text for h in root.iter(f"{OAI}header")]


def ident(bid: int) -> str:
    return f"oai:librowise.local:{bid}"


def test_identify(client, repo):
    root = oai(client, verb="Identify")
    assert error(root) is None
    assert root.find(f"{OAI}request").get("verb") == "Identify"
    idf = root.find(f"{OAI}Identify")
    for el in ("repositoryName", "baseURL", "protocolVersion", "adminEmail", "earliestDatestamp",
               "deletedRecord", "granularity"):
        assert idf.find(f"{OAI}{el}") is not None and idf.find(f"{OAI}{el}").text, el
    assert idf.find(f"{OAI}protocolVersion").text == "2.0"
    assert idf.find(f"{OAI}baseURL").text == "http://testserver/oai"
    assert idf.find(f"{OAI}deletedRecord").text == "persistent"
    assert idf.find(f"{OAI}granularity").text == "YYYY-MM-DDThh:mm:ssZ"
    assert idf.find(f"{OAI}earliestDatestamp").text == "2026-01-01T12:00:00Z"
    assert "@" in idf.find(f"{OAI}adminEmail").text
    sample = idf.find(".//{http://www.openarchives.org/OAI/2.0/oai-identifier}sampleIdentifier").text
    assert sample.startswith("oai:librowise.local:")


def test_list_metadata_formats_and_sets(client, repo):
    root = oai(client, verb="ListMetadataFormats")
    prefixes = {f.find(f"{OAI}metadataPrefix").text for f in root.iter(f"{OAI}metadataFormat")}
    assert prefixes == {"oai_dc", "marc21"}
    for f in root.iter(f"{OAI}metadataFormat"):
        assert f.find(f"{OAI}schema").text.endswith(".xsd") and f.find(f"{OAI}metadataNamespace").text
    assert error(oai(client, verb="ListMetadataFormats", identifier=ident(repo[0]))) is None
    assert error(oai(client, verb="ListMetadataFormats", identifier="oai:librowise.local:99999")) == "idDoesNotExist"
    assert error(oai(client, verb="ListMetadataFormats", identifier="nonsense")) == "idDoesNotExist"
    sets = {s.find(f"{OAI}setSpec").text: s.find(f"{OAI}setName").text for s in oai(client, verb="ListSets").iter(f"{OAI}set")}
    assert sets["book"] == "Books" and sets["dvd"] == "DVDs and video"
    assert error(oai(client, verb="ListSets", resumptionToken="x")) == "badResumptionToken"


def test_list_records_oai_dc_with_deleted(client, repo):
    root = oai(client, verb="ListRecords", metadataPrefix="oai_dc")
    assert error(root) is None
    records = root.findall(f"{OAI}ListRecords/{OAI}record")
    assert [r.find(f"{OAI}header/{OAI}identifier").text for r in records] == [ident(i) for i in repo]
    deleted = records[3]
    assert deleted.find(f"{OAI}header").get("status") == "deleted"
    assert deleted.find(f"{OAI}metadata") is None
    first = records[0]
    assert first.find(f"{OAI}header/{OAI}datestamp").text == "2026-01-01T12:00:00Z"
    assert first.find(f"{OAI}header/{OAI}setSpec").text == "book"
    dc = first.find(f"{OAI}metadata/{OAI_DC}dc")
    assert dc.find(f"{DC}title").text == "Alpha" and dc.find(f"{DC}date").text == "2000"
    assert root.find(f"{OAI}ListRecords/{OAI}resumptionToken") is None  # single, complete page


def test_list_identifiers_marc21_and_get_record(client, repo):
    root = oai(client, verb="ListIdentifiers", metadataPrefix="marc21", set="dvd")
    assert ids(root, "ListIdentifiers") == [ident(repo[2])]
    assert root.find(f"{OAI}ListIdentifiers/{OAI}header/{OAI}setSpec").text == "dvd"
    rec = oai(client, verb="GetRecord", identifier=ident(repo[0]), metadataPrefix="marc21")
    marc = rec.find(f"{OAI}GetRecord/{OAI}record/{OAI}metadata/{MARC}record")
    assert marc is not None
    t245 = [d for d in marc.iter(f"{MARC}datafield") if d.get("tag") == "245"][0]
    assert t245.find(f"{MARC}subfield").text == "Alpha"
    gone = oai(client, verb="GetRecord", identifier=ident(repo[3]), metadataPrefix="oai_dc")
    assert gone.find(f"{OAI}GetRecord/{OAI}record/{OAI}header").get("status") == "deleted"


def test_from_until(client, repo):
    root = oai(client, verb="ListIdentifiers", metadataPrefix="oai_dc", **{"from": "2026-01-02", "until": "2026-01-03"})
    assert ids(root, "x") == [ident(repo[1]), ident(repo[2])]
    root = oai(client, verb="ListIdentifiers", metadataPrefix="oai_dc",
               **{"from": "2026-01-02T12:00:00Z", "until": "2026-01-02T12:00:00Z"})
    assert ids(root, "x") == [ident(repo[1])]  # sub-second datestamps match their displayed second
    root = oai(client, verb="ListIdentifiers", metadataPrefix="oai_dc", **{"from": "2026-01-05T12:00:01Z"})
    assert error(root) == "noRecordsMatch"
    assert error(oai(client, verb="ListRecords", metadataPrefix="oai_dc", until="2025-12-31")) == "noRecordsMatch"


@pytest.mark.parametrize("params,code", [
    ({}, "badVerb"),
    ({"verb": "Explode"}, "badVerb"),
    ({"verb": "ListRecords"}, "badArgument"),
    ({"verb": "GetRecord", "identifier": "oai:librowise.local:1"}, "badArgument"),
    ({"verb": "Identify", "extra": "1"}, "badArgument"),
    ({"verb": "ListRecords", "metadataPrefix": "mods"}, "cannotDisseminateFormat"),
    ({"verb": "GetRecord", "identifier": "oai:librowise.local:424242", "metadataPrefix": "oai_dc"}, "idDoesNotExist"),
    ({"verb": "ListRecords", "metadataPrefix": "oai_dc", "from": "2026-13-45"}, "badArgument"),
    ({"verb": "ListRecords", "metadataPrefix": "oai_dc", "from": "2026-01-01", "until": "2026-01-02T00:00:00Z"}, "badArgument"),
    ({"verb": "ListRecords", "metadataPrefix": "oai_dc", "from": "2026-02-01", "until": "2026-01-01"}, "badArgument"),
    ({"verb": "ListRecords", "metadataPrefix": "oai_dc", "set": "nope"}, "noRecordsMatch"),
    ({"verb": "ListRecords", "resumptionToken": "garbage"}, "badResumptionToken"),
    ({"verb": "ListRecords", "resumptionToken": "x", "metadataPrefix": "oai_dc"}, "badArgument"),
])
def test_errors(client, repo, params, code):
    root = oai(client, **params)
    assert error(root) == code
    req = root.find(f"{OAI}request")
    if code in ("badVerb", "badArgument"):
        assert req.attrib == {}


def test_repeated_arguments(client, repo):
    r = client.get("/oai?verb=Identify&verb=Identify")
    assert error(ET.fromstring(r.content)) == "badVerb"
    r = client.get("/oai?verb=ListRecords&metadataPrefix=oai_dc&metadataPrefix=marc21")
    assert error(ET.fromstring(r.content)) == "badArgument"


def test_resumption_tokens(client, repo, monkeypatch):
    monkeypatch.setenv("LIBROWISE_OAI_PAGE_SIZE", "2")
    root = oai(client, verb="ListIdentifiers", metadataPrefix="oai_dc")
    seen = ids(root, "x")
    token = root.find(f"{OAI}ListIdentifiers/{OAI}resumptionToken")
    assert token.get("completeListSize") == "5" and token.get("cursor") == "0" and token.text
    assert STAMP.match(token.get("expirationDate"))
    cursors = ["0"]
    while token is not None and token.text:
        # A record updated mid-harvest moves to the end of the list and is not lost.
        root = oai(client, verb="ListIdentifiers", resumptionToken=token.text)
        assert error(root) is None
        seen += ids(root, "x")
        token = root.find(f"{OAI}ListIdentifiers/{OAI}resumptionToken")
        cursors.append(token.get("cursor"))
    assert seen == [ident(i) for i in repo]
    assert cursors == ["0", "2", "4"]
    assert token.text is None and token.get("completeListSize") == "5"  # last page: empty token

    first = oai(client, verb="ListRecords", metadataPrefix="oai_dc")
    tok = first.find(f"{OAI}ListRecords/{OAI}resumptionToken").text
    assert error(oai(client, verb="ListIdentifiers", resumptionToken=tok)) == "badResumptionToken"  # wrong verb
    assert error(oai(client, verb="ListRecords", resumptionToken=tok[:-2] + "xx")) == "badResumptionToken"
    page2 = oai(client, method="post", verb="ListRecords", resumptionToken=tok)
    assert len(page2.findall(f"{OAI}ListRecords/{OAI}record")) == 2

    from librowise.interop import oai as oai_mod

    monkeypatch.setattr(oai_mod, "TOKEN_TTL", timedelta(seconds=-5))
    assert error(oai(client, verb="ListRecords", resumptionToken=tok)) == "badResumptionToken"  # expired


def test_harvest_sees_changes_made_during_harvest(client, repo, monkeypatch, db):
    from librowise.models import Biblio

    monkeypatch.setenv("LIBROWISE_OAI_PAGE_SIZE", "2")
    root = oai(client, verb="ListIdentifiers", metadataPrefix="oai_dc")
    token = root.find(f"{OAI}ListIdentifiers/{OAI}resumptionToken").text
    db.get(Biblio, repo[0]).updated_at = datetime(2026, 2, 1)  # already harvested record changes
    db.commit()
    rest = []
    while token:
        root = oai(client, verb="ListIdentifiers", resumptionToken=token)
        rest += ids(root, "x")
        token = root.find(f"{OAI}ListIdentifiers/{OAI}resumptionToken").text
    assert rest == [ident(i) for i in repo[2:]] + [ident(repo[0])]
