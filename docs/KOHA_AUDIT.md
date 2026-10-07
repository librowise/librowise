# Koha ILS: architecture & flaw audit

This audit drove the design of Librowise.

- **Audited tree:** `Koha-Community/Koha`, `main` at commit `a6676a63` (October 2026, shallow clone).
- **Method:** static analysis with grep/find/wc/awk over the source. No runtime testing.
- **Inferred findings:** items marked *(inferred)* come from reading code or packaged defaults and should be validated dynamically before anyone relies on them.

> **Responsible disclosure.** The audit found code paths that look security-relevant, including one that looks like a possible authenticated SQL-injection vector in a staff search feature. This public document does not give exploit details. Any security concern should be reported privately through Koha's own process (see `SECURITY.md` in the Koha repository). None of these issues has been confirmed by exploitation.

Koha is a mature, widely deployed, feature-rich system, built by a dedicated community over more than twenty years. The findings below are mostly the accumulated cost of that history. They are not a judgement of the project's value.

---

## 1. Executive summary

1. **Two of everything.** Koha has:
   - two business-logic namespaces: procedural `C4::` and OO `Koha::`;
   - two persistence styles: raw DBI and DBIx::Class;
   - two search engines: Zebra and Elasticsearch;
   - three web runtimes: CGI, Plack-wrapped CGI, and the Mojolicious REST API;
   - two UI stacks: Template Toolkit with jQuery, and Vue/TypeScript.
2. **Security by convention, not by default.**
   - Templates have no auto-escaping. They rely on more than 18,000 hand-written `| html` filters.
   - CSRF protection depends on an `op=cud-*` naming convention enforced by middleware.
   - The guided SQL report feature is guarded by a regex blocklist.
3. **927 system preferences.** 765 of them are referenced from Perl, at 2,870 Perl call sites and 1,586 template call sites. This makes the configuration space combinatorial and very hard to test.
4. **MySQL-only, MARC-centric data model.**
   - MARCXML is stored as a `longtext` blob.
   - The biblio/biblioitems split remains.
   - Six `deleted*` shadow tables duplicate their live tables.
   - 92 of 298 tables have no foreign keys.
5. **A partial REST API.** It offers 384 operations in OpenAPI **2.0**, against about 600 CGI pages and 49 legacy `svc` endpoints. There are no REST endpoints for check-in, serials, notices, reports or catalogue search.
6. **No modern discovery features.** Koha has no semantic search, embeddings or native recommendations. Enrichment comes from paid third parties.

## 2. Metrics

| Metric | Value |
|---|---|
| `.pl` scripts (excluding tests) | 1,403 (191,445 LOC) |
| Staff CGI pages / OPAC CGI pages | 409 / 96 |
| `.pm` modules | 1,365 |
| `C4/`: modules / LOC | 136 / 78,931 |
| `Koha/` (excl. Schema): modules / LOC | 886 / 149,331 |
| Auto-generated DBIC schema | 301 files / 61,622 LOC |
| Largest modules | `C4/Circulation.pm` 5,312 · `Koha/Patron.pm` 4,258 · `C4/Biblio.pm` 3,308 |
| Longest subroutines | `checkauth` 777 lines · `CanBookBeIssued` 662 · `AddReturn` 576 |
| REST API | 237 paths / 384 operations, Swagger **2.0** |
| System preferences | 927 rows; 21 `.pref` files (6,186 lines) |
| Database | 298 tables; 92 without any FK; 61 ENUM columns |
| Widest tables | `borrowers` 84 columns (mirrored by `deletedborrowers`) |
| Migrations | 29,573-line `updatedatabase.pl` plus 641 `db_revs`; none reversible |
| Raw DBI usage | `C4::Context->dbh` 800 occurrences in 292 files |
| Cross-namespace coupling | 198 `Koha/` files `use C4::`; 73 of 136 `C4` files `use Koha::` |
| Templates | 546 `.tt` + 332 `.inc`; 716 inline `<script>` blocks; 153 inline `on*=` handlers |
| Escaping filters | `\| html` 18,575 · `\| $raw` 2,412 |
| Front-end | ~4,000 jQuery calls; 129 `.vue` files; 43 MB vendored JS |
| Dependencies | 145 required + 46 recommended CPAN modules; 74 npm packages |
| Operations | 58 cron scripts; 11 systemd units; 33 Debian admin scripts |
| Tests | 796 `.t` files; 84% need a live database |
| Debt markers | FIXME 584 · TODO 223 · XXX 56 |

