"""Authority control: normalisation, linking, variant rewriting, merge/rename, MARC, browse, API."""

from __future__ import annotations

import pymarc
import pytest
from conftest import login
from sqlalchemy import select

from shelfwise.errors import Conflict
from shelfwise.models import Authority, Biblio, BiblioAuthority
from shelfwise.services import authorities as auth
from shelfwise.services import catalog
from shelfwise.services import settings as settings_svc


def links(db, biblio_id):
    return sorted((l.role, l.authority_id) for l in db.scalars(select(BiblioAuthority).where(BiblioAuthority.biblio_id == biblio_id)))


def new(db, **data):
    a = auth.create_authority(db, data)
    auth.relink_for(db, [a])
    db.commit()
    return a


# ------------------------------------------------------------------ normalisation & matching


@pytest.mark.parametrize("a,b", [
    ("Brontë, Charlotte.", "bronte charlotte"),
    ("  BRONTE,   charlotte ", "bronte charlotte"),
    ("Æsop", "aesop"),
    ("Øster, Ægir", "oster aegir"),
    ("Straße", "strasse"),
    ("World War, 1939-1945 -- Fiction", "world war 1939 1945 fiction"),
    ("Dostoyevsky, Fyodor (Фёдор)", "dostoyevsky fyodor федор"),
])
def test_normalize_heading(a, b):
    assert auth.normalize_heading(a) == b


def test_name_key_and_clean_heading():
    assert auth.name_key("Austen, Jane, 1775-1817") == "austen jane"
    assert auth.name_key("Tolkien, J. R. R. (John Ronald Reuel), 1892-1973.") == "tolkien j r r"
    assert auth.clean_heading("Sea stories.") == "Sea stories"
    assert auth.clean_heading("Wells, H. G.") == "Wells, H. G."  # initials keep their full stop
    assert auth.split_subdivisions("Whaling -- Fiction--History") == ["Whaling", "Fiction", "History"]


def test_auto_link_and_variant_rewrite_on_create_and_update(db, lib):
    twain = new(db, auth_type="personal_name", heading="Twain, Mark", variants=["Clemens, Samuel Langhorne"])
    whaling = new(db, auth_type="topical_subject", heading="Whaling", variants=["Whale fishing"])
    b = catalog.create_biblio(db, {"title": "Tom Sawyer", "authors": ["CLEMENS, Samuel Langhorne", "Nobody, A."],
                                   "subjects": ["Whale fishing -- Fiction", "Rivers"]})
    db.commit()
    assert b.authors == ["Twain, Mark", "Nobody, A."]
    assert b.subjects == ["Whaling -- Fiction", "Rivers"]
    assert links(db, b.id) == sorted([("author", twain.id), ("subject", whaling.id)])
    # the rewritten form is what gets indexed
    assert b.id in catalog.search(db, "twain").ids
    # update: removing the heading removes the link, adding a variant links and rewrites
    catalog.update_biblio(db, b, {"authors": ["Nobody, A."], "subjects": ["whale-fishing"]})
    db.commit()
    assert b.subjects == ["Whaling"]
    assert links(db, b.id) == [("subject", whaling.id)]


def test_subject_names_and_series(db, lib):
    holmes = new(db, auth_type="personal_name", heading="Holmes, Sherlock (Fictitious character)")
    series = new(db, auth_type="uniform_title", heading="Penguin classics", variants=["Penguin classic series"])
    b = catalog.create_biblio(db, {"title": "Hound", "subjects": ["holmes, sherlock (fictitious character) -- Fiction"],
                                   "series": "Penguin Classic Series"})
    db.commit()
    assert b.subjects == ["Holmes, Sherlock (Fictitious character) -- Fiction"]
    assert b.series == "Penguin classics"
    assert links(db, b.id) == sorted([("series", series.id), ("subject", holmes.id)])
    # a topical subject authority never controls an author heading
    new(db, auth_type="topical_subject", heading="Dickens, Charles")
    b2 = catalog.create_biblio(db, {"title": "Bleak House", "authors": ["Dickens, Charles"]})
    db.commit()
    assert links(db, b2.id) == []


