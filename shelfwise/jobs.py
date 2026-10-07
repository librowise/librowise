"""Background jobs: a database-backed queue, a cron-like scheduler and a worker process.

Design
------
* **Queue** — rows in ``jobs``. Workers claim work with ``SELECT … FOR UPDATE SKIP LOCKED`` on
  PostgreSQL and an atomic compare-and-set ``UPDATE … WHERE status IN ('queued','failed')`` on
  SQLite, so a job is only ever executed by one worker at a time.
* **Retries** — a failing job goes back to ``failed`` with an exponential backoff (``run_at``)
  until ``max_attempts`` is reached, then it is ``dead`` and waits for a human (retry/cancel in
  the System page or ``python -m shelfwise jobs retry``).
* **Crash safety** — running jobs carry a heartbeat; a job whose heartbeat is older than
  ``job_stale_after`` (worker killed, machine lost) is recovered and retried.
* **Exactly-once schedules** — each cron slot inserts a ``schedule_runs`` row with a unique
  ``(name, slot_at)`` key in the same transaction as the job, so any number of workers can run
  the scheduler and every slot fires once.
* **Handlers** — other modules register work with ``@register_job("name")``; a handler receives
  ``(db, payload)``, runs inside the job's transaction and returns a JSON-able result.

The handler's database work and the job's ``succeeded`` status commit atomically.
"""

from __future__ import annotations

import logging
import os
import random
import signal
import socket
import threading
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import get_settings
from .db import SessionLocal, dialect_name
from .models import Job, ScheduleRun, WorkerHeartbeat, utcnow

log = logging.getLogger("shelfwise.jobs")

CLAIMABLE = ("queued", "failed")
FINAL = ("succeeded", "dead", "cancelled")
STATUSES = ("queued", "running", "succeeded", "failed", "dead", "cancelled")

# ------------------------------------------------------------------ handler registry


@dataclass(frozen=True)
class JobSpec:
    name: str
    fn: Callable[[Session, dict], Any]
    max_attempts: int = 5
    description: str = ""


HANDLERS: dict[str, JobSpec] = {}


def register_job(name: str, *, max_attempts: int = 5, description: str = ""):
    """Decorator: ``@register_job("nightly")`` registers ``fn(db, payload) -> dict | None``."""

    def deco(fn: Callable[[Session, dict], Any]):
        HANDLERS[name] = JobSpec(name=name, fn=fn, max_attempts=max_attempts,
                                 description=description or (fn.__doc__ or "").strip().split("\n")[0])
        return fn

    return deco


# ------------------------------------------------------------------ queue operations


def enqueue(db: Session, type: str, payload: dict | None = None, *, priority: int = 0,
            run_at: datetime | None = None, delay: float = 0, max_attempts: int | None = None,
            schedule: str | None = None) -> Job:
    """Add a job (flushes; the caller commits). Unknown types are rejected early."""
    if type not in HANDLERS:
        raise ValueError(f"Unknown job type {type!r}")
    when = run_at or utcnow()
    if delay:
        when = when + timedelta(seconds=delay)
    job = Job(type=type, payload=payload or {}, priority=priority, run_at=when, status="queued",
              max_attempts=max_attempts or HANDLERS[type].max_attempts, schedule=schedule)
    db.add(job)
    db.flush()
    return job


def backoff_seconds(attempts: int) -> float:
    s = get_settings()
    base = s.job_retry_base_seconds * (2 ** max(attempts - 1, 0))
    return min(base, s.job_retry_max_seconds) * random.uniform(0.85, 1.15)


