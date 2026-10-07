# Shelfwise UI audit

*Audit date: 7 October 2026 · build 1.0.0 (branch `worktree-agent-a1e5377d0589ae16f`) · seeded demo database.*

This document is the evidence base for the page-by-page redesign. It covers every HTML page of the
OPAC, staff client, kiosk and utility pages, in four themes (light, dark, sepia, high contrast), at two
viewports (1440×900 desktop, 390×844 phone), and in Hindi and Urdu. The findings come from three
sources:

1. **`scripts/ui_audit.py`**: the automated audit (Playwright on Microsoft Edge, axe-core 4.14.0 with
   the WCAG 2.0/2.1/2.2 A and AA rule tags, Web Vitals, overflow and label probes, an untranslated-string
   heuristic). Re-run it after every redesign step; see [Running the audit](#9-running-the-audit).
2. **Manual review** of the screenshots it produced (`var/ui-audit/shots/<page>__<theme>__<viewport>.jpg`,
   git-ignored; regenerate them with the command below).
3. **Code reading** of templates and page modules, for patterns that screenshots do not show (keyboard
   behaviour, copy, duplicated helpers, error paths).

Priorities:

- **P0**: broken, inaccessible (fails WCAG 2.2 AA), leaks data, or blocks a task.
- **P1**: inconsistent or confusing; slows a common workflow; i18n gaps on shipped languages.
- **P2**: polish.

Evidence references a screenshot as `shots/<file>.jpg` (relative to `var/ui-audit/`), an axe rule id, or
a source location. "All staff pages" means every page rendered by `staff_base.html`.

---

## 1. Summary

**Coverage.** There are 94 audited screens, including tab, dialog and state variants. Every route in
`web.py` is covered, apart from the non-HTML routes (manifest, service worker, SRU and OAI). The
baseline run made 912 visits: 4 themes × 2 viewports in English, plus Hindi and Urdu at desktop size.
It ran in 12 minutes at concurrency 6.

**Baseline (before the fixes on this branch), all themes and viewports:**

- **0** JavaScript errors and **0** uncaught exceptions on any visit.
- **0** CSP violations. CSP stays enforced during the audit, and axe is injected as an init script.
- **0** pages with horizontal overflow at 390 px. Wide tables scroll inside `.table-wrap` instead (see
  `scrollable-region-focusable`).
- **0** unlabeled form controls, **0** images without `alt`, and **0** duplicate ids.
- Network errors appear only where they are expected: the missing-record page (404) and the empty
  login (422).
- **7 axe rules violated, all of impact *serious*.** Together they cause 1,522 failing visits and
  3,677 failing nodes.

| axe rule | Pages | Visits | Nodes | Root cause |
|---|---|---|---|---|
| `color-contrast` | 86 | 228 | 1,787 | the light `--muted` token (#6b7484); the success badge (#15803d on #e8f6ec, 4.49:1) in the light and sepia themes; calendar "All branches" tags (2.2–3.1:1); the error toast in dark and contrast (white on #f87171, 2.77:1) |
| `label-content-name-mismatch` | 60 | 476 | 872 | top-bar search trigger and avatar (every staff page); calendar day buttons |
| `aria-hidden-focus` | 59 | 468 | 468 | closed copilot drawer (every staff page) |
| `link-in-text-block` | 35 | 270 | 310 | colour-only links in text |
| `scrollable-region-focusable` | 14 | 64 | 64 | reports and audit tables (desktop); every `.table-wrap` and `pre` that scrolls on phones |
| `aria-input-field-name` | 1 | 8 | 8 | command palette listbox |
| `target-size` | 1 | 8 | 168 | label start-position grid |

**After the fixes (light and dark, both viewports, 372 visits):**

| axe rule | Before: pages / visits / nodes | After: pages / visits / nodes |
|---|---|---|
| `color-contrast` | 86 / 173 / 1553 | 1 / 2 / 5 (calendar tags) |
| `label-content-name-mismatch` | 60 / 238 / 436 | 1 / 2 / 4 (calendar days) |
| `aria-hidden-focus` | 59 / 234 / 234 | 0 / 0 / 0 |
| `link-in-text-block` | 35 / 132 / 152 | 35 / 132 / 152 (open, P0 #5) |
| `target-size` | 1 / 4 / 84 | 1 / 4 / 84 (open) |
| `scrollable-region-focusable` | 14 / 32 / 32 | 11 / 22 / 22 (phones; open) |
| `aria-input-field-name` | 1 / 4 / 4 | 0 / 0 / 0 |
| **Total** | **817 visits / 2,495 nodes** | **162 visits / 267 nodes** |

**Web Vitals** (light theme, local SQLite server; TTFB outliers above 1 s are contention from the
parallel run and are ignored):

- **LCP is good** (< 1 s) on every staff page. OPAC pages with cover art run 2.6–3.2 s, because the
  LCP element is an external cover image.
- **CLS is poor on desktop staff pages.** Analytics 0.42, AI insights 0.34, system 0.33, calendar
  0.23, and dashboard, acquisitions and reports 0.18–0.19. OPAC browse is 0.135.
- **CLS is very poor on phones.** The staff dashboard reaches 0.72 and the MARC editor 0.76; the
  top-bar and KPI grid reflow after data arrives. OPAC search results reach 0.56.
- **DOM size** peaks on analytics, at about 2,500 nodes; every other page is under 1,000.

**Priority counts.** The finding tables in §2 and §3 hold 72 rows: 9 × P0, 38 × P1 and 25 × P2. The
P0 rows describe 8 distinct issues, because the muted-text contrast appears twice. **Fixed on this
branch:** 5 of the 8 P0 issues, 6 P1 rows and 1 P2 row. Section 4 lists the design-inconsistency
inventory, section 5 the copy and i18n issues, and sections 6 and 7 the heuristic and workflow
review.

### Top 15 findings

| # | P | Finding | Where | Status |
|---|---|---------|-------|--------|
| 1 | P0 | The light theme's `--muted` text colour (#6b7484) is 4.40:1 on `--bg` and 4.24:1 on `--surface-2`, under the 4.5:1 AA minimum. This one token accounts for most `color-contrast` failures: page subtitles, inactive tabs, table headers, hints, footers and the sidebar's `Alt+N` hints. | 86 of 94 screens (light) | **Fixed** (token now #636b7a, ≥ 4.75:1 on every light surface) |
| 2 | P0 | The closed AI copilot drawer is `aria-hidden="true"` but its chips, input and buttons stay focusable, so keyboard users tab into an invisible panel. Its shadow also bleeds onto the right edge of every staff page. | All staff pages · `aria-hidden-focus` | **Fixed** (`inert` + `visibility:hidden` while closed) |
| 3 | P0 | The circulation receipt printed every checkout of the session under the *current* patron's name, so patron A's loans could be printed on patron B's slip (a privacy leak at a shared desk). | Circulation | **Fixed** (receipt filters by patron) |
| 4 | P0 | The login page shipped a "Demo accounts" panel, with the demo passwords hard-coded in `login.js`, in every environment including production. | Login | **Fixed** (rendered only outside production; the credentials come from the server) |
| 5 | P0 | Links in running text are only distinguishable by colour (teal on grey is 1.16:1 against the surrounding text, under the required 3:1), with no underline. | Footer on every OPAC page, register, course, browse cross-references, staff breadcrumbs · `link-in-text-block` | Open: underline links inside text (`p a, .sub a, footer a, nav.crumbs a`) |
| 6 | P0 | Scanning at the circulation desk: the barcode field is **disabled** while each request runs, so keystrokes from a fast scanner for the next barcode are dropped. Failures only appear as a line in the session feed, with no sound and no focus change. | Circulation | Open: queue scans and never disable the input; add an error tone and an `alert` banner (kiosk.js already has both) |
| 7 | P0 | Error toasts in the dark and high-contrast themes are white on light red (2.77:1), and success toasts in dark are white on light green (1.74:1). Messages that matter most are the least legible. | Every page that raises a toast · `color-contrast` | Open: dark text on light status colours, or a stronger status background per theme |
| 8 | P1 | Staff pages shift after first paint: CLS 0.19 on the dashboard, 0.23 calendar, 0.33 system, 0.34 AI insights, 0.42 analytics (good is < 0.1), and 0.72–0.88 for the dashboard on a phone. Skeletons don't match the final layout, and late-loading toolbars push content down. | Insights, Admin, Front desk | Open: give skeletons and KPI rows fixed heights; render toolbars server-side |
| 9 | P1 | Large parts of the UI are hard-coded English: 33 of 47 templates (excluding the icon sprite) make **zero** `t()` calls (all Collection, People, Insights and Admin pages, plus OPAC browse, courses, register and reset-password). Hindi and Urdu users get English pages inside a translated shell. | See §5 | Open |
| 10 | P1 | Destructive actions sit beside primary ones with equal weight: **Delete** next to **Edit record** in the record header, **Erase** next to **Edit** in the patron header, **Lost** next to **Renew** on every loan row. | Staff record, patron | Open: move them into an overflow ("More") menu or a "Danger zone" section |
| 11 | P1 | Check-in with hold routing only raises a toast for 8 s plus a feed line. There's no modal, no hold or transit slip to print, and no sound, so the item can be shelved by mistake. | Circulation (check-in) | Open: blocking dialog with **Print slip** and **Done**, and a distinct tone |
| 12 | P1 | Phone layouts: the OPAC header wraps to three rows (≈140 px) with no menu button. The staff top bar squeezes the search trigger to an icon-sized box and clips the language select ("Englis…"). Wide tables (admin, holds, acquisitions) hide their action columns off-screen with no scroll cue. | `shots/opac-*__mobile`, `shots/staff-*__mobile` | Open |
| 13 | P1 | Seven tab implementations are copy-pasted (`setupTabs` in staff-admin, -authorities, -batch, -holds, -interop, -roles, lib/sc-ui). The staff patron tabs and OPAC account tabs follow different ARIA patterns (no `aria-controls` or roving tabindex on the patron page). | See §4.6 | Open: one `tabs()` helper in core.js |
| 14 | P1 | Error copy leaks internals. Submitting the empty login form showed *"username: String should have at least 1 character; password: …"* twice (inline and as a toast). Raw enum values appear in the UI: `pending`, `ai_warmup`, `deliver_notices`, Language `en`, Format `book`, Audience `adult`. | Login, requests, system, staff record | Login **fixed**; the rest open (§5.1) |
| 15 | P1 | The command palette's `Alt+1…9` hints were hard-coded to the old flat navigation, so they disagreed with the grouped sidebar (e.g. palette "Catalogue Alt+3" while Alt+3 opens Holds). The listbox had no accessible name. | Staff palette | **Fixed** (hints read from the sidebar; listbox labelled) |

---

## 2. Findings by page family

Columns: **P**riority · **Page** · **Theme/viewport** (`all` = every combination) · **Evidence** ·
**Recommendation**.

### 2.1 OPAC

| P | Page | Theme / VP | Evidence | Recommendation |
|---|------|-----------|----------|----------------|
| P0 | every OPAC page | light | `color-contrast`: footer text, inactive account tabs, search-mode toggle (4.23–4.40:1) | **Fixed** by the `--muted` token change |
| P0 | footer, register, course, browse | light, sepia | `link-in-text-block`: "Open API", "Sign in", instructor link, see-also references | Underline links in text; keep colour-only links for navigation bars |
| P0 | login | all | `login.js` `DEMO` constant held the demo passwords; the panel showed in production | **Fixed**: the panel and its credentials are rendered only when `environment != production` |
| P1 | login | all | `shots/login-validation__*`: raw Pydantic message, shown as both inline error and toast (`withBusy` toasts, then `showError` repeats it) | **Fixed** for empty fields (client-side check, translated). Still open: `withBusy` should not toast when the caller renders the error inline |
| P1 | login | hi, ur | `view()` overwrites the translated heading and subtitle with hard-coded English ("Welcome back", "Reset your password") whenever the view changes; "Forgot password?", "New to the library?", "Single sign-on" are untranslated | Move the strings to `login.*` keys |
| P1 | header | mobile | `shots/opac-home__light__mobile.jpg`: brand, nav and tools wrap to three rows | Collapse nav and tools into a menu button below 640 px; keep **Sign in** visible |
| P1 | header | all | "Browse" → `/search`, "Authors & subjects" → `/browse` (h1 "Browse the catalogue") | Rename to **Search** / **Browse A–Z**; make the h1 match the nav label |
| P1 | record | all | Place-hold button shown for titles with no holdable copies ("No copies" magazines); label switches between "Reserve a copy" and "Place hold" | Hide or disable it with a reason ("Reference only"); always say "Place hold" |
| P1 | record → hold | mobile | Anonymous **Place hold** → login → back on the record with the intent lost, so the patron taps again (§7.4) | Return with `?action=hold` and open the dialog automatically |
| P1 | record hold dialog | hi, ur | "Copy", "Next available copy (fastest)", "Not needed after (optional)" and the hints are English literals in `opac-record.js` | Add `opac.record.hold_*` keys |
| P1 | record | all | After a hold is placed, only a toast confirms it; the button still says "Place hold" | Swap the button to "On hold · #n in queue" with a link to Account → Holds |
| P1 | browse, courses, register, reset-password | hi, ur | 0 `t()` calls; `shots/opac-register__hi__desktop.jpg` is entirely English | Translate (≈ 60 strings) |
| P2 | record (missing) | all | `shots/opac-record-404__*`: no h1, only an empty-state line and "Back to results" even without a search | 404 template with h1, search box and "Recently added" |
| P2 | home | all | LCP 2.6–3.2 s; the LCP element is an external cover image; shelves scroll horizontally with no visible affordance (last card clipped) | Lazy-load below-the-fold covers, `fetchpriority=high` on the first, prefetch covers server-side; add scroll buttons or a fade edge |
| P2 | search | mobile | Facets render *after* all results, with no "Filters" button; subject chips wrap to three lines per result | Add a sticky **Filters (n)** button opening a sheet; truncate chips to 2 with "+n" |
| P2 | search, catalogue | all | Generated-cover titles spill out of 60 px covers (`div.cover > .gen > .gt`, e.g. "The Metamorphosis") | Clamp with `overflow-wrap:anywhere` and 3-line clamp |
| P2 | account | all | Stat cards are inconsistent (Overdue has no note); charges in red with no "How to pay"; heading levels skip (h1 → h3) in panels | One stat-card component; add a payment hint or link; fix heading levels |
| P2 | account | mobile | 8 tabs in one row scroll horizontally with no overflow cue | Use a select or segmented menu on phones, or group into "Borrowing / Lists / Settings" |

### 2.2 Front desk (dashboard, circulation, holds, kiosk, calendar, kiosks)

| P | Page | Theme / VP | Evidence | Recommendation |
|---|------|-----------|----------|----------------|
| P0 | every staff page | all | `aria-hidden-focus` on `#copilot` (58/58 staff pages) | **Fixed** |
| P0 | circulation | all | `printReceipt()` printed every checkout of the session regardless of patron | **Fixed**; recommend also clearing the feed (or starting a new "visit") when the patron changes |
| P0 | circulation | all | `#barcode` gets `disabled` during each request (`staff-circulation.js` item-form submit), so scanner input typed meanwhile is lost | Keep the field enabled; push barcodes onto a queue processed sequentially; show the pending count |
| P1 | circulation | all | Checkout failures appear only as a feed line; no audio; the patron block banner says "You can still override" but the override is only offered after a failed scan | Error tone plus a red banner above the field until dismissed; offer "Override for this visit" on the patron card |
| P1 | circulation (check-in) | all | Hold routing: toast (8 s) plus feed alert; no slip | Modal: "Hold for *Patron* at *Branch* → put on hold shelf / in transit", **Print slip** focused |
| P1 | circulation | all | `heading_skips` (h1 → h3 "Current loans", "This session") | Use h2 for card titles across the staff UI |
| P1 | dashboard | all | CLS 0.19; KPI "1 overdue (33%)" is not a link; "Holds to pull 6" tile is not a link | Fixed-height KPI row; make every KPI a deep link (overdue → Reports#overdues, pull → Holds#pull) |
| P1 | command palette | all | `aria-input-field-name` (listbox unnamed); stale Alt+N hints; no `aria-activedescendant`/`aria-controls` combobox wiring | Hints and name **fixed**; still open: combobox semantics so screen readers announce the active option |
| P1 | top bar | mobile | `shots/staff-dashboard__light__mobile.jpg`: search trigger reduced to ~40 px with clipped text; Copilot becomes an unlabeled-looking purple square; language select clipped | Phone top bar: menu, search icon, avatar; move language and appearance into the avatar menu |
| P1 | holds | all | `shots/staff-holds-queue__light__desktop.jpg`: each row has three differently styled actions (outlined "Suspend", icon-only pencil, red "Cancel"); 31 rows with no search or patron filter; no bulk actions | Row actions in one overflow menu; add filters (patron, title, branch, status) and checkboxes for bulk suspend/cancel |
| P1 | holds "To pull" | all | Pull list duplicated between the dashboard (Today at the desk) and Holds → To pull, with different columns | One pull-list component; the dashboard shows the top 5 and links to the full list |
| P2 | calendar | all | CLS 0.25; `label-content-name-mismatch` on closed days (aria-label "Friday, 2 October 2026" vs visible "2 Closed") | Include the visible status in the label ("Friday 2 October 2026, closed") |
| P2 | kiosk | mobile | `shots/kiosk-session__light__mobile.jpg`: barcode input shrinks to ~140 px beside **Borrow**; disabled-looking **Renew** | Stack input and button on phones; explain why renew is unavailable |
| P2 | kiosk | all | Good overall: big targets, live regions, idle timeout, high-contrast toggle. Its own `.kiosk-*` component set duplicates buttons and inputs | Fold kiosk sizes into design-system size tokens (`--control-xl`) |

### 2.3 Collection (catalogue, record, edit, MARC, authorities, labels, batch, copy cataloguing, acquisitions, serials, courses)

| P | Page | Theme / VP | Evidence | Recommendation |
|---|------|-----------|----------|----------------|
| P1 | record edit / new | all | Pressing Enter in the ISBN field (what barcode scanners do) submitted the whole form ("Title is required") instead of fetching metadata | **Fixed**: Enter in ISBN runs **Fetch metadata** |
| P1 | staff record | all | `shots/staff-record__light__desktop.jpg`: **Delete** (danger) sits between **MARC editor** and **Edit record** | Move to an overflow menu; show item count in the confirm text |
| P1 | staff record | all | Details show codes: Language `en`, Format `book`, Audience `adult` | Map through the same labels as the edit form (`FORMAT`, audience names, `Intl.DisplayNames` for languages) |
| P1 | staff record | all | "Readers also borrowed" renders 8 cover rows (≈ 800 px) in the sidebar, pushing nothing useful but dwarfing the main column | Compact list (title + author), 5 items, "More" link |
| P1 | catalogue | all | 25 rows per page with 60 px covers per row: only ~10 records visible; no column choice or density toggle on the table | Compact table mode (no covers) as default for staff; remember the choice |
| P1 | all Collection pages | hi, ur | 0 `t()` calls in templates; 40–60 untranslated strings per page (audit `untranslated`) | Translate |
| P1 | MARC editor | all | Header mixes three button styles for peer actions: text "Back to record", ghost "Discard changes", primary "Review & save" | Breadcrumb for back; secondary + primary pair for discard/save |
| P2 | labels | all | `target-size` (21 nodes): start-position grid cells are 8.6 px apart | Min 24×24 px targets or a number input as alternative |
| P2 | labels print | all | No h1 on the print sheet page | Visually hidden h1 ("Label sheet: n labels") |
| P2 | acquisitions | all | PO titles are plain text (not links to the record); AI "Order" buttons use the purple `btn ai` style for a normal primary action | Link titles; reserve the AI style for AI-generated suggestions themselves, not the action |
| P2 | copy cataloguing | all | Good empty state; "Original record" header action duplicates "New record" in the catalogue under a different name | Use one name ("New record") everywhere |
| P2 | batch | all | Nav label "Batch item tools", h1 "Batch item tools & inventory", web.py label "Batch & inventory" | One name |
| P2 | authorities, batch, serials | all | Seven ad-hoc `max-height` scroll tables (`style="max-height:18rem;overflow:auto"`) | `table-wrap.scroll` modifier with `tabindex=0` and a label |

### 2.4 People (patrons, patron, requests, notices, roles, security)

| P | Page | Theme / VP | Evidence | Recommendation |
|---|------|-----------|----------|----------------|
| P1 | patron | all | `shots/staff-patron__light__desktop.jpg`: **Erase** next to **Edit**; **Lost** (danger) next to **Renew** on every loan row | Overflow menus; Lost only inside a row menu |
| P1 | patron | all | Tabs are buttons with `role=tab` but no `aria-controls`, ids or arrow-key support (unlike other tab sets) | Shared tabs helper |
| P1 | patrons | all | No filters for overdue, owes fines, expired, blocked; the only filter is Role | Add those quick filters (they answer "who is overdue?" in one click, §7.5) |
| P1 | requests | all | Status badge shows the raw value `pending` in lowercase; no bulk approve | Label map; select-all + Approve selected |
| P1 | every staff page | all | `label-content-name-mismatch`: search trigger (aria-label "Open command palette" vs visible "Search or run a command…") and avatar (aria-label vs initials) | **Fixed** |
| P2 | roles | all | Four tabs; "User access" needs a user picked first but the empty state does not say how | Empty state with a search field |
| P2 | notices | all | Outbox failures badge appears only after load (layout shift in the tab bar) | Reserve badge width |

### 2.5 Insights (reports, analytics, AI insights)

| P | Page | Theme / VP | Evidence | Recommendation |
|---|------|-----------|----------|----------------|
| P1 | reports | all | `scrollable-region-focusable`: the 70 vh result table can't be scrolled by keyboard | **Fixed** (`tabindex=0`, `role=region`, label) |
| P1 | analytics | all | CLS 0.43 (worst page); range toolbar and charts render after data | Reserve chart heights; server-render the toolbar |
| P1 | AI insights | all | CLS 0.34; the copilot drawer reads "Live data · · read-only" (empty engine name until `/ai/status` returns) | Skeleton text "…" for the engine |
| P2 | analytics | all | `link-in-text-block` for subject links inside the table | Underline or style as chips |
| P2 | reports | all | The first report runs automatically (good) but there's no title-level description of the period selector being disabled for snapshot reports except a `title` tooltip | Inline hint "Snapshot, no period" |

### 2.6 Admin (administration, system, interop, kiosks)

| P | Page | Theme / VP | Evidence | Recommendation |
|---|------|-----------|----------|----------------|
| P1 | admin → audit log | all | `scrollable-region-focusable` | **Fixed** |
| P1 | system | all | `shots/staff-system__light__desktop.jpg`: "Connection" label collides with its value (no gap) and the value is URL-encoded (`D%3A`); schedules show raw cron (`0 2 * * *`) and job ids (`ai_warmup`) | Wrap kv rows; decode paths; humanise cron ("Daily at 02:00"); label jobs |
| P1 | admin + system | all | Two different "System" destinations (Administration → System tab, and /staff/system) | Merge or rename ("Maintenance" vs "System health") |
| P1 | admin | mobile | `shots/staff-admin-branches__light__mobile.jpg`: 7 tabs overflow; tables clip the action column | Tabs → select on phones; card list for tables under 640 px |
| P2 | interop | light | `color-contrast` on table headers (`th`, 4.23:1) | Fixed by the token change |
| P2 | rules | all | Edit is a ghost text button, delete an icon-only red trash, a different pairing from holds/acquisitions | Standard row-action menu |

---

## 3. Theme-specific notes

| P | Theme | Evidence | Recommendation |
|---|---|---|---|
| P0 | light | `--muted` #6b7484 is 4.40:1 on `--bg`, 4.24:1 on `--surface-2` and 4.17:1 on `--primary-soft` (514 + 289 + 25 nodes) | **Fixed**: now #636b7a, at 5.00 / 4.83 / 4.75:1 |
| P0 | light, sepia | `.badge.ok` / `.badge.available`: #15803d on #e8f6ec is 4.49:1 (20 nodes light, 160 sepia: sepia inherits `--success`) | **Fixed**: `--success` #147a3a (4.86:1) |
| P0 | dark, contrast | Error toast: white text on `--danger` (#f87171 dark, #ff6b6b contrast) is 2.77:1. The success toast in dark is worse (white on #4ade80, 1.74:1; not hit by the audit, which raised no success toast) | Toasts: dark text on light status colours, or a `--danger-strong`/`--success-strong` background per theme |
| P1 | all | Calendar "All branches" tag (#9ea3ad on #fef3f3, 2.3:1) and closed-day reason (3.1:1) | Use `--muted` (fixed token) instead of the custom greys |
| P1 | dark | Links in body text are teal on light grey text (link-in-text-block), so they're harder to distinguish than in light | Underline (P0 #5) |
| P2 | contrast | Theme works well: borders are white, focus rings are cyan, and there are no contrast failures except the toast. Inline `style="background:var(--surface-2)"` cards lose their boundary (surface-2 is #0b0b0b on #000) | Rely on borders, not surface tints, in contrast mode |
| P2 | sepia | Only the badge issue above. Charts use their own sepia palette (good) | — |
| P2 | all | `theme-color` meta is fixed to teal/near-black and does not follow sepia/contrast | Update `meta[name=theme-color]` in `applyPrefs` |
| P2 | system (no `data-theme`) | Six kiosk visits rendered with no theme attribute (the kiosk has its own high-contrast toggle stored separately, `sw-kiosk-prefs`) | Let the kiosk honour `sw-prefs.theme` as its default |

---

## 4. Design inconsistency inventory

Counts are from the source (`grep` over templates and JS) and from the audit's per-page `inventory`
probe (`report.json` → `results[].inventory`). The redesign should collapse each list into one pattern.

### 4.1 Buttons

| Variant (class string) | Uses | Notes |
|---|---|---|
| `btn sm` | 73 | default row action |
| `btn` | 60 | default |
| `btn primary` | 55 | |
| `btn ghost sm` / `btn sm ghost` | 19 / 18 | **same thing, two orders** |
| `btn sm ghost danger` / `btn ghost sm danger` | 15 / 1 | icon-only deletes |
| `btn sm danger` | 12 | text deletes ("Cancel", "Lost") |
| `btn ghost icon-only` / `btn ghost sm icon-only` / `btn sm icon-only` | 10 / 3 / 2 | three icon-button sizes |
| `btn sm primary` / `btn primary sm` | 9 / 2 | order again |
| `btn primary lg`, `btn lg` | 6 / 1 | login, kiosk |
| `btn primary kiosk-btn`, `btn kiosk-btn`, `btn ghost kiosk-tool` | 6 / 3 / 3 | kiosk-only system |
| `btn ai`, `btn sm ai`, `btn ai sm` | 3 / 1 / 1 | AI gradient; also used for non-AI "Order" |
| `btn danger` | 6 | header deletes (Delete, Erase) |
| plain `<button>` styled as link | login "Forgot password?" (bold text), MARC "Back to record" | |
| `.chip` buttons | 36 | filters, suggestions, theme picker, demo accounts |
| `.mode-switch` / `.seg` segmented buttons | 2 / 2 | circulation modes vs other toggles, different CSS |

**Placement**: page-level primary actions live at the top right of `.page-head` (catalogue, patrons,
acquisitions), but on record/patron pages they sit inside a card header, on circulation inside the
form, and on the MARC editor in a sticky bar. Destructive actions appear in headers (record, patron),
in rows (holds, acquisitions, admin) and in dialogs. Recommendation: a page header with
`[secondary…] [primary]` on the right and a `⋯` overflow for destructive/rare actions; row actions in a
single menu button.

### 4.2 Tables

- 62 × `table.table`, plus `viz-data`, `sc-levels`, `sc-issues` variants.
- 54 × wrapped in `.table-wrap` with no modifiers, 7 × `table-wrap` with an inline
  `max-height:…;overflow:auto` (14rem, 16rem, 18rem ×2, 24rem, 32rem, 70vh), and some bare tables in cards.
- Header cells: some have `scope="col"` (reports, analytics), most don't.
- Numeric alignment: `.num` class in reports and analytics, `class="right"` elsewhere, inline styles in places.
- Row actions: text buttons, icon-only buttons and mixed (see 4.1).
- Empty table states: `empty()` component in some, `<p class="small muted">No …</p>` in others (16 distinct strings).
- Mobile: every table scrolls horizontally; none collapses to cards.

### 4.3 Forms

- Field = `.field > label + input + .hint`; good and consistent.
- Inline toolbars use `.card.pad.row` with a fake label `<label>&nbsp;</label>` (8 occurrences) to align
  buttons with inputs. It's an empty label for screen readers, so replace it with `align-items:end`.
- Two-column grids: `.grid.cols-2` with `style="grid-column:1/-1"` repeated 22 times. Add a `.span-all` utility.
- Required fields: "Title *" (asterisk in the label text) in the record form and registration; `required` alone elsewhere.
- Validation: `novalidate` forms with toasts ("Title is required") in staff, inline `role=alert` in login
  and kiosk, `reportValidity()` in modals. Recommend inline field errors with `aria-invalid` and
  `aria-describedby` everywhere, and a summary for long forms.
- Search forms: OPAC search (`.searchbox` with AI/Keyword mode), staff catalogue (`.card.pad.row` with
  Search button), patrons (same), copy cataloguing (same with a "Show" select), browse (form with Jump
  to). Recommend one search-bar component with optional filters slot.

### 4.4 Modals and overlays

| Pattern | Where | Notes |
|---|---|---|
| `modal()` in core.js (`<dialog>` + head/body/foot) | ~40 call sites | good: focus return, labelled |
| `confirmDialog()` (wrapper over `modal`) | 44 call sites | danger by default, even for non-destructive confirmations ("Check in & lend") |
| Hand-built `<dialog>` | circulation camera scanner, kiosk idle dialog, record-extras citation dialog, command palette | each re-implements head/close markup |
| `dialog.wide`, `dialog.sc-xwide` | serials | width variants defined in two places |
| Drawer (`aside.drawer`) | copilot only | |
| Print windows via `window.open` + `document.write` | circulation receipt; labels use a page | two print approaches |

### 4.5 Page headers

- `.page-head` (h1 + `.sub` + actions): 29 templates.
- **No** `.page-head` (custom header markup): staff record, staff patron, serial, course, labels print,
  OPAC home/search/record/courses/register, login, kiosk.
- Breadcrumbs: `<nav class="small muted" style="margin-bottom:.75rem">` hand-written in 9 places, with
  inconsistent `aria-label` (only the OPAC record has one) and no `aria-current`.
- Headings: the h1 sometimes repeats the nav label ("Patrons"), sometimes differs ("Library calendar"
  vs nav "Calendar", "Self-checkout kiosks" vs "Kiosks", "AI Insights" vs palette "AI insights",
  "Batch item tools & inventory" vs "Batch item tools").
- Card titles use h3 directly under the page h1 (heading-level skips on 20+ pages).

### 4.6 Tabs and segmented controls

- `.tabs[role=tablist]` with `button[role=tab]`: 14 templates; keyboard support comes from 7 copies of
  `setupTabs()` (staff-admin, -authorities, -batch, -holds, -interop, -roles, `lib/sc-ui.js`) plus bespoke
  `select()` functions in notices, requests, marc-editor and opac-account.
- Staff patron tabs: no ids, no `aria-controls`, no roving tabindex.
- Segmented: `.mode-switch` (circulation), `.searchbox .mode` (OPAC AI/Keyword), `.seg`, theme
  chips in the appearance dialog: four looks for one control.
- Hash deep-links work on most tab pages (good); the OPAC browse tabs use `?index=` instead.

### 4.7 Empty, loading and error states

- `empty(msg, icon)` component: 108 uses; `<div class="empty">` literal: 6; muted one-liners: 16.
- Loading: `skeleton()` bars (111 uses), but some panels render nothing until data arrives (analytics
  toolbar, notices badges); this is the main source of the CLS above.
- Errors: toast (`toast(…, "error")`, 223 toast calls in total), `errorBox()` in reports, `.alert.bad`
  inline, `role=alert` paragraphs in login/kiosk, `empty(e.message, "alert")` in record pages. Pick
  one: inline `alert` for page-level failures, toast only for background actions.

### 4.8 Badges and status

- Two vocabularies on the same `.badge`: semantic (`ok`, `warn`, `bad`, `info`, `ai`) and
  domain statuses (`available`, `on_loan`, `overdue`, `withdrawn`, `ready`, `queued`, …).
- Misuse: `badge("withdrawn", "No copies")` for availability; `badge("", "No"|"Inactive"|"Never"|
  "Disabled")` (unstyled neutral, 4+ places); `badge("", "Expires …")` on patrons.
- Raw lowercase values rendered directly (`pending`, job states).
- Counts in tabs use `.badge` (holds, requests, notices, serials) and appear after load.
- Recommendation: `<Status kind="success|warning|danger|info|neutral|ai">` with a label map per domain.

### 4.9 Other duplicated components

- Stat tiles: `kpiTile()` in charts.js (dashboard, analytics), `stat()` in staff-reports.js, another
  `stat()` in staff-batch.js, `.desk-stat` (dashboard desk), kiosk counts, OPAC account `#stats`.
  That's five implementations.
- Key–value lists: `.kv` (26), `.dl` (4), `kv()` helper in staff-system.js.
- Inline `style=""`: 368 in templates and JS (top: `margin:0` ×51, `grid-column:1/-1` ×22,
  `margin-bottom:1rem` ×19, `width:auto` ×12). These belong in utilities.

---

## 5. Copy, microcopy and i18n

### 5.1 Copy issues

| Where | Now | Suggest |
|---|---|---|
| Login, empty submit | "username: String should have at least 1 character; password: …" (shown twice) | "Enter your card number or e-mail and your password." (**fixed**) |
| OPAC nav | "Browse" (opens search) / "Authors & subjects" | "Search" / "Browse A–Z" |
| OPAC record | "Reserve a copy" vs "Place hold" | "Place hold" |
| Staff record details | "Language en", "Format book", "Audience adult" | "English", "Book", "Adult" |
| Patron requests | badge "pending" | "Pending review" |
| System | "ai_warmup", "deliver_notices", `0 2 * * *` | "Warm AI index", "Send notices", "Daily 02:00" |
| Copilot header | "Live data · · read-only" before status loads | "Live data · read-only" |
| Circulation | "Tip: you can also type a name — we'll search." | fine; but say what happens with several matches (it silently picks the first!) |
| Dashboard | "-1 vs same day last week (1)" | "1 fewer than last Wednesday" |
| Confirm dialogs | danger-red primary for "Check in & lend" | neutral primary for non-destructive confirms |
| Copy cataloguing | "Original record" | "New record" (same action as the catalogue's button) |
| My account & security | "Lina Librarian · librarian · Librarian · Central Library" (role shown twice, once raw) | "Lina Librarian · Librarian · Central Library" |
| Record edit | "Language (ISO code)" free-text field, default `en` | language picker with names (`Intl.DisplayNames`) |
| Staff ISBN lookup | seeded ISBN 9780140439076 fetches *The Sign of Four* from Open Library for *The Adventures of Sherlock Holmes* | (seed data) worth fixing so demos don't show a mismatch |
| Names | "AI Insights" / "AI insights", "Kiosks" / "Self-checkout kiosks", "Calendar" / "Library calendar", three names for batch tools | one name per destination |

### 5.2 i18n gaps (Hindi `hi`, Urdu `ur`)

The message catalogues are complete for the keys the code uses (518 keys, no gaps, plurals handled).
The gap is **strings that never go through `t()`**:

Measured by the audit's Hindi pass (`--langs hi,ur`): visible UI strings that are still Latin-script.
Book data is excluded where it can be recognised, and lists are capped at 80 per page. **2,334
strings in Hindi (2,308 in Urdu) across 84 pages; only 15 pages are clean.** About 13 per staff page
come from the copilot drawer in `staff_base.html`.

| Family | Pages | Untranslated (hi) | Worst pages | Clean pages |
|---|---|---|---|---|
| OPAC | 23 | 99 | opac-account-settings (21), opac-register (16), opac-courses (15), opac-browse (15), opac-course (12) | search (all states), home, record 404, account loans/holds/lists/history/for-you/charges, offline |
| Front desk | 12 | 336 | staff-calendar (75), staff-holds-new (41), staff-circulation-transfer (31), staff-holds-queue (30), staff-holds-pull (30) | kiosk-setup, kiosk-welcome |
| Collection | 23 | 967 | staff-marc-editor (≥80), staff-labels-print (≥80), staff-labels (≥80), staff-serial (51), staff-batch-modify (49) | — |
| People | 11 | 326 | staff-patrons-new (45), staff-security (36), staff-notices (33), staff-patron (32), staff-roles-roles (29) | — |
| Insights | 4 | 249 | staff-analytics (≥80), staff-insights (60), staff-reports (55), staff-reports-weeding (54) | — |
| Admin | 11 | 357 | staff-system (59), staff-admin-system (38), staff-admin-rules (38), staff-admin-audit (37), staff-admin-categories (31) | — |

Examples: "Register patron", "Name, card number or email" (patrons); "Weekly closed days" (calendar);
"Back to record", "Review & save" (MARC editor); "Job queue", "0 queued · 0 running · 0 retrying ·
0 dead" (system); "Notifications", "Choose how we contact you." (OPAC account settings); "Join Shelfwise
Public Library", "First name *" (register). The staff dashboard, kiosk, OPAC home, search and record
are the only fully translated screens, and the translated sidebar and top bar make the untranslated
page bodies more jarring.

Other i18n issues:

- `login.js` `view()` and the hold dialog in `opac-record.js` overwrite translated text with English.
- Mixed numerals in Urdu: KPI values use Arabic-Indic digits (۱, ۳) while adjacent labels keep Latin
  ("7 دن", "67%"); pick one per locale (recommend `Intl.NumberFormat` everywhere, or Latin digits
  everywhere for staff UIs).
- The pull-list arrow "→" (patron → branch) is not mirrored in RTL.
- Date/time in Urdu shows "PM" from the server-formatted time.
- The copilot drawer's welcome text and suggestion chips are English on every staff page.

---

## 6. Heuristic review (Nielsen's 10)

| # | Heuristic | Assessment | Key issues / recommendations |
|---|---|---|---|
| 1 | Visibility of system status | **Good** in circulation feed, kiosk, MARC editor checks, system page. **Weak** where data loads late (CLS), after placing a hold (toast only), and in the copilot ("…" engine). | Persistent state changes on the trigger (hold button → "On hold"); fixed-height skeletons |
| 2 | Match with the real world | Mostly library vocabulary (good: "pull list", "hold shelf", "in transit"). Leaks: raw codes (`en`, `book`, `pending`, cron). OPAC "Browse" means search. | Label maps; rename OPAC nav |
| 3 | User control and freedom | Dialogs return focus and cancel cleanly; MARC editor has "Discard changes". **Missing undo** for check-in/checkout (no "undo last scan"), for hold cancel, for batch edits (there's a preview, which is good). | "Undo" in the circulation feed for 30 s; soft-cancel holds |
| 4 | Consistency and standards | Weakest area: §4 lists 5 stat tiles, 7 tab helpers, 4 segmented controls, 2 badge vocabularies, mixed action placement. | Design system consolidation |
| 5 | Error prevention | Good: duplicate-record detection, MARC validation, batch preview, confirm on destructive actions. Weak: Delete/Erase/Lost placed beside common actions; scanner input dropped while disabled; patron search silently takes the first match. | Overflow menus; queue scans; disambiguation list |
| 6 | Recognition rather than recall | Command palette, keyboard hints and the sidebar's Alt+N hints help. Hints were stale (fixed). The F2/F3/F4 shortcuts are shown only in the circulation subtitle. | Show shortcuts in tooltips; a `?` help overlay listing per-page keys |
| 7 | Flexibility and efficiency | Strong for experts: palette, Alt+N, F-keys, hash deep-links, MARC keyboard. Weak: no bulk actions on holds/requests, no saved filters, no density toggle on the catalogue table. | Bulk actions, saved filters, compact tables |
| 8 | Aesthetic and minimalist design | Clean visual base. Overloaded spots: record sidebar ("Readers also borrowed" ×8 covers), holds rows (3 buttons), dashboard (13 tiles before the first list). | Trim; progressive disclosure |
| 9 | Help users recover from errors | Error messages are often good domain messages ("Checkout blocked: …" with override). Bad: framework validation text, double reporting (toast + inline), failures in a scroll feed only. | One error channel per context; plain-language messages |
| 10 | Help and documentation | Inline hints are plentiful (ISBN, registration, MARC field help). No in-app help/glossary, no first-run tour, the API docs link is the only "help". | Contextual "?" links to a short guide per module |

---

## 7. Library workflow walkthroughs

Step counts are user actions (keystrokes/scans count as one action per field), measured on the seeded
build at 1440×900 unless noted.

### 7.1 Check out 10 items to one patron

1. Circulation (Alt+2, or F2 anywhere on the page) · 2. scan card, Enter · 3–12. scan item ×10 (Enter is
sent by the scanner) · 13. **Print receipt** (optional).

**12 actions, which is excellent and on par with Koha.** Friction:
- The barcode field is disabled while each checkout is in flight. A scanner sending the next code
  within ~150 ms loses characters (P0 above), so staff learn to wait for each beep that isn't there.
- No audio feedback (the kiosk has it; the desk doesn't).
- Each scan re-fetches the whole patron (`refreshPatron`). That's fine on LAN, but adds 1 round-trip per item.
- Blocks are shown on load, but override is only offered per failed item (10 confirmations for a
  patron over the fine limit). Offer "Override for this visit".
- The receipt mixed patrons (fixed).

### 7.2 Check in with hold routing

1. Circulation · 2. F3 (or click **Check in**) · 3. scan.

**3 actions.** When the item fills a hold the only signals are an 8-second toast and an info line in
the feed; nothing stops the next scan. There's no hold slip or transit slip to print (Koha prints one).
Recommend a blocking dialog with the pickup location, patron initials and a focused **Print slip**
button, plus a distinct tone.

### 7.3 Catalogue a new book from its ISBN

1. Catalogue → **New record** · 2. scan/type ISBN · 3. **Fetch metadata** (before the fix, scanner Enter
submitted the form and showed "Title is required") · 4. review fields · 5. (optional) **Suggest
subjects & classification** + 1 click per suggestion · 6. **Save record** · 7. on the record page
**Add item** · 8. barcode · 9. item type/branch/call number · 10. save item.

**10 actions, plus AI suggestions as needed.** Friction: the item is a separate step on another page (offer
"Save and add item" with barcode on the same form); the duplicate warning only appears after the
title is typed or fetched; the copy-cataloguing route (SRU) is a separate page with a different button
name ("Original record"). The language field asks for an ISO code ("Language (ISO code)").

### 7.4 Place a hold from the OPAC on a phone (anonymous start)

1. Type query, Search · 2. tap result · 3. tap **Reserve a copy / Place hold** · 4. login: card ·
5. password · 6. **Sign in** → back on the record · 7. tap **Place hold** *again* · 8. confirm pickup in
the dialog → **Place hold**.

**8 taps plus typing.** Friction: the hold intent is lost across login (step 7); the mobile header takes 3
rows; the dialog's "Copy" and "Not needed after" fields are English in Hindi/Urdu; after success only a
toast confirms (the button doesn't change). Signed-in patrons need 4 actions.

### 7.5 Find patrons with overdue items

Path A: Reports (Alt+n varies) → the "Overdues" report runs first → **2 actions**. Path B: Dashboard →
KPI "1 overdue": not clickable. Path C: Patrons: no overdue filter at all. Path D: ask the copilot
"Which loans are overdue?" (works, 2 actions).

Friction: the obvious places (dashboard KPI, patrons list) are dead ends; the report has no
"Send reminder"/"Open patron" row actions. Recommend linking the KPI, adding an
**Overdue** quick filter on Patrons, and row actions on the report.

---

## 8. Fixes made on this branch

These are small, unambiguous fixes. Everything structural is left to the redesign. Each fix was
verified by re-running the audit and with a scripted Edge check (palette hints, drawer `inert`
state, ISBN Enter, login validation, demo sign-in).

| # | Fix | Files | Evidence before → after |
|---|---|---|---|
| 1 | Closed copilot drawer is `inert` (toggled on open/close) and `visibility:hidden` after the slide-out, so it leaves the tab order and stops casting a shadow on the page edge | `templates/staff_base.html`, `static/js/core.js`, `static/css/app.css` | `aria-hidden-focus` 59 pages → 0 |
| 2 | Top-bar search trigger: visible text is its accessible name (`aria-keyshortcuts="Control+K"`, `aria-haspopup="dialog"`, label moved to `title`). Avatar link: initials `aria-hidden`, sr-only "*Name*: my account and security" | `templates/staff_base.html` | `label-content-name-mismatch` 60 pages → 1 (calendar) |
| 3 | Light theme `--muted` #6b7484 → #636b7a and `--success` #15803d → #147a3a (AA on all light surfaces, and sepia badges) | `static/css/app.css` | `color-contrast` 86 pages → 1 (calendar custom greys) |
| 4 | Command palette: listbox labelled "Commands"; Alt+N hints computed from the live sidebar instead of a stale hard-coded list; "Go to" commands navigate by `href` | `static/js/core.js` | `aria-input-field-name` → 0; "Catalogue" now shows Alt+6, matching the key handler |
| 5 | Circulation receipt prints only the loaded patron's checkouts (and asks for a patron first) | `static/js/pages/staff-circulation.js` | privacy leak closed |
| 6 | Enter in the ISBN field (scanner) runs **Fetch metadata** instead of submitting the record form | `static/js/pages/staff-record-edit.js` | scripted check: metadata imported, no "Title is required" |
| 7 | Login: empty fields show the translated `login.missing` message (key existed, unused) instead of the raw Pydantic text and duplicate toast | `static/js/pages/login.js` | `shots/login-validation__*` |
| 8 | Login: demo-account shortcuts are rendered only when `environment != "production"`, and their credentials come from `shelfwise/seed.py` via the template instead of being hard-coded in the shipped `login.js` | `web.py`, `templates/login.html`, `static/js/pages/login.js` | `tests/test_ui_audit.py::test_demo_accounts_hidden_outside_development` |
| 9 | Report result table and admin audit log table: scroll regions are focusable (`tabindex=0`, `role=region`, label) | `static/js/pages/staff-reports.js`, `static/js/pages/staff-admin.js` | `scrollable-region-focusable` desktop → 0 |
| 10 | CI: the JS syntax check now covers `pages/<feature>/*.js` sub-folders (courses, serials, lib were skipped) and the non-blocking `ui-audit` job was added; `playwright` joined the `dev` extra | `.github/workflows/ci.yml`, `pyproject.toml` | — |

Tests: `tests/test_ui_audit.py` keeps the audit's page table in sync with `web.py` routes, renders the
report, asserts the staff-shell accessibility markup (drawer `inert`, no mismatched `aria-label`s) and
the production gating of demo logins.

---

## 9. Running the audit

```bash
pip install -e ".[dev]"                       # includes playwright
# Windows with Edge installed: nothing else to install (uses channel "msedge")
# elsewhere:  python -m playwright install --with-deps chromium

# start a server yourself …
SHELFWISE_DATABASE_URL=sqlite:///$PWD/audit.db SHELFWISE_ENVIRONMENT=development python -m shelfwise seed
SHELFWISE_DATABASE_URL=sqlite:///$PWD/audit.db SHELFWISE_ENVIRONMENT=development \
  python -m uvicorn shelfwise.app:app --host 127.0.0.31 --port 8781 &
python scripts/ui_audit.py --base-url http://127.0.0.31:8781

# … or let the script seed a throw-away DB and run the server
python scripts/ui_audit.py --serve

# focus on what you are redesigning
python scripts/ui_audit.py --pages circulation,holds --themes light,dark --viewports desktop,mobile --langs none
```

Output: `var/ui-audit/index.html` (thumbnail grid per page × theme × viewport with deduplicated issues
inline, rule summary, route coverage), `var/ui-audit/report.json` (everything, including the per-page
`inventory` of component variants and Web Vitals), `var/ui-audit/shots/*.jpg`.

Exit status is non-zero on serious/critical axe violations, console/page errors, 5xx responses or
harness errors (`--fail-on critical|serious|moderate|minor|none`, `--no-fail`). CI runs it as the
non-blocking `ui-audit` job and uploads the report as an artifact. When you add a page route,
`tests/test_ui_audit.py` fails until the page is added to `PAGES` in the script.
