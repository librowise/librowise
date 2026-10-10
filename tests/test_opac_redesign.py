"""OPAC redesign: home discover data, the public library-info endpoint, shell markup and page contracts."""

from __future__ import annotations

from datetime import timedelta

from conftest import login

from librowise.models import utcnow


def test_home_includes_discover_facets(client, lib, make_book):
    make_book("Dune", authors=["Herbert, Frank"], subjects=["Science fiction"], material_type="book")
    make_book("Foundation", authors=["Asimov, Isaac"], subjects=["Science fiction"], material_type="book")
    make_book("Akira", authors=["Otomo, Katsuhiro"], subjects=["Manga"], material_type="comic")
    r = client.get("/api/v1/opac/home")
    assert r.status_code == 200
    body = r.json()
    assert "shelves" in body  # backwards compatible
    d = body["discover"]
    assert d["total"] == 3
    assert ["Science fiction", 2] in d["subjects"]
    assert {a for a, _ in d["authors"]} >= {"Herbert, Frank", "Asimov, Isaac"}
    assert dict(map(tuple, d["formats"])) == {"book": 2, "comic": 1}


def test_library_info_reports_branches_and_opening_days(client, admin, lib):
    branch = lib["branches"]["MAIN"]
    today = utcnow().date()
    closed = today + timedelta(days=3)
    r = client.post("/api/v1/calendar/closures", headers=admin,
                    json={"branch_id": branch.id, "day": closed.isoformat(), "description": "Staff training"})
    assert r.status_code == 201, r.text
    weekday = (today + timedelta(days=1)).weekday()
    assert client.put(f"/api/v1/calendar/{branch.id}/weekdays", headers=admin, json={"closed_weekdays": [weekday]}).status_code == 200

    r = client.get("/api/v1/opac/library")  # public: no authentication
    assert r.status_code == 200
    data = r.json()
    assert data["library_name"]
    main = next(b for b in data["branches"] if b["id"] == branch.id)
    assert len(main["week"]) == 7 and main["week"][0]["date"] == today.isoformat()
    assert main["week"][1]["open"] is False  # weekly closed day
    assert main["closed_weekdays"] == [weekday]
    assert {"date": closed.isoformat(), "reason": "Staff training"} in main["closures"]
    assert all(c["date"] != (today + timedelta(days=1)).isoformat() for c in main["closures"])  # weekly days are not "closures"
    assert set(main) >= {"name", "address", "phone", "email", "open_today", "next_open"}


def test_opac_shell_has_phone_menu_account_menu_and_footer(client, lib):
    html = client.get("/").text
    assert 'aria-controls="opac-menu"' in html and 'id="opac-menu"' in html and "data-opac-menu" in html
    assert '/static/css/pages/opac.css' in html and '<script type="module" src="/static/js/opac-shell.js">' in html
    assert 'class="oh-search"' not in html  # the home page has its own search box
    assert 'class="site opac-footer"' in html and 'href="/register"' in html
    login(client, "reader1")
    html = client.get("/").text
    assert 'aria-haspopup="menu"' in html and 'id="oh-account-menu"' in html and "data-logout" in html
    record = client.get("/browse").text
    assert 'class="oh-search"' in record and 'href="/account#holds"' in record


def test_record_page_keeps_seo_and_server_renders_title(client, lib, make_book):
    b, _ = make_book("Cinematic Title")
    html = client.get(f"/record/{b.id}").text
    assert 'application/ld+json' in html and 'rel="canonical"' in html
    assert '<h1 class="rec-title">Cinematic Title</h1>' in html
    missing = client.get("/record/987654")
    assert missing.status_code == 404 and "<h1>" in missing.text and 'role="search"' in missing.text


def test_opac_pages_are_translated(client, lib):
    for path in ("/login", "/register", "/reset-password", "/browse", "/courses"):
        hi = client.get(f"{path}?lang=hi").text
        ur = client.get(f"{path}?lang=ur").text
        assert 'lang="hi"' in hi and 'dir="rtl"' in ur, path
    assert "पासवर्ड भूल गए?" in client.get("/login?lang=hi").text
    assert "حروفِ تہجی کی فہرست" in client.get("/browse?lang=ur").text
    assert "अपना पहला नाम" not in client.get("/register?lang=hi").text  # errors are rendered by JS only
    assert "पहला नाम" in client.get("/register?lang=hi").text


def test_browse_index_links_reflect_url_state(client, lib):
    html = client.get("/browse?index=subjects&start=B").text
    assert 'id="tab-subjects" href="/browse?index=subjects" aria-current="page"' in html
    assert 'href="/browse?index=subjects&amp;start=B" aria-current="true"' in html
    assert 'name="index" value="subjects"' in html
