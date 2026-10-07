"""Batch item modification/withdrawal/deletion and inventory classification."""

from __future__ import annotations

import pytest
from conftest import login

from shelfwise.errors import DomainError
from shelfwise.models import AuditLog, ItemStatus
from shelfwise.services import batch_items as svc
from shelfwise.services import circulation


@pytest.fixture()
def shelf(db, lib, make_book):
    """Five items: four on MAIN/Stacks (one of them on loan), one on EAST."""
    b1, items = make_book("Emma", copies=4, classification="823.7")
    b2, (east,) = make_book("Persuasion", copies=1)
    for i in items:
        i.shelf_location = "Stacks"
        i.call_number = "823.7 AUS"
    east.branch_id = lib["branches"]["EAST"].id
    east.shelf_location = "Stacks"
    db.commit()
    circulation.checkout(db, lib["patron"], items[3], branch_id=items[3].branch_id)
    db.commit()
    return {"main": items, "east": east, "biblios": (b1, b2)}


def test_modify_preview_does_not_change_then_apply(db, lib, shelf):
    items = shelf["main"]
    codes = [i.barcode for i in items] + ["NOPE"]
    sel, unknown = svc.select_items(db, {"barcodes": "\n".join(codes)})
    assert unknown == ["NOPE"] and len(sel) == 4
    changes = {"item_type_id": lib["itypes"]["REF"].id, "status": "processing", "call_number_prefix": "REF",
               "notes_mode": "append", "notes": "Moved to reference"}
    rows = svc.plan_modify(db, sel, changes)
    by_code = {r["barcode"]: r for r in rows}
    assert by_code[items[0].barcode]["result"] == "change"
    assert by_code[items[3].barcode]["result"] == "skipped" and "on loan" in by_code[items[3].barcode]["reason"]
    fields = {c["field"]: c for c in by_code[items[0].barcode]["changes"]}
    assert fields["item_type_id"]["before"] == "Book" and fields["item_type_id"]["after"] == "Reference"
    assert fields["call_number"]["after"] == "REF 823.7 AUS" and fields["notes"]["after"] == "Moved to reference"
    db.rollback()
    assert items[0].item_type_id == lib["itypes"]["BOOK"].id and items[0].call_number == "823.7 AUS"  # preview only

    applied = svc.apply_modify(db, sel, changes)
    db.commit()
    assert svc.tally(applied) == {"changed": 3, "skipped": 1}
    assert items[0].status == ItemStatus.processing and items[0].call_number == "REF 823.7 AUS"
    assert items[3].status == ItemStatus.on_loan and items[3].call_number == "823.7 AUS"
    # idempotent prefixes, and removal
    again = svc.plan_modify(db, items[:1], {"call_number_prefix": "REF"})
    assert again[0]["result"] == "unchanged"
    removed = svc.apply_modify(db, items[:1], {"call_number_prefix": "REF", "call_number_prefix_mode": "remove",
                                               "shelf_location": ""})
    db.commit()
    assert removed[0]["result"] == "changed" and items[0].call_number == "823.7 AUS" and items[0].shelf_location is None


def test_modify_validation_and_search_selection(db, lib, shelf):
    with pytest.raises(DomainError):
        svc.select_items(db, {"search": {}})
    with pytest.raises(DomainError):
        svc.plan_modify(db, shelf["main"], {})
    with pytest.raises(DomainError):
        svc.plan_modify(db, shelf["main"], {"status": "on_loan"})
    with pytest.raises(DomainError):
        svc.plan_modify(db, shelf["main"], {"branch_id": 999})
    sel, _ = svc.select_items(db, {"search": {"branch_id": lib["branches"]["MAIN"].id, "shelf_location": "stacks"}})
    assert {i.id for i in sel} == {i.id for i in shelf["main"]}
    sel, _ = svc.select_items(db, {"search": {"q": "persuasion"}})
    assert [i.id for i in sel] == [shelf["east"].id]
    sel, _ = svc.select_items(db, {"search": {"status": "on_loan"}})
    assert [i.id for i in sel] == [shelf["main"][3].id]
    sel, _ = svc.select_items(db, {"search": {"call_number_prefix": "823.7"}})
    assert len(sel) == 4


def test_withdraw_and_delete_protect_loans(db, lib, shelf):
    items = shelf["main"]
    rows = svc.plan_delete(db, items, "delete")
    assert [r["result"] for r in rows] == ["delete", "delete", "delete", "skipped"]
    res = svc.apply_delete(db, items[:2], "withdraw")
    db.commit()
    assert [r["result"] for r in res["rows"]] == ["withdrawn", "withdrawn"]
    assert svc.plan_delete(db, items[:1], "withdraw")[0]["result"] == "unchanged"
    # deleting the only item of a record can remove the empty record too
    b2 = shelf["biblios"][1]
    res = svc.apply_delete(db, [shelf["east"]], "delete", delete_empty_biblios=True)
    db.commit()
    assert res["biblios_deleted"] == [{"biblio_id": b2.id, "title": "Persuasion"}] and b2.deleted_at is not None
    res = svc.apply_delete(db, items, "delete", delete_empty_biblios=True)
    db.commit()
    assert svc.tally(res["rows"]) == {"deleted": 3, "skipped": 1}
    assert res["biblios_deleted"] == []  # one copy is still on loan


