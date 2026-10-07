// Staff › Insights › Reports — a catalogue of vetted, parameterised reports (grouped by theme) with the shared
// Insights toolbar, "right now" KPI tiles, saved views, and results in the standard data table with
// humanised values and drill-down links. Deep links: /staff/reports?range=90d&branch=2#top_titles.
import { $, $$, api, date, datetime, html, icon, money, num, qs, withBusy } from "/static/js/core.js";
import { kpiTile } from "/static/js/charts.js";
import { t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { errorState } from "/static/js/ui/empty.js";
import { statusPill } from "/static/js/ui/status.js";
import {
  createToolbar, drill, fmt, kpiError, pill, presetDates, rangeText, setKpis, wireViews,
} from "/static/js/pages/lib/insights-ui.js";

const page = $("#ins-page");
const canExport = page.dataset.canExport === "true";
const canAnalytics = page.dataset.canAnalytics === "true";
const NAV = $$("[data-report]", page);
const KEYS = NAV.map((a) => a.dataset.report);
const DATED = new Set(NAV.filter((a) => a.dataset.dated === "true").map((a) => a.dataset.report));
const DEFAULT_KEY = "overdues";
const state = { key: DEFAULT_KEY, seq: 0, rows: [], cols: [], sort: null, page: 1, perPage: 25 };
let tb, views, table;

const keyFromHash = () => { const k = decodeURIComponent(location.hash.slice(1)); return KEYS.includes(k) ? k : null; };
const reportName = (k) => t(`insights.reports.r.${k}.name`);

// ------------------------------------------------------------------ values

const NEVER = "never";
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);

/** Destination for a column that links somewhere (record, patron, branch breakdown, patron category). */
function linkFor(col, ref) {
  const id = ref?.[col.link];
  if (!id) return "";
  if (col.link === "biblio") return drill.record(id);
  if (col.link === "patron") return drill.patron(id);
  if (col.link === "category") return drill.category(id);
  if (col.link === "branch") return drill.insights("reports", { ...tb.state, branch: String(id) }, "circulation_by_category");
  return "";
}

function display(col, v) {
  if (v === null || v === undefined || v === "") return html`<span class="muted">—</span>`;
  switch (col.type) {
    case "number": return num(v);
    case "money": return money(v);
    case "date": return v === NEVER ? pill("neutral", t("insights.reports.never")) : isDate(v) ? html`<span class="nowrap">${date(v)}</span>` : v;
    case "status": return statusPill(col.kind || "item", v);
    case "code": return html`<span class="mono">${v}</span>`;
    default: return v;
  }
}

function csvValue(col, v) {
  if (v === null || v === undefined) return "";
  if (col.type === "date" && v === NEVER) return t("insights.reports.never");
  if (col.type === "status") return t(`status.${v}`, {}, String(v).replace(/_/g, " "));
  return v;
}

function sortValue(col, v) {
  if (col.type === "number" || col.type === "money") return Number(v) || 0;
  if (col.type === "date") return v === NEVER || !v ? "" : String(v);
  return String(v ?? "");
}

const PRIMARY = ["title", "name", "first_name", "branch", "category", "item_type"];

/** Display order: the column that names the row first (title, name, branch…), the rest as delivered. */
function displayOrder(cols) {
  const idx = cols.map((_, i) => i);
  const p = cols.findIndex((c) => PRIMARY.includes(c.key));
  if (p > 0) {
    const lead = [p, ...(cols[p].key === "first_name" ? [cols.findIndex((c) => c.key === "last_name")].filter((i) => i > 0) : [])];
    return [...lead, ...idx.filter((i) => !lead.includes(i))];
  }
  return idx;
}

/** One link per destination: prefer a text column over a code (barcode/card) column. */
function linkedColumns(cols, order) {
  const seen = new Set(), out = new Set();
  for (const pass of [(c) => c.type !== "code", () => true]) {
    for (const i of order) {
      const c = cols[i];
      if (c.link && !seen.has(c.link) && pass(c)) { seen.add(c.link); out.add(i); }
    }
  }
  return out;
}

function columns(cols) {
  const order = displayOrder(cols);
  const linked = linkedColumns(cols, order);
  return order.map((i, pos) => {
    const c = cols[i];
    return {
      key: `c${i}`, label: t(`insights.reports.col.${c.key}`, {}, c.label), sortable: true, primary: pos === 0, hideable: pos !== 0,
      // the card number is secondary when the patron's name is shown (still available from the column chooser)
      hidden: c.key === "card" && cols.some((o) => o.key === "patron" || o.key === "name"),
      align: c.type === "number" || c.type === "money" ? "num" : undefined,
      csv: (r) => csvValue(c, r.values[i]),
      render: (r) => {
        const href = linked.has(i) ? linkFor(c, r.ref) : "";
        const v = display(c, r.values[i]);
        return href ? html`<a href="${href}">${v}</a>` : v;
      },
    };
  });
}

// ------------------------------------------------------------------ KPI tiles ("right now")

