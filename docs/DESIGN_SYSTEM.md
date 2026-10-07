# Librowise design system

> Product brand: **Librowise — the modern library system.** (The Python package, CLI, `SHELFWISE_*`
> environment variables, cookies and storage keys keep their `shelfwise` names until the planned code rename.)

This document is the contract for every screen in Librowise. It covers the principles, the tokens, every
component (with usage, do/don't and accessibility notes), the page templates and a checklist for migrating
an existing page. The living reference is **`/staff/styleguide`** — every component in every state, with a
theme and LTR/RTL switcher. When the two disagree, fix whichever is wrong.

**Files**

| Layer | File | Owns |
|---|---|---|
| Tokens | `shelfwise/static/css/tokens.css` | Fonts, colour ramps, semantic colours per theme, type/space/radius/elevation/motion/z scales |
| Base | `shelfwise/static/css/app.css` | Element defaults, buttons, inputs, cards, badges, tables, dialogs, toasts + legacy feature sections |
| Components | `shelfwise/static/css/ui.css` | Staff shell, page header, filter bar, data table, forms, side panel, tabs, combobox, pills, notification centre, OPAC search, style guide |
| Behaviour | `shelfwise/static/js/ui/*.js` (barrel: `ui/index.js`) | One small ES module per component |
| Core | `shelfwise/static/js/core.js` | `api`, `html```, `raw`, `esc`, `modal`, `confirmDialog`, `toast`, `withBusy`, `cover`, `badge`, `icon`, formatting |
| Shell | `shelfwise/templates/staff_base.html`, `shelfwise/web.py` (`HUBS`) | Sidebar, top bar, breadcrumbs, hub tabs |
| Icons | `shelfwise/templates/_icons.html` | SVG sprite: `icon("name")` → `<use href="#i-name">` |

Load order is fixed in `base.html`: `tokens.css` → `app.css` → `ui.css`.

---

## 1. Principles

1. **Calm density.** Librarians work long shifts on dense data. Default to comfortable spacing, offer
   compact density, never decorate data. One primary action per view.
2. **Find, then act.** Every list has search, filters that live in the URL, and bulk actions. Every record
   is one keystroke away (Ctrl K / `/`).
3. **Keyboard first, pointer friendly, touch ready.** Everything works with the keyboard and shows a focus
   ring; targets are ≥ 32 px (≥ 44 px on the kiosk); every page works at 360 px wide.
4. **Accessible by construction.** WCAG 2.2 AA colour contrast is *tested*, not hoped for. Status is never
   colour alone. Live regions announce async results. Logical CSS properties make RTL free.
5. **Fast and honest.** Skeletons instead of spinners for content; optimistic UI only with Undo; errors say
   what happened and offer a retry.
6. **One way to do a thing.** Use the component; if it doesn't fit, extend the component (and the style
   guide) rather than writing page-local CSS.

## 2. Brand

* **Mark (“2B”)** — an open indigo book with a violet ribbon down the gutter carrying a white AI spark.
  Use it wherever the product is identified: staff sidebar and top bar, OPAC header, favicon, style guide.
  Render it as an image (`<img class="brand-logo" src="/static/brand/librowise-mark.svg" alt="">`) — its
  gradients have `lw-` prefixed ids, so it can also be inlined safely.
* **Seal (“2F”)** — the same book, ribbon and spark inside a dark-indigo circle
  (`static/brand/librowise-seal.svg`): sign-in page hero (`.brand-seal`), kiosk header, avatar/profile spots,
  about pages and certificates.
* **App icons** — `librowise-icon-light.svg` (also `static/icons/icon.svg`), `librowise-icon-dark.svg`,
  `librowise-maskable.svg` (also `static/icons/maskable.svg`, glyph inside the 80 % safe zone); favicon =
  the mark. Raster lockups (1200×300): `librowise-logo-light.png` / `-dark.png`; also
  `librowise-avatar-512.png` and `librowise-social-1280x640.png` (copies in `docs/brand/`).
