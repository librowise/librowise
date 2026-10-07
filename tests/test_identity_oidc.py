"""OpenID Connect SSO against a mocked identity provider (httpx.MockTransport + locally generated RSA keys)."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from conftest import login
from cryptography.hazmat.primitives.asymmetric import rsa
from identity_utils import bearer, code_for, enable_mfa, install_clock, reset_identity_state
from sqlalchemy import select

from shelfwise.models import Patron, UserIdentity, utcnow
from shelfwise.services import oidc

ISSUER = "https://idp.example"
CLIENT_ID = "shelfwise-client"


def _jwk(public_key, kid):
    d = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(public_key))
    d.update(kid=kid, use="sig", alg="RS256")
    return d


class FakeIdP:
    def __init__(self):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.kid = "k1"
        self.claims: dict = {}
        self.overrides: dict = {}
        self.sign_with = None  # None = correct key
        self.alg = "RS256"
        self.headers_kid = "k1"
        self.nonce = None
        self.challenge = None
        self.last_token_request: dict = {}
        self.token_status = 200
        self.userinfo: dict | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f"{ISSUER}/.well-known/openid-configuration":
            return httpx.Response(200, json={
                "issuer": ISSUER, "authorization_endpoint": f"{ISSUER}/authorize", "token_endpoint": f"{ISSUER}/token",
                "jwks_uri": f"{ISSUER}/jwks", "userinfo_endpoint": f"{ISSUER}/userinfo",
                "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"]})
        if url == f"{ISSUER}/jwks":
            return httpx.Response(200, json={"keys": [_jwk(self.key.public_key(), self.kid)]})
        if url == f"{ISSUER}/token":
            form = parse_qs(request.content.decode())
            self.last_token_request = {k: v[0] for k, v in form.items()}
            self.last_token_request["authorization"] = request.headers.get("authorization", "")
            verifier = self.last_token_request.get("code_verifier", "")
            computed = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
            if computed != self.challenge or self.last_token_request.get("code") != "good-code":
                return httpx.Response(400, json={"error": "invalid_grant"})
            if self.token_status != 200:
                return httpx.Response(self.token_status, json={"error": "server_error"})
            return httpx.Response(200, json={"id_token": self.id_token(), "access_token": "at-123", "token_type": "Bearer"})
        if url == f"{ISSUER}/userinfo":
            return httpx.Response(200, json=self.userinfo or {})
        return httpx.Response(404)

    def id_token(self) -> str:
        now = int(time.time())
        claims = {"iss": ISSUER, "aud": CLIENT_ID, "sub": "idp-user-1", "iat": now, "exp": now + 300,
                  "nonce": self.nonce, "email": "reader1@example.org", "email_verified": True, **self.claims}
        claims.update(self.overrides)
        claims = {k: v for k, v in claims.items() if v is not None}
        if self.alg == "HS256":
            return jwt.encode(claims, "shared-secret-guess-that-is-long-enough-1234", algorithm="HS256", headers={"kid": self.headers_kid})
        if self.alg == "none":
            head = base64.urlsafe_b64encode(json.dumps({"alg": "none", "kid": self.headers_kid}).encode()).decode().rstrip("=")
            body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
            return f"{head}.{body}."
        return jwt.encode(claims, self.sign_with or self.key, algorithm="RS256", headers={"kid": self.headers_kid})


@pytest.fixture(autouse=True)
def _fresh():
    reset_identity_state()


@pytest.fixture()
def idp(monkeypatch):
    fake = FakeIdP()
    monkeypatch.setattr(oidc, "http_client", lambda: httpx.Client(transport=httpx.MockTransport(fake.handler)))
    return fake


@pytest.fixture()
def provider(client, lib, admin, idp):
    r = client.put("/api/v1/admin/sso/providers/testidp", headers=admin, json={
        "label": "Test IdP", "issuer": ISSUER, "client_id": CLIENT_ID, "client_secret": "s3cret",
        "default_category": "ADULT", "default_branch": "MAIN"})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return r.json()


def start(client, idp, next_url="/account"):
    r = client.get(f"/api/v1/auth/sso/testidp/login?next={next_url}", follow_redirects=False)
    assert r.status_code == 303, r.text
    loc = urlparse(r.headers["location"])
    assert f"{loc.scheme}://{loc.netloc}{loc.path}" == f"{ISSUER}/authorize"
    q = {k: v[0] for k, v in parse_qs(loc.query).items()}
    assert q["response_type"] == "code" and q["client_id"] == CLIENT_ID and q["code_challenge_method"] == "S256"
    assert "openid" in q["scope"].split()
    idp.nonce, idp.challenge = q["nonce"], q["code_challenge"]
    return q


def callback(client, state, code="good-code"):
    return client.get(f"/api/v1/auth/sso/testidp/callback?code={code}&state={state}", follow_redirects=False)


def error_of(r) -> str | None:
    assert r.status_code == 303
    qs = parse_qs(urlparse(r.headers["location"]).query)
    return qs.get("sso_error", [None])[0]


# ------------------------------------------------------------------ admin configuration


def test_provider_admin_masks_secret(client, lib, admin, idp, db):
    client.put("/api/v1/admin/sso/providers/testidp", headers=admin, json={"label": "Test IdP", "issuer": ISSUER, "client_id": CLIENT_ID, "client_secret": "s3cret"})
    listed = client.get("/api/v1/admin/sso/providers", headers=admin).json()["results"][0]
    assert listed["client_secret_set"] is True and "s3cret" not in json.dumps(listed)
    from shelfwise.models import Setting

    assert "s3cret" not in json.dumps(db.get(Setting, "oidc_providers").value)  # encrypted at rest
    # keeping the secret when it's omitted
    client.put("/api/v1/admin/sso/providers/testidp", headers=admin, json={"label": "Renamed", "issuer": ISSUER, "client_id": CLIENT_ID})
    assert oidc.client_secret(oidc.get_provider(db, "testidp")) == "s3cret"
    assert client.get("/api/v1/auth/sso/providers").json()["results"] == [{"id": "testidp", "label": "Renamed"}]
    bad = client.put("/api/v1/admin/sso/providers/x2", headers=admin, json={"label": "L", "issuer": "http://evil.example", "client_id": "c"})
    assert bad.status_code == 422
    assert client.put("/api/v1/admin/sso/providers/BAD ID", headers=admin, json={"label": "L", "issuer": ISSUER, "client_id": "c"}).status_code in (404, 422)
    assert client.get("/api/v1/admin/sso/providers", headers=login(client, "librarian")).status_code == 403


# ------------------------------------------------------------------ happy paths


def test_sso_login_maps_verified_email(client, lib, provider, idp, db):
    q = start(client, idp, "/account")
    r = callback(client, q["state"])
    assert r.status_code == 303 and r.headers["location"] == "/account", r.headers.get("location")
    assert idp.last_token_request["authorization"].startswith("Basic ")  # client_secret_basic
    assert idp.last_token_request["redirect_uri"].endswith("/api/v1/auth/sso/testidp/callback")
    me = client.get("/api/v1/auth/me").json()
    assert me["card_number"] == "reader1"
    ident = db.scalar(select(UserIdentity).where(UserIdentity.subject == "idp-user-1"))
    assert ident.user_id == lib["patron"].id and ident.provider == "testidp"
    sessions = client.get("/api/v1/auth/sessions").json()["results"]
    assert sessions[0]["method"] == "sso:testidp"
    # second login maps by the linked subject even if the e-mail changed
    client.cookies.clear()
    idp.overrides = {"email": "changed@elsewhere.example"}
    q = start(client, idp)
    assert callback(client, q["state"]).headers["location"] == "/account"
    assert client.get("/api/v1/auth/me").json()["card_number"] == "reader1"


def test_sso_auto_create(client, lib, admin, idp, db):
    client.put("/api/v1/admin/sso/providers/testidp", headers=admin, json={
        "label": "Test IdP", "issuer": ISSUER, "client_id": CLIENT_ID, "client_secret": "s3cret", "auto_create": True,
        "default_category": "ADULT", "default_branch": "MAIN", "allowed_domains": ["uni.example"]})
    client.cookies.clear()
    idp.overrides = {"sub": "new-sub", "email": "new.person@uni.example", "given_name": "New", "family_name": "Person"}
    q = start(client, idp)
    assert callback(client, q["state"]).headers["location"] == "/account"
    p = db.scalar(select(Patron).where(Patron.email == "new.person@uni.example"))
    assert p is not None and p.role.value == "patron" and p.password_hash is None and p.category.code == "ADULT"
    # domain restriction applies
    client.cookies.clear()
    idp.overrides = {"sub": "x-sub", "email": "someone@gmail.example"}
    q = start(client, idp)
    assert error_of(callback(client, q["state"])) == "domain"


def test_sso_respects_mfa(client, lib, provider, idp, monkeypatch):
    clock = install_clock(monkeypatch)
    secret, _ = enable_mfa(client, login(client, "reader1"), clock)
    client.cookies.clear()
    q = start(client, idp, "/account")
    r = callback(client, q["state"])
    loc = r.headers["location"]
    assert loc.startswith("/login#mfa=") and "sw_session" not in r.cookies
    clock.tick()
    done = client.post("/api/v1/auth/mfa", json={"mfa_token": loc.split("#mfa=")[1], "code": code_for(secret, clock.now)})
    assert done.status_code == 200 and done.json()["next"] == "/account"
    assert client.get("/api/v1/auth/sessions", headers=bearer(done.json()["token"])).json()["results"][0]["method"] == "sso:testidp+totp"


def test_link_and_unlink_identity(client, lib, provider, idp, db):
    h = login(client, "reader2")  # sets cookies too (linking needs the browser session)
    r = client.post("/api/v1/auth/sso/testidp/link", headers={"X-CSRF-Token": client.cookies.get("sw_csrf")})
    assert r.status_code == 200
    q = {k: v[0] for k, v in parse_qs(urlparse(r.json()["redirect"]).query).items()}
    idp.nonce, idp.challenge = q["nonce"], q["code_challenge"]
    idp.overrides = {"sub": "reader2-at-idp", "email": "different@idp.example"}
    cb = callback(client, q["state"])
    assert cb.headers["location"] == "/account#settings"
    ids = client.get("/api/v1/auth/identities", headers=h).json()["results"]
    assert [i["provider"] for i in ids] == ["testidp"]
    # the linked identity now signs reader2 in
    client.cookies.clear()
    q = start(client, idp)
    callback(client, q["state"])
    assert client.get("/api/v1/auth/me").json()["card_number"] == "reader2"
    assert client.delete(f"/api/v1/auth/identities/{ids[0]['id']}", headers=h).status_code == 200
    assert db.scalar(select(UserIdentity).where(UserIdentity.subject == "reader2-at-idp")) is None


def test_cannot_link_identity_owned_by_someone_else(client, lib, provider, idp):
    q = start(client, idp)
    callback(client, q["state"])  # links idp-user-1 to reader1 by e-mail
    client.cookies.clear()
    login(client, "reader2")
    r = client.post("/api/v1/auth/sso/testidp/link", headers={"X-CSRF-Token": client.cookies.get("sw_csrf")})
    q = {k: v[0] for k, v in parse_qs(urlparse(r.json()["redirect"]).query).items()}
    idp.nonce, idp.challenge = q["nonce"], q["code_challenge"]
    assert error_of(callback(client, q["state"])) == "already_linked"


# ------------------------------------------------------------------ validation failures


def test_state_mismatch_rejected(client, lib, provider, idp):
    start(client, idp)
    assert error_of(callback(client, "forged-state")) == "state"
    client.cookies.clear()  # no state cookie at all
    assert error_of(callback(client, "anything")) == "state"


def test_state_cookie_is_bound_to_provider_and_single_attempt(client, lib, provider, idp):
    q = start(client, idp)
    assert callback(client, q["state"]).headers["location"] == "/account"
    # the state cookie is cleared after use, so replaying the callback fails
    assert error_of(callback(client, q["state"])) == "state"


def test_pkce_verifier_required(client, lib, provider, idp):
    q = start(client, idp)
    idp.challenge = "tampered"
    assert error_of(callback(client, q["state"])) == "token_exchange"


@pytest.mark.parametrize(("setup", "expected"), [
    (lambda idp: setattr(idp, "nonce", "wrong-nonce"), "nonce"),
    (lambda idp: setattr(idp, "sign_with", idp.other_key), "signature"),
    (lambda idp: idp.overrides.update(aud="someone-else"), "audience"),
    (lambda idp: idp.overrides.update(aud=[CLIENT_ID, "other"], azp="other"), "audience"),
    (lambda idp: idp.overrides.update(iss="https://evil.example"), "issuer"),
    (lambda idp: idp.overrides.update(exp=int(time.time()) - 3600, iat=int(time.time()) - 7200), "expired"),
    (lambda idp: idp.overrides.update(exp=None), "invalid_token"),
    (lambda idp: setattr(idp, "alg", "HS256"), "signature"),
    (lambda idp: setattr(idp, "alg", "none"), "signature"),
    (lambda idp: setattr(idp, "headers_kid", "unknown-kid"), "signature"),
    (lambda idp: idp.overrides.update(email_verified=False), "email_unverified"),
    (lambda idp: idp.overrides.update(sub="nobody", email="nobody@example.org"), "no_account"),
])
def test_id_token_validation_failures(client, lib, provider, idp, db, setup, expected):
    q = start(client, idp)
    nonce = idp.nonce
    setup(idp)
    if expected != "nonce":
        idp.nonce = nonce
    r = callback(client, q["state"])
    assert error_of(r) == expected
    assert "sw_session" not in r.cookies
    assert db.scalar(select(UserIdentity)) is None


def test_staff_only_and_patron_only_providers(client, lib, admin, idp):
    client.put("/api/v1/admin/sso/providers/testidp", headers=admin, json={
        "label": "Staff IdP", "issuer": ISSUER, "client_id": CLIENT_ID, "client_secret": "s3cret", "allow_patrons": False})
    client.cookies.clear()
    q = start(client, idp)
    assert error_of(callback(client, q["state"])) == "not_allowed"  # reader1 is a patron
    idp.overrides = {"email": "librarian@example.org"}
    q = start(client, idp, "/staff")
    r = callback(client, q["state"])
    assert r.headers["location"] == "/staff"


def test_open_redirect_blocked(client, lib, provider, idp):
    q = start(client, idp, "//evil.example/phish")
    assert callback(client, q["state"]).headers["location"] == "/account"


def test_disabled_provider_hidden(client, lib, admin, idp):
    client.put("/api/v1/admin/sso/providers/testidp", headers=admin, json={
        "label": "Off", "issuer": ISSUER, "client_id": CLIENT_ID, "enabled": False})
    assert client.get("/api/v1/auth/sso/providers").json()["results"] == []
    assert client.get("/api/v1/auth/sso/testidp/login", follow_redirects=False).status_code == 404


def test_locked_account_cannot_sso(client, lib, provider, idp, db):

    p = db.get(Patron, lib["patron"].id)

    p.locked_until = utcnow() + timedelta(minutes=5)
    db.commit()
    q = start(client, idp)
    assert error_of(callback(client, q["state"])) == "locked"