def claim(worker_id: str, *, types: list[str] | None = None, now: datetime | None = None) -> int | None:
    """Atomically claim the next due job for ``worker_id``; returns its id or None."""
    now = now or utcnow()
    db = SessionLocal()
    try:
        base = select(Job.id).where(Job.status.in_(CLAIMABLE), Job.run_at <= now)
        if types:
            base = base.where(Job.type.in_(types))
        base = base.order_by(Job.priority.desc(), Job.run_at, Job.id)
        values = dict(status="running", locked_by=worker_id, locked_at=now, heartbeat_at=now,
                      started_at=now, attempts=Job.attempts + 1)
        if dialect_name(db) == "postgresql":
            job_id = db.scalar(base.limit(1).with_for_update(skip_locked=True))
            if job_id is None:
                db.rollback()
                return None
            db.execute(update(Job).where(Job.id == job_id).values(**values))
            db.commit()
            return job_id
        # SQLite & others: compare-and-set; losing a race just means trying the next candidate.
        for job_id in db.scalars(base.limit(8)).all():
            res = db.execute(update(Job).where(Job.id == job_id, Job.status.in_(CLAIMABLE))
                             .values(**values).execution_options(synchronize_session=False))
            if res.rowcount == 1:
                db.commit()
                return job_id
            db.rollback()
        return None
    finally:
        db.close()


def execute(job_id: int, worker_id: str) -> str:
    """Run a claimed job. Returns the outcome: succeeded | failed | dead | lost."""
    db = SessionLocal()
    try:
        job = db.get(Job, job_id)
        if job is None:
            return "lost"
        spec = HANDLERS.get(job.type)
        job_type, payload = job.type, dict(job.payload or {})
        try:
            if spec is None:
                raise LookupError(f"No handler registered for job type {job_type!r}")
            result = spec.fn(db, payload)
            if result is not None and not isinstance(result, dict):
                result = {"result": result}
            db.flush()
            db.refresh(job, with_for_update=True)  # re-read: was it recovered/re-claimed meanwhile?
            if job.status != "running" or job.locked_by != worker_id:
                db.rollback()
                log.warning("job %s was taken away from %s while running; discarding result", job_id, worker_id)
                return "lost"
            job.status, job.result, job.finished_at = "succeeded", _jsonable(result), utcnow()
            job.last_error, job.locked_by, job.locked_at = None, None, None
            db.commit()
            outcome = "succeeded"
        except Exception as exc:
            db.rollback()
            outcome = _record_failure(db, job_id, worker_id, exc)
        _metric(job_type, outcome)
        level = logging.INFO if outcome == "succeeded" else logging.WARNING
        log.log(level, "job %s %s %s", job_id, job_type, outcome, extra={"job_id": job_id, "job_type": job_type})
        return outcome
    finally:
        db.close()


def _record_failure(db: Session, job_id: int, worker_id: str, exc: BaseException) -> str:
    job = db.get(Job, job_id)
    if job is None or job.locked_by != worker_id:
        return "lost"
    tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    job.last_error = tb[-4000:]
    job.locked_by = job.locked_at = None
    job.finished_at = utcnow()
    if job.attempts >= job.max_attempts:
        job.status = "dead"
    else:
        job.status = "failed"
        job.run_at = utcnow() + timedelta(seconds=backoff_seconds(job.attempts))
    db.commit()
    return job.status


def _jsonable(value):
    import json

    if value is None:
        return None
    return json.loads(json.dumps(value, default=str))


def _metric(job_type: str, outcome: str) -> None:
    try:
        from .observability import JOBS_TOTAL

        JOBS_TOTAL.labels(type=job_type, outcome=outcome).inc()
    except Exception:  # pragma: no cover
        pass


def recover_stale(db: Session, *, now: datetime | None = None) -> int:
    """Re-queue (or bury) running jobs whose worker stopped heart-beating."""
    now = now or utcnow()
    cutoff = now - timedelta(seconds=get_settings().job_stale_after)
    n = 0
    stale = select(Job).where(Job.status == "running", func.coalesce(Job.heartbeat_at, Job.locked_at) < cutoff)
    if dialect_name(db) == "postgresql":
        stale = stale.with_for_update(skip_locked=True)
    for job in db.scalars(stale).all():
        job.last_error = f"Recovered: worker {job.locked_by} stopped responding (no heartbeat since {job.heartbeat_at})"
        job.locked_by = job.locked_at = None
        job.status = "dead" if job.attempts >= job.max_attempts else "failed"
        job.run_at = now
        n += 1
    if n:
        log.warning("recovered %s stale job(s)", n)
    return n


def retry(db: Session, job: Job) -> Job:
    if job.status not in ("failed", "dead", "cancelled"):
        raise ValueError("Only failed, dead or cancelled jobs can be retried")
    job.status, job.run_at, job.finished_at = "queued", utcnow(), None
    if job.attempts >= job.max_attempts:
        job.max_attempts = job.attempts + 1
    return job


