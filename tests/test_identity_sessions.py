"""Server-side sessions, personal API tokens, lockout, sign-in history and password reset."""

from __future__ import annotations

import re
from datetime import timedelta

import pytest
from conftest import PASSWORD, login
from identity_utils import bearer, password_login, reset_identity_state
from sqlalchemy import select

from shelfwise.models import ApiToken, AuditLog, AuthToken, LoginEvent, Notification, Patron, UserSession, utcnow
from shelfwise.security import create_session_token


@pytest.fixture(autouse=True)
def _fresh():
    reset_identity_state()


def _token(client, username="reader1"):
    r = password_login(client, username)
    assert r.status_code == 200, r.text
    return r.json()["token"]


# ------------------------------------------------------------------ sessions


def test_login_creates_listed_session(client, lib, db):
    h = bearer(_token(client))
    sessions = client.get("/api/v1/auth/sessions", headers={**h, "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Firefox/130.0"}).json()["results"]
    assert len(sessions) == 1 and sessions[0]["current"] is True
    assert db.scalar(select(UserSession).where(UserSession.user_id == lib["patron"].id)).sid


def test_revoked_session_is_rejected(client, lib):
    a, b = bearer(_token(client)), bearer(_token(client))
    sessions = client.get("/api/v1/auth/sessions", headers=a).json()["results"]
    other = next(s for s in sessions if not s["current"])
    assert client.delete(f"/api/v1/auth/sessions/{other['id']}", headers=a).status_code == 200
    assert client.get("/api/v1/auth/me", headers=b).status_code == 401
    assert client.get("/api/v1/auth/me", headers=a).status_code == 200
    # cannot revoke someone else's session
    mine = client.get("/api/v1/auth/sessions", headers=a).json()["results"][0]["id"]
    assert client.delete(f"/api/v1/auth/sessions/{mine}", headers=bearer(_token(client, "reader2"))).status_code == 404


def test_sign_out_everywhere(client, lib):
    a, b, c = (bearer(_token(client)) for _ in range(3))
    r = client.post("/api/v1/auth/sessions/revoke-all", headers=a, json={})
    assert r.json()["revoked"] == 2
    assert client.get("/api/v1/auth/me", headers=a).status_code == 200
    assert client.get("/api/v1/auth/me", headers=b).status_code == 401
    assert client.get("/api/v1/auth/me", headers=c).status_code == 401
    client.post("/api/v1/auth/sessions/revoke-all", headers=a, json={"include_current": True})
    assert client.get("/api/v1/auth/me", headers=a).status_code == 401


def test_logout_revokes_server_session(client, lib):
    token = _token(client)
    assert client.post("/api/v1/auth/logout", headers=bearer(token)).status_code == 200
    assert client.get("/api/v1/auth/me", headers=bearer(token)).status_code == 401


def test_cookie_logout_revokes_session(client, lib):
    password_login(client, "reader1")
    stolen = client.cookies.get("sw_session")
    assert client.get("/api/v1/auth/me").status_code == 200
    client.post("/api/v1/auth/logout")
    assert client.get("/api/v1/auth/me", headers=bearer(stolen)).status_code == 401


def test_password_change_revokes_all_other_sessions(client, lib):
    a, b = _token(client), _token(client)
    r = client.post("/api/v1/auth/password", headers=bearer(a), json={"current_password": PASSWORD, "new_password": "N3w#Password!!"})
    assert r.status_code == 200
    assert client.get("/api/v1/auth/me", headers=bearer(a)).status_code == 401
    assert client.get("/api/v1/auth/me", headers=bearer(b)).status_code == 401
    assert client.get("/api/v1/auth/me", headers=bearer(r.json()["token"])).status_code == 200


def test_expired_and_idle_sessions_rejected(client, lib, admin, db):
    token = _token(client)
    s = db.scalars(select(UserSession).where(UserSession.user_id == lib["patron"].id)).one()
    s.expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    assert client.get("/api/v1/auth/me", headers=bearer(token)).status_code == 401
    assert client.put("/api/v1/admin/settings/session_idle_timeout_minutes", headers=admin, json={"value": 30}).status_code == 200
    token = _token(client)
    assert client.get("/api/v1/auth/me", headers=bearer(token)).status_code == 200
    s = db.scalars(select(UserSession).where(UserSession.user_id == lib["patron"].id, UserSession.revoked_at.is_(None))
                   .order_by(UserSession.id.desc())).first()
    db.refresh(s)
    s.last_seen_at = utcnow() - timedelta(minutes=31)
    db.commit()
    assert client.get("/api/v1/auth/me", headers=bearer(token)).status_code == 401


