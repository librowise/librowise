"""Observability: structured logging, Prometheus metrics and health probes — no dependencies.

* ``configure_logging()`` — plain text or one JSON object per line (``SHELFWISE_LOG_FORMAT=json``);
  every record carries the request id and user id of the request that produced it.
* A tiny metrics registry (counters, gauges, histograms with labels) rendered in the Prometheus
  text exposition format at ``/metrics``. Route labels use templates (``/api/v1/biblios/{biblio_id}``),
  never raw paths, so cardinality stays bounded.
* ``MetricsMiddleware`` — pure ASGI middleware: request id propagation, access log, request
  metrics and circulation-operation counters.

Metrics are per process. Run Prometheus against each process (or one worker per container)
when scaling out; queue, database and worker gauges are read from the database at scrape time
and are therefore identical from any process.
"""

from __future__ import annotations

import contextvars
import json
import logging
import math
import re
import sys
import threading
import time
import uuid
from collections.abc import Callable, Iterable

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
user_id_var: contextvars.ContextVar[int | None] = contextvars.ContextVar("user_id", default=None)

# ------------------------------------------------------------------ metrics registry


def _escape(v: str) -> str:
    return str(v).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _fmt(v: float) -> str:
    if v == math.inf:
        return "+Inf"
    if float(v).is_integer():
        return str(int(v))
    return repr(float(v))


def _labelstr(names: tuple[str, ...], values: tuple[str, ...], extra: tuple[tuple[str, str], ...] = ()) -> str:
    pairs = list(zip(names, values, strict=True)) + list(extra)
    if not pairs:
        return ""
    return "{" + ",".join(f'{k}="{_escape(v)}"' for k, v in pairs) + "}"


class _Metric:
    kind = "untyped"

    def __init__(self, name: str, help: str, labelnames: Iterable[str] = ()) -> None:
        self.name = name
        self.help = help
        self.labelnames = tuple(labelnames)
        self._lock = threading.Lock()
        self._children: dict[tuple[str, ...], object] = {}

    def labels(self, **labels):
        key = tuple(str(labels.get(n, "")) for n in self.labelnames)
        with self._lock:
            child = self._children.get(key)
            if child is None:
                child = self._children[key] = self._new_child()
            return child

    def _new_child(self):  # pragma: no cover - abstract
        raise NotImplementedError

    def reset(self) -> None:
        with self._lock:
            self._children.clear()

    def collect(self) -> list[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} {self.kind}"]
        with self._lock:
            items = list(self._children.items())
        for key, child in sorted(items):
            lines.extend(self._render(key, child))
        return lines


class _Value:
    __slots__ = ("value", "_lock")

    def __init__(self) -> None:
        self.value = 0.0
        self._lock = threading.Lock()

    def inc(self, amount: float = 1.0) -> None:
        with self._lock:
            self.value += amount

    def dec(self, amount: float = 1.0) -> None:
        self.inc(-amount)

    def set(self, value: float) -> None:
        with self._lock:
            self.value = float(value)


class Counter(_Metric):
    kind = "counter"

    def _new_child(self):
        return _Value()

    def inc(self, amount: float = 1.0) -> None:
        self.labels().inc(amount)

    def _render(self, key, child):
        return [f"{self.name}{_labelstr(self.labelnames, key)} {_fmt(child.value)}"]


class Gauge(Counter):
    kind = "gauge"

    def set(self, value: float) -> None:
        self.labels().set(value)


class _HistogramChild:
    __slots__ = ("buckets", "counts", "sum", "count", "_lock")

    def __init__(self, buckets: tuple[float, ...]) -> None:
        self.buckets = buckets
        self.counts = [0] * len(buckets)
        self.sum = 0.0
        self.count = 0
        self._lock = threading.Lock()

    def observe(self, value: float) -> None:
        with self._lock:
            self.sum += value
            self.count += 1
            for i, b in enumerate(self.buckets):
                if value <= b:
                    self.counts[i] += 1
                    break

    def quantile(self, q: float) -> float | None:
        """Approximate quantile from bucket counts (upper bound of the bucket)."""
        with self._lock:
            if not self.count:
                return None
            target, acc = q * self.count, 0
            for b, c in zip(self.buckets, self.counts, strict=True):
                acc += c
                if acc >= target:
                    return b
        return self.buckets[-1]


