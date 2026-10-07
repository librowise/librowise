// Shared building blocks for the Insights hub (Reports · Analytics · AI insights): one filter toolbar,
// KPI tiles, chart cards and drill-down links, so the three pages read as a single analytics product.
// Markup for the toolbar, KPI skeletons and card headers is server-rendered (templates/staff/_insights_ui.html)
// so nothing shifts when data arrives; this module wires it up. Styles: /static/css/pages/admin-insights.css.
//
//   const tb = createToolbar({ granularity: true, compare: true, onChange: (state) => reload() });
//   tb.state → { range, start, end, branch, g, compare }   tb.apiParams() → { start, end, branch_id, granularity }
//   tb.setSnapshot(true)  → period controls disabled with the inline "Snapshot — no period" explanation
//   setKpis($("#kpis"), [kpiTile(…), …])   wireCard(card, { csv: () => url })   drill.patrons("overdue")
import { $, $$, api, html, icon, money, num, qs, raw } from "/static/js/core.js";
import { setView } from "/static/js/charts.js";
import { formatList, locale, t } from "/static/js/i18n.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { savedViews } from "/static/js/ui/filters.js";
import { wireDateRange } from "/static/js/ui/date-range.js";
import { wireSegmented } from "/static/js/ui/tabs.js";

export const RANGES = ["7d", "30d", "90d", "365d", "ytd", "custom"];
const PRESET_DAYS = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
export const DEFAULT_GRAN = { "7d": "day", "30d": "day", "90d": "week", "365d": "month", ytd: "month", custom: "day" };
export const MAX_DAYS = 1098;
const DAY = 86400000;

// ------------------------------------------------------------------ dates

/** Local calendar date → "YYYY-MM-DD". */
export const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** "YYYY-MM-DD" → Date at UTC midnight (format with timeZone: "UTC" so the calendar day never moves). */
export const asDate = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
export const addDays = (s, n) => { const d = asDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const dayCount = (start, end) => Math.round((asDate(end) - asDate(start)) / DAY) + 1;

const fmtCache = new Map();
/** Intl.DateTimeFormat for calendar dates (UTC), cached per option set. */
export function dateFmt(opts) {
  const k = JSON.stringify(opts);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }));
  return fmtCache.get(k);
}
export const longDate = (s) => dateFmt({ day: "numeric", month: "short", year: "numeric" }).format(asDate(s));
/** "1 – 30 Sep 2026" (Intl.formatRange where available). */
export function rangeText(start, end) {
  const f = dateFmt({ day: "numeric", month: "short", year: "numeric" });
  try { return f.formatRange(asDate(start), asDate(end)); } catch { return `${longDate(start)} – ${longDate(end)}`; }
}
/** Bucket label for a chart axis at the given granularity. */
export function bucketLabel(s, g) {
  return g === "month" ? dateFmt({ month: "short", year: "numeric" }).format(asDate(s)) : dateFmt({ day: "numeric", month: "short" }).format(asDate(s));
}
/** Localised short weekday for an index where 0 = Monday. */
export const weekday = (i) => dateFmt({ weekday: "short" }).format(new Date(Date.UTC(2024, 0, 1 + i)));

export function presetDates(range, today = new Date()) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  if (range === "ytd") start.setMonth(0, 1);
  else start.setDate(end.getDate() - (PRESET_DAYS[range] || 30) + 1);
  return { start: isoDay(start), end: isoDay(end) };
}

// ------------------------------------------------------------------ number formatting

export const fmt = {
  num,
  money,
  pct: (v, digits = 0) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(v) || 0),
  dec: (v, digits = 2) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(v) || 0),
  hour: (h) => new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(h),
};

// ------------------------------------------------------------------ drill-down destinations (only URLs that exist)

