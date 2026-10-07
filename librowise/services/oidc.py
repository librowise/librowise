"""OpenID Connect single sign-on (authorization code flow + PKCE + state + nonce).

Providers are stored in the ``settings`` table under ``oidc_providers`` (client secrets encrypted at rest)
and managed through ``/api/v1/admin/sso/providers``. ID tokens are verified against the provider's JWKS
(signature, issuer, audience/azp, expiry, issued-at, nonce). Accounts are matched by linked identity
(provider + subject) first, then by *verified* e-mail address; new patrons are only created when the
provider's ``auto_create`` flag is on.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Branch, Patron, PatronCategory, Role, Setting, UserIdentity, utcnow
from ..security import seal, unseal

SETTING_KEY = "oidc_providers"
ALLOWED_ALGS = {"RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"}
CACHE_TTL = 3600
LEEWAY = 60


class OidcError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


# ------------------------------------------------------------------ provider configuration


def _raw(db: Session) -> dict[str, dict]:
    row = db.get(Setting, SETTING_KEY)
    return dict(row.value) if row is not None and isinstance(row.value, dict) else {}


def _save(db: Session, providers: dict[str, dict]) -> None:
    row = db.get(Setting, SETTING_KEY)
    if row is None:
        db.add(Setting(key=SETTING_KEY, value=providers, description="OpenID Connect single sign-on providers"))
    else:
        row.value = providers


def providers(db: Session) -> dict[str, dict]:
    return _raw(db)


def get_provider(db: Session, pid: str, *, enabled_only: bool = True) -> dict | None:
    p = _raw(db).get(pid)
    if p is None or (enabled_only and not p.get("enabled", True)):
        return None
    return {**p, "id": pid}


def upsert_provider(db: Session, pid: str, data: dict) -> dict:
    allp = _raw(db)
    current = allp.get(pid, {})
    secret = data.pop("client_secret", None)
    stored = {**current, **data}
    if secret:
        stored["client_secret_enc"] = seal(secret, "oidc")
    allp[pid] = stored
    _save(db, allp)
    return {**stored, "id": pid}


def delete_provider(db: Session, pid: str) -> bool:
    allp = _raw(db)
    if pid not in allp:
        return False
    del allp[pid]
    _save(db, allp)
    return True


def masked(pid: str, p: dict) -> dict:
    out = {k: v for k, v in p.items() if k != "client_secret_enc"}
    out["id"] = pid
    out["client_secret_set"] = bool(p.get("client_secret_enc") or (p.get("client_secret_env") and os.environ.get(p["client_secret_env"])))
    return out


def public_list(db: Session) -> list[dict]:
    return [{"id": pid, "label": p.get("label") or pid} for pid, p in sorted(_raw(db).items()) if p.get("enabled", True)]


def client_secret(p: dict) -> str:
    if p.get("client_secret_enc"):
        return unseal(p["client_secret_enc"], "oidc") or ""
    env = p.get("client_secret_env")
    return os.environ.get(env, "") if env else ""


# ------------------------------------------------------------------ HTTP (replaceable in tests)


def http_client() -> httpx.Client:
    return httpx.Client(timeout=10.0, follow_redirects=False, headers={"Accept": "application/json"})


_cache: dict[str, tuple[float, Any]] = {}


def clear_cache() -> None:
    _cache.clear()


def _get_json(url: str) -> dict:
    try:
        with http_client() as c:
            r = c.get(url)
    except httpx.HTTPError as exc:
        raise OidcError("provider_unreachable", str(exc)) from None
    if r.status_code != 200:
        raise OidcError("provider_error", f"GET {url} returned {r.status_code}")
    try:
        data = r.json()
    except ValueError:
        raise OidcError("provider_error", "invalid JSON") from None
    if not isinstance(data, dict):
        raise OidcError("provider_error", "invalid JSON")
    return data


def discover(issuer: str) -> dict:
    issuer = issuer.rstrip("/")
    hit = _cache.get(f"disc:{issuer}")
    if hit and time.monotonic() - hit[0] < CACHE_TTL:
        return hit[1]
    doc = _get_json(f"{issuer}/.well-known/openid-configuration")
    if doc.get("issuer", "").rstrip("/") != issuer:
        raise OidcError("issuer", "discovery issuer mismatch")
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not isinstance(doc.get(key), str):
            raise OidcError("provider_error", f"discovery document lacks {key}")
    _cache[f"disc:{issuer}"] = (time.monotonic(), doc)
    return doc


def _jwks(uri: str, force: bool = False) -> list[dict]:
    hit = _cache.get(f"jwks:{uri}")
    if hit and not force and time.monotonic() - hit[0] < CACHE_TTL:
        return hit[1]
    keys = _get_json(uri).get("keys") or []
    _cache[f"jwks:{uri}"] = (time.monotonic(), keys)
    return keys


# ------------------------------------------------------------------ protocol steps


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def authorization_request(provider: dict, redirect_uri: str) -> tuple[str, dict]:
    """Return the IdP authorization URL and the per-attempt secrets to keep in the state cookie."""
    doc = discover(provider["issuer"])
    state, nonce, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    params = {
        "response_type": "code", "client_id": provider["client_id"], "redirect_uri": redirect_uri,
        "scope": provider.get("scopes") or "openid email profile", "state": state, "nonce": nonce,
        "code_challenge": challenge, "code_challenge_method": "S256",
    }
    sep = "&" if "?" in doc["authorization_endpoint"] else "?"
    return f"{doc['authorization_endpoint']}{sep}{urlencode(params)}", {"state": state, "nonce": nonce, "verifier": verifier}


def exchange_code(provider: dict, code: str, verifier: str, redirect_uri: str) -> dict:
    doc = discover(provider["issuer"])
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri, "code_verifier": verifier}
    secret = client_secret(provider)
    methods = doc.get("token_endpoint_auth_methods_supported") or ["client_secret_basic"]
    auth = None
    if secret and "client_secret_basic" in methods:
        auth = (provider["client_id"], secret)
    else:
        data["client_id"] = provider["client_id"]
        if secret:
            data["client_secret"] = secret
    try:
        with http_client() as c:
            r = c.post(doc["token_endpoint"], data=data, auth=auth)
    except httpx.HTTPError as exc:
        raise OidcError("provider_unreachable", str(exc)) from None
    if r.status_code != 200:
        raise OidcError("token_exchange", f"token endpoint returned {r.status_code}")
    try:
        tokens = r.json()
    except ValueError:
        raise OidcError("token_exchange", "invalid JSON") from None
    if not isinstance(tokens, dict) or not isinstance(tokens.get("id_token"), str):
        raise OidcError("token_exchange", "no id_token in response")
    return tokens


def validate_id_token(provider: dict, id_token: str, nonce: str) -> dict:
    doc = discover(provider["issuer"])
    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.PyJWTError:
        raise OidcError("invalid_token", "malformed ID token") from None
    alg = header.get("alg")
    if alg not in ALLOWED_ALGS:
        raise OidcError("signature", f"algorithm {alg!r} not allowed")
    kid = header.get("kid")

    def find(keys: list[dict]) -> dict | None:
        cands = [k for k in keys if (kid is None or k.get("kid") == kid) and k.get("use", "sig") == "sig"]
        return cands[0] if cands else None

    jwk = find(_jwks(doc["jwks_uri"])) or find(_jwks(doc["jwks_uri"], force=True))  # handle key rotation
    if jwk is None:
        raise OidcError("signature", "signing key not found")
    try:
        key = jwt.PyJWK(jwk, algorithm=alg).key
        claims = jwt.decode(id_token, key=key, algorithms=[alg], audience=provider["client_id"],
                            issuer=doc["issuer"], leeway=LEEWAY,
                            options={"require": ["exp", "iat", "iss", "aud", "sub"]})
    except jwt.ExpiredSignatureError:
        raise OidcError("expired", "ID token expired") from None
    except jwt.InvalidAudienceError:
        raise OidcError("audience", "ID token audience mismatch") from None
    except jwt.InvalidIssuerError:
        raise OidcError("issuer", "ID token issuer mismatch") from None
    except jwt.InvalidSignatureError:
        raise OidcError("signature", "ID token signature invalid") from None
    except (jwt.PyJWTError, ValueError, TypeError) as exc:
        raise OidcError("invalid_token", str(exc)) from None
    aud = claims.get("aud")
    if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != provider["client_id"]:
        raise OidcError("audience", "azp mismatch")
    if not isinstance(claims.get("nonce"), str) or not hmac.compare_digest(claims["nonce"], nonce):
        raise OidcError("nonce", "nonce mismatch")
    return claims


def fetch_userinfo(provider: dict, access_token: str, sub: str) -> dict:
    doc = discover(provider["issuer"])
    url = doc.get("userinfo_endpoint")
    if not url or not access_token:
        return {}
    try:
        with http_client() as c:
            r = c.get(url, headers={"Authorization": f"Bearer {access_token}"})
        info = r.json() if r.status_code == 200 else {}
    except (httpx.HTTPError, ValueError):
        return {}
    return info if isinstance(info, dict) and info.get("sub") == sub else {}


# ------------------------------------------------------------------ account mapping


def _verified(claims: dict) -> bool:
    v = claims.get("email_verified")
    return v is True or (isinstance(v, str) and v.lower() == "true")


def _domain_ok(provider: dict, email: str | None) -> bool:
    domains = [d.lower().lstrip("@") for d in provider.get("allowed_domains") or [] if d]
    if not domains:
        return True
    return bool(email) and email.rsplit("@", 1)[-1].lower() in domains


def resolve_user(db: Session, provider: dict, claims: dict, *, link_user: Patron | None = None) -> tuple[Patron, bool]:
    """Find (or link / create) the local account for verified ID-token claims. Returns (user, created)."""
    pid, sub = provider["id"], str(claims["sub"])
    email = (claims.get("email") or "").strip().lower() or None
    if email and not _verified(claims):
        email = None
    if not _domain_ok(provider, email):
        raise OidcError("domain", "e-mail domain not allowed for this provider")
    ident = db.scalar(select(UserIdentity).where(UserIdentity.provider == pid, UserIdentity.subject == sub))
    created = False
    if link_user is not None:
        if ident is not None and ident.user_id != link_user.id:
            raise OidcError("already_linked", "identity linked to another account")
        user = link_user
    elif ident is not None:
        user = db.get(Patron, ident.user_id)
    else:
        if not email:
            raise OidcError("email_unverified", "provider did not supply a verified e-mail")
        user = db.scalar(select(Patron).where(Patron.email == email, Patron.deleted_at.is_(None)))
        if user is None:
            if not provider.get("auto_create"):
                raise OidcError("no_account", "no account with that e-mail")
            user = _create_patron(db, provider, claims, email)
            created = True
    if user is None or user.deleted_at is not None or not user.is_active:
        raise OidcError("inactive", "account inactive")
    if user.is_staff and not provider.get("allow_staff", True):
        raise OidcError("not_allowed", "staff may not use this provider")
    if not user.is_staff and not provider.get("allow_patrons", True):
        raise OidcError("not_allowed", "patrons may not use this provider")
    if ident is None:
        ident = UserIdentity(user_id=user.id, provider=pid, subject=sub, email=email)
        db.add(ident)
    ident.last_login_at = utcnow()
    if email:
        ident.email = email
    db.flush()
    return user, created


def _create_patron(db: Session, provider: dict, claims: dict, email: str) -> Patron:
    from ..api.patrons import new_card_number

    cat = db.scalar(select(PatronCategory).where(PatronCategory.code == (provider.get("default_category") or "")))
    branch = db.scalar(select(Branch).where(Branch.code == (provider.get("default_branch") or "")))
    cat = cat or db.scalar(select(PatronCategory).order_by(PatronCategory.id).limit(1))
    branch = branch or db.scalar(select(Branch).order_by(Branch.id).limit(1))
    if cat is None or branch is None:
        raise OidcError("no_account", "no default category/branch configured")
    first = (claims.get("given_name") or (claims.get("name") or "").split(" ")[0] or email.split("@")[0])[:80]
    last = (claims.get("family_name") or " ".join((claims.get("name") or "").split(" ")[1:]) or "(SSO)")[:80]

    p = Patron(card_number=new_card_number(db), email=email, first_name=first, last_name=last, role=Role.patron,
               category_id=cat.id, home_branch_id=branch.id,
               expires_on=(utcnow() + timedelta(days=30 * cat.enrollment_months)).date())
    db.add(p)
    db.flush()
    return p
