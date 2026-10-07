"""OPAC self-registration, staff approval queue and login messaging."""

import pytest
from conftest import login

from librowise.models import Notification, Patron, PatronRegistration
from librowise.services import registration

GOOD_PW = "Lantern#Reader42"


@pytest.fixture(autouse=True)
def _reset_limiter():
    registration.registration_limiter.reset()
    yield
    registration.registration_limiter.reset()


def _form(lib, **kw):
    return {"first_name": "Meera", "last_name": "Nair", "email": "meera.nair@example.org", "phone": "+91 99999 11111",
            "address": "12 Park Street", "date_of_birth": "1990-05-04",
            "home_branch_id": lib["branches"]["EAST"].id, "password": GOOD_PW, **kw}


def _register(client, lib, **kw):
    client.cookies.clear()  # an anonymous visitor (staff fixtures use bearer tokens, not cookies)
    return client.post("/api/v1/opac/register", json=_form(lib, **kw))


def test_register_creates_pending_inactive_account(client, lib, db):
    r = _register(client, lib)
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "pending"
    p = db.query(Patron).filter_by(email="meera.nair@example.org").one()
    assert not p.is_active and p.registration_status == "pending" and p.role.value == "patron"
    assert p.category.code == "ADULT" and p.home_branch.code == "EAST" and p.expires_on is None
    assert p.password_hash and GOOD_PW not in p.password_hash
    reg = db.query(PatronRegistration).filter_by(patron_id=p.id).one()
    assert reg.status == "pending" and reg.ip


def test_pending_login_explains_awaiting_approval(client, lib):
    _register(client, lib)
    r = client.post("/api/v1/auth/login", json={"username": "meera.nair@example.org", "password": GOOD_PW})
    assert r.status_code == 403 and "awaiting approval" in r.json()["detail"]
    # Wrong password → the usual generic 401 (no information leak)
    r = client.post("/api/v1/auth/login", json={"username": "meera.nair@example.org", "password": "Nope#12345678"})
    assert r.status_code == 401 and "awaiting" not in r.json()["detail"]


@pytest.mark.parametrize("override,code", [
    ({"password": "short"}, 422),
    ({"password": "meeranair#2026XY"}, 422),  # contains the applicant's name
    ({"email": "not-an-email"}, 422),
    ({"home_branch_id": 9999}, 404),
    ({"date_of_birth": "2999-01-01"}, 422),
    ({"phone": "<script>"}, 422),
])
def test_register_validation(client, lib, override, code):
    assert _register(client, lib, **override).status_code == code


def test_duplicate_email_and_honeypot(client, lib, db):
    assert _register(client, lib, email="reader1@example.org").status_code == 409
    r = _register(client, lib, email="bot@example.org", website="http://spam.example")
    assert r.status_code == 201
    assert db.query(Patron).filter_by(email="bot@example.org").count() == 0


def test_register_rate_limited(client, lib):
    codes = [_register(client, lib, email=f"user{i}@example.org").status_code for i in range(8)]
    assert codes[:5] == [201] * 5 and 429 in codes


def test_register_disabled_by_policy(client, admin, lib):
    assert client.put("/api/v1/admin/settings/allow_self_registration", json={"value": False},
                      headers=admin).status_code == 200
    assert client.get("/api/v1/opac/register/config").json()["enabled"] is False
    assert _register(client, lib).status_code == 403


def test_staff_approve_flow(client, staff, lib, db):
    _register(client, lib)
    q = client.get("/api/v1/registrations", headers=staff).json()
    assert q["pending"] == 1 and q["results"][0]["email"] == "meera.nair@example.org"
    pid = q["results"][0]["patron_id"]
    r = client.post(f"/api/v1/registrations/{pid}/approve", headers=staff,
                    json={"category_id": lib["cats"]["STUDENT"].id, "note": "ID checked"})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    db.expire_all()
    p = db.get(Patron, pid)
    assert p.is_active and p.category.code == "STUDENT" and p.expires_on
    n = db.query(Notification).filter_by(patron_id=pid).one()
    assert n.code == "REGISTRATION_APPROVED" and p.card_number in n.body
    assert client.post(f"/api/v1/registrations/{pid}/approve", headers=staff, json={}).status_code == 409
    # The applicant can now sign in
    assert login(client, "meera.nair@example.org", GOOD_PW)
    assert client.get("/api/v1/registrations/count", headers=staff).json()["pending"] == 0


def test_staff_reject_flow(client, staff, lib, db):
    _register(client, lib)
    pid = client.get("/api/v1/registrations", headers=staff).json()["results"][0]["patron_id"]
    assert client.post(f"/api/v1/registrations/{pid}/reject", headers=staff, json={"reason": ""}).status_code == 422
    r = client.post(f"/api/v1/registrations/{pid}/reject", headers=staff, json={"reason": "Address outside area"})
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    n = db.query(Notification).filter_by(patron_id=pid).one()
    assert n.code == "REGISTRATION_REJECTED" and "Address outside area" in n.body
    r = client.post("/api/v1/auth/login", json={"username": "meera.nair@example.org", "password": GOOD_PW})
    assert r.status_code == 403 and "not approved" in r.json()["detail"]
    rejected = client.get("/api/v1/registrations", params={"status": "rejected"}, headers=staff).json()["results"]
    assert rejected[0]["decision_note"] == "Address outside area" and rejected[0]["reviewed_by"]


def test_registration_queue_permissions(client, lib):
    _register(client, lib)
    me = login(client, "reader1")
    assert client.get("/api/v1/registrations", headers=me).status_code == 403
    assert client.post("/api/v1/registrations/1/approve", headers=me, json={}).status_code == 403
    client.cookies.clear()
    assert client.get("/api/v1/registrations").status_code == 401


def test_duplicate_hint_for_existing_cardholders(client, staff, lib):
    _register(client, lib, first_name="Reader1", last_name="Test", email="again@example.org",
              password="Kettle#Morning77")
    row = client.get("/api/v1/registrations", headers=staff).json()["results"][0]
    assert [d["card_number"] for d in row["duplicates"]] == ["reader1"]
