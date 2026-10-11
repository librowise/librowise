"""First-launch setup wizard: unclaimed-server protection (setup code), the one-shot /setup/complete,
admin-mode setup for installer-created instances, and that existing databases are left alone."""

from __future__ import annotations

import pytest
from conftest import login
from sqlalchemy import func, select

from librowise.models import Biblio, Branch, CirculationRule, ItemType, Patron, PatronCategory, Role, Setting
from librowise.services import settings as settings_svc
from librowise.services import setup

STRONG = "Lantern#Shelves42"


@pytest.fixture(autouse=True)
def _fresh_setup_limiter():
    from librowise.api.setup import setup_limiter

    setup_limiter.reset()
    yield
    setup_limiter.reset()


def _code(db) -> str:
    code = setup.ensure_code(db)
    db.commit()
    return code


def _payload(code: str | None, **over) -> dict:
    body = {
        "setup_code": code,
        "library": {"name": "Riverside College Library", "kind": "academic"},
        "admin": {"first_name": "Meera", "last_name": "Rao", "username": "meera", "email": "meera@riverside.example",
                  "password": STRONG},
        "branches": [{"code": "MAIN", "name": "Main Campus"}, {"code": "SCI", "name": "Science Block", "email": "sci@riverside.example"}],
        "loans": {"loan_days": 28, "max_renewals": 3, "max_loans": 8, "hold_pickup_days": 5, "fine_per_day": 100, "fine_cap": 5000},
        "start": "empty",
    }
    body.update(over)
    return body


