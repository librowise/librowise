"""Self-checkout kiosk: provisioning, authentication isolation, no overrides, holds respected, sessions."""

from __future__ import annotations

from datetime import timedelta

import pytest
from conftest import PASSWORD, login

from librowise.api import kiosk as kiosk_api
from librowise.models import AuditLog, Hold, HoldStatus, ItemStatus, KioskSession, Loan, utcnow
from librowise.services import circulation


@pytest.fixture(autouse=True)
def _reset_limiters():
    kiosk_api.device_limiter.reset()
    kiosk_api.signin_limiter.reset()
    yield


@pytest.fixture()
def device(client, staff, lib):
    r = client.post("/api/v1/kiosk/devices", headers=staff, json={"name": "Lobby", "branch_id": lib["branches"]["EAST"].id})
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["token"].startswith("kiosk_") and d["token_hint"] == d["token"][:10]
    client.cookies.clear()  # the kiosk is a different browser
    return {"id": d["id"], "h": {"X-Kiosk-Token": d["token"]}, "token": d["token"]}


def sign_in(client, device, card="reader1", password=PASSWORD):
    return client.post("/api/v1/kiosk/session", headers=device["h"], json={"card": card, "password": password})


@pytest.fixture()
def session(client, device):
    r = sign_in(client, device)
    assert r.status_code == 201, r.text
    return {**device["h"], "X-Kiosk-Session": r.json()["session_token"]}


def test_device_management_requires_permission_and_hides_tokens(client, staff, lib):
    reader = login(client, "reader1")
    assert client.post("/api/v1/kiosk/devices", headers=reader, json={"name": "x", "branch_id": 1}).status_code == 403
    assert client.post("/api/v1/kiosk/devices", headers=staff, json={"name": "x", "branch_id": 999}).status_code == 422
    r = client.post("/api/v1/kiosk/devices", headers=staff, json={"name": "Desk", "branch_id": lib["branches"]["MAIN"].id})
    listing = client.get("/api/v1/kiosk/devices", headers=staff).json()["results"]
    assert len(listing) == 1 and "token" not in listing[0] and "token_hash" not in listing[0]
    assert r.json()["token"] not in str(listing)


def test_hello_rejects_missing_wrong_and_staff_credentials(client, lib, device):
    assert client.get("/api/v1/kiosk/hello").status_code == 401
    assert client.get("/api/v1/kiosk/hello", headers={"X-Kiosk-Token": "kiosk_wrong"}).status_code == 401
    staff_bearer = login(client, "librarian")  # also sets staff cookies on the client
    assert client.get("/api/v1/kiosk/hello", headers=staff_bearer).status_code == 401
    assert client.get("/api/v1/kiosk/hello").status_code == 401  # staff cookie alone
    ok = client.get("/api/v1/kiosk/hello", headers=device["h"]).json()
    assert ok["branch"]["id"] == lib["branches"]["EAST"].id and ok["device"]["name"] == "Lobby"


def test_session_endpoints_reject_staff_cookie_and_foreign_sessions(client, staff, lib, device, session):
    login(client, "librarian")
    # staff cookie + device token but no patron session → still unauthorised
    assert client.get("/api/v1/kiosk/me", headers=device["h"]).status_code == 401
    assert client.post("/api/v1/kiosk/checkout", headers={**device["h"], "X-CSRF-Token": client.cookies.get("sw_csrf")},
                       json={"barcode": "x"}).status_code == 401
    client.cookies.clear()
    # a session token is bound to the device that created it
    other = client.post("/api/v1/kiosk/devices", headers=staff, json={"name": "Other", "branch_id": lib["branches"]["MAIN"].id}).json()
    client.cookies.clear()
    assert client.get("/api/v1/kiosk/me", headers={"X-Kiosk-Token": other["token"], "X-Kiosk-Session": session["X-Kiosk-Session"]}).status_code == 401
    assert client.get("/api/v1/kiosk/me", headers=session).status_code == 200


def test_sign_in_checks_password_and_is_rate_limited(client, device, db):
    assert sign_in(client, device, password="wrong").status_code == 401
    assert sign_in(client, device, card="nobody").status_code == 401
    assert db.query(AuditLog).filter(AuditLog.action == "kiosk_login_failed").count() == 2
    codes = [sign_in(client, device, password="wrong").status_code for _ in range(8)]
    assert 429 in codes


def test_checkout_renew_receipt_and_end(client, db, lib, make_book, session):
    b, (item,) = make_book("Kiosk Book")
    r = client.post("/api/v1/kiosk/checkout", headers=session, json={"barcode": item.barcode})
    assert r.status_code == 200, r.text
    loan = db.get(Loan, r.json()["loan"]["id"])
    assert loan.branch_id == lib["branches"]["EAST"].id and loan.patron_id == lib["patron"].id
    assert db.query(AuditLog).filter(AuditLog.action == "kiosk_checkout").count() == 1
    me = client.get("/api/v1/kiosk/me", headers=session).json()
    assert me["patron"]["first_name"] == "Reader1" and me["patron"]["card"].endswith("der1") and "•" in me["patron"]["card"]
    assert [x["title"] for x in me["loans"]] == ["Kiosk Book"] and me["loans"][0]["can_renew"]
    r = client.post("/api/v1/kiosk/renew", headers=session, json={"loan_id": loan.id})
    assert r.status_code == 200 and r.json()["loan"]["renewals"] == 1
    receipt = client.get("/api/v1/kiosk/receipt", headers=session).json()
    assert [x["kind"] for x in receipt["lines"]] == ["checkout", "renew"]
    end = client.post("/api/v1/kiosk/session/end", headers=session).json()
    assert len(end["lines"]) == 2 and end["branch"] == lib["branches"]["EAST"].name
    assert client.get("/api/v1/kiosk/me", headers=session).status_code == 401


