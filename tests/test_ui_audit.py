"""The UI audit tool (scripts/ui_audit.py) and the small accessibility fixes it surfaced."""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

from conftest import login

ROOT = Path(__file__).resolve().parents[1]


def _audit_module():
    spec = importlib.util.spec_from_file_location("ui_audit", ROOT / "scripts" / "ui_audit.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("ui_audit", module)  # dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)  # playwright is imported lazily, so this works without it
    return module


def test_audit_page_table_covers_every_html_route():
    audit = _audit_module()
    routes = audit.web_routes()
    assert "/staff/catalog/{biblio_id}/marc" in routes
    covered = {audit.page_route(p) for p in audit.PAGES}
    missing = [r for r in routes if r not in covered and r not in audit.NON_PAGE_ROUTES]
    assert not missing, f"add these routes to PAGES in scripts/ui_audit.py: {missing}"
    ids = [p.id for p in audit.PAGES]
    assert len(ids) == len(set(ids)), "page ids must be unique (they name the screenshots)"
    assert {p.family for p in audit.PAGES} <= {"OPAC", "Front desk", "Collection", "People", "Insights", "Admin"}


def test_audit_report_renders_without_results():
    audit = _audit_module()
    summary = {"generated_at": "now", "base_url": "http://x", "browser": "chromium", "axe_version": "4", "axe_tags": [],
               "totals": {"pages": 0}, "failures": [], "axe_rules": [], "uncovered_routes": [], "escalated_to_admin": {},
               "pages_meta": []}
    out = audit.render_html(summary, [])
    assert out.startswith("<!doctype html>") and "Shelfwise UI audit" in out


def test_staff_shell_accessibility(client, lib):
    login(client, "librarian")
    page = client.get("/staff").text
    # The closed copilot drawer must not be reachable by keyboard while aria-hidden (axe aria-hidden-focus).
    drawer = re.search(r'<aside class="drawer" id="copilot"[^>]*>', page).group(0)
    assert "inert" in drawer and 'aria-hidden="true"' in drawer
    # Visible text must be part of the accessible name (axe label-content-name-mismatch).
    trigger = re.search(r'<button[^>]*class="search-trigger"[^>]*>', page).group(0)
    assert "aria-label" not in trigger and 'aria-keyshortcuts="Control+K"' in trigger
    # The user-menu trigger is named by its visible first name plus screen-reader text, not aria-label.
    user = re.search(r'<button[^>]*class="user-trigger"[^>]*>(.*?)</button>', page, re.S)
    assert "aria-label" not in user.group(0).split(">")[0] and 'class="sr-only"' in user.group(1)


def test_demo_accounts_hidden_outside_development(client, monkeypatch):
    from shelfwise import web

    monkeypatch.setattr(web, "_show_demo_logins", lambda: False)
    assert 'id="demo-accounts"' not in client.get("/login").text
    monkeypatch.setattr(web, "_show_demo_logins", lambda: True)
    assert 'id="demo-accounts"' in client.get("/login").text
