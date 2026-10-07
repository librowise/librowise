"""Copy cataloguing (HTTP mocked), SIP account administration API, JSON-LD on OPAC pages,
staff pages, seed data and the sip2 CLI command."""

from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from conftest import login

from shelfwise.interop import copycat

LOC_RESPONSE = b"""<?xml version="1.0" encoding="UTF-8"?>
<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zing/srw/">
 <zs:version>1.1</zs:version><zs:numberOfRecords>27</zs:numberOfRecords>
 <zs:records>
  <zs:record><zs:recordSchema>marcxml</zs:recordSchema><zs:recordPacking>xml</zs:recordPacking>
   <zs:recordData><record xmlns="http://www.loc.gov/MARC21/slim">
     <leader>01142cam  2200301 a 4500</leader>
     <controlfield tag="001">2005013457</controlfield>
     <controlfield tag="008">050412s1937    enk           000 1 eng  </controlfield>
     <datafield tag="010" ind1=" " ind2=" "><subfield code="a">   37004532 </subfield></datafield>
     <datafield tag="020" ind1=" " ind2=" "><subfield code="a">0261103342 (pbk.)</subfield></datafield>
     <datafield tag="082" ind1="0" ind2="0"><subfield code="a">823.912</subfield></datafield>
     <datafield tag="100" ind1="1" ind2=" "><subfield code="a">Tolkien, J. R. R.</subfield></datafield>
     <datafield tag="245" ind1="1" ind2="4"><subfield code="a">The hobbit :</subfield><subfield code="b">or, There and back again /</subfield></datafield>
     <datafield tag="260" ind1=" " ind2=" "><subfield code="b">Allen &amp; Unwin,</subfield><subfield code="c">1937.</subfield></datafield>
     <datafield tag="300" ind1=" " ind2=" "><subfield code="a">310 p.</subfield></datafield>
     <datafield tag="650" ind1=" " ind2="0"><subfield code="a">Fantasy fiction.</subfield></datafield>
     <datafield tag="952" ind1=" " ind2=" "><subfield code="p">REMOTE-ITEM</subfield></datafield>
   </record></zs:recordData><zs:recordPosition>1</zs:recordPosition></zs:record>
  <zs:record><zs:recordSchema>marcxml</zs:recordSchema><zs:recordPacking>string</zs:recordPacking>
   <zs:recordData>&lt;record xmlns="http://www.loc.gov/MARC21/slim"&gt;&lt;leader&gt;00000nam  2200000 a 4500&lt;/leader&gt;&lt;datafield tag="245" ind1="0" ind2="0"&gt;&lt;subfield code="a"&gt;The hobbit : graphic novel&lt;/subfield&gt;&lt;/datafield&gt;&lt;/record&gt;</zs:recordData>
   <zs:recordPosition>2</zs:recordPosition></zs:record>
 </zs:records>
</zs:searchRetrieveResponse>"""

DIAG_RESPONSE = b"""<?xml version="1.0"?>
<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zing/srw/"><zs:version>1.1</zs:version>
<zs:numberOfRecords>0</zs:numberOfRecords><zs:diagnostics>
<diagnostic xmlns="http://www.loc.gov/zing/srw/diagnostic/"><uri>info:srw/diagnostic/1/16</uri>
<details>dc.nonsense</details><message>Unsupported index</message></diagnostic></zs:diagnostics>
</zs:searchRetrieveResponse>"""


