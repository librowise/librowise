"""Observability, health, System API/page, shared rate limiting and backups."""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

import pytest
from conftest import login
from sqlalchemy import select

from librowise import jobs
from librowise.config import get_settings
from librowise.models import AuditLog, Biblio, Job, WorkerHeartbeat, utcnow

# ------------------------------------------------------------------ metrics & logging


def test_metrics_requires_token_or_admin(client, lib, monkeypatch):
    assert client.get("/metrics").status_code == 401
    staff = login(client, "librarian")
    assert client.get("/metrics", headers=staff).status_code == 403
    admin = login(client, "admin")
    r = client.get("/metrics", headers=admin)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
    monkeypatch.setenv("LIBROWISE_METRICS_TOKEN", "s3cret-metrics-token")
    get_settings.cache_clear()
    assert client.get("/metrics", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/metrics", headers={"Authorization": "Bearer s3cret-metrics-token"}).status_code == 200
    get_settings.cache_clear()


def test_metrics_content_uses_route_templates(client, lib, make_book, admin):
    b, (item,) = make_book("Metric Book")
    client.get(f"/api/v1/biblios/{b.id}")
    client.get("/api/v1/search", params={"q": "metric"})
    client.post("/api/v1/circulation/checkout", headers=admin, json={"patron_card": "reader1", "barcode": item.barcode})
    client.post("/api/v1/circulation/checkout", headers=admin, json={"patron_card": "reader1", "barcode": "NOPE"})
    text = client.get("/metrics", headers=admin).text
    assert 'route="/api/v1/biblios/{biblio_id}"' in text
    assert f"/api/v1/biblios/{b.id}\"" not in text  # never raw paths
    assert "librowise_http_request_duration_seconds_bucket" in text
    assert 'librowise_circulation_operations_total{operation="checkout",outcome="success"}' in text
    assert 'librowise_circulation_operations_total{operation="checkout",outcome="failure"}' in text
    assert 'librowise_search_duration_seconds_count{kind="keyword"}' in text
    assert 'librowise_jobs{status="queued"}' in text and "librowise_db_pool_connections" in text
    assert "librowise_worker_heartbeat_age_seconds -1" in text


def test_metrics_registry_exposition():
    from librowise.observability import Registry

    reg = Registry()
    c = reg.counter("t_total", "help", ("a",))
    c.labels(a='x"y').inc(2)
    h = reg.histogram("t_seconds", "help", buckets=(0.1, 1.0))
    h.observe(0.05)
    h.observe(5)
    g = reg.gauge("t_gauge", "help")
    g.set(3.5)
    out = reg.render()
    assert 't_total{a="x\\"y"} 2' in out
    assert 't_seconds_bucket{le="0.1"} 1' in out and 't_seconds_bucket{le="+Inf"} 2' in out
    assert "t_seconds_count 2" in out and "t_gauge 3.5" in out
    assert "# TYPE t_seconds histogram" in out


def test_request_id_is_propagated(client):
    r = client.get("/healthz", headers={"X-Request-ID": "abc-123"})
    assert r.headers["x-request-id"] == "abc-123"
    r = client.get("/healthz", headers={"X-Request-ID": "bad id with spaces\nnewline"})
    assert r.headers["x-request-id"] != "bad id with spaces\nnewline" and len(r.headers["x-request-id"]) == 16


def test_json_log_formatter_includes_context():
    from librowise.observability import JsonFormatter, request_id_var, user_id_var

    t1, t2 = request_id_var.set("rid-1"), user_id_var.set(7)
    try:
        rec = logging.LogRecord("librowise.test", logging.INFO, __file__, 1, "hello %s", ("world",), None)
        rec.route = "/x/{id}"
        data = json.loads(JsonFormatter().format(rec))
    finally:
        request_id_var.reset(t1)
        user_id_var.reset(t2)
    assert data["msg"] == "hello world" and data["request_id"] == "rid-1" and data["user_id"] == 7
    assert data["route"] == "/x/{id}" and data["level"] == "info"


# ------------------------------------------------------------------ health


def test_readyz_checks_database_and_worker(client, db, monkeypatch):
    r = client.get("/readyz")
    assert r.status_code == 200
    body = r.json()
    assert body["checks"]["database"]["ok"] is True and body["checks"]["worker"]["ok"] is False
    monkeypatch.setenv("LIBROWISE_REQUIRE_WORKER", "true")
    get_settings.cache_clear()
    assert client.get("/readyz").status_code == 503
    db.add(WorkerHeartbeat(worker_id="w-test", hostname="h", pid=1, last_seen_at=utcnow()))
    db.commit()
    assert client.get("/readyz").status_code == 200
    get_settings.cache_clear()


# ------------------------------------------------------------------ System API & page


def test_system_api_permissions_and_overview(client, lib, admin, staff):
    assert client.get("/api/v1/system/overview", headers=staff).status_code == 403
    r = client.get("/api/v1/system/overview", headers=admin)
    assert r.status_code == 200
    o = r.json()
    assert o["database"]["dialect"] in ("sqlite", "postgresql") and o["database"]["rows"]["patrons"] >= 4
    assert {s["name"] for s in o["schedules"]} >= {"nightly", "deliver_notices"}
    assert any(t["type"] == "nightly" for t in o["job_types"])
    assert o["ready"] is True and "queue" in o


def test_system_jobs_enqueue_retry_cancel(client, db, lib, admin, staff):
    assert client.post("/api/v1/system/jobs", headers=staff, json={"type": "reindex"}).status_code == 403
    assert client.post("/api/v1/system/jobs", headers=admin, json={"type": "rm -rf"}).status_code == 422
    r = client.post("/api/v1/system/jobs", headers=admin, json={"type": "reindex", "priority": 5})
    assert r.status_code == 201
    job_id = r.json()["id"]
    assert client.post(f"/api/v1/system/jobs/{job_id}/retry", headers=admin).status_code == 409
    assert client.post(f"/api/v1/system/jobs/{job_id}/cancel", headers=admin).json()["status"] == "cancelled"
    assert client.post(f"/api/v1/system/jobs/{job_id}/retry", headers=admin).json()["status"] == "queued"
    listing = client.get("/api/v1/system/jobs?status=queued", headers=admin).json()
    assert listing["total"] == 1 and listing["results"][0]["type"] == "reindex"
    assert client.get("/api/v1/system/jobs/999999", headers=admin).status_code == 404
    jobs.run_pending()
    assert client.get(f"/api/v1/system/jobs/{job_id}", headers=admin).json()["status"] == "succeeded"
    actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity == "job")))
    assert {"job_enqueue", "job_cancel", "job_retry"} <= actions


