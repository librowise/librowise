"""Administration pages redesign: additive API fields/params (settings metadata, rules matrix, audit
filters and facets, copy-cataloguing connection test), server-rendered page shells and i18n coverage of
the keys the page modules compute at runtime."""

from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path

import httpx
import pytest
from conftest import login

from librowise import i18n
from librowise.interop import copycat
from librowise.permissions import CATALOGUE
from librowise.services import settings as settings_svc

ROOT = Path(__file__).resolve().parent.parent / "librowise"
JS = ROOT / "static" / "js" / "pages"


# ------------------------------------------------------------------ settings metadata


def test_settings_include_presentation_metadata(client, admin, lib):
    r = client.get("/api/v1/admin/settings", headers=admin).json()
    assert r["sections"] == ["profile", "policies", "notices", "integrations"]
    by_key = {s["key"]: s for s in r["results"]}
    # backward compatible: the original fields are still there
    for s in r["results"]:
        assert {"key", "value", "default", "description"} <= set(s)
        assert s["section"] in r["sections"] and s["type"] in {"bool", "int", "float", "str", "text", "select"}
        assert s["label"] and s["group"]
    assert by_key["library_name"]["section"] == "profile" and by_key["library_name"]["required"] is True
    assert by_key["anonymize_history_after_days"]["unit"] == "days" and by_key["anonymize_history_after_days"]["min"] == 0
    assert by_key["self_registration_category"]["type"] == "select"
    assert by_key["notice_max_attempts"]["section"] == "notices"
    assert by_key["ai_assistant_enabled"]["section"] == "integrations"
    env = r["environment"]
    assert {"email_backend", "sms_backend", "ai_enabled"} <= set(env)
    assert not any("password" in k or "token" in k for k in env), "environment facts must never include secrets"


def test_unknown_module_settings_fall_back_to_defaults(monkeypatch):
    monkeypatch.setitem(settings_svc.DEFAULTS, "some_future_flag", (True, "A future module's switch"))
    meta = settings_svc.describe("some_future_flag")
    assert meta["section"] == "policies" and meta["group"] == "other" and meta["type"] == "bool"
    assert meta["label"] == "Some future flag"


# ------------------------------------------------------------------ circulation rules matrix


def test_rules_matrix_matches_explain(client, admin, lib):
    branch = lib["branches"]["MAIN"].id
    m = client.get("/api/v1/admin/rules/matrix", headers=admin, params={"branch_id": branch}).json()
    cats, types = m["categories"], m["item_types"]
    assert len(m["cells"]) == (len(cats) + 1) * (len(types) + 1)
    rules = client.get("/api/v1/admin/rules", headers=admin).json()["results"]
    for cell in m["cells"]:
        if cell["category_id"] is None or cell["item_type_id"] is None:
            continue
        ex = client.get("/api/v1/admin/rules/explain", headers=admin, params={
            "branch_id": branch, "category_id": cell["category_id"], "item_type_id": cell["item_type_id"]}).json()
        assert ex["effective"] == cell["effective"]
        exact = [r["id"] for r in rules if r["branch_id"] == branch and r["category_id"] == cell["category_id"]
                 and r["item_type_id"] == cell["item_type_id"]]
        assert cell["explicit_rule_id"] == (exact[0] if exact else None)
    # library-wide matrix: the (Any, Any) cell is the base rule
    base = client.get("/api/v1/admin/rules/matrix", headers=admin).json()
    assert base["branch_id"] is None
    any_any = next(c for c in base["cells"] if c["category_id"] is None and c["item_type_id"] is None)
    assert any_any["explicit_rule_id"] == any_any["effective"]["source_rule_id"]
    assert client.get("/api/v1/admin/rules/matrix", headers=admin, params={"branch_id": 99999}).status_code == 404


# ------------------------------------------------------------------ audit log filters


def test_audit_filters_and_facets(client, admin, lib):
    client.put("/api/v1/admin/settings/library_name", headers=admin, json={"value": "Filter Test Library"})
    full = client.get("/api/v1/admin/audit", headers=admin).json()
    assert full["per_page"] == 50 and full["page"] == 1  # defaults unchanged
    mine = client.get("/api/v1/admin/audit", headers=admin, params={"actor": "admin", "action": "setting"}).json()
    assert mine["total"] >= 1 and all(e["action"] == "setting" and e["actor"] for e in mine["results"])
    assert all("actor_id" in e for e in mine["results"])
    nobody = client.get("/api/v1/admin/audit", headers=admin, params={"actor": "zz-no-such-person"}).json()
    assert nobody["total"] == 0
    today = date.today()
    in_range = client.get("/api/v1/admin/audit", headers=admin, params={
        "date_from": (today - timedelta(days=1)).isoformat(), "date_to": (today + timedelta(days=1)).isoformat()}).json()
    assert in_range["total"] >= mine["total"]
    future = client.get("/api/v1/admin/audit", headers=admin, params={"date_from": (today + timedelta(days=3)).isoformat()}).json()
    assert future["total"] == 0
    paged = client.get("/api/v1/admin/audit", headers=admin, params={"per_page": 1}).json()
    assert len(paged["results"]) <= 1 and paged["per_page"] == 1
    facets = client.get("/api/v1/admin/audit/facets", headers=admin).json()
    assert "setting" in facets["actions"] and "settings" in facets["entities"]
    assert client.get("/api/v1/admin/audit/facets", headers=login(client, "reader1")).status_code == 403