@pytest.fixture()
def remote(monkeypatch):
    """Route every copy-cataloguing HTTP request to an in-memory handler (no network in tests)."""
    calls: list[httpx.Request] = []
    state = {"handler": lambda req: httpx.Response(200, content=LOC_RESPONSE)}

    def transport(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return state["handler"](req)

    real_fetch = copycat._fetch

    def fake_fetch(url, timeout, client=None):
        return real_fetch(url, timeout, httpx.Client(transport=httpx.MockTransport(transport)))

    monkeypatch.setattr(copycat, "_fetch", fake_fetch)
    return {"calls": calls, "state": state}


# ------------------------------------------------------------------ copy cataloguing


def test_parse_sru_response():
    total, records, diags = copycat.parse_sru_response(LOC_RESPONSE)
    assert total == 27 and len(records) == 2 and diags == []
    assert records[0]["245"]["a"] == "The hobbit :"
    assert records[1]["245"]["a"] == "The hobbit : graphic novel"  # recordPacking=string
    total, records, diags = copycat.parse_sru_response(DIAG_RESPONSE)
    assert records == [] and diags == ["Unsupported index — dc.nonsense"]
    with pytest.raises(copycat.RemoteError):
        copycat.parse_sru_response(b"<not xml")


def test_build_query_escapes_terms():
    t = copycat.TargetInfo(id=0, **copycat.DEFAULT_TARGET)
    assert copycat.build_query(t, "title", 'say "hi"') == 'dc.title="say \\"hi\\""'
    assert copycat.build_query(t, "isbn", "978-0-261-10334-4") == "bath.isbn=9780261103344"
    assert copycat.build_query(t, "author", "Tolkien") == 'dc.creator="Tolkien"'
    from shelfwise.errors import DomainError

    with pytest.raises(DomainError):
        copycat.build_query(t, "isbn", "123")


def test_default_target_and_search(client, staff, lib, make_book, remote):
    make_book("The Hobbit", isbn="9780261103344")
    targets = client.get("/api/v1/copycat/targets", headers=staff).json()["results"]
    assert targets == [{**{k: copycat.DEFAULT_TARGET[k] for k in targets[0] if k != "id"}, "id": 0}]
    r = client.get("/api/v1/copycat/search", params={"q": "hobbit", "kind": "title"}, headers=staff)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] == 27 and data["target"]["name"] == "Library of Congress"
    first = data["results"][0]
    assert first["title"] == "The hobbit" and first["authors"] == ["Tolkien, J. R. R"]
    assert first["isbn"] == "9780261103344" and first["pub_year"] == 1937 and first["lccn"] == "37004532"
    assert first["existing_biblio_id"] is not None  # dedupe hint: already in the catalogue
    assert any(f["tag"] == "245" and "$a The hobbit" in f["value"] for f in first["fields"])
    req = remote["calls"][0]
    assert req.url.host == "lx2.loc.gov" and req.url.port == 210
    qs = parse_qs(urlparse(str(req.url)).query)
    assert qs["query"] == ['dc.title="hobbit"'] and qs["recordSchema"] == ["marcxml"]
    assert qs["operation"] == ["searchRetrieve"] and qs["maximumRecords"] == ["10"]


def test_remote_errors(client, staff, lib, remote):
    remote["state"]["handler"] = lambda req: httpx.Response(200, content=DIAG_RESPONSE)
    r = client.get("/api/v1/copycat/search", params={"q": "x"}, headers=staff)
    assert r.status_code == 502 and "Unsupported index" in r.json()["detail"]

    def timeout(req):
        raise httpx.ReadTimeout("slow", request=req)

    remote["state"]["handler"] = timeout
    r = client.get("/api/v1/copycat/search", params={"q": "x"}, headers=staff)
    assert r.status_code == 502 and "did not answer in time" in r.json()["detail"]
    remote["state"]["handler"] = lambda req: httpx.Response(500)
    assert client.get("/api/v1/copycat/search", params={"q": "x"}, headers=staff).status_code == 502
    remote["state"]["handler"] = lambda req: httpx.Response(200, content=b"x" * (copycat.MAX_RESPONSE_BYTES + 10))
    r = client.get("/api/v1/copycat/search", params={"q": "x"}, headers=staff)
    assert r.status_code == 502 and "too large" in r.json()["detail"]
    assert client.get("/api/v1/copycat/search", params={"q": "x", "target_id": 99}, headers=staff).status_code == 404


