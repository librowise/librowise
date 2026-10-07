"""Operations commands for ``python -m shelfwise``: worker, jobs, backup, restore, generate."""

from __future__ import annotations

import argparse
import json
import sys

COMMANDS = {"worker", "jobs", "backup", "restore", "generate"}


def add_parsers(sub) -> None:
    p = sub.add_parser("worker", help="Run the background job worker and scheduler")
    p.add_argument("--concurrency", type=int, default=1, help="Job threads in this process")
    p.add_argument("--no-scheduler", action="store_true", help="Only execute jobs; do not fire schedules")
    p.add_argument("--burst", action="store_true", help="Exit when the queue is empty")
    p.add_argument("--types", help="Comma-separated job types to handle (default: all)")
    p.add_argument("--metrics-port", type=int, default=0, help="Serve this worker's /metrics on 127.0.0.1:PORT")
    p.add_argument("--metrics-host", default="127.0.0.1")

    j = sub.add_parser("jobs", help="Inspect and manage background jobs")
    jsub = j.add_subparsers(dest="jobs_cmd", required=True)
    e = jsub.add_parser("enqueue", help="Queue a job")
    e.add_argument("type")
    e.add_argument("--payload", default="{}", help="JSON object")
    e.add_argument("--priority", type=int, default=0)
    e.add_argument("--delay", type=float, default=0, help="Seconds before the job becomes due")
    e.add_argument("--max-attempts", type=int)
    ls = jsub.add_parser("list", help="List recent jobs")
    ls.add_argument("--status")
    ls.add_argument("--type")
    ls.add_argument("--limit", type=int, default=30)
    r = jsub.add_parser("retry", help="Retry failed/dead/cancelled jobs")
    r.add_argument("ids", nargs="*", type=int)
    r.add_argument("--all-dead", action="store_true")
    c = jsub.add_parser("cancel", help="Cancel queued/failed jobs")
    c.add_argument("ids", nargs="+", type=int)
    jsub.add_parser("types", help="List registered job types")
    jsub.add_parser("schedules", help="Show schedules and their next runs")
    jsub.add_parser("run-pending", help="Execute all due jobs in this process, then exit")
    jsub.add_parser("tick", help="Fire due schedules once (for external cron)")

    b = sub.add_parser("backup", help="Back up the database (SQLite online backup / pg_dump)")
    b.add_argument("--dest", help="Backup directory (default: SHELFWISE_BACKUP_DIR)")
    b.add_argument("--keep", type=int, help="Retain this many newest backups (default: SHELFWISE_BACKUP_KEEP)")
    b.add_argument("--list", action="store_true", help="List existing backups instead")
    b.add_argument("--verify", metavar="FILE", help="Verify a backup file and exit")

    rs = sub.add_parser("restore", help="Restore the database from a backup file (destructive)")
    rs.add_argument("file")
    rs.add_argument("--yes", action="store_true", help="Confirm that the current database will be replaced")
    rs.add_argument("--no-safety-backup", action="store_true", help="Skip the automatic pre-restore backup")

    g = sub.add_parser("generate", help="Generate a large synthetic library for load testing")
    g.add_argument("--biblios", type=int, default=100_000)
    g.add_argument("--patrons", type=int, default=20_000)
    g.add_argument("--loans", type=int, default=300_000)
    g.add_argument("--seed", type=int, default=7)
    g.add_argument("--no-index", action="store_true", help="Skip rebuilding the search index")


def dispatch(args: argparse.Namespace) -> int | None:
    if args.cmd not in COMMANDS:
        return None
    from .db import create_all

    create_all()
    return {"worker": _worker, "jobs": _jobs, "backup": _backup, "restore": _restore, "generate": _generate}[args.cmd](args)


def _worker(args) -> int:
    from . import jobs
    from .observability import configure_logging

    configure_logging()
    w = jobs.Worker(args.concurrency, scheduler=not args.no_scheduler, burst=args.burst,
                    types=[t.strip() for t in args.types.split(",")] if args.types else None)
    w.install_signal_handlers()
    if args.metrics_port:
        _serve_metrics(args.metrics_host, args.metrics_port)
    stats = w.run()
    print(json.dumps(stats))
    return 0


def _serve_metrics(host: str, port: int) -> None:
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from .observability import render_metrics

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path.split("?")[0] != "/metrics":
                self.send_error(404)
                return
            body = render_metrics().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True, name="metrics").start()