DEFAULT_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, math.inf)


class Histogram(_Metric):
    kind = "histogram"

    def __init__(self, name, help, labelnames=(), buckets: tuple[float, ...] = DEFAULT_BUCKETS) -> None:
        super().__init__(name, help, labelnames)
        b = tuple(sorted(set(buckets)))
        self.buckets = b if b[-1] == math.inf else (*b, math.inf)

    def _new_child(self):
        return _HistogramChild(self.buckets)

    def observe(self, value: float) -> None:
        self.labels().observe(value)

    def _render(self, key, child):
        out, acc = [], 0
        with child._lock:
            counts, total, n = list(child.counts), child.sum, child.count
        for b, c in zip(self.buckets, counts, strict=True):
            acc += c
            out.append(f"{self.name}_bucket{_labelstr(self.labelnames, key, (('le', _fmt(b)),))} {acc}")
        out.append(f"{self.name}_sum{_labelstr(self.labelnames, key)} {_fmt(total)}")
        out.append(f"{self.name}_count{_labelstr(self.labelnames, key)} {n}")
        return out


class Registry:
    def __init__(self) -> None:
        self.metrics: list[_Metric] = []
        self.collectors: list[Callable[[], list[str]]] = []

    def register(self, metric):
        self.metrics.append(metric)
        return metric

    def counter(self, name, help, labelnames=()) -> Counter:
        return self.register(Counter(name, help, labelnames))

    def gauge(self, name, help, labelnames=()) -> Gauge:
        return self.register(Gauge(name, help, labelnames))

    def histogram(self, name, help, labelnames=(), buckets=DEFAULT_BUCKETS) -> Histogram:
        return self.register(Histogram(name, help, labelnames, buckets))

    def add_collector(self, fn: Callable[[], list[str]]) -> None:
        """``fn`` returns exposition lines computed at scrape time (e.g. from the database)."""
        self.collectors.append(fn)

    def render(self) -> str:
        lines: list[str] = []
        for m in self.metrics:
            lines.extend(m.collect())
        for fn in self.collectors:
            try:
                lines.extend(fn())
            except Exception:  # pragma: no cover - a broken collector must not break /metrics
                logging.getLogger("shelfwise.metrics").exception("metrics collector failed")
        return "\n".join(lines) + "\n"


REGISTRY = Registry()

HTTP_REQUESTS = REGISTRY.counter("shelfwise_http_requests_total", "HTTP requests by route template and status.",
                                 ("method", "route", "status"))
HTTP_LATENCY = REGISTRY.histogram("shelfwise_http_request_duration_seconds", "HTTP request latency by route template.",
                                  ("method", "route"))
HTTP_IN_PROGRESS = REGISTRY.gauge("shelfwise_http_requests_in_progress", "HTTP requests currently being served.")
CIRCULATION_OPS = REGISTRY.counter("shelfwise_circulation_operations_total",
                                   "Circulation operations through the API by outcome.", ("operation", "outcome"))
SEARCH_LATENCY = REGISTRY.histogram("shelfwise_search_duration_seconds", "Catalogue search latency (service layer).",
                                    ("kind",), (0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5))
JOBS_TOTAL = REGISTRY.counter("shelfwise_jobs_total", "Background jobs executed by this process, by outcome.",
                              ("type", "outcome"))
PROCESS_START = time.time()

