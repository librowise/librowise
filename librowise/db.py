"""Database engine, session handling and full-text index maintenance.

Two databases are first-class:

* **SQLite** (default) — WAL mode, FTS5 virtual table ``biblio_fts`` with BM25 ranking.
* **PostgreSQL** — ``biblio_search`` table holding a weighted ``tsvector`` (title/ISBN = A,
  authors = B, subjects = C, series/publisher/description = D) behind a GIN index, queried with
  ``websearch_to_tsquery`` + prefix matching and ranked with ``ts_rank_cd``.

Any other SQLAlchemy dialect still works; search then falls back to ``ILIKE`` matching.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event, inspect, text
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
    cur.execute("PRAGMA cache_size=-65536")  # up to 64 MB page cache per connection
    cur.close()
    # Unicode-aware lower() (SQLite's built-in only folds ASCII); used by catalogue filters.
    dbapi_conn.create_function("py_lower", 1, _py_lower, deterministic=True)


def _py_lower(value):
    return value.lower() if isinstance(value, str) else value


def init_engine(url: str | None = None) -> Engine:
    """(Re)create the global engine. Tests call this with an isolated database URL."""
    global _engine, _SessionLocal
    settings = get_settings()
    url = url or settings.database_url
    kwargs: dict = {"future": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        kwargs.update(
            pool_pre_ping=True,
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_max_overflow,
            pool_recycle=settings.db_pool_recycle,
            pool_timeout=settings.db_pool_timeout,
        )
        if url.startswith("postgresql") and settings.db_statement_timeout_ms:
            kwargs["connect_args"] = {
                "application_name": "librowise",
                "options": f"-c statement_timeout={int(settings.db_statement_timeout_ms)}",
            }
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


def dialect_name(bind=None) -> str:
    """``sqlite`` | ``postgresql`` | other dialect name, for an engine, connection or session."""
    if bind is None:
        bind = get_engine()
    elif isinstance(bind, Session):
        bind = bind.get_bind()
    return bind.dialect.name


# --------------------------------------------------------------------------------------
# Full-text search DDL
# --------------------------------------------------------------------------------------

FTS_DDL = [
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS biblio_fts USING fts5(
        title, authors, subjects, description, publisher, isbn, series,
        tokenize='porter unicode61 remove_diacritics 2'
    )
    """,
]

PG_SEARCH_DDL = [
    """
    CREATE TABLE IF NOT EXISTS biblio_search (
        biblio_id integer PRIMARY KEY REFERENCES biblios(id) ON DELETE CASCADE,
        document tsvector NOT NULL,
        title_len smallint NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_biblio_search_document ON biblio_search USING GIN (document)",
]

#: Tables that live outside SQLAlchemy metadata (raw DDL above).
EXTRA_TABLES = {"sqlite": ["biblio_fts"], "postgresql": ["biblio_search"]}


def fts_available(engine: Engine | None = None) -> bool:
    """True when the SQLite FTS5 index is in use (kept for backwards compatibility)."""
    return dialect_name(engine) == "sqlite"


def search_backend(bind=None) -> str:
    """``fts5`` (SQLite), ``tsvector`` (PostgreSQL) or ``like`` (portable fallback)."""
    return {"sqlite": "fts5", "postgresql": "tsvector"}.get(dialect_name(bind), "like")


def create_all() -> None:
    from . import models  # noqa: F401  (register mappers)

    engine = get_engine()
    Base.metadata.create_all(engine)
    ensure_search_structures()


def ensure_search_structures() -> None:
    """Raw-DDL search tables plus any model indexes an existing database lacks (idempotent)."""
    from . import models  # noqa: F401

    engine = get_engine()
    backend = search_backend(engine)
    ddl = FTS_DDL if backend == "fts5" else PG_SEARCH_DDL if backend == "tsvector" else []
    with engine.begin() as conn:
        # create_all() only creates indexes together with new tables; add indexes introduced
        # since an existing database was created (idempotent, cheap catalogue lookups).
        existing = _index_names(conn)
        for table in Base.metadata.sorted_tables:
            for index in table.indexes:
                if index.name not in existing:
                    index.create(conn)
        for stmt in ddl:
            conn.execute(text(stmt))


def _index_names(conn) -> set[str]:
    """Names of existing indexes, including expression indexes the inspector does not report."""
    if conn.dialect.name == "sqlite":
        return set(conn.scalars(text("SELECT name FROM sqlite_master WHERE type = 'index'")))
    if conn.dialect.name == "postgresql":
        return set(conn.scalars(text("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()")))
    insp = inspect(conn)
    return {i["name"] for t in insp.get_table_names() for i in insp.get_indexes(t)}


def drop_all() -> None:
    from . import models  # noqa: F401

    engine = get_engine()
    cascade = " CASCADE" if engine.dialect.name == "postgresql" else ""
    with engine.begin() as conn:
        for table in EXTRA_TABLES.get(engine.dialect.name, []):
            conn.execute(text(f"DROP TABLE IF EXISTS {table}{cascade}"))
    Base.metadata.drop_all(engine)


def truncate_all() -> None:
    """Delete every row from every table (fast per-test reset on PostgreSQL)."""
    from . import models  # noqa: F401

    engine = get_engine()
    quote = engine.dialect.identifier_preparer.quote
    names = [t.name for t in Base.metadata.sorted_tables] + EXTRA_TABLES.get(engine.dialect.name, [])
    with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            conn.execute(text(f"TRUNCATE TABLE {', '.join(quote(n) for n in names)} RESTART IDENTITY CASCADE"))
        else:
            for name in reversed(names):
                conn.execute(text(f"DELETE FROM {quote(name)}"))


def pool_stats(engine: Engine | None = None) -> dict[str, int]:
    """Connection-pool counters for metrics (zeros for pools that do not track them)."""
    pool = (engine or get_engine()).pool
    out = {}
    for key in ("size", "checkedin", "checkedout", "overflow"):
        fn = getattr(pool, key, None)
        try:
            out[key] = int(fn()) if callable(fn) else 0
        except Exception:  # pragma: no cover - pool implementations vary
            out[key] = 0
    return out
