"""System operations API: job queue, scheduler, workers, health, metrics, database and backups.

Everything here requires the ``jobs:manage`` permission (administrators). ``/metrics`` (outside
``/api/v1``) accepts either the ``LIBROWISE_METRICS_TOKEN`` bearer token or an admin session.
"""

from __future__ import annotations

import hmac
import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from .. import __version__, jobs
from ..config import get_settings
from ..db import get_db, get_engine, pool_stats, search_backend
from ..deps import client_ip, optional_user, require
from ..errors import NotFound
from ..models import Biblio, Item, Job, Loan, Patron
from ..observability import PROCESS_START, latency_summary, render_metrics
from ..security import has_permission
from ..services import audit

router = APIRouter(prefix="/system", tags=["system"])
ops_router = APIRouter(include_in_schema=False)
MANAGE = require("jobs:manage")


# ------------------------------------------------------------------ health


def readiness(db: Session | None = None) -> tuple[bool, dict]:
    """Checks used by ``/readyz`` and the System page: database round-trip and worker heartbeat."""
    checks: dict = {}
    ok = True
    started = time.perf_counter()
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        checks["database"] = {"ok": True, "latency_ms": round((time.perf_counter() - started) * 1000, 1)}
    except Exception as exc:  # pragma: no cover - exercised when the database is down
        return False, {"database": {"ok": False, "error": type(exc).__name__}}
    settings = get_settings()
    own = db is None
    from ..db import SessionLocal

    db = db or SessionLocal()
    try:
        age = jobs.latest_heartbeat_age(db)
        lag = jobs.queue_stats(db)["lag_seconds"]
    except Exception as exc:  # tables missing during first start-up
        age, lag = None, 0.0
        checks["jobs"] = {"ok": False, "error": type(exc).__name__}
    finally:
        if own:
            db.close()
    limit = max(settings.job_heartbeat_interval * 4, 60)
    worker_ok = age is not None and age <= limit
    checks["worker"] = {"ok": worker_ok, "required": settings.require_worker,
                        "heartbeat_age_seconds": None if age is None else round(age, 1), "queue_lag_seconds": lag}
    if settings.require_worker and not worker_ok:
        ok = False
    return ok, checks


# ------------------------------------------------------------------ metrics


def _metrics_allowed(request: Request, user: Patron | None) -> bool:
    token = get_settings().metrics_token
    auth = request.headers.get("authorization", "")
    if token and auth.lower().startswith("bearer ") and hmac.compare_digest(auth[7:].strip(), token):
        return True
    return has_permission(user, "jobs:manage")


@ops_router.get("/metrics")
def metrics(request: Request, user: Patron | None = Depends(optional_user)):
    if not _metrics_allowed(request, user):
        raise HTTPException(401 if user is None else 403, "Metrics require the metrics token or an administrator session",
                            headers={"WWW-Authenticate": "Bearer"} if user is None else None)
    return PlainTextResponse(render_metrics(), media_type="text/plain; version=0.0.4; charset=utf-8")


# ------------------------------------------------------------------ overview


def database_info(db: Session) -> dict:
    engine = get_engine()
    dialect = engine.dialect.name
    info: dict = {"dialect": dialect, "url": engine.url.render_as_string(hide_password=True),
                  "search_backend": search_backend(db), "pool": pool_stats(engine)}
    try:
        if dialect == "sqlite":
            info["server_version"] = db.scalar(text("SELECT sqlite_version()"))
            info["size_bytes"] = int(db.scalar(text("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()")) or 0)
            info["journal_mode"] = db.scalar(text("PRAGMA journal_mode"))
        elif dialect == "postgresql":
            info["server_version"] = db.scalar(text("SHOW server_version"))
            info["size_bytes"] = int(db.scalar(text("SELECT pg_database_size(current_database())")) or 0)
            info["connections"] = int(db.scalar(text("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()")) or 0)
    except Exception:  # pragma: no cover - restricted database permissions
        pass
    info["rows"] = {
        "biblios": db.scalar(select(func.count()).select_from(Biblio)),
        "items": db.scalar(select(func.count()).select_from(Item)),
        "patrons": db.scalar(select(func.count()).select_from(Patron)),
        "loans": db.scalar(select(func.count()).select_from(Loan)),
        "jobs": db.scalar(select(func.count()).select_from(Job)),
    }
    return info


