"""Course reserves: item-type/location swap and restore, multi-course reserves, bulk deactivation,
permissions and OPAC visibility."""

from __future__ import annotations

import pytest
from conftest import login
from sqlalchemy import select

from shelfwise.errors import Conflict
from shelfwise.models import CourseItem, CourseReserve, Item
from shelfwise.services import circulation
from shelfwise.services import courses as svc


@pytest.fixture()
def res(db, lib, make_book):
    restype = svc.ensure_reserve_item_type(db)
    db.commit()
    book, items = make_book("Introduction to Algorithms", copies=2, shelf_location=None)
    for i in items:
        i.shelf_location = "Stacks"
    db.commit()

    def course(code="CS 101", term="Autumn 2026", active=True, **kw):
        c = svc.create_course(db, {"code": code, "name": f"{code} course", "term": term, "department": "Computer Science",
                                   "active": active, "instructor_ids": [lib["patron2"].id], **kw})
        db.commit()
        return c

    return {"type": restype, "book": book, "items": items, "course": course, "book_type": lib["itypes"]["BOOK"]}


def test_reserve_swaps_and_restores_item_type_and_location(db, lib, res):
    c = res["course"]()
    item = res["items"][0]
    r = svc.add_reserve(db, c, item=item, settings={"item_type_id": res["type"].id, "shelf_location": "Reserve desk"},
                        actor=lib["librarian"])
    db.commit()
    db.refresh(item)
    assert item.item_type_id == res["type"].id and item.shelf_location == "Reserve desk"
    ci = r.course_item
    assert ci.swapped and ci.original_item_type_id == res["book_type"].id and ci.original_shelf_location == "Stacks"
    # the short-loan rule applies while on reserve
    rule = circulation.resolve_rule(db, item.branch_id, lib["patron"].category_id, item.item_type_id)
    assert rule.loan_days == 1 and rule.max_renewals == 0
    assert svc.remove_reserve(db, r, actor=lib["librarian"]) == "restored"
    db.commit()
    db.refresh(item)
    assert item.item_type_id == res["book_type"].id and item.shelf_location == "Stacks"
    assert db.scalar(select(CourseItem)) is None  # orphaned course item cleaned up


def test_multi_course_reserve_keeps_swap_until_last_active_course(db, lib, res):
    a, b = res["course"]("CS 101"), res["course"]("CS 202")
    item = res["items"][0]
    settings = {"item_type_id": res["type"].id, "shelf_location": "Reserve desk"}
    ra = svc.add_reserve(db, a, item=item, settings=settings)
    rb = svc.add_reserve(db, b, item=item)
    db.commit()
    assert ra.course_item_id == rb.course_item_id
    with pytest.raises(Conflict):
        svc.add_reserve(db, a, item=item)
    # deactivating one course keeps the item on reserve for the other
    assert svc.set_active(db, a, False)["restored"] == 0
    db.refresh(item)
    assert item.item_type_id == res["type"].id
    # removing the other course's reserve restores it (course A is inactive)
    svc.remove_reserve(db, rb)
    db.commit()
    db.refresh(item)
    assert item.item_type_id == res["book_type"].id and item.shelf_location == "Stacks"
    # re-activating course A swaps the item again
    assert svc.set_active(db, a, True)["swapped"] == 1
    db.refresh(item)
    assert item.item_type_id == res["type"].id


def test_inactive_course_does_not_swap_until_activated(db, res):
    c = res["course"](active=False)
    item = res["items"][1]
    svc.add_reserve(db, c, item=item, settings={"item_type_id": res["type"].id})
    db.commit()
    db.refresh(item)
    assert item.item_type_id == res["book_type"].id
    svc.set_active(db, c, True)
    db.refresh(item)
    assert item.item_type_id == res["type"].id and item.shelf_location == "Stacks"  # no location override given


def test_manual_change_while_on_reserve_is_respected(db, res, lib):
    c = res["course"]()
    item = res["items"][0]
    svc.add_reserve(db, c, item=item, settings={"item_type_id": res["type"].id, "shelf_location": "Reserve desk"})
    db.commit()
    item.item_type = lib["itypes"]["REF"]  # staff re-type the item by hand
    db.commit()
    svc.set_active(db, c, False)
    db.refresh(item)
    assert item.item_type_id == lib["itypes"]["REF"].id  # not clobbered
    assert item.shelf_location == "Stacks"  # location still restored


def test_updating_shared_settings_reapplies(db, res, lib):
    c = res["course"]()
    item = res["items"][0]
    r = svc.add_reserve(db, c, item=item, settings={"item_type_id": res["type"].id})
    db.commit()
    svc.update_course_item_settings(db, r.course_item, {"item_type_id": lib["itypes"]["REF"].id, "shelf_location": "Desk 2"})
    db.commit()
    db.refresh(item)
    assert item.item_type_id == lib["itypes"]["REF"].id and item.shelf_location == "Desk 2"
    assert r.course_item.original_item_type_id == res["book_type"].id
    svc.set_active(db, c, False)
    db.refresh(item)
    assert item.item_type_id == res["book_type"].id and item.shelf_location == "Stacks"


