"""Code 128 encoding, label sheet pagination, layouts, print jobs and the print page."""

from __future__ import annotations

import pytest
from conftest import login

from librowise.errors import DomainError
from librowise.services import barcodes, labels

# ------------------------------------------------------------------ Code 128


def test_pattern_table_is_well_formed():
    assert len(barcodes.PATTERNS) == 107
    assert all(len(p) == 6 and sum(map(int, p)) == 11 for p in barcodes.PATTERNS[:106])
    assert sum(map(int, barcodes.PATTERNS[106])) == 13
    assert len(set(barcodes.PATTERNS)) == 107


def _bits(value: int) -> str:
    return "".join(("1" if k % 2 == 0 else "0") * int(w) for k, w in enumerate(barcodes.PATTERNS[value]))


@pytest.mark.parametrize("value,bits", [
    (0, "11011001100"),  # space in subset B
    (16, "10011101100"),  # '0'
    (33, "10100011000"),  # 'A'
    (65, "10010110000"),  # 'a'
    (99, "10111011110"),  # CODE C
    (100, "10111101110"),  # CODE B
    (103, "11010000100"),  # START A
    (104, "11010010000"),  # START B
    (105, "11010011100"),  # START C
    (106, "1100011101011"),  # STOP
])
def test_reference_symbol_patterns(value, bits):
    assert _bits(value) == bits


@pytest.mark.parametrize("data,values", [
    # "Wikipedia" — the classic subset B worked example, check symbol 88
    ("Wikipedia", [104, 55, 73, 75, 73, 80, 69, 68, 73, 65, 88, 106]),
    # even digit string: subset C pairs, check (105 + 12*1 + 34*2) % 103 = 82
    ("1234", [105, 12, 34, 82, 106]),
    # odd digit string: C for the pairs, the last digit in B
    ("12345", [105, 12, 34, 100, 21, 54, 106]),
    # Librowise item barcode: letters in B, then switch to C for the 8-digit run
    ("SW00000001", [104, 51, 55, 99, 0, 0, 0, 1, 54, 106]),
    # odd run at the end: first digit stays in B
    ("AB12345", [104, 33, 34, 17, 99, 23, 45, 7, 106]),
    # short digit runs mid-data stay in B
    ("A12B", [104, 33, 17, 18, 34, 52, 106]),
])
def test_encode_known_values_and_checksums(data, values):
    assert barcodes.encode(data) == values
    assert barcodes.checksum(values[:-2]) == values[-2]


def test_modules_decode_back_to_symbols():
    data = "SW00012345"
    bits = barcodes.modules(data)
    values = barcodes.encode(data)
    assert len(bits) == 11 * (len(values) - 1) + 13
    lookup = {_bits(v): v for v in range(107)}
    decoded = [lookup[bits[i:i + 11]] for i in range(0, len(bits) - 13, 11)] + [lookup[bits[-13:]]]
    assert decoded == values
    assert bits.startswith("11010010000") and bits.endswith("1100011101011")


def test_encode_rejects_unsupported_input_and_svg_is_safe():
    with pytest.raises(ValueError):
        barcodes.encode("")
    with pytest.raises(ValueError):
        barcodes.encode("café")
    svg = barcodes.svg("<x&y>")
    assert svg.startswith("<svg") and "aria-label=\"Barcode &lt;x&amp;y&gt;\"" in svg and "<x&y>" not in svg
    assert "<text" not in barcodes.svg("123", text=False)


# ------------------------------------------------------------------ pagination & content


def test_paginate_with_start_offset():
    pages = labels.paginate(["a", "b", "c", "d", "e"], rows=2, cols=2, start=3)
    assert pages == [[None, None, "a", "b"], ["c", "d", "e", None]]
    assert labels.paginate(["a"], 2, 2, start=99) == [[None, None, None, "a"]]  # clamped to the last cell
    assert labels.paginate([], 2, 2) == []
    assert len(labels.paginate(list(range(21)), 7, 3, start=1)) == 1
    assert len(labels.paginate(list(range(21)), 7, 3, start=2)) == 2


@pytest.mark.parametrize("cn,split,lines", [
    ("823.912 CHR", False, ["823.912", "CHR"]),
    ("823.912 CHR", True, ["823", ".912", "CHR"]),
    ("QA76.73 .P98 2019", False, ["QA", "76.73", ".P98", "2019"]),
    ("R 030 ENC", False, ["R", "030", "ENC"]),
    ("", False, []),
    ("a b c d e f g h", False, ["a", "b", "c", "d", "e", "f g h"]),
    ("QA76.76 .D47 M37 2009", False, ["QA", "76.76", ".D47", "M37", "2009"]),  # cutters never split
])
def test_split_call_number(cn, split, lines):
    assert labels.split_call_number(cn, split_decimal=split) == lines


def test_fit_font_shrinks_long_call_numbers():
    from librowise.models import LabelLayout

    layout = LabelLayout(**{k: v for k, v in labels.PRESETS[3].items() if k != "page_size"}, page_width=210, page_height=297)
    assert labels.fit_font(["823.8", "DOY"], layout) == layout.font_size
    small = labels.fit_font(["QA", "76.76", ".D47", "M37", "2009", "c.2"], layout)
    assert small < layout.font_size and 6 * small * 0.3528 * 1.2 <= layout.label_height - 2 * layout.padding
    assert labels.fit_font(["X" * 200], layout) == 4.0  # never below a legible minimum


