"""Shared helpers for the identity & access test modules."""

from __future__ import annotations

import time

import pytest
from conftest import PASSWORD

from shelfwise.services import totp


class FakeClock:
    """Replaces ``time`` inside the TOTP module so tests can move between 30-second steps."""

    def __init__(self) -> None:
        self.now = float(int(time.time()) // 30 * 30 + 5)

    def time(self) -> float:
        return self.now

    def tick(self, steps: int = 1) -> None:
        self.now += 30 * steps


def install_clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    c = FakeClock()
    monkeypatch.setattr(totp, "time", c)
    return c


def reset_identity_state() -> None:
    from shelfwise.security import reset_limiters
    from shelfwise.services import oidc

    reset_limiters()
    oidc.clear_cache()


def code_for(secret: str, at: float) -> str:
    return totp.totp(totp.b32decode(secret), at)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def password_login(client, username: str, password: str = PASSWORD):
    return client.post("/api/v1/auth/login", json={"username": username, "password": password})


def enable_mfa(client, headers: dict, clock: FakeClock, password: str = PASSWORD) -> tuple[str, list[str]]:
    r = client.post("/api/v1/auth/mfa/setup", headers=headers, json={"password": password})
    assert r.status_code == 200, r.text
    secret = r.json()["secret"]
    r = client.post("/api/v1/auth/mfa/activate", headers=headers, json={"code": code_for(secret, clock.now)})
    assert r.status_code == 200, r.text
    return secret, r.json()["recovery_codes"]
