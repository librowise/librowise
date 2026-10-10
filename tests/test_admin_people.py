"""Staff People pages: API additions used by the redesigned patron, requests, notices and security pages."""

from datetime import timedelta

from conftest import login

from librowise.models import Patron, Role, utcnow
from librowise.services import circulation, notices, registration

# ------------------------------------------------------------------ patrons list: status=overdue


def _checkout(db, lib, patron, item, *, days_ago=0, loan_days=None):
    now = utcnow() - timedelta(days=days_ago)
    due = now + timedelta(days=loan_days) if loan_days is not None else None
    res = circulation.checkout(db, patron, item, branch_id=item.branch_id, actor=lib["librarian"], now=now, due_at=due,
                               override=True)
    db.commit()
    return res.loan


def test_list_patrons_status_overdue(client, staff, lib, db, make_book):
    _, items = make_book("Late One", copies=3)
    _checkout(db, lib, lib["patron"], items[0], days_ago=30, loan_days=14)  # 16 days overdue
    _checkout(db, lib, lib["patron2"], items[1])  # current, not overdue
    r = client.get("/api/v1/patrons?status=overdue", headers=staff)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [p["card_number"] for p in body["results"]] == ["reader1"] and body["total"] == 1
    assert body["results"][0]["overdue_loans"] == 1 and body["results"][0]["open_loans"] == 1
    # Every result in the unfiltered list reports overdue_loans (additive field).
    rows = client.get("/api/v1/patrons", headers=staff).json()["results"]
    assert all("overdue_loans" in p for p in rows)
    assert {p["card_number"]: p["overdue_loans"] for p in rows}["reader2"] == 0


def test_list_patrons_status_deep_links_from_insights(client, staff, lib, db):
    today = utcnow().date()
    lib["patron2"].expires_on = today - timedelta(days=3)
    circulation.charge(db, lib["patron"], 1500, lib["admin"], "Printing")
    db.commit()
    expired = client.get("/api/v1/patrons?status=expired", headers=staff).json()["results"]
    owing = client.get("/api/v1/patrons?status=owing", headers=staff).json()["results"]
    assert [p["card_number"] for p in expired] == ["reader2"]
    assert [p["card_number"] for p in owing] == ["reader1"]
    assert client.get("/api/v1/patrons?status=bogus", headers=staff).status_code == 422


def test_patrons_list_page_accepts_status_query(client, lib):
    login(client, "librarian")  # sets the session cookie for page views
    for status in ("overdue", "owing", "expired"):
        assert client.get(f"/staff/patrons?status={status}").status_code == 200


# ------------------------------------------------------------------ patron detail: structured blocks + limits


def test_patron_detail_reports_block_reasons_and_limits(client, staff, lib, db):
    p = lib["patron"]
    p.expires_on = utcnow().date() - timedelta(days=1)
    circulation.charge(db, p, p.category.block_fine_threshold + 100, lib["admin"], "Damage")
    db.commit()
    d = client.get(f"/api/v1/patrons/{p.id}", headers=staff).json()
    codes = [b["code"] for b in d["block_reasons"]]
    assert codes == ["expired", "fines"]
    assert d["block_reasons"][1]["amount"] > d["block_reasons"][1]["limit"] > 0
    assert len(d["blocks"]) == 2  # the legacy English reasons stay
    assert d["limits"]["max_loans"] == p.category.max_loans and d["limits"]["max_holds"] == p.category.max_holds
    assert d["is_staff"] is False and d["staff_role"] is None
    staff_d = client.get(f"/api/v1/patrons/{lib['librarian'].id}", headers=staff).json()
    assert staff_d["is_staff"] is True and staff_d["block_reasons"] == []


# ------------------------------------------------------------------ patron activity (audit trail)


