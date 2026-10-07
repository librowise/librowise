"""MARC editor: grid <-> MARCXML <-> mnemonic round trips, validation, diff and save."""

from __future__ import annotations

import pytest
from conftest import login

from librowise.errors import DomainError
from librowise.services import marc_editor as ed

GRID = {
    "leader": "00000nam a2200000 i 4500",
    "fields": [
        {"tag": "001", "value": "ocm 42"},
        {"tag": "008", "value": "200101s2019    xx            000 0 eng d"},
        {"tag": "020", "ind1": " ", "ind2": " ", "subfields": [{"code": "a", "value": "9780306406157"}]},
        {"tag": "100", "ind1": "1", "ind2": " ", "subfields": [{"code": "a", "value": "Martin, Robert C."}]},
        {"tag": "245", "ind1": "1", "ind2": "0", "subfields": [
            {"code": "a", "value": "Clean code :"}, {"code": "b", "value": "a handbook {of} craft $5 /"},
            {"code": "c", "value": "Robert C. Martin."}]},
        {"tag": "650", "ind1": " ", "ind2": "0", "subfields": [
            {"code": "a", "value": "Software engineering"}, {"code": "v", "value": "Handbooks"}]},
        {"tag": "700", "ind1": "1", "ind2": " ", "subfields": [{"code": "a", "value": "Feathers, Michael"}]},
    ],
}


def test_grid_mnemonic_round_trip():
    text = ed.to_mnemonic(GRID)
    assert "=LDR  00000nam\\a2200000\\i\\4500" in text
    assert "=245  10$aClean code :$ba handbook {lcub}of{rcub} craft {dollar}5 /$cRobert C. Martin." in text
    assert "=008  200101s2019\\\\\\\\xx" in text and "=020  \\\\$a9780306406157" in text
    grid, errors = ed.from_mnemonic(text)
    assert not errors and grid == ed.normalize_grid(GRID)


def test_grid_xml_round_trip_and_convert():
    xml = ed.to_xml(GRID)
    assert "<marc:record" in xml or "<record" in xml
    assert ed.from_xml(xml) == ed.normalize_grid(GRID)
    out = ed.convert(GRID, None, "grid", "mnemonic")
    back = ed.convert(None, out["text"], "mnemonic", "xml")
    assert ed.from_xml(back["text"]) == ed.normalize_grid(GRID)


def test_mnemonic_parse_errors_and_blank_indicator_spellings():
    grid, errors = ed.from_mnemonic("=245  1#$aTitle\nnot a field line\n=650  _0\n=500  \\\\$$aBroken\n")
    assert grid["fields"][0] == {"tag": "245", "ind1": "1", "ind2": " ", "subfields": [{"code": "a", "value": "Title"}]}
    assert [e["line"] for e in errors] == [2, 3, 4]
    with pytest.raises(DomainError):
        ed.from_xml("<record><leader>broken")


def test_validation_rules():
    bad = {"leader": "short", "fields": [
        {"tag": "24", "ind1": " ", "ind2": " ", "subfields": [{"code": "a", "value": "x"}]},
        {"tag": "005", "value": "x", "subfields": [{"code": "a", "value": "y"}]},
        {"tag": "100", "ind1": "%", "ind2": " ", "subfields": [{"code": "AB", "value": "Name"}, {"code": "d", "value": " "}]},
        {"tag": "245", "ind1": "1", "ind2": "0", "subfields": [{"code": "b", "value": "no title proper"}]},
        {"tag": "260", "ind1": " ", "ind2": " ", "subfields": []},
        {"tag": "100", "ind1": "1", "ind2": " ", "subfields": [{"code": "a", "value": "Second main entry"}]},
    ]}
    errors, warnings = ed.validate(bad)
    msgs = " | ".join(e["message"] for e in errors)
    assert "Leader must be exactly 24" in msgs
    assert "Tag “24” must be three digits" in msgs
    assert "Control field 005 cannot have subfields" in msgs
    assert "first indicator" in msgs and "subfield code “AB”" in msgs and "$d is empty" in msgs
    assert "needs at least one subfield" in msgs
    assert "245 field with a non-empty $a" in msgs
    assert any("not repeatable" in w["message"] for w in warnings)
    errors, warnings = ed.validate(GRID)
    assert errors == [] and warnings == []