def test_auto_link_policy_can_be_disabled(db, lib):
    new(db, auth_type="personal_name", heading="Twain, Mark", variants=["Clemens, Samuel"])
    settings_svc.set_value(db, "authority_auto_link", False)
    db.commit()
    b = catalog.create_biblio(db, {"title": "Roughing It", "authors": ["Clemens, Samuel"]})
    db.commit()
    assert b.authors == ["Clemens, Samuel"] and links(db, b.id) == []
    stats = auth.relink_all(db)  # explicit relink still works
    db.commit()
    assert stats["rewritten"] == 1 and b.authors == ["Twain, Mark"]


def test_name_key_links_without_rewriting_and_never_guesses(db, lib):
    austen = new(db, auth_type="personal_name", heading="Austen, Jane, 1775-1817")
    b = catalog.create_biblio(db, {"title": "Emma", "authors": ["Austen, Jane"]})
    db.commit()
    assert b.authors == ["Austen, Jane"] and links(db, b.id) == [("author", austen.id)]
    new(db, auth_type="personal_name", heading="Smith, John, 1580-1631")
    new(db, auth_type="personal_name", heading="Smith, John, 1900-1980")
    b2 = catalog.create_biblio(db, {"title": "Ambiguous", "authors": ["Smith, John"]})
    db.commit()
    assert links(db, b2.id) == []


def test_relink_existing_records_when_authority_created(db, lib, make_book):
    b1, _ = make_book("Life on the Mississippi", authors=["Clemens, Samuel"])
    b2, _ = make_book("Huckleberry Finn", authors=["Twain, Mark"])
    a = auth.create_authority(db, {"auth_type": "personal_name", "heading": "Twain, Mark", "variants": ["Clemens, Samuel"]})
    stats = auth.relink_for(db, [a])
    db.commit()
    assert stats["records"] == 2 and stats["rewritten"] == 1
    assert b1.authors == ["Twain, Mark"] and links(db, b1.id) == [("author", a.id)]
    again = auth.relink_all(db)
    db.commit()
    assert again["rewritten"] == 0 and again["links"] == 2  # idempotent


def test_collisions_are_rejected(db, lib):
    new(db, auth_type="personal_name", heading="Twain, Mark", variants=["Clemens, Samuel"])
    with pytest.raises(Conflict):
        auth.create_authority(db, {"auth_type": "personal_name", "heading": "twain mark"})
    with pytest.raises(Conflict):
        auth.create_authority(db, {"auth_type": "personal_name", "heading": "Clemens, Samuel"})
    # same heading under another type is fine
    auth.create_authority(db, {"auth_type": "topical_subject", "heading": "Twain, Mark"})


# ------------------------------------------------------------------ rename / merge / delete


def test_rename_propagates_and_reindexes(db, lib, make_book):
    a = new(db, auth_type="topical_subject", heading="Whaling")
    b, _ = make_book("Moby-Dick", subjects=["Whaling -- Fiction", "Sea stories"])
    assert b.subjects[0] == "Whaling -- Fiction" and links(db, b.id) == [("subject", a.id)]
    res = auth.rename(db, a, "Whale hunting")
    db.commit()
    assert res["records"] == 1 and res["kept_variant"] == "Whaling"
    assert b.subjects == ["Whale hunting -- Fiction", "Sea stories"]
    assert [v.heading for v in a.variants] == ["Whaling"]
    assert b.id in catalog.search(db, "hunting").ids
    # the old form is now a variant, so new records using it are rewritten
    b2 = catalog.create_biblio(db, {"title": "In the Heart of the Sea", "subjects": ["whaling"]})
    db.commit()
    assert b2.subjects == ["Whale hunting"]