## 3. Findings

### Architecture

| ID | Severity | Finding |
|---|---|---|
| A1 | High | **Dual business-logic layer.** Rules live in procedural `C4::` modules that the OO `Koha::` layer still imports. Hold logic, for example, is split between `C4::Reserves` (28 subs) and `Koha::Hold`, so every rule has two possible homes. |
| A2 | High | **God modules and god functions.** `C4/Circulation.pm` has 5,312 lines and 109 preference lookups. `CanBookBeIssued` is 662 lines with 29 preference reads. These cannot be unit-tested in isolation. |
| A3 | Medium | **Three web runtimes.** CGI under Apache, the same scripts wrapped by `Plack::App::CGIBin` (which monkey-patches `CGI::new`), and a Mojolicious REST app. CSRF logic is duplicated between the middleware and a Mojolicious plugin. |
| A4 | Medium | **Global mutable state.** 415 `C4::Context->userenv` call sites, a global database handle, and test detection by sniffing `$ENV{_}`. |
| A5 | High | **Weak transactional integrity.** `AddReturn` performs more than 15 separate writes with no enclosing transaction. A crash mid-return can leave inconsistent state *(inferred)*. |

### Security

| ID | Severity | Finding |
|---|---|---|
| S1 | High *(inferred)* | **Dynamic SQL built from request parameters** in at least one staff-only search path, with no allow-list. Reported here without details; see the disclosure note above. |
| S2 | High | **Arbitrary SQL reports.** Reports run free-form SELECT statements on the primary connection. Validation is a regex blocklist that misses several dangerous constructs. There is no read-only role or replica option. Reports flagged public are served without authentication. |
| S3 | High *(inferred, CGI mode)* | **CSRF depends on Plack plus a naming convention.** The non-Plack check reads a parameter that nothing sets. Packaged vhosts ship with the Plack config commented out. |
| S4 | Medium | **No template auto-escaping.** Template Toolkit runs with `EVAL_PERL => 1`. XSS safety depends on hand-written filters and a lint test. |
| S5 | Medium | **Weak password hashing.** bcrypt cost is hard-coded at 8, unsalted legacy MD5 hashes are still accepted, and the comparison is not constant-time. |
| S6 | Medium *(inferred)* | **Session IDs.** `CGI::Session` with the `md5` ID generator, which is not a CSPRNG. |
| S7 | Medium | **Unsigned plugins.** Plugins are unsigned zip archives that run in-process with full privileges. They are disabled by default. |
| S8–S9 | Medium | **Raw JS/CSS injection and no CSP.** Admin-supplied JavaScript and CSS are injected raw through preferences, and CSP is off by default. 153 inline handlers would block a strict CSP. |
| S10 | Low–Medium | **Risky dynamic code paths.** String `eval` of profile files and shell-string construction in import/export code. |

Koha does have good security foundations: a private disclosure process, TOTP two-factor authentication, OAuth/OIDC, and IP-bound sessions.

### Data model

| ID | Severity | Finding |
|---|---|---|
| D1 | High | **MySQL/MariaDB lock-in.** Only a MySQL schema exists, and MySQL-specific SQL (`TO_DAYS`, `GROUP_CONCAT`, `ExtractValue`) appears in application code. |
| D2 | High | **MARC as an opaque blob.** MARC is stored in `longtext`. Unmapped fields can only be queried with full-scan `ExtractValue`, and MARCXML is re-parsed at more than 170 call sites. |
| D3 | Medium | **Shadow-table deletes.** Six `deleted*` tables mean every schema change is made twice. Personal data is retained by default *(inferred)*. |
| D4 | Medium | **Weak typing and integrity.** 92 tables have no foreign keys. Permissions are a bigint bitmask plus a side table. Preferences are untyped text. |
| D5 | Medium | **Irreversible migrations.** About 30,000 lines of imperative, up-only migrations. |

### Configuration, search, API and performance

