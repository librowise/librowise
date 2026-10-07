# Interoperability: SIP2, SRU, OAI-PMH, copy cataloguing and schema.org

Librowise speaks the standard library protocols that self-check machines, security gates,
union catalogues, harvesters and search engines expect. This document covers each one:
what it does, how to configure it and what it supports.

| Protocol | Where | Who uses it |
|---|---|---|
| SIP2 (3M SIP 2.00) | TCP, `python -m librowise sip2` (default port 6001) | Self-check kiosks, security gates, sorters (AMH), e-book platforms |
| SRU 1.1 / 1.2 / 2.0 + CQL | `GET/POST /sru` | Other libraries' copy cataloguing, discovery layers, reference managers |
| OAI-PMH 2.0 | `GET/POST /oai` | Union catalogues, aggregators, discovery services |
| SRU client (copy cataloguing) | Staff → *Copy cataloguing* | Cataloguers importing records from the Library of Congress etc. |
| schema.org JSON-LD + Open Graph | Every OPAC record page `/record/{id}` | Search engines, link previews |

Staff can see all endpoints, and administrators can manage SIP2 accounts and copy-cataloguing
targets, under **Staff → Interoperability** (`/staff/interop`).

---

## 1. SIP2

### Running the server

The SIP2 server runs as its own process next to the web server and uses the same database
(`LIBROWISE_DATABASE_URL`):

```bash
python -m librowise sip2 --host 0.0.0.0 --port 6001
```

| Option | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | Interface to bind (`0.0.0.0` for all) |
| `--port` | `6001` | TCP port |
| `--delimiter` | `\|` | Field delimiter used **before** login (after login the account's own setting applies) |
| `--encoding` | `utf-8` | Character set used before login |
| `--login-timeout` | `60` | Seconds a connection may stay open without logging in |
| `--max-connections` | `256` | Concurrent connections (extra connections are refused) |
| `--certfile` / `--keyfile` | – | Serve SIP2 over TLS (TLS 1.2+) |
| `--log-level` | `INFO` | `DEBUG` also logs every message, with passwords (`CO`, `AD`, `AC`) masked |

SIP2 sends card numbers and PINs in clear text. Keep the port on the library network or VPN,
restrict each account to its terminals' addresses (*Allowed networks*), or use TLS (directly
with `--certfile`, or with stunnel in front).

Run it under your process manager like the web server, e.g. a systemd unit with
`ExecStart=/opt/librowise/.venv/bin/python -m librowise sip2 --host 0.0.0.0 --port 6001`,
or an extra service in `docker-compose.yml` using the same image with that command.

### SIP accounts

Each terminal logs in (message 93) with its own **SIP account**, managed by administrators at
*Staff → Interoperability → SIP2 accounts* or via `/api/v1/sip/accounts`. Passwords are stored
with Argon2id and must meet the normal password policy.

| Setting | Effect |
|---|---|
| Login / password | `CN` / `CO` of the login message |
| Branch | Loans, returns and renewals are recorded at this branch |
| Institution ID | Returned in `AO` |
| Allowed networks | Comma-separated IPs/CIDRs allowed to log in (empty = any) |
| Field delimiter, character set | Applied after login (`|` and UTF-8 by default; `cp850`, `latin-1` … for older devices) |
| Require checksums | Messages without a valid `AY`/`AZ` trailer are answered with `96` (resend) |
| Idle timeout | Connection is closed after this many idle seconds |
| Services | Checkout, check-in, renewals, patron information, holds, fee payment, block patron |
| Require patron PIN | Transactions and patron details require the patron's password in `AD` |
| Accept returns of items not on loan | `ok=1` (default) or `ok=0` when an item that was not checked out is returned |
| Sort bins | `CL` value for returns routed to a hold, a transfer, or everything else |

### Supported messages

