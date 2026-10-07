"""Fine-grained permissions, custom staff roles and enforcement on guarded endpoints."""

from __future__ import annotations

import pytest
from conftest import login
from identity_utils import reset_identity_state

from shelfwise.models import Patron, Role, StaffRole
from shelfwise.permissions import BUILTIN_ROLE_PERMISSIONS, CATALOGUE, PERMISSION_CODES
from shelfwise.security import ROLE_PERMISSIONS, effective_permissions, has_permission


@pytest.fixture(autouse=True)
def _fresh():
    reset_identity_state()


NEW_PERMS = {"circulation:override", "fines:waive", "fines:charge", "patrons:delete", "patrons:manage_staff",
             "catalog:delete", "reports:export", "settings:manage", "audit:read", "sip:manage", "notices:manage",
             "serials:manage", "courses:manage", "authorities:manage", "acquisitions:write", "jobs:manage"}
LEGACY_LIBRARIAN = {"opac", "catalog:read", "catalog:write", "circulation", "patrons:read", "patrons:write",
                    "holds:manage", "acquisitions:read", "acquisitions:write", "reports:read", "ai:staff"}


def test_catalogue_contains_existing_and_new_permissions():
    assert NEW_PERMS | LEGACY_LIBRARIAN | {"admin"} <= PERMISSION_CODES
    assert all(group and desc for _, group, desc in CATALOGUE)
    assert ROLE_PERMISSIONS is BUILTIN_ROLE_PERMISSIONS
    assert LEGACY_LIBRARIAN <= ROLE_PERMISSIONS[Role.librarian]  # existing behaviour preserved
    assert not {"settings:manage", "audit:read", "patrons:manage_staff", "admin"} & ROLE_PERMISSIONS[Role.librarian]
    assert ROLE_PERMISSIONS[Role.admin] == {"*"}


def test_me_reports_effective_permissions(client, lib, staff, admin):
    me = client.get("/api/v1/auth/me", headers=staff).json()
    assert "circulation:override" in me["permissions"] and "settings:manage" not in me["permissions"]
    assert client.get("/api/v1/auth/me", headers=admin).json()["permissions"] == ["*"]


@pytest.fixture()
def desk(client, lib, db):
    """A patron-role account given a narrow custom 'desk' role (no overrides, waivers, deletes, exports)."""
    role = StaffRole(name="Desk", permissions=["catalog:read", "catalog:write", "circulation", "patrons:read",
                                                "patrons:write", "holds:manage", "reports:read"])
    db.add(role)
    db.flush()
    p = lib["make_user"]("desk1", Role.patron, "STAFF")
    p.staff_role_id = role.id
    db.commit()
    return login(client, "desk1")


def test_custom_role_grants_union(client, lib, desk, db):
    p = db.query(Patron).filter_by(card_number="desk1").one()
    assert p.is_staff
    perms = effective_permissions(p)
    assert {"opac", "circulation", "patrons:read"} <= perms and "fines:waive" not in perms
    assert has_permission(p, "circulation") and not has_permission(p, "circulation:override")
    assert client.get("/api/v1/patrons", headers=desk).status_code == 200
    assert client.post("/api/v1/circulation/checkin", json={"barcode": "nope"}, headers=desk).status_code == 404
    assert client.get("/staff/circulation", headers=desk, follow_redirects=False).status_code == 200