@router.get("/overview")
def overview(db: Session = Depends(get_db), _: Patron = Depends(MANAGE)):
    from .. import backup

    ready, checks = readiness(db)
    s = get_settings()
    try:
        backups = backup.list_backups()[:20]
    except OSError:
        backups = []
    return {
        "version": __version__,
        "environment": s.environment,
        "uptime_seconds": round(time.time() - PROCESS_START),
        "ready": ready,
        "checks": checks,
        "database": database_info(db),
        "queue": jobs.queue_stats(db),
        "schedules": jobs.schedule_status(db),
        "workers": jobs.worker_status(db),
        "job_types": [{"type": k, "description": v.description, "max_attempts": v.max_attempts}
                      for k, v in sorted(jobs.HANDLERS.items())],
        "latency": latency_summary(),
        "rate_limit_backend": s.rate_limit_backend,
        "log_format": s.log_format,
        "metrics_token_configured": bool(s.metrics_token),
        "backups": backups,
        "backup_dir": s.backup_dir,
    }


# ------------------------------------------------------------------ jobs


@router.get("/jobs")
def list_jobs(status: str | None = Query(default=None, pattern="^(queued|running|succeeded|failed|dead|cancelled)$"),
              type: str | None = Query(default=None, max_length=64), page: int = Query(default=1, ge=1, le=10000),
              per_page: int = Query(default=25, ge=1, le=200), db: Session = Depends(get_db),
              _: Patron = Depends(MANAGE)):
    stmt = select(Job)
    if status:
        stmt = stmt.where(Job.status == status)
    if type:
        stmt = stmt.where(Job.type == type)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Job.id.desc()).offset((page - 1) * per_page).limit(per_page)).all()
    return {"total": total, "page": page, "per_page": per_page, "results": [jobs.job_out(j) for j in rows]}


class EnqueueIn(BaseModel):
    type: str = Field(min_length=1, max_length=64)
    payload: dict = Field(default_factory=dict)
    priority: int = Field(default=0, ge=-100, le=100)
    delay_seconds: int = Field(default=0, ge=0, le=7 * 86400)


@router.post("/jobs", status_code=201)
def enqueue(body: EnqueueIn, request: Request, db: Session = Depends(get_db), user: Patron = Depends(MANAGE)):
    if body.type not in jobs.HANDLERS:
        raise HTTPException(422, f"Unknown job type {body.type!r}")
    job = jobs.enqueue(db, body.type, body.payload, priority=body.priority, delay=body.delay_seconds)
    audit.record(db, "job_enqueue", "job", job.id, actor=user, ip=client_ip(request), type=body.type)
    db.commit()
    return jobs.job_out(job)


def _job(db: Session, job_id: int) -> Job:
    job = db.get(Job, job_id)
    if job is None:
        raise NotFound("Job not found")
    return job


@router.get("/jobs/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db), _: Patron = Depends(MANAGE)):
    return jobs.job_out(_job(db, job_id))


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: int, request: Request, db: Session = Depends(get_db), user: Patron = Depends(MANAGE)):
    job = _job(db, job_id)
    try:
        jobs.retry(db, job)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    audit.record(db, "job_retry", "job", job.id, actor=user, ip=client_ip(request), type=job.type)
    db.commit()
    return jobs.job_out(job)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int, request: Request, db: Session = Depends(get_db), user: Patron = Depends(MANAGE)):
    job = _job(db, job_id)
    try:
        jobs.cancel(db, job)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    audit.record(db, "job_cancel", "job", job.id, actor=user, ip=client_ip(request), type=job.type)
    db.commit()
    return jobs.job_out(job)


@router.get("/backups")
def backups(_: Patron = Depends(MANAGE)):
    """Read-only listing. Backup files are never served over HTTP."""
    from .. import backup

    return {"backup_dir": get_settings().backup_dir, "results": backup.list_backups()}
