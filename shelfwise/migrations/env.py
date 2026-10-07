"""Alembic environment: runs against Shelfwise's configured engine (or ``sqlalchemy.url``)."""

from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine

from shelfwise import models  # noqa: F401  (register every mapper on Base.metadata)
from shelfwise.db import Base
from shelfwise.migrations import include_object

config = context.config
target_metadata = Base.metadata


def _engine():
    url = config.get_main_option("sqlalchemy.url")
    if url:
        return create_engine(url)
    engine = config.attributes.get("engine")
    if engine is None:
        from shelfwise.db import get_engine

        engine = get_engine()
    return engine


def run_migrations_offline() -> None:
    context.configure(url=str(_engine().url), target_metadata=target_metadata, literal_binds=True,
                      include_object=include_object, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = _engine()
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=include_object,
            render_as_batch=connection.dialect.name == "sqlite",  # ALTER TABLE support on SQLite
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()
        connection.commit()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