def test_new_permissions_enforced(client, lib, desk, staff, admin, make_book, db):
    from shelfwise.services import circulation

    b, (item,) = make_book("Guarded", copies=1)
    pid = lib["patron2"].id
    circulation.charge(db, db.get(Patron, pid), 100, lib["admin"], "x")
    db.commit()
    card = lib["patron"].card_number
    checks = [
        ("POST", "/api/v1/circulation/checkout", {"patron_card": card, "barcode": item.barcode, "override": True}),
        ("POST", "/api/v1/holds", {"patron_card": card, "biblio_id": b.id, "pickup_branch_id": lib["branches"]["MAIN"].id, "override": True}),
        ("POST", f"/api/v1/patrons/{pid}/waive", {"amount": 50}),
        ("POST", f"/api/v1/patrons/{pid}/charge", {"amount": 50}),
        ("DELETE", f"/api/v1/patrons/{lib['patron'].id}", None),
        ("DELETE", f"/api/v1/biblios/{b.id}", None),
        ("DELETE", f"/api/v1/items/{item.id}", None),
        ("GET", "/api/v1/reports/run/overdues?fmt=csv", None),
        ("GET", "/api/v1/admin/settings", None),
        ("PUT", "/api/v1/admin/settings/library_name", {"value": "X"}),
        ("GET", "/api/v1/admin/audit", None),
        ("POST", "/api/v1/admin/jobs/nightly", None),
        ("GET", "/api/v1/admin/roles", None),
    ]
    for method, path, body in checks:
        r = client.request(method, path, headers=desk, json=body)
        assert r.status_code == 403, (path, r.status_code, r.text)
        assert "permission" in r.json()["detail"].lower() or "Missing" in r.json()["detail"]
    # the same desk user can still do the non-privileged variant
    assert client.get("/api/v1/reports/run/overdues", headers=desk).status_code == 200
    r = client.post("/api/v1/circulation/checkout", headers=desk, json={"patron_card": card, "barcode": item.barcode})
    assert r.status_code == 200, r.text
    loan_id = r.json()["loan"]["id"]
    assert client.post(f"/api/v1/loans/{loan_id}/renew", headers=desk, json={"override": True}).status_code == 403
    # librarians keep their previous abilities (default set preserved) …
    assert client.post(f"/api/v1/loans/{loan_id}/renew", headers=staff, json={"override": True}).status_code == 200
    assert client.post(f"/api/v1/patrons/{pid}/waive", headers=staff, json={"amount": 50}).status_code == 200
    assert client.get("/api/v1/reports/run/overdues?fmt=csv", headers=staff).status_code == 200
    # … but not the administrator-only ones
    for path in ["/api/v1/admin/settings", "/api/v1/admin/audit", "/api/v1/admin/roles", "/api/v1/admin/sso/providers"]:
        assert client.get(path, headers=staff).status_code == 403, path
    assert client.get("/api/v1/admin/audit", headers=admin).status_code == 200


def test_role_crud_and_validation(client, lib, admin, db):
    r = client.post("/api/v1/admin/roles", headers=admin, json={"name": "Cataloguer", "permissions": ["catalog:read", "catalog:write"]})
    assert r.status_code == 201
    rid = r.json()["id"]
    assert client.post("/api/v1/admin/roles", headers=admin, json={"name": "Cataloguer"}).status_code == 409
    assert client.post("/api/v1/admin/roles", headers=admin, json={"name": "Bad", "permissions": ["root"]}).status_code == 422
    assert client.post("/api/v1/admin/roles", headers=admin, json={"name": "Star", "permissions": ["*"]}).status_code == 422
    r = client.put(f"/api/v1/admin/roles/{rid}", headers=admin, json={"name": "Cataloguer", "permissions": ["catalog:read"]})
    assert r.json()["permissions"] == ["catalog:read"]
    pid = lib["patron"].id
    a = client.put(f"/api/v1/admin/users/{pid}/staff-role", headers=admin, json={"staff_role_id": rid}).json()
    assert a["is_staff"] and a["staff_role"]["name"] == "Cataloguer"
    assert {"code": "catalog:read", "sources": ["custom:Cataloguer"]} in a["effective_permissions"]
    assert {"code": "opac", "sources": ["role:patron"]} in a["effective_permissions"]
    roles = client.get("/api/v1/admin/roles", headers=admin).json()["results"]
    assert roles[0]["members"] == 1
    assert any(s["id"] == pid for s in client.get("/api/v1/admin/staff", headers=admin).json()["results"])
    assert client.delete(f"/api/v1/admin/roles/{rid}", headers=admin).json()["unassigned"] == 1
    db.expire_all()
    assert db.get(Patron, pid).staff_role_id is None
    cat = client.get("/api/v1/admin/permissions", headers=admin).json()
    assert cat["builtin_roles"]["admin"] == ["*"] and any(g["group"] == "Circulation" for g in cat["groups"])