| ID | Severity | Finding |
|---|---|---|
| C1 | High | **927 untyped system preferences.** Behaviour forks on them everywhere, including 582 lookups inside the "modern" `Koha/` namespace. |
| Q1 | High | **Two search engines maintained in parallel.** Zebra and Elasticsearch each need their own indexer daemon, the code branches on the engine in 13 places, and there are 22,882 lines of XSLT for result display. |
| Q2 | High | **No semantic or hybrid retrieval and no native recommendations.** |
| P1 | High | **Partial REST API.** It uses Swagger 2.0. Integrations are spread across SIP2, ILS-DI, OAI-PMH, Z39.50 and `svc/`. |
| F1–F3 | Medium | **Performance and operations.** CGI recompiles per request, caches are flushed per request under Plack, behaviour is batch/cron-driven (58 scripts), and there are full-scan and XSLT hotspots. |

### Maintainability, front-end and deployment

| ID | Severity | Finding |
|---|---|---|
| M1–M3 | Medium | **Code health.** About 860 debt markers, DB-bound tests that rely on monkey-patching, and 191 CPAN dependencies including overlapping date libraries. |
| U1 | Medium | **Hybrid UI.** About 550 server-rendered pages with inline jQuery, alongside Vue islands. |
| U2 | Medium | **Per-language template copies.** i18n generates a full copy of the template tree for each language. |
| U3 | Medium | **Accessibility gaps.** 921 `href="#"` pseudo-links, about 1,500 icons without `aria-hidden`, and no automated a11y testing. |
| O1 | Medium | **Heavy deployment.** Apache, MariaDB, Plack, Zebra or Elasticsearch, an indexer, a worker, optionally RabbitMQ and memcached, SIP and Z39.50 daemons, configured in XML and orchestrated by shell scripts. |

## 4. How Librowise responds

| Koha issue | Librowise design |
|---|---|
| C4/Koha duplication, god functions (A1, A2) | One typed service layer (`librowise/services`). Circulation is small, pure functions over SQLAlchemy sessions. |
| Non-atomic returns (A5) | Every endpoint is one transaction. A partial unique index makes double checkout impossible at the database level. |
| Regex-guarded SQL reports (S2) | Only vetted, parameterised reports, with CSV export and formula-injection neutralisation. No user SQL ever reaches the database. |
| CSRF by convention (S3) | Double-submit CSRF token enforced by middleware on **every** unsafe cookie-authenticated request. |
| No auto-escape (S4, S8, S9) | Jinja2 auto-escaping plus an escaping `html` tagged template in the UI. Strict CSP (`script-src 'self'`) and zero inline scripts or handlers. |
| bcrypt-8 and MD5 (S5, S6) | Argon2id with transparent re-hash. Signed, expiring tokens bound to a password fingerprint, so a password change revokes every session. Login rate limiting. |
| MySQL lock-in, MARC blob (D1, D2) | Portable SQLAlchemy models (SQLite by default, PostgreSQL ready). Normalised fields plus the original MARCXML preserved verbatim. |
| Shadow `deleted*` tables (D3) | Soft-delete columns, GDPR-style erasure, automatic loan-history anonymisation, and a per-patron history opt-out. |
| 927 sysprefs (C1) | Typed deployment settings (Pydantic) and **9** documented library policies. Circulation rules are a single wildcard matrix with an "explain" endpoint. |
| Two search engines (Q1) | One engine: SQLite FTS5 with BM25 field weighting and prefix matching. No daemon to run. |
| No modern discovery (Q2) | Hybrid BM25 + semantic retrieval fused with RRF, natural-language query understanding, recommendations, cataloguing AI, and a staff copilot. Claude is used when configured, with local models otherwise. |
| Partial REST API (P1) | API-first: every UI action goes through the same OpenAPI 3.1 JSON API, including check-in, reports, holds and admin. |
| Hybrid jQuery/Vue UI, a11y gaps (U1, U3) | One design system. Light, dark, sepia and high-contrast themes, density and text-size controls, keyboard-first command palette, labelled controls, skip links, reduced-motion support. |
| Heavy deployment (O1) | One process (`python -m librowise run`), 12-factor environment config, Dockerfile, and health/readiness probes. |
| Cron sprawl (F2) | One idempotent nightly job (`python -m librowise nightly`), also triggerable from the admin UI. |
| Koha migration | MARC21/MARCXML import understands Koha `952` holdings, and patron CSV import accepts Koha borrower column names. |
