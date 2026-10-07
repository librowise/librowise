# Shelfwise ILS

**A modern, AI-assisted integrated library system, written in Python. It reimagines [Koha](https://koha-community.org) for the 2020s.**

Shelfwise covers the core of an ILS:

- cataloguing, including MARC21/MARCXML
- circulation, holds and fines
- patrons and a public catalogue (OPAC) with self-service
- acquisitions, reports and administration

It runs as one fast Python process with a secure-by-default design and a polished, accessible UI. AI features are built in: they use **Claude** when an API key is configured and fall back to **local models** that need no network.

> The design comes from a source-level audit of Koha: [`docs/KOHA_AUDIT.md`](docs/KOHA_AUDIT.md).

---

## Highlights

### For patrons (OPAC)
- **AI search that understands plain language**, e.g. *"funny books for kids about space published after 2015"*. The query is parsed into filters (audience, year, language, format, author, availability) and ranked by fusing BM25 keyword relevance with semantic similarity. The UI shows how the query was understood.
- **Instant keyword search** (SQLite FTS5 with BM25 field weighting, stemming, diacritic folding and prefix matching), with facets for format, language, subject, author and decade.
- **Personal recommendations** ("Picked for you") and "You might also like" on every title.
- **Self-service account:** renew loans (one at a time or all), place and cancel holds with live queue position, reading lists (private or public), ratings and reviews, charges, and password changes.
- **Privacy controls:** turn reading history off, or clear it at any time.
- **Appearance:** light, dark, sepia and high-contrast themes, comfortable or compact density, and adjustable text size. Settings follow your account across devices.

### For staff
- **Circulation desk** built for scanners:
  - check out, check in and receive transfers, with F2/F3/F4 shortcuts
  - **camera barcode scanning** through the browser's BarcodeDetector
  - policy blocks with an explicit override, a session feed and printable receipts
- **Automatic hold routing on check-in.** The hold shelf or an in-transit transfer is set automatically, with patron notifications, pickup expiry and a pull list.
- **Cataloguing:**
  - ISBN lookup (Open Library) with duplicate detection
  - **AI enrichment** suggesting subject headings, Dewey class, audience and summary
  - MARC21/MARCXML import and export; Koha exports with `952` holdings import directly
- **Patrons:** registration, editing, payments, waivers and charges, history, and GDPR-style erasure. CSV import accepts Koha borrower columns.
- **Acquisitions:** vendors, budgets with spend meters, orders, and receiving that creates items automatically. **AI purchase suggestions** come from hold-queue demand.
- **Reports:** a dashboard plus vetted, parameterised reports, all exportable as CSV. No raw SQL ever runs.
- **AI insights:**
  - **late-return risk scoring** (a transparent logistic model)
  - duplicate-record detection
  - weeding candidates
  - a natural-language query lab
- **Library copilot (Ctrl+J).** Ask *"Which loans are overdue?"*, *"What should we buy more copies of?"* or *"Summarise patron 1000000001"*. It answers from live data through **read-only tools**: with Claude it runs an agentic tool loop, and without it a local intent router calls the same tools.
- **Command palette (Ctrl+K).** Navigate, search the catalogue or patrons, run actions, or ask the copilot from anywhere.
- **Administration:**
  - branches, item types and patron categories
  - a **circulation rule matrix with an "explain" tool**
  - 9 typed policy settings (Koha has 927)
  - audit log, nightly jobs and reindexing

### Under the hood
| | Koha | Shelfwise |
|---|---|---|
| Stack | Perl CGI + Plack + Mojolicious, TT + jQuery + Vue | FastAPI (OpenAPI 3.1) + SQLAlchemy 2 + vanilla ES modules |
| Search | Zebra **or** Elasticsearch (plus indexer daemons) | SQLite FTS5 BM25 + semantic index, hybrid RRF |
| Database | MySQL/MariaDB only, 298 tables | SQLite by default, PostgreSQL-ready, ~20 tables |
| Configuration | 927 untyped system preferences | Typed env settings + 9 documented policies |
| Passwords | bcrypt cost 8, legacy MD5 accepted | Argon2id with transparent re-hashing |
| CSRF / XSS | naming convention / hand-written filters | Enforced middleware / auto-escaping + strict CSP |
| Reports | free-form SQL behind a regex blocklist | vetted parameterised reports, CSV formula-safe |
| Deletion | `deleted*` shadow tables | soft deletes, erasure, history anonymisation |
| AI | none | NL search, recommendations, cataloguing, copilot, risk, dedupe |

---

## Quick start

```bash
git clone https://github.com/<org>/shelfwise.git && cd shelfwise
python -m venv .venv && . .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
python -m shelfwise seed       # creates shelfwise.db with demo data
python -m shelfwise run        # http://127.0.0.1:8000
```

**Demo accounts** (seeded databases only; defined in `shelfwise/seed.py`):

| Role | Login | Password |
|---|---|---|
| Administrator | `admin` | `Shelfwise#Admin2026` |
| Librarian | `librarian` | `Shelfwise#Staff2026` |
| Patron | `1000000001` | `Reader#Demo2026` |

The login page also has one-click demo buttons. The interactive API docs are at `/api/docs`.

### Enable Claude
The AI features already work offline. To use Claude (`claude-opus-5-5`) for query understanding, cataloguing and the agentic copilot, set an API key before starting:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Requests use structured outputs for JSON and strict tool schemas, with server-side refusal fallbacks enabled. If credentials are missing, rejected or rate-limited, Shelfwise switches to the local engine automatically and backs off before trying Claude again. The copilot's tools are read-only.

### Docker
```bash
docker compose up --build      # app + PostgreSQL, http://localhost:8000
docker compose exec app python -m shelfwise seed
```

### Configuration (environment variables)
| Variable | Default | Notes |
|---|---|---|
| `SHELFWISE_DATABASE_URL` | `sqlite:///<project>/shelfwise.db` | e.g. `postgresql+psycopg://user:pass@host/db` |
| `SHELFWISE_SECRET_KEY` | generated in `.shelfwise_secret` | **set this in production** |
| `SHELFWISE_COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `SHELFWISE_ALLOWED_HOSTS` | `["*"]` | JSON list |
| `SHELFWISE_AI_ENABLED` | `true` | turn off all LLM calls |
| `SHELFWISE_AI_MODEL` | `claude-opus-5-5` | |
| `SHELFWISE_METADATA_LOOKUP_ENABLED` | `true` | Open Library ISBN lookups |
| `ANTHROPIC_API_KEY` | – | enables Claude |

### CLI
```
python -m shelfwise init-db        # create tables + search index
python -m shelfwise seed           # demo data
python -m shelfwise create-admin --username jdoe --email jdoe@library.org
python -m shelfwise nightly        # notices, hold expiry, anonymisation (run from cron)
python -m shelfwise reindex        # rebuild the full-text index
python -m shelfwise run --host 0.0.0.0 --port 8000
```

### Migrating from Koha
1. Export bibliographic records with items from Koha (*Tools → Export data*, MARCXML or MARC21, including `952` items). Import them in **Administration → System → Import MARC**. Barcodes, home branch (`952$a`), item type (`952$y`), call number (`952$o`) and price (`952$g`) are mapped, and the original MARC is preserved.
2. Export patrons as CSV (`cardnumber, surname, firstname, email, phone, address, categorycode, branchcode, dateexpiry`). Import them in **Administration → System → Import patrons**.
3. Re-create branches, item types and categories with matching codes before importing.

---

## Architecture

```
shelfwise/
  app.py            ASGI factory: security headers, CSP, CSRF, timing, error mapping, health probes
  config.py         typed settings (env / .env)
  models.py         SQLAlchemy 2 models (one biblio table, soft deletes, integer money)
  security.py       Argon2id, signed sessions, CSRF, RBAC, rate limiting
  services/         domain logic — catalog (FTS5), circulation (rules, fines, holds), MARC, audit, settings
  ai/               semantic index, NL search, cataloguing, recommendations, insights, copilot, Claude client
  api/              JSON API routers (OpenAPI 3.1 at /api/docs)
  web.py            page routes (thin shells; all data via the API)
  templates/        Jinja2 (auto-escaped) — OPAC + staff
  static/           design system (CSS tokens, themes) + ES-module pages, no build step
tests/              pytest suite: security, circulation, catalogue, AI, API, pages
```

**Design principles:** API-first, one transaction per request, database-enforced invariants, no inline JS (strict CSP), and graceful degradation for every AI feature.

## Testing
```bash
pytest            # 60 tests: security, circulation rules, holds routing, search, AI, MARC, API, pages
ruff check .
```

## Security
See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.

## License
GPL-3.0-or-later, the same licence family as Koha. Shelfwise is an independent implementation and contains no Koha code.

## Cataloguing tools

**Authority control** (*Staff → Authorities*, API `/api/v1/authorities`)
- Seven authority types (personal/corporate/meeting names, uniform titles, topical/geographic/genre subjects) with see-from variants (4XX), see-also references (5XX with broader/narrower/related/earlier/later), source thesaurus and notes.
- Headings are matched on a normalised key (case, diacritics and punctuation folded). Whenever a record's authors, subjects or series change, they are linked to authorities and **variants are rewritten to the authorised form**; `"Whale fishing -- Fiction"` becomes `"Whaling -- Fiction"` via the main heading. Names also match without dates/qualifiers when that is unambiguous (linked, not rewritten). The policy setting `authority_auto_link` (default on) controls this.
- **Rename** propagates to every linked record and re-indexes it; **merge** shows a preview of every record change before it runs; delete is blocked while a heading is in use.
- MARC21 authority import/export (1XX/4XX/5XX, MARCXML or ISO 2709), a one-off *Generate from catalogue* bootstrap, and an *Unlinked headings* report with fuzzy "did you mean" suggestions.
- CLI: `python -m shelfwise authorities relink` (re-derive all links) and `python -m shelfwise authorities generate`.
- OPAC: **`/browse`** — alphabetical author/subject/series index with record counts, "see" references from variants and "see also" links; each heading opens a filtered search.

**MARC editor** (*record page → MARC editor*): field/subfield grid with indicators, add/remove/reorder, leader and control fields, a built-in MARC21 field dictionary (~100 tags) for hints and repeatability checks, live validation, keyboard shortcuts, a MarcEdit-style text view (`=245  10$aTitle`) and a MARCXML view with round-trip conversion. Saving shows a diff first, stores the MARCXML and re-derives the record's fields; items are never touched and stale edits are rejected.

**Labels & cards** (*Staff → Labels & cards*): pure-Python Code 128 (subsets B/C chosen automatically) rendered as SVG; spine labels, barcode labels and patron cards on A4/Letter sheet layouts (Avery-style presets plus your own), starting at any position on a partly used sheet. Print pages use print CSS and work under the strict CSP.

**Batch & inventory** (*Staff → Batch & inventory*): batch modify (branch, location, item type, status, notes, call-number prefix) and batch withdraw/delete from a barcode list or a catalogue search, always previewed item by item first; items on loan, in transit or on the hold shelf are protected. Inventory compares scanned barcodes with a branch/location/call-number range and reports missing, out-of-place and wrong-status items (with one-click check-in), marks items as seen, and exports CSV.

Permissions added: `authorities:write`, `items:batch`, `inventory`, `labels` (granted to librarians).