def test_system_page_admin_only(client, lib):
    login(client, "librarian")
    r = client.get("/staff/system", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/staff"
    assert 'href="/staff/system"' not in client.get("/staff").text  # nav entry hidden
    client.post("/api/v1/auth/logout")
    login(client, "admin")
    r = client.get("/staff/system")
    assert r.status_code == 200 and 'data-page="staff-system"' in r.text
    assert 'href="/staff/system"' in client.get("/staff").text


# ------------------------------------------------------------------ rate limiting


def test_database_rate_limiter_is_shared(db, monkeypatch):
    from librowise.security import SlidingWindowLimiter

    monkeypatch.setenv("LIBROWISE_RATE_LIMIT_BACKEND", "database")
    get_settings.cache_clear()
    a = SlidingWindowLimiter(3, 60, name="t-shared")
    b = SlidingWindowLimiter(3, 60, name="t-shared")  # another process, same limiter name
    assert [a.allow("ip1"), b.allow("ip1"), a.allow("ip1")] == [True, True, True]
    assert b.allow("ip1") is False and a.allow("ip1") is False
    assert a.allow("ip2") is True  # keys are independent
    other = SlidingWindowLimiter(3, 60, name="t-other")
    assert other.allow("ip1") is True  # names are independent
    a.reset()
    assert b.allow("ip1") is True
    get_settings.cache_clear()


def test_database_rate_limiter_sliding_window(db):
    from librowise import ratelimit

    t0 = 60 * 16_667 + 20.0  # 20 s into a 60 s window
    for _ in range(4):
        assert ratelimit.db_allow("sw:k", 4, 60, now=t0)
    assert not ratelimit.db_allow("sw:k", 4, 60, now=t0)
    # 30 s into the next window, half of the previous window still counts: 4 * 0.5 + 2 = 4
    assert ratelimit.db_allow("sw:k", 4, 60, now=t0 + 70)
    assert ratelimit.db_allow("sw:k", 4, 60, now=t0 + 70)
    assert not ratelimit.db_allow("sw:k", 4, 60, now=t0 + 70)
    assert ratelimit.db_allow("sw:k", 4, 60, now=t0 + 200)  # old windows no longer count
    assert ratelimit.prune_counters(db, older_than=0) >= 1


def test_login_rate_limit_with_database_backend(client, lib, monkeypatch):
    from librowise.security import login_limiter

    monkeypatch.setenv("LIBROWISE_RATE_LIMIT_BACKEND", "database")
    get_settings.cache_clear()
    login_limiter.reset()
    codes = [client.post("/api/v1/auth/login", json={"username": "reader1", "password": "wrong"}).status_code
             for _ in range(login_limiter.limit + 1)]
    assert codes[-1] == 429 and codes[0] == 401
    login_limiter.reset()
    get_settings.cache_clear()


# ------------------------------------------------------------------ backups

def _is_sqlite() -> bool:
    return get_settings().database_url.startswith("sqlite")


def test_sqlite_backup_verify_prune_restore(db, lib, make_book, tmp_path, monkeypatch, capsys):
    if not _is_sqlite():
        pytest.skip("SQLite backup test")
    from librowise import backup
    from librowise.__main__ import main

    make_book("Before Backup")
    dest = tmp_path / "backups"
    info = backup.create_backup(dest, keep=5)
    assert info["kind"] == "sqlite" and info["size"] > 0 and len(info["sha256"]) == 64
    backup.verify(info["file"])
    assert backup.list_backups(dest)[0]["name"] == info["name"]
    # Retention keeps the newest N
    for _ in range(3):
        backup.create_backup(dest, keep=2)
    assert len(backup.list_backups(dest)) == 2
    latest = backup.list_backups(dest)[0]["name"]
    # Change data, then restore the backup
    make_book("After Backup")
    assert db.scalar(select(Biblio.id).where(Biblio.title == "After Backup"))
    assert main(["restore", str(dest / latest)]) == 2  # refuses without --yes
    monkeypatch.setenv("LIBROWISE_BACKUP_DIR", str(tmp_path / "safety"))
    get_settings.cache_clear()
    db.close()
    assert main(["restore", str(dest / latest), "--yes"]) == 0
    from librowise.db import SessionLocal

    s = SessionLocal()
    try:
        titles = set(s.scalars(select(Biblio.title)))
    finally:
        s.close()
    assert "Before Backup" in titles and "After Backup" not in titles
    assert any("pre-restore" in b["name"] for b in backup.list_backups())  # safety copy (default dir)
    out = capsys.readouterr().out
    assert "Restored" in out
    get_settings.cache_clear()


def test_sqlite_backup_leaves_no_wal_side_files(db, lib, make_book, tmp_path):
    """The live DB runs in WAL mode; the backup must be one self-contained file with no -wal/-shm."""
    if not _is_sqlite():
        pytest.skip("SQLite backup test")
    import sqlite3

    from librowise import backup

    make_book("Side Files")
    dest = tmp_path / "backups"
    info = backup.create_backup(dest, keep=0)
    assert sorted(p.name for p in dest.iterdir()) == sorted([info["name"], info["name"] + ".json"])
    backup.verify(info["file"])
    con = sqlite3.connect(f"file:{Path(info['file']).as_posix()}?mode=ro", uri=True)
    try:
        assert con.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    finally:
        con.close()
    assert not [p.name for p in dest.iterdir() if p.name.endswith(("-wal", "-shm"))]
    # Side files left by an older, interrupted run are swept by prune; backups themselves are kept.
    for name in ("librowise-20200101-000000.sqlite3.partial-wal", "librowise-20200101-000000.sqlite3.partial-shm",
                 info["name"] + "-shm"):
        (dest / name).write_bytes(b"x")
    backup.prune(dest, keep=5)
    assert sorted(p.name for p in dest.iterdir()) == sorted([info["name"], info["name"] + ".json"])


def test_backup_detects_corruption(tmp_path, db, lib):
    if not _is_sqlite():
        pytest.skip("SQLite backup test")
    from librowise import backup

    info = backup.create_backup(tmp_path, keep=0)
    with open(info["file"], "r+b") as fh:
        fh.seek(200)
        fh.write(b"\x00garbage\x00" * 50)
    with pytest.raises(backup.BackupError):
        backup.verify(info["file"])
    bogus = tmp_path / "librowise-bogus.sqlite3"
    bogus.write_bytes(b"not a database" * 100)
    with pytest.raises(backup.BackupError):
        backup.verify(bogus)


def test_postgres_backup_when_tools_available(db, lib, tmp_path):
    if _is_sqlite() or not shutil.which("pg_dump"):
        pytest.skip("needs PostgreSQL and pg_dump")
    from librowise import backup

    info = backup.create_backup(tmp_path, keep=3)
    assert info["kind"] == "postgresql" and info["name"].endswith(".dump")
    backup.verify(info["file"])


def test_backup_job_and_api_listing(client, db, admin, tmp_path, monkeypatch):
    if not _is_sqlite():
        pytest.skip("SQLite backup test")
    monkeypatch.setenv("LIBROWISE_BACKUP_DIR", str(tmp_path))
    get_settings.cache_clear()
    jobs.enqueue(db, "backup", {"keep": 3})
    db.commit()
    assert jobs.run_pending()["succeeded"] == 1
    assert db.scalar(select(Job.result).where(Job.type == "backup"))["size"] > 0
    listing = client.get("/api/v1/system/backups", headers=admin).json()
    assert len(listing["results"]) == 1 and listing["results"][0]["sha256"]
    get_settings.cache_clear()
