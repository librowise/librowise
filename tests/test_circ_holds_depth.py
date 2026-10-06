"""Holds depth: suspension, item-level holds, "not needed after" and hold notes."""

from datetime import timedelta

import pytest
from conftest import login

from shelfwise.errors import Conflict, NotFound, PolicyBlocked
from shelfwise.models import HoldStatus, ItemStatus, utcnow
from shelfwise.services import circulation
from shelfwise.services import holds as holds_svc


def test_suspended_hold_is_skipped_by_routing_and_resumes(db, lib, make_book):
    biblio, (item,) = make_book()
    main = item.branch_id
    h1 = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=main)
    h2 = circulation.place_hold(db, lib["patron2"], biblio, pickup_branch_id=main)
    holds_svc.suspend(db, h1)
    assert circulation.hold_queue_position(db, h1) == 1  # keeps its place in the queue
    res = circulation.checkin(db, item, branch_id=main)
    assert res.hold.id == h2.id and h2.status == HoldStatus.ready and h1.status == HoldStatus.queued
    holds_svc.resume(db, h1)
    assert not h1.suspended
    with pytest.raises(Conflict):
        holds_svc.resume(db, h1)


def test_suspension_with_date_resumes_automatically(db, lib, make_book):
    biblio, (item,) = make_book()
    main = item.branch_id
    today = utcnow().date()
    h = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=main)
    with pytest.raises(PolicyBlocked):
        holds_svc.suspend(db, h, until=today)
    holds_svc.suspend(db, h, until=today + timedelta(days=3))
    assert circulation.holds_to_pull(db) == []
    # Routing treats it as active from the resume date onwards, and clears the flag
    later = utcnow() + timedelta(days=3)
    res = circulation.checkin(db, item, branch_id=main, now=later)
    assert res.hold.id == h.id and h.status == HoldStatus.ready and not h.suspended


def test_nightly_resumes_and_expires_not_needed(db, lib, make_book):
    biblio, (item,) = make_book()
    biblio2, _ = make_book("Other")
    main = item.branch_id
    today = utcnow().date()
    h1 = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=main)
    holds_svc.suspend(db, h1, until=today + timedelta(days=2))
    h2 = circulation.place_hold(db, lib["patron2"], biblio2, pickup_branch_id=main,
                                not_needed_after=today + timedelta(days=1))
    stats = circulation.run_nightly(db, now=utcnow() + timedelta(days=1))
    assert stats["holds_resumed"] == 0 and stats["holds_not_needed"] == 0
    stats = circulation.run_nightly(db, now=utcnow() + timedelta(days=2))
    assert stats["holds_resumed"] == 1 and not h1.suspended and h1.suspended_until is None
    assert stats["holds_not_needed"] == 1 and h2.status == HoldStatus.expired


def test_not_needed_after_validation_and_routing(db, lib, make_book):
    biblio, (item,) = make_book()
    main = item.branch_id
    with pytest.raises(PolicyBlocked):
        circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=main,
                               not_needed_after=utcnow().date() - timedelta(days=1))
    h = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=main,
                               not_needed_after=utcnow().date())
    res = circulation.checkin(db, item, branch_id=main, now=utcnow() + timedelta(days=2))
    assert res.hold is None and h.status == HoldStatus.queued and item.status == ItemStatus.available


def test_cannot_suspend_routed_hold(db, lib, make_book):
    biblio, (item,) = make_book()
    h = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=lib["branches"]["EAST"].id)
    circulation.checkin(db, item, branch_id=item.branch_id)
    assert item.status == ItemStatus.in_transit
    with pytest.raises(Conflict):
        holds_svc.suspend(db, h)


def test_item_level_hold_only_filled_by_requested_copy(db, lib, make_book):
    biblio, (a, b) = make_book(copies=2)
    main = a.branch_id
    other_biblio, (x,) = make_book("Elsewhere")
    with pytest.raises(NotFound):
        circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=main, item_id=x.id)
    circulation.checkout(db, lib["patron2"], a, branch_id=main)
    circulation.checkout(db, lib["admin"], b, branch_id=main)
    h = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=main, item_id=b.id)
    assert h.requested_item_id == b.id and h.item_id is None
    res = circulation.checkin(db, a, branch_id=main)
    assert res.hold is None and a.status == ItemStatus.available
    res = circulation.checkin(db, b, branch_id=main)
    assert res.hold.id == h.id and h.status == HoldStatus.ready and h.item_id == b.id