export const drill = {
  patrons: (status, extra = {}) => `/staff/patrons?${qs({ status, ...extra })}`,
  patron: (id) => (id ? `/staff/patrons/${id}` : ""),
  record: (id) => (id ? `/staff/catalog/${id}` : ""),
  catalog: (q) => `/staff/catalog?${qs({ q })}`,
  material: (type) => `/staff/catalog?${qs({ material_type: type })}`,
  category: (id) => (id ? `/staff/patrons?${qs({ category_id: id })}` : ""),
  holds: () => "/staff/holds",
  circulation: () => "/staff/circulation",
  acquisitions: () => "/staff/acquisitions",
  /** Another Insights page, carrying the current period and branch. */
  insights(page, state = {}, hash = "") {
    const p = { range: state.range && state.range !== "30d" ? state.range : undefined, branch: state.branch || undefined };
    if (state.range === "custom") Object.assign(p, { start: state.start, end: state.end });
    const q = qs(p);
    return `/staff/${page}${q ? `?${q}` : ""}${hash ? `#${hash}` : ""}`;
  },
};

// ------------------------------------------------------------------ toolbar

/**
 * Wire the server-rendered toolbar (#ins-toolbar). State lives in the query string (range, start, end, branch,
 * g, compare); the URL hash is preserved so Reports keeps its #report deep links.
 */
