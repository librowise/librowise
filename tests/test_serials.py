"""Serials control: prediction math, numbering, late detection, receiving, claims, API and OPAC."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from conftest import login
from sqlalchemy import select

from shelfwise.errors import Conflict, PolicyBlocked
from shelfwise.models import (
    AuditLog,
    Item,
    Loan,
    SerialClaim,
    SerialIssue,
    SerialIssueStatus,
    SubscriptionStatus,
    Vendor,
    utcnow,
)
from shelfwise.services import circulation
from shelfwise.services import serials as svc
from shelfwise.services.serials import SerialSpec, add_months, predict, preview

# ------------------------------------------------------------------ prediction math (pure)


def dates(freq, anchor=date(2026, 1, 1), n=5, interval=1, skip=()):
    spec = SerialSpec(frequency=freq, anchor=anchor, interval=interval, skip_weekdays=list(skip),
                      numbering={"X": {}})
    return [p.expected_on for p in predict(spec, limit=n)]


@pytest.mark.parametrize("freq,expected", [
    ("daily", [date(2026, 1, 1), date(2026, 1, 2), date(2026, 1, 3)]),
    ("weekly", [date(2026, 1, 1), date(2026, 1, 8), date(2026, 1, 15)]),
    ("fortnightly", [date(2026, 1, 1), date(2026, 1, 15), date(2026, 1, 29)]),
    ("monthly", [date(2026, 1, 1), date(2026, 2, 1), date(2026, 3, 1)]),
    ("bimonthly", [date(2026, 1, 1), date(2026, 3, 1), date(2026, 5, 1)]),
    ("quarterly", [date(2026, 1, 1), date(2026, 4, 1), date(2026, 7, 1)]),
    ("semiannual", [date(2026, 1, 1), date(2026, 7, 1), date(2027, 1, 1)]),
    ("annual", [date(2026, 1, 1), date(2027, 1, 1), date(2028, 1, 1)]),
])
def test_frequencies(freq, expected):
    assert dates(freq, n=3) == expected


def test_every_n_frequencies():
    assert dates("every_n_days", n=3, interval=10) == [date(2026, 1, 1), date(2026, 1, 11), date(2026, 1, 21)]
    assert dates("every_n_weeks", n=3, interval=3) == [date(2026, 1, 1), date(2026, 1, 22), date(2026, 2, 12)]
    assert dates("every_n_months", n=3, interval=4) == [date(2026, 1, 1), date(2026, 5, 1), date(2026, 9, 1)]


def test_irregular_is_not_predicted():
    assert dates("irregular") == []
    assert preview(SerialSpec(frequency="irregular", anchor=date(2026, 1, 1), numbering={"X": {}}))["irregular"] is True


def test_month_end_never_drifts():
    assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert dates("monthly", anchor=date(2026, 1, 31), n=4) == [
        date(2026, 1, 31), date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30)]
    assert add_months(date(2024, 2, 29), 12) == date(2025, 2, 28)


def test_daily_skipping_sundays():
    # 2026-01-03 is a Saturday, 2026-01-04 a Sunday
    got = dates("daily", anchor=date(2026, 1, 3), n=3, skip=[6])
    assert got == [date(2026, 1, 3), date(2026, 1, 5), date(2026, 1, 6)]


def test_skip_every_publication_day_does_not_hang():
    # a weekly anchored on a Sunday with Sundays skipped can never publish
    assert dates("weekly", anchor=date(2026, 1, 4), skip=[6]) == []


def test_end_date_limits_prediction():
    spec = SerialSpec(frequency="monthly", anchor=date(2026, 1, 15), numbering={"X": {}}, end_date=date(2026, 4, 1))
    assert [p.expected_on.month for p in predict(spec)] == [1, 2, 3]


def enums(pattern, numbering, freq="monthly", anchor=date(2026, 1, 1), n=14):
    spec = SerialSpec(frequency=freq, anchor=anchor, pattern=pattern, numbering=numbering)
    return [p.enumeration for p in predict(spec, limit=n)]


def test_volume_number_rollover():
    got = enums("Vol. {X}, No. {Y}", {"X": {"start": 5}, "Y": {"start": 1, "max": 12}})
    assert got[0] == "Vol. 5, No. 1"
    assert got[11] == "Vol. 5, No. 12"
    assert got[12] == "Vol. 6, No. 1"
    assert got[13] == "Vol. 6, No. 2"


def test_start_mid_volume_resets_to_reset_value():
    got = enums("v.{X} no.{Y}", {"X": {"start": 12}, "Y": {"start": 11, "max": 12, "reset": 1}}, n=4)
    assert got == ["v.12 no.11", "v.12 no.12", "v.13 no.1", "v.13 no.2"]


def test_three_level_odometer_and_increment():
    got = enums("{X}.{Y}.{Z}", {"X": {"start": 1}, "Y": {"start": 1, "max": 2}, "Z": {"start": 1, "max": 3}}, n=8)
    assert got == ["1.1.1", "1.1.2", "1.1.3", "1.2.1", "1.2.2", "1.2.3", "2.1.1", "2.1.2"]
    assert enums("No. {X}", {"X": {"start": 100, "increment": 2}}, n=3) == ["No. 100", "No. 102", "No. 104"]


def test_seasonal_labels_and_year_tokens():
    got = enums("{Y} {YEAR}", {"Y": {"start": 1, "max": 4, "labels": ["Spring", "Summer", "Autumn", "Winter"]}},
                freq="quarterly", anchor=date(2026, 3, 1), n=5)
    assert got == ["Spring 2026", "Summer 2026", "Autumn 2026", "Winter 2026", "Spring 2027"]
    assert enums("{MONTH} {YEAR}", {}, n=2) == ["January 2026", "February 2026"]
    assert enums("{DAY} {MON}", {}, freq="weekly", n=2) == ["1 Jan", "8 Jan"]


def test_yearly_reset_numbering():
    # weekly; issue numbers restart every January and the volume advances
    got = enums("Vol. {X}, No. {Y}", {"X": {"start": 10}, "Y": {"start": 1, "yearly": True}},
                freq="weekly", anchor=date(2026, 12, 24), n=4)
    assert got == ["Vol. 10, No. 1", "Vol. 10, No. 2", "Vol. 11, No. 1", "Vol. 11, No. 2"]


def test_chronology_formats():
    spec = SerialSpec(frequency="monthly", anchor=date(2026, 10, 5), numbering={"X": {}})
    assert next(predict(spec)).chronology == "Oct 2026"
    spec.frequency = "annual"
    assert next(predict(spec)).chronology == "2026"
    spec.frequency = "weekly"
    assert next(predict(spec)).chronology == "5 Oct 2026"


@pytest.mark.parametrize("pattern,numbering,msg", [
    ("Vol. {X}, No. {Y}", {"X": {}}, "level Y is not configured"),
    ("No. {Q}", {"X": {}}, "Unknown placeholder"),
    ("No. {X}", {"W": {}}, "Unknown numbering level"),
    ("No. {X}", {"X": {"start": 5, "max": 3}}, "rollover"),
])
def test_invalid_patterns(pattern, numbering, msg):
    with pytest.raises(PolicyBlocked, match=msg):
        svc.validate_spec(SerialSpec(frequency="monthly", anchor=date(2026, 1, 1), pattern=pattern, numbering=numbering))


def test_preview_starts_today_and_counts_per_year():
    spec = SerialSpec(frequency="monthly", anchor=date(2026, 1, 10), pattern="No. {X}", numbering={"X": {}})
    p = preview(spec, count=3, today=date(2026, 5, 1))
    assert [i["enumeration"] for i in p["issues"]] == ["No. 5", "No. 6", "No. 7"]
    assert p["per_year"] == 12


# ------------------------------------------------------------------ database helpers


@pytest.fixture()
def serial(db, lib, make_book):
    biblio, _ = make_book("The Monthly Review", copies=0, material_type="serial", classification="050")
    vendor = Vendor(name="Periodicals Inc", email="claims@periodicals.example")
    db.add(vendor)
    db.commit()

    def make(start=date(2026, 1, 1), today=date(2026, 3, 20), **kw):
        data = {"frequency": "monthly", "numbering_pattern": "Vol. {X}, No. {Y}",
                "numbering": {"X": {"start": 1}, "Y": {"start": 1, "max": 12}}, "start_date": start,
                "branch_id": lib["branches"]["MAIN"].id, "vendor_id": vendor.id, "grace_days": 5,
                "create_items": True, "item_type_id": lib["itypes"]["MAG"].id, "shelf_location": "Periodicals", **kw}
        sub = svc.create_subscription(db, biblio, data, actor=lib["librarian"], today=today)
        db.commit()
        return sub

    make.biblio, make.vendor = biblio, vendor
    return make


def issues_of(db, sub):
    return list(db.scalars(select(SerialIssue).where(SerialIssue.subscription_id == sub.id)
                           .order_by(SerialIssue.expected_on)))


def test_create_requires_serial_record(db, lib, make_book):
    book, _ = make_book("Not a magazine")
    with pytest.raises(PolicyBlocked, match="not a serial"):
        svc.create_subscription(db, book, {"start_date": date(2026, 1, 1), "branch_id": lib["branches"]["MAIN"].id,
                                           "create_items": False})


def test_generation_marks_past_issues_late_with_grace(db, serial):
    sub = serial(today=date(2026, 3, 20))
    got = issues_of(db, sub)
    assert got[0].enumeration == "Vol. 1, No. 1" and got[0].chronology == "Jan 2026"
    by_month = {i.expected_on.month: i.status for i in got if i.expected_on.year == 2026}
    assert by_month[1] == by_month[2] == SerialIssueStatus.late
    assert by_month[3] == SerialIssueStatus.late  # 1 Mar + 5 days grace < 20 Mar
    assert by_month[4] == SerialIssueStatus.expected
    # horizon: ~180 days ahead of "today"
    assert max(i.expected_on for i in got) <= date(2026, 3, 20) + timedelta(days=svc.DEFAULT_HORIZON_DAYS)


def test_mark_late_respects_grace_period(db, serial):
    sub = serial(start=date(2026, 4, 1), today=date(2026, 3, 1))
    assert all(i.status == SerialIssueStatus.expected for i in issues_of(db, sub))
    # expected 1 Apr, grace 5 days → still on time on 6 Apr, late on 7 Apr
    assert svc.mark_late_issues(db, datetime(2026, 4, 6, 3)) == 0
    assert svc.mark_late_issues(db, datetime(2026, 4, 7, 3)) == 1
    first = issues_of(db, sub)[0]
    assert first.status == SerialIssueStatus.late
    # cancelled subscriptions are ignored
    sub.status = SubscriptionStatus.cancelled
    db.flush()
    assert svc.mark_late_issues(db, datetime(2026, 12, 1)) == 0


def test_nightly_job_runs_serials_hook(db, serial):
    sub = serial(start=date(2026, 4, 1), today=date(2026, 3, 1))
    stats = circulation.run_nightly(db, now=datetime(2026, 4, 20, 2))
    assert stats["serials_late"] >= 1
    assert issues_of(db, sub)[0].status == SerialIssueStatus.late


def test_failing_nightly_hook_is_isolated(db, monkeypatch):
    def boom(db, now):
        db.add(Vendor(name="written inside the failed hook"))
        db.flush()
        raise RuntimeError("boom")

    import types

    module = types.ModuleType("sw_test_hooks")
    module.boom = boom
    monkeypatch.setitem(__import__("sys").modules, "sw_test_hooks", module)
    monkeypatch.setattr(circulation, "NIGHTLY_HOOKS", ["sw_test_hooks:boom", "shelfwise.services.serials:nightly"])
    stats = circulation.run_nightly(db, now=datetime(2026, 4, 20, 2))
    assert stats["failed:sw_test_hooks:boom"] == 1 and "serials_late" in stats
    assert db.scalar(select(Vendor).where(Vendor.name == "written inside the failed hook")) is None


def test_nightly_expires_subscriptions(db, serial):
    sub = serial(start=date(2025, 1, 1), end_date=date(2025, 12, 31), today=date(2025, 1, 1))
    circulation.run_nightly(db, now=datetime(2026, 1, 2, 2))
    assert sub.status == SubscriptionStatus.expired


def test_receive_creates_item_and_undo(db, serial, lib):
    sub = serial()
    issue = issues_of(db, sub)[0]
    svc.receive_issue(db, issue, received_on=date(2026, 1, 3), actor=lib["librarian"])
    db.commit()
    assert issue.status == SerialIssueStatus.arrived and issue.received_on == date(2026, 1, 3)
    item = issue.item
    assert item is not None and item.biblio_id == sub.biblio_id
    assert item.call_number == "050 Vol. 1, No. 1"
    assert item.shelf_location == "Periodicals" and item.item_type_id == lib["itypes"]["MAG"].id
    with pytest.raises(Conflict):
        svc.receive_issue(db, issue)
    svc.undo_receive(db, issue, actor=lib["librarian"], today=date(2026, 3, 20))
    db.commit()
    assert issue.item_id is None and issue.status == SerialIssueStatus.late
    assert db.get(Item, item.id) is None


def test_undo_receive_blocked_after_loan(db, serial, lib):
    sub = serial()
    issue = issues_of(db, sub)[0]
    svc.receive_issue(db, issue, actor=lib["librarian"])
    db.add(Loan(item_id=issue.item_id, patron_id=lib["patron"].id, branch_id=lib["branches"]["MAIN"].id,
                due_at=utcnow(), returned_at=utcnow()))
    db.commit()
    with pytest.raises(Conflict, match="circulated"):
        svc.undo_receive(db, issue)


def test_receive_without_item(db, serial):
    sub = serial(create_items=False, item_type_id=None)
    issue = issues_of(db, sub)[0]
    svc.receive_issue(db, issue)
    assert issue.item is None and issue.status == SerialIssueStatus.arrived


def test_regenerate_keeps_locked_issues(db, serial, lib):
    sub = serial(today=date(2026, 3, 20))
    first, second = issues_of(db, sub)[:2]
    svc.receive_issue(db, first, actor=lib["librarian"])
    svc.set_issue_status(db, second, SerialIssueStatus.missing)
    db.commit()
    # change the pattern: issues not yet acted on are renumbered, locked ones are untouched
    svc.apply_subscription_data(db, sub, {"numbering_pattern": "Issue {X}", "numbering": {"X": {"start": 1}}})
    stats = svc.generate_issues(db, sub, today=date(2026, 3, 20))
    db.commit()
    got = issues_of(db, sub)
    assert got[0].enumeration == "Vol. 1, No. 1" and got[0].status == SerialIssueStatus.arrived
    assert got[1].enumeration == "Vol. 1, No. 2" and got[1].status == SerialIssueStatus.missing
    assert got[2].enumeration == "Issue 3"
    assert stats["updated"] >= 1 and stats["created"] == 0
    again = svc.generate_issues(db, sub, today=date(2026, 3, 20))
    assert again == {"created": 0, "updated": 0, "removed": 0}  # idempotent


def test_shortening_end_date_removes_untouched_predictions(db, serial):
    sub = serial(today=date(2026, 3, 20))
    svc.apply_subscription_data(db, sub, {"end_date": date(2026, 4, 30)})
    stats = svc.generate_issues(db, sub, today=date(2026, 3, 20))
    assert stats["removed"] > 0
    assert max(i.expected_on for i in issues_of(db, sub)) == date(2026, 4, 1)


def test_status_transitions(db, serial):
    sub = serial()
    issue = issues_of(db, sub)[0]
    svc.set_issue_status(db, issue, SerialIssueStatus.not_published)
    with pytest.raises(Conflict):
        svc.receive_issue(db, issue)
    svc.set_issue_status(db, issue, SerialIssueStatus.expected, today=date(2026, 3, 20))  # reopen
    assert issue.status == SerialIssueStatus.late
    with pytest.raises(PolicyBlocked):
        svc.set_issue_status(db, issue, SerialIssueStatus.arrived)


def test_irregular_manual_issues_continue_numbering(db, serial):
    sub = serial(frequency="irregular", numbering_pattern="No. {X}", numbering={"X": {"start": 7}})
    assert issues_of(db, sub) == []
    a = svc.add_manual_issue(db, sub, expected_on=date(2026, 2, 1), today=date(2026, 1, 1))
    b = svc.add_manual_issue(db, sub, expected_on=date(2026, 5, 1), today=date(2026, 1, 1))
    c = svc.add_manual_issue(db, sub, expected_on=date(2026, 6, 1), enumeration="Special issue", today=date(2026, 1, 1))
    assert (a.enumeration, b.enumeration, c.enumeration) == ("No. 7", "No. 8", "Special issue")
    assert a.status == SerialIssueStatus.expected


def test_claims(db, serial, lib):
    sub = serial(today=date(2026, 3, 20))
    late = [i for i in issues_of(db, sub) if i.status == SerialIssueStatus.late]
    expected = next(i for i in issues_of(db, sub) if i.status == SerialIssueStatus.expected)
    with pytest.raises(Conflict, match="Only late"):
        svc.claim_issues(db, [expected], actor=lib["librarian"])
    batch = svc.claim_issues(db, late[:2], actor=lib["librarian"], note="Please resend")
    db.commit()
    assert all(i.status == SerialIssueStatus.claimed and i.claim_count == 1 for i in late[:2])
    claims = db.scalars(select(SerialClaim).where(SerialClaim.batch == batch)).all()
    assert len(claims) == 2 and all(c.vendor_id == serial.vendor.id for c in claims)
    svc.claim_issues(db, late[:1], actor=lib["librarian"])
    assert late[0].claim_count == 2
    assert db.scalar(select(AuditLog).where(AuditLog.action == "claim_issue")) is not None
    # claimed issues stay claimed (not reset to late) when predictions are refreshed
    svc.generate_issues(db, sub, today=date(2026, 3, 21))
    assert late[0].status == SerialIssueStatus.claimed


def test_cancel_and_renew(db, serial):
    sub = serial(today=date(2026, 3, 20), end_date=date(2026, 12, 31))
    removed = svc.cancel_subscription(db, sub, today=date(2026, 3, 20))
    assert removed > 0 and sub.status == SubscriptionStatus.cancelled
    assert all(i.expected_on <= date(2026, 3, 20) for i in issues_of(db, sub))
    stats = svc.renew_subscription(db, sub, date(2027, 6, 30), today=date(2026, 3, 20))
    assert sub.status == SubscriptionStatus.active and stats["created"] > 0


# ------------------------------------------------------------------ API


def sub_body(lib, biblio_id, **kw):
    return {"biblio_id": biblio_id, "frequency": "monthly", "numbering_pattern": "Vol. {X}, No. {Y}",
            "numbering": {"X": {"start": 3}, "Y": {"start": 1, "max": 12}},
            "start_date": (utcnow().date() - timedelta(days=75)).isoformat(),
            "branch_id": lib["branches"]["MAIN"].id, "item_type_id": lib["itypes"]["MAG"].id, "grace_days": 3, **kw}


def test_api_subscription_lifecycle(client, staff, lib, make_book, db):
    b, _ = make_book("Science Weekly", copies=0, material_type="serial")
    r = client.post("/api/v1/serials/preview", headers=staff, json={
        "frequency": "weekly", "numbering_pattern": "No. {X}", "numbering": {"X": {"start": 1}},
        "start_date": "2030-01-07", "count": 6})
    assert r.status_code == 200 and len(r.json()["issues"]) == 6 and r.json()["per_year"] == 53
    r = client.post("/api/v1/serials/subscriptions", headers=staff, json=sub_body(lib, b.id))
    assert r.status_code == 201, r.text
    sub = r.json()
    assert sub["counts"].get("late", 0) >= 2 and sub["next_issue"]["enumeration"].startswith("Vol. 3")
    issues = client.get(f"/api/v1/serials/subscriptions/{sub['id']}/issues?status=outstanding", headers=staff).json()
    late_ids = [i["id"] for i in issues["results"]]
    assert late_ids
    # receive one with an explicit barcode, claim the rest
    r = client.post(f"/api/v1/serials/issues/{late_ids[0]}/receive", headers=staff, json={"barcode": "MAG-0001"})
    assert r.status_code == 200 and r.json()["issue"]["item"]["barcode"] == "MAG-0001"
    r = client.post("/api/v1/serials/claims", headers=staff, json={"issue_ids": late_ids[1:], "note": "x"})
    assert r.status_code == 201
    batch = r.json()["batch"]
    letter = client.get(f"/api/v1/serials/claims/batches/{batch}", headers=staff).json()
    assert letter["letters"][0]["vendor"]["name"] == "No vendor"
    assert len(letter["letters"][0]["claims"]) == len(late_ids) - 1
    assert client.get(f"/staff/serials/claims/{batch}", headers=staff).status_code == 200
    late = client.get("/api/v1/serials/late", headers=staff).json()
    assert late["total"] == len(late_ids) - 1
    hist = client.get(f"/api/v1/serials/claims?subscription_id={sub['id']}", headers=staff).json()
    assert len(hist["results"]) == len(late_ids) - 1
    # bulk receive the claimed ones
    r = client.post("/api/v1/serials/issues/receive", headers=staff, json={"issue_ids": late_ids[1:]})
    assert r.status_code == 200 and r.json()["received"] == len(late_ids) - 1
    # undo receive
    r = client.post(f"/api/v1/serials/issues/{late_ids[0]}/undo-receive", headers=staff)
    assert r.status_code == 200 and r.json()["item"] is None
    # edit (regenerate), renew, routing, list, stats
    full = client.get(f"/api/v1/serials/subscriptions/{sub['id']}", headers=staff).json()
    assert full["routing"] == []
    r = client.put(f"/api/v1/serials/subscriptions/{sub['id']}", headers=staff,
                   json=sub_body(lib, b.id, grace_days=10, numbering_pattern="v.{X} n.{Y}"))
    assert r.status_code == 200 and r.json()["regenerated"]["updated"] > 0
    r = client.put(f"/api/v1/serials/subscriptions/{sub['id']}/routing", headers=staff,
                   json={"entries": [{"patron_id": lib["patron2"].id}, {"patron_id": lib["patron"].id, "notes": "last"}]})
    assert [e["patron_id"] for e in r.json()["routing"]] == [lib["patron2"].id, lib["patron"].id]
    end = (utcnow().date() + timedelta(days=20)).isoformat()
    r = client.post(f"/api/v1/serials/subscriptions/{sub['id']}/renew", headers=staff, json={"end_date": end})
    assert r.status_code == 200
    exp = client.get("/api/v1/serials/expiring?days=30", headers=staff).json()
    assert [s["id"] for s in exp["results"]] == [sub["id"]]
    lst = client.get("/api/v1/serials/subscriptions?q=science", headers=staff).json()
    assert lst["total"] == 1 and lst["results"][0]["next_issue"]
    assert client.get("/api/v1/serials/stats", headers=staff).json()["active"] == 1
    r = client.post(f"/api/v1/serials/subscriptions/{sub['id']}/cancel", headers=staff, json={})
    assert r.json()["status"] == "cancelled"


def test_api_create_with_new_serial_record_and_validation(client, staff, lib):
    body = sub_body(lib, None, new_biblio={"title": "Journal of Testing", "issn": "1234-5678"})
    r = client.post("/api/v1/serials/subscriptions", headers=staff, json=body)
    assert r.status_code == 201
    assert client.get(f"/api/v1/biblios/{r.json()['biblio']['id']}").json()["material_type"] == "serial"
    bad = sub_body(lib, r.json()["biblio"]["id"], numbering_pattern="No. {Z}")
    r = client.post("/api/v1/serials/subscriptions", headers=staff, json=bad)
    assert r.status_code == 422 and "level Z" in r.json()["detail"]
    r = client.post("/api/v1/serials/subscriptions", headers=staff,
                    json=sub_body(lib, None, new_biblio={"title": "No type"}, item_type_id=None))
    assert r.status_code == 422 and "item type" in r.json()["detail"]


def test_api_permissions(client, lib, make_book):
    patron = login(client, "reader1")
    assert client.get("/api/v1/serials/subscriptions", headers=patron).status_code == 403
    assert client.post("/api/v1/serials/claims", headers=patron, json={"issue_ids": [1]}).status_code == 403
    client.cookies.clear()
    assert client.get("/api/v1/serials/subscriptions").status_code == 401
    b, _ = make_book("Public Mag", copies=0, material_type="serial")
    assert client.get(f"/api/v1/serials/public/biblios/{b.id}/issues").status_code == 200


def test_opac_latest_issues(client, db, serial, lib):
    sub = serial(today=date(2026, 3, 20))
    first, second, third = issues_of(db, sub)[:3]
    svc.receive_issue(db, first, received_on=date(2026, 1, 2))
    svc.receive_issue(db, second, received_on=date(2026, 2, 3))
    db.commit()
    r = client.get(f"/api/v1/serials/public/biblios/{sub.biblio_id}/issues")
    assert r.status_code == 200
    data = r.json()
    assert [i["enumeration"] for i in data["results"]] == ["Vol. 1, No. 2", "Vol. 1, No. 1"]
    assert data["results"][0]["status"] == "available" and data["subscribed"] is True
    assert "barcode" not in data["results"][0]


def test_staff_pages_render(client, lib, db, serial):
    sub = serial()
    staff_h = login(client, "librarian")
    for path in ("/staff/serials", f"/staff/serials/{sub.id}"):
        r = client.get(path, headers=staff_h)
        assert r.status_code == 200 and 'data-page="staff-serials"' in r.text
    patron = login(client, "reader1")
    r = client.get("/staff/serials", headers=patron, follow_redirects=False)
    assert r.status_code == 303