| Request → Response | Notes |
|---|---|
| 93 → 94 Login | UID/PWD algorithm `0` only; 3 failures close the connection; rate-limited per IP |
| 99 → 98 SC/ACS status | Supported-messages bitmap (`BX`) reflects the account's services; timeout `100` (10 s), 3 retries |
| 23 → 24 Patron status | 14-char status, `BL` valid patron, `CQ` valid password (when `AD` is sent), `BH`/`BV` fees |
| 63 → 64 Patron information | Counts for holds/overdue/charged/fines/recalls/unavailable holds; item list selected by the summary field with `BP`/`BQ` range; limits `BZ`/`CB`/`CC`; `BD`/`BE`/`BF`, `PB` birth date, `PC` category, `PE` expiry. A wrong password discloses nothing |
| 11 → 12 Checkout | Renewal policy `Y` renews an item already on loan to the patron; no-block `Y` (offline) overrides blocks and honours the `nb due date`; desensitize `Y` on success; `AH` due date; `BK` loan id |
| 09 → 10 Checkin | Alert + `CV` alert type: `01` hold here, `02` hold elsewhere (transit), `04` send home; `CT` destination, `CY`/`DA` hold patron; `CL` sort bin; return date honoured for offline returns |
| 29 → 30 Renew | Third-party flag respected; no-block overrides |
| 65 → 66 Renew all | `BM` renewed / `BN` not renewed item lists |
| 17 → 18 Item information | Circulation status (03 available, 04 charged, 06 in process, 08 on hold shelf, 10 in transit, 12 lost, 13 withdrawn), security marker `02`, `CF` hold queue length, `AH` due date, `CM` hold pickup date, `AQ`/`AP` locations, `CS` call number |
| 35 → 36 End patron session | |
| 97 → last response | Resend; `96` if nothing was sent yet |
| 01 → 24 Block patron | Deactivates the account and records the block (card retained → "card reported lost") |
| 25 → 26 Patron enable | Clears blocks placed by SIP2 only; never re-enables an account suspended by staff |
| 15 → 16 Hold | `+` place (by item `AB` or biblio id in `AJ`; pickup `BS`), `-` cancel; `*` not supported |
| 37 → 38 Fee paid | Amount must be positive, in the library currency and not more than the balance |
| 19 → 20 Item status update | Answered with `item properties ok = 0` (not supported) |

Disabled services and requests before login get the proper "not OK" response for that message
type, with an explanation in `AF`. Malformed messages, unknown codes and checksum errors get
`96` (request resend); five consecutive errors close the connection. Messages may end with CR,
LF or CR LF; messages over 16 KiB close the connection.

Every transaction runs in its own database transaction through the same circulation services as
the staff desk (same rules, limits, fines and holds routing). The audit log entries written by
those services are tagged `via=sip2`, `sip_account`, `terminal` and the terminal's IP; logins,
failed logins, blocks and enables are audited too. Dates are sent in the library's time zone
(`LIBROWISE_TIMEZONE`, default `Asia/Kolkata`) in the SIP `YYYYMMDDZZZZHHMMSS` format.

### Sample self-check configuration

Most kiosks (3M/Bibliotheca, Envisionware, P-Series, …) ask for the same values:

```
ACS / LMS host ........ sip.library.example   (the machine running `python -m librowise sip2`)
Port .................. 6001
Login (CN) ............ kiosk-ground-floor     (a SIP account created in Staff → Interoperability)
Password (CO) ......... ••••••••••••
Location code (CP) .... MAIN                   (shown back in 98 as AN)
Institution ID (AO) ... LIBROWISE              (must match the SIP account)
Field delimiter ....... |
Message terminator .... CR (0x0D)
Error detection ....... on  (AY sequence + AZ checksum)  — tick "Require checksums" on the account
Character set ......... UTF-8 (or cp850 for older devices — set it on the account)
Renewal policy ........ Y   (re-scanning a borrowed item renews it)
Patron PIN ............ as required by library policy ("Require the patron's PIN" on the account)
```

A minimal session, for testing with `nc` or the bundled client:

```
→ 9300CNkiosk-ground-floor|COsecret|CPMAIN|AY0AZEFCE
← 941AY0AZFDFD
→ 9900802.00AY1AZFCA0
← 98YYYYNY100003...2.00AOLIBROWISE|AMLibrowise Public Library|BXYYYYYYYYYYYNYYYY|ANMAIN|...
```