export function createToolbar({ root = $("#ins-toolbar"), granularity = false, compare = false, onChange = () => {} } = {}) {
  const state = readUrl();
  let snapshot = root.dataset.snapshot === "true";
  let branches = [];
  const status = $("[data-period-text]", root), note = $("[data-snapshot-note]", root);
  const custom = $("[data-date-range]", root), select = $("#ins-branch", root), cmp = $("#ins-compare", root);

  function readUrl() {
    const p = new URLSearchParams(location.search);
    const s = { range: RANGES.includes(p.get("range")) ? p.get("range") : "30d", branch: /^\d+$/.test(p.get("branch") || "") ? p.get("branch") : "",
      start: "", end: "", g: "", compare: p.get("compare") !== "0" };
    const okDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
    if (s.range === "custom" && okDate(p.get("start")) && okDate(p.get("end")) && p.get("start") <= p.get("end")) Object.assign(s, { start: p.get("start"), end: p.get("end") });
    else { if (s.range === "custom") s.range = "30d"; Object.assign(s, presetDates(s.range)); }
    s.g = ["day", "week", "month"].includes(p.get("g")) ? p.get("g") : DEFAULT_GRAN[s.range];
    if (s.range === "custom" && !p.get("g") && dayCount(s.start, s.end) > 120) s.g = "week";
    return s;
  }

  function writeUrl() {
    const p = { range: state.range === "30d" ? undefined : state.range, branch: state.branch || undefined };
    if (state.range === "custom") Object.assign(p, { start: state.start, end: state.end });
    if (granularity && state.g !== DEFAULT_GRAN[state.range]) p.g = state.g;
    if (compare && !state.compare) p.compare = "0";
    const q = qs(p);
    history.replaceState(history.state, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
  }

  function describe() {
    if (snapshot) return "";
    const parts = [rangeText(state.start, state.end)];
    if (compare && state.compare) {
      const prev = previous();
      parts.push(t("insights.common.compared_with", { range: rangeText(prev.start, prev.end) }));
    }
    if (granularity) parts.push(t(`insights.common.by_${state.g}`));
    return parts.join(" · ");
  }

  function sync() {
    $$("[data-range] [role=radio]", root).forEach((b) => {
      const on = b.dataset.value === state.range;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = snapshot;
    });
    $$("[data-gran] [role=radio]", root).forEach((b) => {
      const on = b.dataset.value === state.g;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = snapshot || (b.dataset.value === "day" && dayCount(state.start, state.end) > 400);
    });
    if (custom) {
      custom.hidden = snapshot || state.range !== "custom";
      $("[data-start]", custom).value = state.start;
      $("[data-end]", custom).value = state.end;
      $("[data-end]", custom).max = isoDay(new Date());
      $("[data-start]", custom).max = isoDay(new Date());
    }
    if (cmp) { cmp.checked = state.compare; cmp.disabled = snapshot; }
    if (select) select.value = state.branch;
    root.dataset.snapshot = String(snapshot);
    note.hidden = !snapshot;
    status.hidden = snapshot;
    status.textContent = describe();
  }

  function previous() {
    const days = dayCount(state.start, state.end);
    return { start: addDays(state.start, -days), end: addDays(state.start, -1) };
  }

  function change(changes) {
    Object.assign(state, changes);
    writeUrl();
    sync();
    onChange({ ...state });
  }

  if ($("[data-range]", root)) wireSegmented($("[data-range]", root), (value) => {
    if (snapshot || value === state.range) return;
    if (value === "custom") { state.range = "custom"; writeUrl(); sync(); $("[data-start]", custom).focus(); return; }
    change({ range: value, ...presetDates(value), g: DEFAULT_GRAN[value] });
  });
  if (granularity) wireSegmented($("[data-gran]", root), (value) => { if (!snapshot && value !== state.g) change({ g: value }); });
  if (custom) wireDateRange(custom, ({ start, end }) => {
    if (!start || !end) return;
    const days = dayCount(start, end);
    const g = days > 400 && state.g === "day" ? "month" : days > 120 && state.g === "day" ? "week" : state.g;
    change({ range: "custom", start, end, g });
  }, { maxDays: MAX_DAYS - 1 });
  select?.addEventListener("change", () => change({ branch: select.value }));
  cmp?.addEventListener("change", () => change({ compare: cmp.checked }));

  async function loadBranches() {
    try { branches = (await api("/lookups")).branches || []; } catch { branches = []; }
    if (!select) return branches;
    const cur = state.branch;
    select.innerHTML = html`<option value="">${t("common.all_branches")}</option>${branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}`;
    if (cur && !branches.some((b) => String(b.id) === cur)) { state.branch = ""; writeUrl(); }
    select.value = state.branch;
    return branches;
  }

  writeUrl();
  sync();
  return {
    state,
    branches: () => branches,
    branchName: () => (state.branch ? branches.find((b) => String(b.id) === state.branch)?.name || "" : t("common.all_branches")),
    loadBranches,
    previous,
    describe,
    set: change,
    /** Point-in-time view: disable the period controls and explain why. */
    setSnapshot(on) { snapshot = !!on; sync(); },
    get snapshot() { return snapshot; },
    apiParams: () => ({ start: state.start, end: state.end, branch_id: state.branch || undefined, ...(granularity ? { granularity: state.g } : {}) }),
    days: () => dayCount(state.start, state.end),
  };
}

/**
 * Saved views over the toolbar state (plus optional extra keys such as the report).
 * Presets are complete parameter sets; user views are saved per browser by ui/filters.js.
 */
export function wireViews(el, { id, toolbar, presets, keys, current, onSelect }) {
  return savedViews(el, {
    id, keys, presets,
    current: current || (() => ({ ...toolbar.state, compare: "" })),
    onSelect: (params) => {
      const range = RANGES.includes(params.range) ? params.range : "30d";
      const dates = range === "custom" && params.start && params.end ? { start: params.start, end: params.end } : presetDates(range);
      onSelect ? onSelect(params, { range, ...dates }) : toolbar.set({ range, ...dates, branch: params.branch || "", g: params.g || DEFAULT_GRAN[range] });
    },
  });
}

// ------------------------------------------------------------------ KPI tiles

/** Replace the server-rendered KPI skeletons (same count, same fixed height) with tiles. */
export function setKpis(el, tiles) {
  el.innerHTML = html`${tiles}`;
  el.removeAttribute("aria-busy");
}

export function kpiError(el, err, retry) {
  el.removeAttribute("aria-busy");
  el.innerHTML = html`<div class="card ins-kpi-error" role="alert">${icon("alert")}<span>${err?.message || String(err)}</span>
    ${retry ? html`<button type="button" class="btn sm" data-kpi-retry>${t("ui.state.retry")}</button>` : ""}</div>`;
  if (retry) $("[data-kpi-retry]", el).addEventListener("click", retry, { once: true });
}

// ------------------------------------------------------------------ cards

/**
 * Wire a server-rendered chart card: the "Table" toggle flips every chart inside between chart and data
 * table (charts.js setView), the CSV link follows the current filters.
 */
export function wireCard(card, { csv } = {}) {
  const toggle = $("[data-view-toggle]", card);
  toggle?.addEventListener("click", () => {
    const on = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(on));
    card.dataset.view = on ? "table" : "chart";
    $$(".viz", card).forEach((v) => setView(v, on ? "table" : "chart"));
  });
  return {
    card,
    body: $("[data-body]", card),
    sub: $("[data-sub]", card),
    setCsv(href) { const a = $("[data-csv]", card); if (a) a.href = href; },
    /** Apply the card's current chart/table choice to charts rendered after a reload. */
    applyView() { if (card.dataset.view === "table") $$(".viz", card).forEach((v) => setView(v, "table")); },
    setToggle(visible) { if (toggle) toggle.hidden = !visible; },
    csv,
  };
}

