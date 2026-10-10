"""Collection redesign: record tools (duplicates, history, due dates, holds by record), the acquisitions
order lifecycle (draft → ordered → received), budget breakdown, vendor/budget editing, and the redesigned
collection pages (shared stylesheet, breadcrumbs for detail pages, translated headers)."""

from __future__ import annotations

from conftest import login

from librowise.models import OrderStatus, PurchaseOrder
from librowise.services import record_tools

API = "/api/v1"


# ------------------------------------------------------------------ record tools


def test_title_key_ignores_case_punctuation_and_articles():
    assert record_tools.title_key("The Hobbit: or, There and Back Again") == "hobbit or there and back again"
    assert record_tools.title_key("Émile") == "emile"
    assert record_tools.title_key(None) == ""


def test_duplicates_by_isbn_title_and_author(client, staff, make_book):
    a, _ = make_book("The Hound of the Baskervilles", isbn="9780140437867", authors=["Doyle, Arthur Conan"])
    b, _ = make_book("Hound of the Baskervilles", authors=["Doyle, Arthur Conan"])
    c, _ = make_book("Unrelated Title", isbn="9780140437867")
    make_book("A Study in Scarlet", authors=["Doyle, Arthur Conan"])
    r = client.get(f"{API}/biblios/{a.id}/duplicates", headers=staff)
    assert r.status_code == 200
    rows = {x["id"]: x for x in r.json()["results"]}
    assert a.id not in rows  # never itself
    assert "isbn" in rows[c.id]["reasons"]
    assert {"title", "author"} <= set(rows[b.id]["reasons"])
    assert all(x["title"] != "A Study in Scarlet" for x in rows.values())
    # live check while keying a new record
    r = client.post(f"{API}/cataloging/duplicates", headers=staff,
                    json={"title": "hound of the baskervilles!", "authors": ["Doyle, A. C."], "exclude_id": b.id})
    ids = [x["id"] for x in r.json()["results"]]
    assert a.id in ids and b.id not in ids


def test_duplicates_need_staff(client, lib, make_book):
    a, _ = make_book("Private")
    assert client.get(f"{API}/biblios/{a.id}/duplicates").status_code == 401
    h = login(client, "reader1")
    assert client.post(f"{API}/cataloging/duplicates", headers=h, json={"title": "x"}).status_code == 403


def test_record_history_lists_record_and_item_changes(client, staff, lib, make_book):
    b, items = make_book("History Book")
    assert client.patch(f"{API}/biblios/{b.id}", headers=staff, json={"subtitle": "A story"}).status_code == 200
    assert client.patch(f"{API}/items/{items[0].id}", headers=staff, json={"shelf_location": "Display"}).status_code == 200
    r = client.post(f"{API}/batch/items/modify", headers=staff, json={
        "selection": {"barcodes": [items[0].barcode]}, "changes": {"status": "processing"}, "dry_run": False})
    assert r.status_code == 200
    hist = client.get(f"{API}/biblios/{b.id}/history", headers=staff).json()["results"]
    actions = [(h["action"], h["entity"]) for h in hist]
    assert ("update", "biblio") in actions and ("update", "item") in actions and ("batch_modify", "item") in actions
    item_entry = next(h for h in hist if h["action"] == "update" and h["entity"] == "item")
    assert item_entry["barcode"] == items[0].barcode and item_entry["actor"]
    batch = next(h for h in hist if h["action"] == "batch_modify")
    assert batch["barcodes"] == [items[0].barcode] and "item_ids" not in batch["details"]
    assert all("ip" not in h for h in hist)


def test_items_show_due_dates_and_holds_filter_by_record(client, staff, lib, make_book):
    b, items = make_book("Due Book", copies=2)
    other, _ = make_book("Other Book")
    r = client.post(f"{API}/circulation/checkout", headers=staff, json={"patron_card": "reader1", "barcode": items[0].barcode})
    assert r.status_code in (200, 201), r.text
    rec = client.get(f"{API}/biblios/{b.id}", headers=staff).json()
    due = {i["barcode"]: i["due_at"] for i in rec["items"]}
    assert due[items[0].barcode] and due[items[1].barcode] is None
    client.cookies.clear()
    assert "due_at" not in client.get(f"{API}/biblios/{b.id}").json()["items"][0]  # anonymous: no loan data
    for biblio in (b, other):
        assert client.post(f"{API}/holds", headers=staff, json={"biblio_id": biblio.id, "patron_card": "reader2",
                                                                "pickup_branch_id": lib["branches"]["MAIN"].id}).status_code == 201
    holds = client.get(f"{API}/holds?biblio_id={b.id}", headers=staff).json()["results"]
    assert [h["biblio"]["id"] for h in holds] == [b.id]