```python
from librowise.sip2.client import SipClient
c = SipClient("127.0.0.1", 6001, error_detection=True)
c.login("kiosk-ground-floor", "secret", "MAIN")
print(c.request("63", ["001", c.now(), "  Y       "], [("AO", "LIBROWISE"), ("AA", "1000000001")]).fields)
```

The demo data (`python -m librowise seed`) creates the SIP account `selfcheck` /
`SelfCheck#Demo2026` at the Central Library — for local development only.

---

## 2. SRU server — `/sru`

SRU 1.1, 1.2 (default) and 2.0 over `GET` or `POST` (form-encoded).

* **explain** (the default when there is no `query`): server info, indexes, schemas, limits.
* **searchRetrieve**: `query` (CQL), `startRecord` (default 1), `maximumRecords` (default 10,
  capped at 100, 0 = count only), `recordSchema` (`marcxml` default, or `dc`),
  `recordPacking` (1.x) / `recordXMLEscaping` (2.0): `xml` or `string`.
* Responses use the proper namespaces (`http://www.loc.gov/zing/srw/` for 1.x,
  `http://docs.oasis-open.org/ns/search-ws/sruResponse` for 2.0) and include
  `echoedSearchRetrieveRequest` and `nextRecordPosition`.

### CQL

| Index | Maps to |
|---|---|
| `cql.serverChoice`, `cql.anywhere` (or no index) | all text fields |
| `dc.title` | title + subtitle |
| `dc.creator`, `dc.author`, `bath.name` | authors |
| `dc.subject` | subjects |
| `dc.publisher`, `dc.description` | publisher, description |
| `bath.isbn`, `bath.issn`, `dc.identifier` | ISBN (any form, normalised) / ISSN |
| `dc.date` | publication year (`= == < > <= >= <>`) |
| `dc.language` (`en` or `eng`), `dc.type` (`book`, `dvd` …) | exact match |
| `rec.id` | record number |
| `cql.allRecords` | every record |

Relations `=` and `all` (all words), `any` (any word), `adj`, `==` and `exact` (phrase);
booleans `and`, `or`, `not`; parentheses; quoted terms with `\"` escapes; right truncation with
`*`. Text clauses are compiled into SQLite FTS5 expressions made only of quoted word tokens and
passed as bound parameters — user text never reaches SQL.

Examples:

```
/sru?operation=searchRetrieve&version=1.2&query=dc.title%3Dhobbit
/sru?version=2.0&query=dc.creator all "tolkien" and dc.date>1950&recordSchema=dc
/sru?operation=searchRetrieve&version=1.2&query=bath.isbn%3D0261103342&recordPacking=string
```

### Diagnostics (`info:srw/diagnostic/1/N`)

1 general error · 4 unsupported operation (`scan`) · 5 unsupported version · 6 unsupported
parameter value · 7 mandatory parameter missing · 8 unsupported parameter · 10 query syntax
error · 13 parentheses · 16 unsupported index · 19 unsupported relation · 20 unsupported
relation modifier · 27 empty term · 36 term in invalid format · 37 unsupported boolean (`prox`)
· 46 boolean modifier · 61 first record out of range · 66 unknown schema · 71 unsupported
record packing · 72 XPath · 80 sort · 110 stylesheets.

---

## 3. OAI-PMH 2.0 — `/oai`

All six verbs over `GET` or `POST`: `Identify`, `ListMetadataFormats`, `ListSets`,
`ListIdentifiers`, `ListRecords`, `GetRecord`.

* **Formats:** `oai_dc` (simple Dublin Core) and `marc21` (MARCXML — the preserved original
  record when one was imported).
* **Identifiers:** `oai:<repository-id>:<record number>`, e.g. `oai:librowise.local:42`.
* **Sets:** one per material type (`book`, `ebook`, `audiobook`, `dvd`, `serial`, `comic`).
* **Datestamps:** the record's last modification, UTC, granularity `YYYY-MM-DDThh:mm:ssZ`
  (`from`/`until` also accept `YYYY-MM-DD`; both bounds inclusive).
* **Deleted records:** `deletedRecord=persistent` — soft-deleted records are listed with
  `<header status="deleted">` and no metadata.