def cancel(db: Session, job: Job) -> Job:
    if job.status not in CLAIMABLE:
        raise ValueError("Only queued or failed jobs can be cancelled")
    job.status, job.finished_at = "cancelled", utcnow()
    return job


def prune(db: Session, keep_days: int | None = None) -> dict:
    keep_days = keep_days if keep_days is not None else get_settings().job_keep_days
    cutoff = utcnow() - timedelta(days=keep_days)
    db.execute(delete(ScheduleRun).where(ScheduleRun.created_at < cutoff))
    jobs = db.execute(delete(Job).where(Job.status.in_(("succeeded", "cancelled")), Job.finished_at < cutoff)).rowcount
    workers = db.execute(delete(WorkerHeartbeat).where(WorkerHeartbeat.last_seen_at < utcnow() - timedelta(days=1))).rowcount
    return {"jobs_pruned": jobs or 0, "workers_pruned": workers or 0}


def queue_stats(db: Session) -> dict:
    counts = dict(db.execute(select(Job.status, func.count()).group_by(Job.status)).all())
    oldest = db.scalar(select(func.min(Job.run_at)).where(Job.status.in_(CLAIMABLE), Job.run_at <= utcnow()))
    return {"by_status": {s: int(counts.get(s, 0)) for s in STATUSES},
            "lag_seconds": round((utcnow() - oldest).total_seconds(), 1) if oldest else 0.0}


def job_out(job: Job) -> dict:
    return {
        "id": job.id, "type": job.type, "payload": job.payload, "status": job.status, "priority": job.priority,
        "run_at": job.run_at, "attempts": job.attempts, "max_attempts": job.max_attempts,
        "last_error": job.last_error, "result": job.result, "locked_by": job.locked_by,
        "heartbeat_at": job.heartbeat_at, "started_at": job.started_at, "finished_at": job.finished_at,
        "schedule": job.schedule, "created_at": job.created_at,
    }


# ------------------------------------------------------------------ cron schedules

_FIELDS = (("minute", 0, 59), ("hour", 0, 23), ("day", 1, 31), ("month", 1, 12), ("weekday", 0, 6))


class CronExpression:
    """Five-field cron expression (minute hour day-of-month month day-of-week; 0/7 = Sunday).

    Supports ``*``, ``*/n``, ``a-b``, ``a-b/n`` and comma lists. As in cron, when both
    day-of-month and day-of-week are restricted a day matching either fires.
    """

    def __init__(self, expr: str) -> None:
        parts = expr.split()
        if len(parts) != 5:
            raise ValueError(f"Cron expression needs 5 fields: {expr!r}")
        self.expr = expr
        self.sets: list[set[int]] = []
        for raw, (name, lo, hi) in zip(parts, _FIELDS, strict=True):
            values = self._parse(raw, lo, hi if name != "weekday" else 7, name)
            if name == "weekday" and 7 in values:
                values = (values - {7}) | {0}
            self.sets.append(values)
        self.dom_any = parts[2] == "*"
        self.dow_any = parts[4] == "*"

    @staticmethod
    def _parse(raw: str, lo: int, hi: int, name: str) -> set[int]:
        out: set[int] = set()
        for chunk in raw.split(","):
            step = 1
            if "/" in chunk:
                chunk, step_s = chunk.split("/", 1)
                step = int(step_s)
                if step < 1:
                    raise ValueError(f"Bad step in {name}")
            if chunk in ("*", ""):
                a, b = lo, hi
            elif "-" in chunk:
                a, b = (int(x) for x in chunk.split("-", 1))
            else:
                a = b = int(chunk)
                if step > 1:
                    b = hi
            if a < lo or b > hi or a > b:
                raise ValueError(f"{name} out of range in {raw!r}")
            out.update(range(a, b + 1, step))
        return out

    def matches(self, dt: datetime) -> bool:
        minute, hour, dom, month, dow = self.sets
        if dt.minute not in minute or dt.hour not in hour or dt.month not in month:
            return False
        return self._day_ok(dt)

    def _day_ok(self, dt: datetime) -> bool:
        dom_ok = dt.day in self.sets[2]
        dow_ok = (dt.isoweekday() % 7) in self.sets[4]
        if self.dom_any or self.dow_any:
            return dom_ok and dow_ok
        return dom_ok or dow_ok

    def next_after(self, dt: datetime) -> datetime | None:
        """First matching minute strictly after ``dt`` (searches up to 5 years)."""
        t = dt.replace(second=0, microsecond=0) + timedelta(minutes=1)
        limit = t + timedelta(days=366 * 5)
        while t < limit:
            if t.month not in self.sets[3]:
                t = (t.replace(day=1, hour=0, minute=0) + timedelta(days=32)).replace(day=1)
                continue
            if not self._day_ok(t):
                t = (t + timedelta(days=1)).replace(hour=0, minute=0)
                continue
            if t.hour not in self.sets[1]:
                t = (t + timedelta(hours=1)).replace(minute=0)
                continue
            if t.minute not in self.sets[0]:
                t += timedelta(minutes=1)
                continue
            return t
        return None

    def latest_at_or_before(self, dt: datetime, window_seconds: int) -> datetime | None:
        """Most recent matching minute in ``(dt - window, dt]``."""
        t = dt.replace(second=0, microsecond=0)
        floor = dt - timedelta(seconds=window_seconds)
        while t > floor:
            if self.matches(t):
                return t
            t -= timedelta(minutes=1)
        return None