# ------------------------------------------------------------------ copy-cataloguing connection test

SRU_OK = (b'<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><version>1.1</version>'
          b"<numberOfRecords>42</numberOfRecords><records/></searchRetrieveResponse>")


@pytest.fixture()
def fake_remote(monkeypatch):
    state = {"handler": lambda req: httpx.Response(200, content=SRU_OK)}
    real = copycat._fetch

    def fetch(url, timeout, client=None):
        return real(url, timeout, httpx.Client(transport=httpx.MockTransport(lambda req: state["handler"](req))))

    monkeypatch.setattr(copycat, "_fetch", fetch)
    return state


def test_copycat_target_connection_test(client, admin, staff, lib, fake_remote):
    r = client.post("/api/v1/copycat/targets/0/test", headers=admin)  # built-in Library of Congress target
    assert r.status_code == 200 and r.json()["ok"] is True and r.json()["total"] == 42
    fake_remote["handler"] = lambda req: httpx.Response(503)
    bad = client.post("/api/v1/copycat/targets/0/test", headers=admin).json()
    assert bad["ok"] is False and "503" in bad["message"]
    assert client.post("/api/v1/copycat/targets/12345/test", headers=admin).status_code == 404
    assert client.post("/api/v1/copycat/targets/0/test", headers=staff).status_code == 403


# ------------------------------------------------------------------ page shells


def test_settings_page_shell(client, lib):
    login(client, "admin")
    html = client.get("/staff/admin").text
    assert 'id="as-nav"' in html and 'id="as-panel"' in html and 'class="page-header"' in html
    for section in ("profile", "branches", "item-types", "categories", "rules", "policies", "notices",
                    "integrations", "audit", "maintenance"):
        assert f'href="#{section}"' in html
    js = (JS / "staff-admin.js").read_text(encoding="utf-8")
    assert 'settings: "profile"' in js and 'system: "maintenance"' in js  # legacy hashes keep working
    assert "setupTabs" not in js


def test_settings_page_denied_for_librarians(client, lib):
    login(client, "librarian")
    html = client.get("/staff/admin").text
    assert 'id="as-panel"' not in html and "as-denied" in html


def test_roles_system_interop_shells(client, lib):
    login(client, "admin")
    roles = client.get("/staff/roles").text
    for tab in ("roles", "staff", "user", "sso"):
        assert f'data-tab="{tab}"' in roles
    assert 'role="tablist"' in roles and 'id="roles-panel"' in roles
    system = client.get("/staff/system").text
    assert system.count("sys-kpi") >= 4 and 'id="sys-jobs"' in system
    assert "style=" not in (ROOT / "templates" / "staff" / "system.html").read_text(encoding="utf-8")  # no inline styles
    interop = client.get("/staff/interop").text
    assert 'data-can-manage="true"' in interop and "as-readonly" not in interop
    login(client, "librarian")
    ro = client.get("/staff/interop").text
    assert 'data-can-manage="false"' in ro and "as-readonly" in ro
    for name in ("staff-roles.js", "staff-system.js", "staff-interop.js"):
        assert "setupTabs" not in (JS / name).read_text(encoding="utf-8")


# ------------------------------------------------------------------ i18n of computed keys


def _keys(lang: str) -> dict:
    return i18n.catalog(lang)


@pytest.mark.parametrize("lang", ["en", "hi", "ur"])
def test_runtime_computed_keys_exist(lang):
    cat = _keys(lang)
    for key in settings_svc.DEFAULTS:
        assert f"admin.settings.field.{key}.label" in cat, key
        assert f"admin.settings.field.{key}.help" in cat, key
    for code, group, _ in CATALOGUE:
        assert f"admin.roles.perm.{re.sub(r'[^a-z0-9]+', '_', code.lower())}" in cat, code
        assert f"admin.roles.group.{re.sub(r'[^a-z]+', '_', group.lower())}" in cat, group
    js = (JS / "staff-admin.js").read_text(encoding="utf-8")
    for const, prefix in (("AUDIT_ACTIONS", "admin.audit.action."), ("AUDIT_ENTITIES", "admin.audit.entity."),
                          ("DETAIL_KEYS", "admin.audit.key.")):
        values = json.loads("[" + re.search(rf"const {const} = \[(.*?)\];", js, re.S).group(1) + "]")
        for v in values:
            assert prefix + v.replace("-", "_") in cat, prefix + v