* **Paging:** opaque, signed (HMAC with `LIBROWISE_SECRET_KEY`) resumption tokens with
  `cursor`, `completeListSize` and a 24-hour `expirationDate`. Paging is keyset-based on
  (datestamp, id), so records changed during a harvest are never skipped.
* **Errors:** `badVerb`, `badArgument` (unknown/missing/repeated arguments, bad dates, mixed
  granularities, `from` after `until`, resumptionToken combined with other arguments),
  `cannotDisseminateFormat`, `idDoesNotExist`, `noRecordsMatch`, `badResumptionToken`.

| Environment variable | Default | Meaning |
|---|---|---|
| `LIBROWISE_OAI_REPOSITORY_ID` | `librowise.local` | Repository identifier used in OAI identifiers (use your domain name) |
| `LIBROWISE_OAI_ADMIN_EMAIL` | first branch e-mail | `adminEmail` in Identify |
| `LIBROWISE_OAI_PAGE_SIZE` | `100` | Records per response |
| `LIBROWISE_PROTOCOL_REQUESTS_PER_MINUTE` | `300` | Per-IP limit for `/sru` and `/oai` (HTTP 503 + `Retry-After`) |

---

## 4. Copy cataloguing

*Staff → Copy cataloguing* (`/staff/copycat`, permission `catalog:write`) searches a remote
SRU catalogue by title, ISBN, author or raw CQL, shows each record's key fields and the full
MARC record, and imports a record with one click:

* The Library of Congress (`http://lx2.loc.gov:210/LCDB`, SRU 1.1, `dc.title` / `dc.creator` /
  `bath.isbn`) is built in. Administrators can add, reorder, disable or remove targets under
  *Interoperability → Copy-cataloguing targets* (`/api/v1/copycat/targets`); once any target is
  configured only configured targets are offered. Only `http(s)` URLs chosen by an
  administrator are ever contacted.
* Requests use httpx with the target's timeout (default 10 s) and a response size cap (8 MB);
  responses are parsed with the standard library's expat parser (no external entities).
* Imports are de-duplicated by normalised ISBN (HTTP 409 with `existing_biblio_id`; the UI
  offers "Import copy" when a duplicate is intended), keep the MARCXML verbatim (minus local
  `9XX` fields such as remote `952` holdings), are indexed for search immediately and audited
  (`copycat_import`). Add items from the record page afterwards.

API: `GET /api/v1/copycat/search?q=&kind=title|isbn|author|cql&target_id=&max=&start=`,
`POST /api/v1/copycat/import {marcxml, target_id?, allow_duplicate?}`.

---

## 5. schema.org JSON-LD and Open Graph

`/record/{id}` is rendered with, in `<head>`:

* `<script type="application/ld+json">` describing the work as `Book` (or `Audiobook`,
  `Movie`, `Periodical`, `CreativeWork`) with `name`, `author`, `isbn`, `datePublished`,
  `inLanguage`, `publisher`, `numberOfPages`, `about`, `description`, `image`, and one `Offer`
  per branch holding copies (`businessFunction` LeaseOut, `availability` InStock/OutOfStock,
  `inventoryLevel`, `offeredBy`/`availableAtOrFrom` the `Library`). The JSON is escaped with
  Jinja's `tojson`, so catalogue data can never break out of the script element.
* `og:*` / `book:*` tags, `<link rel="canonical">`, a record-specific `<title>` and
  description.

Unknown or deleted records return HTTP 404 with `noindex`.

---

## API and permissions summary

| Endpoint | Permission |
|---|---|
| `GET/POST /api/v1/sip/accounts`, `PATCH/DELETE /api/v1/sip/accounts/{id}` | `interop:manage` (administrators) |
| `GET /api/v1/copycat/targets` | `catalog:write` |
| `POST/PATCH/DELETE /api/v1/copycat/targets[/{id}]` | `interop:manage` |
| `GET /api/v1/copycat/search`, `POST /api/v1/copycat/import` | `catalog:write` |
| `/sru`, `/oai`, `/record/{id}` | public (rate-limited) |