def library_tz():
    from zoneinfo import ZoneInfo

    try:
        return ZoneInfo(get_settings().timezone)
    except Exception:  # pragma: no cover - unknown zone or missing tzdata
        return UTC


def _to_utc_naive(local: datetime) -> datetime:
    return local.astimezone(UTC).replace(tzinfo=None)


def schedules() -> dict[str, CronExpression]:
    out = {}
    for name, expr in (get_settings().schedules or {}).items():
        if not expr:
            continue
        try:
            out[name] = CronExpression(expr)
        except ValueError as exc:
            log.error("invalid schedule %s=%r: %s", name, expr, exc)
    return out


def schedule_status(db: Session, now: datetime | None = None) -> list[dict]:
    now = now or utcnow()
    tz = library_tz()
    local_now = now.replace(tzinfo=UTC).astimezone(tz)
    out = []
    for name, cron in schedules().items():
        last = db.scalar(select(ScheduleRun).where(ScheduleRun.name == name).order_by(ScheduleRun.slot_at.desc()).limit(1))
        last_job = db.get(Job, last.job_id) if last and last.job_id else None
        nxt = cron.next_after(local_now)
        out.append({
            "name": name, "cron": cron.expr, "timezone": str(tz), "registered": name in HANDLERS,
            "next_run": _to_utc_naive(nxt) if nxt else None,
            "last_slot": last.slot_at if last else None,
            "last_status": last_job.status if last_job else None,
            "last_job_id": last_job.id if last_job else None,
        })
    return out


def scheduler_tick(now: datetime | None = None) -> list[tuple[str, int]]:
    """Enqueue every schedule whose current slot has not fired yet. Safe to call from any number
    of processes concurrently: the unique (name, slot_at) key lets exactly one of them win."""
    now = now or utcnow()
    tz = library_tz()
    grace = get_settings().schedule_misfire_grace
    local_now = now.replace(tzinfo=UTC).astimezone(tz)
    fired: list[tuple[str, int]] = []
    for name, cron in schedules().items():
        if name not in HANDLERS:
            continue
        slot_local = cron.latest_at_or_before(local_now, grace)
        if slot_local is None:
            continue
        slot = _to_utc_naive(slot_local)
        db = SessionLocal()
        try:
            if db.scalar(select(ScheduleRun.id).where(ScheduleRun.name == name, ScheduleRun.slot_at == slot)):
                continue
            run = ScheduleRun(name=name, slot_at=slot)
            db.add(run)
            db.flush()  # unique violation here means another scheduler won the slot
            job = enqueue(db, name, {"slot": slot.isoformat()}, schedule=name, priority=5)
            run.job_id = job.id
            db.commit()
            fired.append((name, job.id))
            log.info("schedule %s fired for slot %s (job %s)", name, slot.isoformat(), job.id)
        except IntegrityError:
            db.rollback()
        finally:
            db.close()
    return fired


