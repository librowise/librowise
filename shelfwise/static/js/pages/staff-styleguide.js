// Living style guide (/staff/styleguide): renders every design-system component in its states, with a
// theme / direction / density preview switcher. Sample data is illustrative and never saved.
import { $, $$, cover, html, icon, modal, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { avatar } from "/static/js/ui/avatar.js";
import { combobox, highlight } from "/static/js/ui/combobox.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { dateRange, datePicker, wireDateRange } from "/static/js/ui/date-range.js";
import { confirmDestructive, confirmDialog } from "/static/js/ui/dialog.js";
import { emptyState, errorState, skeletonList } from "/static/js/ui/empty.js";
import { activeFilters, searchField, selectChip, wireFilterBar } from "/static/js/ui/filters.js";
import { enhanceForm, field, formSection, saveBar } from "/static/js/ui/form.js";
import { pageHeader } from "/static/js/ui/page-header.js";
import { sidePanel } from "/static/js/ui/panel.js";
import { progress, statTile } from "/static/js/ui/stat.js";
import { STATUS, statusPill } from "/static/js/ui/status.js";
import { segmented, tabs, wireSegmented, wireTabsPanel } from "/static/js/ui/tabs.js";

const slot = (id) => $(`[data-sg="${id}"]`);
const demo = (content, cls = "") => html`<div class="sg-demo ${cls}">${content}</div>`;
const code = (text) => html`<pre class="sg-code"><code>${text}</code></pre>`;
const SEMANTIC = ["bg", "surface", "surface-2", "surface-3", "border", "border-strong", "border-input", "text", "text-2", "muted",
  "primary", "primary-2", "primary-soft", "accent", "success", "success-soft", "warning", "warning-soft", "danger", "danger-soft",
  "info", "info-soft", "ai", "ai-soft", "focus"];
const RAMPS = ["indigo", "slate"];
const STEPS = { indigo: [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950], slate: [50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 950] };

function lum(rgb) {
  const [r, g, b] = rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const rgbOf = (css) => (css.match(/\d+(\.\d+)?/g) || [0, 0, 0]).slice(0, 3).map(Number);
function contrast(a, b) { const [x, y] = [lum(rgbOf(a)), lum(rgbOf(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
function resolved(token) {
  const probe = document.createElement("span");
  probe.style.color = `var(--${token})`;
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

const SAMPLE = [
  { id: 1, name: "Asha Rao", card: "2026000101", category: "Adult", loans: 3, balance: 0, status: "active" },
  { id: 2, name: "Rahul Verma", card: "2026000102", category: "Student", loans: 0, balance: 45, status: "owing" },
  { id: 3, name: "Fatima Khan", card: "2026000103", category: "Adult", loans: 7, balance: 0, status: "expiring" },
  { id: 4, name: "Arjun Mehta", card: "2026000104", category: "Child", loans: 1, balance: 0, status: "expired" },
  { id: 5, name: "Meera Iyer", card: "2026000105", category: "Staff", loans: 2, balance: 0, status: "staff" },
];

function previewControls() {
  const root = document.documentElement;
  $("#sg-preview-controls").innerHTML = html`
    ${segmented({ name: "theme", label: t("ui.appearance.theme"), value: root.dataset.theme || "system",
      options: [["system", t("ui.appearance.system")], ["light", t("ui.appearance.light")], ["dark", t("ui.appearance.dark")],
        ["sepia", t("ui.appearance.sepia")], ["contrast", t("ui.appearance.contrast")]] })}
    ${segmented({ name: "dir", label: t("ui.sg.direction"), value: root.dir || "ltr", options: [["ltr", "LTR"], ["rtl", "RTL"]] })}`;
  const [themeEl, dirEl] = $$("[data-segmented]", $("#sg-preview-controls"));
  wireSegmented(themeEl, (v) => { if (v === "system") delete root.dataset.theme; else root.dataset.theme = v; renderColour(); });
  wireSegmented(dirEl, (v) => { root.dir = v; });
}

function renderBrand() {
  slot("brand").innerHTML = html`
    ${demo(html`<span class="brand"><img class="brand-logo" src="/static/brand/librowise-mark.svg" alt="" width="32" height="32"><span class="wordmark">Libro<span>wise</span></span></span>
      <img src="/static/brand/librowise-mark.svg" alt="Librowise mark" width="72" height="72">
      <img src="/static/brand/librowise-seal.svg" alt="Librowise seal" width="72" height="72">
      <img src="/static/brand/librowise-icon-light.svg" alt="App icon (light)" width="72" height="72">
      <img src="/static/brand/librowise-icon-dark.svg" alt="App icon (dark)" width="72" height="72">
      <img src="/static/brand/librowise-maskable.svg" alt="Maskable PWA icon" width="72" height="72" style="border-radius:50%">
      <img src="/static/favicon.svg" alt="Favicon" width="32" height="32">`)}
    ${demo(html`<img class="sg-lockup light" src="/static/brand/librowise-logo-light.png" alt="Librowise logo for light backgrounds" width="300" height="75">
      <img class="sg-lockup dark" src="/static/brand/librowise-logo-dark.png" alt="Librowise logo for dark backgrounds" width="300" height="75">
      <span class="muted">${t("ui.brand.tagline")}</span>`)}
    <p class="small muted">${t("ui.sg.brand_note")}</p>`;
}

function renderColour() {
  const surface = resolved("surface");
  slot("colour").innerHTML = html`
    <div class="sg-swatches">${SEMANTIC.map((tok) => {
      const c = resolved(tok);
      const vsSurface = contrast(c, surface);
      return html`<div class="sg-swatch"><div class="chip-color" style="background:var(--${tok})"></div>
        <div class="meta"><strong>--${tok}</strong><code>${c}</code><span class="tiny muted">${vsSurface.toFixed(2)}:1 ${t("ui.sg.on_surface")}</span></div></div>`;
    })}</div>
    <h3 style="margin-top:1.25rem">${t("ui.sg.ramps")}</h3>
    ${RAMPS.map((r) => html`<div class="sg-ramp" aria-label="${r}" role="img">${STEPS[r].map((s) => html`<div style="background:var(--${r}-${s});color:${s >= 500 ? "#fff" : "#111"}">${s}</div>`)}</div><div class="small muted" style="margin:.25rem 0 .75rem">--${r}-*</div>`)}
    <h3>${t("ui.sg.chart_palette")}</h3>
    ${demo(html`${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => html`<span class="row tight"><span class="viz-key" style="--c:var(--viz-${n});width:1.25rem;height:1.25rem"></span><code class="small">--viz-${n}</code></span>`)}`)}
    <p class="small muted">${t("ui.sg.contrast_note")}</p>`;
}

function renderType() {
  slot("type").innerHTML = demo(html`<div class="stack tight" style="width:100%">
    ${[["--fs-3xl", "Display 36"], ["--fs-2xl", "Heading 1 · 28"], ["--fs-xl", "Heading 2 · 22"], ["--fs-lg", "Heading 3 · 18"], ["--fs-base", "Body · 15"], ["--fs-sm", "Small · 13"], ["--fs-xs", "Caption · 12"]]
      .map(([v, l]) => html`<div style="font-size:var(${v});font-weight:${v.includes("xl") || v.includes("3xl") ? 700 : 420}">${l} — Inter, the quick brown fox</div>`)}
    <div class="num" style="font-size:1.4rem">1,204,567.89 · 0123456789 <span class="small muted">${t("ui.sg.tabular")}</span></div>
    <div style="font-family:var(--font-serif);font-size:1.4rem">Gitanjali — Rabindranath Tagore <span class="small muted">(serif, OPAC titles)</span></div>
    <div lang="hi" style="font-family:var(--font-devanagari)">गीतांजलि — रवीन्द्रनाथ टैगोर</div>
    <div lang="ur" dir="rtl" style="font-family:var(--font-urdu)">گیتانجلی — رابندر ناتھ ٹیگور</div>
    <div class="mono">MARC 245 10 $a Gitanjali / $c Rabindranath Tagore.</div></div>`, "col");
}

function renderScales() {
  slot("scales").innerHTML = html`
    <h3>${t("ui.sg.spacing")}</h3>${demo(html`<div class="sg-scale">${[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => html`<div class="stack tight" style="align-items:center"><div class="bar" style="width:var(--space-${n});height:var(--space-${n})"></div><code class="tiny">${n}</code></div>`)}</div>`)}
    <h3>${t("ui.sg.radius_elevation")}</h3>${demo(html`${["xs", "sm", "md", "lg", "xl"].map((r, i) => html`<div class="card" style="width:6rem;height:4rem;border-radius:var(--radius-${r});box-shadow:var(--shadow-${["xs", "sm", "md", "lg", "xl"][i]});display:grid;place-items:center"><code class="tiny">${r}</code></div>`)}`)}
    <h3>${t("ui.sg.motion")}</h3>${code("--dur-1 90ms · --dur-2 160ms · --dur-3 240ms · --dur-4 360ms\n--ease (standard) · --ease-emphasized · --ease-exit — all collapse under prefers-reduced-motion")}`;
}

function renderButtons() {
  slot("buttons").innerHTML = html`
    ${demo(html`<button class="btn primary">${icon("plus")}Primary</button><button class="btn">Secondary</button><button class="btn ghost">Ghost</button>
      <button class="btn danger">${icon("trash")}Danger</button><button class="btn danger solid">Destructive</button><button class="btn ai">${icon("sparkle")}AI</button>
      <button class="btn" disabled>Disabled</button><button class="btn primary" aria-busy="true" disabled><span class="spinner" aria-hidden="true"></span>Saving…</button>`)}
    ${demo(html`<button class="btn sm">Small</button><button class="btn">Default</button><button class="btn lg">Large</button>
      <button class="btn icon-only" aria-label="Edit" data-tip="Edit (icon-only buttons need aria-label)">${icon("edit")}</button>
      <span class="btn-group"><button class="btn">Day</button><button class="btn">Week</button><button class="btn">Month</button></span>
      <button class="chip">Chip</button><button class="chip" aria-pressed="true">Pressed chip</button><kbd>Ctrl K</kbd>`)}
    ${code('html`<button class="btn primary">${icon("plus")}${t("…")}</button>`')}`;
}

function renderStatus() {
  slot("status").innerHTML = html`${Object.entries(STATUS).map(([kind, map]) => html`<div class="row tight" style="margin-bottom:.5rem">
    <code class="small" style="min-width:6.5rem">${kind}</code>${Object.keys(map).map((v) => statusPill(kind, v))}</div>`)}
    ${demo(html`<span class="badge">Neutral</span><span class="badge outline">Outline</span><span class="badge ai">${icon("sparkle")}AI</span>
      <div class="alert info grow">${icon("info")}<div>Info alert — supplementary context.</div></div>
      <div class="alert warn grow">${icon("alert")}<div>Warning alert — needs attention soon.</div></div>
      <div class="alert bad grow">${icon("alert")}<div>Error alert — something failed.</div></div>`, "col")}
    ${code('statusPill("item", "on_loan")   statusPill("hold", "ready")   statusPill("loan", "overdue")')}`;
}

function renderHeader() {
  slot("header").innerHTML = html`${demo(html`<div style="width:100%">${pageHeader({ title: "Patrons", count: 1204, eyebrow: "People", subtitle: "Search members, register new ones and manage accounts.", id: "sg-ph",
    actions: html`<button class="btn">${icon("download")}Export</button><button class="btn primary">${icon("user-plus")}Register patron</button>` })}</div>`, "bg")}
    ${code('pageHeader({ title, count, subtitle, actions: html`…` })   setCrumb(record.title)')}`;
}

function renderFilters() {
  slot("filters").innerHTML = html`${demo(html`<div class="filter-bar" style="width:100%;margin:0" id="sg-fb">
    <div class="saved-views"><span class="view-item"><button class="view-tab" aria-pressed="true">All</button></span><span class="view-item"><button class="view-tab" aria-pressed="false">Expiring soon</button></span>
      <span class="view-item"><button class="view-tab" aria-pressed="false">My view</button><button class="view-rm" aria-label="Delete view My view">${icon("x")}</button></span>
      <button class="view-tab">${icon("plus")}${t("ui.filters.save_view")}</button></div>
    <div class="filter-row">${searchField({ name: "sgq", label: "Search", value: "rao", shortcut: "" })}
      ${selectChip({ name: "sgs", label: "Status", value: "active", options: [["", "Any status"], ["active", "Active"]] })}
      ${selectChip({ name: "sgb", label: "Branch", value: "", options: [["", "All branches"], ["1", "Main"]] })}</div>
    <div id="sg-chips">${activeFilters([{ key: "sgq", label: "Search", value: "“rao”" }, { key: "sgs", label: "Status", value: "Active" }])}</div></div>`)}
    ${code("const state = urlState({ q: \"\", status: \"\", page: 1 });\nwireFilterBar(bar, (changes) => apply(changes), { keys: [\"q\", \"status\"] });")}`;
  wireFilterBar($("#sg-fb"), (c) => toast(`Filter change: ${JSON.stringify(c)}`), { keys: ["sgq", "sgs", "sgb"] });
}

function renderTable() {
  slot("table").innerHTML = html`<div class="row tight" style="margin-bottom:.5rem">
      <button class="btn sm" data-sg-state="rows">Rows</button><button class="btn sm" data-sg-state="loading">Loading</button>
      <button class="btn sm" data-sg-state="empty">Empty</button><button class="btn sm" data-sg-state="error">Error</button></div>
    <div id="sg-dt"></div>${code("dataTable(el, { id, columns, selectable, bulkActions, onSort, onPage, empty, exportName })")}`;
  const table = dataTable($("#sg-dt"), {
    id: "styleguide", caption: "Sample patrons", selectable: true, rowLabel: (r) => r.name, exportName: "sample",
    sort: { key: "name", dir: "asc" }, onSort: () => {}, onPage: () => {},
    columns: [
      { key: "name", label: "Name", sortable: true, primary: true, render: (r) => html`<div class="dt-person">${avatar(r.name)}<div class="dt-cell-stack"><a href="#sg-dt">${r.name}</a><span class="sub">${r.card}</span></div></div>`, csv: (r) => r.name },
      { key: "category", label: "Category" },
      { key: "loans", label: "Loans", align: "num" },
      { key: "balance", label: "Balance", align: "num", render: (r) => `₹${r.balance}` },
      { key: "status", label: "Status", render: (r) => statusPill("patron", r.status) },
      { key: "card", label: "Card", hidden: true },
    ],
    bulkActions: [{ id: "renew", label: "Renew membership", icon: "refresh", run: (rows) => toast(`Would renew ${rows.length}`, "success", { action: { label: t("ui.undo"), run: () => toast("Undone") } }) }],
    empty: { art: "people", title: "No patrons match", body: "Try fewer filters.", actions: html`<button class="btn">Clear filters</button>` },
  });
  table.setRows(SAMPLE, { total: 1204, page: 1, perPage: 25 });
  slot("table").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sg-state]");
    if (!b) return;
    const s = b.dataset.sgState;
    if (s === "rows") table.setRows(SAMPLE, { total: 1204, page: 1, perPage: 25 });
    if (s === "loading") table.setLoading();
    if (s === "empty") table.setRows([], { total: 0 });
    if (s === "error") table.setError(new Error("The server did not respond (503)."), () => table.setRows(SAMPLE, { total: 1204 }));
  });
}

function renderForms() {
  slot("forms").innerHTML = html`<form id="sg-form" class="card pad">
    ${formSection({ title: "Contact", description: "How the library reaches this patron.", body: html`<div class="form-grid">
      ${field({ name: "first_name", label: "First name", required: true, value: "Asha" })}
      ${field({ name: "email", label: "Email", type: "email", help: "Used for due-date reminders.", value: "asha@" })}
      ${field({ name: "phone", label: "Phone", type: "tel", optional: true })}
      ${field({ name: "category", label: "Category", as: "select", options: [["1", "Adult"], ["2", "Student"]] })}
      ${field({ name: "notes", label: "Staff notes", as: "textarea", span: 2, help: "Shown at the circulation desk." })}
      ${field({ name: "sms", label: "Send SMS reminders", type: "checkbox", value: true })}</div>` })}
    ${saveBar({ submit: "Save patron" })}</form>
    ${code("enhanceForm(form, { onSubmit: (data) => api(...), validate: { email: (v) => v.includes(\"@\") || \"Enter an email\" } })")}`;
  const form = $("#sg-form");
  enhanceForm(form, { guard: false, onSubmit: async () => { await new Promise((r) => setTimeout(r, 600)); toast("Saved (demo)", "success"); },
    validate: { email: (v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || t("ui.form.email") } }).check();
}

function renderTabs() {
  slot("tabs").innerHTML = html`<div id="sg-tabsdemo">${tabs({ id: "sgt", label: "Example tabs", selected: "orders",
    items: [{ id: "orders", label: "Orders", count: 12 }, { id: "budgets", label: "Budgets" }, { id: "vendors", label: "Vendors", count: 4 }] })}</div>
    ${demo(segmented({ name: "sgseg", label: "Period", value: "week", options: [["day", "Day"], ["week", "Week"], ["month", "Month"]] }))}
    ${code("tabs({ id, label, items, selected })  wireTabsPanel(el, (id, panel) => …, { hash: true })\nsegmented({ name, label, value, options })  wireSegmented(el, (v) => …)")}`;
  wireTabsPanel($("#sg-tabsdemo"), (id, panel) => { panel.innerHTML = html`<p class="muted" style="padding:.5rem 0">Panel: <strong>${id}</strong> (← / → to switch tabs)</p>`; });
  wireSegmented(slot("tabs"), () => {});
}

function renderCombobox() {
  slot("combobox").innerHTML = html`${demo(html`<div class="field" style="width:min(100%,24rem)"><label for="sg-combo">Patron</label><input id="sg-combo" placeholder="Type “a”…"></div>`)}
    ${code("combobox(input, { source: async (q) => results, render, value, onSelect })")}`;
  combobox($("#sg-combo"), {
    source: async (q) => SAMPLE.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())),
    render: (p, q) => html`<span class="grow">${highlight(p.name, q)} <span class="sub">${p.card}</span></span>`,
    value: (p) => p.name, onSelect: (p) => toast(`Selected ${p.name}`),
  });
}

function renderDates() {
  slot("dates").innerHTML = html`${demo(html`${dateRange({ name: "sgr", label: "Period", start: "2026-09-01", end: "2026-09-30", presets: ["today", "7d", "30d", "month", "year"] })}
    ${datePicker({ name: "sgd", label: "Due date", value: "2026-10-21", help: "Library closed days are skipped automatically." })}`, "col")}
    ${code("dateRange({ name, label, start, end, presets })  wireDateRange(el, ({ start, end }) => …, { maxDays: 366 })")}`;
  wireDateRange(slot("dates"), ({ start, end }) => toast(`${start} → ${end}`), { maxDays: 366 });
}

function renderStats() {
  slot("stats").innerHTML = html`<div class="grid kpi-grid">
      ${statTile({ label: "On loan", value: 1204, icon: "repeat", delta: 38, deltaLabel: "vs last week" })}
      ${statTile({ label: "Overdue", value: 37, icon: "clock", delta: 5, goodWhen: "down", tone: "danger", deltaLabel: "vs last week" })}
      ${statTile({ label: "Holds ready", value: 12, icon: "bookmark", href: "#sg-stats" })}
      ${statTile({ label: "New patrons", value: 64, icon: "user-plus", delta: 0, deltaLabel: "vs last month" })}</div>
    ${demo(html`<div class="stack" style="width:100%">${progress({ value: 72, label: "Budget committed" })}${progress({ value: 93, label: "Shelf full", tone: "danger" })}
      ${progress({ indeterminate: true, label: "Importing records" })}</div>`)}`;
}

function renderEmpty() {
  slot("empty").innerHTML = html`<div class="grid cols-3">
    ${["search", "books", "people", "inbox", "done", "filter"].map((a) => html`<div class="card">${emptyState({ art: a, compact: true, title: a, body: "Short, helpful explanation." })}</div>`)}
    <div class="card">${errorState(new Error("Request failed (500)"))}</div>
    <div class="card">${skeletonList(2)}</div></div>`;
}

function renderFeedback() {
  slot("feedback").innerHTML = html`${demo(html`<button class="btn" data-toast="info">Info toast</button><button class="btn" data-toast="success">Success + Undo</button>
    <button class="btn" data-toast="warn">Warning</button><button class="btn" data-toast="error">Error</button>
    <span class="row tight"><span class="spinner" aria-hidden="true"></span>Spinner</span>
    <button class="btn ghost" data-tip="Tooltips appear on hover and keyboard focus; Esc dismisses.">${icon("help")}Hover or focus me</button>`)}
    ${code('toast(msg, "success", { action: { label: t("ui.undo"), run: undo } })')}`;
  slot("feedback").addEventListener("click", (e) => {
    const b = e.target.closest("[data-toast]");
    if (!b) return;
    const k = b.dataset.toast;
    if (k === "success") toast("3 memberships renewed", "success", { action: { label: t("ui.undo"), run: () => toast("Renewal undone") } });
    else toast({ info: "Saved as draft", warn: "Two items are still in transit", error: "Could not reach the server" }[k], k);
  });
}

function renderOverlays() {
  slot("overlays").innerHTML = html`${demo(html`${["sm", "md", "lg", "xl"].map((s) => html`<button class="btn" data-dlg="${s}">Dialog ${s}</button>`)}
    <button class="btn danger" data-confirm>Confirm</button><button class="btn danger" data-destructive>Type to confirm</button>
    <button class="btn primary" data-panel>Side panel</button>`)}
    ${code("const fd = await modal({ title, body, submit, size })  ·  sidePanel({ title, body, footer })")}`;
  slot("overlays").addEventListener("click", async (e) => {
    const d = e.target.closest("[data-dlg]");
    if (d) {
      const fd = await modal({ title: `Dialog (${d.dataset.dlg})`, size: d.dataset.dlg, submit: "Save",
        body: html`<div class="stack">${field({ name: "title", label: "Title", required: true })}<p class="small muted">Enter submits · Esc cancels · focus is trapped and restored.</p></div>` });
      if (fd) toast(`Submitted: ${fd.get("title")}`, "success");
    }
    if (e.target.closest("[data-confirm]") && await confirmDialog("Withdraw 3 items?", "They will no longer be lendable.", "Withdraw")) toast("Confirmed", "success");
    if (e.target.closest("[data-destructive]") && await confirmDestructive({ title: "Delete 120 records?", text: "This cannot be undone.", word: "DELETE" })) toast("Confirmed", "success");
    if (e.target.closest("[data-panel]")) {
      sidePanel({ title: "Asha Rao", subtitle: "Card 2026000101 · Adult · Main library",
        body: html`<div class="stack"><div class="row">${avatar("Asha Rao", { size: "md" })}<div>${statusPill("patron", "active")}</div></div>
          <dl class="dl"><dt>Loans</dt><dd>3</dd><dt>Holds</dt><dd>1 ready</dd><dt>Balance</dt><dd>₹0</dd></dl></div>`,
        footer: html`<a class="btn primary" href="#sg-overlays">Open patron</a>` });
    }
  });
}

function renderPeople() {
  slot("people").innerHTML = demo(html`${["xs", "sm", "md", "", "lg"].map((s) => avatar("Asha Rao", { size: s }))}
    ${["Rahul Verma", "Fatima Khan", "Arjun Mehta", "Meera Iyer", "Li Wei", "Ana Souza"].map((n) => avatar(n, { size: "md" }))}`);
}

function renderCovers() {
  const books = [{ id: 0, title: "Gitanjali", authors: ["Tagore, Rabindranath"] }, { id: 0, title: "The Guide", authors: ["Narayan, R. K."] },
    { id: 0, title: "Train to Pakistan", authors: ["Singh, Khushwant"] }];
  slot("covers").innerHTML = html`${demo(html`${books.map((b) => html`<div style="width:110px">${cover(b)}</div>`)}`)}
    <p class="small muted">${t("ui.sg.covers_note")}</p>${code("cover(biblio, \"sm\" | \"\" | \"lg\")   →   /covers/{id}.jpg (uploaded → Open Library → generated)")}`;
}

export default async function init() {
  previewControls();
  for (const fn of [renderBrand, renderColour, renderType, renderScales, renderButtons, renderStatus, renderHeader, renderFilters, renderTable,
    renderForms, renderTabs, renderCombobox, renderDates, renderStats, renderEmpty, renderFeedback, renderOverlays, renderPeople, renderCovers]) {
    try { fn(); } catch (e) { console.error(e); }
  }
}