def test_merge_preview_then_apply(db, lib, make_book):
    src = new(db, auth_type="personal_name", heading="Clemens, Samuel", variants=["Clemens, S. L."])
    tgt = new(db, auth_type="personal_name", heading="Twain, Mark", see_also=[{"heading": "Snodgrass, Quintus Curtius"}])
    b1, _ = make_book("A", authors=["Clemens, Samuel"])
    b2, _ = make_book("B", authors=["Clemens, S. L.", "Other, Person"])
    b3, _ = make_book("C", authors=["Twain, Mark"])
    assert b2.authors[0] == "Clemens, Samuel"  # variant already rewritten to the source heading

    preview = auth.merge(db, src, tgt, dry_run=True)
    assert preview["records"] == 2 and preview["dry_run"]
    assert {c["before"] for e in preview["changes"] for c in e["changes"]} == {"Clemens, Samuel"}
    assert set(preview["variants_added"]) == {"Clemens, Samuel", "Clemens, S. L."}
    db.rollback()
    assert b1.authors == ["Clemens, Samuel"] and src.deleted_at is None  # nothing applied

    done = auth.merge(db, src, tgt, dry_run=False)
    db.commit()
    assert done["records"] == 2
    assert b1.authors == ["Twain, Mark"] and b2.authors == ["Twain, Mark", "Other, Person"] and b3.authors == ["Twain, Mark"]
    assert src.deleted_at is not None
    assert {v.heading for v in tgt.variants} == {"Clemens, Samuel", "Clemens, S. L."}
    assert all(aid == tgt.id for _, aid in links(db, b1.id) + links(db, b2.id))
    assert auth.usage_counts(db, [tgt.id]) == {tgt.id: 3}
    b4 = catalog.create_biblio(db, {"title": "D", "authors": ["Clemens, S. L."]})
    db.commit()
    assert b4.authors == ["Twain, Mark"]


def test_merge_requires_same_type(db, lib):
    a = new(db, auth_type="personal_name", heading="Paris")
    b = new(db, auth_type="geographic", heading="Paris (France)")
    with pytest.raises(Conflict):
        auth.merge(db, a, b)


def test_delete_protected_while_in_use(db, lib, make_book):
    a = new(db, auth_type="topical_subject", heading="Pirates")
    make_book("Treasure Island", subjects=["Pirates -- Fiction"])
    with pytest.raises(Conflict) as exc:
        auth.delete_authority(db, a)
    assert exc.value.details["usage"] == 1
    unused = new(db, auth_type="topical_subject", heading="Unused heading")
    auth.delete_authority(db, unused)
    db.commit()
    assert unused.deleted_at is not None
    again = new(db, auth_type="topical_subject", heading="Unused heading")  # soft-deleted rows don't block
    assert again.id != unused.id


def test_update_authority_variants_and_type(db, lib, make_book):
    a = new(db, auth_type="topical_subject", heading="Cats")
    b, _ = make_book("Cat book", subjects=["Felines"])
    assert links(db, b.id) == []
    res = auth.update_authority(db, a, {"variants": ["Felines", "Felis catus"], "notes": "LCSH form"})
    db.commit()
    assert res["relink"]["rewritten"] == 1 and b.subjects == ["Cats"] and a.notes == "LCSH form"
    res = auth.update_authority(db, a, {"heading": "Cats (Domestic)", "variants": ["Felines"]})
    db.commit()
    assert b.subjects == ["Cats (Domestic)"]
    assert {v.heading for v in a.variants} == {"Felines", "Cats"}


# ------------------------------------------------------------------ bootstrap, reports, MARC


