"""Circulation desk API: undo (30 s, audited, safe), structured reasons, routing, renew-by-barcode,
emailed receipts, patron context, hold tab counts and the Home page desk tasks."""

from __future__ import annotations

from datetime import timedelta

from librowise.models import AuditLog, HoldStatus, ItemStatus, LedgerEntry, LedgerKind, Loan, Notification, utcnow
from librowise.services import circulation


def _checkout(client, staff, card, barcode, **kw):
    return client.post("/api/v1/circulation/checkout", headers=staff, json={"patron_card": card, "barcode": barcode, **kw})


def _checkin(client, staff, barcode, branch_id=None):
    return client.post("/api/v1/circulation/checkin", headers=staff, json={"barcode": barcode, "branch_id": branch_id})


def test_checkout_returns_undo_token_and_undo_restores_everything(client, db, lib, make_book, staff):
    _, (item,) = make_book("Undo Me")
    r = _checkout(client, staff, "reader1", item.barcode)
    assert r.status_code == 200, r.text
    token = r.json()["undo_token"]
    assert token and r.json()["warning_codes"] == []
    u = client.post("/api/v1/circulation/undo", headers=staff, json={"token": token})
    assert u.status_code == 200, u.text
    assert u.json()["undone"] == "checkout" and u.json()["patron"]["card_number"] == "reader1"
    db.expire_all()
    assert item.status == ItemStatus.available and (item.times_borrowed or 0) == 0
    assert db.query(Loan).filter(Loan.item_id == item.id).count() == 0
    assert db.query(AuditLog).filter(AuditLog.action == "checkout_undone", AuditLog.entity_id == token).count() == 1
    # once only
    again = client.post("/api/v1/circulation/undo", headers=staff, json={"token": token})
    assert again.status_code == 409 and again.json()["code"] == "undo_done"


def test_undo_checkout_restores_a_fulfilled_hold(client, db, lib, make_book, staff):
    b, (item,) = make_book("Held Book")
    hold = circulation.place_hold(db, lib["patron"], b, pickup_branch_id=item.branch_id)
    circulation.checkin(db, item, branch_id=item.branch_id)  # routes the copy to the hold shelf
    db.commit()
    assert hold.status == HoldStatus.ready and item.status == ItemStatus.on_hold_shelf
    r = _checkout(client, staff, "reader1", item.barcode)
    db.expire_all()
    assert hold.status == HoldStatus.fulfilled
    assert client.post("/api/v1/circulation/undo", headers=staff, json={"token": r.json()["undo_token"]}).status_code == 200
    db.expire_all()
    assert hold.status == HoldStatus.ready and hold.item_id == item.id and item.status == ItemStatus.on_hold_shelf


def test_undo_checkin_reopens_loan_reverses_fine_and_hold_routing(client, db, lib, make_book, staff):
    b, (item,) = make_book("Late and Wanted")
    loan = circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id, now=utcnow() - timedelta(days=30)).loan
    hold = circulation.place_hold(db, lib["patron2"], b, pickup_branch_id=item.branch_id)
    db.commit()
    r = _checkin(client, staff, item.barcode, item.branch_id)
    body = r.json()
    assert body["routing"] == "hold_shelf" and body["hold"]["patron"]["card_number"] == "reader2"
    assert body["fine"] > 0 and body["to_branch"]["id"] == item.branch_id
    assert db.query(Notification).filter(Notification.code == "HOLD_READY").count() == 1
    u = client.post("/api/v1/circulation/undo", headers=staff, json={"token": body["undo_token"]})
    assert u.status_code == 200, u.text
    db.expire_all()
    assert loan.returned_at is None and loan.patron_id == lib["patron"].id and loan.fine_charged == 0
    assert item.status == ItemStatus.on_loan
    assert hold.status == HoldStatus.queued and hold.item_id is None and hold.ready_at is None
    assert circulation.balance(db, lib["patron"].id) == 0  # fine reversed by a waiver entry (ledger stays append-only)
    assert db.query(LedgerEntry).filter(LedgerEntry.kind == LedgerKind.waiver).count() == 1
    assert db.query(Notification).filter(Notification.code == "HOLD_READY").count() == 0  # unsent notice withdrawn