def test_item_level_hold_pull_list_and_renewal(db, lib, make_book):
    biblio, (a, b) = make_book(copies=2)
    main = a.branch_id
    loan = circulation.checkout(db, lib["patron2"], a, branch_id=main).loan
    h = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=main, item_id=b.id)
    pull = circulation.holds_to_pull(db)
    assert [(r["hold"].id, r["item"].id) for r in pull] == [(h.id, b.id)]
    # A hold on a *different* copy doesn't block renewing this one
    assert not circulation.renewal_blocks(db, loan)


def test_suspended_hold_does_not_block_renewal(db, lib, make_book):
    biblio, (item,) = make_book()
    loan = circulation.checkout(db, lib["patron"], item, branch_id=item.branch_id).loan
    h = circulation.place_hold(db, lib["patron2"], biblio, pickup_branch_id=item.branch_id)
    assert circulation.renewal_blocks(db, loan)
    holds_svc.suspend(db, h)
    assert not circulation.renewal_blocks(db, loan)


def test_update_hold_notes_and_pickup(db, lib, make_book):
    biblio, (item,) = make_book()
    h = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=item.branch_id)
    holds_svc.update(db, h, notes="  Large print if possible ", pickup_branch_id=lib["branches"]["EAST"].id)
    assert h.notes == "Large print if possible" and h.pickup_branch_id == lib["branches"]["EAST"].id
    with pytest.raises(NotFound):
        holds_svc.update(db, h, pickup_branch_id=9999)


# ------------------------------------------------------------------ API


def test_staff_hold_actions_api(client, staff, lib, make_book):
    biblio, (a, b) = make_book(copies=2)
    r = client.post("/api/v1/holds", headers=staff, json={
        "biblio_id": biblio.id, "pickup_branch_id": a.branch_id, "patron_card": "reader1", "item_id": b.id,
        "not_needed_after": (utcnow().date() + timedelta(days=30)).isoformat(), "notes": "for school project"})
    assert r.status_code == 201, r.text
    h = r.json()
    assert h["item_level"] and h["requested_item"]["barcode"] == b.barcode and h["not_needed_after"]
    hid = h["id"]
    until = (utcnow().date() + timedelta(days=5)).isoformat()
    r = client.post(f"/api/v1/holds/{hid}/suspend", headers=staff, json={"until": until})
    assert r.status_code == 200 and r.json()["suspended"] and r.json()["suspended_until"] == until
    r = client.post(f"/api/v1/holds/{hid}/resume", headers=staff)
    assert r.status_code == 200 and not r.json()["suspended"]
    r = client.patch(f"/api/v1/holds/{hid}", headers=staff, json={"notes": "updated", "not_needed_after": None})
    assert r.status_code == 200 and r.json()["notes"] == "updated" and r.json()["not_needed_after"] is None
    assert client.post("/api/v1/holds/9999/suspend", headers=staff, json={}).status_code == 404


def test_opac_hold_actions_are_owner_only(client, lib, make_book):
    biblio, (item,) = make_book()
    me, other = login(client, "reader1"), login(client, "reader2")
    r = client.post("/api/v1/opac/me/holds", headers=me, json={
        "biblio_id": biblio.id, "pickup_branch_id": item.branch_id, "item_id": item.id})
    assert r.status_code == 201 and r.json()["item_level"]
    hid = r.json()["id"]
    assert client.post(f"/api/v1/opac/me/holds/{hid}/suspend", headers=other, json={}).status_code == 404
    assert client.patch(f"/api/v1/opac/me/holds/{hid}", headers=other, json={"notes": "x"}).status_code == 404
    r = client.post(f"/api/v1/opac/me/holds/{hid}/suspend", headers=me, json={})
    assert r.status_code == 200 and r.json()["suspended"] and r.json()["suspended_until"] is None
    s = client.get("/api/v1/opac/me/summary", headers=me).json()
    assert s["holds"][0]["suspended"] is True
    assert client.post(f"/api/v1/opac/me/holds/{hid}/resume", headers=me).status_code == 200
    r = client.patch(f"/api/v1/opac/me/holds/{hid}", headers=me, json={"notes": "Ring me"})
    assert r.json()["notes"] == "Ring me"
    # Patrons cannot use the staff endpoints
    assert client.post(f"/api/v1/holds/{hid}/suspend", headers=me, json={}).status_code == 403