def test_generated_record_save_rederives_fields_and_keeps_items(db, lib, make_book):
    b, items = make_book("Old title", copies=2, authors=["Someone, A."], language="hi", subjects=["Gardening"],
                         pub_year=1999, material_type="book", audience="adult")
    payload = ed.editor_payload(b)
    assert payload["origin"] == "generated" and payload["items"] == 2 and payload["holdings_fields"] == 2
    tags = [f["tag"] for f in payload["grid"]["fields"]]
    assert "952" not in tags and "008" in tags
    f008 = next(f for f in payload["grid"]["fields"] if f["tag"] == "008")["value"]
    assert len(f008) == 40 and f008[35:38] == "hin" and f008[7:11] == "1999"

    grid = payload["grid"]
    for f in grid["fields"]:
        if f["tag"] == "245":
            f["subfields"] = [{"code": "a", "value": "New title :"}, {"code": "b", "value": "the sequel"}]
    grid["fields"].append({"tag": "520", "ind1": " ", "ind2": " ", "subfields": [{"code": "a", "value": "A summary."}]})
    grid["fields"].append({"tag": "952", "ind1": " ", "ind2": " ", "subfields": [{"code": "p", "value": "IGNORED"}]})
    prev = ed.preview(b, grid)
    assert not prev["errors"] and any("952" in w["message"] for w in prev["warnings"])
    changed = {c["field"]: c for c in prev["field_changes"]}
    assert changed["title"]["after"] == "New title" and changed["subtitle"]["after"] == "the sequel"
    assert changed["description"]["after"] == "A summary."
    assert {"op": "+", "text": "=520  \\\\$aA summary."} in prev["marc_diff"]

    res = ed.save(db, b, grid)
    db.commit()
    assert {"title", "subtitle", "description"} <= set(res["changed_fields"])
    assert b.title == "New title" and b.language == "hi" and b.audience == "adult" and b.pub_year == 1999
    assert len([i for i in b.items if i.deleted_at is None]) == 2
    assert "IGNORED" not in b.marc_xml and "<controlfield tag=\"005\">" in b.marc_xml
    from librowise.services import catalog
    assert b.id in catalog.search(db, "sequel").ids  # re-indexed
    again = ed.editor_payload(b)
    assert again["origin"] == "stored"
    assert ed.preview(b, again["grid"])["unchanged"]


def test_save_rejects_invalid_and_language_without_codes_is_kept(db, lib, make_book):
    b, _ = make_book("Kept", language="fr")
    with pytest.raises(DomainError) as exc:
        ed.save(db, b, {"leader": "00000nam a2200000 i 4500", "fields": [{"tag": "100", "ind1": "1", "ind2": " ",
                                                                         "subfields": [{"code": "a", "value": "X"}]}]})
    assert exc.value.code == "marc_invalid" and exc.value.details["errors"]
    ed.save(db, b, {"leader": "00000nam a2200000 i 4500", "fields": [
        {"tag": "245", "ind1": "0", "ind2": "0", "subfields": [{"code": "a", "value": "Kept"}]}]})
    db.commit()
    assert b.language == "fr" and b.authors == []  # no 100/700 any more


def test_marc_editor_api(client, lib, make_book):
    b, _ = make_book("API title")
    staff, patron = login(client, "librarian"), login(client, "reader1")
    assert client.get(f"/api/v1/biblios/{b.id}/marc", headers=patron).status_code == 403
    r = client.get(f"/api/v1/biblios/{b.id}/marc", headers=staff)
    assert r.status_code == 200
    data = r.json()
    grid = data["grid"]
    conv = client.post("/api/v1/marc/convert", headers=staff, json={"from": "grid", "to": "mnemonic", "grid": grid}).json()
    text = conv["text"].replace("$aAPI title", "$aEdited via mnemonic")
    back = client.post("/api/v1/marc/convert", headers=staff, json={"from": "mnemonic", "to": "xml", "text": text}).json()
    assert back["validation"]["errors"] == [] and "Edited via mnemonic" in back["text"]
    edited = back["grid"]
    prev = client.post(f"/api/v1/biblios/{b.id}/marc/preview", headers=staff, json=edited).json()
    assert prev["field_changes"][0]["field"] == "title"
    detail = client.get(f"/api/v1/biblios/{b.id}").json()
    stale = client.put(f"/api/v1/biblios/{b.id}/marc", headers=staff,
                       json={"grid": edited, "expected_updated_at": "2001-01-01T00:00:00"})
    assert stale.status_code == 409 and stale.json()["code"] == "stale_record"
    r = client.put(f"/api/v1/biblios/{b.id}/marc", headers=staff,
                   json={"grid": edited, "expected_updated_at": detail["updated_at"]})
    assert r.status_code == 200, r.text
    assert r.json()["biblio"]["title"] == "Edited via mnemonic" and r.json()["biblio"]["has_marc"]
    bad = client.put(f"/api/v1/biblios/{b.id}/marc", headers=staff, json={"grid": {"leader": "x", "fields": []}})
    assert bad.status_code == 400 and bad.json()["code"] == "marc_invalid" and bad.json()["errors"]
    assert client.put(f"/api/v1/biblios/{b.id}/marc", headers=patron, json={"grid": edited}).status_code == 403
    d = client.get("/api/v1/marc/dictionary", headers=staff).json()["fields"]
    assert len(d) >= 60 and d["245"]["repeatable"] is False and d["650"]["subfields"]["x"] == "General subdivision"
    page = client.get(f"/staff/catalog/{b.id}/marc", headers=staff)
    assert page.status_code == 200 and "staff-marc-editor" in page.text