def test_session_activity_is_tracked_with_throttling(client, lib, db):
    token = _token(client)
    s = db.scalars(select(UserSession).where(UserSession.user_id == lib["patron"].id)).one()
    s.last_seen_at = utcnow() - timedelta(minutes=5)
    db.commit()
    client.get("/api/v1/auth/me", headers=bearer(token))
    db.refresh(s)
    assert (utcnow() - s.last_seen_at).total_seconds() < 30


def test_legacy_tokens_rejected_after_sign_out_everywhere(client, lib, db):
    legacy = create_session_token(db.get(Patron, lib["patron"].id))  # minted without a server-side session
    assert client.get("/api/v1/auth/me", headers=bearer(legacy)).status_code == 200
    client.post("/api/v1/auth/sessions/revoke-all", headers=bearer(_token(client)), json={})
    assert client.get("/api/v1/auth/me", headers=bearer(legacy)).status_code == 401


def test_admin_can_revoke_all_sessions_of_a_user(client, lib, admin, staff):
    t = _token(client)
    pid = lib["patron"].id
    assert client.post(f"/api/v1/admin/users/{pid}/sessions/revoke", headers=login(client, "reader2")).status_code == 403
    assert client.post(f"/api/v1/admin/users/{pid}/sessions/revoke", headers=staff).json()["revoked"] >= 1
    assert client.get("/api/v1/auth/me", headers=bearer(t)).status_code == 401
    # librarians cannot end an administrator's sessions
    assert client.post(f"/api/v1/admin/users/{lib['admin'].id}/sessions/revoke", headers=staff).status_code == 403
    assert client.post(f"/api/v1/admin/users/{lib['librarian'].id}/sessions/revoke", headers=admin).status_code == 200


# ------------------------------------------------------------------ personal API tokens


