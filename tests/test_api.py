"""End-to-end API and page tests."""

from conftest import login


def test_health(client):
    assert client.get("/healthz").json()["status"] == "ok"
    assert client.get("/readyz").json()["status"] == "ready"
    assert client.get("/api/openapi.json").json()["openapi"].startswith("3.")


def test_catalogue_crud_and_items(client, staff, lib):
    r = client.post("/api/v1/biblios", headers=staff, json={
        "title": "  Clean Architecture ", "authors": ["Martin, Robert C.", "martin, robert c."],
        "isbn": "0-306-40615-2", "subjects": ["Software engineering"]})
    assert r.status_code == 201
    b = r.json()
    assert b["title"] == "Clean Architecture" and b["isbn"] == "9780306406157"
    assert b["authors"] == ["Martin, Robert C."]  # case-insensitive de-duplication
    r = client.post(f"/api/v1/biblios/{b['id']}/items", headers=staff, json={
        "branch_id": lib["branches"]["MAIN"].id, "item_type_id": lib["itypes"]["BOOK"].id, "price": 59900})
    assert r.status_code == 201 and r.json()["barcode"].startswith("SW")
    dup = client.post(f"/api/v1/biblios/{b['id']}/items", headers=staff, json={
        "barcode": r.json()["barcode"], "branch_id": lib["branches"]["MAIN"].id, "item_type_id": lib["itypes"]["BOOK"].id})
    assert dup.status_code == 409
    detail = client.get(f"/api/v1/biblios/{b['id']}").json()
    assert detail["availability"] == {"total": 1, "available": 1}
    r = client.patch(f"/api/v1/biblios/{b['id']}", headers=staff, json={"pub_year": 2017})
    assert r.json()["pub_year"] == 2017
    assert client.get("/api/v1/search?q=clean").json()["total"] == 1
    assert client.delete(f"/api/v1/biblios/{b['id']}", headers=staff).status_code == 204
    assert client.get(f"/api/v1/biblios/{b['id']}").status_code == 404


def test_validation_errors_are_readable(client, staff):
    r = client.post("/api/v1/biblios", headers=staff, json={"title": "", "unknown": 1})
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error" and r.json()["errors"]


def test_patron_registration_and_erasure(client, staff, lib):
    r = client.post("/api/v1/patrons", headers=staff, json={
        "first_name": "Ravi", "last_name": "Kumar", "email": "Ravi@Example.org", "category_id": lib["cats"]["ADULT"].id,
        "home_branch_id": lib["branches"]["MAIN"].id, "password": "Str0ng#Passw"})
    assert r.status_code == 201
    p = r.json()
    assert len(p["card_number"]) == 10 and p["email"] == "ravi@example.org" and p["expires_on"]
    assert client.get("/api/v1/patrons?q=kumar", headers=staff).json()["total"] == 1
    assert client.post("/api/v1/auth/login", json={"username": p["card_number"], "password": "Str0ng#Passw"}).status_code == 200
    assert client.delete(f"/api/v1/patrons/{p['id']}", headers=staff).status_code == 204
    assert client.get("/api/v1/patrons?q=kumar", headers=staff).json()["total"] == 0
    assert client.post("/api/v1/auth/login", json={"username": p["card_number"], "password": "Str0ng#Passw"}).status_code == 401


def test_payments(client, staff, lib, db):
    from shelfwise.services import circulation

    circulation.charge(db, lib["patron"], 2500, lib["admin"], "Printing")
    db.commit()
    pid = lib["patron"].id
    r = client.post(f"/api/v1/patrons/{pid}/pay", headers=staff, json={"amount": 1000})
    assert r.json()["balance"] == 15.0
    r = client.post(f"/api/v1/patrons/{pid}/waive", headers=staff, json={"amount": 1500, "note": "goodwill"})
    assert r.json()["balance"] == 0
    assert len(client.get(f"/api/v1/patrons/{pid}/ledger", headers=staff).json()["entries"]) == 3