async function loadKpis() {
  const box = $("#ins-kpis");
  try {
    const k = await api(`/reports/kpis?${qs({ branch_id: tb.state.branch || undefined })}`);
    const br = tb.state.branch ? { branch_id: tb.state.branch } : {};
    setKpis(box, [
      kpiTile({ label: t("insights.reports.kpi.open_loans"), value: k.open_loans.value, href: drill.circulation(), className: "ins-kpi" }),
      kpiTile({ label: t("insights.reports.kpi.overdue"), value: k.overdue.value, href: drill.patrons("overdue"), alert: k.overdue.value > 0, className: "ins-kpi",
        note: k.open_loans.value ? t("insights.reports.kpi.overdue_note", { pct: fmt.pct(k.overdue.rate, 1) }) : t("insights.reports.kpi.all_on_time") }),
      kpiTile({ label: t("insights.reports.kpi.holds_queued"), value: k.holds_queued.value, href: drill.holds(), className: "ins-kpi",
        note: t("insights.reports.kpi.holds_note") }),
      kpiTile({ label: t("insights.reports.kpi.holds_ready"), value: k.holds_queued.ready, href: drill.holds(), className: "ins-kpi",
        note: t("insights.reports.kpi.ready_note") }),
      kpiTile({ label: t("insights.reports.kpi.fines"), value: k.fines_outstanding.value, format: money, href: drill.patrons("owing", br), className: "ins-kpi",
        alert: k.fines_outstanding.value > 0, note: t("insights.reports.kpi.fines_note") }),
      kpiTile({ label: t("insights.reports.kpi.expired"), value: k.expired_patrons.value, href: drill.patrons("expired", br), className: "ins-kpi",
        note: t("insights.reports.kpi.expired_note") }),
    ]);
  } catch (e) {
    kpiError(box, e, loadKpis);
  }
}

// ------------------------------------------------------------------ report runner