def test_no_override_is_possible(client, db, lib, make_book, session):
    _, (item,) = make_book("Blocked Book")
    # extra fields are rejected outright
    assert client.post("/api/v1/kiosk/checkout", headers=session, json={"barcode": item.barcode, "override": True}).status_code == 422
    # outstanding charges above the category threshold block self-checkout
    circulation.charge(db, lib["patron"], 60000, lib["admin"], "Lost book")
    db.commit()
    r = client.post("/api/v1/kiosk/checkout", headers=session, json={"barcode": item.barcode})
    assert r.status_code == 422 and r.json()["code"] == "checkout_blocked"
    assert db.get(type(item), item.id).status == ItemStatus.available


def test_holds_for_other_patrons_are_respected(client, db, lib, make_book, session):
    main = lib["branches"]["MAIN"].id
    # 1) a copy on the hold shelf for someone else
    b1, (shelf_item,) = make_book("On The Shelf")
    db.add(Hold(biblio_id=b1.id, patron_id=lib["patron2"].id, pickup_branch_id=main, status=HoldStatus.ready, item_id=shelf_item.id))
    shelf_item.status = ItemStatus.on_hold_shelf
    # 2) an available copy of a title whose queue is headed by someone else
    b2, (queued_item,) = make_book("Wanted")
    db.add(Hold(biblio_id=b2.id, patron_id=lib["patron2"].id, pickup_branch_id=main))
    db.commit()
    for item in (shelf_item, queued_item):
        r = client.post("/api/v1/kiosk/checkout", headers=session, json={"barcode": item.barcode})
        assert r.status_code == 422 and r.json()["code"] == "reserved", r.text
    # 3) the patron's own hold at the head of the queue may be collected
    b3, (mine,) = make_book("Mine")
    db.add(Hold(biblio_id=b3.id, patron_id=lib["patron"].id, pickup_branch_id=main, created_at=utcnow() - timedelta(days=1)))
    db.add(Hold(biblio_id=b3.id, patron_id=lib["patron2"].id, pickup_branch_id=main))
    db.commit()
    r = client.post("/api/v1/kiosk/checkout", headers=session, json={"barcode": mine.barcode})
    assert r.status_code == 200, r.text
    assert db.query(Hold).filter(Hold.biblio_id == b3.id, Hold.patron_id == lib["patron"].id).one().status == HoldStatus.fulfilled
    # renewing is refused while another reader waits
    loan_id = r.json()["loan"]["id"]
    r = client.post("/api/v1/kiosk/renew", headers=session, json={"loan_id": loan_id})
    assert r.status_code == 422 and r.json()["code"] == "renewal_blocked"


def test_cannot_renew_someone_elses_loan(client, db, lib, make_book, session):
    _, (item,) = make_book("Theirs")
    loan = circulation.checkout(db, lib["patron2"], item, branch_id=lib["branches"]["MAIN"].id).loan
    db.commit()
    assert client.post("/api/v1/kiosk/renew", headers=session, json={"loan_id": loan.id}).status_code == 404


def test_idle_and_absolute_expiry(client, db, session):
    s = db.query(KioskSession).one()
    s.last_active_at = utcnow() - kiosk_api.SESSION_IDLE - timedelta(seconds=5)
    db.commit()
    assert client.get("/api/v1/kiosk/me", headers=session).status_code == 401
    s.last_active_at = utcnow()
    s.created_at = utcnow() - kiosk_api.SESSION_MAX - timedelta(seconds=5)
    db.commit()
    assert client.get("/api/v1/kiosk/me", headers=session).status_code == 401


def test_deactivate_and_rotate_revoke_access(client, staff, device, session):
    client.cookies.clear()
    r = client.patch(f"/api/v1/kiosk/devices/{device['id']}", headers=staff, json={"active": False})
    assert r.status_code == 200 and r.json()["active"] is False
    assert client.get("/api/v1/kiosk/hello", headers=device["h"]).status_code == 401
    client.patch(f"/api/v1/kiosk/devices/{device['id']}", headers=staff, json={"active": True})
    assert client.get("/api/v1/kiosk/me", headers=session).status_code == 401  # deactivation ended the session
    new = client.post(f"/api/v1/kiosk/devices/{device['id']}/rotate", headers=staff).json()
    assert client.get("/api/v1/kiosk/hello", headers=device["h"]).status_code == 401
    assert client.get("/api/v1/kiosk/hello", headers={"X-Kiosk-Token": new["token"]}).status_code == 200
    assert client.delete(f"/api/v1/kiosk/devices/{device['id']}", headers=staff).status_code == 200
    assert client.get("/api/v1/kiosk/hello", headers={"X-Kiosk-Token": new["token"]}).status_code == 401


def test_kiosk_page_renders_without_user(client, lib):
    login(client, "librarian")
    r = client.get("/kiosk")
    assert r.status_code == 200 and 'data-page="kiosk"' in r.text
    assert '"user": null' in r.text  # never rendered as the signed-in staff member
    assert r.headers["cache-control"] == "no-store"
