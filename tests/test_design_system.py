"""Design system: navigation hubs, staff shell, notification feed, patron list API, style guide, tokens."""

from __future__ import annotations

import importlib.util
import re
from datetime import timedelta
from pathlib import Path

from conftest import login

from librowise import web
from librowise.models import Hold, HoldStatus, Job, Patron, Role, utcnow

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "librowise" / "static"


# ------------------------------------------------------------------ navigation registry


def test_hub_registry_is_complete_and_small():
    assert len(web.HUBS) <= web.MAX_HUBS
    claimed = [key for hub in web.HUBS for key in hub.tabs]
    assert len(claimed) == len(set(claimed)), "a page belongs to exactly one hub"
    keys = {key for key, *_ in web.STAFF_NAV}
    assert set(claimed) == keys, f"unclaimed pages: {keys - set(claimed)}; unknown tabs: {set(claimed) - keys}"
    assert not [h for h in web._all_hubs() if h.id == "more"]  # nothing falls into "More" today
    for page, (tab, label) in web.PAGE_TABS.items():
        assert tab in keys and label, page
    assert all(key in web.NAV_PERMISSIONS for key in keys), "every page declares its permission"


def test_orphan_pages_land_in_more_hub(monkeypatch):
    monkeypatch.setattr(web, "STAFF_NAV", [*web.STAFF_NAV, ("newthing", "/staff/newthing", "New thing", "list")])
    hubs = web._all_hubs()
    assert hubs[-1].id == "more" and hubs[-1].tabs == ("newthing",)
    assert len(hubs) <= web.MAX_HUBS


def test_hubs_are_permission_aware(db, lib):
    librarian = staff_hubs = web.staff_hubs(lib["librarian"])
    ids = [h["id"] for h in staff_hubs]
    assert ids[0] == "home" and [h["index"] for h in staff_hubs] == list(range(1, len(ids) + 1))
    tabs = {t["key"] for h in librarian for t in h["tabs"]}
    assert {"circulation", "catalog", "patrons", "reports"} <= tabs
    assert not {"roles", "system", "admin"} & tabs  # admin-only pages are hidden
    admin_tabs = {t["key"] for h in web.staff_hubs(lib["admin"]) for t in h["tabs"]}
    assert {"roles", "system", "admin"} <= admin_tabs
    assert web.staff_hubs(lib["patron"]) == [] and web.staff_hubs(None) == []
    # a hub links to its first visible tab
    admin_hub = next(h for h in web.staff_hubs(lib["admin"]) if h["id"] == "administration")
    assert admin_hub["href"] == "/staff/admin"


def test_shell_breadcrumbs_and_current_tab(db, lib):
    s = web.staff_shell(lib["librarian"], "staff-record")
    assert s["hub"]["id"] == "catalogue" and s["tab"]["key"] == "catalog" and s["detail"] == "Record"
    assert [c["label"] for c in s["crumbs"]] == ["Catalogue", "Records"]
    s = web.staff_shell(lib["librarian"], "staff-patrons")  # tab label == hub label → no duplicate crumb
    assert [c["label"] for c in s["crumbs"]] == ["Patrons"] and s["detail"] is None
    assert web.staff_shell(lib["librarian"], "staff-styleguide")["hub"] is None


def test_staff_shell_renders_hubs_tabs_and_crumbs(client, lib, make_book):
    b, _ = make_book("Shell Test")
    login(client, "librarian")
    html = client.get(f"/staff/catalog/{b.id}").text
    assert html.count('class="hub-link"') == len(web.staff_hubs(lib["librarian"]))
    assert 'data-hub-index="1"' in html and "Alt 1" in html
    assert re.search(r'<nav class="hub-tabs"[^>]*>.*?href="/staff/catalog" aria-current="location"', html, re.S)
    assert '<nav class="crumbs"' in html and 'id="crumb"' in html
    assert 'href="/staff/roles"' not in html  # permission-aware
    assert "data-notifications" in html and "data-menu-trigger" in html and 'href="/staff/security"' in html
    assert "Libro<span>wise</span>" in html  # product wordmark
    # every legacy URL still renders inside the shell
    for key, href, *_ in web.STAFF_NAV:
        if key in {"roles", "system", "admin"}:
            continue
        r = client.get(href)
        assert r.status_code == 200 and 'class="shell"' in r.text, href


def test_styleguide_page(client, lib):
    assert client.get("/staff/styleguide", follow_redirects=False).status_code == 303
    login(client, "librarian")
    r = client.get("/staff/styleguide")
    assert r.status_code == 200 and 'data-page="staff-styleguide"' in r.text
    for section in ("brand", "colour", "table", "forms", "overlays", "covers"):
        assert f'id="sg-{section}"' in r.text
    assert client.get("/static/js/pages/staff-styleguide.js").status_code == 200


def test_admin_home_has_system_health(client, lib):
    login(client, "admin")
    assert 'id="sys-health"' in client.get("/staff").text
    client.cookies.clear()
    login(client, "librarian")
    assert 'id="sys-health"' not in client.get("/staff").text


# ------------------------------------------------------------------ notification centre


