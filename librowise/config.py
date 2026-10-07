"""Application settings, loaded from environment variables (prefix ``LIBROWISE_``) or a ``.env`` file.

Koha keeps 1,000+ runtime "system preferences" in a database table. Librowise keeps a small,
typed set of deployment settings here and a handful of library policies in the ``settings``
table (see :mod:`librowise.services.settings`).
"""

from __future__ import annotations

import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent

# Backwards compatibility: the project was called "Shelfwise" before 1.1. Honour SHELFWISE_* variables
# for deployments that still set them; LIBROWISE_* always wins when both are present.
for _key, _value in list(os.environ.items()):
    if _key.startswith("SHELFWISE_"):
        os.environ.setdefault("LIBROWISE_" + _key[len("SHELFWISE_"):], _value)


def _local_secret() -> str:
    """Development fallback: a random key persisted next to the project so sessions survive
    restarts and are shared by workers. Production deployments set LIBROWISE_SECRET_KEY."""
    path = BASE_DIR.parent / ".librowise_secret"
    try:
        if path.exists():
            return path.read_text().strip()
        key = secrets.token_urlsafe(48)
        path.write_text(key)
        return key
    except OSError:
        return secrets.token_urlsafe(48)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LIBROWISE_", env_file=".env", extra="ignore")

    app_name: str = "Librowise ILS"  # product brand shown in the API docs (package/env names stay "librowise")
    environment: str = "development"  # development | production | test
    # Defaults to a SQLite file next to the project; use postgresql+psycopg://… in production.
    database_url: str = f"sqlite:///{(BASE_DIR.parent / 'librowise.db').as_posix()}"
    secret_key: str = Field(default_factory=_local_secret)
    session_max_age: int = 60 * 60 * 12  # 12 hours
    cookie_secure: bool = False  # set True behind HTTPS
    allowed_hosts: list[str] = ["*"]
    cors_origins: list[str] = []
    # Public base URL (e.g. https://library.example.org) used in e-mailed links such as password resets
    # and as the OpenID Connect redirect base. Set it in production so links never depend on the Host header.
    public_url: str = ""

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

    # ---- circulation services: notice delivery (`python -m librowise send-notices`) ----
    email_backend: str = "console"  # console | smtp
    sms_backend: str = "console"  # console | webhook
    smtp_host: str = "localhost"
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "Librowise Library <no-reply@librowise.local>"
    smtp_starttls: bool = True
    smtp_ssl: bool = False  # implicit TLS (port 465); mutually exclusive with STARTTLS
    smtp_timeout: float = 20.0
    sms_webhook_url: str | None = None  # receives POST {"to", "body", "notice_id", "code"}
    sms_webhook_token: str | None = None  # sent as "Authorization: Bearer <token>"
    sms_webhook_timeout: float = 10.0
    # Self-registration: submissions allowed per client IP per hour
    registrations_per_hour: int = 5

    # ---- platform & operations ----
    # Database pool (ignored for SQLite)
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_pool_recycle: int = 1800
    db_pool_timeout: int = 30
    db_statement_timeout_ms: int = 0  # 0 = no server-side statement timeout (PostgreSQL)
    # PostgreSQL text-search configuration used for the catalogue tsvector (e.g. english, simple)
    pg_search_config: str = "english"
    # Logging: "text" or "json"; level name
    log_format: str = "text"
    log_level: str = "INFO"
    access_log: bool = True
    # /metrics: bearer token for Prometheus (admins can always read it with their session)
    metrics_token: str = ""
    # Rate limiting backend: "memory" (per process) or "database" (shared by all processes)
    rate_limit_backend: str = "memory"
    # Background jobs
    job_poll_interval: float = 2.0  # seconds between queue polls when idle
    job_stale_after: int = 300  # a running job without heartbeat for this long is recovered
    job_heartbeat_interval: float = 15.0
    job_retry_base_seconds: float = 30.0
    job_retry_max_seconds: float = 3600.0
    job_keep_days: int = 30  # finished jobs are pruned after this many days
    # Cron-like schedules ("min hour dom month dow", library time zone). Empty string disables one.
    schedules: dict[str, str] = {
        "nightly": "0 2 * * *",
        "deliver_notices": "*/5 * * * *",
        "maintenance": "30 3 * * *",
    }
    schedule_misfire_grace: int = 3600  # run a missed slot if the scheduler sees it within this many seconds
    require_worker: bool = False  # /readyz fails when no worker heartbeat is fresh
    # Backups
    backup_dir: str = str(BASE_DIR.parent / "backups")
    backup_keep: int = 14
    # Local semantic index snapshot (shared by web processes; built by the ai_warmup job)
    cache_dir: str = str(BASE_DIR.parent / "var")
    semantic_sync_build_limit: int = 20000  # larger catalogues are (re)built in the background

    # ---- design system: book covers (services/covers.py) ----
    # Uploaded files (staff cover uploads) live here; back this directory up with the database.
    media_dir: str = str(BASE_DIR.parent / "media")
    cover_upload_max_bytes: int = 5 * 1024 * 1024
    # Fetch missing covers from Open Library by ISBN (cached under cache_dir/covers). Disable for air-gapped sites.
    covers_remote_enabled: bool = True
    covers_fetch_timeout: float = 4.0
    covers_remote_max_bytes: int = 2 * 1024 * 1024
    covers_negative_ttl: int = 7 * 86400  # remember "no cover for this ISBN" for a week

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def is_postgres(self) -> bool:
        return self.database_url.startswith("postgresql")


@lru_cache
def get_settings() -> Settings:
    return Settings()