def test_import_dedupes_and_preserves_marc(client, staff, lib, remote, db):
    from shelfwise.models import AuditLog, Biblio

    rec = client.get("/api/v1/copycat/search", params={"q": "hobbit"}, headers=staff).json()["results"][0]
    assert rec["existing_biblio_id"] is None
    r = client.post("/api/v1/copycat/import", json={"marcxml": rec["marcxml"], "target_id": 0}, headers=staff)
    assert r.status_code == 201, r.text
    b = r.json()
    assert b["title"] == "The hobbit" and b["subtitle"] == "or, There and back again"
    assert b["isbn"] == "9780261103344" and b["classification"] == "823.912" and b["pages"] == 310
    assert b["has_marc"] is True and b["language"] == "en"
    stored = db.get(Biblio, b["id"])
    assert "2005013457" in stored.marc_xml and "REMOTE-ITEM" not in stored.marc_xml  # 9XX local fields stripped
    assert stored.items == []
    # re-indexed: the catalogue search finds it straight away
    hits = client.get("/api/v1/search", params={"q": "hobbit"}).json()
    assert [x["id"] for x in hits["results"]] == [b["id"]]
    entry = db.query(AuditLog).filter(AuditLog.action == "copycat_import").one()
    assert entry.details["source"] == "Library of Congress"
    # duplicate ISBN -> 409 with a pointer to the existing record, unless explicitly allowed
    dup = client.post("/api/v1/copycat/import", json={"marcxml": rec["marcxml"]}, headers=staff)
    assert dup.status_code == 409 and dup.json()["existing_biblio_id"] == b["id"]
    again = client.post("/api/v1/copycat/import", json={"marcxml": rec["marcxml"], "allow_duplicate": True}, headers=staff)
    assert again.status_code == 201
    # the search now flags the record as already catalogued
    rec2 = client.get("/api/v1/copycat/search", params={"q": "hobbit"}, headers=staff).json()["results"][0]
    assert rec2["existing_biblio_id"] in (b["id"], again.json()["id"])
    bad = client.post("/api/v1/copycat/import", json={"marcxml": "<record>not marc at all</rec>"}, headers=staff)
    assert bad.status_code == 400


def test_copycat_permissions_and_targets(client, staff, admin, lib, remote):
    reader = login(client, "reader1")
    assert client.get("/api/v1/copycat/targets", headers=reader).status_code == 403
    assert client.get("/api/v1/copycat/search", params={"q": "x"}, headers=reader).status_code == 403
    body = {"name": "Local union catalogue", "url": "https://sru.example.org/union", "sru_version": "1.2",
            "timeout_seconds": 5}
    assert client.post("/api/v1/copycat/targets", json=body, headers=staff).status_code == 403
    assert client.post("/api/v1/copycat/targets", json={**body, "url": "file:///etc/passwd"}, headers=admin).status_code == 422
    r = client.post("/api/v1/copycat/targets", json=body, headers=admin)
    assert r.status_code == 201
    tid = r.json()["id"]
    targets = client.get("/api/v1/copycat/targets", headers=staff).json()["results"]
    assert [t["name"] for t in targets] == ["Local union catalogue"]  # built-in default no longer offered
    client.get("/api/v1/copycat/search", params={"q": "0261103342", "target_id": tid, "kind": "isbn"}, headers=staff)
    sent = remote["calls"][-1]
    sent_qs = parse_qs(urlparse(str(sent.url)).query)
    assert sent.url.host == "sru.example.org"
    assert sent_qs["query"] == ["bath.isbn=0261103342"] and sent_qs["version"] == ["1.2"]
    assert client.patch(f"/api/v1/copycat/targets/{tid}", json={"enabled": False}, headers=admin).json()["enabled"] is False
    assert client.get("/api/v1/copycat/search", params={"q": "x", "target_id": tid}, headers=staff).status_code == 404
    assert client.delete(f"/api/v1/copycat/targets/{tid}", headers=admin).status_code == 200


# ------------------------------------------------------------------ SIP account administration


