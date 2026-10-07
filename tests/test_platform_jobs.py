"""Background jobs: queue, retries, claiming, stale-lock recovery, cron schedules, worker, CLI."""

from __future__ import annotations

import threading
from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select

from shelfwise import jobs
from shelfwise.config import get_settings
from shelfwise.models import AuditLog, Job, ScheduleRun, WorkerHeartbeat, utcnow

CALLS: list[dict] = []


@jobs.register_job("test_echo", max_attempts=3)
def _echo(db, payload):
    CALLS.append(payload)
    return {"echo": payload.get("value")}


@jobs.register_job("test_fail", max_attempts=2)
def _fail(db, payload):
    raise RuntimeError("boom")


@pytest.fixture(autouse=True)
def _clear_calls():
    CALLS.clear()
    yield


def test_enqueue_and_run_success(db):
    job = jobs.enqueue(db, "test_echo", {"value": 42})
    db.commit()
    assert job.status == "queued" and job.max_attempts == 3
    out = jobs.run_pending()
    assert out["succeeded"] == 1
    db.expire_all()
    job = db.get(Job, job.id)
    assert job.status == "succeeded" and job.result == {"echo": 42} and job.attempts == 1
    assert job.locked_by is None and job.finished_at is not None


def test_unknown_job_type_rejected(db):
    with pytest.raises(ValueError):
        jobs.enqueue(db, "no_such_job")


def test_failure_backoff_dead_and_retry(db):
    job = jobs.enqueue(db, "test_fail")
    db.commit()
    assert jobs.run_pending()["failed"] == 1
    db.expire_all()
    job = db.get(Job, job.id)
    assert job.status == "failed" and job.attempts == 1 and "boom" in job.last_error
    assert job.run_at > utcnow() + timedelta(seconds=10)  # exponential backoff pushed it out
    assert jobs.run_pending()["succeeded"] == 0  # not due yet
    job.run_at = utcnow() - timedelta(seconds=1)
    db.commit()
    assert jobs.run_pending()["dead"] == 1
    db.expire_all()
    job = db.get(Job, job.id)
    assert job.status == "dead" and job.attempts == 2
    jobs.retry(db, job)
    db.commit()
    assert job.status == "queued" and job.max_attempts == 3
    with pytest.raises(ValueError):
        jobs.retry(db, job)  # queued jobs cannot be retried
    jobs.cancel(db, job)
    db.commit()
    assert job.status == "cancelled"
    assert jobs.run_pending() == {"succeeded": 0, "failed": 0, "dead": 0, "lost": 0}


def test_backoff_grows_and_is_capped():
    s = get_settings()
    assert jobs.backoff_seconds(1) < jobs.backoff_seconds(4)
    assert jobs.backoff_seconds(50) <= s.job_retry_max_seconds * 1.15


def test_priority_order(db):
    low = jobs.enqueue(db, "test_echo", {"value": "low"})
    high = jobs.enqueue(db, "test_echo", {"value": "high"}, priority=10)
    later = jobs.enqueue(db, "test_echo", {"value": "later"}, delay=3600)
    db.commit()
    assert jobs.claim("w1") == high.id
    assert jobs.claim("w1") == low.id
    assert jobs.claim("w1") is None  # the delayed job is not due
    assert later.id


