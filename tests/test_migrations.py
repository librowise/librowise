"""Migrations must build exactly the schema the models describe, and adopt pre-migration databases."""

from __future__ import annotations

import pytest
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import inspect

from librowise import db as dbmod
from librowise import migrations


@pytest.fixture()
def fresh_db(tmp_path):
    url = f"sqlite:///{(tmp_path / 'migrate.db').as_posix()}"
    engine = dbmod.init_engine(url)
    yield engine
    engine.dispose()


def _schema_diff(engine) -> list:
    with engine.connect() as conn:
        ctx = MigrationContext.configure(conn, opts={"include_object": migrations.include_object, "compare_type": False})
        diffs = compare_metadata(ctx, dbmod.Base.metadata)
    # SQLite cannot reflect expression indexes (e.g. lower(title)); ensure_search_structures creates them.
    return [d for d in diffs if not (d[0] == "add_index" and d[1].name == "ix_biblios_title_lower")]


def test_upgrade_from_empty_matches_models(fresh_db):
    result = migrations.upgrade()
    assert result["to"] == migrations.head_revision() and not result["adopted_legacy_schema"]
    assert _schema_diff(fresh_db) == []
    names = set(inspect(fresh_db).get_table_names())
    assert {"biblios", "loans", "holds", "jobs", "authorities", "sip_accounts", "kiosk_devices", "biblio_fts"} <= names


def test_legacy_create_all_database_is_adopted(fresh_db):
    dbmod.create_all()  # how databases were created before migrations existed
    result = migrations.upgrade()
    assert result["adopted_legacy_schema"] is True
    assert migrations.current_revision() == migrations.head_revision()
    assert _schema_diff(fresh_db) == []


def test_prepare_schema_development_creates_and_stamps(fresh_db):
    migrations.prepare_schema("development")
    assert migrations.current_revision() == migrations.head_revision()
    assert inspect(fresh_db).has_table("patrons")


def test_prepare_schema_production_never_auto_creates(fresh_db):
    migrations.prepare_schema("production")
    assert not inspect(fresh_db).has_table("patrons")


def test_models_have_no_unmigrated_changes(fresh_db):
    """Fails when a model changed without a new migration: run `python -m librowise makemigration`."""
    migrations.upgrade()
    assert _schema_diff(fresh_db) == []