def test_presets_are_valid_and_overflow_is_rejected():
    for p in labels.PRESETS:
        labels.validate_layout(p)
    bad = {**labels.PRESETS[0], "cols": 4}
    with pytest.raises(DomainError) as exc:
        labels.validate_layout(bad)
    assert "wide in total" in exc.value.message


def test_build_item_spine_and_patron_jobs(db, lib, make_book):
    b, items = make_book("Murder on the Orient Express", copies=3, classification="823.912")
    job = labels.build(db, {"kind": "item", "source": "barcodes",
                            "barcodes": f"{items[0].barcode}\nNOPE\n{items[1].barcode}", "start": 20, "copies": 2})
    assert job["count"] == 4 and job["missing"] == ["NOPE"] and job["sheets"] == 2
    first = job["pages"][0]
    assert [c["entry"] is None for c in first[:19]] == [True] * 19 and first[19]["entry"]["barcode"] == items[0].barcode
    assert first[20]["entry"]["barcode"] == items[0].barcode  # copies are adjacent
    cell = first[19]
    assert (cell["row"], cell["col"]) == (7, 2)
    layout = job["layout"]
    assert cell["left"] == pytest.approx(layout["margin_left"] + layout["label_width"] + layout["gutter_x"])
    assert cell["entry"]["barcode_svg"].startswith("<svg")
    spine = labels.build(db, {"kind": "spine", "source": "biblio", "biblio_id": b.id})
    assert spine["count"] == 3 and spine["pages"][0][0]["entry"]["lines"] == ["823.912"]
    cards = labels.build(db, {"kind": "patron", "patron_q": "reader"})
    names = [c["entry"]["card_number"] for c in cards["pages"][0] if c["entry"]]
    assert set(names) == {"reader1", "reader2"} and cards["layout"]["kind"] == "patron"
    with pytest.raises(DomainError):
        labels.build(db, {"kind": "patron"})


def test_labels_api_and_print_page(client, lib, make_book):
    b, items = make_book("Dracula", copies=2)
    staff, patron = login(client, "librarian"), login(client, "reader1")
    r = client.get("/api/v1/labels/layouts", headers=staff)
    assert r.status_code == 200 and len(r.json()["results"]) == len(labels.PRESETS)
    preset = r.json()["results"][0]
    same = {k: preset[k] for k in labels.LAYOUT_FIELDS}
    assert client.put(f"/api/v1/labels/layouts/{preset['id']}", headers=staff, json=same).status_code == 409
    body = {"name": "My sheet", "kind": "item", "page_size": "A4", "rows": 2, "cols": 2, "margin_top": 10, "margin_left": 10,
            "gutter_x": 5, "gutter_y": 5, "label_width": 90, "label_height": 60, "padding": 2, "font_size": 9}
    created = client.post("/api/v1/labels/layouts", headers=staff, json=body)
    assert created.status_code == 201, created.text
    lid = created.json()["id"]
    assert client.post("/api/v1/labels/layouts", headers=staff, json=body).status_code == 409
    too_wide = client.post("/api/v1/labels/layouts", headers=staff, json={**body, "name": "Too wide", "label_width": 120})
    assert too_wide.status_code == 400 and too_wide.json()["problems"]
    prev = client.post("/api/v1/labels/preview", headers=staff, json={
        "kind": "item", "layout_id": lid, "start": 4, "barcodes": [items[0].barcode, items[1].barcode, "MISSING"]})
    assert prev.status_code == 200
    p = prev.json()
    assert p["count"] == 2 and p["sheets"] == 2 and p["missing"] == ["MISSING"] and p["blank_cells"] == 3 + 3
    assert "barcode_svg" not in p["entries"][0]
    assert client.post("/api/v1/labels/preview", headers=patron, json={"kind": "item", "barcodes": "x"}).status_code == 403
    svg = client.get(f"/api/v1/barcodes/code128.svg?data={items[0].barcode}", headers=staff)
    assert svg.status_code == 200 and svg.headers["content-type"].startswith("image/svg+xml")
    assert client.get("/api/v1/barcodes/code128.svg?data=caf%C3%A9", headers=staff).status_code == 422

    page = client.get(f"/staff/labels/print?kind=item&layout_id={lid}&barcodes={items[0].barcode}&start=2", headers=staff)
    assert page.status_code == 200
    assert page.text.count('class="label-cell item"') == 1 and page.text.count("label-cell item blank") == 3
    assert "@page { size: 210.0mm 297.0mm" in page.text and "<script>" not in page.text.split("</head>")[1]
    posted = client.post("/staff/labels/print", headers=staff, data={"kind": "spine", "source": "biblio", "biblio_id": str(b.id)})
    assert posted.status_code == 200 and posted.text.count('class="label-cell spine"') == 2
    cards = client.get("/staff/labels/print?kind=patron&patron_q=reader1", headers=staff)
    assert cards.status_code == 200 and "reader1" in cards.text and "label-cell patron" in cards.text
    err = client.get("/staff/labels/print?kind=item&barcodes=", headers=staff)
    assert err.status_code == 200 and "Enter or scan at least one barcode" in err.text
    denied = client.get("/staff/labels/print?kind=item&barcodes=x", headers=patron)
    assert "permission" in denied.text
    assert client.delete(f"/api/v1/labels/layouts/{lid}", headers=staff).status_code == 204
    assert client.get("/staff/labels", headers=staff).status_code == 200