def _make_pat(client, h, scopes, **kw):
    r = client.post("/api/v1/auth/tokens", headers=h, json={"name": "integration", "scopes": scopes, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_api_token_scopes_enforced(client, lib, staff, db):
    pat = _make_pat(client, staff, ["catalog:read"])
    assert pat["token"].startswith("swt_")
    stored = db.get(ApiToken, pat["id"])
    assert stored.token_hash != pat["token"] and pat["token"] not in stored.token_hash  # only a hash is stored
    h = bearer(pat["token"])
    assert client.get("/api/v1/admin/branches", headers=h).status_code == 200  # catalog:read
    assert client.get("/api/v1/patrons", headers=h).status_code == 403  # librarian may, but the token may not
    assert client.get("/api/v1/auth/me", headers=h).json()["permissions"] == ["catalog:read"]
    assert client.get("/api/v1/opac/me/summary", headers=h).status_code == 403  # no "opac" scope


def test_admin_token_scopes_intersect_wildcard(client, lib, admin):
    h = bearer(_make_pat(client, admin, ["reports:read"])["token"])
    assert client.get("/api/v1/reports", headers=h).status_code == 200
    assert client.get("/api/v1/admin/settings", headers=h).status_code == 403
    assert client.get("/api/v1/admin/audit", headers=h).status_code == 403


def test_api_token_cannot_manage_credentials(client, lib):
    h = login(client, "reader1")
    pat = bearer(_make_pat(client, h, ["opac"])["token"])
    assert client.get("/api/v1/opac/me/summary", headers=pat).status_code == 200
    for method, path, body in [("GET", "/api/v1/auth/sessions", None), ("GET", "/api/v1/auth/tokens", None),
                               ("POST", "/api/v1/auth/tokens", {"name": "x", "scopes": ["opac"]}),
                               ("POST", "/api/v1/auth/password", {"current_password": PASSWORD, "new_password": "N3w#Password!!"}),
                               ("POST", "/api/v1/auth/mfa/setup", {"password": PASSWORD}),
                               ("POST", "/api/v1/auth/sessions/revoke-all", {})]:
        assert client.request(method, path, headers=pat, json=body).status_code == 403, path


def test_api_token_scope_must_be_held(client, lib):
    h = login(client, "reader1")
    r = client.post("/api/v1/auth/tokens", headers=h, json={"name": "x", "scopes": ["catalog:write"]})
    assert r.status_code == 422
    assert [s["code"] for s in client.get("/api/v1/auth/scopes", headers=h).json()["results"]] == ["opac"]


def test_api_token_revocation_and_expiry(client, lib, staff, db):
    pat = _make_pat(client, staff, ["catalog:read"], expires_days=1)
    h = bearer(pat["token"])
    assert client.get("/api/v1/admin/branches", headers=h).status_code == 200
    listed = client.get("/api/v1/auth/tokens", headers=staff).json()["results"]
    assert listed[0]["prefix"] == pat["token"][:12] and "token" not in listed[0]
    row = db.get(ApiToken, pat["id"])
    row.expires_at = utcnow() - timedelta(minutes=1)
    db.commit()
    assert client.get("/api/v1/admin/branches", headers=h).status_code == 401
    pat2 = _make_pat(client, staff, ["catalog:read"])
    assert client.delete(f"/api/v1/auth/tokens/{pat2['id']}", headers=staff).status_code == 200
    assert client.get("/api/v1/admin/branches", headers=bearer(pat2["token"])).status_code == 401
    # API tokens are never accepted from the session cookie
    client.cookies.clear()
    pat3 = _make_pat(client, staff, ["catalog:read"])
    client.cookies.set("sw_session", pat3["token"])
    assert client.get("/api/v1/admin/branches").status_code == 401


# ------------------------------------------------------------------ lockout & history


def test_lockout_after_repeated_failures(client, lib, db, admin):
    for _ in range(5):
        assert password_login(client, "reader1", "wrong-password").status_code == 401
    r = password_login(client, "reader1")
    assert r.status_code == 401 and r.json()["detail"] == "Invalid card number/email or password"
    p = db.get(Patron, lib["patron"].id)
    db.refresh(p)
    assert p.locked_until is not None
    assert db.scalar(select(Notification).where(Notification.patron_id == p.id, Notification.subject.like("%locked%")))
    assert db.scalar(select(AuditLog).where(AuditLog.action == "login_locked", AuditLog.entity_id == p.id))
    events = db.scalars(select(LoginEvent).where(LoginEvent.user_id == p.id)).all()
    assert [e.reason for e in events].count("bad_password") == 5 and events[-1].reason == "locked"
    # an administrator can unlock it
    access = client.post(f"/api/v1/admin/users/{p.id}/unlock", headers=admin).json()
    assert access["locked_until"] is None
    assert password_login(client, "reader1").status_code == 200


def test_lockout_expires(client, lib, db):
    for _ in range(5):
        password_login(client, "reader1", "wrong-password")
    p = db.get(Patron, lib["patron"].id)
    db.refresh(p)
    p.locked_until = utcnow() - timedelta(seconds=1)
    db.commit()
    assert password_login(client, "reader1").status_code == 200


def test_lockout_can_be_disabled(client, lib, admin):
    client.put("/api/v1/admin/settings/lockout_threshold", headers=admin, json={"value": 0})
    for _ in range(7):
        password_login(client, "reader1", "wrong-password")
    assert password_login(client, "reader1").status_code == 200


def test_login_history_visible_to_user(client, lib):
    password_login(client, "reader1", "wrong-password")
    h = bearer(_token(client))
    rows = client.get("/api/v1/auth/logins", headers=h).json()["results"]
    assert [r["success"] for r in rows[:2]] == [True, False]
    assert {"at", "ip", "user_agent", "method"} <= set(rows[0])
    # nobody else's history leaks in
    assert all(r["method"] for r in rows)
    assert client.get("/api/v1/auth/logins", headers=bearer(_token(client, "reader2"))).json()["results"][0]["success"]


def test_new_signin_notice(client, lib, admin, db):
    client.put("/api/v1/admin/settings/notify_new_signin", headers=admin, json={"value": True})
    client.post("/api/v1/auth/login", json={"username": "reader1", "password": PASSWORD}, headers={"User-Agent": "Agent-A"})
    client.post("/api/v1/auth/login", json={"username": "reader1", "password": PASSWORD}, headers={"User-Agent": "Agent-A"})
    assert not db.scalar(select(Notification).where(Notification.subject.like("New sign-in%")))
    client.post("/api/v1/auth/login", json={"username": "reader1", "password": PASSWORD}, headers={"User-Agent": "Agent-B"})
    assert db.scalar(select(Notification).where(Notification.subject.like("New sign-in%"),
                                                Notification.patron_id == lib["patron"].id))


def test_auth_events_are_audited(client, lib, db):
    password_login(client, "reader1", "bad")
    h = bearer(_token(client))
    client.post("/api/v1/auth/sessions/revoke-all", headers=h, json={})
    client.post("/api/v1/auth/logout", headers=h)
    actions = set(db.scalars(select(AuditLog.action)))
    assert {"login_failed", "login", "sessions_revoked_all", "logout"} <= actions


# ------------------------------------------------------------------ password reset


def _reset_token(db, patron_id) -> str:
    n = db.scalars(select(Notification).where(Notification.patron_id == patron_id, Notification.subject.like("Reset%"))
                   .order_by(Notification.id.desc())).first()
    return re.search(r"#token=(\S+)", n.body).group(1)


def test_password_reset_flow(client, lib, db):
    old = _token(client)
    known = client.post("/api/v1/auth/password-reset", json={"identifier": "reader1@example.org"})
    unknown = client.post("/api/v1/auth/password-reset", json={"identifier": "nobody@example.org"})
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()  # no account enumeration
    token = _reset_token(db, lib["patron"].id)
    assert client.post("/api/v1/auth/password-reset/confirm", json={"token": token, "new_password": "aaaaaaaaaa"}).status_code == 422
    r = client.post("/api/v1/auth/password-reset/confirm", json={"token": token, "new_password": "Brand#New2026!"})
    assert r.status_code == 200
    assert client.get("/api/v1/auth/me", headers=bearer(old)).status_code == 401  # sessions revoked
    assert password_login(client, "reader1", "Brand#New2026!").status_code == 200
    # single use
    again = client.post("/api/v1/auth/password-reset/confirm", json={"token": token, "new_password": "An0ther#Pass!"})
    assert again.status_code == 400


def test_password_reset_token_expiry_and_supersession(client, lib, db):
    client.post("/api/v1/auth/password-reset", json={"identifier": "reader1"})
    first = _reset_token(db, lib["patron"].id)
    client.post("/api/v1/auth/password-reset", json={"identifier": "reader1"})
    second = _reset_token(db, lib["patron"].id)
    assert first != second
    # only the newest link works
    assert client.post("/api/v1/auth/password-reset/confirm", json={"token": first, "new_password": "Brand#New2026!"}).status_code == 400
    for row in db.scalars(select(AuthToken).where(AuthToken.purpose == "reset")):
        row.expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    assert client.post("/api/v1/auth/password-reset/confirm", json={"token": second, "new_password": "Brand#New2026!"}).status_code == 400
    assert client.post("/api/v1/auth/password-reset/confirm", json={"token": "garbage-token-value", "new_password": "Brand#New2026!"}).status_code == 400


def test_password_reset_invalidated_by_password_change(client, lib, db):
    client.post("/api/v1/auth/password-reset", json={"identifier": "reader1"})
    token = _reset_token(db, lib["patron"].id)
    client.post("/api/v1/auth/password", headers=bearer(_token(client)),
                json={"current_password": PASSWORD, "new_password": "N3w#Password!!"})
    assert client.post("/api/v1/auth/password-reset/confirm", json={"token": token, "new_password": "Brand#New2026!"}).status_code == 400


def test_password_reset_clears_lockout(client, lib, db):
    for _ in range(5):
        password_login(client, "reader1", "wrong-password")
    client.post("/api/v1/auth/password-reset", json={"identifier": "reader1"})
    token = _reset_token(db, lib["patron"].id)
    assert client.post("/api/v1/auth/password-reset/confirm", json={"token": token, "new_password": "Brand#New2026!"}).status_code == 200
    assert password_login(client, "reader1", "Brand#New2026!").status_code == 200


def test_password_reset_rate_limited_and_policy(client, lib, admin):
    codes = [client.post("/api/v1/auth/password-reset", json={"identifier": "reader2"}).status_code for _ in range(7)]
    assert 429 in codes
    reset_identity_state()
    client.put("/api/v1/admin/settings/password_reset_enabled", headers=admin, json={"value": False})
    assert client.post("/api/v1/auth/password-reset", json={"identifier": "reader1"}).status_code == 403


def test_reset_with_cookie_session_does_not_need_csrf(client, lib):
    password_login(client, "reader1")  # leaves cookies behind
    assert client.post("/api/v1/auth/password-reset", json={"identifier": "reader1"}).status_code == 200