def test_concurrent_claims_never_double_execute(db):
    ids = {jobs.enqueue(db, "test_echo", {"value": i}).id for i in range(24)}
    db.commit()
    claimed: list[int] = []
    lock = threading.Lock()

    def worker(name):
        while (jid := jobs.claim(name)) is not None:
            with lock:
                claimed.append(jid)

    threads = [threading.Thread(target=worker, args=(f"w{i}",)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(claimed) == sorted(ids)  # every job exactly once
    assert db.scalar(select(func.count()).select_from(Job).where(Job.status == "running")) == 24


def test_stale_running_job_is_recovered(db):
    job = jobs.enqueue(db, "test_echo", {"value": 1})
    db.commit()
    assert jobs.claim("dead-worker") == job.id
    db.expire_all()
    job = db.get(Job, job.id)
    job.heartbeat_at = job.locked_at = utcnow() - timedelta(seconds=get_settings().job_stale_after + 5)
    db.commit()
    assert jobs.recover_stale(db) == 1
    db.commit()
    assert job.status == "failed" and job.locked_by is None and "stopped responding" in job.last_error
    assert jobs.run_pending()["succeeded"] == 1


def test_result_discarded_when_lock_was_lost(db):
    job = jobs.enqueue(db, "test_echo", {"value": 1})
    db.commit()
    jobs.claim("w-a")
    db.expire_all()
    db.get(Job, job.id).locked_by = "w-b"  # e.g. recovered and re-claimed elsewhere
    db.commit()
    assert jobs.execute(job.id, "w-a") == "lost"


@jobs.register_job("test_hijack", max_attempts=1)
def _hijack(db, payload):
    from shelfwise.db import SessionLocal

    other = SessionLocal()  # simulates stale-lock recovery + re-claim by another worker mid-run
    try:
        other.get(Job, payload["job_id"]).locked_by = "someone-else"
        other.commit()
    finally:
        other.close()
    return {"ok": True}


def test_lock_lost_during_execution_discards_result(db):
    job = jobs.enqueue(db, "test_hijack")
    job.payload = {"job_id": job.id}
    db.commit()
    assert jobs.run_pending()["lost"] == 1
    db.expire_all()
    assert db.get(Job, job.id).status == "running" and db.get(Job, job.id).result is None


# ------------------------------------------------------------------ cron


def test_cron_parsing_and_matching():
    c = jobs.CronExpression("*/15 2-4 * * 1-5")
    assert c.matches(datetime(2026, 10, 5, 2, 30))  # Monday
    assert not c.matches(datetime(2026, 10, 4, 2, 30))  # Sunday
    assert not c.matches(datetime(2026, 10, 5, 2, 31))
    assert c.next_after(datetime(2026, 10, 5, 4, 45)) == datetime(2026, 10, 6, 2, 0)
    nightly = jobs.CronExpression("0 2 * * *")
    assert nightly.next_after(datetime(2026, 12, 31, 3, 0)) == datetime(2027, 1, 1, 2, 0)
    assert nightly.latest_at_or_before(datetime(2026, 10, 5, 2, 40), 3600) == datetime(2026, 10, 5, 2, 0)
    assert nightly.latest_at_or_before(datetime(2026, 10, 5, 4, 0), 3600) is None
    # Day-of-month OR day-of-week when both are restricted (classic cron semantics)
    both = jobs.CronExpression("0 0 1 * 0")
    assert both.matches(datetime(2026, 10, 1, 0, 0)) and both.matches(datetime(2026, 10, 4, 0, 0))
    assert jobs.CronExpression("0 0 * * 7").matches(datetime(2026, 10, 4, 0, 0))  # 7 = Sunday
    assert jobs.CronExpression("30 3 29 2 *").next_after(datetime(2026, 1, 1)) == datetime(2028, 2, 29, 3, 30)
    for bad in ("* * *", "61 * * * *", "* 24 * * *", "*/0 * * * *"):
        with pytest.raises(ValueError):
            jobs.CronExpression(bad)


def test_scheduler_fires_each_slot_exactly_once(db, monkeypatch):
    monkeypatch.setenv("SHELFWISE_SCHEDULES", '{"test_echo": "*/5 * * * *", "nightly": ""}')
    monkeypatch.setenv("SHELFWISE_TIMEZONE", "UTC")
    get_settings.cache_clear()
    now = datetime(2026, 10, 7, 10, 7, 30)
    results: list = []

    def tick():
        results.extend(jobs.scheduler_tick(now))

    threads = [threading.Thread(target=tick) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    tick()  # a later tick in the same slot does nothing
    assert len(results) == 1 and results[0][0] == "test_echo"
    run = db.scalar(select(ScheduleRun))
    assert run.slot_at == datetime(2026, 10, 7, 10, 5) and run.job_id == results[0][1]
    assert db.get(Job, run.job_id).schedule == "test_echo"
    jobs.scheduler_tick(now + timedelta(minutes=5))  # next slot fires
    assert db.scalar(select(func.count()).select_from(ScheduleRun)) == 2
    status = {s["name"]: s for s in jobs.schedule_status(db, now + timedelta(minutes=5))}
    assert status["test_echo"]["next_run"] == datetime(2026, 10, 7, 10, 15)
    assert "nightly" not in status  # disabled by an empty expression
    get_settings.cache_clear()


def test_schedule_uses_library_time_zone(db, monkeypatch):
    monkeypatch.setenv("SHELFWISE_SCHEDULES", '{"test_echo": "0 2 * * *"}')
    monkeypatch.setenv("SHELFWISE_TIMEZONE", "Asia/Kolkata")
    get_settings.cache_clear()
    # 02:10 IST == 20:40 UTC the previous day
    fired = jobs.scheduler_tick(datetime(2026, 10, 6, 20, 40))
    assert len(fired) == 1
    assert db.scalar(select(ScheduleRun.slot_at)) == datetime(2026, 10, 6, 20, 30)
    get_settings.cache_clear()


# ------------------------------------------------------------------ worker & handlers


def test_worker_burst_runs_jobs_and_heartbeats(db):
    for i in range(6):
        jobs.enqueue(db, "test_echo", {"value": i})
    db.commit()
    w = jobs.Worker(concurrency=3, scheduler=False, burst=True, poll_interval=0.05)
    stats = w.run()
    assert stats == {"succeeded": 6, "failed": 0}
    assert sorted(c["value"] for c in CALLS) == list(range(6))
    hb = db.scalar(select(WorkerHeartbeat).where(WorkerHeartbeat.worker_id == w.worker_id))
    assert hb is not None and hb.stopping and hb.jobs_succeeded == 6
    assert jobs.worker_status(db)[0]["alive"] is False  # stopped workers are not alive


def test_worker_stops_on_request(db):
    w = jobs.Worker(concurrency=1, scheduler=False, poll_interval=0.05)
    t = threading.Thread(target=w.run)
    t.start()
    w.stop()  # what the SIGTERM/SIGINT handler does
    t.join(timeout=20)
    assert not t.is_alive()


def test_builtin_handlers(db, lib, make_book):
    make_book("Indexed Title")
    for name in ("nightly", "reindex", "deliver_notices", "maintenance"):
        jobs.enqueue(db, name)
    db.commit()
    out = jobs.run_pending()
    assert out["succeeded"] == 4, db.scalars(select(Job.last_error)).all()
    results = {j.type: j.result for j in db.scalars(select(Job))}
    assert results["reindex"]["indexed"] == 1
    assert "holds_expired" in results["nightly"]
    assert "jobs_pruned" in results["maintenance"]
    assert "skipped" in results["deliver_notices"] or results["deliver_notices"] is not None
    assert db.scalar(select(AuditLog).where(AuditLog.action == "nightly_job")) is not None
    assert {"nightly", "reindex", "ai_warmup", "deliver_notices", "backup", "maintenance"} <= set(jobs.HANDLERS)


def test_queue_stats_and_prune(db):
    old = jobs.enqueue(db, "test_echo")
    db.commit()
    jobs.run_pending()
    db.expire_all()
    db.get(Job, old.id).finished_at = utcnow() - timedelta(days=90)
    jobs.enqueue(db, "test_echo")
    db.commit()
    stats = jobs.queue_stats(db)
    assert stats["by_status"]["queued"] == 1 and stats["by_status"]["succeeded"] == 1
    assert jobs.prune(db, keep_days=30)["jobs_pruned"] == 1
    db.commit()
    assert db.scalar(select(func.count()).select_from(Job)) == 1


def test_cli_jobs_commands(db, capsys):
    from shelfwise.__main__ import main

    assert main(["jobs", "enqueue", "test_echo", "--payload", '{"value": 7}']) == 0
    assert main(["jobs", "enqueue", "nope"]) == 2
    assert main(["jobs", "list"]) == 0
    assert "test_echo" in capsys.readouterr().out
    assert main(["jobs", "run-pending"]) == 0
    assert CALLS == [{"value": 7}]
    assert main(["jobs", "types"]) == 0
    assert main(["jobs", "schedules"]) == 0
    job = jobs.enqueue(db, "test_fail", max_attempts=1)
    db.commit()
    jobs.run_pending()
    assert main(["jobs", "retry", "--all-dead"]) == 0
    db.expire_all()
    assert db.get(Job, job.id).status == "queued"
    assert main(["jobs", "cancel", str(job.id)]) == 0
    assert main(["worker", "--burst", "--no-scheduler"]) == 0