def test_sip_account_crud(client, admin, staff, lib, db):
    from shelfwise.models import AuditLog, SipAccount
    from shelfwise.security import verify_password

    main = lib["branches"]["MAIN"].id
    body = {"login": "kiosk-1", "password": "Kiosk#Passw0rd", "branch_id": main, "name": "Kiosk 1",
            "institution_id": "CENTRAL", "allowed_networks": "10.0.0.0/8,192.168.1.5", "sort_bins": {"hold": "2"}}
    assert client.post("/api/v1/sip/accounts", json=body, headers=staff).status_code == 403
    assert client.get("/api/v1/sip/accounts", headers=staff).status_code == 403
    assert client.post("/api/v1/sip/accounts", json={**body, "password": "short"}, headers=admin).status_code == 422
    assert client.post("/api/v1/sip/accounts", json={**body, "password": None}, headers=admin).status_code == 422
    assert client.post("/api/v1/sip/accounts", json={**body, "allowed_networks": "not-an-ip"}, headers=admin).status_code == 422
    assert client.post("/api/v1/sip/accounts", json={**body, "delimiter": "a"}, headers=admin).status_code == 422
    assert client.post("/api/v1/sip/accounts", json={**body, "encoding": "rot13"}, headers=admin).status_code == 422
    assert client.post("/api/v1/sip/accounts", json={**body, "sort_bins": {"x": "1"}}, headers=admin).status_code == 422
    assert client.post("/api/v1/sip/accounts", json={**body, "branch_id": 999}, headers=admin).status_code == 422
    r = client.post("/api/v1/sip/accounts", json=body, headers=admin)
    assert r.status_code == 201, r.text
    acc = r.json()
    assert "Kiosk#Passw0rd" not in json.dumps(acc) and "password_hash" not in acc and "password" not in acc
    assert acc["allowed_networks"] == "10.0.0.0/8, 192.168.1.5" and acc["branch"]["code"] == "MAIN"
    assert client.post("/api/v1/sip/accounts", json=body, headers=admin).status_code == 409
    listing = client.get("/api/v1/sip/accounts", headers=admin).json()["results"]
    assert [a["login"] for a in listing] == ["kiosk-1"]
    r = client.patch(f"/api/v1/sip/accounts/{acc['id']}", json={"allow_checkout": False, "password": "New#Passw0rd!"},
                     headers=admin)
    assert r.status_code == 200 and r.json()["allow_checkout"] is False and r.json()["name"] == "Kiosk 1"
    db.expire_all()
    assert verify_password(db.get(SipAccount, acc["id"]).password_hash, "New#Passw0rd!")
    assert client.delete(f"/api/v1/sip/accounts/{acc['id']}", headers=admin).status_code == 200
    actions = [a.action for a in db.query(AuditLog).filter(AuditLog.entity == "sip_account")]
    assert actions == ["create", "update", "delete"]
    for a in db.query(AuditLog).filter(AuditLog.entity == "sip_account"):
        assert "Passw0rd" not in json.dumps(a.details)


# ------------------------------------------------------------------ schema.org JSON-LD on OPAC pages


def _jsonld(page: str) -> dict:
    m = re.search(r'<script type="application/ld\+json">(.*?)</script>', page, re.S)
    assert m, "JSON-LD block missing"
    return json.loads(m.group(1))


def test_record_page_has_jsonld_and_open_graph(client, staff, lib, make_book, db):
    from shelfwise.services import catalog, circulation

    b, items = make_book("The Hobbit", authors=["Tolkien, J. R. R."], isbn="9780261103344", pub_year=1937,
                         language="en", publisher="Allen & Unwin", subjects=["Fantasy"], copies=2,
                         description="A hobbit goes on an adventure.")
    catalog.create_item(db, b, {"branch_id": lib["branches"]["EAST"].id, "item_type_id": lib["itypes"]["BOOK"].id})
    db.commit()
    circulation.checkout(db, db.merge(lib["patron"]), db.merge(items[0]), branch_id=lib["branches"]["MAIN"].id)
    db.commit()
    r = client.get(f"/record/{b.id}")
    assert r.status_code == 200
    page = r.text
    ld = _jsonld(page)
    assert ld["@context"] == "https://schema.org" and ld["@type"] == "Book"
    assert ld["name"] == "The Hobbit" and ld["isbn"] == "9780261103344"
    assert ld["author"] == [{"@type": "Person", "name": "J. R. R. Tolkien"}]
    assert ld["datePublished"] == "1937" and ld["inLanguage"] == "en"
    assert ld["url"].endswith(f"/record/{b.id}") and ld["publisher"]["name"] == "Allen & Unwin"
    offers = {o["offeredBy"]["name"]: o for o in ld["offers"]}
    assert set(offers) == {"Central Library", "East Branch"}
    assert offers["Central Library"]["availability"] == "https://schema.org/InStock"
    assert offers["Central Library"]["inventoryLevel"]["value"] == 1
    assert all(o["businessFunction"].endswith("#LeaseOut") for o in ld["offers"])
    assert '<meta property="og:title" content="The Hobbit">' in page
    assert '<meta property="og:type" content="book">' in page
    assert '<meta property="book:isbn" content="9780261103344">' in page
    assert f'<link rel="canonical" href="http://testserver/record/{b.id}">' in page
    assert "<title>The Hobbit · " in page
    assert 'name="description" content="A hobbit goes on an adventure."' in page

    # all copies out -> OutOfStock
    circulation.checkout(db, db.merge(lib["patron"]), db.merge(items[1]), branch_id=lib["branches"]["MAIN"].id)
    db.commit()
    ld = _jsonld(client.get(f"/record/{b.id}").text)
    offers = {o["offeredBy"]["name"]: o for o in ld["offers"]}
    assert offers["Central Library"]["availability"] == "https://schema.org/OutOfStock"


