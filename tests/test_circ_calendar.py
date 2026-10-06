"""Library calendar: date math, due dates, fines and hold pickup windows."""

from datetime import date, datetime, timedelta

import pytest

from shelfwise.errors import PolicyBlocked
from shelfwise.models import BranchCalendar, CalendarClosure, HoldStatus, utcnow
from shelfwise.services import calendar as cal
from shelfwise.services import circulation
from shelfwise.services import settings as settings_svc


def _close(db, branch_id, day, desc="Closed", yearly=False, open_override=False):
    db.add(CalendarClosure(branch_id=branch_id, day=day, description=desc, repeats_yearly=yearly,
                           open_override=open_override))
    db.flush()


def test_always_open_calendar_is_identity(db, lib):
    c = cal.for_branch(db, lib["branches"]["MAIN"].id)
    d = date(2026, 3, 10)
    assert c.always_open and c.next_open_day(d) == d
    assert c.add_open_days(d, 7) == d + timedelta(days=7)
    assert c.open_days_between(d, d + timedelta(days=5)) == 5
    assert c.open_days_between(d, d - timedelta(days=5)) == 0


def test_consecutive_closures_weekly_exact_and_yearly(db, lib):
    main = lib["branches"]["MAIN"].id
    sat = date(2026, 3, 14)  # a Saturday
    assert sat.weekday() == 5
    cal.set_closed_weekdays(db, main, [6], actor=None)  # Sundays
    _close(db, main, sat, "Stocktake")  # branch-specific exact date
    _close(db, None, date(2019, 3, 16), "Founders' day", yearly=True)  # all branches, every year (a Monday in 2026)
    c = cal.for_branch(db, main)
    assert not c.is_open(sat) and not c.is_open(sat + timedelta(days=1)) and not c.is_open(sat + timedelta(days=2))
    assert c.next_open_day(sat) == date(2026, 3, 17)
    assert c.next_open_day(date(2026, 3, 13)) == date(2026, 3, 13)  # Friday is open
    # 2 open days after Friday: Tue 17, Wed 18
    assert c.add_open_days(date(2026, 3, 13), 2) == date(2026, 3, 18)
    # Fri 13 → Thu 19: Sat/Sun/Mon closed → Tue, Wed, Thu open
    assert c.open_days_between(date(2026, 3, 13), date(2026, 3, 19)) == 3
    s = c.status(date(2026, 3, 16))
    assert s.reason == "Founders' day" and s.all_branches and s.repeats_yearly
    assert c.status(date(2026, 3, 15)).weekly


def test_branch_specific_entries_win_and_special_openings(db, lib):
    main, east = lib["branches"]["MAIN"].id, lib["branches"]["EAST"].id
    holiday = date(2026, 8, 15)
    _close(db, None, holiday, "Independence Day", yearly=True)
    _close(db, main, holiday, "Open for celebrations", open_override=True)
    assert cal.is_open(db, main, holiday)
    assert not cal.is_open(db, east, holiday)
    assert not cal.is_open(db, east, date(2031, 8, 15))  # yearly recurrence
    # A special opening on a weekly closed day
    cal.set_closed_weekdays(db, east, [6], actor=None)
    sunday = date(2026, 3, 15)
    _close(db, east, sunday, "Book fair", open_override=True)
    assert cal.is_open(db, east, sunday) and not cal.is_open(db, east, sunday + timedelta(days=7))


def test_closed_every_day_never_blocks(db, lib):
    main = lib["branches"]["MAIN"].id
    with pytest.raises(PolicyBlocked):
        cal.set_closed_weekdays(db, main, list(range(7)), actor=None)
    db.add(BranchCalendar(branch_id=main, closed_weekdays=list(range(7))))  # bypassing validation
    db.flush()
    d = date(2026, 3, 2)
    c = cal.for_branch(db, main)
    assert c.next_open_day(d) == d and c.add_open_days(d, 3) == d + timedelta(days=3)


def test_checkout_due_date_skips_closed_days(db, lib, make_book):
    _, (item,) = make_book()
    main = item.branch_id
    natural = utcnow().date() + timedelta(days=14)
    _close(db, main, natural, "Holiday")
    _close(db, None, natural + timedelta(days=1), "Holiday 2", yearly=True)
    cal.set_closed_weekdays(db, main, [(natural + timedelta(days=2)).weekday()], actor=None)
    loan = circulation.checkout(db, lib["patron"], item, branch_id=main).loan
    assert loan.due_at.date() == natural + timedelta(days=3)
    assert loan.due_at.time() == circulation.end_of_day(natural).time()


def test_renewal_due_date_skips_closed_days(db, lib, make_book):
    _, (item,) = make_book()
    main = item.branch_id
    loan = circulation.checkout(db, lib["patron"], item, branch_id=main).loan
    natural = loan.due_at.date() + timedelta(days=14)  # not yet due: the new period starts at the old due date
    _close(db, main, natural, "Holiday")
    circulation.renew(db, loan)
    assert loan.due_at.date() == natural + timedelta(days=1)


