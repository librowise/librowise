"""Analytics panels and the staff dashboard endpoint: numbers on fixture data, empty ranges, branch filter."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta

import pytest
from conftest import login

from librowise.models import Budget, Hold, HoldStatus, ItemStatus, LedgerEntry, LedgerKind, PurchaseOrder, Vendor
from librowise.services import analytics, circulation


def local_noon(d: date, hour: int = 12) -> datetime:
    """Naive-UTC timestamp for ``hour`` o'clock library-local time on ``d``."""
    return datetime.combine(d, time(hour)) - timedelta(minutes=analytics.local_offset_minutes(d))


@pytest.fixture()
def data(db, lib, make_book):
    """Two branches of activity inside the last 30 days, one loan in the previous period, holds and fines."""
    today = analytics.local_today()
    main, east = lib["branches"]["MAIN"], lib["branches"]["EAST"]
    p1, p2 = lib["patron"], lib["patron2"]
    b1, (i1, i2) = make_book("Alpha Rising", copies=2, subjects=["Space -- Fiction"], authors=["Adams, Ada"], pub_year=1999)
    b2, (j1,) = make_book("Beta Waves", copies=1, subjects=["Oceans"], authors=["Brown, Bo"], pub_year=2015)
    b3, (k1,) = make_book("Gamma Never", copies=1, subjects=["Space"], authors=["Adams, Ada"], pub_year=2021)
    j1.branch_id = east.id  # Beta's only copy lives at the East branch
    db.commit()
    d5, d3, d40 = today - timedelta(days=5), today - timedelta(days=3), today - timedelta(days=40)
    l1 = circulation.checkout(db, p1, i1, branch_id=main.id, now=local_noon(d5, 10)).loan
    circulation.checkin(db, i1, branch_id=main.id, now=local_noon(d3, 15))
    circulation.checkout(db, p2, i2, branch_id=main.id, now=local_noon(d3, 10))
    circulation.checkout(db, p1, j1, branch_id=east.id, now=local_noon(d3, 18))
    old = circulation.checkout(db, p2, i1, branch_id=main.id, now=local_noon(d40, 11)).loan  # previous period (31–60 days ago)
    old.returned_at = local_noon(d40 + timedelta(days=2))
    i1.status = ItemStatus.available
    # holds: one placed and filled in range (2 days to ready), one still queued
    h = Hold(biblio_id=b2.id, patron_id=p2.id, pickup_branch_id=main.id, status=HoldStatus.ready,
             created_at=local_noon(d5), ready_at=local_noon(d3))
    db.add_all([h, Hold(biblio_id=b1.id, patron_id=p1.id, pickup_branch_id=main.id, created_at=local_noon(d3))])
    # fines: 30.00 charged, 10.00 paid, 5.00 waived
    db.add_all([LedgerEntry(patron_id=p1.id, kind=LedgerKind.overdue, amount=3000, created_at=local_noon(d5)),
                LedgerEntry(patron_id=p1.id, kind=LedgerKind.payment, amount=-1000, created_at=local_noon(d3)),
                LedgerEntry(patron_id=p1.id, kind=LedgerKind.waiver, amount=-500, created_at=local_noon(d3))])
    db.commit()
    return {"today": today, "b1": b1, "b2": b2, "b3": b3, "main": main, "east": east, "l1": l1, "d5": d5, "d3": d3}


