"""Database engine, session handling and full-text index maintenance."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings


class Base(DeclarativeBase):
    pass


_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def _sqlite_pragmas(dbapi_conn, _record) -> None:  # pragma: no cover - exercised implicitly
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA temp_store=MEMORY")
    cur.close()


def init_engine(url: str | None = None) -> Engine:
    """(Re)create the global engine. Tests call this with an isolated database URL."""
    global _engine, _SessionLocal
    url = url or get_settings().database_url
    kwargs: dict = {"future": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        kwargs.update(pool_pre_ping=True, pool_size=10, max_overflow=20)
    _engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        event.listen(_engine, "connect", _sqlite_pragmas)
    _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def get_engine() -> Engine:
    return _engine or init_engine()


def SessionLocal() -> Session:
    if _SessionLocal is None:
        init_engine()
    assert _SessionLocal is not None
    return _SessionLocal()


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request, rolled back on error."""
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


# --------------------------------------------------------------------------------------
# Full-text search (SQLite FTS5). Postgres deployments fall back to ILIKE queries; a
# tsvector index can be added with a migration without touching the service layer.
# --------------------------------------------------------------------------------------

FTS_DDL = [
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS biblio_fts USING fts5(
        title, authors, subjects, description, publisher, isbn, series,
        tokenize='porter unicode61 remove_diacritics 2'
    )
    """,
]


def fts_available(engine: Engine | None = None) -> bool:
    engine = engine or get_engine()
    return engine.dialect.name == "sqlite"


def create_all() -> None:
    from . import models  # noqa: F401  (register mappers)

    engine = get_engine()
    Base.metadata.create_all(engine)
    if fts_available(engine):
        with engine.begin() as conn:
            for ddl in FTS_DDL:
                conn.execute(text(ddl))


def drop_all() -> None:
    from . import models  # noqa: F401

    engine = get_engine()
    if fts_available(engine):
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS biblio_fts"))
    Base.metadata.drop_all(engine)
