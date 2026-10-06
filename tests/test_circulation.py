from datetime import timedelta

import pytest

from shelfwise.errors import Conflict, PolicyBlocked
from shelfwise.models import HoldStatus, ItemStatus, LedgerKind, Patron, utcnow
from shelfwise.services import circulation


def test_checkout_and_checkin_on_time(db, lib, make_book):
    _, (item,) = make_book()
    p = lib["patron"]
    res = circulation.checkout(db, p, item, branch_id=item.branch_id)
    assert item.status == ItemStatus.on_loan
    assert (res.loan.due_at.date() - utcnow().date()).days == 14  # default rule
    out = circulation.checkin(db, item, branch_id=item.branch_id)
    assert out.fine == 0 and item.status == ItemStatus.available
    assert out.loan.returned_at is not None


def test_rule_specificity(db, lib):
    b, c, t = lib["branches"], lib["cats"], lib["itypes"]
    assert circulation.resolve_rule(db, b["MAIN"].id, c["ADULT"].id, t["BOOK"].id).loan_days == 14
    assert circulation.resolve_rule(db, b["MAIN"].id, c["ADULT"].id, t["DVD"].id).loan_days == 7
    assert circulation.resolve_rule(db, b["MAIN"].id, c["STUDENT"].id, t["BOOK"].id).loan_days == 21
    # branch + category beats category alone
    assert circulation.resolve_rule(db, b["UNIV"].id, c["STUDENT"].id, t["BOOK"].id).loan_days == 28
    # item type (weight 4) beats branch + category (3)
    assert circulation.resolve_rule(db, b["UNIV"].id, c["STUDENT"].id, t["DVD"].id).loan_days == 7


def test_double_checkout_conflict(db, lib, make_book):
    _, (item,) = make_book()
    circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id)
    with pytest.raises(Conflict):
        circulation.checkout(db, lib["patron2"], item, branch_id=item.branch_id)
    with pytest.raises(Conflict) as ex:
        circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id)
    assert ex.value.code == "already_on_loan"


def test_overdue_fine_on_checkin_respects_cap(db, lib, make_book):
    _, (item,) = make_book()
    p = lib["patron"]
    past = utcnow() - timedelta(days=100)
    circulation.checkout(db, p, item, branch_id=item.branch_id, now=past)
    res = circulation.checkin(db, item, branch_id=item.branch_id)
    assert res.fine == 10000  # 86 days * 200 capped at 10000
    assert circulation.balance(db, p.id) == 10000
    kinds = [e.kind for e in db.query(circulation.LedgerEntry).filter_by(patron_id=p.id)]
    assert kinds == [LedgerKind.overdue]


def test_fines_block_borrowing_unless_override(db, lib, make_book):
    _, (a, b) = make_book(copies=2)
    p = lib["patron"]
    circulation.charge(db, p, 60000, lib["admin"], "damage")
    with pytest.raises(PolicyBlocked) as ex:
        circulation.checkout(db, p, a, branch_id=a.branch_id)
    assert "Outstanding charges" in ex.value.details["reasons"][0]
    res = circulation.checkout(db, p, a, branch_id=a.branch_id, override=True)
    assert any("Overridden" in w for w in res.warnings)
    circulation.pay(db, p, 60000, lib["librarian"])
    circulation.checkout(db, p, b, branch_id=b.branch_id)


def test_loan_limit(db, lib, make_book):
    child = lib["make_user"]("kid", cat="CHILD")
    db.commit()
    _, items = make_book(copies=6)
    for it in items[:5]:
        circulation.checkout(db, child, it, branch_id=it.branch_id)
    with pytest.raises(PolicyBlocked):
        circulation.checkout(db, child, items[5], branch_id=items[5].branch_id)


def test_expired_membership_blocks(db, lib, make_book):
    _, (item,) = make_book()
    p = db.get(Patron, lib["patron"].id)
    p.expires_on = utcnow().date() - timedelta(days=1)
    with pytest.raises(PolicyBlocked):
        circulation.checkout(db, p, item, branch_id=item.branch_id)


def test_renewal_limits_and_holds_block(db, lib, make_book):
    biblio, (item,) = make_book()
    loan = circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id).loan
    circulation.renew(db, loan)
    circulation.renew(db, loan)
    with pytest.raises(PolicyBlocked):
        circulation.renew(db, loan)  # default max 2
    loan.renewals = 0
    circulation.place_hold(db, lib["patron2"], biblio, pickup_branch_id=item.branch_id)
    with pytest.raises(PolicyBlocked) as ex:
        circulation.renew(db, loan)
    assert "waiting" in ex.value.message


def test_hold_queue_routing_on_checkin(db, lib, make_book):
    biblio, (item,) = make_book()
    p1, p2 = lib["patron"], lib["patron2"]
    circulation.checkout(db, p1, item, branch_id=item.branch_id)
    h = circulation.place_hold(db, p2, biblio, pickup_branch_id=item.branch_id)
    assert circulation.hold_queue_position(db, h) == 1
    res = circulation.checkin(db, item, branch_id=item.branch_id)
    assert res.hold.id == h.id and h.status == HoldStatus.ready
    assert item.status == ItemStatus.on_hold_shelf
    # Item is reserved for p2 only
    p3 = lib["make_user"]("reader3")
    with pytest.raises(PolicyBlocked):
        circulation.checkout(db, p3, item, branch_id=item.branch_id)
    circulation.checkout(db, p2, item, branch_id=item.branch_id)
    assert h.status == HoldStatus.fulfilled
    assert db.query(circulation.Notification).filter_by(patron_id=p2.id).count() == 1