# Route template -> circulation operation name (counted with outcome success/failure)
CIRCULATION_ROUTES = {
    ("POST", "/api/v1/circulation/checkout"): "checkout",
    ("POST", "/api/v1/circulation/checkin"): "checkin",
    ("POST", "/api/v1/circulation/transfer/receive"): "transfer_receive",
    ("POST", "/api/v1/loans/{loan_id}/renew"): "renew",
    ("POST", "/api/v1/opac/me/loans/{loan_id}/renew"): "renew",
    ("POST", "/api/v1/loans/{loan_id}/lost"): "mark_lost",
    ("POST", "/api/v1/holds"): "place_hold",
    ("POST", "/api/v1/opac/me/holds"): "place_hold",
    ("DELETE", "/api/v1/holds/{hold_id}"): "cancel_hold",
    ("DELETE", "/api/v1/opac/me/holds/{hold_id}"): "cancel_hold",
}


def _db_collector() -> list[str]:
    """Gauges read at scrape time: pool, job queue, worker heartbeat."""
    from sqlalchemy import func, select

    from .db import SessionLocal, get_engine, pool_stats
    from .jobs import STATUSES, latest_heartbeat_age, queue_stats
    from .models import Job

    lines = ["# HELP shelfwise_db_pool_connections Database connection pool state.",
             "# TYPE shelfwise_db_pool_connections gauge"]
    for k, v in pool_stats(get_engine()).items():
        lines.append(f'shelfwise_db_pool_connections{{state="{k}"}} {v}')
    db = SessionLocal()
    try:
        stats = queue_stats(db)
        by_type = db.execute(select(Job.type, Job.status, func.count()).group_by(Job.type, Job.status)).all()
        age = latest_heartbeat_age(db)
    finally:
        db.close()
    lines += ["# HELP shelfwise_jobs Jobs in the queue by status.", "# TYPE shelfwise_jobs gauge"]
    for s in STATUSES:
        lines.append(f'shelfwise_jobs{{status="{s}"}} {stats["by_status"].get(s, 0)}')
    lines += ["# HELP shelfwise_jobs_by_type Jobs in the queue by type and status.", "# TYPE shelfwise_jobs_by_type gauge"]
    for t, s, n in by_type:
        lines.append(f'shelfwise_jobs_by_type{{type="{_escape(t)}",status="{_escape(s)}"}} {n}')
    lines += ["# HELP shelfwise_job_queue_lag_seconds Age of the oldest due job still waiting.",
              "# TYPE shelfwise_job_queue_lag_seconds gauge", f"shelfwise_job_queue_lag_seconds {stats['lag_seconds']}",
              "# HELP shelfwise_worker_heartbeat_age_seconds Seconds since the freshest worker heartbeat (-1 = none).",
              "# TYPE shelfwise_worker_heartbeat_age_seconds gauge",
              f"shelfwise_worker_heartbeat_age_seconds {round(age, 1) if age is not None else -1}"]
    return lines


def _process_collector() -> list[str]:
    from . import __version__

    return ["# HELP shelfwise_info Build information.", "# TYPE shelfwise_info gauge",
            f'shelfwise_info{{version="{__version__}",python="{sys.version.split()[0]}"}} 1',
            "# HELP shelfwise_process_start_time_seconds Process start time (unix seconds).",
            "# TYPE shelfwise_process_start_time_seconds gauge", f"shelfwise_process_start_time_seconds {PROCESS_START}"]


REGISTRY.add_collector(_process_collector)
REGISTRY.add_collector(_db_collector)


def render_metrics() -> str:
    return REGISTRY.render()


def latency_summary() -> dict:
    """p50/p95 per route from the request histogram (for the System page)."""
    out = []
    with HTTP_LATENCY._lock:
        items = list(HTTP_LATENCY._children.items())
    for (method, route), child in items:
        if child.count:
            out.append({"method": method, "route": route, "count": child.count,
                        "avg_ms": round(child.sum / child.count * 1000, 1),
                        "p50_ms": _ms(child.quantile(0.5)), "p95_ms": _ms(child.quantile(0.95))})
    out.sort(key=lambda r: -r["count"])
    return {"routes": out[:15]}


def _ms(v):
    return None if v is None or v == math.inf else round(v * 1000, 1)


# ------------------------------------------------------------------ logging


