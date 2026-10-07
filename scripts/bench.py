"""Librowise benchmark: search, record page, circulation throughput and dashboards.

Runs the real ASGI app in-process (FastAPI TestClient — no network noise) against an existing
database, typically one produced by ``python -m librowise generate``::

    python -m librowise generate --biblios 100000 --patrons 20000 --loans 300000
    python scripts/bench.py --database-url sqlite:///librowise.db --runs 30

Prints a table and optionally writes JSON (``--json out.json``). Works with any Librowise
version that exposes the v1 API, so it can measure before/after a change.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

QUERIES = {
    "keyword: common word": "/api/v1/search?q=history",
    "keyword: two terms": "/api/v1/search?q=river+garden",
    "keyword: prefix": "/api/v1/search?q=astro",
    "keyword: rare/no match": "/api/v1/search?q=zzyzx",
    "keyword + filters": "/api/v1/search?q=fiction&material_type=book&language=en&year_from=2000",
    "facet: subject filter": "/api/v1/search?subject=Science%20fiction",
    "facet: author filter": "/api/v1/search?author=sharma",
    "browse: newest (no query)": "/api/v1/search?sort=newest",
    "browse: available only": "/api/v1/search?available_only=true&sort=title",
    "deep page: stop word (page 50)": "/api/v1/search?q=the&page=50",
    "deep page: common term (page 50)": "/api/v1/search?q=fiction&page=50",
    "smart: natural language": "/api/v1/search/smart?q=funny%20books%20for%20kids%20about%20space",
    "smart: filters only": "/api/v1/search/smart?q=dvds%20in%20hindi%20after%202010",
}


def pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    k = min(len(s) - 1, max(0, round(p / 100 * (len(s) - 1))))
    return s[k]


def timed(client, method: str, url: str, **kw) -> tuple[float, object]:
    t = time.perf_counter()
    r = client.request(method, url, **kw)
    return (time.perf_counter() - t) * 1000, r


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database-url", default=os.environ.get("LIBROWISE_DATABASE_URL"))
    ap.add_argument("--runs", type=int, default=20, help="Timed repetitions per query (after 2 warm-ups)")
    ap.add_argument("--circ", type=int, default=200, help="Checkout+checkin pairs for the throughput test")
    ap.add_argument("--json", help="Write results to this file")
    ap.add_argument("--label", default="")
    ap.add_argument("--cold", action="store_true",
                    help="Clear in-process search caches before every request (measures uncached latency)")
    ap.add_argument("--code", default=str(ROOT), help="Path of the Librowise source tree to benchmark")
    args = ap.parse_args()
    if not args.database_url:
        ap.error("--database-url or LIBROWISE_DATABASE_URL is required")

    os.environ["LIBROWISE_DATABASE_URL"] = args.database_url
    os.environ.setdefault("LIBROWISE_ENVIRONMENT", "bench")
    os.environ.setdefault("LIBROWISE_AI_ENABLED", "false")
    os.environ.setdefault("LIBROWISE_METADATA_LOOKUP_ENABLED", "false")
    os.environ.setdefault("LIBROWISE_ACCESS_LOG", "false")
    os.environ.setdefault("LIBROWISE_LOG_LEVEL", "WARNING")
    os.environ.setdefault("LIBROWISE_SEMANTIC_SYNC_BUILD_LIMIT", "10000000")  # measure the build explicitly
    sys.path.insert(0, args.code)

    import logging

    logging.disable(logging.INFO)
    from fastapi.testclient import TestClient
    from sqlalchemy import func, select

    from librowise import db as dbmod
    from librowise.app import create_app
    from librowise.models import Biblio, Item, ItemStatus, Loan, Patron, PatronCategory, Role
    from librowise.security import ai_limiter, hash_password, login_limiter

    dbmod.init_engine(args.database_url)
    results: dict = {"cold": args.cold, "label": args.label, "database": args.database_url.split("@")[-1], "runs": args.runs, "timings": {}}
    with dbmod.session_scope() as db:
        results["sizes"] = {
            "biblios": db.scalar(select(func.count()).select_from(Biblio)),
            "items": db.scalar(select(func.count()).select_from(Item)),
            "patrons": db.scalar(select(func.count()).select_from(Patron)),
            "loans": db.scalar(select(func.count()).select_from(Loan)),
        }
        admin = db.scalar(select(Patron).where(Patron.card_number == "bench-admin"))
        if admin is None:
            p = db.scalar(select(Patron).limit(1))
            cat = db.scalar(select(PatronCategory).where(PatronCategory.code == "STAFF")) or db.scalar(select(PatronCategory))
            admin = Patron(card_number="bench-admin", email="bench-admin@example.invalid", first_name="Bench",
                           last_name="Admin", role=Role.admin, category_id=cat.id, home_branch_id=p.home_branch_id,
                           password_hash=hash_password("Bench#Admin2026"))
            db.add(admin)
    print(f"Database: {results['database']}  sizes: {results['sizes']}", flush=True)

    try:
        from librowise.services.catalog import clear_search_cache
    except ImportError:  # older versions have no cache
        def clear_search_cache():
            return None

    def limiter_reset():
        login_limiter.reset()
        ai_limiter.reset()
        if args.cold:
            clear_search_cache()

    with TestClient(create_app()) as client:
        limiter_reset()
        r = client.post("/api/v1/auth/login", json={"username": "bench-admin", "password": "Bench#Admin2026"})
        r.raise_for_status()
        auth = {"Authorization": f"Bearer {r.json()['token']}"}

        def measure(name: str, method: str, url: str, runs: int | None = None, **kw):
            times = []
            for i in range((runs or args.runs) + 2):
                limiter_reset()
                ms, resp = timed(client, method, url, headers=auth, **kw)
                if resp.status_code >= 400:
                    raise SystemExit(f"{name}: HTTP {resp.status_code} {resp.text[:200]}")
                if i >= 2:
                    times.append(ms)
            results["timings"][name] = {"p50": round(pct(times, 50), 1), "p95": round(pct(times, 95), 1),
                                        "mean": round(statistics.fmean(times), 1), "n": len(times)}
            t = results["timings"][name]
            print(f"  {name:<34} p50 {t['p50']:>8.1f} ms   p95 {t['p95']:>8.1f} ms", flush=True)

        # First smart search triggers the semantic index build — measure it separately.
        ms, resp = timed(client, "GET", "/api/v1/search/smart?q=space%20exploration", headers=auth)
        results["timings"]["semantic index cold build (1st smart search)"] = {"p50": round(ms, 1), "p95": round(ms, 1), "n": 1}
        print(f"  {'semantic index cold (1st smart)':<34} {ms:>8.1f} ms", flush=True)
        for _ in range(60):  # background builds (new code) finish before timing
            st = client.get("/api/v1/search/smart?q=space", headers=auth)
            if st.json().get("total"):
                break
            time.sleep(1)

        print("Search", flush=True)
        for name, url in QUERIES.items():
            measure(name, "GET", url)

        with dbmod.session_scope() as db:
            rng = random.Random(1)
            popular = db.scalars(select(Item.biblio_id).order_by(Item.times_borrowed.desc()).limit(50)).all()
            sample = rng.sample(popular, min(10, len(popular)))
        print("Record pages", flush=True)
        measure("record: detail", "GET", f"/api/v1/biblios/{sample[0]}")
        measure("record: related (recommendations)", "GET", f"/api/v1/biblios/{sample[1]}/related")
        print("Dashboards", flush=True)
        measure("staff dashboard", "GET", "/api/v1/reports/dashboard", runs=max(5, args.runs // 2))
        measure("OPAC home shelves", "GET", "/api/v1/opac/home", runs=max(5, args.runs // 2))
        measure("loans list (overdue)", "GET", "/api/v1/loans?overdue=true")

        print("Circulation throughput", flush=True)
        with dbmod.session_scope() as db:
            patrons = db.scalars(select(Patron.card_number).where(
                Patron.role == Role.patron, Patron.is_active.is_(True), Patron.deleted_at.is_(None),
                Patron.expires_on > func.current_date()).limit(500)).all()
            items = db.scalars(select(Item.barcode).where(Item.status == ItemStatus.available,
                                                          Item.deleted_at.is_(None)).limit(args.circ)).all()
        co, ci, ok = [], [], 0
        started = time.perf_counter()
        for i, barcode in enumerate(items):
            ms, resp = timed(client, "POST", "/api/v1/circulation/checkout", headers=auth,
                             json={"patron_card": patrons[i % len(patrons)], "barcode": barcode, "override": True})
            co.append(ms)
            if resp.status_code == 200:
                ok += 1
            ms, resp = timed(client, "POST", "/api/v1/circulation/checkin", headers=auth, json={"barcode": barcode})
            ci.append(ms)
        elapsed = time.perf_counter() - started
        results["timings"]["checkout"] = {"p50": round(pct(co, 50), 1), "p95": round(pct(co, 95), 1), "n": len(co)}
        results["timings"]["checkin"] = {"p50": round(pct(ci, 50), 1), "p95": round(pct(ci, 95), 1), "n": len(ci)}
        results["circulation_ops_per_second"] = round((len(co) + len(ci)) / elapsed, 1) if elapsed else None
        results["checkouts_ok"] = ok
        print(f"  checkout p50 {pct(co, 50):.1f} ms p95 {pct(co, 95):.1f} ms | checkin p50 {pct(ci, 50):.1f} ms "
              f"p95 {pct(ci, 95):.1f} ms | {results['circulation_ops_per_second']} ops/s (single client)", flush=True)

    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