# ------------------------------------------------------------------ acquisitions lifecycle


def _setup_acq(client, h, allocated=100000):
    v = client.post(f"{API}/acquisitions/vendors", headers=h, json={"name": "Books Ltd"}).json()
    b = client.post(f"{API}/acquisitions/budgets", headers=h, json={"name": "Fiction", "fiscal_year": 2026, "allocated": allocated}).json()
    return v, b


def test_draft_order_lifecycle(client, staff, lib):
    v, b = _setup_acq(client, staff)
    o = client.post(f"{API}/acquisitions/orders", headers=staff, json={
        "vendor_id": v["id"], "budget_id": b["id"], "title": "Draft Book", "quantity": 2, "unit_price": 10000, "status": "draft"}).json()
    assert o["status"] == "draft" and o["vendor_id"] == v["id"] and o["budget_id"] == b["id"]
    # drafts cannot be received, but can be edited
    assert client.post(f"{API}/acquisitions/orders/{o['id']}/receive", headers=staff,
                       json={"branch_id": lib["branches"]["MAIN"].id, "item_type_id": lib["itypes"]["BOOK"].id}).status_code == 409
    r = client.patch(f"{API}/acquisitions/orders/{o['id']}", headers=staff, json={"quantity": 3, "notes": "Rush", "isbn": "978-0-14-043786-7"})
    assert r.status_code == 200 and r.json()["quantity"] == 3 and r.json()["total"] == 300.0 and r.json()["isbn"] == "9780140437867"
    # budget shows the draft as planned spend
    bud = client.get(f"{API}/acquisitions/budgets", headers=staff).json()["results"][0]
    assert bud["draft"] == 300.0 and bud["ordered"] == 0 and bud["committed"] == 300.0
    # editing beyond the budget is refused (the draft's own amount is not double counted)
    assert client.patch(f"{API}/acquisitions/orders/{o['id']}", headers=staff, json={"quantity": 10}).status_code == 200
    assert client.patch(f"{API}/acquisitions/orders/{o['id']}", headers=staff, json={"quantity": 11}).status_code == 409
    placed = client.post(f"{API}/acquisitions/orders/{o['id']}/place", headers=staff)
    assert placed.status_code == 200 and placed.json()["status"] == "ordered"
    assert client.post(f"{API}/acquisitions/orders/{o['id']}/place", headers=staff).status_code == 409
    # placed orders: only notes may change
    assert client.patch(f"{API}/acquisitions/orders/{o['id']}", headers=staff, json={"quantity": 1}).status_code == 409
    assert client.patch(f"{API}/acquisitions/orders/{o['id']}", headers=staff, json={"notes": "Chased"}).json()["notes"] == "Chased"
    bud = client.get(f"{API}/acquisitions/budgets", headers=staff).json()["results"][0]
    assert bud["ordered"] == 1000.0 and bud["draft"] == 0
    rec = client.post(f"{API}/acquisitions/orders/{o['id']}/receive", headers=staff,
                      json={"branch_id": lib["branches"]["MAIN"].id, "item_type_id": lib["itypes"]["BOOK"].id})
    assert rec.status_code == 200 and len(rec.json()["barcodes"]) == 10
    listing = client.get(f"{API}/acquisitions/orders", headers=staff).json()
    assert listing["counts"] == {"received": 1}
    assert client.get(f"{API}/acquisitions/budgets", headers=staff).json()["results"][0]["received"] == 1000.0


