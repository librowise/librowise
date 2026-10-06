from conftest import PASSWORD, login


def test_login_success_and_me(client, lib):
    h = login(client, "reader1")
    me = client.get("/api/v1/auth/me", headers=h).json()
    assert me["card_number"] == "reader1"
    assert me["is_staff"] is False
    assert "password_hash" not in me


def test_login_by_email(client, lib):
    r = client.post("/api/v1/auth/login", json={"username": "reader1@example.org", "password": PASSWORD})
    assert r.status_code == 200


def test_bad_password_is_generic_401(client, lib):
    r = client.post("/api/v1/auth/login", json={"username": "reader1", "password": "wrong"})
    assert r.status_code == 401
    r2 = client.post("/api/v1/auth/login", json={"username": "nobody", "password": "wrong"})
    assert r2.status_code == 401
    assert r.json()["detail"] == r2.json()["detail"]  # no user enumeration


def test_login_rate_limited(client, lib):
    codes = [client.post("/api/v1/auth/login", json={"username": "reader1", "password": "x"}).status_code for _ in range(12)]
    assert 429 in codes


def test_rbac_patron_cannot_use_staff_api(client, lib):
    h = login(client, "reader1")
    assert client.get("/api/v1/patrons", headers=h).status_code == 403
    assert client.post("/api/v1/circulation/checkin", json={"barcode": "x"}, headers=h).status_code == 403
    assert client.get("/api/v1/admin/settings", headers=h).status_code == 403


def test_librarian_cannot_use_admin_api(client, staff):
    assert client.get("/api/v1/admin/settings", headers=staff).status_code == 403
    assert client.get("/api/v1/patrons", headers=staff).status_code == 200


def test_unauthenticated_gets_401(client, lib):
    assert client.get("/api/v1/patrons").status_code == 401


def test_csrf_required_for_cookie_sessions(client, lib):
    client.post("/api/v1/auth/login", json={"username": "reader1", "password": PASSWORD})
    # Cookie-authenticated mutation without the CSRF header is rejected
    r = client.patch("/api/v1/auth/preferences", json={"theme": "dark"})
    assert r.status_code == 403 and r.json()["code"] == "csrf"
    token = client.cookies.get("sw_csrf")
    r = client.patch("/api/v1/auth/preferences", json={"theme": "dark"}, headers={"X-CSRF-Token": token})
    assert r.status_code == 200
    assert r.json()["preferences"]["theme"] == "dark"


def test_password_change_revokes_old_tokens(client, lib):
    h = login(client, "reader1")
    r = client.post("/api/v1/auth/password", headers=h, json={"current_password": PASSWORD, "new_password": "N3w#Password!!"})
    assert r.status_code == 200
    assert client.get("/api/v1/auth/me", headers=h).status_code == 401


def test_weak_password_rejected(client, lib):
    h = login(client, "reader1")
    r = client.post("/api/v1/auth/password", headers=h, json={"current_password": PASSWORD, "new_password": "aaaaaaaaaa"})
    assert r.status_code == 422


def test_tampered_token_rejected(client, lib):
    h = login(client, "reader1")
    bad = {"Authorization": h["Authorization"][:-3] + "abc"}
    assert client.get("/api/v1/auth/me", headers=bad).status_code == 401


def test_security_headers(client, lib):
    r = client.get("/")
    assert r.status_code == 200
    csp = r.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["x-content-type-options"] == "nosniff"


def test_librarian_cannot_create_admin(client, staff, lib):
    r = client.post("/api/v1/patrons", headers=staff, json={
        "first_name": "Evil", "last_name": "Admin", "category_id": lib["cats"]["ADULT"].id,
        "home_branch_id": lib["branches"]["MAIN"].id, "role": "admin"})
    assert r.status_code == 403


def test_sql_injection_attempt_in_search_is_harmless(client, lib, make_book):
    make_book("Robust Systems")
    for q in ["'; DROP TABLE biblios; --", '" OR 1=1 --', "title:* NEAR(", "robust\" AND \"x"]:
        r = client.get("/api/v1/search", params={"q": q})
        assert r.status_code == 200
    assert client.get("/api/v1/search", params={"q": "robust"}).json()["total"] == 1


def test_xss_payload_is_stored_as_text(client, staff, lib):
    payload = "<script>alert(1)</script>"
    r = client.post("/api/v1/biblios", headers=staff, json={"title": payload})
    assert r.status_code == 201
    page = client.get(f"/record/{r.json()['id']}").text
    assert payload not in page  # never rendered raw by the server


def test_csv_formula_injection_neutralised(client, admin, lib, make_book, db):
    from shelfwise.models import Patron

    p = db.get(Patron, lib["patron"].id)
    p.first_name = "=HYPERLINK(\"http://evil\")"
    db.commit()
    from shelfwise.services import circulation

    circulation.charge(db, p, 5000, lib["admin"], "test")
    db.commit()
    csv = client.get("/api/v1/reports/run/fines?fmt=csv", headers=admin).text
    assert "'=HYPERLINK" in csv
