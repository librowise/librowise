"""TOTP two-factor authentication: RFC 6238 vectors, enrolment, two-step login, recovery codes, policy."""

from __future__ import annotations

from datetime import timedelta

import pytest
from conftest import PASSWORD, login
from identity_utils import bearer, code_for, enable_mfa, install_clock, password_login, reset_identity_state
from sqlalchemy import select

from librowise.models import AuthToken, MfaRecoveryCode, MfaTotp, Notification, utcnow
from librowise.services import totp


@pytest.fixture(autouse=True)
def _fresh():
    reset_identity_state()


@pytest.fixture()
def clock(monkeypatch):
    return install_clock(monkeypatch)


# ------------------------------------------------------------------ RFC 6238 Appendix B test vectors

SEED1 = b"12345678901234567890"
SEED256 = b"12345678901234567890123456789012"
SEED512 = b"1234567890123456789012345678901234567890123456789012345678901234"
VECTORS = [
    (59, "94287082", "46119246", "90693936"),
    (1111111109, "07081804", "68084774", "25091201"),
    (1111111111, "14050471", "67062674", "99943326"),
    (1234567890, "89005924", "91819424", "93441116"),
    (2000000000, "69279037", "90698825", "38618901"),
    (20000000000, "65353130", "77737706", "47863826"),
]


@pytest.mark.parametrize(("t", "sha1", "sha256", "sha512"), VECTORS)
def test_rfc6238_vectors(t, sha1, sha256, sha512):
    assert totp.totp(SEED1, t, digits=8, algorithm="SHA1") == sha1
    assert totp.totp(SEED256, t, digits=8, algorithm="SHA256") == sha256
    assert totp.totp(SEED512, t, digits=8, algorithm="SHA512") == sha512


def test_rfc4226_hotp_vectors():
    expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]
    assert [totp.hotp(SEED1, i) for i in range(10)] == expected


def test_verify_drift_and_replay():
    secret = totp.new_secret()
    key = totp.b32decode(secret)
    now = 1_700_000_015.0
    step = totp.time_step(now)
    assert totp.verify(secret, totp.totp(key, now), at=now) == step
    assert totp.verify(secret, totp.totp(key, now - 30), at=now) == step - 1  # one step of drift allowed
    assert totp.verify(secret, totp.totp(key, now + 30), at=now) == step + 1
    assert totp.verify(secret, totp.totp(key, now - 60), at=now) is None  # two steps: too old
    assert totp.verify(secret, totp.totp(key, now + 90), at=now) is None
    # replay protection: the last accepted step and earlier steps are rejected
    assert totp.verify(secret, totp.totp(key, now), at=now, last_step=step) is None
    assert totp.verify(secret, totp.totp(key, now - 30), at=now, last_step=step) is None
    assert totp.verify(secret, totp.totp(key, now + 30), at=now, last_step=step) == step + 1
    for bad in ["", "12345", "1234567", "abcdef", None]:
        assert totp.verify(secret, bad, at=now) is None


def test_provisioning_uri_and_qr():
    uri = totp.provisioning_uri("JBSWY3DPEHPK3PXP", "ana@example.org", "Town Library")
    assert uri.startswith("otpauth://totp/Town%20Library%3Aana%40example.org?")
    assert "secret=JBSWY3DPEHPK3PXP" in uri and "issuer=Town%20Library" in uri and "period=30" in uri
    svg = totp.qr_svg_data_uri(uri)
    assert svg.startswith("data:image/svg+xml")


# ------------------------------------------------------------------ enrolment


def test_enrolment_flow_and_secret_encrypted(client, lib, db, clock):
    h = login(client, "reader1")
    assert client.post("/api/v1/auth/mfa/setup", headers=h, json={"password": "wrong"}).status_code == 400
    r = client.post("/api/v1/auth/mfa/setup", headers=h, json={"password": PASSWORD})
    assert r.status_code == 200
    setup = r.json()
    assert setup["otpauth_uri"].startswith("otpauth://totp/") and setup["qr_svg"].startswith("data:image/svg+xml")
    row = db.get(MfaTotp, lib["patron"].id)
    assert row is not None and setup["secret"] not in row.secret_enc  # encrypted at rest
    assert client.get("/api/v1/auth/mfa", headers=h).json()["pending"] is True
    # wrong code does not activate
    assert client.post("/api/v1/auth/mfa/activate", headers=h, json={"code": "000000"}).status_code == 400
    r = client.post("/api/v1/auth/mfa/activate", headers=h, json={"code": code_for(setup["secret"], clock.now)})
    assert r.status_code == 200
    codes = r.json()["recovery_codes"]
    assert len(codes) == 10 and len(set(codes)) == 10
    db.expire_all()
    stored = [c.code_hash for c in db.scalars(select(MfaRecoveryCode).where(MfaRecoveryCode.user_id == lib["patron"].id))]
    assert len(stored) == 10 and not set(codes) & set(stored)  # hashed
    status = client.get("/api/v1/auth/mfa", headers=h).json()
    assert status["enabled"] and status["recovery_codes_remaining"] == 10
    # cannot start a second enrolment while enabled
    assert client.post("/api/v1/auth/mfa/setup", headers=h, json={"password": PASSWORD}).status_code == 409