def test_notifications_feed_is_permission_filtered(client, db, lib, make_book):
    b, items = make_book("Waiting Title")
    db.add(Hold(biblio_id=b.id, patron_id=lib["patron"].id, pickup_branch_id=lib["branches"]["MAIN"].id,
                status=HoldStatus.ready, item_id=items[0].id, ready_at=utcnow(), expires_at=utcnow() + timedelta(days=1)))
    db.add(Job(type="nightly", status="dead", finished_at=utcnow(), last_error="boom"))
    db.commit()
    staff = login(client, "librarian")
    r = client.get("/api/v1/ui/notifications", headers=staff)
    assert r.status_code == 200
    kinds = {i["kind"]: i for i in r.json()["items"]}
    assert kinds["holds_ready"]["params"] == {"count": 1, "expiring": 1} and kinds["holds_ready"]["href"] == "/staff/holds"
    assert "jobs_failed" not in kinds  # administrators only
    admin = login(client, "admin")
    items = client.get("/api/v1/ui/notifications", headers=admin).json()["items"]
    assert items[0]["tone"] == "danger" and any(i["kind"] == "jobs_failed" for i in items)
    assert all({"id", "kind", "tone", "title", "href"} <= set(i) for i in items)
    reader = login(client, "reader1")
    assert client.get("/api/v1/ui/notifications", headers=reader).status_code == 403


# ------------------------------------------------------------------ patrons list (reference page API)


def test_patron_list_filters_and_sort(client, db, lib):
    lib["patron2"].expires_on = utcnow().date() - timedelta(days=3)
    lib["patron"].expires_on = utcnow().date() + timedelta(days=10)
    db.commit()
    staff = login(client, "librarian")
    get = lambda **q: client.get("/api/v1/patrons", params=q, headers=staff).json()  # noqa: E731
    assert {p["card_number"] for p in get(status="expired")["results"]} == {"reader2"}
    assert {p["card_number"] for p in get(status="expiring")["results"]} == {"reader1"}
    assert {p["role"] for p in get(role="staff")["results"]} == {"librarian", "admin"}
    cards = [p["card_number"] for p in get(sort="-card")["results"]]
    assert cards == sorted(cards, reverse=True)
    assert get(branch_id=lib["branches"]["MAIN"].id)["total"] >= 4
    assert client.get("/api/v1/patrons", params={"sort": "evil"}, headers=staff).status_code == 422


def test_bulk_renew_memberships(client, db, lib):
    staff = login(client, "librarian")
    reader, admin = lib["patron2"], lib["admin"]
    reader.expires_on = utcnow().date() - timedelta(days=30)
    db.commit()
    r = client.post("/api/v1/patrons/renew", json={"ids": [reader.id, admin.id]}, headers=staff)
    assert r.status_code == 200
    body = r.json()
    assert [x["id"] for x in body["renewed"]] == [reader.id]
    assert body["skipped"] == [{"id": admin.id, "reason": "staff account"}]  # librarians cannot manage admins
    db.expire_all()
    assert db.get(Patron, reader.id).expires_on > utcnow().date() + timedelta(days=300)
    reader_headers = login(client, "reader1")
    assert client.post("/api/v1/patrons/renew", json={"ids": [reader.id]}, headers=reader_headers).status_code == 403


# ------------------------------------------------------------------ assets, tokens, modules


def _contrast_module():
    spec = importlib.util.spec_from_file_location("check_contrast", ROOT / "scripts" / "check_contrast.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_token_contrast_meets_wcag_aa_in_every_theme():
    mod = _contrast_module()
    failures = mod.check()
    assert failures == [], "\n".join(failures)
    assert set(mod.theme_tokens()) >= {"light", "dark", "sepia", "contrast"}


def test_contrast_checker_catches_regressions():
    mod = _contrast_module()
    css = mod.TOKENS.read_text(encoding="utf-8").replace("--muted: #586274;", "--muted: #b0b6c0;", 1)
    failures = mod.check(css=css)
    assert any("--muted on --surface" in f and f.startswith("light") for f in failures)
    drift = mod.TOKENS.read_text(encoding="utf-8").replace("--text: #e8edf4;", "--text: #ffffff;", 1)  # only one dark block
    assert any("differs between" in f for f in mod.check(css=drift))


def test_font_brand_and_ui_modules_are_served(client):
    assert client.get("/static/fonts/inter/InterVariable.woff2").content[:4] == b"wOF2"
    assert "SIL Open Font License" in (STATIC / "fonts" / "inter" / "LICENSE.txt").read_text(encoding="utf-8")
    assert "font-src 'self'" in client.get("/").headers["content-security-policy"]
    for asset in ("css/tokens.css", "css/ui.css", "brand/librowise-mark.svg", "brand/librowise-seal.svg", "brand/librowise-logo-light.png",
                  "brand/librowise-logo-dark.png", "brand/librowise-maskable.svg"):
        assert client.get(f"/static/{asset}").status_code == 200, asset
    index = (STATIC / "js" / "ui" / "index.js").read_text(encoding="utf-8")
    for module in re.findall(r'from "/static/js/ui/([\w-]+)\.js"', index):
        r = client.get(f"/static/js/ui/{module}.js")
        assert r.status_code == 200 and "export " in r.text, module
    for name in ("dataTable", "pageHeader", "statusPill", "enhanceForm", "sidePanel", "combobox", "dateRange", "emptyState"):
        assert re.search(rf"\b{name}\b", index), name
    html = client.get("/").text
    for sheet in ("tokens.css", "app.css", "ui.css"):
        assert f"/static/css/{sheet}" in html
    assert html.index("tokens.css") < html.index("app.css") < html.index("ui.css")


def test_patron_role_enum_is_unchanged():
    # The staff filter maps to these roles; guard against silent enum changes.
    assert {r.value for r in Role} == {"patron", "librarian", "admin"}