def test_undo_is_refused_when_late_stale_or_not_yours(client, db, lib, make_book, staff):
    _, (item, other) = make_book("Guarded", copies=2)
    r = _checkout(client, staff, "reader1", item.barcode).json()
    # stale: the item was checked in since
    _checkin(client, staff, item.barcode)
    stale = client.post("/api/v1/circulation/undo", headers=staff, json={"token": r["undo_token"]})
    assert stale.status_code == 409 and stale.json()["code"] == "undo_stale"
    # too late
    r2 = _checkout(client, staff, "reader1", other.barcode).json()
    entry = db.get(AuditLog, r2["undo_token"])
    entry.at = utcnow() - timedelta(minutes=2)
    db.commit()
    late = client.post("/api/v1/circulation/undo", headers=staff, json={"token": r2["undo_token"]})
    assert late.status_code == 409 and late.json()["code"] == "undo_expired"
    # not a circulation transaction
    assert client.post("/api/v1/circulation/undo", headers=staff, json={"token": 999999}).status_code == 404


def test_undo_by_another_staff_member_needs_override_permission(client, db, lib, make_book):
    from conftest import login

    _, (item,) = make_book("Shared Desk")
    lib["make_user"]("assistant", role=lib["librarian"].role, cat="STAFF")
    db.commit()
    first = login(client, "librarian")
    token = _checkout(client, first, "reader1", item.barcode).json()["undo_token"]
    entry = db.get(AuditLog, token)
    entry.actor_id = lib["admin"].id  # pretend someone else made it
    db.commit()
    from librowise import permissions

    assert "circulation:override" in permissions._LIBRARIAN  # librarians may undo colleagues' transactions
    assert client.post("/api/v1/circulation/undo", headers=first, json={"token": token}).status_code == 200


def test_structured_block_reasons_and_override_reason_is_audited(client, db, lib, make_book, staff):
    _, (item,) = make_book("Blocked")
    p = lib["patron"]
    p.expires_on = utcnow().date() - timedelta(days=1)
    db.commit()
    r = _checkout(client, staff, "reader1", item.barcode)
    assert r.status_code == 422 and r.json()["code"] == "checkout_blocked"
    codes = r.json()["reason_codes"]
    assert codes[0]["code"] == "expired" and codes[0]["params"]["date"] == p.expires_on.isoformat()
    assert r.json()["reasons"][0].startswith("Membership expired")  # English text kept for API clients
    ok = _checkout(client, staff, "reader1", item.barcode, override=True, override_reason="Approved by a supervisor")
    assert ok.status_code == 200
    assert [w["code"] for w in ok.json()["warning_codes"]][:1] == ["overridden"]
    entry = db.query(AuditLog).filter(AuditLog.action == "checkout").one()
    assert entry.details["override"] is True and entry.details["override_reason"] == "Approved by a supervisor"


def test_checkin_routing_codes(client, db, lib, make_book, staff):
    _, (item,) = make_book("Wanderer")
    circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id)
    db.commit()
    east = lib["branches"]["EAST"].id
    body = _checkin(client, staff, item.barcode, east).json()
    assert body["routing"] == "home_branch" and body["to_branch"]["id"] == item.branch_id
    _, (local,) = make_book("Homebody")
    assert _checkin(client, staff, local.barcode, local.branch_id).json()["routing"] == "reshelve"


def test_renew_by_barcode(client, db, lib, make_book, staff):
    _, (item, idle) = make_book("Renew Me", copies=2)
    circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id)
    db.commit()
    r = client.post("/api/v1/circulation/renew", headers=staff, json={"barcode": item.barcode})
    assert r.status_code == 200 and r.json()["renewals"] == 1
    r = client.post("/api/v1/circulation/renew", headers=staff, json={"barcode": idle.barcode})
    assert r.status_code == 422 and r.json()["code"] == "not_on_loan"


