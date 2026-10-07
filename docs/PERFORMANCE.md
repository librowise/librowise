# Performance at catalogue scale

This document records how Librowise behaves with a realistically large library — **100,000 titles,
~152,000 items, 20,000 patrons and 300,000 loans** — and what was changed to get there.

## Reproduce

```bash
# 1. Synthetic library (≈1 min on SQLite, ≈3 min on PostgreSQL in Docker)
LIBROWISE_DATABASE_URL=sqlite:///var/bench.db \
  python -m librowise generate --biblios 100000 --patrons 20000 --loans 300000

# 2. Benchmark: the real ASGI app in-process (no network noise), p50/p95 per operation
python scripts/bench.py --database-url sqlite:///var/bench.db --runs 20 --json out.json
python scripts/bench.py --database-url sqlite:///var/bench.db --cold   # search caches cleared before every request
```

The generator uses bulk Core inserts with realistic shapes: Zipf-distributed subjects, authors and
title popularity, 1–4 copies per title, a long tail of light readers and a few heavy ones, five
years of loans with ~4% still open (some overdue), late returns with fines and payments, and
queued holds on popular titles. It rebuilds the search index once at the end and runs `ANALYZE`.

`scripts/bench.py --code PATH` runs the same benchmark against another source tree, which is how
the *before* column was produced (commit `303ed38`, original schema, identical data).

**Machine:** Windows 11 laptop — Intel Core i7-1255U (10 cores, 15 W), 16 GB RAM, NVMe SSD; Python 3.12, SQLite 3.49 (WAL).
PostgreSQL 17 runs in Docker Desktop (WSL2) on the same laptop, so every PostgreSQL query also
pays a virtualised network round trip (~0.3–1 ms) — a dedicated server is faster.

## Results

p50 / p95 in milliseconds (single client; *warm* = repeated identical requests may use the
per-process facet/total cache, *cold* = caches cleared before every request).

| Operation | **Before** SQLite | After SQLite (warm) | After SQLite (cold) | After PostgreSQL 17 (warm) | After PostgreSQL 17 (cold) |
|---|---|---|---|---|---|
| semantic index cold build (1st smart search) | 17,094 | 5,241 | 5,296 | 5,766 | 6,182 |
| keyword: common word | 96.9 / 299.7 | 21.3 / 22.6 | 60.9 / 81.5 | 95.0 / 150.5 | 182 / 212 |
| keyword: two terms | 14.1 / 16.3 | 6.7 / 7.4 | 11.6 / 12.2 | 39.2 / 45.6 | 81.3 / 131.3 |
| keyword: prefix | 28.0 / 55.6 | 6.7 / 7.6 | 14.8 / 22.5 | 35.7 / 48.6 | 81.6 / 108.8 |
| keyword: rare/no match | 2.4 / 4.0 | 2.3 / 2.5 | 2.6 / 2.8 | 8.9 / 13.7 | 16.6 / 23.0 |
| keyword + filters | 129 / 274 | 49.5 / 71.8 | 110 / 187 | 311 / 446 | 480 / 658 |
| facet: subject filter | 1,657 / 1,864 | 12.7 / 13.9 | 38.3 / 41.3 | 15.6 / 17.0 | 115 / 166 |
| facet: author filter | 1,556 / 1,723 | 16.5 / 17.6 | 51.9 / 110.3 | 17.5 / 23.3 | 159 / 265 |
| browse: newest (no query) | 2,399 / 3,048 | 5.4 / 7.4 | 137 / 216 | 14.7 / 25.4 | 125 / 169 |
| browse: available only | 2,352 / 3,107 | 151 / 206 | 146 / 204 | 120 / 214 | 133 / 183 |
| deep page: stop word (page 50) | 145 / 413 | 102 / 153 | 225 / 346 | 12.3 / 17.1 | 13.2 / 15.5 |
| deep page: common term (page 50) | 195 / 489 | 101 / 162 | 192 / 241 | 307 / 350 | 405 / 555 |
| smart: natural language | 617 / 763 | 13.0 / 21.6 | 70.5 / 88.4 | 33.0 / 38.3 | 95.1 / 187.4 |
| smart: filters only | 28.9 / 52.1 | 10.9 / 14.4 | 19.2 / 24.9 | 23.0 / 28.7 | 25.4 / 35.6 |
| record: detail | 6.3 / 8.3 | 3.9 / 4.3 | 4.5 / 6.9 | 14.6 / 21.9 | 21.4 / 42.8 |
| record: related (recommendations) | 1,097 / 1,615 | 33.2 / 53.9 | 30.4 / 39.4 | 84.8 / 135.0 | 85.6 / 141.2 |
| staff dashboard | 7,034 / 7,293 | 228 / 279 | 275 / 493 | 199 / 265 | 185 / 277 |
| OPAC home shelves | 3,124 / 3,335 | 83.2 / 181.8 | 79.1 / 84.7 | 88.4 / 103.8 | 87.0 / 110.8 |
| loans list (overdue) | 2,687 / 4,424 | 43.1 / 61.6 | 17.1 / 32.5 | 137 / 341 | 75.3 / 88.1 |
| checkout | 8.6 / 23.7 | 9.2 / 20.1 | 8.8 / 17.6 | 43.7 / 102.5 | 40.0 / 76.1 |
| checkin | 7.4 / 21.1 | 7.2 / 14.4 | 7.2 / 23.4 | 32.5 / 61.0 | 30.2 / 61.7 |
| circulation ops/s (1 client) | 94.4 | 80.8 | 98.0 | 22.3 | 25.0 |

