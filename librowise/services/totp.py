"""RFC 6238 time-based one-time passwords (TOTP), implemented with the standard library.

* HOTP (RFC 4226) dynamic truncation over HMAC-SHA1/256/512.
* 30-second steps, 6 digits, ±1 step tolerance for clock drift.
* Replay protection: callers pass the last accepted step; codes for that step or earlier are rejected.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote, urlencode

STEP = 30
DIGITS = 6
DRIFT = 1
_ALGOS = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}


def new_secret(nbytes: int = 20) -> str:
    """A random 160-bit secret, base32-encoded without padding (what authenticator apps expect)."""
    return base64.b32encode(secrets.token_bytes(nbytes)).decode().rstrip("=")


def b32decode(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def hotp(key: bytes, counter: int, digits: int = DIGITS, algorithm: str = "SHA1") -> str:
    digest = hmac.new(key, struct.pack(">Q", counter), _ALGOS[algorithm]).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10 ** digits)).zfill(digits)


def time_step(at: float | None = None, step: int = STEP) -> int:
    return int((time.time() if at is None else at) // step)


def totp(key: bytes, at: float | None = None, *, step: int = STEP, digits: int = DIGITS, algorithm: str = "SHA1") -> str:
    return hotp(key, time_step(at, step), digits, algorithm)


def verify(secret_b32: str, code: str, *, at: float | None = None, last_step: int | None = None,
           drift: int = DRIFT) -> int | None:
    """Return the matched time step if ``code`` is valid and not replayed, else ``None``."""
    code = (code or "").strip().replace(" ", "")
    if len(code) != DIGITS or not code.isdigit():
        return None
    try:
        key = b32decode(secret_b32)
    except (ValueError, TypeError):
        return None
    now = time_step(at)
    matched = None
    for candidate in range(now - drift, now + drift + 1):
        # compare every candidate (constant work regardless of which one matches)
        if hmac.compare_digest(hotp(key, candidate), code) and matched is None:
            matched = candidate
    if matched is None or (last_step is not None and matched <= last_step):
        return None
    return matched


def provisioning_uri(secret_b32: str, account: str, issuer: str) -> str:
    label = quote(f"{issuer}:{account}", safe="")
    params = urlencode({"secret": secret_b32, "issuer": issuer, "algorithm": "SHA1", "digits": DIGITS, "period": STEP},
                       quote_via=quote)
    return f"otpauth://totp/{label}?{params}"


def qr_svg_data_uri(data: str) -> str:
    """Render ``data`` as a QR code SVG data URI (pure Python, via ``segno``)."""
    import segno

    return segno.make(data, error="m", micro=False).svg_data_uri(scale=5, border=2, dark="#000", light="#fff")
