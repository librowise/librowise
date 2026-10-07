"""Insights hub (Reports · Analytics · AI insights): report catalogue metadata, typed columns and row
references, period/branch parameters, humanised CSV, the KPI endpoint, enriched AI-insight rows and the
server-rendered toolbar on all three pages."""

from __future__ import annotations

import csv
import io
from datetime import timedelta

import pytest
from conftest import login

from librowise.models import LedgerEntry, LedgerKind, Patron
from librowise.services import analytics, circulation


@pytest.fixture()
def activity(db, lib, make_book):
    main, east = lib["branches"]["MAIN"], lib["branches"]["EAST"]
    b1, (i1, i2) = make_book("Alpha Rising", copies=2)
    b2, (j1,) = make_book("Beta Waves", copies=1)
    j1.branch_id = east.id
    db.commit()
    now = analytics.utcnow()
    circulation.checkout(db, lib["patron"], i1, branch_id=main.id, now=now - timedelta(days=3))
    overdue = circulation.checkout(db, lib["patron2"], j1, branch_id=east.id, now=now - timedelta(days=60)).loan
    overdue.due_at = now - timedelta(days=4)
    db.add(LedgerEntry(patron_id=lib["patron"].id, kind=LedgerKind.overdue, amount=2500, created_at=now - timedelta(days=2)))
    expired = db.get(Patron, lib["patron2"].id)
    expired.expires_on = analytics.local_today() - timedelta(days=10)
    db.commit()
    return {"b1": b1, "b2": b2, "main": main, "east": east, "overdue": overdue}


def test_catalogue_lists_groups_descriptions_and_period_kind(client, staff):
    r = client.get("/api/v1/reports", headers=staff).json()
    keys = {x["key"]: x for x in r["results"]}
    assert {"overdues", "weeding", "top_titles", "fines", "expired_patrons", "new_patrons"} <= set(keys)
    assert r["groups"] == ["circulation", "collection", "patrons", "finance"]
    assert keys["top_titles"]["dated"] is True and keys["overdues"]["dated"] is False
    assert all(x["group"] in r["groups"] and x["description"] and x["name"] for x in r["results"])


def test_report_output_has_typed_columns_refs_and_keeps_legacy_shape(client, staff, activity):
    d = client.get("/api/v1/reports/run/overdues", headers=staff).json()
    assert d["name"] == "Overdue loans" and d["headers"][0] == "Barcode"  # legacy keys unchanged
    assert [c["type"] for c in d["columns"]] == ["code", "text", "text", "code", "date", "number"]
    assert d["columns"][1]["link"] == "biblio" and d["columns"][2]["link"] == "patron"
    assert len(d["rows"]) == len(d["refs"]) == 1
    assert d["refs"][0]["biblio"] == activity["b2"].id and d["rows"][0][-1] >= 4
    assert d["dated"] is False and d["period"] is None and d["key"] == "overdues"


def test_branch_and_date_parameters(client, staff, activity, lib):
    main, east = activity["main"].id, activity["east"].id
    assert len(client.get("/api/v1/reports/run/overdues", headers=staff, params={"branch_id": main}).json()["rows"]) == 0
    assert len(client.get("/api/v1/reports/run/overdues", headers=staff, params={"branch_id": east}).json()["rows"]) == 1
    today = analytics.local_today()
    week = client.get("/api/v1/reports/run/top_titles", headers=staff,
                      params={"start": (today - timedelta(days=6)).isoformat(), "end": today.isoformat()}).json()
    assert [r[0] for r in week["rows"]] == ["Alpha Rising"] and week["refs"][0]["biblio"] == activity["b1"].id
    assert week["period"]["days"] == 7
    legacy = client.get("/api/v1/reports/run/top_titles", headers=staff, params={"days": 90}).json()
    assert {r[0] for r in legacy["rows"]} == {"Alpha Rising", "Beta Waves"}
    by_branch = client.get("/api/v1/reports/run/circulation_by_branch", headers=staff, params={"days": 90}).json()
    assert {r["branch"] for r in by_branch["refs"]} == {main, east}
    assert client.get("/api/v1/reports/run/overdues", headers=staff, params={"branch_id": 999}).status_code == 422
    assert client.get("/api/v1/reports/run/top_titles", headers=staff,
                      params={"start": today.isoformat(), "end": (today - timedelta(days=3)).isoformat()}).status_code == 422


def test_patron_reports(client, staff, activity, lib):
    exp = client.get("/api/v1/reports/run/expired_patrons", headers=staff).json()
    assert [r[1] for r in exp["rows"]] == ["reader2"] and exp["refs"][0]["patron"] == lib["patron2"].id
    new = client.get("/api/v1/reports/run/new_patrons", headers=staff, params={"days": 30}).json()
    assert {r[1] for r in new["rows"]} == {"reader1", "reader2"}  # staff accounts are not members
    assert new["columns"][-1]["type"] == "date"