# ------------------------------------------------------------------ worker


def worker_status(db: Session, now: datetime | None = None) -> list[dict]:
    now = now or utcnow()
    fresh = timedelta(seconds=max(get_settings().job_heartbeat_interval * 4, 60))
    rows = db.scalars(select(WorkerHeartbeat).order_by(WorkerHeartbeat.last_seen_at.desc())).all()
    return [{"worker_id": w.worker_id, "hostname": w.hostname, "pid": w.pid, "concurrency": w.concurrency,
             "started_at": w.started_at, "last_seen_at": w.last_seen_at,
             "age_seconds": round((now - w.last_seen_at).total_seconds(), 1),
             "alive": (now - w.last_seen_at) <= fresh and not w.stopping,
             "jobs_succeeded": w.jobs_succeeded, "jobs_failed": w.jobs_failed,
             "current_jobs": w.current_jobs or [], "stopping": w.stopping} for w in rows]


def latest_heartbeat_age(db: Session, now: datetime | None = None) -> float | None:
    last = db.scalar(select(func.max(WorkerHeartbeat.last_seen_at)).where(WorkerHeartbeat.stopping.is_(False)))
    return None if last is None else ((now or utcnow()) - last).total_seconds()


class Worker:
    """Runs ``concurrency`` job threads plus the scheduler, heartbeat and stale-lock recovery."""

    def __init__(self, concurrency: int = 1, *, scheduler: bool = True, types: list[str] | None = None,
                 burst: bool = False, poll_interval: float | None = None) -> None:
        self.concurrency = max(1, concurrency)
        self.scheduler = scheduler
        self.types = types
        self.burst = burst
        self.poll_interval = poll_interval if poll_interval is not None else get_settings().job_poll_interval
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:6]}"
        self.stop_event = threading.Event()
        self._current: set[int] = set()
        self._lock = threading.Lock()
        self.succeeded = 0
        self.failed = 0
        self._prev_handlers: dict = {}

    # -- lifecycle
    def install_signal_handlers(self) -> None:
        def handler(signum, _frame):
            log.info("worker %s received signal %s; finishing current jobs", self.worker_id, signum)
            self.stop()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                self._prev_handlers[sig] = signal.signal(sig, handler)
            except (ValueError, OSError):  # pragma: no cover - not in main thread / unsupported
                pass

    def _restore_signal_handlers(self) -> None:
        for sig, prev in self._prev_handlers.items():
            try:
                signal.signal(sig, prev)
            except (ValueError, OSError, TypeError):  # pragma: no cover
                pass
        self._prev_handlers.clear()

    def stop(self) -> None:
        self.stop_event.set()

    def run(self) -> dict:
        log.info("worker %s starting (concurrency=%s, scheduler=%s)", self.worker_id, self.concurrency, self.scheduler)
        self._housekeeping()  # register heartbeat, fire due schedules, recover stale jobs
        threads = [threading.Thread(target=self._loop, name=f"job-{i}", daemon=True) for i in range(self.concurrency)]
        for t in threads:
            t.start()
        interval = min(get_settings().job_heartbeat_interval, 15.0)
        while not self.stop_event.is_set():
            try:
                self._housekeeping()
            except Exception:  # pragma: no cover - keep the worker alive on transient DB errors
                log.exception("worker housekeeping failed")
            if self.burst and not any(t.is_alive() for t in threads):
                break
            self.stop_event.wait(min(interval, 1.0) if self.burst else interval)
        self.stop_event.set()
        for t in threads:
            t.join()
        self._beat(stopping=True)
        self._restore_signal_handlers()
        log.info("worker %s stopped (%s succeeded, %s failed)", self.worker_id, self.succeeded, self.failed)
        return {"succeeded": self.succeeded, "failed": self.failed}

    def _housekeeping(self) -> None:
        if self.scheduler:
            scheduler_tick()
        db = SessionLocal()
        try:
            recover_stale(db)
            db.commit()
        finally:
            db.close()
        self._beat()

    def _loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                job_id = claim(self.worker_id, types=self.types)
            except Exception:  # pragma: no cover - transient DB error
                log.exception("claim failed")
                self.stop_event.wait(self.poll_interval)
                continue
            if job_id is None:
                if self.burst:
                    return
                self.stop_event.wait(self.poll_interval)
                continue
            with self._lock:
                self._current.add(job_id)
            try:
                outcome = execute(job_id, self.worker_id)
            finally:
                with self._lock:
                    self._current.discard(job_id)
            with self._lock:
                if outcome == "succeeded":
                    self.succeeded += 1
                elif outcome in ("failed", "dead"):
                    self.failed += 1

    def _beat(self, stopping: bool = False) -> None:
        now = utcnow()
        with self._lock:
            current = sorted(self._current)
        db = SessionLocal()
        try:
            hb = db.get(WorkerHeartbeat, self.worker_id)
            if hb is None:
                hb = WorkerHeartbeat(worker_id=self.worker_id, hostname=socket.gethostname(), pid=os.getpid(),
                                     concurrency=self.concurrency, started_at=now)
                db.add(hb)
            hb.last_seen_at = now
            hb.jobs_succeeded, hb.jobs_failed = self.succeeded, self.failed
            hb.current_jobs = current
            hb.stopping = stopping
            if current:
                db.execute(update(Job).where(Job.id.in_(current), Job.locked_by == self.worker_id)
                           .values(heartbeat_at=now).execution_options(synchronize_session=False))
            db.commit()
        except Exception:  # pragma: no cover
            db.rollback()
            log.exception("heartbeat failed")
        finally:
            db.close()