# ------------------------------------------------------------------ two-step login


def test_two_step_login_with_totp(client, lib, clock):
    secret, _ = enable_mfa(client, login(client, "reader1"), clock)
    r = password_login(client, "reader1")
    assert r.status_code == 200
    body = r.json()
    assert body["mfa_required"] is True and "token" not in body and body["mfa_token"]
    assert "sw_session" not in r.cookies
    # the code used to activate (same step) is a replay and is rejected
    bad = client.post("/api/v1/auth/mfa", json={"mfa_token": body["mfa_token"], "code": code_for(secret, clock.now)})
    assert bad.status_code == 401
    clock.tick()
    ok = client.post("/api/v1/auth/mfa", json={"mfa_token": body["mfa_token"], "code": code_for(secret, clock.now)})
    assert ok.status_code == 200, ok.text
    assert client.get("/api/v1/auth/me", headers=bearer(ok.json()["token"])).json()["mfa_enabled"] is True
    # the same TOTP code cannot be replayed in a new login, even with a fresh challenge
    t2 = password_login(client, "reader1").json()["mfa_token"]
    assert client.post("/api/v1/auth/mfa", json={"mfa_token": t2, "code": code_for(secret, clock.now)}).status_code == 401


def test_mfa_token_is_single_use(client, lib, clock):
    secret, _ = enable_mfa(client, login(client, "reader1"), clock)
    token = password_login(client, "reader1").json()["mfa_token"]
    clock.tick()
    assert client.post("/api/v1/auth/mfa", json={"mfa_token": token, "code": code_for(secret, clock.now)}).status_code == 200
    clock.tick()
    r = client.post("/api/v1/auth/mfa", json={"mfa_token": token, "code": code_for(secret, clock.now)})
    assert r.status_code == 401 and "expired" in r.json()["detail"]


def test_mfa_token_expiry_and_tampering(client, lib, db, clock):
    secret, _ = enable_mfa(client, login(client, "reader1"), clock)
    token = password_login(client, "reader1").json()["mfa_token"]
    clock.tick()
    assert client.post("/api/v1/auth/mfa", json={"mfa_token": token[:-2] + "xx", "code": code_for(secret, clock.now)}).status_code == 401
    row = db.scalars(select(AuthToken).where(AuthToken.purpose == "mfa")).all()[-1]
    row.expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    assert client.post("/api/v1/auth/mfa", json={"mfa_token": token, "code": code_for(secret, clock.now)}).status_code == 401


def test_mfa_token_burned_after_too_many_wrong_codes(client, lib, clock):
    secret, _ = enable_mfa(client, login(client, "reader1"), clock)
    token = password_login(client, "reader1").json()["mfa_token"]
    for _ in range(5):
        assert client.post("/api/v1/auth/mfa", json={"mfa_token": token, "code": "000000"}).status_code == 401
    clock.tick()
    assert client.post("/api/v1/auth/mfa", json={"mfa_token": token, "code": code_for(secret, clock.now)}).status_code == 401


def test_password_token_not_issued_without_second_factor(client, lib, clock):
    """An MFA token is not a session: it cannot be used as a bearer credential."""
    enable_mfa(client, login(client, "reader1"), clock)
    token = password_login(client, "reader1").json()["mfa_token"]
    assert client.get("/api/v1/auth/me", headers=bearer(token)).status_code == 401