function markNav(key) {
  NAV.forEach((a) => { if (a.dataset.report === key) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
  $("#rep-select").value = key;
}

function contextAction(key) {
  const br = tb.state.branch ? { branch_id: tb.state.branch } : {};
  const a = {
    overdues: [drill.patrons("overdue"), t("insights.reports.action.overdue_patrons"), "users"],
    fines: [drill.patrons("owing", br), t("insights.reports.action.owing_patrons"), "wallet"],
    expired_patrons: [drill.patrons("expired", br), t("insights.reports.action.expired_patrons"), "users"],
    new_patrons: [`/staff/patrons?${qs({ sort: "-created", ...br })}`, t("insights.reports.action.newest_patrons"), "user-plus"],
    weeding: ["/staff/insights", t("insights.reports.action.ai_insights"), "sparkle"],
  }[key];
  if (a) return a;
  if (DATED.has(key) && canAnalytics) return [drill.insights("analytics", tb.state), t("insights.reports.action.open_analytics"), "trend"];
  return null;
}

function apiQuery(key, extra = {}) {
  const s = tb.state;
  return qs({ ...(DATED.has(key) ? { start: s.start, end: s.end } : {}), branch_id: s.branch || undefined, ...extra });
}

function renderHead(key, data) {
  $("#rep-title").textContent = reportName(key);
  $("#rep-desc").textContent = t(`insights.reports.r.${key}.desc`);
  const where = tb.branchName();
  const rows = t("insights.reports.rows", { count: data ? data.rows.length : 0 });
  $("#rep-meta").innerHTML = data ? (DATED.has(key)
    ? html`<span>${rows}</span><span>${rangeText(tb.state.start, tb.state.end)}</span><span>${where}</span>`
    : html`<span>${rows}</span><span>${t("insights.reports.as_of", { time: datetime(data.generated_at) })}</span><span>${where}</span>`) : "";
  const act = contextAction(key);
  $("#rep-actions").innerHTML = html`
    ${act ? html`<a class="btn ghost sm" href="${act[0]}">${icon(act[2])}<span>${act[1]}</span></a>` : ""}
    ${canExport ? html`<a class="btn sm" href="/api/v1/reports/run/${encodeURIComponent(key)}?${apiQuery(key, { fmt: "csv" })}" download>${icon("download")}<span>${t("insights.reports.download_csv")}</span></a>` : ""}`;
}

function emptyFor(key) {
  const dated = DATED.has(key);
  return {
    art: dated ? "filter" : "done",
    title: dated ? t("insights.reports.empty_period_title") : t("insights.reports.empty_now_title"),
    body: dated ? t("insights.reports.empty_period_body") : t("insights.reports.empty_now_body"),
    actions: dated && tb.state.range !== "365d" ? html`<button type="button" class="btn" data-widen>${t("insights.reports.widen")}</button>` : "",
  };
}

function sortRows() {
  if (!state.sort) return;
  const i = Number(state.sort.key.slice(1));
  const col = state.cols[i];
  const dir = state.sort.dir === "desc" ? -1 : 1;
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  state.rows.sort((a, b) => {
    const x = sortValue(col, a.values[i]), y = sortValue(col, b.values[i]);
    return dir * (typeof x === "number" ? x - y : coll.compare(x, y));
  });
}

function showPage() {
  const start = (state.page - 1) * state.perPage;
  table.setRows(state.rows.slice(start, start + state.perPage), { total: state.rows.length, page: state.page, perPage: state.perPage });
}

function mountTable(key, cols) {
  const body = $("#rep-body");
  body.innerHTML = '<div class="ins-rep-table"></div>';
  const order = displayOrder(cols);
  const linkCol = order.find((i) => linkedColumns(cols, order).has(i)) ?? -1;
  table = dataTable($(".ins-rep-table", body), {
    id: `report-${key}`, caption: reportName(key), columns: columns(cols),
    rowKey: (r) => r.i, rowLabel: (r) => String(r.values[0] ?? ""),
    rowHref: linkCol >= 0 ? (r) => linkFor(cols[linkCol], r.ref) || undefined : undefined,
    perPage: state.perPage, perPageOptions: [25, 50, 100],
    onSort: (s) => { state.sort = s; state.page = 1; sortRows(); showPage(); },
    onPage: ({ page: p, perPage }) => { state.page = p || 1; state.perPage = perPage || state.perPage; showPage(); },
    empty: emptyFor(key),
  });
}

async function runReport(key = state.key) {
  if (!KEYS.includes(key)) key = DEFAULT_KEY;
  const changed = key !== state.key || !table;
  state.key = key;
  markNav(key);
  tb.setSnapshot(!DATED.has(key));
  views?.render();
  const seq = ++state.seq;
  const out = $("#rep-output");
  out.setAttribute("aria-busy", "true");
  renderHead(key, null);
  if (changed) { state.sort = null; state.page = 1; }
  try {
    const data = await api(`/reports/run/${encodeURIComponent(key)}?${apiQuery(key)}`);
    if (seq !== state.seq) return;
    state.cols = data.columns;
    state.rows = data.rows.map((values, i) => ({ i, values, ref: data.refs?.[i] || {} }));
    state.page = 1;
    mountTable(key, data.columns);
    if (state.sort) { table.setSort(state.sort); sortRows(); }
    showPage();
    renderHead(key, data);
  } catch (e) {
    if (seq !== state.seq) return;
    $("#rep-body").innerHTML = html`<div class="ins-rep-error">${errorState(e)}</div>`;
    $("[data-retry]", $("#rep-body"))?.addEventListener("click", () => runReport(key), { once: true });
  } finally {
    if (seq === state.seq) out.removeAttribute("aria-busy");
  }
}

/** Switch report without a hashchange round-trip (keeps the query string). */
function goTo(key) {
  if (!KEYS.includes(key)) return;
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${key}`);
  runReport(key);
}

// ------------------------------------------------------------------ init

export default async function init() {
  state.key = keyFromHash() || DEFAULT_KEY;
  tb = createToolbar({ onChange: () => { loadKpis(); runReport(state.key); } });
  tb.setSnapshot(!DATED.has(state.key));
  markNav(state.key);

  const VIEW_KEYS = ["report", "range", "branch", "start", "end"];
  views = wireViews($("#ins-views"), {
    id: "reports", toolbar: tb, keys: VIEW_KEYS,
    current: () => {
      const s = tb.state, dated = DATED.has(state.key);
      return { report: state.key, range: dated ? s.range : "", branch: s.branch, start: dated && s.range === "custom" ? s.start : "", end: dated && s.range === "custom" ? s.end : "" };
    },
    presets: [
      { id: "overdue", label: t("insights.reports.view.overdue"), params: { report: "overdues" } },
      { id: "top30", label: t("insights.reports.view.top30"), params: { report: "top_titles", range: "30d" } },
      { id: "branches_year", label: t("insights.reports.view.branches_year"), params: { report: "circulation_by_branch", range: "ytd" } },
      { id: "joined30", label: t("insights.reports.view.joined30"), params: { report: "new_patrons", range: "30d" } },
      { id: "owing", label: t("insights.reports.view.owing"), params: { report: "fines" } },
    ],
    onSelect: (params, dates) => {
      const key = KEYS.includes(params.report) ? params.report : state.key;
      state.key = key;
      history.replaceState(history.state, "", `${location.pathname}${location.search}#${key}`);
      tb.setSnapshot(!DATED.has(key));
      tb.set({ ...(DATED.has(key) ? dates : {}), branch: params.branch || "" });
    },
  });

  $("#rep-title").tabIndex = -1;
  page.addEventListener("click", (e) => {
    const a = e.target.closest("a.ins-nav-item[data-report]");
    if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); goTo(a.dataset.report); }
    if (e.target.closest("[data-widen]")) tb.set({ range: "365d", ...presetDates("365d"), g: "month" });
  });
  $("#rep-select").addEventListener("change", (e) => goTo(e.target.value));
  window.addEventListener("hashchange", () => { const k = keyFromHash(); if (k && k !== state.key) runReport(k); });
  $("#ins-refresh").addEventListener("click", (e) => withBusy(e.currentTarget, () => Promise.all([loadKpis(), runReport(state.key)])));

  await tb.loadBranches();
  loadKpis();
  runReport(state.key);
}