def test_patron_activity_lists_humanisable_events(client, staff, lib, db, make_book):
    biblio, items = make_book("The Activity Book", copies=1)
    p = lib["patron"]
    loan = _checkout(db, lib, p, items[0])
    circulation.renew(db, loan, actor=lib["librarian"], override=True)
    circulation.checkin(db, items[0], branch_id=items[0].branch_id, actor=lib["librarian"])
    circulation.charge(db, p, 700, lib["librarian"], "Lost card")
    db.commit()
    client.patch(f"/api/v1/patrons/{p.id}", headers=staff, json={"phone": "+91 90000 00000"})
    r = client.get(f"/api/v1/patrons/{p.id}/activity", headers=staff)
    assert r.status_code == 200, r.text
    body = r.json()
    actions = [e["action"] for e in body["results"]]
    assert {"checkout", "renew", "checkin", "charge", "update"} <= set(actions)
    assert body["total"] == len(body["results"])
    # newest first
    ats = [e["at"] for e in body["results"]]
    assert ats == sorted(ats, reverse=True)
    by = {e["action"]: e for e in body["results"]}
    assert by["checkout"]["subject"]["title"] == "The Activity Book" and by["checkout"]["subject"]["biblio_id"] == biblio.id
    assert by["checkin"]["subject"]["barcode"] == items[0].barcode
    assert by["charge"]["details"]["amount"] == 7.0  # minor units → money
    assert by["update"]["details"]["fields"] == ["phone"]
    assert by["update"]["actor"]["full_name"] == lib["librarian"].full_name
    # nothing sensitive leaks into details
    assert all("ip" not in e and "username" not in e["details"] for e in body["results"])


def test_patron_activity_excludes_other_patrons_and_honours_history_opt_out(client, staff, lib, db, make_book):
    _, items = make_book("Shared Copy", copies=1)
    first = _checkout(db, lib, lib["patron2"], items[0])
    circulation.checkin(db, items[0], branch_id=items[0].branch_id, actor=lib["librarian"])
    db.commit()
    assert first.returned_at is not None
    mine = client.get(f"/api/v1/patrons/{lib['patron'].id}/activity", headers=staff).json()["results"]
    assert not any(e["action"] in ("checkout", "checkin") for e in mine)  # reader2's loan is not reader1's activity
    # reader2 opts out of reading history → events of returned loans disappear, account events stay
    lib["patron2"].keep_history = False
    db.commit()
    theirs = client.get(f"/api/v1/patrons/{lib['patron2'].id}/activity", headers=staff).json()["results"]
    assert not any(e["action"] in ("checkout", "checkin") for e in theirs)


def test_patron_activity_paging_and_permissions(client, staff, lib, db):
    p = lib["patron"]
    for i in range(5):
        circulation.charge(db, p, 100 + i, lib["librarian"], f"Charge {i}")
    db.commit()
    page1 = client.get(f"/api/v1/patrons/{p.id}/activity?per_page=2", headers=staff).json()
    page2 = client.get(f"/api/v1/patrons/{p.id}/activity?per_page=2&page=2", headers=staff).json()
    assert page1["total"] == page2["total"] >= 5 and len(page1["results"]) == 2
    assert {e["id"] for e in page1["results"]}.isdisjoint({e["id"] for e in page2["results"]})
    reader = login(client, "reader2")
    assert client.get(f"/api/v1/patrons/{p.id}/activity", headers=reader).status_code == 403
    assert client.get("/api/v1/patrons/999999/activity", headers=staff).status_code == 404


# ------------------------------------------------------------------ registrations: counts + duplicate details


def _pending(db, lib, first="Meera", last="Nair", phone=None):
    p = Patron(card_number=f"9{abs(hash((first, last))) % 10**9:09d}", first_name=first, last_name=last,
               email=f"{first.lower()}.{last.lower()}@example.org", phone=phone, role=Role.patron,
               category_id=lib["cats"]["ADULT"].id, home_branch_id=lib["branches"]["MAIN"].id, is_active=False,
               registration_status=registration.PENDING)
    db.add(p)
    db.commit()
    return p