def test_csv_is_localised_and_humanised(client, staff, admin, activity):
    r = client.get("/api/v1/reports/run/collection_by_type", headers=admin, params={"fmt": "csv"})
    assert r.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(r.text.lstrip("﻿"))))
    assert rows[0] == ["Item type", "Status", "Items"]
    assert {row[1] for row in rows[1:]} <= {"Available", "On loan", "On hold shelf", "In transit", "Lost", "Damaged", "Withdrawn", "Processing"}
    hi = client.get("/api/v1/reports/run/collection_by_type", headers=admin, params={"fmt": "csv", "lang": "hi"}).text
    assert hi.startswith("﻿") and "Item type" not in hi.splitlines()[0]
    assert "librowise-collection_by_type-" in r.headers["content-disposition"]
    # analytics CSV keeps English headers by default and translates them on request
    a = client.get("/api/v1/analytics/branches", headers=staff, params={"fmt": "csv"})
    assert a.text.splitlines()[0].startswith("Branch,Checkouts")
    a_hi = client.get("/api/v1/analytics/branches", headers=staff, params={"fmt": "csv", "lang": "hi"}).text
    assert a_hi.startswith("﻿") and not a_hi.lstrip("﻿").startswith("Branch,")


def test_kpis_endpoint(client, staff, activity):
    k = client.get("/api/v1/reports/kpis", headers=staff).json()
    assert k["overdue"]["value"] == 1 and k["open_loans"]["value"] == 2 and k["expired_patrons"]["value"] == 1
    assert k["fines_outstanding"]["value"] == 25.0 and k["checkouts"]["value"] == 1 and len(k["checkouts"]["spark"]) == 30
    east = client.get("/api/v1/reports/kpis", headers=staff, params={"branch_id": activity["east"].id}).json()
    assert east["overdue"]["value"] == 1 and east["open_loans"]["value"] == 1 and east["checkouts"]["value"] == 0
    assert "kpis" in client.get("/api/v1/reports/dashboard", headers=staff).json()
    assert client.get("/api/v1/reports/kpis", headers=staff, params={"branch_id": 999}).status_code == 422


def test_ai_insight_rows_are_enriched_and_filterable(client, staff, activity):
    risk = client.get("/api/v1/reports/insights/risk", headers=staff).json()["results"]
    assert risk and all({"biblio_id", "item_id", "branch_id"} <= set(r) for r in risk)
    east = client.get("/api/v1/reports/insights/risk", headers=staff, params={"branch_id": activity["east"].id}).json()["results"]
    assert all(r["branch_id"] == activity["east"].id for r in east)
    dups = client.get("/api/v1/reports/insights/duplicates", headers=staff).json()["results"]
    assert all(d["reason_code"] in ("isbn", "similar") for d in dups)
    weed = client.get("/api/v1/reports/insights/weeding", headers=staff, params={"branch_id": activity["main"].id}).json()["results"]
    assert all("biblio_id" in w and w["branch_id"] == activity["main"].id for w in weed)


def test_patron_category_ids_for_drill_down(client, staff, activity):
    d = client.get("/api/v1/analytics/patrons", headers=staff).json()
    assert d["by_category"] and all(isinstance(c["id"], int) for c in d["by_category"])


@pytest.mark.parametrize("path,page", [("/staff/reports", "staff-reports"), ("/staff/analytics", "staff-analytics"),
                                       ("/staff/insights", "staff-insights")])
def test_pages_render_toolbar_kpis_and_translations(client, lib, path, page):
    login(client, "librarian")
    r = client.get(f"{path}?range=90d&branch=1")
    assert r.status_code == 200 and f'data-page="{page}"' in r.text
    html = r.text
    assert 'id="ins-toolbar"' in html and 'id="ins-kpis"' in html and "admin-insights.css" in html
    assert 'id="ins-branch"' in html and '<option value="1" selected>' in html
    if page != "staff-insights":
        assert 'data-value="90d" aria-checked="true"' in html  # server-rendered state: no flash of the default
    assert "insights." not in html.split("<main", 1)[1].split("</main>", 1)[0].replace('href="/staff/insights', "")  # no raw keys
    hi = client.get(f"{path}?lang=hi").text
    assert "Snapshot" not in hi.split("<main", 1)[1]


def test_reports_page_keeps_hash_deep_links(client, lib):
    login(client, "librarian")
    html = client.get("/staff/reports").text
    for key in ("overdues", "weeding", "top_titles", "circulation_by_branch", "fines"):
        assert f'href="#{key}"' in html