def test_jsonld_is_safely_escaped(client, staff, lib):
    payload = "</script><script>alert(1)</script>"
    r = client.post("/api/v1/biblios", headers=staff, json={"title": payload, "authors": ['Evil, "Quote" <b>']})
    bid = r.json()["id"]
    page = client.get(f"/record/{bid}").text
    assert payload not in page and "<b>" not in page
    ld = _jsonld(page)
    assert ld["name"] == payload  # round-trips exactly once parsed


def test_jsonld_types_and_missing_records(client, lib, make_book):
    film, _ = make_book("Spirited Away", material_type="dvd", itype="DVD", authors=["Miyazaki, Hayao"])
    ld = _jsonld(client.get(f"/record/{film.id}").text)
    assert ld["@type"] == "Movie" and ld["director"][0]["name"] == "Hayao Miyazaki" and "isbn" not in ld
    r = client.get("/record/987654")
    assert r.status_code == 404 and "application/ld+json" not in r.text and 'content="noindex"' in r.text


# ------------------------------------------------------------------ staff pages, seed, CLI


def test_staff_pages_render(client, staff, admin, lib):
    for path in ("/staff/copycat", "/staff/interop"):
        r = client.get(path, headers=staff)
        assert r.status_code == 200, path
        assert 'href="/staff/copycat"' in r.text and 'href="/staff/interop"' in r.text
    assert 'data-page="staff-copycat"' in client.get("/staff/copycat", headers=staff).text
    assert 'data-page="staff-interop"' in client.get("/staff/interop", headers=admin).text
    reader = login(client, "reader1")
    assert client.get("/staff/copycat", headers=reader, follow_redirects=False).status_code == 303
    for asset in ("/static/js/pages/staff-copycat.js", "/static/js/pages/staff-interop.js"):
        assert client.get(asset).status_code == 200


def test_seed_interop_is_idempotent(db, lib):
    from shelfwise.models import CopyCatTarget, SipAccount
    from shelfwise.security import verify_password
    from shelfwise.seed import DEMO_SIP_ACCOUNT, seed_interop

    seed_interop(db)
    seed_interop(db)
    db.commit()
    accounts = db.query(SipAccount).all()
    assert len(accounts) == 1 and accounts[0].login == DEMO_SIP_ACCOUNT[0]
    assert verify_password(accounts[0].password_hash, DEMO_SIP_ACCOUNT[1])
    assert db.query(CopyCatTarget).count() == 1


def test_sip2_cli_command(monkeypatch):
    from shelfwise import __main__ as cli
    from shelfwise.sip2 import server

    seen = {}
    monkeypatch.setattr(server, "run", lambda config: seen.setdefault("config", config))
    assert cli.main(["sip2", "--host", "0.0.0.0", "--port", "6001", "--delimiter", "^", "--login-timeout", "30"]) == 0
    cfg = seen["config"]
    assert (cfg.host, cfg.port, cfg.delimiter, cfg.login_timeout, cfg.certfile) == ("0.0.0.0", 6001, "^", 30.0, None)
