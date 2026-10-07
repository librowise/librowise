"""Rate-limit storage backends for :class:`shelfwise.security.SlidingWindowLimiter`.

``memory`` (default) keeps exact sliding windows per process — right for a single process.
``database`` (``SHELFWISE_RATE_LIMIT_BACKEND=database``) shares counters between every web
process and host through the ``rate_limit_counters`` table using the *sliding-window counter*
approximation: the current fixed window's hits plus the previous window's hits weighted by how
much of it still overlaps the sliding window. One atomic upsert per check (``INSERT … ON
CONFLICT DO UPDATE … RETURNING``) on both SQLite and PostgreSQL.
"""

from __future__ import annotations

import hashlib
import logging
import time

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_engine
from .models import RateLimitCounter

log = logging.getLogger("shelfwise.ratelimit")

BACKENDS = ("memory", "database")


def backend() -> str:
    name = (get_settings().rate_limit_backend or "memory").lower()
    return name if name in BACKENDS else "memory"


def _key(key: str) -> str:
    return key if len(key) <= 200 else key[:120] + "#" + hashlib.sha256(key.encode()).hexdigest()[:40]


def _upsert(dialect: str):
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        return None
    return insert


def db_allow(key: str, limit: int, window: float, *, now: float | None = None) -> bool:
    """Record a hit for ``key`` and return False when it exceeds ``limit`` per ``window``."""
    engine = get_engine()
    insert = _upsert(engine.dialect.name)
    if insert is None:
        raise RuntimeError(f"database rate limiting is not supported on {engine.dialect.name}")
    now = time.time() if now is None else now
    w = max(int(window), 1)
    start = int(now // w * w)
    elapsed = (now - start) / w
    key = _key(key)
    t = RateLimitCounter.__table__
    stmt = insert(t).values(key=key, window_start=start, hits=1)
    stmt = stmt.on_conflict_do_update(index_elements=[t.c.key, t.c.window_start],
                                      set_={"hits": t.c.hits + 1}).returning(t.c.hits)
    with engine.begin() as conn:
        current = int(conn.execute(stmt).scalar_one())
        previous = conn.scalar(select(t.c.hits).where(t.c.key == key, t.c.window_start == start - w)) or 0
        if previous * (1.0 - elapsed) + current > limit:
            # Rejected attempts do not consume budget (matches the in-memory limiter).
            conn.execute(update(t).where(t.c.key == key, t.c.window_start == start).values(hits=t.c.hits - 1))
            return False
    return True


def db_reset(prefix: str) -> None:
    t = RateLimitCounter.__table__
    with get_engine().begin() as conn:
        conn.execute(delete(t).where(t.c.key.startswith(prefix, autoescape=True)))


def prune_counters(db: Session, older_than: int = 2 * 86400) -> int:
    cutoff = int(time.time()) - older_than
    return db.execute(delete(RateLimitCounter).where(RateLimitCounter.window_start < cutoff)).rowcount or 0
