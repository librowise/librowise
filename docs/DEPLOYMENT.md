# Deploying Librowise in production

This guide covers a production deployment: PostgreSQL, the web tier behind a TLS reverse proxy,
the background worker, observability, backups and scaling. A complete example lives in
[`docker-compose.yml`](../docker-compose.yml).

## Topology

```
            HTTPS                      HTTP (private network)
 browser ─────────────► reverse proxy ───────────────► app  (uvicorn, N workers)  ─┐
 Prometheus ── /metrics (token) ──────────────────────►                            ├──► PostgreSQL 17
                                                       worker (jobs + scheduler) ──┘
                                                       backup volume ◄── pg_dump (backup job)
```

* **app** — stateless ASGI web processes (`uvicorn librowise.app:app`). Scale horizontally.
* **worker** — `python -m librowise worker --concurrency 2`: executes background jobs and fires
  cron schedules (nightly circulation run, notice delivery, maintenance, backups). Run one or
  more; schedules fire exactly once per slot no matter how many workers run, and jobs are
  claimed with `FOR UPDATE SKIP LOCKED` so no job runs twice.
* **PostgreSQL** — the system of record. SQLite remains the zero-configuration default and is
  fine for a single small library on one machine.

## Configuration

All settings are environment variables with the `LIBROWISE_` prefix (or a `.env` file).

| Setting | Production value | Notes |
|---|---|---|
| `LIBROWISE_ENVIRONMENT` | `production` | |
| `LIBROWISE_DATABASE_URL` | `postgresql+psycopg://librowise:…@db:5432/librowise` | install with `pip install ".[postgres]"` |
| `LIBROWISE_SECRET_KEY` | 64 random bytes, e.g. `python -c "import secrets;print(secrets.token_urlsafe(64))"` | **required**; shared by all app and worker processes |
| `LIBROWISE_COOKIE_SECURE` | `true` | cookies only over HTTPS; also enables HSTS |
| `LIBROWISE_ALLOWED_HOSTS` | `["library.example.org"]` | JSON list; rejects other `Host` headers |
| `LIBROWISE_TIMEZONE` | e.g. `Asia/Kolkata` | library time zone used by cron schedules |
| `LIBROWISE_DB_POOL_SIZE` / `LIBROWISE_DB_MAX_OVERFLOW` | `10` / `20` | per process; see *Scaling* |
| `LIBROWISE_DB_STATEMENT_TIMEOUT_MS` | `30000` | PostgreSQL server-side guard against runaway queries |
| `LIBROWISE_PG_SEARCH_CONFIG` | `english` (or `simple` for multilingual collections) | text-search configuration of the catalogue `tsvector`; run `reindex` after changing |
| `LIBROWISE_LOG_FORMAT` | `json` | one JSON object per line with `request_id`, `user_id`, `route`, `status`, `duration_ms` |
| `LIBROWISE_LOG_LEVEL` | `INFO` | |
| `LIBROWISE_METRICS_TOKEN` | random string | bearer token Prometheus uses for `/metrics` |
| `LIBROWISE_RATE_LIMIT_BACKEND` | `database` | login/AI rate limits shared by every process and host |
| `LIBROWISE_REQUIRE_WORKER` | `true` | `/readyz` fails when no worker heartbeat is fresh |
| `LIBROWISE_SCHEDULES` | JSON object, see below | |
| `LIBROWISE_BACKUP_DIR` / `LIBROWISE_BACKUP_KEEP` | `/backups` / `14` | |
| `LIBROWISE_CACHE_DIR` | `/var/lib/librowise` | semantic-index snapshots shared by processes on one host/volume |
| `ANTHROPIC_API_KEY` | optional | enables Claude-powered AI features; local models are used otherwise |

### Schedules

Cron expressions (`minute hour day-of-month month day-of-week`) in the library time zone. The
key is the job type; an empty string disables a default.

```json
{"nightly": "0 2 * * *", "deliver_notices": "*/5 * * * *", "maintenance": "30 3 * * *",
 "backup": "15 1 * * *", "ai_warmup": "45 2 * * 0"}
```

`python -m librowise jobs schedules` prints each schedule's next run. A slot missed while no
worker was running is still executed if a worker comes back within
`LIBROWISE_SCHEDULE_MISFIRE_GRACE` seconds (default 1 hour).

## First start

```bash
docker compose up -d db
docker compose run --rm app python -m librowise init-db
docker compose run --rm app python -m librowise create-admin --username admin --email admin@example.org
docker compose up -d
```

Tables, indexes and the search index are created idempotently on start-up; `init-db` is safe
to re-run after upgrades (it also adds indexes introduced by newer versions).

Migrating from SQLite: export with `python -m librowise backup`, then load the data with your
preferred tool (e.g. `pgloader`) and run `python -m librowise reindex` against PostgreSQL.

## Reverse proxy and TLS

Terminate TLS at the proxy, forward to the app over the private network and pass the original
host, scheme and client address. Uvicorn trusts `X-Forwarded-*` only from the addresses in
`FORWARDED_ALLOW_IPS` (the compose file sets it to the proxy network; never use `*` when the app
port is reachable from outside).

**Caddy** (automatic certificates):

```caddyfile
library.example.org {
    encode zstd gzip
    reverse_proxy app:8000 {
        header_up X-Request-ID {http.request.uuid}
    }
    @metrics path /metrics
    respond @metrics 404   # scrape /metrics on the private network instead
}
```

**nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name library.example.org;
    ssl_certificate     /etc/letsencrypt/live/library.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/library.example.org/privkey.pem;
    client_max_body_size 60m;               # MARC imports up to 50 MB
    location = /metrics { return 404; }      # scrape from inside the network
    location / {
        proxy_pass http://app:8000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-ID      $request_id;
        proxy_read_timeout 120s;             # AI requests can take a while
    }
}
server { listen 80; server_name library.example.org; return 301 https://$host$request_uri; }
```

The application sets its own security headers (CSP, HSTS when `COOKIE_SECURE=true`,
`X-Frame-Options`, …); the proxy does not need to add them. `X-Request-ID` from the proxy is
propagated into logs and the response, so a request can be traced end to end.

## Health checks and observability

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | liveness: the process is serving requests (no dependencies checked) |
| `GET /readyz` | readiness: database round-trip and worker heartbeat; returns 503 with details when not ready (the worker check only fails readiness when `REQUIRE_WORKER=true`) |
| `GET /metrics` | Prometheus text format; `Authorization: Bearer $LIBROWISE_METRICS_TOKEN` or an admin session |

Key metrics: `librowise_http_requests_total{method,route,status}`,
`librowise_http_request_duration_seconds` (histogram, route templates),
`librowise_circulation_operations_total{operation,outcome}`, `librowise_search_duration_seconds`,
`librowise_jobs{status}`, `librowise_job_queue_lag_seconds`,
`librowise_worker_heartbeat_age_seconds`, `librowise_db_pool_connections{state}`.
HTTP counters are per process — scrape each app container (or use one uvicorn worker per
container); queue, worker and pool gauges are read from the database and are identical from
any process. Workers can expose their own job counters with `--metrics-port 9100`.

Suggested alerts: `librowise_worker_heartbeat_age_seconds > 120`,
`librowise_jobs{status="dead"} > 0`, `librowise_job_queue_lag_seconds > 600`,
p95 of `librowise_http_request_duration_seconds` > 1 s for 10 minutes, `/readyz` failing.

Administrators see the same information on the **System** page (`/staff/system`): health,
job queue with retry/cancel, schedules and next runs, worker heartbeats, request latency,
database size and the backup list.

## Backups

* `python -m librowise backup [--dest DIR] [--keep N]` — SQLite: online backup API (consistent
  snapshot while the app runs) + `PRAGMA integrity_check`; PostgreSQL: `pg_dump --format=custom`
  verified with `pg_restore --list`. Each backup gets a JSON manifest with its SHA-256; the
  newest *N* are kept.
* Schedule it with the `backup` job (see *Schedules*) — the worker image includes the
  PostgreSQL 17 client tools.
* `python -m librowise restore FILE --yes` — verifies the checksum, saves a `pre-restore`
  copy of the current database (SQLite), restores, and asks you to restart app and workers.
* `python -m librowise backup --verify FILE` checks a backup without restoring it.

**Recommended production strategy**

1. **Point-in-time recovery** — for PostgreSQL use continuous WAL archiving (pgBackRest, WAL-G or
   your provider's PITR) with a 14–35 day window. This protects against "someone deleted the
   patrons table at 10:42".
2. **Daily logical dumps** — the `backup` job at a quiet hour, `LIBROWISE_BACKUP_KEEP=14`. Logical
   dumps are portable across PostgreSQL major versions and easy to inspect.
3. **Off-site copies** — sync the backup volume to object storage with versioning and
   object lock (e.g. `rclone sync /backups s3:library-backups`), encrypted at rest. Keep weekly
   copies for 3 months and monthly copies for a year.
4. **Restore drills** — monthly, restore the latest dump into a scratch database, run
   `python -m librowise reindex` and the test suite's smoke checks (`/readyz`, a search, a
   checkout). An untested backup is not a backup.
5. **Protect the secret key** — store `LIBROWISE_SECRET_KEY` in your secret manager; it is
   not in the database backup, and sessions/semantic-index snapshots depend on it.

Backups contain personal data (patrons, loan history): restrict access to the backup volume
and bucket, and apply the same retention rules as the live system. Backup files are never
served by the web application.

## Scaling

* **Web**: stateless; run more containers or uvicorn workers (`--workers`). Size the database
  pool so that `processes × (pool_size + max_overflow)` stays below PostgreSQL's
  `max_connections` (default 100), or put PgBouncer (transaction pooling) in front.
* **Workers**: increase `--concurrency` or run more worker containers; claiming is safe across
  hosts. Long jobs heartbeat every 15 s; a job whose worker disappears is recovered after
  `LIBROWISE_JOB_STALE_AFTER` (default 300 s) and retried with exponential backoff.
* **Search**: PostgreSQL's GIN-indexed `tsvector` handles hundreds of thousands of records on
  modest hardware (see [PERFORMANCE.md](PERFORMANCE.md)). Facets on scalar fields are exact;
  subject/author facets use the best 2,000 matches.
* **Semantic (AI) search index**: built in memory per process; catalogues above
  `LIBROWISE_SEMANTIC_SYNC_BUILD_LIMIT` records are built in a background thread and persisted
  to `LIBROWISE_CACHE_DIR` so other processes load the snapshot instead of rebuilding. Schedule
  the `ai_warmup` job (weekly) and mount the cache directory as a shared volume.
* **Rate limiting**: set `LIBROWISE_RATE_LIMIT_BACKEND=database` as soon as more than one
  process serves requests, otherwise each process enforces its own limit.
* **PostgreSQL tuning** for ~100k titles / 1M loans: `shared_buffers` ≈ 25% of RAM,
  `effective_cache_size` ≈ 70%, `work_mem` 16–32 MB, `random_page_cost=1.1` on SSDs, and
  autovacuum left on. Run `ANALYZE` after bulk imports (`generate` and `reindex` do this).

## Upgrades

1. Take a backup (`python -m librowise backup`).
2. Deploy the new image; start-up creates new tables and indexes idempotently.
3. Run `python -m librowise reindex` if the release notes mention search changes.
4. Restart workers last so that they pick up new job handlers.