/** Loading placeholder sized like the final chart (the card body keeps its min-height). */
export const chartSkeleton = (kind = "chart") => raw(`<div class="ins-skel ins-skel-${kind}" aria-hidden="true"></div>`);

export function cardError(body, err, retry) {
  body.innerHTML = html`${errorState(err, { retry: !!retry })}`;
  if (retry) $("[data-retry]", body)?.addEventListener("click", retry, { once: true });
}

export const cardEmpty = (title, bodyText = "", art = "inbox", actions = "") =>
  emptyState({ art, title, body: bodyText, actions, compact: true });

// ------------------------------------------------------------------ small pieces

/** Pill with dot + text for a tone (success · warning · danger · info · neutral · ai). */
export const pill = (tone, label) => html`<span class="badge pill ${tone}"><span class="dot" aria-hidden="true"></span>${label}</span>`;

/** Inline mini statistic, optionally a drill-down link. */
export function miniStat(label, value, note = "", href = "") {
  const inner = html`<span class="label">${label}</span><span class="value">${value}</span>${note ? html`<span class="note">${note}</span>` : ""}`;
  return href ? html`<a class="ins-mini" href="${href}">${inner}</a>` : html`<div class="ins-mini">${inner}</div>`;
}

/**
 * Change vs the previous period as a coloured inline delta: "▲ 12% vs previous period". Colour follows
 * meaning (goodWhen "up" | "down"), the arrow is decorative and screen readers hear "up 12% …".
 */
export function deltaText(cur, prev, { goodWhen = "up" } = {}) {
  if (prev === null || prev === undefined) return "";
  if (!prev) return html`<span class="ins-delta flat">${cur ? t("insights.common.new_this_period") : t("insights.common.no_change")}</span>`;
  const d = (cur - prev) / Math.abs(prev);
  if (d === 0) return html`<span class="ins-delta flat">${t("insights.common.no_change")}</span>`;
  const abs = Math.abs(d);
  const pctTxt = abs > 9.99 ? ">999%" : fmt.pct(abs, abs < 0.1 ? 1 : 0);
  const good = (d > 0) === (goodWhen === "up");
  return html`<span class="ins-delta ${good ? "good" : "bad"}"><span aria-hidden="true">${d > 0 ? "▲" : "▼"}</span>
    <span class="sr-only">${d > 0 ? t("charts.up") : t("charts.down")}</span> ${pctTxt} <span class="ins-delta-vs">${t("charts.vs_previous")}</span></span>`;
}

export const list = (items) => formatList(items.filter(Boolean));

/** Bind data-* drill links that should keep the current toolbar state when clicked (href is refreshed). */
export function refreshInsightLinks(root, state) {
  $$("[data-insights-link]", root).forEach((a) => { a.href = drill.insights(a.dataset.insightsLink, state, a.dataset.hash || ""); });
}
