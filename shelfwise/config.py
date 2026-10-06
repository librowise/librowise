"""Application settings, loaded from environment variables (prefix ``SHELFWISE_``) or a ``.env`` file.

Koha keeps 1,000+ runtime "system preferences" in a database table. Shelfwise keeps a small,
typed set of deployment settings here and a handful of library policies in the ``settings``
table (see :mod:`shelfwise.services.settings`).
"""

from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent


def _local_secret() -> str:
    """Development fallback: a random key persisted next to the project so sessions survive
    restarts and are shared by workers. Production deployments set SHELFWISE_SECRET_KEY."""
    path = BASE_DIR.parent / ".shelfwise_secret"
    try:
        if path.exists():
            return path.read_text().strip()
        key = secrets.token_urlsafe(48)
        path.write_text(key)
        return key
    except OSError:
        return secrets.token_urlsafe(48)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SHELFWISE_", env_file=".env", extra="ignore")

    app_name: str = "Shelfwise ILS"
    environment: str = "development"  # development | production | test
    # Defaults to a SQLite file next to the project; use postgresql+psycopg://… in production.
    database_url: str = f"sqlite:///{(BASE_DIR.parent / 'shelfwise.db').as_posix()}"
    secret_key: str = Field(default_factory=_local_secret)
    session_max_age: int = 60 * 60 * 12  # 12 hours
    cookie_secure: bool = False  # set True behind HTTPS
    allowed_hosts: list[str] = ["*"]
    cors_origins: list[str] = []

    # Rate limiting for authentication endpoints
    login_attempts_per_minute: int = 10

    # AI — Claude is used when credentials are available; otherwise local models are used.
    ai_enabled: bool = True
    ai_model: str = "claude-opus-5-5"
    ai_effort: str = "low"
    ai_timeout: float = 60.0
    # Optional outbound metadata lookups (Open Library) for ISBN cataloguing
    metadata_lookup_enabled: bool = True

    currency: str = "INR"
    timezone: str = "Asia/Kolkata"

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    return Settings()