The *semantic index cold build* row is a single measurement (first smart search with an empty
index, forced to build synchronously by the benchmark). Measured separately with `tracemalloc`,
the index for 100k titles now **retains 17 MiB (peak 66 MiB during the build)** versus
**378 MiB retained (705 MiB peak)** before.

Reading the table:

* **Before** = commit `303ed38` on SQLite with identical data. Its keyword searches look cheap
  for small result sets because the old code fetched at most 5,000 FTS candidates — totals were
  silently capped at 5,000 and deeper pages were unreachable; the new numbers are for exact
  totals over all matches.
* PostgreSQL ran in Docker Desktop on the same laptop: each query pays a virtualised network
  round trip, which dominates request types that issue many small queries (checkout ≈ 30
  queries → ~40 ms; on a native/LAN PostgreSQL this is typically 5–10 ms). The *stop word*
  deep-page query matches nothing on PostgreSQL (see notes below), so that row is not
  comparable across databases. `keyword + filters` searches "fiction", which matches 82% of the
  synthetic catalogue — a worst case for any ranker.
* Circulation throughput is a single client doing checkout+checkin pairs through the HTTP stack;
  it is unchanged within noise on SQLite (the extra covering indexes cost little on writes).

## What was slow, and what changed

| Hot spot (before) | Cause | Fix |
|---|---|---|
| Browse / facet filters took 1.5–3 s | `catalog.search` loaded **every matching row** into Python, filtered JSON arrays, counted facets and sorted in Python, then sliced a page | Filtering, counting, sorting and pagination moved into SQL. One grouped query returns the total *and* the format/language/decade facets; one ordered id query returns the page and the facet sample |
| Subject/author filters and facets | JSON arrays parsed per record | New `biblio_facets` table (one row per subject/author, maintained with the full-text index, bulk rebuilt by `reindex`) — filters become index lookups, facets one `GROUP BY` over the best 2,000 matches |
| Every search re-ran the full-text match several times | facets/counting reused the scored subquery | Separate unscored id subquery for counting/facets; BM25 / `ts_rank` only for ordering |
| Repeated browsing | totals and facets recomputed per request | Per-process LRU cache (60 s TTL) keyed by the catalogue signature *(max id, max updated_at — two index lookups)*; any record change invalidates. Not used for availability/branch filters |
| PostgreSQL ranking 300+ ms for common prefixes | `ts_rank_cd` (cover density) is ~10× dearer than `ts_rank` with prefix terms | Two-stage ranking: `ts_rank` for all matches, `ts_rank_cd` re-ranks the best 1,000 |
| Smart search loaded the whole filtered catalogue (`per_page=100000`) | structured filters applied by materialising every id | Filters applied only to the ≤5,300 keyword/semantic candidates (`catalog.filter_ids`); facets from a one-row search |
| Semantic index: 17 s build **inside the first request**, 378 MiB retained per process, full rebuild after every new record | dict/tuple postings, rebuild on any change, per process | Postings packed into `array('i')`/`array('f')` (≈8 bytes each), memoised stemming, impact-ordered postings with a per-term budget, incremental overlay for changed records, background build for catalogues over 20,000 records (requests never wait), HMAC-signed snapshot shared by processes (`ai_warmup` job) |
| "Readers also borrowed" 1.1–2.6 s | loaded **all** loan pairs of the last two years into Python per call | SQL: the title's 400 most recent readers → co-borrow counts → popularity for ≤500 candidates; covering index on `loans(item_id, issued_at, patron_id)` |
| Staff dashboard 7–15 s | overdue-risk loaded every open loan as ORM objects with eager joins; late-return stats with a 10k-element `IN` list; trending probed the loans index once per item | Risk scored over light tuples and only the top N loaded; stats via semi-join on a covering index, cached 5 min; trending aggregates per item first on `loans(issued_at, item_id, branch_id)` |
| Overdue loan list 2.7–8 s | `ORDER BY due_at` walked the whole due-date index checking `returned_at` | Partial index `loans(due_at) WHERE returned_at IS NULL` |
| Checkout regressed to 85 ms with the first draft of the new indexes | a `(returned_at, due_at)` index lured SQLite into scanning all open loans for "this patron's open loans" | Replaced by `(patron_id, returned_at, due_at)` (also covers late-return statistics) and the partial due-date index |
| `patron_id IS NOT NULL` predicates | SQLite chose a range scan over a patron index covering the whole loans table | Filtered in Python / with `count(column)` instead |