def test_recovery_codes_are_single_use(client, lib, db, clock):
    _, codes = enable_mfa(client, login(client, "reader1"), clock)
    t1 = password_login(client, "reader1").json()["mfa_token"]
    r = client.post("/api/v1/auth/mfa", json={"mfa_token": t1, "code": codes[0].upper()})  # case/format tolerant
    assert r.status_code == 200 and r.json()["recovery_codes_remaining"] == 9
    t2 = password_login(client, "reader1").json()["mfa_token"]
    assert client.post("/api/v1/auth/mfa", json={"mfa_token": t2, "code": codes[0]}).status_code == 401
    assert client.post("/api/v1/auth/mfa", json={"mfa_token": t2, "code": codes[1].replace("-", "")}).status_code == 200
    assert db.scalar(select(Notification).where(Notification.subject.like("%recovery code%"))) is not None


def test_regenerate_recovery_codes_and_disable(client, lib, clock):
    h = login(client, "reader1")
    secret, old = enable_mfa(client, h, clock)
    clock.tick()
    assert client.post("/api/v1/auth/mfa/recovery-codes", headers=h, json={"password": PASSWORD, "code": "000000"}).status_code == 400
    r = client.post("/api/v1/auth/mfa/recovery-codes", headers=h, json={"password": PASSWORD, "code": code_for(secret, clock.now)})
    assert r.status_code == 200
    new = r.json()["recovery_codes"]
    assert not set(new) & set(old)
    # disable requires password + a valid code (an old recovery code no longer works)
    assert client.post("/api/v1/auth/mfa/disable", headers=h, json={"password": PASSWORD, "code": old[0]}).status_code == 400
    assert client.post("/api/v1/auth/mfa/disable", headers=h, json={"password": "nope", "code": new[0]}).status_code == 400
    assert client.post("/api/v1/auth/mfa/disable", headers=h, json={"password": PASSWORD, "code": new[1]}).status_code == 200
    assert client.get("/api/v1/auth/mfa", headers=h).json()["enabled"] is False
    assert "token" in password_login(client, "reader1").json()  # single-step login again


def test_admin_reset_mfa(client, lib, admin, staff, clock):
    enable_mfa(client, login(client, "reader1"), clock)
    pid = lib["patron"].id
    assert client.post(f"/api/v1/admin/users/{pid}/mfa/reset", headers=login(client, "reader2")).status_code == 403
    r = client.post(f"/api/v1/admin/users/{pid}/mfa/reset", headers=staff)  # librarians may help patrons
    assert r.status_code == 200 and r.json()["mfa"]["enabled"] is False
    assert "token" in password_login(client, "reader1").json()
    # a librarian may not reset an administrator's second factor
    assert client.post(f"/api/v1/admin/users/{lib['admin'].id}/mfa/reset", headers=staff).status_code == 403


def test_cli_break_glass_reset(client, lib, clock, db):
    from librowise.__main__ import main

    enable_mfa(client, login(client, "admin"), clock)
    assert main(["reset-2fa", "--username", "admin"]) == 0
    assert "token" in password_login(client, "admin").json()


# ------------------------------------------------------------------ policy: require 2FA for staff


def test_require_2fa_for_staff_policy(client, lib, admin, clock):
    assert client.put("/api/v1/admin/settings/require_2fa_for_staff", headers=admin, json={"value": True}).status_code == 200
    # admin (still signed in) is now restricted too until enrolled
    assert client.get("/api/v1/patrons", headers=admin).status_code == 403
    r = password_login(client, "librarian")
    assert r.status_code == 200 and r.json()["mfa_enrollment_required"] is True
    h = bearer(r.json()["token"])
    me = client.get("/api/v1/auth/me", headers=h).json()
    assert me["mfa_enrollment_required"] is True and me["permissions"] == ["opac"]
    denied = client.get("/api/v1/patrons", headers=h)
    assert denied.status_code == 403 and "Two-factor" in denied.json()["detail"]
    # staff pages redirect to the enrolment page
    client.cookies.clear()
    password_login(client, "librarian")
    page = client.get("/staff/circulation", follow_redirects=False)
    assert page.status_code == 303 and page.headers["location"] == "/staff/security?enroll=1"
    assert client.get("/staff/security").status_code == 200
    client.cookies.clear()
    secret, _ = enable_mfa(client, h, clock)
    assert client.get("/api/v1/patrons", headers=h).status_code == 200
    # cannot switch it off while the policy is on
    clock.tick()
    r = client.post("/api/v1/auth/mfa/disable", headers=h, json={"password": PASSWORD, "code": code_for(secret, clock.now)})
    assert r.status_code == 403
    # patrons are unaffected by the staff policy
    assert "token" in password_login(client, "reader1").json()