def test_acquisitions_flow(client, admin, lib):
    v = client.post("/api/v1/acquisitions/vendors", headers=admin, json={"name": "Books Ltd"}).json()
    b = client.post("/api/v1/acquisitions/budgets", headers=admin, json={"name": "Fiction", "fiscal_year": 2026, "allocated": 100000}).json()
    too_big = client.post("/api/v1/acquisitions/orders", headers=admin, json={
        "vendor_id": v["id"], "budget_id": b["id"], "title": "Expensive", "quantity": 2, "unit_price": 60000})
    assert too_big.status_code == 409  # over budget
    o = client.post("/api/v1/acquisitions/orders", headers=admin, json={
        "vendor_id": v["id"], "budget_id": b["id"], "title": "Project Hail Mary", "quantity": 2, "unit_price": 40000}).json()
    r = client.post(f"/api/v1/acquisitions/orders/{o['id']}/receive", headers=admin, json={
        "branch_id": lib["branches"]["MAIN"].id, "item_type_id": lib["itypes"]["BOOK"].id})
    assert r.status_code == 200 and len(r.json()["barcodes"]) == 2
    assert client.get("/api/v1/search?q=hail").json()["results"][0]["availability"]["total"] == 2
    budget = client.get("/api/v1/acquisitions/budgets", headers=admin).json()["results"][0]
    assert budget["committed"] == 800.0 and budget["remaining"] == 200.0


def test_admin_settings_and_rules(client, admin, lib):
    r = client.put("/api/v1/admin/settings/library_name", headers=admin, json={"value": "Town Library"})
    assert r.json()["value"] == "Town Library"
    assert "Town Library" in client.get("/").text
    assert client.put("/api/v1/admin/settings/nope", headers=admin, json={"value": 1}).status_code == 404
    ex = client.get("/api/v1/admin/rules/explain", headers=admin, params={
        "branch_id": lib["branches"]["MAIN"].id, "category_id": lib["cats"]["FACULTY"].id, "item_type_id": lib["itypes"]["BOOK"].id}).json()
    assert ex["effective"]["loan_days"] == 60
    r = client.post("/api/v1/admin/branches", headers=admin, json={"code": "MAIN", "name": "Dup"})
    assert r.status_code == 409
    audit = client.get("/api/v1/admin/audit", headers=admin).json()
    assert any(a["action"] == "setting" for a in audit["results"])


def test_ai_endpoints(client, staff, lib, make_book):
    make_book("Cosmos", subjects=["Astronomy"])
    assert client.get("/api/v1/ai/status").json()["engine"] == "local"
    r = client.post("/api/v1/ai/ask", headers=staff, json={"question": "how many books are overdue?"})
    assert r.status_code == 200 and r.json()["engine"] == "local"
    r = client.post("/api/v1/ai/catalog-assist", headers=staff, json={"title": "Stars and planets"})
    assert r.status_code == 200
    assert client.get("/api/v1/ai/parse-query", params={"q": "space books for kids"}).json()["audience"] == "children"
    h = login(client, "reader1")
    assert client.post("/api/v1/ai/ask", headers=h, json={"question": "stats"}).status_code == 403


def test_reports(client, admin, lib):
    reports = client.get("/api/v1/reports", headers=admin).json()["results"]
    for rep in reports:
        r = client.get(f"/api/v1/reports/run/{rep['key']}", headers=admin)
        assert r.status_code == 200, rep
        assert client.get(f"/api/v1/reports/run/{rep['key']}?fmt=csv", headers=admin).headers["content-type"].startswith("text/csv")
    assert client.get("/api/v1/reports/run/drop_tables", headers=admin).status_code == 404
    d = client.get("/api/v1/reports/dashboard", headers=admin).json()
    assert "stats" in d and "trend" in d


def test_all_pages_render(client, lib, make_book):
    b, _ = make_book("Page Test")
    for path in ["/", "/search?q=page", f"/record/{b.id}", "/login"]:
        assert client.get(path).status_code == 200, path
    assert client.get("/account", follow_redirects=False).status_code == 303
    login(client, "admin")  # sets cookies for page views
    pages = ["/staff", "/staff/circulation", "/staff/catalog", "/staff/catalog/new", f"/staff/catalog/{b.id}",
             f"/staff/catalog/{b.id}/edit", "/staff/patrons", f"/staff/patrons/{lib['patron'].id}", "/staff/holds",
             "/staff/acquisitions", "/staff/reports", "/staff/insights", "/staff/admin", "/account"]
    for path in pages:
        r = client.get(path)
        assert r.status_code == 200, path
        assert 'data-page="' in r.text
    client.post("/api/v1/auth/logout")
    login(client, "reader1")
    assert client.get("/staff", follow_redirects=False).headers["location"] == "/account"


def test_static_page_modules_exist(client):
    import re

    from shelfwise.web import STAFF_NAV

    expected = {f"staff-{k}" for k, *_ in STAFF_NAV} | {"opac-home", "opac-search", "opac-record", "opac-account", "login",
                                                         "staff-record", "staff-record-edit", "staff-patron"}
    for page in expected:
        r = client.get(f"/static/js/pages/{page}.js")
        assert r.status_code == 200, page
        assert re.search(r"export default (async )?function", r.text), page