class JsonFormatter(logging.Formatter):
    RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}

    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S") + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        rid, uid = request_id_var.get(), user_id_var.get()
        if rid:
            out["request_id"] = rid
        if uid is not None:
            out["user_id"] = uid
        for k, v in record.__dict__.items():
            if k not in self.RESERVED and not k.startswith("_"):
                out[k] = v
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


JsonFormatter.converter = time.gmtime


class _ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = getattr(record, "request_id", None) or request_id_var.get() or "-"
        return True


_configured = False


def configure_logging(force: bool = False) -> None:
    """Install the root handler once (idempotent; uvicorn's own loggers keep working)."""
    global _configured
    if _configured and not force:
        return
    from .config import get_settings

    s = get_settings()
    handler = logging.StreamHandler()
    if s.log_format.lower() == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"))
    handler.addFilter(_ContextFilter())
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_shelfwise", False):
            root.removeHandler(h)
    handler._shelfwise = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(getattr(logging, s.log_level.upper(), logging.INFO))
    if s.log_format.lower() == "json":
        # Route uvicorn's loggers through the JSON handler too (no duplicate plain-text lines).
        for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
            lg = logging.getLogger(name)
            lg.handlers = []
            lg.propagate = True
        logging.getLogger("uvicorn.access").disabled = s.access_log  # our access log replaces it
    _configured = True


# ------------------------------------------------------------------ ASGI middleware

access_log = logging.getLogger("shelfwise.access")


class MetricsMiddleware:
    """Outermost middleware: assigns the request id, measures, counts and logs every request."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or [])
        rid = headers.get(b"x-request-id", b"").decode("latin-1")[:64]
        if not rid or not all(c.isalnum() or c in "-_." for c in rid):
            rid = uuid.uuid4().hex[:16]
            scope["headers"] = [(k, v) for k, v in scope.get("headers") or [] if k != b"x-request-id"] + [
                (b"x-request-id", rid.encode())]
        token_r = request_id_var.set(rid)
        token_u = user_id_var.set(None)
        status_holder = {"status": 500}
        start = time.perf_counter()
        HTTP_IN_PROGRESS.labels().inc()

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            HTTP_IN_PROGRESS.labels().dec()
            elapsed = time.perf_counter() - start
            method, status = scope.get("method", "GET"), status_holder["status"]
            route = _route_template(scope)
            HTTP_REQUESTS.labels(method=method, route=route, status=str(status)).inc()
            HTTP_LATENCY.labels(method=method, route=route).observe(elapsed)
            op = CIRCULATION_ROUTES.get((method, route))
            if op:
                CIRCULATION_OPS.labels(operation=op, outcome="success" if status < 400 else "failure").inc()
            user = (scope.get("state") or {}).get("user")
            uid = getattr(user, "__dict__", {}).get("id")  # never trigger a lazy load here
            if uid is not None:
                user_id_var.set(uid)
            from .config import get_settings

            if get_settings().access_log and not route.startswith("/static"):
                access_log.info("%s %s %s %.1fms", method, scope.get("path"), status, elapsed * 1000, extra={
                    "method": method, "path": scope.get("path"), "route": route, "status": status,
                    "duration_ms": round(elapsed * 1000, 1), "user_id": uid,
                    "client": (scope.get("client") or ("", 0))[0]})
            request_id_var.reset(token_r)
            user_id_var.reset(token_u)


def _route_template(scope) -> str:
    """The matched route's path template including router prefixes (``/api/v1/biblios/{biblio_id}``).

    Depending on the FastAPI version ``scope["route"].path`` may exclude the include_router
    prefix, so the prefix is recovered from the request path by re-rendering the template with
    the matched path parameters."""
    path = getattr(scope.get("route"), "path", None)
    raw = scope.get("path", "")
    if path:
        params = scope.get("path_params") or {}
        rendered = _PARAM.sub(lambda m: str(params.get(m.group(1), m.group(0))), path)
        if rendered != raw and raw.endswith(rendered):
            return raw[: len(raw) - len(rendered)] + path
        return path
    return "/static" if raw.startswith("/static/") else "<unmatched>"


_PARAM = re.compile(r"{([^}:]+)(?::[^}]*)?}")