def test_delegated_manager_cannot_escalate(client, lib, admin, db):
    mgr_role = client.post("/api/v1/admin/roles", headers=admin, json={
        "name": "Staff manager", "permissions": ["patrons:manage_staff"]}).json()
    client.put(f"/api/v1/admin/users/{lib['librarian'].id}/staff-role", headers=admin, json={"staff_role_id": mgr_role["id"]})
    mgr = login(client, "librarian")
    # may create roles only from permissions they hold
    assert client.post("/api/v1/admin/roles", headers=mgr, json={"name": "Sneaky", "permissions": ["settings:manage"]}).status_code == 403
    ok = client.post("/api/v1/admin/roles", headers=mgr, json={"name": "Desk", "permissions": ["circulation"]})
    assert ok.status_code == 201
    # cannot widen an existing role beyond their own permissions, nor touch the admin account
    assert client.put(f"/api/v1/admin/roles/{ok.json()['id']}", headers=mgr,
                      json={"name": "Desk", "permissions": ["circulation", "audit:read"]}).status_code == 403
    assert client.put(f"/api/v1/admin/users/{lib['admin'].id}/staff-role", headers=mgr, json={"staff_role_id": None}).status_code == 403
    assert client.patch(f"/api/v1/patrons/{lib['admin'].id}", headers=mgr, json={"first_name": "Mallory"}).status_code == 403
    # promoting to admin needs "*"; promoting to librarian is fine for a manager who holds the librarian set
    r = client.patch(f"/api/v1/patrons/{lib['patron'].id}", headers=mgr, json={"role": "admin"})
    assert r.status_code == 403
    assert client.patch(f"/api/v1/patrons/{lib['patron'].id}", headers=mgr, json={"role": "librarian"}).status_code == 200


def test_plain_librarian_cannot_manage_custom_role_staff(client, lib, admin, staff, db):
    """An account with a custom role is a staff account: ordinary librarians cannot edit, reset or erase it."""
    role = client.post("/api/v1/admin/roles", headers=admin, json={"name": "Auditor", "permissions": ["audit:read"]}).json()
    pid = lib["patron"].id
    client.put(f"/api/v1/admin/users/{pid}/staff-role", headers=admin, json={"staff_role_id": role["id"]})
    assert client.patch(f"/api/v1/patrons/{pid}", headers=staff, json={"password": "Takeover#2026!"}).status_code == 403
    assert client.post(f"/api/v1/admin/users/{pid}/mfa/reset", headers=staff).status_code == 403
    assert client.delete(f"/api/v1/patrons/{pid}", headers=staff).status_code == 403
    assert client.get(f"/api/v1/admin/users/{pid}/access", headers=staff).status_code == 403
    assert client.get(f"/api/v1/admin/users/{lib['patron2'].id}/access", headers=staff).status_code == 200
    # the auditor can now read the audit log
    assert client.get("/api/v1/admin/audit", headers=login(client, "reader1")).status_code == 200


def test_removing_custom_role_revokes_sessions(client, lib, admin):
    role = client.post("/api/v1/admin/roles", headers=admin, json={"name": "Auditor", "permissions": ["audit:read"]}).json()
    pid = lib["patron"].id
    client.put(f"/api/v1/admin/users/{pid}/staff-role", headers=admin, json={"staff_role_id": role["id"]})
    h = login(client, "reader1")
    client.put(f"/api/v1/admin/users/{pid}/staff-role", headers=admin, json={"staff_role_id": None})
    assert client.get("/api/v1/auth/me", headers=h).status_code == 401


def test_erasure_removes_credentials(client, lib, admin, db):
    h = login(client, "reader2")
    client.post("/api/v1/auth/tokens", headers=h, json={"name": "x", "scopes": ["opac"]})
    assert client.delete(f"/api/v1/patrons/{lib['patron2'].id}", headers=admin).status_code == 204
    assert client.get("/api/v1/auth/me", headers=h).status_code == 401


def test_identity_pages_render(client, lib):
    for path in ["/login", "/reset-password"]:
        assert client.get(path).status_code == 200
    login(client, "admin")  # cookies
    for path in ["/staff/roles", "/staff/security", "/account"]:
        r = client.get(path)
        assert r.status_code == 200, path
    assert 'href="/staff/roles"' in client.get("/staff").text
    client.cookies.clear()
    login(client, "librarian")
    assert 'href="/staff/roles"' not in client.get("/staff").text  # nav hidden without patrons:manage_staff
    client.cookies.clear()
    login(client, "reader1")
    r = client.get("/staff/security", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/account#settings"


def test_identity_static_modules_exist(client):
    for name in ["pages/staff-roles.js", "pages/staff-security.js", "pages/reset-password.js", "security-panel.js"]:
        assert client.get(f"/static/js/{name}").status_code == 200