def test_generate_from_catalogue_and_unlinked_report(db, lib, make_book):
    make_book("A", authors=["Christie, Agatha"], subjects=["Detective and mystery stories", "Islands -- Fiction"])
    make_book("B", authors=["Christie, Agatha", "Royal Geographical Society"], subjects=["Detective and mystery stories"],
              series="Poirot mysteries")
    report = auth.unlinked_headings(db)
    by_heading = {r["heading"]: r for r in report["results"]}
    assert by_heading["Christie, Agatha"]["count"] == 2
    assert by_heading["Islands"]["role"] == "subject"  # subjects are reported by main heading
    assert by_heading["Royal Geographical Society"]["suggested_type"] == "corporate_name"

    preview = auth.generate_from_catalogue(db, dry_run=True)
    db.rollback()
    assert preview["would_create"] == 5 and db.scalar(select(Authority.id)) is None
    res = auth.generate_from_catalogue(db)
    db.commit()
    assert res["created"] == 5 and res["by_type"]["uniform_title"] == 1
    assert auth.unlinked_headings(db)["total"] == 0
    # near-miss headings get a fuzzy suggestion
    make_book("C", authors=["Christie, Agathа"])  # Cyrillic 'а'
    sugg = auth.unlinked_headings(db, role="author")["results"][0]["suggestion"]
    assert sugg and sugg["heading"] == "Christie, Agatha"


def _authority_marcxml() -> bytes:
    S = pymarc.Subfield
    recs = []
    r = pymarc.Record(leader="00000nz  a2200000n  4500")
    r.add_field(pymarc.Field(tag="001", data="n79021164"))
    r.add_field(pymarc.Field(tag="008", data="790115n| azannaabn          |a aaa      "))
    r.add_field(pymarc.Field(tag="010", indicators=[" ", " "], subfields=[S("a", "n  79021164")]))
    r.add_field(pymarc.Field(tag="100", indicators=["1", " "], subfields=[S("a", "Twain, Mark,"), S("d", "1835-1910.")]))
    r.add_field(pymarc.Field(tag="400", indicators=["1", " "], subfields=[S("a", "Clemens, Samuel Langhorne,"), S("d", "1835-1910")]))
    r.add_field(pymarc.Field(tag="500", indicators=["1", " "], subfields=[S("w", "a"), S("a", "Snodgrass, Quintus Curtius")]))
    r.add_field(pymarc.Field(tag="670", indicators=[" ", " "], subfields=[S("a", "His Huckleberry Finn, 1885.")]))
    recs.append(r)
    r = pymarc.Record(leader="00000nz  a2200000n  4500")
    r.add_field(pymarc.Field(tag="008", data="860211i| anannbabn          |a ana      "))
    r.add_field(pymarc.Field(tag="150", indicators=[" ", " "], subfields=[S("a", "Whaling"), S("v", "Fiction")]))
    r.add_field(pymarc.Field(tag="450", indicators=[" ", " "], subfields=[S("a", "Whale fishing")]))
    r.add_field(pymarc.Field(tag="550", indicators=[" ", " "], subfields=[S("w", "g"), S("a", "Fisheries")]))
    recs.append(r)
    bad = pymarc.Record()
    bad.add_field(pymarc.Field(tag="245", indicators=["0", "0"], subfields=[S("a", "Not an authority")]))
    recs.append(bad)
    return b"<collection xmlns='http://www.loc.gov/MARC21/slim'>" + b"".join(pymarc.record_to_xml(x) for x in recs) + b"</collection>"