def run_pending(*, types: list[str] | None = None, limit: int = 1000) -> dict:
    """Execute due jobs in the current thread until the queue is empty (tests, cron, CLI)."""
    worker_id = f"inline:{os.getpid()}:{uuid.uuid4().hex[:6]}"
    out = {"succeeded": 0, "failed": 0, "dead": 0, "lost": 0}
    for _ in range(limit):
        job_id = claim(worker_id, types=types)
        if job_id is None:
            break
        outcome = execute(job_id, worker_id)
        out[outcome] = out.get(outcome, 0) + 1
    return out


# ------------------------------------------------------------------ built-in handlers


@register_job("nightly", max_attempts=3, description="Courtesy/overdue notices, hold expiry, auto-renewals, anonymisation")
def _nightly(db: Session, payload: dict) -> dict:
    from .services import audit
    from .services.circulation import run_nightly

    stats = run_nightly(db)
    audit.record(db, "nightly_job", "system", None, source="scheduler", **stats)
    return stats


@register_job("reindex", max_attempts=3, description="Rebuild the full-text search index")
def _reindex(db: Session, payload: dict) -> dict:
    from .ai import semantic
    from .services.catalog import reindex_all

    n = reindex_all(db)
    semantic.index.invalidate()
    return {"indexed": n}


@register_job("ai_warmup", max_attempts=2, description="Build and persist the semantic (AI) search index")
def _ai_warmup(db: Session, payload: dict) -> dict:
    from .ai import semantic

    return semantic.index.warm(db)


@register_job("deliver_notices", max_attempts=5, description="Send pending patron notices (email/SMS)")
def _deliver_notices(db: Session, payload: dict) -> dict:
    try:
        from .services import notices  # provided by the notices module when installed
    except ImportError:
        return {"skipped": "notice delivery module not installed"}
    deliver = getattr(notices, "deliver_pending", None)
    if deliver is None:
        return {"skipped": "notices.deliver_pending not available"}
    result = deliver(db)
    return result if isinstance(result, dict) else {"delivered": result}


@register_job("backup", max_attempts=2, description="Back up the database to the backup directory")
def _backup(db: Session, payload: dict) -> dict:
    from . import backup

    info = backup.create_backup(dest=payload.get("dest"), keep=payload.get("keep"))
    return {k: v for k, v in info.items() if k in ("file", "size", "sha256", "pruned", "kind")}


@register_job("maintenance", max_attempts=3, description="Prune finished jobs, schedule history and rate-limit counters")
def _maintenance(db: Session, payload: dict) -> dict:
    from .ratelimit import prune_counters

    out = prune(db, payload.get("keep_days"))
    out["rate_limit_counters_pruned"] = prune_counters(db)
    return out