def test_unclaimed_server_sends_everyone_to_setup(client):
    for path in ("/", "/login", "/staff", "/staff/circulation"):
        r = client.get(path, follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/setup", path
    page = client.get("/setup")
    assert page.status_code == 200 and 'data-mode="bootstrap"' in page.text
    assert page.headers["cache-control"] == "no-store"
    state = client.get("/api/v1/setup/state").json()
    assert state["status"] == "bootstrap" and state["code_required"] and state["needs_admin"]
    assert {p["key"] for p in state["presets"]} == {"public", "academic", "school", "special"}


def test_setup_code_is_stable_formatted_and_retired(db):
    code = _code(db)
    assert setup.CODE_RE.match(code) and setup.ensure_code(db) == code  # same code for every worker / restart
    assert setup.check_code(db, setup.format_code(code).lower()) and setup.check_code(db, f" {code[:4]} {code[4:]} ")
    assert not setup.check_code(db, "AAAA-BBBB") and not setup.check_code(db, "")
    raw = db.get(Setting, setup.CODE_KEY).value["sealed"]
    assert code not in raw  # sealed at rest
    rotated = setup.ensure_code(db, rotate=True)
    assert rotated != code and not setup.check_code(db, code)


def test_wrong_codes_are_refused_and_rate_limited(client, db):
    from librowise.api.setup import SETUP_ATTEMPTS, setup_limiter

    code = _code(db)
    codes = [client.post("/api/v1/setup/verify", json={"code": "AAAA-BBBB"}).status_code for _ in range(SETUP_ATTEMPTS + 1)]
    assert codes[:-1] == [403] * SETUP_ATTEMPTS and codes[-1] == 429
    assert client.post("/api/v1/setup/verify", json={"code": code}).status_code == 429  # even the right code waits
    setup_limiter.reset()
    r = client.post("/api/v1/setup/complete", json=_payload("AAAA-BBBB"))
    assert r.status_code == 403 and not setup.has_admin(db)


def test_bootstrap_creates_everything_and_signs_the_administrator_in(client, db):
    code = _code(db)
    assert client.post("/api/v1/setup/verify", json={"code": code}).json() == {"ok": True}
    r = client.post("/api/v1/setup/complete", json=_payload(code))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["signed_in"] and out["redirect"] == "/staff" and out["summary"]["branches"] == 2
    me = client.get("/api/v1/auth/me").json()  # the session cookie from setup works
    assert me["card_number"] == "meera" and me["role"] == "admin"

    db.expire_all()
    admin = db.scalar(select(Patron).where(Patron.card_number == "meera"))
    assert admin.role == Role.admin and admin.email == "meera@riverside.example" and admin.home_branch.code == "MAIN"
    assert settings_svc.get(db, "library_name") == "Riverside College Library"
    assert settings_svc.get(db, "self_registration_category") == "STUDENT"
    assert {b.code for b in db.scalars(select(Branch))} == {"MAIN", "SCI"}
    assert {"BOOK", "REF", "THESIS"} <= {t.code for t in db.scalars(select(ItemType))}
    cats = {c.code: c for c in db.scalars(select(PatronCategory))}
    assert {"STUDENT", "FACULTY", "STAFF"} <= set(cats) and cats["STUDENT"].max_loans == 8
    default = db.scalar(select(CirculationRule).where(CirculationRule.branch_id.is_(None), CirculationRule.category_id.is_(None),
                                                      CirculationRule.item_type_id.is_(None)))
    assert (default.loan_days, default.max_renewals, default.fine_per_day, default.hold_pickup_days) == (28, 3, 100, 5)
    faculty = db.scalar(select(CirculationRule).where(CirculationRule.category_id == cats["FACULTY"].id))
    assert faculty.loan_days == 60 and faculty.fine_per_day == 0
    assert setup.status(db) == "completed" and db.get(Setting, setup.CODE_KEY) is None

    # The server is claimed: the setup code no longer works and the wizard is for administrators only.
    client.cookies.clear()
    assert client.post("/api/v1/setup/verify", json={"code": code}).status_code == 409
    assert client.post("/api/v1/setup/complete", json=_payload(code)).status_code == 401
    assert client.get("/api/v1/setup/state").json() == {"status": "configured", "allowed": False}
    assert client.get("/setup", follow_redirects=False).headers["location"] == "/login?next=/setup"
    assert client.get("/", follow_redirects=False).status_code == 200


def test_validation_problems_name_the_field_and_write_nothing(client, db):
    code = _code(db)
    weak = _payload(code, admin={**_payload(code)["admin"], "password": "short"})
    r = client.post("/api/v1/setup/complete", json=weak)
    assert r.status_code == 422 and r.json()["field"] == "admin.password"
    personal = _payload(code, admin={**_payload(code)["admin"], "password": "Meera#2026xyz"})
    assert client.post("/api/v1/setup/complete", json=personal).json()["code"] == "personal"
    dup = _payload(code, branches=[{"code": "MAIN", "name": "A"}, {"code": "main", "name": "B"}])
    r = client.post("/api/v1/setup/complete", json=dup)
    assert r.status_code == 422 and r.json()["field"] == "branches.1.code"
    for field, body in [("library.name", _payload(code, library={"name": "  ", "kind": "public"})),
                        ("library.kind", _payload(code, library={"name": "X", "kind": "zoo"})),
                        ("branches", _payload(code, branches=[])),
                        ("loans.loan_days", _payload(code, loans={"loan_days": 0})),
                        ("start", _payload(code, start="nonsense"))]:
        r = client.post("/api/v1/setup/complete", json=body)
        assert r.status_code == 422 and r.json()["field"] == field, (field, r.text)
    db.expire_all()
    assert not setup.has_admin(db) and db.scalar(select(func.count()).select_from(Branch)) == 0
    assert settings_svc.get(db, "library_name") == ""


def test_sample_catalogue_is_searchable_and_offered_only_once(client, db):
    code = _code(db)
    r = client.post("/api/v1/setup/complete", json=_payload(code, start="sample"))
    assert r.status_code == 200 and r.json()["summary"]["sample_records"] > 50
    assert client.get("/api/v1/search", params={"q": "pride prejudice"}).json()["total"] >= 1
    assert db.scalar(select(Patron.id).where(Patron.card_number == "1000000001")) is None  # no demo accounts
    csrf = {"X-CSRF-Token": client.cookies.get("sw_csrf")}  # now signed in by cookie
    existing = client.get("/api/v1/setup/state").json()["snapshot"]["branches"]  # the wizard re-sends their ids
    again = client.post("/api/v1/setup/complete", json=_payload(None, start="sample", admin=None, branches=existing), headers=csrf)
    assert again.status_code == 422 and again.json()["code"] == "not_empty"


def test_import_start_sends_the_administrator_to_marc_import(client, db):
    r = client.post("/api/v1/setup/complete", json=_payload(_code(db), start="import"))
    assert r.json()["redirect"] == "/staff/admin#maintenance"


def test_installer_created_instance_runs_setup_after_sign_in(client, db):
    from librowise.instances.bootstrap import bootstrap_admin, set_library_name

    set_library_name("Hilltop Public Library")
    out = bootstrap_admin("admin", "admin@hilltop.example")
    db.expire_all()
    assert setup.status(db) == "pending"
    h = login(client, "admin", out["password"])
    assert client.get("/staff", follow_redirects=False).headers["location"] == "/setup"
    assert client.get("/staff/circulation", follow_redirects=False).status_code == 200  # only the dashboard redirects
    state = client.get("/api/v1/setup/state", headers=h).json()
    assert state["allowed"] and not state["needs_admin"] and state["snapshot"]["library_name"] == "Hilltop Public Library"
    placeholder = state["snapshot"]["branches"][0]
    kinds = {i["kind"] for i in client.get("/api/v1/ui/notifications", headers=h).json()["items"]}
    assert "setup_pending" in kinds and "library_name_unset" not in kinds

    body = _payload(None, admin=None, library={"name": "Hilltop Public Library", "kind": "public"},
                    branches=[{"id": placeholder["id"], "code": "MAIN", "name": "Hilltop Central"}])
    r = client.post("/api/v1/setup/complete", json=body, headers=h)
    assert r.status_code == 200 and not r.json()["signed_in"]
    db.expire_all()
    assert [b.name for b in db.scalars(select(Branch))] == ["Hilltop Central"]  # renamed, not duplicated
    assert setup.status(db) == "completed"
    assert client.get("/staff", follow_redirects=False).status_code == 200


def test_skip_stops_the_redirect_but_keeps_the_reminder(client, db):
    from librowise.instances.bootstrap import bootstrap_admin

    out = bootstrap_admin("admin", "admin@hilltop.example")
    h = login(client, "admin", out["password"])
    assert client.post("/api/v1/setup/skip", headers=h).json()["redirect"] == "/staff"
    db.expire_all()
    assert setup.status(db) == "skipped"
    assert client.get("/staff", follow_redirects=False).status_code == 200
    kinds = {i["kind"] for i in client.get("/api/v1/ui/notifications", headers=h).json()["items"]}
    assert "setup_pending" in kinds


def test_existing_libraries_are_never_sent_to_setup(client, lib, db):
    assert setup.status(db) == "none"
    admin = login(client, "admin")
    assert client.get("/staff", headers=admin, follow_redirects=False).status_code == 200
    staff = login(client, "librarian")
    assert client.post("/api/v1/setup/skip", headers=staff).status_code == 403
    assert client.post("/api/v1/setup/complete", json=_payload(None, admin=None), headers=staff).status_code == 403
    assert client.get("/api/v1/setup/state", headers=staff).json()["allowed"] is False
    client.cookies.clear()
    login(client, "librarian")
    assert client.get("/setup", follow_redirects=False).headers["location"] == "/staff"


def test_setup_code_cli(engine, capsys):
    from librowise.__main__ import main

    assert main(["setup-code"]) == 0
    first = capsys.readouterr().out
    assert "Setup code:" in first
    assert main(["setup-code"]) == 0 and capsys.readouterr().out == first
    assert main(["setup-code", "--new"]) == 0 and capsys.readouterr().out != first


def test_sample_catalogue_spreads_copies_over_branches(db, lib):
    branches = list(lib["branches"].values())
    n = setup.load_sample_catalogue(db, branches, lib["itypes"])
    db.commit()
    assert n == db.scalar(select(func.count()).select_from(Biblio))
    from librowise.models import Item

    assert {i.branch_id for i in db.scalars(select(Item))} == {b.id for b in branches}
