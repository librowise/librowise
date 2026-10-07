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

## Circulation services: calendar, holds, notices, registration, suggestions

**Library calendar** (*Staff → Calendar*). Each branch has weekly closed days plus dated closures (one branch or all
branches, optionally repeating yearly, or a *special opening* on a normally closed day). Computed due dates (checkout
and renewal) move to the issuing branch's next open day; overdue fines count only open days late (policy
`fines_skip_closed_days`, default on); the hold-shelf pickup window is measured in open days.

**Holds.** Item-level holds (a specific copy, `item_id`) or next available; suspend/resume, optionally until a date
(suspended holds keep their queue place, are skipped by routing/the pull list/renewal checks and resume automatically);
a patron "not needed after" date (expired by the nightly job); notes and pickup-branch edits. Available in the staff
holds queue, patron and record pages, and in the OPAC (account *Holds* tab and the place-hold dialog).

**Notices** (*Staff → Notices*). Templates per notice code (`HOLD_READY`, `DUE_SOON`, `OVERDUE`, `WELCOME`,
`REGISTRATION_APPROVED`, `REGISTRATION_REJECTED`, `PURCHASE_SUGGESTION_UPDATE`) and channel (email/SMS), rendered in an
immutable Jinja2 **sandbox** from plain dicts, with a live preview. Patrons choose email, SMS or none per notice type
(*My account → Settings*). Every notice goes through the `notifications` outbox (`pending` → `sent`/`failed`, attempts,
last error, exponential backoff):

```bash
python -m shelfwise send-notices --limit 200   # or call services.notices.deliver_pending(db, limit) from a worker
```

| Setting (env) | Default | Purpose |
| --- | --- | --- |
| `SHELFWISE_EMAIL_BACKEND` | `console` | `console` (log) or `smtp` |
| `SHELFWISE_SMTP_HOST` / `_PORT` / `_USERNAME` / `_PASSWORD` / `_FROM` | `localhost` / `587` / – / – / `Shelfwise Library <no-reply@…>` | SMTP relay |
| `SHELFWISE_SMTP_STARTTLS` / `SHELFWISE_SMTP_SSL` | `true` / `false` | STARTTLS or implicit TLS |
| `SHELFWISE_SMS_BACKEND` | `console` | `console` or `webhook` |
| `SHELFWISE_SMS_WEBHOOK_URL` / `_TOKEN` | – | POST `{"to","body","notice_id","code"}` with optional bearer token |
| `SHELFWISE_REGISTRATIONS_PER_HOUR` | `5` | self-registrations per client IP |

**Self-registration** (`/register`): rate-limited, honeypot-protected, password policy; creates an inactive account with
`registration_status = pending`. Staff approve/reject in *Staff → Patron requests*; the applicant receives
REGISTRATION_APPROVED/REJECTED. Sign-in explains "awaiting approval" (only after the password is verified).

**Purchase suggestions**: patrons suggest titles from *My account → Suggest a purchase* and follow their status; staff
accept (optionally creating a **draft** purchase order against a vendor/budget) or reject with a reason in
*Staff → Patron requests*; the patron is notified on every change.

Policies: `fines_skip_closed_days`, `allow_self_registration`, `self_registration_category`, `allow_purchase_suggestions`,
`notice_max_attempts`. Permissions: `calendar:manage`, `notices:outbox`, `patrons:approve`, `suggestions:manage`
(librarians) and `notices:manage` (template editing — administrators).

## Serials & course reserves

**Serials control** (staff → *Serials*, API `/api/v1/serials`, permissions `serials:read` / `serials:write`):

- *Subscriptions* link a serial record (`material_type = "serial"`) to a vendor, optional budget and receiving branch, with start/end dates and status (active / expired / cancelled).
- *Prediction*: frequencies daily, weekly, fortnightly, monthly, bimonthly (every 2 months), quarterly, semiannual, annual, irregular, or every N days / weeks / months; day-based frequencies can skip weekdays. Numbering patterns such as `Vol. {X}, No. {Y}` use up to three odometer levels (start, increment, "rollover after", reset value, optional yearly restart, optional labels such as seasons) plus `{YEAR}`, `{MONTH}`, `{MON}`, `{DAY}`. The subscription form shows a live preview of the next six issues. Regeneration is safe: received, claimed, missing, not-published and manually added issues are never changed.
- *Issue lifecycle*: expected → arrived (optionally creating an item whose call number ends with the enumeration) / late (expected date + grace period passed) / missing / claimed / not published; bulk receive; undo a receipt while the item has never been loaned. Irregular serials get issues added by hand (numbering continues automatically).
- *Claims*: late-issues report grouped by vendor, claim recording (count + last claimed date + audit) and printable per-vendor claim letters (`/staff/serials/claims/{batch}`, with a mailto link), claim history, and renewal alerts for subscriptions ending soon.
- *Nightly job*: `python -m shelfwise nightly` (and the admin nightly endpoint) now also runs hooks listed in `services/circulation.py` `NIGHTLY_HOOKS`; the serials hook expires ended subscriptions, keeps ~180 days of predictions and flags late issues (`serials.mark_late_issues`). Each hook runs in a savepoint, so a failing hook cannot break circulation jobs.
- OPAC record pages for serials show *Latest issues* (public endpoint `/api/v1/serials/public/biblios/{id}/issues`).

**Course reserves** (staff → *Course reserves*, OPAC `/courses`, API `/api/v1/courses`, permissions `courses:read` / `courses:write`):

- Courses have a code, optional section, name, department, term, instructors (patrons), active flag and public/staff notes.
- Reserve items by barcode scan or catalogue search, or reserve a whole title. While any active course reserves an item, it can switch to a short-loan item type (the demo data seeds `RES`: 1-day loans, no renewals) and/or a reserve shelf location; the original values are remembered and restored when the last active course releases the item (reserve removed, course deactivated or deleted). Values staff changed by hand in the meantime are left alone. An item can be on reserve for several courses.
- *End of term*: bulk-deactivate every course in a term (or selected courses) in one step; reactivating re-applies the reserve settings.
- The OPAC lists active courses (search by code, name, department or instructor) and each course's readings with live availability.