def test_default_order_status_is_ordered_and_suggestion_link(client, staff, db, lib):
    v, b = _setup_acq(client, staff)
    o = client.post(f"{API}/acquisitions/orders", headers=staff, json={
        "vendor_id": v["id"], "budget_id": b["id"], "title": "Placed", "quantity": 1, "unit_price": 500}).json()
    assert o["status"] == "ordered"
    # a draft created from a patron suggestion links back to it
    from librowise.services import settings as settings_svc
    settings_svc.set_value(db, "allow_purchase_suggestions", True)
    db.commit()
    ph = login(client, "reader1")
    s = client.post(f"{API}/opac/me/suggestions", headers=ph, json={"title": "Suggested Book"}).json()
    r = client.post(f"{API}/suggestions/{s['id']}/accept", headers=staff, json={
        "create_order": True, "vendor_id": v["id"], "budget_id": b["id"], "unit_price": 900})
    assert r.status_code == 200, r.text
    drafts = client.get(f"{API}/acquisitions/orders?status=draft", headers=staff).json()["results"]
    assert drafts[0]["suggestion_id"] == s["id"] and drafts[0]["title"] == "Suggested Book"
    assert db.get(PurchaseOrder, drafts[0]["id"]).status == OrderStatus.draft


def test_vendor_and_budget_editing(client, staff):
    v, b = _setup_acq(client, staff, allocated=20000)
    r = client.patch(f"{API}/acquisitions/vendors/{v['id']}", headers=staff, json={"email": "orders@books.example", "discount_pct": 12.5})
    assert r.status_code == 200 and r.json()["discount_pct"] == 12.5
    other = client.post(f"{API}/acquisitions/vendors", headers=staff, json={"name": "Other"}).json()
    assert client.patch(f"{API}/acquisitions/vendors/{other['id']}", headers=staff, json={"name": "Books Ltd"}).status_code == 409
    assert client.get(f"{API}/acquisitions/vendors", headers=staff).json()["results"][0]["orders"] == 0
    client.post(f"{API}/acquisitions/orders", headers=staff, json={
        "vendor_id": v["id"], "budget_id": b["id"], "title": "X", "quantity": 1, "unit_price": 15000})
    assert client.patch(f"{API}/acquisitions/budgets/{b['id']}", headers=staff, json={"allocated": 10000}).status_code == 409
    r = client.patch(f"{API}/acquisitions/budgets/{b['id']}", headers=staff, json={"allocated": 50000, "name": "Fiction 2026"})
    assert r.status_code == 200 and r.json()["remaining"] == 350.0 and r.json()["name"] == "Fiction 2026"
    assert client.patch(f"{API}/acquisitions/budgets/999", headers=staff, json={"name": "x"}).status_code == 404


# ------------------------------------------------------------------ pages


def test_collection_pages_render_with_shared_stylesheet(client, lib, make_book):
    b, _ = make_book("Page Book")
    login(client, "librarian")
    for url in (f"/staff/catalog/{b.id}", f"/staff/catalog/{b.id}/edit", "/staff/catalog/new", f"/staff/catalog/{b.id}/marc",
                "/staff/authorities", "/staff/copycat", "/staff/labels", "/staff/batch", "/staff/acquisitions",
                "/staff/serials", "/staff/courses"):
        r = client.get(url)
        assert r.status_code == 200, url
        assert "/static/css/pages/collection.css" in r.text, url
        assert 'class="page-header' in r.text or 'class="detail-head' in r.text, url


def test_collection_detail_pages_have_breadcrumbs(client, db, lib):
    from librowise import web

    for page, tab in (("staff-serial", "serials"), ("staff-serial-claims", "serials"), ("staff-course", "courses")):
        s = web.staff_shell(lib["librarian"], page)
        assert s["tab"]["key"] == tab and s["detail"], page
    login(client, "librarian")
    html = client.get("/staff/courses/1").text  # unknown course still renders the shell (the page shows a 404 state)
    assert 'id="crumb"' in html and 'data-page="staff-course"' in html


def test_collection_pages_translated(client, lib):
    login(client, "librarian")
    html = client.get("/staff/acquisitions?lang=hi").text
    assert '<h1 id="page-title">अधिग्रहण</h1>' in html  # page header rendered server-side in Hindi
    html = client.get("/staff/authorities?lang=ur").text
    assert 'dir="rtl"' in html