def test_hold_for_other_branch_goes_in_transit(db, lib, make_book):
    biblio, (item,) = make_book()
    east = lib["branches"]["EAST"].id
    h = circulation.place_hold(db, lib["patron2"], biblio, pickup_branch_id=east)
    res = circulation.checkin(db, item, branch_id=item.branch_id)
    assert item.status == ItemStatus.in_transit and res.hold.id == h.id
    circulation.receive_transfer(db, item, branch_id=east)
    assert item.status == ItemStatus.on_hold_shelf and h.status == HoldStatus.ready


def test_cancel_ready_hold_passes_item_to_next(db, lib, make_book):
    biblio, (item,) = make_book()
    h1 = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=item.branch_id)
    h2 = circulation.place_hold(db, lib["patron2"], biblio, pickup_branch_id=item.branch_id)
    circulation.checkin(db, item, branch_id=item.branch_id)
    assert h1.status == HoldStatus.ready
    circulation.cancel_hold(db, h1)
    assert h2.status == HoldStatus.ready and h2.item_id == item.id


def test_duplicate_hold_rejected(db, lib, make_book):
    biblio, _ = make_book()
    circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=lib["branches"]["MAIN"].id)
    with pytest.raises(Conflict):
        circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=lib["branches"]["MAIN"].id)


def test_reference_items_not_holdable(db, lib, make_book):
    biblio, _ = make_book(itype="REF")
    with pytest.raises(PolicyBlocked):
        circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=lib["branches"]["MAIN"].id)


def test_privacy_opt_out_anonymises_on_return(db, lib, make_book):
    p = lib["make_user"]("private", keep_history=False)
    _, (item,) = make_book()
    loan = circulation.checkout(db, p, item, branch_id=item.branch_id).loan
    circulation.checkin(db, item, branch_id=item.branch_id)
    assert loan.patron_id is None


def test_nightly_expires_holds_and_sends_notices(db, lib, make_book):
    biblio, (item, other) = make_book(copies=2)
    h = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=item.branch_id)
    circulation.checkin(db, item, branch_id=item.branch_id)
    h.expires_at = utcnow() - timedelta(days=1)
    tomorrow_loan = circulation.checkout(db, lib["patron2"], other, branch_id=other.branch_id).loan
    tomorrow_loan.due_at = utcnow() + timedelta(days=1)
    stats = circulation.run_nightly(db)
    assert stats["holds_expired"] == 1 and h.status == HoldStatus.expired
    assert item.status == ItemStatus.available
    assert stats["courtesy"] == 1


def test_mark_lost_charges_replacement(db, lib, make_book):
    _, (item,) = make_book()
    item.price = 45000
    loan = circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id).loan
    cost = circulation.mark_lost(db, loan, actor=lib["librarian"])
    assert cost == 45000 and item.status == ItemStatus.lost
    assert circulation.balance(db, lib["patron"].id) == 45000


# ------------------------------------------------------------------ via the HTTP API


def test_api_checkout_override_flow(client, staff, lib, make_book, db):
    _, (item,) = make_book()
    circulation.charge(db, db.get(Patron, lib["patron"].id), 90000, lib["admin"], "x")
    db.commit()
    body = {"patron_card": "reader1", "barcode": item.barcode}
    r = client.post("/api/v1/circulation/checkout", json=body, headers=staff)
    assert r.status_code == 422 and r.json()["reasons"]
    r = client.post("/api/v1/circulation/checkout", json={**body, "override": True}, headers=staff)
    assert r.status_code == 200 and r.json()["warnings"]
    r = client.post("/api/v1/circulation/checkin", json={"barcode": item.barcode}, headers=staff)
    assert r.status_code == 200 and r.json()["item"]["status"] == "available"


def test_api_patron_self_service(client, lib, make_book, db):
    from conftest import login

    biblio, (item,) = make_book()
    circulation.checkout(db, db.get(Patron, lib["patron"].id), item, branch_id=item.branch_id)
    db.commit()
    h = login(client, "reader1")
    s = client.get("/api/v1/opac/me/summary", headers=h).json()
    assert len(s["loans"]) == 1
    loan_id = s["loans"][0]["id"]
    assert client.post(f"/api/v1/opac/me/loans/{loan_id}/renew", headers=h).status_code == 200
    # cannot renew someone else's loan
    h2 = login(client, "reader2")
    assert client.post(f"/api/v1/opac/me/loans/{loan_id}/renew", headers=h2).status_code == 404
    r = client.post("/api/v1/opac/me/holds", headers=h2, json={"biblio_id": biblio.id, "pickup_branch_id": item.branch_id})
    assert r.status_code == 201 and r.json()["queue_position"] == 1