def test_registrations_include_status_counts_and_duplicate_matches(client, staff, lib, db):
    lib["patron2"].phone = "+91 98888 77777"
    db.commit()
    _pending(db, lib, "Reader1", "Test")  # same name as the existing reader1
    _pending(db, lib, "Asha", "Rao", phone="+91 98888 77777")  # same phone as reader2
    _pending(db, lib, "Nobody", "Similar")
    r = client.get("/api/v1/registrations?status=pending", headers=staff).json()
    assert r["pending"] == 3 and r["counts"] == {"pending": 3, "approved": 0, "rejected": 0}
    rows = {x["full_name"]: x for x in r["results"]}
    assert [(d["card_number"], d["match"]) for d in rows["Reader1 Test"]["duplicates"]] == [("reader1", "name")]
    assert [(d["card_number"], d["match"]) for d in rows["Asha Rao"]["duplicates"]] == [("reader2", "phone")]
    assert rows["Nobody Similar"]["duplicates"] == []
    pid = rows["Nobody Similar"]["patron_id"]
    assert client.post(f"/api/v1/registrations/{pid}/reject", headers=staff, json={"reason": "Unverified"}).status_code == 200
    counts = client.get("/api/v1/registrations?status=all", headers=staff).json()["counts"]
    assert counts == {"pending": 2, "approved": 0, "rejected": 1}


# ------------------------------------------------------------------ notices: is_default


def test_notice_templates_report_whether_text_is_the_default(client, admin, lib, db):
    notices.ensure_default_templates(db)  # stored copies of the defaults (as the demo seed does)
    db.commit()
    rows = client.get("/api/v1/notices/templates", headers=admin).json()["results"]
    hold = next(x for x in rows if x["code"] == "HOLD_READY" and x["channel"] == "email")
    assert hold["customized"] is True and hold["is_default"] is True
    r = client.put("/api/v1/notices/templates/HOLD_READY/email", headers=admin,
                   json={"subject": "Ready!", "body": "Hi {{ patron.first_name }}", "is_active": True})
    assert r.status_code == 200 and r.json()["is_default"] is False
    r = client.delete("/api/v1/notices/templates/HOLD_READY/email", headers=admin)
    assert r.json()["is_default"] is True


def test_patron_notices_and_outbox_filter_by_card(client, staff, lib, db):
    notices.queue(db, lib["patron"], "WELCOME")
    notices.queue(db, lib["patron2"], "WELCOME")
    db.commit()
    mine = client.get(f"/api/v1/patrons/{lib['patron'].id}/notices", headers=staff).json()
    assert mine["total"] == 1 and mine["results"][0]["patron"]["card_number"] == "reader1"
    by_card = client.get("/api/v1/notices/outbox?patron_card=reader2", headers=staff).json()
    assert by_card["total"] == 1


# ------------------------------------------------------------------ pages render with the new strings


def test_people_pages_render_translated(client, lib):
    login(client, "librarian")
    for path, root in (("/staff/requests", "rq-page"), ("/staff/notices", "nt-page"), ("/staff/security", "sec-page"),
                       (f"/staff/patrons/{lib['patron'].id}", "pp-page"), ("/staff/patrons", "list-page")):
        r = client.get(path)
        assert r.status_code == 200, path
        assert root in r.text and "admin-people.css" in r.text, path
        assert ">people." not in r.text, path  # no untranslated key rendered as text
    en = client.get("/staff/security?lang=en").text
    # the role is shown once and translated (UI_AUDIT §5.1: "librarian · Librarian")
    assert "Librarian Test · Librarian ·" in en  # full name, then the translated role
    assert "· librarian ·" not in en
    hi = client.get("/staff/security?lang=hi").text
    assert "My account &amp; security" not in hi
    # the hi/ur catalogues translate every people.* key the pages use
    from librowise.i18n import catalog

    en_keys = {k for k in catalog("en") if k.startswith("people.")}
    for lang in ("hi", "ur"):
        assert en_keys <= set(catalog(lang)), lang