def test_marc_authority_import_export_round_trip(db, lib, make_book):
    b, _ = make_book("Huck Finn", authors=["Clemens, Samuel Langhorne, 1835-1910"])
    stats = auth.import_marc(db, _authority_marcxml())
    db.commit()
    assert stats["created"] == 2 and stats["skipped"] == 1 and not stats["errors"]
    twain = db.scalar(select(Authority).where(Authority.heading == "Twain, Mark, 1835-1910"))
    assert twain.source == "lcnaf" and twain.marc_xml
    assert [v.heading for v in twain.variants] == ["Clemens, Samuel Langhorne, 1835-1910"]
    assert twain.see_also == [{"heading": "Snodgrass, Quintus Curtius", "relationship": "earlier", "authority_id": None}]
    assert "Huckleberry Finn" in twain.notes
    whaling = db.scalar(select(Authority).where(Authority.heading == "Whaling -- Fiction"))
    assert whaling.auth_type.value == "topical_subject" and whaling.source == "lcsh"
    assert b.authors == ["Twain, Mark, 1835-1910"]  # import relinks and rewrites the variant

    # re-importing updates instead of duplicating
    again = auth.import_marc(db, _authority_marcxml())
    db.commit()
    assert again["created"] == 0 and again["updated"] == 2

    exported = auth.export([twain, whaling], "xml")
    recs = pymarc.parse_xml_to_array(__import__("io").BytesIO(exported))
    assert recs[0]["100"].get_subfields("a", "d") == ["Twain, Mark,", "1835-1910"]
    assert recs[0]["500"].get_subfields("w") == ["a"]
    assert recs[1]["150"].get_subfields("a", "x") == ["Whaling", "Fiction"]
    assert len(recs[0]["008"].data) == 40 and recs[1]["008"].data[11] == "a"
    parsed = auth.parse_authority_record(recs[0])
    assert parsed["heading"] == "Twain, Mark, 1835-1910"
    assert parsed["variants"] == ["Clemens, Samuel Langhorne, 1835-1910"]
    assert parsed["see_also"] == [{"heading": "Snodgrass, Quintus Curtius", "relationship": "earlier"}]
    assert auth.export([twain], "mrc").endswith(b"\x1d")


# ------------------------------------------------------------------ API, OPAC browse, CLI


def test_authority_api_permissions_and_flow(client, lib, make_book):
    make_book("Moby-Dick", authors=["Melville, H."], subjects=["Whale fishing -- Fiction"])
    body = {"auth_type": "topical_subject", "heading": "Whaling", "variants": ["Whale fishing"],
            "see_also": [{"heading": "Fisheries", "relationship": "broader"}]}
    assert client.post("/api/v1/authorities", json=body).status_code == 401
    patron = login(client, "reader1")
    staff = login(client, "librarian")
    assert client.post("/api/v1/authorities", headers=patron, json=body).status_code == 403
    assert client.get("/api/v1/authorities", headers=patron).status_code == 403
    r = client.post("/api/v1/authorities", headers=staff, json=body)
    assert r.status_code == 201, r.text
    a = r.json()
    assert a["usage"] == 1 and a["relink"]["rewritten"] == 1
    assert client.post("/api/v1/authorities", headers=staff, json=body).status_code == 409
    lst = client.get("/api/v1/authorities?q=whale%20fish", headers=staff).json()
    assert lst["total"] == 1 and lst["results"][0]["usage"] == 1
    assert client.get("/api/v1/authorities?used=unused", headers=staff).json()["total"] == 0
    detail = client.get(f"/api/v1/authorities/{a['id']}", headers=staff).json()
    assert detail["records"][0]["title"] == "Moby-Dick" and detail["records"][0]["heading"] == "Whaling -- Fiction"
    assert client.delete(f"/api/v1/authorities/{a['id']}", headers=staff).status_code == 409
    r = client.post(f"/api/v1/authorities/{a['id']}/rename", headers=staff, json={"heading": "Whale hunting"})
    assert r.status_code == 200 and r.json()["records"] == 1
    assert client.get("/api/v1/search?subject=Whale%20hunting%20--%20Fiction").json()["total"] == 1
    other = client.post("/api/v1/authorities", headers=staff, json={"auth_type": "topical_subject", "heading": "Whales"}).json()
    prev = client.post("/api/v1/authorities/merge", headers=staff, json={"source_id": a["id"], "target_id": other["id"]})
    assert prev.status_code == 200 and prev.json()["dry_run"] and prev.json()["records"] == 1
    assert client.get(f"/api/v1/authorities/{a['id']}", headers=staff).status_code == 200  # untouched
    done = client.post("/api/v1/authorities/merge", headers=staff,
                       json={"source_id": a["id"], "target_id": other["id"], "dry_run": False})
    assert done.status_code == 200
    assert client.get(f"/api/v1/authorities/{a['id']}", headers=staff).status_code == 404
    biblio_id = done.json()["changes"][0]["biblio_id"]
    assert client.get(f"/api/v1/biblios/{biblio_id}/authorities", headers=staff).json()["results"][0]["authorised"] == "Whales"
    assert client.get("/api/v1/authorities/unlinked?role=author", headers=staff).json()["results"][0]["heading"] == "Melville, H."
    xml = client.get("/api/v1/authorities/export?fmt=xml", headers=staff)
    assert xml.status_code == 200 and b"<marc:record" in xml.content or b"<record" in xml.content
    files = {"file": ("auth.xml", _authority_marcxml(), "application/xml")}
    imp = client.post("/api/v1/authorities/import", headers=staff, files=files)
    assert imp.status_code == 200 and imp.json()["created"] == 2
    gen = client.post("/api/v1/authorities/generate", headers=staff, json={"dry_run": True})
    assert gen.status_code == 200 and gen.json()["would_create"] >= 1
    assert client.post("/api/v1/authorities/relink", headers=patron).status_code == 403
    assert client.post("/api/v1/authorities/relink", headers=staff).status_code == 200