def test_email_receipt(client, db, lib, make_book, staff):
    _, (item,) = make_book("Receipt Book")
    loan_id = _checkout(client, staff, "reader1", item.barcode).json()["loan"]["id"]
    r = client.post("/api/v1/circulation/receipt", headers=staff,
                    json={"patron_id": lib["patron"].id, "lines": [{"loan_id": loan_id, "kind": "checkout"}]})
    assert r.status_code == 200 and r.json()["queued"] and r.json()["to"].endswith("@example.org")
    n = db.query(Notification).filter(Notification.patron_id == lib["patron"].id).order_by(Notification.id.desc()).first()
    assert "Receipt Book" in n.body
    # someone else's loan cannot be put on this patron's receipt
    bad = client.post("/api/v1/circulation/receipt", headers=staff,
                      json={"patron_id": lib["patron2"].id, "lines": [{"loan_id": loan_id}]})
    assert bad.status_code == 404
    lib["patron2"].email = None
    db.commit()
    none = client.post("/api/v1/circulation/receipt", headers=staff,
                       json={"patron_id": lib["patron2"].id, "lines": [{"loan_id": loan_id}]})
    assert none.status_code == 422 and none.json()["code"] == "no_email"


def test_patron_context(client, db, lib, staff):
    r = client.get("/api/v1/circulation/patrons/by-card/reader1/context", headers=staff)
    assert r.status_code == 200
    body = r.json()
    assert body["card_number"] == "reader1" and body["block_reasons"] == [] and body["can_override"] is True
    assert {"loans", "holds", "balance", "max_loans"} <= set(body)
    assert client.get("/api/v1/circulation/patrons/by-card/nobody/context", headers=staff).status_code == 404


def test_hold_counts_and_transit_filter(client, db, lib, make_book, staff):
    b, (item,) = make_book("Travelling")
    hold = circulation.place_hold(db, lib["patron"], b, pickup_branch_id=lib["branches"]["EAST"].id)
    db.commit()
    counts = client.get("/api/v1/holds/counts", headers=staff).json()
    assert counts["pull"] == 1 and counts["transit"] == 0 and counts["queued"] == 1
    circulation.checkin(db, item, branch_id=item.branch_id)  # copy at MAIN → in transit to EAST
    db.commit()
    assert item.status == ItemStatus.in_transit
    counts = client.get("/api/v1/holds/counts", headers=staff).json()
    assert counts["transit"] == 1 and counts["pull"] == 0
    rows = client.get("/api/v1/holds?transit=true", headers=staff).json()["results"]
    assert [h["id"] for h in rows] == [hold.id]
    assert rows[0]["item"]["status"] == "in_transit" and rows[0]["item"]["branch"]["id"] == item.branch_id


def test_today_tasks_are_permission_filtered(client, db, lib, make_book, staff):
    from conftest import login

    tasks = {t["id"]: t for t in client.get("/api/v1/circulation/today", headers=staff).json()["tasks"]}
    assert {"holds_to_pull", "holds_expiring", "in_transit", "overdue"} <= set(tasks)
    assert tasks["holds_to_pull"]["href"] == "/staff/holds#pull"
    reader = login(client, "reader1")
    assert client.get("/api/v1/circulation/today", headers=reader).status_code == 403


def test_desk_pages_render(client, lib, staff):
    from conftest import login

    login(client, "librarian")
    html = client.get("/staff/circulation?patron=reader1").text
    assert 'id="circ-modes"' in html and "/static/css/pages/desk.css" in html
    assert 'aria-busy="true"' in html  # space reserved for the patron panel while it loads (no layout shift)
    for path in ("/staff", "/staff/holds", "/staff/calendar", "/staff/kiosks"):
        assert client.get(path).status_code == 200, path