def _print_jobs(rows) -> None:
    for j in rows:
        err = (j.last_error or "").strip().splitlines()[-1:] or [""]
        print(f"{j.id:>7}  {j.status:<10} {j.type:<16} attempts={j.attempts}/{j.max_attempts}  "
              f"run_at={j.run_at:%Y-%m-%d %H:%M:%S}  {err[0][:80]}")


def _jobs(args) -> int:
    from sqlalchemy import select

    from . import jobs
    from .db import session_scope
    from .models import Job

    cmd = args.jobs_cmd
    if cmd == "types":
        for name, spec in sorted(jobs.HANDLERS.items()):
            print(f"{name:<18} max_attempts={spec.max_attempts}  {spec.description}")
        return 0
    if cmd == "run-pending":
        print(json.dumps(jobs.run_pending()))
        return 0
    if cmd == "tick":
        print(json.dumps(jobs.scheduler_tick()))
        return 0
    with session_scope() as db:
        if cmd == "enqueue":
            try:
                payload = json.loads(args.payload)
                job = jobs.enqueue(db, args.type, payload, priority=args.priority, delay=args.delay,
                                   max_attempts=args.max_attempts)
            except (ValueError, TypeError) as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 2
            print(f"Queued job {job.id} ({job.type}).")
        elif cmd == "list":
            stmt = select(Job).order_by(Job.id.desc()).limit(args.limit)
            if args.status:
                stmt = stmt.where(Job.status == args.status)
            if args.type:
                stmt = stmt.where(Job.type == args.type)
            _print_jobs(db.scalars(stmt).all())
            print(json.dumps(jobs.queue_stats(db)["by_status"]))
        elif cmd == "retry":
            rows = list(db.scalars(select(Job).where(Job.status == "dead"))) if args.all_dead else \
                [j for j in (db.get(Job, i) for i in args.ids) if j is not None]
            n = 0
            for job in rows:
                try:
                    jobs.retry(db, job)
                    n += 1
                except ValueError as exc:
                    print(f"job {job.id}: {exc}", file=sys.stderr)
            print(f"Re-queued {n} job(s).")
        elif cmd == "cancel":
            for i in args.ids:
                job = db.get(Job, i)
                try:
                    if job is None:
                        raise ValueError("not found")
                    jobs.cancel(db, job)
                    print(f"Cancelled job {i}.")
                except ValueError as exc:
                    print(f"job {i}: {exc}", file=sys.stderr)
        elif cmd == "schedules":
            for s in jobs.schedule_status(db):
                print(f"{s['name']:<18} {s['cron']:<16} next={s['next_run']} UTC  last={s['last_slot']} "
                      f"({s['last_status'] or '-'}){'' if s['registered'] else '  [no handler]'}")
    return 0


def _backup(args) -> int:
    from . import backup

    try:
        if args.list:
            for b in backup.list_backups(args.dest):
                print(f"{b['created_at']}  {b['size']:>12,}  {b['name']}")
            return 0
        if args.verify:
            backup.verify(args.verify)
            print(f"{args.verify}: OK")
            return 0
        info = backup.create_backup(args.dest, args.keep)
    except backup.BackupError as exc:
        print(f"Backup failed: {exc}", file=sys.stderr)
        return 1
    print(f"Backup written: {info['file']} ({info['size']:,} bytes, sha256 {info['sha256'][:16]}…)")
    if info["pruned"]:
        print(f"Pruned {len(info['pruned'])} old backup(s).")
    return 0


def _restore(args) -> int:
    from . import backup

    if not args.yes:
        print("Refusing to restore without --yes: this REPLACES the current database with the backup.",
              file=sys.stderr)
        return 2
    try:
        info = backup.restore(args.file, safety_backup=not args.no_safety_backup)
    except backup.BackupError as exc:
        print(f"Restore failed: {exc}", file=sys.stderr)
        return 1
    print(f"Restored {info['restored']}." + (f" Previous database saved as {info['safety_backup']}." if info["safety_backup"] else ""))
    print("Restart the application and workers, then run `python -m shelfwise reindex` if search looks stale.")
    return 0


def _generate(args) -> int:
    from .generate import generate

    stats = generate(biblios=args.biblios, patrons=args.patrons, loans=args.loans, seed=args.seed,
                     index=not args.no_index, progress=lambda msg: print(msg, flush=True))
    print(json.dumps(stats))
    return 0