def get(client, h, panel, **params):
    r = client.get(f"/api/v1/analytics/{panel}", headers=h, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_circulation_panel_counts_comparison_and_branch_filter(client, staff, data):
    d = get(client, staff, "circulation")
    assert d["range"]["days"] == 30 and len(d["labels"]) == 30
    assert d["totals"]["checkouts"] == 3
    assert d["totals"]["returns"] == 1
    assert d["totals"]["previous_checkouts"] == 1
    idx = d["labels"].index(data["d3"].isoformat())
    assert d["checkouts"][idx] == 2 and d["returns"][idx] == 1
    assert d["checkouts"][d["labels"].index(data["d5"].isoformat())] == 1
    main = get(client, staff, "circulation", branch_id=data["main"].id)
    assert main["totals"]["checkouts"] == 2
    east = get(client, staff, "circulation", branch_id=data["east"].id)
    assert east["totals"]["checkouts"] == 1 and east["totals"]["previous_checkouts"] == 0


def test_granularity_buckets_are_weeks_and_months(client, staff, data):
    week = get(client, staff, "circulation", granularity="week")
    assert all(date.fromisoformat(x).weekday() == 0 for x in week["labels"])
    assert sum(week["checkouts"]) == 3
    month = get(client, staff, "circulation", granularity="month", start=(data["today"] - timedelta(days=90)).isoformat())
    assert all(x.endswith("-01") for x in month["labels"]) and sum(month["checkouts"]) == 4


def test_empty_range_returns_zeros(client, staff, data):
    start, end = "2001-01-01", "2001-01-10"
    for panel in svc_panels():
        d = get(client, staff, panel, start=start, end=end)
        assert d["range"]["days"] == 10
    circ = get(client, staff, "circulation", start=start, end=end)
    assert circ["checkouts"] == [0] * 10 and circ["totals"]["checkouts"] == 0
    assert get(client, staff, "heatmap", start=start, end=end)["busiest"] is None
    assert get(client, staff, "top", start=start, end=end)["titles"] == []
    assert get(client, staff, "holds", start=start, end=end)["median_days_to_ready"] is None


def svc_panels():
    return list(analytics.PANELS)


def test_heatmap_uses_library_local_time(client, staff, data):
    d = get(client, staff, "heatmap")
    assert d["rows"][0] == "Mon" and len(d["values"]) == 7 and len(d["values"][0]) == 24
    assert sum(map(sum, d["values"])) == 3
    row = data["d3"].weekday()
    assert d["values"][row][10] == 1 and d["values"][row][18] == 1
    assert d["values"][data["d5"].weekday()][10] == 1


def test_turnover_collection_and_top(client, staff, data):
    t = get(client, staff, "turnover")
    book = next(r for r in t["by_type"] if r["label"] == "Book")
    assert book["items"] == 4 and book["loans"] == 3 and book["turnover"] == 0.75
    space = next(r for r in t["by_subject"] if r["label"] == "Space")
    assert space["loans"] == 2 and space["items"] == 3  # "Space -- Fiction" rolls up to "Space"
    c = get(client, staff, "collection")
    assert c["total_items"] == 4
    assert c["never_borrowed"] == 1 and c["never_borrowed_share"] == 0.25  # Gamma's copy
    assert c["not_borrowed_in_period"] == 1
    assert {r["label"]: r["value"] for r in c["by_publication_decade"]} == {"1990s": 2, "2010s": 1, "2020s": 1}
    top = get(client, staff, "top")
    assert top["titles"][0]["label"] == "Alpha Rising" and top["titles"][0]["value"] == 2
    assert top["authors"][0] == {"label": "Adams, Ada", "value": 2}


def test_holds_patrons_and_fines(client, staff, data):
    h = get(client, staff, "holds")
    assert h["totals"]["placed"] == 2 and h["totals"]["filled"] == 1
    assert h["median_days_to_ready"] == 2.0 and h["queued_now"] == 1 and h["ready_now"] == 1
    p = get(client, staff, "patrons")
    assert p["registered"] == 2 and p["active"] == 2  # staff accounts are not counted as patrons
    assert p["new_total"] == 2  # both fixture patrons registered "now"; staff accounts excluded
    f = get(client, staff, "fines")
    assert f["totals"] == {"charged": 30.0, "paid": 10.0, "waived": 5.0}
    assert f["outstanding"] == 15.0
    assert sum(f["charged"]) == 30.0


def test_branch_comparison_and_overview(client, staff, data):
    b = get(client, staff, "branches", branch_id=data["main"].id)
    rows = {r["code"]: r for r in b["branches"]}
    assert rows["MAIN"]["checkouts"] == 2 and rows["MAIN"]["selected"] is True
    assert rows["EAST"]["checkouts"] == 1 and rows["EAST"]["items"] == 1
    o = get(client, staff, "overview")
    assert o["kpis"]["checkouts"]["value"] == 3 and o["kpis"]["checkouts"]["previous"] == 1
    assert len(o["kpis"]["checkouts"]["spark"]) == 30
    assert o["kpis"]["fines_charged"] == {"value": 30.0, "previous": 0.0, "money": True}


def test_csv_export_and_validation(client, staff, admin, data, lib):
    r = client.get("/api/v1/analytics/branches", headers=staff, params={"fmt": "csv"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    assert r.text.splitlines()[0].startswith("Branch,Checkouts")
    assert client.get("/api/v1/analytics/nope", headers=staff).status_code == 404
    assert client.get("/api/v1/analytics/circulation", headers=staff, params={"start": "2026-02-01", "end": "2026-01-01"}).status_code == 422
    assert client.get("/api/v1/analytics/circulation", headers=staff, params={"start": "2000-01-01", "end": "2026-01-01"}).status_code == 422
    assert client.get("/api/v1/analytics/circulation", headers=staff, params={"branch_id": 999}).status_code == 422
    assert client.get("/api/v1/analytics/circulation", headers=staff, params={"granularity": "hour"}).status_code == 422
    reader = login(client, "reader1")
    assert client.get("/api/v1/analytics/circulation", headers=reader).status_code == 403
    assert client.get("/api/v1/analytics/dashboard", headers=reader).status_code == 403
    client.cookies.clear()
    assert client.get("/api/v1/analytics/circulation").status_code == 401


def test_csv_neutralises_formulas(client, staff, db, lib, make_book):
    b, (item,) = make_book("=HYPERLINK(\"http://evil\")")
    circulation.checkout(db, lib["patron"], item, branch_id=lib["branches"]["MAIN"].id)
    db.commit()
    text = client.get("/api/v1/analytics/top", headers=staff, params={"fmt": "csv"}).text
    assert "'=HYPERLINK" in text


def test_dashboard_snapshot_and_alerts(client, staff, db, data, lib):
    vendor = Vendor(name="V")
    budget = Budget(name="Fiction", fiscal_year=2026, allocated=10000)
    db.add_all([vendor, budget])
    db.flush()
    db.add(PurchaseOrder(vendor_id=vendor.id, budget_id=budget.id, title="X", quantity=1, unit_price=9500))
    # 4 queued holds on Gamma (1 copy) → long-queue alert
    for card in ("q1", "q2", "q3", "q4"):
        p = lib["make_user"](card)
        db.add(Hold(biblio_id=data["b3"].id, patron_id=p.id, pickup_branch_id=data["main"].id))
    db.commit()
    d = client.get("/api/v1/analytics/dashboard", headers=staff).json()
    assert set(d["kpis"]) >= {"checkouts_7d", "returns_7d", "open_loans", "overdue", "holds_queued", "active_patrons_7d", "new_patrons_30d"}
    assert d["kpis"]["checkouts_7d"]["value"] == 3 and len(d["kpis"]["checkouts_7d"]["spark"]) == 14
    assert d["kpis"]["open_loans"]["value"] == 2
    assert {"checkouts_today", "checkins_today", "holds_to_pull", "holds_ready", "holds_expiring", "in_transit_stale"} <= set(d["desk"])
    assert len(d["hourly_today"]) == 24
    kinds = {a["kind"] for a in d["alerts"]}
    assert "budget" in kinds and "holds_ratio" in kinds
    ratio = next(a for a in d["alerts"] if a["kind"] == "holds_ratio")
    assert ratio["params"]["queued"] == 4 and ratio["params"]["copies"] == 1
    east = client.get("/api/v1/analytics/dashboard", headers=staff, params={"branch_id": data["east"].id}).json()
    assert east["kpis"]["checkouts_7d"]["value"] == 1
    assert client.get("/api/v1/analytics/dashboard", headers=staff, params={"branch_id": 999}).status_code == 422
    # the legacy dashboard used by the Reports page keeps working
    assert "stats" in client.get("/api/v1/reports/dashboard", headers=staff).json()


def test_overdue_spike_alert(db, lib, make_book):
    now = analytics.utcnow()
    p = lib["patron"]
    _, items = make_book("Spike", copies=6)
    for n, item in enumerate(items):
        loan = circulation.checkout(db, p if n % 2 else lib["patron2"], item, branch_id=lib["branches"]["MAIN"].id,
                                    now=now - timedelta(days=20)).loan
        loan.due_at = now - timedelta(days=2)  # all fell due this week and none came back
    db.commit()
    alerts = analytics.alerts(db, None, now=now)
    spike = next(a for a in alerts if a["kind"] == "overdue_spike")
    assert spike["value"] == 1.0 and spike["params"]["rate"] == "100%"


def test_window_math():
    w = analytics.Window(date(2026, 3, 1), date(2026, 3, 31), "week", None, 330)
    assert w.days == 31
    assert w.previous().end == date(2026, 2, 28) and w.previous().days == 31
    assert w.start_utc == datetime(2026, 2, 28, 18, 30)
    assert w.bucket_keys()[0] == "2026-02-23"
    m = analytics.Window(date(2025, 11, 15), date(2026, 2, 2), "month")
    assert m.bucket_keys() == ["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"]