def test_opac_browse_see_and_see_also(client, db, lib, make_book):
    twain = new(db, auth_type="personal_name", heading="Twain, Mark", variants=["Clemens, Samuel"],
                see_also=[{"heading": "Snodgrass, Quintus Curtius", "relationship": "earlier"}])
    snod = new(db, auth_type="personal_name", heading="Snodgrass, Quintus Curtius")
    new(db, auth_type="personal_name", heading="Unused, Person")
    make_book("Huck", authors=["Twain, Mark"])
    make_book("Letters", authors=["Snodgrass, Quintus Curtius"])
    r = client.get("/api/v1/browse?index=authors").json()
    kinds = [(e["kind"], e["heading"]) for e in r["entries"]]
    assert kinds == [("see", "Clemens, Samuel"), ("heading", "Snodgrass, Quintus Curtius"), ("heading", "Twain, Mark")]
    tw = r["entries"][2]
    assert tw["count"] == 1 and tw["see_also"] == [{"heading": "Snodgrass, Quintus Curtius", "relationship": "earlier",
                                                    "id": snod.id, "count": 1}]
    assert r["entries"][0]["see"]["id"] == twain.id
    r = client.get("/api/v1/browse?index=authors&start=clemens samuel").json()
    assert r["exact"]["kind"] == "see" and r["exact"]["see"]["heading"] == "Twain, Mark"
    page1 = client.get("/api/v1/browse?index=authors&limit=2").json()
    assert len(page1["entries"]) == 2 and page1["next"] and page1["prev"] is None
    page2 = client.get(f"/api/v1/browse?index=authors&limit=2&after={page1['next']}").json()
    assert [e["heading"] for e in page2["entries"]] == ["Twain, Mark"] and page2["next"] is None
    back = client.get(f"/api/v1/browse?index=authors&limit=2&before={page2['prev']}").json()
    assert [e["heading"] for e in back["entries"]] == [e["heading"] for e in page1["entries"]]
    assert client.get(f"/api/v1/browse/authorities/{twain.id}").json()["usage"] == 1
    assert client.get("/browse").status_code == 200
    assert client.get("/browse?index=subjects&start=a").status_code == 200


def test_cli_relink(engine, db, lib, make_book):
    from shelfwise.__main__ import main

    b, _ = make_book("Roughing It", authors=["Clemens, Samuel"])
    settings_svc.set_value(db, "authority_auto_link", False)
    auth.create_authority(db, {"auth_type": "personal_name", "heading": "Twain, Mark", "variants": ["Clemens, Samuel"]})
    db.commit()
    assert main(["authorities", "relink"]) == 0
    db.expire_all()
    assert db.get(Biblio, b.id).authors == ["Twain, Mark"]