Indexes added (all created idempotently by `init-db`/start-up on existing databases):
`biblios(created_at)`, `biblios(updated_at)`, `biblios(lower(title))`,
`items(biblio_id, status, deleted_at, branch_id)`, `loans(item_id, issued_at, patron_id)`,
`loans(issued_at, item_id, branch_id)`, `loans(patron_id, issued_at, item_id)`,
`loans(patron_id, returned_at, due_at)`, `loans(due_at) WHERE returned_at IS NULL`,
`loans(updated_at)`, `biblio_facets(kind, value_norm, biblio_id)`, `biblio_facets(biblio_id, kind, value)`.

## Notes and limits

* **Facets**: format, language and decade counts are exact; subject and author counts are over
  the best 2,000 matches (exact whenever a search matches ≤ 2,000 records).
* **PostgreSQL stop words**: with the default `english` text-search configuration, words such as
  "the" are not indexed, so a query consisting only of stop words matches nothing (SQLite FTS5
  indexes every word). Use `LIBROWISE_PG_SEARCH_CONFIG=simple` for multilingual collections and
  run `python -m librowise reindex`.
* **Semantic search** reads at most 4,000 postings per query term (impact-ordered), so for
  very common terms only the strongest matches contribute — exact for typical vocabularies.
* **Caches are per process** (facet/total cache, late-return statistics, semantic index). Each
  is invalidated by catalogue changes or expires within minutes; nothing is shared state that
  could diverge permanently.
* **Remaining costs**: an availability-filtered browse over the whole catalogue must check every
  title's copies (~150–200 ms at 100k titles); a common-term query matching most of the
  catalogue still ranks every match (~100–250 ms). `run_nightly` still iterates open loans in
  Python (it runs in the background worker, ~12k open loans take a few seconds).