def test_bulk_end_of_term_and_delete_course(db, res):
    a, b = res["course"]("CS 101"), res["course"]("CS 202")
    other = res["course"]("CS 999", term="Spring 2027")
    svc.add_reserve(db, a, item=res["items"][0], settings={"item_type_id": res["type"].id})
    svc.add_reserve(db, b, item=res["items"][1], settings={"item_type_id": res["type"].id})
    svc.add_reserve(db, other, biblio=res["book"])  # title-level: nothing to swap
    db.commit()
    out = svc.bulk_set_active(db, active=False, term="Autumn 2026")
    db.commit()
    assert out == {"courses": 2, "swapped": 0, "restored": 2}
    assert other.active
    for i in res["items"]:
        db.refresh(i)
        assert i.item_type_id == res["book_type"].id
    svc.bulk_set_active(db, active=True, course_ids=[a.id])
    assert svc.delete_course(db, a) == 1
    db.commit()
    db.refresh(res["items"][0])
    assert res["items"][0].item_type_id == res["book_type"].id
    assert db.scalar(select(CourseReserve).where(CourseReserve.course_id == a.id)) is None


def test_duplicate_course_rejected(db, res):
    res["course"]("HIST 1")
    with pytest.raises(Conflict):
        res["course"]("HIST 1")
    res["course"]("HIST 1", term="Spring 2027")  # same code, different term is fine


# ------------------------------------------------------------------ API


def test_api_course_management_and_opac(client, db, lib, res):
    staff = login(client, "librarian")
    item = res["items"][0]
    r = client.post("/api/v1/courses", headers=staff, json={
        "code": "LIT 300", "name": "Victorian Fiction", "department": "English", "term": "Autumn 2026",
        "instructor_ids": [lib["patron2"].id], "public_notes": "Two-hour loans at the desk."})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    r = client.post(f"/api/v1/courses/{cid}/reserves", headers=staff, json={
        "barcode": item.barcode, "item_type_id": res["type"].id, "shelf_location": "Reserve desk", "public_note": "Ch. 1-3"})
    assert r.status_code == 201, r.text
    rv = r.json()
    assert rv["swapped"] and rv["item"]["item_type"]["code"] == "RES" and rv["original_item_type"]["name"] == "Book"
    assert client.post(f"/api/v1/courses/{cid}/reserves", headers=staff, json={"barcode": item.barcode}).status_code == 409
    assert client.post(f"/api/v1/courses/{cid}/reserves", headers=staff, json={"barcode": "NOPE"}).status_code == 404
    r = client.post(f"/api/v1/courses/{cid}/reserves", headers=staff, json={"biblio_id": res["book"].id})
    assert r.status_code == 201 and r.json()["title_level"]
    # staff list/detail
    lst = client.get("/api/v1/courses?q=victorian", headers=staff).json()
    assert lst["total"] == 1 and lst["results"][0]["reserve_count"] == 2
    assert client.get("/api/v1/courses?q=Reader2", headers=staff).json()["total"] == 1  # by instructor name
    # OPAC: public browse shows live availability; no barcodes or staff notes leak
    pub = client.get("/api/v1/courses/public?department=English").json()
    assert pub["total"] == 1 and pub["facets"]["departments"] == ["English"]
    assert "card_number" not in pub["results"][0]["instructors"][0]
    detail = client.get(f"/api/v1/courses/public/{cid}").json()
    item_res = next(x for x in detail["reserves"] if x["item"])
    assert item_res["item"]["status"] == "available" and item_res["item"]["barcode"] is None
    assert "staff_note" not in item_res
    title_res = next(x for x in detail["reserves"] if x["title_level"])
    assert title_res["availability"]["total"] == 2
    # edit reserve, then deactivate via bulk → hidden from OPAC and item restored
    r = client.patch(f"/api/v1/courses/reserves/{rv['id']}", headers=staff, json={"shelf_location": "Desk B"})
    assert r.status_code == 200 and r.json()["item"]["shelf_location"] == "Desk B"
    r = client.post("/api/v1/courses/bulk-status", headers=staff, json={"active": False, "course_ids": [cid]})
    assert r.json() == {"courses": 1, "swapped": 0, "restored": 1}
    assert client.get(f"/api/v1/courses/public/{cid}").status_code == 404
    assert client.get("/api/v1/courses/public").json()["total"] == 0
    db.expire_all()
    assert db.get(Item, item.id).shelf_location == "Stacks"
    # update + delete
    r = client.put(f"/api/v1/courses/{cid}", headers=staff, json={"code": "LIT 300", "name": "Victorian Novels", "active": True})
    assert r.status_code == 200 and r.json()["changes"]["swapped"] == 1 and r.json()["instructors"] == []
    assert client.get(f"/api/v1/courses/items/{item.id}/reserves", headers=staff).json()["results"]
    r = client.delete(f"/api/v1/courses/{cid}", headers=staff)
    assert r.status_code == 200 and r.json()["restored"] == 1


def test_api_permissions(client, lib):
    patron = login(client, "reader1")
    assert client.get("/api/v1/courses", headers=patron).status_code == 403
    assert client.post("/api/v1/courses", headers=patron, json={"code": "X", "name": "Y"}).status_code == 403
    assert client.post("/api/v1/courses/bulk-status", headers=patron, json={"term": "x"}).status_code == 403
    assert client.get("/api/v1/courses/public").status_code == 200


def test_pages_render(client, lib, db, res):
    c = res["course"]()
    staff = login(client, "librarian")
    for path in ("/staff/courses", f"/staff/courses/{c.id}"):
        r = client.get(path, headers=staff)
        assert r.status_code == 200 and 'data-page="staff-courses"' in r.text
    client.cookies.clear()
    for path in ("/courses", f"/courses/{c.id}"):
        r = client.get(path)
        assert r.status_code == 200 and 'data-page="opac-courses"' in r.text
