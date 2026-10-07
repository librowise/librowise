"""Patron purchase suggestions: OPAC form, staff review, draft orders and notices."""

from conftest import login

from librowise.models import Budget, Notification, OrderStatus, PurchaseOrder, Vendor


def _suggest(client, h, **kw):
    return client.post("/api/v1/opac/me/suggestions", headers=h, json={
        "title": "Project Hail Mary", "author": "Weir, Andy", "isbn": "978-0-593-13520-4", "format": "book",
        "reason": "Loved The Martian", **kw})


def _acq(db):
    v = Vendor(name="Test Books")
    b = Budget(name="Fiction", fiscal_year=2026, allocated=100000)
    db.add_all([v, b])
    db.commit()
    return v, b


def test_patron_suggests_lists_and_withdraws(client, lib):
    me = login(client, "reader1")
    r = _suggest(client, me)
    assert r.status_code == 201 and r.json()["status"] == "pending" and r.json()["isbn"] == "9780593135204"
    assert _suggest(client, me).status_code == 409  # duplicate while pending
    mine = client.get("/api/v1/opac/me/suggestions", headers=me).json()["results"]
    assert len(mine) == 1 and mine[0]["status_label"] == "Under review"
    other = login(client, "reader2")
    assert client.get("/api/v1/opac/me/suggestions", headers=other).json()["results"] == []
    assert client.delete(f"/api/v1/opac/me/suggestions/{mine[0]['id']}", headers=other).status_code == 404
    r = client.delete(f"/api/v1/opac/me/suggestions/{mine[0]['id']}", headers=me)
    assert r.status_code == 200 and r.json()["status"] == "withdrawn"
    assert _suggest(client, me).status_code == 201  # may suggest again after withdrawing


def test_suggestion_validation(client, lib):
    me = login(client, "reader1")
    assert _suggest(client, me, title="").status_code == 422
    assert _suggest(client, me, isbn="<x>").status_code == 422
    assert _suggest(client, me, format="vinyl").status_code == 422


def test_staff_accept_without_order_notifies_patron(client, staff, lib, db):
    me = login(client, "reader1")
    sid = _suggest(client, me).json()["id"]
    q = client.get("/api/v1/suggestions", params={"status": "pending"}, headers=staff).json()
    assert q["counts"]["pending"] == 1 and q["results"][0]["patron"]["card_number"] == "reader1"
    r = client.post(f"/api/v1/suggestions/{sid}/accept", headers=staff, json={"note": "We'll buy it"})
    assert r.status_code == 200 and r.json()["status"] == "accepted" and r.json()["reviewed_by"]
    n = db.query(Notification).filter_by(code="PURCHASE_SUGGESTION_UPDATE").one()
    assert n.patron_id == lib["patron"].id and "Accepted" in n.subject and "We'll buy it" in n.body
    assert client.post(f"/api/v1/suggestions/{sid}/accept", headers=staff, json={}).status_code == 409
    mine = client.get("/api/v1/opac/me/suggestions", headers=me).json()["results"]
    assert mine[0]["status"] == "accepted" and mine[0]["decision_note"] == "We'll buy it"


def test_staff_accept_with_draft_order(client, staff, lib, db):
    v, b = _acq(db)
    me = login(client, "reader1")
    sid = _suggest(client, me).json()["id"]
    r = client.post(f"/api/v1/suggestions/{sid}/accept", headers=staff, json={"create_order": True})
    assert r.status_code == 422  # vendor/budget/price required
    too_much = {"create_order": True, "vendor_id": v.id, "budget_id": b.id, "quantity": 3, "unit_price": 50000}
    assert client.post(f"/api/v1/suggestions/{sid}/accept", headers=staff, json=too_much).status_code == 409
    r = client.post(f"/api/v1/suggestions/{sid}/accept", headers=staff,
                    json={**too_much, "quantity": 2, "unit_price": 45000})
    assert r.status_code == 200 and r.json()["status"] == "ordered" and r.json()["order_id"]
    po = db.get(PurchaseOrder, r.json()["order_id"])
    assert po.status == OrderStatus.draft and po.title == "Project Hail Mary" and po.isbn == "9780593135204"
    assert po.quantity == 2 and po.unit_price == 45000 and "suggestion" in po.notes


def test_staff_reject_requires_reason(client, staff, lib, db):
    me = login(client, "reader1")
    sid = _suggest(client, me).json()["id"]
    assert client.post(f"/api/v1/suggestions/{sid}/reject", headers=staff, json={"reason": " "}).status_code == 422
    r = client.post(f"/api/v1/suggestions/{sid}/reject", headers=staff, json={"reason": "Out of print"})
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    n = db.query(Notification).filter_by(code="PURCHASE_SUGGESTION_UPDATE").one()
    assert "Out of print" in n.body
    assert client.delete(f"/api/v1/opac/me/suggestions/{sid}", headers=me).status_code == 409


def test_suggestions_permissions_and_policy(client, admin, lib):
    me = login(client, "reader1")
    assert client.get("/api/v1/suggestions", headers=me).status_code == 403
    sid = _suggest(client, me).json()["id"]
    assert client.post(f"/api/v1/suggestions/{sid}/accept", headers=me, json={}).status_code == 403
    client.cookies.clear()
    assert client.get("/api/v1/opac/me/suggestions").status_code == 401
    client.put("/api/v1/admin/settings/allow_purchase_suggestions", json={"value": False}, headers=admin)
    assert _suggest(client, me, title="Another").status_code == 403


def test_holdings_hint(client, staff, lib, make_book):
    make_book("Project Hail Mary", isbn="9780593135204")
    me = login(client, "reader1")
    _suggest(client, me)
    row = client.get("/api/v1/suggestions", headers=staff).json()["results"][0]
    assert row["holdings"]  # the library already has a record for it
