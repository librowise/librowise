"""Versioned schema migrations (Alembic).

* ``python -m shelfwise migrate`` brings any database to the latest revision (``upgrade head``)
  and then (re)creates the search structures that live outside SQLAlchemy metadata.
* Development convenience: when a database has no ``alembic_version`` table, the app creates the
  schema from the models and stamps it at ``head`` (see :func:`prepare_schema`). Production
  deployments (``SHELFWISE_ENVIRONMENT=production``) never auto-create; run ``migrate`` instead.
* New revisions: ``python -m shelfwise makemigration -m "describe change"`` (autogenerate), then
  review the generated file under ``shelfwise/migrations/versions``.
"""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import inspect

log = logging.getLogger("shelfwise.migrations")
HERE = Path(__file__).resolve().parent


def alembic_config(url: str | None = None):
    from alembic.config import Config

    from ..db import get_engine

    cfg = Config()
    cfg.set_main_option("script_location", str(HERE))
    cfg.set_main_option("version_locations", str(HERE / "versions"))
    cfg.attributes["engine"] = get_engine()
    if url:
        cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return cfg


def head_revision() -> str | None:
    from alembic.script import ScriptDirectory

    return ScriptDirectory.from_config(alembic_config()).get_current_head()


def current_revision() -> str | None:
    from alembic.runtime.migration import MigrationContext

    from ..db import get_engine

    with get_engine().connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


def _has_table(name: str) -> bool:
    from ..db import get_engine

    return inspect(get_engine()).has_table(name)


def upgrade(revision: str = "head") -> dict:
    """Apply migrations; adopt pre-migration databases (created by ``create_all``) by stamping."""
    from alembic import command

    from ..db import ensure_search_structures

    cfg = alembic_config()
    adopted = False
    if not _has_table("alembic_version") and _has_table("biblios"):
        # Database created before migrations existed: its tables match the baseline revision.
        command.stamp(cfg, "0001_baseline")
        adopted = True
    before = current_revision()
    command.upgrade(cfg, revision)
    ensure_search_structures()
    return {"from": before, "to": current_revision(), "adopted_legacy_schema": adopted}


def prepare_schema(environment: str) -> None:
    """Startup hook: keep development databases usable without a manual migrate step."""
    from alembic import command

    from ..db import create_all

    if _has_table("alembic_version"):
        cur, head = current_revision(), head_revision()
        if cur != head:
            if environment == "production":
                log.error("Database schema is at %s but code expects %s — run `python -m shelfwise migrate`", cur, head)
            else:
                upgrade()
        return
    if environment == "production":
        log.error("Database is not initialised — run `python -m shelfwise migrate`")
        return
    if _has_table("biblios"):
        upgrade()  # adopt and bring a legacy development database up to date
        return
    create_all()
    command.stamp(alembic_config(), "head")


def make_migration(message: str) -> str:
    from alembic import command

    script = command.revision(alembic_config(), message=message, autogenerate=True)
    return str(script.path) if script is not None else ""