def test_fines_count_only_open_days(db, lib, make_book):
    _, (item,) = make_book()
    main = item.branch_id
    now = utcnow()
    loan = circulation.checkout(db, lib["patron"], item, branch_id=main, now=now - timedelta(days=20)).loan
    due = loan.due_at.date()
    late = (now.date() - due).days
    assert late == 6
    _close(db, main, due + timedelta(days=1), "Closed")
    _close(db, main, due + timedelta(days=2), "Closed")
    rule = circulation.resolve_rule(db, main, lib["patron"].category_id, item.item_type_id)
    assert circulation.overdue_fine(loan, rule, now, db) == (late - 2) * 200
    assert circulation.overdue_fine(loan, rule, now) == late * 200  # without db: plain calendar days (compat)
    settings_svc.set_value(db, "fines_skip_closed_days", False)
    db.flush()
    assert circulation.overdue_fine(loan, rule, now, db) == late * 200
    settings_svc.set_value(db, "fines_skip_closed_days", True)
    db.flush()
    res = circulation.checkin(db, item, branch_id=main, now=now)
    assert res.fine == (late - 2) * 200


def test_grace_days_apply_to_open_days(db, lib, make_book):
    from shelfwise.models import CirculationRule

    _, (item,) = make_book()
    main = item.branch_id
    rule_row = db.query(CirculationRule).filter_by(branch_id=None, category_id=None, item_type_id=None).one()
    rule_row.grace_days = 2
    db.flush()
    now = utcnow()
    loan = circulation.checkout(db, lib["patron"], item, branch_id=main, now=now - timedelta(days=17)).loan
    due = loan.due_at.date()  # 3 calendar days late, one of them closed → 2 open days ≤ grace
    _close(db, main, due + timedelta(days=1), "Closed")
    rule = circulation.resolve_rule(db, main, lib["patron"].category_id, item.item_type_id)
    assert circulation.overdue_fine(loan, rule, now, db) == 0


def test_hold_pickup_window_skips_closed_days(db, lib, make_book):
    biblio, (item,) = make_book()
    main = item.branch_id
    today = utcnow().date()
    cal.set_closed_weekdays(db, main, [5, 6], actor=None)
    h = circulation.place_hold(db, lib["patron2"], biblio, pickup_branch_id=main)
    circulation.checkin(db, item, branch_id=main)
    assert h.status == HoldStatus.ready
    d, n = today, 0
    while n < 7:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    expected = d
    assert h.expires_at.date() == expected
    assert h.expires_at == datetime.combine(expected, circulation.end_of_day(expected).time())


# ------------------------------------------------------------------ API


def test_calendar_api_month_weekdays_and_closures(client, staff, lib):
    main = lib["branches"]["MAIN"].id
    r = client.put(f"/api/v1/calendar/{main}/weekdays", json={"closed_weekdays": [6]}, headers=staff)
    assert r.status_code == 200 and r.json()["closed_weekdays"] == [6]
    r = client.post("/api/v1/calendar/closures", headers=staff, json={
        "branch_id": main, "day": "2026-04-06", "end_day": "2026-04-08", "description": "Renovation"})
    assert r.status_code == 201 and len(r.json()["results"]) == 3
    r = client.post("/api/v1/calendar/closures", headers=staff, json={
        "branch_id": None, "day": "2026-01-26", "description": "Republic Day", "repeats_yearly": True})
    assert r.status_code == 201
    m = client.get(f"/api/v1/calendar/{main}/month", params={"year": 2026, "month": 4}, headers=staff).json()
    closed = {d["date"]: d for d in m["days"] if not d["open"]}
    assert {"2026-04-06", "2026-04-07", "2026-04-08", "2026-04-05"} <= set(closed)
    assert closed["2026-04-05"]["weekly"] and closed["2026-04-06"]["reason"] == "Renovation"
    chk = client.get(f"/api/v1/calendar/{main}/check", params={"date": "2026-04-05"}, headers=staff).json()
    assert chk["open"] is False and chk["next_open"] == "2026-04-09"
    cid = closed["2026-04-07"]["closure_id"]
    assert client.delete(f"/api/v1/calendar/closures/{cid}", headers=staff).status_code == 200
    m = client.get(f"/api/v1/calendar/{main}/month", params={"year": 2026, "month": 4}, headers=staff).json()
    assert next(d for d in m["days"] if d["date"] == "2026-04-07")["open"] is True
    jan = client.get(f"/api/v1/calendar/{main}/month", params={"year": 2027, "month": 1}, headers=staff).json()
    assert next(d for d in jan["days"] if d["date"] == "2027-01-26")["open"] is False
    lst = client.get("/api/v1/calendar/closures", params={"branch_id": main}, headers=staff).json()["results"]
    assert any(e["repeats_yearly"] for e in lst)


def test_calendar_api_validation_and_permissions(client, staff, lib):
    from conftest import login

    main = lib["branches"]["MAIN"].id
    assert client.put(f"/api/v1/calendar/{main}/weekdays", json={"closed_weekdays": [0, 1, 2, 3, 4, 5, 6]},
                      headers=staff).status_code == 422
    assert client.put(f"/api/v1/calendar/{main}/weekdays", json={"closed_weekdays": [9]},
                      headers=staff).status_code == 422
    assert client.post("/api/v1/calendar/closures", headers=staff, json={
        "branch_id": main, "day": "2026-04-08", "end_day": "2026-04-01"}).status_code == 422
    assert client.get("/api/v1/calendar/9999/month?year=2026&month=1", headers=staff).status_code == 404
    patron = login(client, "reader1")
    assert client.get(f"/api/v1/calendar/{main}/month?year=2026&month=1", headers=patron).status_code == 403
    assert client.put(f"/api/v1/calendar/{main}/weekdays", json={"closed_weekdays": [6]},
                      headers=patron).status_code == 403
    assert client.post("/api/v1/calendar/closures", headers=patron,
                       json={"day": "2026-04-01"}).status_code == 403