* **Wordmark** — “Libro” in ink (`--wordmark-ink`: #1e1b4b light, #f8fafc dark) + “wise” in indigo
  (`--wordmark-accent`: #6366f1 light, #a5b4fc dark), Inter 760, letter-spacing −0.035 em. Markup:
  `<span class="wordmark">Libro<span>wise</span></span>`; in templates use `{{ product_name }}` for text.
  (Logotypes are exempt from WCAG text contrast; everything else is not.)
* **Palette** — indigo #6366f1 / #4338ca / #312e81 / #1e1b4b, light #818cf8 / #c7d2fe / #e0e7ff / #eef2ff,
  violet accent #a78bfa → #7c3aed (ribbon, AI). Light theme `--primary` = indigo-700 #4338ca (7.9:1 on
  white); dark theme `--primary` = indigo-300 #a5b4fc; AI = violet. Sepia and high contrast keep their own
  primaries (warm brown, yellow) — the brand assets stay indigo in every theme.
* **Tagline** — “The modern library system” (`ui.brand.tagline`).
* The OPAC shows the *library's* own name (`library_name` setting) next to the mark; the product brand
  appears in the staff sidebar, footers (“Powered by Librowise”) and as the manifest fallback name.

## 3. Tokens

Never hard-code colours in components; use semantic tokens. Primitive ramps (`--indigo-700`, `--slate-200`, …)
exist for the style guide and rare fixed-colour needs (e.g. the AI button gradient).

### Colour (semantic)

| Token | Use |
|---|---|
| `--bg` | Page background |
| `--surface`, `--surface-2`, `--surface-3`, `--surface-raised` | Cards; table headers / hovers; chips / skeletons; dialogs & popovers |
| `--border`, `--border-strong` | Dividers; card and button outlines |
| `--border-input` | Form-control boundaries (≥ 3:1, WCAG 1.4.11) |
| `--text`, `--text-2`, `--muted` | Primary, secondary and tertiary text (all ≥ 4.5:1 on every surface) |
| `--primary`, `--primary-2`, `--primary-soft`, `--primary-text` | Links/actions, hover, selected backgrounds, text on primary |
| `--success / --warning / --danger / --info / --ai` (+ `-soft`) | Status text/icons and their tinted backgrounds |
| `--accent` (+ `-soft`) | Announcements, highlights |
| `--focus` | Focus rings |
| `--surface-inverse`, `--text-inverse` | Tooltips and toasts |
| `--viz-1…8`, `--viz-seq`, `--viz-grid`, `--viz-axis` | Charts (`charts.js`); charts always offer a data table and labels |

Themes: **light** (default), **dark** (also via `prefers-color-scheme`), **sepia**, **high contrast**. A
theme only re-maps semantic tokens. The dark block exists twice in `tokens.css` (explicit + media query);
the contrast test fails if they drift.

**Contrast is enforced:** `python scripts/check_contrast.py -v` prints every pair; `test_token_contrast_meets_wcag_aa_in_every_theme`
(`tests/test_design_system.py`) fails the build below 4.5:1 for text and 3:1 for UI boundaries/focus.
When you add a new text/background combination, add it to `PAIRS` in the script.

### Type

Inter (variable, self-hosted, OFL — `static/fonts/inter/LICENSE.txt`), `font-display: swap`, preloaded.
Fallbacks: system UI, then Nirmala UI/Noto for Devanagari; Urdu uses `--font-urdu` (Nastaliq stack) with a
taller line height. Serif (`--font-serif`) only for OPAC titles and citations; `--mono` for barcodes, call
numbers, MARC.

Scale: `--fs-xs .75` · `--fs-sm .8125` · `--fs-md .9375` · `--fs-base 1` · `--fs-lg 1.125` · `--fs-xl 1.375` ·
`--fs-2xl 1.75` · `--fs-3xl 2.25` rem (1 rem = 15 px × user text-size preference). Weights 420/520/620/720.
**Numbers in data use tabular figures** — tables do this automatically; elsewhere add `.num`.

### Space, radius, elevation, motion, layers

* Space (4 px grid): `--space-1 … --space-16` (.25 rem … 4 rem). Layout gaps use `--gap`/`--pad` (density-aware).
* Radius: `--radius-xs 4` · `-sm 6` · `-md 10` (`--radius`) · `-lg 14` · `-xl 20` · `-full`.
* Elevation: `--shadow-xs/sm/md/lg/xl` (dark and contrast themes re-map them).
* Motion: `--dur-1 90ms` (hover) · `--dur-2 160ms` (state) · `--dur-3 240ms` (enter) · `--dur-4 360ms`;
  easing `--ease`, `--ease-emphasized`, `--ease-exit`. `prefers-reduced-motion` collapses all of it.
* Layers: `--z-sticky 20` · `--z-dropdown 40` · `--z-sidebar 50` · `--z-drawer 60` · `--z-toast 1000` · `--z-tooltip 1100`.
  Dialogs use the browser top layer (`<dialog>.showModal()`).

## 4. Information architecture (staff)

The sidebar shows **hubs**; a hub's pages appear as a tab bar under the breadcrumbs. Registry:
`web.HUBS` (+ `NAV_PERMISSIONS`, `TAB_LABELS`, `PAGE_TABS`). Hubs and tabs are filtered by permission; a hub
links to its first visible tab. Alt+1…9 jumps to hubs (hold Alt to see the hints); `[` collapses the sidebar.

| Hub (Alt) | Tabs → URL |
|---|---|
| Home (1) | Today → `/staff` (admins also see System health) |
| Circulation (2) | Desk `/staff/circulation` · Holds `/staff/holds` · Calendar `/staff/calendar` · Kiosks `/staff/kiosks` |
| Catalogue (3) | Records `/staff/catalog` (+ record, edit, MARC editor) · Authorities · Copy cataloguing · Labels & cards (+ print) · Batch & inventory |
| Acquisitions (4) | Orders & budgets `/staff/acquisitions` · Serials `/staff/serials` |
| Patrons (5) | Patrons `/staff/patrons` (+ patron) · Requests `/staff/requests` · Notices `/staff/notices` |
| Course reserves (6) | `/staff/courses` |
| Insights (7) | Reports · Analytics · AI insights |
| Administration (8) | Settings `/staff/admin` · Roles & permissions · System · Interoperability |

Not in the sidebar: `/staff/security` (user menu → “My account & security”), `/staff/styleguide` (user menu).
**Adding a page:** append to `STAFF_NAV` (routing), give it a permission in `NAV_PERMISSIONS`, add its key
to one hub's `tabs`; detail pages go in `PAGE_TABS`. Unclaimed pages fall into a “More” hub so nothing is
ever unreachable; `tests/test_design_system.py` keeps the registry honest (≤ 9 hubs, every page claimed once).

## 5. Components

All snippets build markup with `html```, which escapes every interpolation. Use `raw()` only for trusted,
already-escaped HTML (e.g. our own translations containing `<kbd>`).

### Staff shell (`staff_base.html`, `ui/shell.js`)
Sidebar (full ↔ rail, remembered in `localStorage["sw-sidebar"]` and applied before paint by
`theme-boot.js`), off-canvas below 960 px with a scrim; top bar with global search, Copilot, notification
bell, language, appearance and the user menu; breadcrumbs + hub tabs. Detail pages override
`{% block crumbs_extra %}` (see `staff/record.html`); `setCrumb(text)` updates the last crumb from JS
(the default element has `id="crumb"`).

### Page header (`ui/page-header.js`, `.page-header`)
```js
pageHeader({ title: t("ui.patrons.title"), count: total, subtitle: t("…"),
  actions: html`<button class="btn primary">${icon("user-plus")}${t("ui.patrons.register")}</button>` })
```
Do: one primary action, secondary actions as default buttons. Don't: put filters in the header.
List pages may server-render the header (faster first paint) — see `staff/patrons.html`.

### Buttons (`.btn`)
Variants `primary`, default, `ghost`, `danger`, `danger solid` (destructive confirm), `ai`; sizes `sm`, `lg`,
`icon-only` (must have `aria-label`), groups `.btn-group`. `withBusy(btn, fn)` adds a spinner and disables.
Don't use two primaries side by side; don't use colour alone to distinguish actions.

### Status pills (`ui/status.js`)
```js
statusPill("item", "on_loan")      statusPill("hold", "ready")      statusPill("job", "dead", "Gave up")
```
One mapping (`STATUS`) for items, holds, loans, orders, suggestions, notices, jobs, patrons, serial issues
and registrations → tones success/warning/danger/info/neutral/ai. Each pill has a dot *and* text. Legacy
`badge(status)` uses the same tone classes.

### Filter bar & saved views (`ui/filters.js`)
```js
const state = urlState({ q: "", status: "", sort: "name", page: 1, per_page: 25 });
row.innerHTML = html`${searchField({ name: "q", label, value })}${selectChip({ name: "status", label, value, options })}`;
chips.innerHTML = activeFilters([{ key: "status", label: "Status", value: "Active" }]);
wireFilterBar(bar, (changes) => apply(changes), { keys: FILTERS });
savedViews(el, { id: "patrons", keys: FILTERS, presets, current: () => state.get(), onSelect });
```
Filters live in the query string (`history.replaceState`), so views are linkable. Search is debounced
(300 ms), Enter applies immediately, Esc clears. Presets cover the common questions (“Expired”, “Owes
money”); users can save their own (per browser).

### Data table (`ui/data-table.js`)
```js
const table = dataTable(el, {
  id: "patrons", caption: t("ui.patrons.title"), selectable: true, rowHref: (r) => `/staff/patrons/${r.id}`,
  columns: [{ key: "name", label, sortable: true, primary: true, render: (r) => html`…`, csv: (r) => r.full_name },
            { key: "email", label, hidden: true }, { key: "loans", label, align: "num" }],
  sort: { key: "name", dir: "asc" }, onSort, onPage, perPageOptions: [25, 50, 100],
  bulkActions: [{ id: "renew", label, icon: "refresh", run: async (rows, { clear, button }) => … }],
  empty: { art: "people", title, body, actions }, exportName: "patrons", exportAll: async () => allRows,
});
table.setLoading(); table.setRows(rows, { total, page, perPage }); table.setError(err, retry);
```
Features: sortable headers (`aria-sort`), column chooser and density (remembered per table), sticky header,
selection with Shift-range and a bulk-action bar, pagination, CSV export (formula-injection safe; selected
rows or `exportAll`), skeleton/empty/error states, keyboard rows (↑/↓ or J/K, Home/End, Enter opens,
Space/X selects), and a card layout when the table itself is < 640 px wide (container query — mark the
main column `primary`, a thumbnail `media`, unimportant ones `cardHidden`). Server-side sort/paging: the
page owns fetching; the table only emits events.

### Forms (`ui/form.js`)
```js
form.innerHTML = html`${formSection({ title, description, body: html`<div class="form-grid">
  ${field({ name: "email", label, type: "email", help, required: true })}
  ${field({ name: "notes", label, as: "textarea", span: 2, optional: true })}</div>` })}${saveBar()}`;
const f = enhanceForm(form, { onSubmit: (data) => api(…), validate: { email: (v) => ok || t("…") } });
```
Labels are always visible; help and error text are linked with `aria-describedby`; errors appear on blur
and update live once a field is touched; on submit the first invalid field is focused and the count is
announced. 422 responses with `errors: [{field, message}]` map back to fields. The sticky save bar shows
“Unsaved changes”, and leaving the page asks first. Don't disable the submit button to signal invalidity.

### Dialogs (`modal`, `confirmDialog` in core; `confirmDestructive` in `ui/dialog.js`)
```js
const fd = await modal({ title, body: html`…`, submit: t("common.save"), size: "sm" | "md" | "lg" | "xl" });
if (await confirmDialog(title, text, t("ui.cover.remove"))) …
await confirmDestructive({ title, text, word: "DELETE" })   // type-to-confirm for irreversible bulk actions
```
Enter in any single-line field runs the primary action (body buttons never submit), Esc/✕/Cancel resolve
`null`, focus is trapped and returned to the opener, invalid fields block submission; bottom sheet on
phones. Use a dialog for short, blocking tasks; use a side panel for reading/editing details in context.

### Side panel (`ui/panel.js`)
`sidePanel({ title, subtitle, body, footer, wide })` → `{ setBody, setTitle, close, closed }`. Modal
`<dialog>` sliding from the inline end (correct in RTL), backdrop click and Esc close it.

### Tabs & segmented control (`ui/tabs.js`)
In-page tabs: `tabs({ id, label, items, selected })` + `wireTabsPanel(root, onSelect, { hash: true })` — the
WAI-ARIA tabs pattern with arrow keys (RTL-aware). Page-to-page navigation uses the shell's hub tabs, not
these. Segmented control (`role="radiogroup"`) for 2–5 mutually exclusive view options (list/grid, period).

### Combobox (`ui/combobox.js`)
`combobox(input, { source: async (q, signal) => rows, render, value, onSelect, minChars })` — ARIA 1.2
combobox, debounced, aborts stale requests, announces result counts. The OPAC search box keeps its
specialised `suggest.js`.

### Dates (`ui/date-range.js`)
`datePicker({ name, label, value, min, max })` and `dateRange({ name, label, start, end, presets })` +
`wireDateRange(el, onChange, { maxDays })`: native date inputs (localised, mobile pickers, accessible) with
presets (today, 7/30/90 days, this/last month, this year) and validation (end ≥ start, max span).

### Stat tiles & progress (`ui/stat.js`)
`statTile({ label, value, icon, delta, goodWhen: "up" | "down", deltaLabel, tone, href })` — trend arrows are
coloured by *good/bad*, not by direction, and carry screen-reader text. Use `charts.js kpiTile()` when you
need a sparkline. `progress({ value, max, label, tone, indeterminate })` renders `role="progressbar"`.

### Empty, error, loading (`ui/empty.js`)
`emptyState({ art, title, body, actions })` with inline SVG illustrations (`search`, `books`, `people`,
`inbox`, `done`, `error`, `filter`) drawn from tokens; `errorState(err, { retry })` pairs with a
`[data-retry]` handler; `skeletonRows(rows, cols)` and `skeletonList(n)`. An empty state always says why
and what to do next.

### Toasts (`toast` in core)
`toast(msg, "success" | "info" | "warn" | "error", { action: { label: t("ui.undo"), run }, duration })`. Errors
are `role="alert"`, others `status`; the timer pauses on hover/focus; actions keep the toast up for 8 s.
Prefer Undo over “Are you sure?” for reversible actions.

### Avatars, tooltips, popovers
`avatar(name, { size: "xs"|"sm"|"md"|""|"lg", src })` — deterministic hue, white initials ≥ 4.5:1.
`data-tip="…"` on any focusable element shows a tooltip on hover/focus (Esc dismisses). Tooltips describe;
icon-only buttons still need `aria-label`. `popover(trigger, panel, { menu: true })` gives menus ↑/↓/Home/End,
typeahead, Esc and outside-click closing.

### Notification centre (`ui/notifications.js`, `GET /api/v1/ui/notifications`)
Aggregates dashboard alerts, holds on the shelf, failed notices, pending registrations and suggestions,
and (admins) failed jobs — filtered by permission. Read state is per user in localStorage; item ids change
when content changes. Add a source by appending to `api/ui.py` with a stable id, `kind`, `tone`, `icon`,
`href` and `params`, plus `ui.notif.kind.<kind>` strings.

### Book covers (`cover()` in core, `ui/cover-upload.js`, `/covers/{id}.jpg`)
`cover(b, "sm" | "" | "lg")` paints the generated gradient cover and layers the real image on top when the
cover service has one (uploaded → cached Open Library by ISBN → 404). Staff upload/replace/remove covers on
the record page (`mountCoverEditor`).

### Command palette / global search (`ui/palette.js`)
Ctrl K or the top-bar search. Scopes: All · Records · Patrons · Items (exact barcode) · Commands; prefixes
`>` `@` `#`; Tab cycles scopes. Navigation commands come from the (permission-filtered) sidebar.

## 6. Page templates

**List page** — reference: `templates/staff/patrons.html` + `static/js/pages/staff-patrons.js`
(also `staff-catalog.js`). Page header (title + live count, one primary action) → saved views → filter
row (search + select chips) → active-filter chips → data table. All state in the URL; page owns fetching.

**Detail page** — reference: `staff/record.html`. Breadcrumb via `crumbs_extra` + `#crumb`; header with
cover/avatar, title, key status pills and actions (primary last); two-column body (`.grid.split`): main
content cards left, facts (`.dl`) and secondary cards right; collapses to one column < 1000 px.

**Form page** — `form-section`s (title + description left, `.form-grid` right) and a `saveBar()`;
`enhanceForm()` for validation and the unsaved-changes guard. Use dialogs only for ≤ 6 fields.

**Dashboard** — reference: `staff/dashboard.html`. Quick actions row → KPI grid (`.kpi-grid`) → two-column
`.dash-grid` of cards (work queues first, trends second). Role-aware sections are template-guarded with
`can(user, "permission")`.

**OPAC results** — reference: `opac/search.html` + `opac-search.js`: search box → facet rail
(collapsible) + results (list/grid) with chips, did-you-mean and pagination.

## 7. Migrating a page — checklist

1. **Template**: extend `staff_base.html`; drop any hand-made breadcrumb (`crumbs_extra` for detail pages);
   server-render the `.page-header` with translated strings (`{{ t('…') }}`).
2. **Registry**: confirm the page is in a hub (`web.HUBS`) with the right permission; detail pages in `PAGE_TABS`.
3. **Imports**: `import { … } from "/static/js/ui/index.js"` (or the specific modules).
4. **Lists** → `dataTable` + `urlState` + `wireFilterBar` (+ `savedViews` if there are common questions);
   no `<table>` built by hand, no `?page=` reloads.
5. **Statuses** → `statusPill(kind, value)`; add new statuses to `STATUS` (never ad-hoc colours).
6. **Forms** → `field`/`formSection`/`saveBar` + `enhanceForm`; dialogs via `modal({ size })`.
7. **States** → `setLoading()` / skeletons, `emptyState` with a next step, `errorState` with retry.
8. **Feedback** → `toast` (with Undo for reversible bulk actions); destructive bulk actions use `confirmDestructive`.
9. **Copy** → every string through `t()`; add keys to `en.json`, `hi.json`, `ur.json` (tests enforce completeness).
10. **CSS** → none page-local if a component exists; otherwise add a component class to `ui.css` using
    tokens and logical properties, and add it to the style guide.
11. **Verify**: light/dark/sepia/high contrast, `?lang=ur` (RTL), 360 px wide (no horizontal scroll),
    keyboard only (Tab, Enter, Esc, arrows), screen-reader names for icon buttons; run `python -m pytest`,
    `python -m ruff check .`, `python scripts/check_contrast.py` and the JS syntax check.

## 8. Accessibility notes

* Focus: `:focus-visible` 3 px `--focus` ring (≥ 3:1 everywhere). Never remove outlines without a replacement.
* Landmarks: skip link → `<main id="main">`; sidebar `<nav>`, breadcrumbs `<nav aria-label>`, hub tabs `<nav>`.
* Live regions: tables, palette, combobox, forms and notifications announce changes politely; errors use `role="alert"`.
* Motion: everything respects `prefers-reduced-motion`.
* RTL: use `inset-inline-*`, `margin-inline-*`, `padding-inline-*`, `text-align: start/end`; flip directional
  icons with `[dir="rtl"] … { transform: scaleX(-1) }`. Codes, barcodes and MARC stay LTR (`.mono`).
* Print: shell chrome, toolbars and bulk bars are hidden in print.
