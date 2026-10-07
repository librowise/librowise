"""Experience pages render; PWA manifest, service worker and security headers."""

from __future__ import annotations

import re

from conftest import login


def test_new_pages_render(client, lib, make_book):
    b, _ = make_book("Render Me")
    assert client.get("/offline").status_code == 200
    assert client.get("/kiosk").status_code == 200
    login(client, "librarian")
    for path, page in [("/staff/analytics", "staff-analytics"), ("/staff/kiosks", "staff-kiosks"), ("/staff", "staff-dashboard"),
                       (f"/record/{b.id}", "opac-record"), ("/search?q=render", "opac-search"), ("/account", "opac-account")]:
        r = client.get(path)
        assert r.status_code == 200, path
        assert f'data-page="{page}"' in r.text
    client.cookies.clear()
    assert client.get("/staff/analytics", follow_redirects=False).status_code == 303


def test_page_modules_exist(client):
    for page in ["staff-analytics", "staff-kiosks", "kiosk", "offline"]:
        r = client.get(f"/static/js/pages/{page}.js")
        assert r.status_code == 200 and re.search(r"export default (async )?function", r.text), page
    for module in ["charts", "i18n", "suggest", "record-extras", "a11y", "pwa", "sw"]:
        assert client.get(f"/static/js/{module}.js").status_code == 200, module


def test_manifest(client, lib):
    r = client.get("/manifest.webmanifest", headers={"Accept-Language": "hi"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/manifest+json")
    m = r.json()
    assert m["start_url"].startswith("/") and m["scope"] == "/" and m["display"] == "standalone"
    assert m["name"] == "Shelfwise Public Library" and len(m["short_name"]) <= 12
    assert {i["purpose"] for i in m["icons"]} == {"any", "maskable"}
    assert all(i["type"] == "image/svg+xml" and client.get(i["src"]).status_code == 200 for i in m["icons"])
    assert m["lang"] == "hi" and m["shortcuts"][0]["name"] == "सूची में खोजें"


def test_service_worker_route(client):
    r = client.get("/sw.js")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/javascript")
    assert r.headers["service-worker-allowed"] == "/"
    assert "no-cache" in r.headers["cache-control"]
    assert "__BUILD__" not in r.text and "__VERSION__" not in r.text
    build = re.search(r'const BUILD = "([0-9a-f]{12})"', r.text).group(1)
    assert client.get("/sw.js").text.count(build) == 1  # stable between requests
    # every precached URL exists
    for url in re.findall(r'^\s+"(/[^"]*)",?$', r.text, re.M):
        assert client.get(url).status_code == 200, url


def test_security_headers_and_pwa_wiring(client, lib):
    r = client.get("/")
    csp = r.headers["content-security-policy"]
    assert "worker-src 'self'" in csp and "manifest-src 'self'" in csp and "script-src 'self';" in csp
    assert '<link rel="manifest" href="/manifest.webmanifest">' in r.text
    assert '<script type="module" src="/static/js/pwa.js">' in r.text
    assert "private" not in r.headers.get("cache-control", "")  # anonymous pages may be cached offline
    assert re.search(r"<script(?![^>]*\bsrc=)(?![^>]*application/json)[^>]*>", r.text) is None  # no inline scripts
    login(client, "reader1")
    assert client.get("/").headers["cache-control"] == "private, no-store"  # personalised pages never are


def test_a11y_landmarks_on_opac_pages(client, lib, make_book):
    b, _ = make_book("Landmarks")
    for path in ["/", "/search?q=landmarks", f"/record/{b.id}", "/login", "/offline"]:
        html = client.get(path).text
        assert 'class="skip-link" href="#main"' in html, path
        assert '<main id="main"' in html and "<header" in html and "<footer" in html, path
        assert '<nav aria-label=' in html, path
    search = client.get("/search?q=x").text
    assert '<h1 class="sr-only"' in search and 'role="search"' in search and 'aria-live="polite"' in search