def test_inventory_classification(db, lib, shelf, make_book):
    main_items = shelf["main"]
    lost = main_items[2]
    lost.status = ItemStatus.lost
    db.commit()
    scans = [main_items[0].barcode, main_items[0].barcode, main_items[3].barcode, lost.barcode, shelf["east"].barcode, "GHOST"]
    report = svc.run_inventory(db, branch_id=lib["branches"]["MAIN"].id, shelf_location="Stacks", barcodes=scans)
    db.commit()
    by = {r["barcode"]: r for r in report["scanned"]}
    assert by[main_items[0].barcode]["result"] == "ok" and by[main_items[0].barcode]["scans"] == 2
    assert by[main_items[3].barcode]["result"] == "wrong_status" and by[main_items[3].barcode]["action"] == "checkin"
    assert by[lost.barcode]["problems"][0]["code"] == "lost"
    assert by[shelf["east"].barcode]["result"] == "out_of_place"
    assert "East Branch" in by[shelf["east"].barcode]["problems"][0]["message"]
    assert [m["barcode"] for m in report["missing"]] == [main_items[1].barcode]
    assert report["unknown"] == ["GHOST"]
    s = report["summary"]
    assert (s["scanned"], s["unique"], s["ok"], s["missing"], s["duplicates"], s["marked_seen"]) == (6, 5, 1, 1, 1, 4)
    assert main_items[0].last_seen_at is not None and main_items[1].last_seen_at is None
    csv_text = svc.inventory_csv(report)
    assert csv_text.splitlines()[0].startswith("result,barcode") and "GHOST" in csv_text and "missing" in csv_text
    # call-number range narrows what is expected
    narrow = svc.run_inventory(db, branch_id=lib["branches"]["MAIN"].id, barcodes=[], call_number_from="900",
                               mark_seen=False)
    assert narrow["missing"] == []


def test_batch_and_inventory_api(client, db, lib, shelf):
    staff, patron = login(client, "librarian"), login(client, "reader1")
    codes = [i.barcode for i in shelf["main"]]
    body = {"selection": {"barcodes": codes}, "changes": {"shelf_location": "New books"}}
    assert client.post("/api/v1/batch/items/modify", headers=patron, json=body).status_code == 403
    prev = client.post("/api/v1/batch/items/modify", headers=staff, json=body).json()
    assert prev["dry_run"] and prev["summary"] == {"change": 4}
    assert "_value" not in str(prev["results"])
    done = client.post("/api/v1/batch/items/modify", headers=staff, json={**body, "dry_run": False}).json()
    assert done["summary"] == {"changed": 4}
    db.expire_all()
    assert all(i.shelf_location == "New books" for i in shelf["main"])
    assert db.query(AuditLog).filter(AuditLog.action == "batch_modify").count() == 1
    bad = client.post("/api/v1/batch/items/modify", headers=staff, json={"selection": {"barcodes": codes}, "changes": {}})
    assert bad.status_code == 400

    d = client.post("/api/v1/batch/items/delete", headers=staff,
                    json={"selection": {"barcodes": codes}, "action": "withdraw", "dry_run": False}).json()
    assert d["summary"] == {"withdrawn": 3, "skipped": 1}

    inv = {"branch_id": lib["branches"]["MAIN"].id, "shelf_location": "New books", "barcodes": codes[:1]}
    assert client.post("/api/v1/inventory", headers=patron, json=inv).status_code == 403
    r = client.post("/api/v1/inventory", headers=staff, json=inv)
    assert r.status_code == 200 and r.json()["summary"]["ok"] == 0  # withdrawn items are not expected on the shelf
    csv_r = client.post("/api/v1/inventory?format=csv", headers=staff, json={**inv, "mark_seen": False})
    assert csv_r.status_code == 200 and csv_r.headers["content-type"].startswith("text/csv")
    locs = client.get(f"/api/v1/inventory/locations?branch_id={lib['branches']['MAIN'].id}", headers=staff).json()["results"]
    assert {"value": "New books", "label": "New books", "items": 4} in locs
    assert client.get("/staff/batch", headers=staff).status_code == 200
    assert client.get("/staff/authorities", headers=staff).status_code == 200
    assert client.get("/staff/batch", headers=patron, follow_redirects=False).status_code == 303
