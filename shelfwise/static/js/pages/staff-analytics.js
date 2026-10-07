// Staff: Analytics — date-range/branch/granularity filters (kept in the URL) driving independent panels.
import { $, $$, api, empty, html, icon, money, num, qs, raw, skeleton, toast } from "/static/js/core.js";
import { barChart, delta, donutChart, heatmap, hBarChart, kpiTile, lineChart } from "/static/js/charts.js";
import { locale } from "/static/js/i18n.js";

const PRESETS = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
const DEFAULT_GRAN = { "7d": "day", "30d": "day", "90d": "week", "365d": "month", ytd: "month" };
const state = { range: "30d", start: "", end: "", branch: "", g: "day", seq: 0 };
let branches = [];

// ------------------------------------------------------------------ dates & formatting

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const utcFmt = (opts) => new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" });
const dayFmt = utcFmt({ day: "numeric", month: "short" });
const longFmt = utcFmt({ day: "numeric", month: "short", year: "numeric" });
const monthFmt = utcFmt({ month: "short", year: "numeric" });
const asDate = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const bucketLabel = (s) => (state.g === "month" ? monthFmt.format(asDate(s)) : dayFmt.format(asDate(s)));
const longDate = (s) => longFmt.format(asDate(s));
const pct = (v, digits = 0) => `${(100 * (v || 0)).toFixed(digits)}%`;
const fixed2 = (v) => (Number(v) || 0).toFixed(2);
const unit = () => ({ day: "day", week: "week", month: "month" }[state.g]);

function presetDates(range) {
  const end = new Date();
  const start = new Date(end);
  if (range === "ytd") start.setMonth(0, 1);
  else start.setDate(end.getDate() - (PRESETS[range] || 30) + 1);
  return { start: iso(start), end: iso(end) };
}

// ------------------------------------------------------------------ URL state

function readState() {
  const p = new URLSearchParams(location.search);
  state.range = p.get("range") in PRESETS || ["ytd", "custom"].includes(p.get("range")) ? p.get("range") : "30d";
  state.branch = p.get("branch") || "";
  if (state.range === "custom" && p.get("start") && p.get("end")) Object.assign(state, { start: p.get("start"), end: p.get("end") });
  else { if (state.range === "custom") state.range = "30d"; Object.assign(state, presetDates(state.range)); }
  state.g = ["day", "week", "month"].includes(p.get("g")) ? p.get("g") : DEFAULT_GRAN[state.range] || "day";
}

function writeState() {
  const params = { range: state.range, branch: state.branch || undefined, g: state.g };
  if (state.range === "custom") Object.assign(params, { start: state.start, end: state.end });
  history.replaceState(null, "", `${location.pathname}?${qs(params)}`);
}

const apiParams = () => qs({ start: state.start, end: state.end, granularity: state.g, branch_id: state.branch || undefined });

function syncControls() {
  $$("[data-range]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.range === state.range));
  $$("[data-gran]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.gran === state.g));
  $("#an-custom").hidden = state.range !== "custom";
  $("#an-start").value = state.start;
  $("#an-end").value = state.end;
  $("#an-branch").value = state.branch;
  const br = branches.find((b) => String(b.id) === state.branch);
  $("#an-range-label").textContent = `${longDate(state.start)} – ${longDate(state.end)} · ${br ? br.name : "All branches"} · by ${unit()}`;
}

// ------------------------------------------------------------------ panel plumbing

const cache = new Map();
function fetchPanel(name) {
  const key = `${name}?${apiParams()}`;
  if (!cache.has(key)) cache.set(key, api(`/analytics/${name}?${apiParams()}`).catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

const deltaText = (cur, prev) => {
  const d = delta(cur, prev);
  if (d === null) return "";
  return d === 0 ? "no change vs previous period" : `${d > 0 ? "▲" : "▼"} ${Math.abs(Math.round(d * 100))}% vs previous period`;
};
const miniStat = (label, value, note = "") => html`<div class="mini-stat"><span class="label">${label}</span><span class="value">${value}</span>${note ? html`<span class="tiny muted">${note}</span>` : ""}</div>`;

async function loadPanel(section, seq) {
  const name = section.dataset.panel;
  const body = $("[data-body]", section), sub = $("[data-sub]", section), tools = $("[data-tools]", section);
  const title = $("h2", section).textContent;
  tools.innerHTML = html`<a class="btn ghost sm" href="/api/v1/analytics/${name}?${apiParams()}&fmt=csv" download aria-label="Download ${title} as CSV">${icon("download")}CSV</a>`;
  body.setAttribute("aria-busy", "true");
  body.innerHTML = skeleton(5);
  sub.textContent = "";
  try {
    const data = await fetchPanel(name);
    if (seq !== state.seq) return;
    body.innerHTML = "";
    RENDER[section.dataset.view || name](body, data, sub);
  } catch (e) {
    if (seq !== state.seq) return;
    body.innerHTML = html`<div class="alert bad" role="alert">${icon("alert")}<div>${e.message}</div></div>`;
  } finally {
    body.removeAttribute("aria-busy");
  }
}

function block(body, heading) {
  const wrap = document.createElement("div");
  wrap.className = "an-block";
  if (heading) wrap.innerHTML = html`<h3 class="an-block-title">${heading}</h3>`;
  const el = document.createElement("div");
  wrap.append(el);
  body.append(wrap);
  return el;
}

// ------------------------------------------------------------------ renderers

const RENDER = {
  circulation(body, d, sub) {
    sub.textContent = `${num(d.totals.checkouts)} checkouts · ${deltaText(d.totals.checkouts, d.totals.previous_checkouts)}`;
    lineChart(block(body), {
      labels: d.labels.map(bucketLabel), height: 260,
      series: [{ name: "This period", values: d.checkouts }, { name: "Previous period", values: d.previous_checkouts, compare: true }],
      summary: `Checkouts per ${unit()}, ${longDate(state.start)} to ${longDate(state.end)}: ${num(d.totals.checkouts)} in total, compared with ${num(d.totals.previous_checkouts)} in the previous period.`,
    });
  },
  activity(body, d, sub) {
    sub.textContent = `${num(d.totals.returns)} returns · ${num(d.totals.renewals)} renewals`;
    barChart(block(body), {
      labels: d.labels.map(bucketLabel), height: 220,
      series: [{ name: "Returns", values: d.returns }, { name: "Renewals", values: d.renewals }],
      summary: `Returns and renewals per ${unit()}: ${num(d.totals.returns)} returns and ${num(d.totals.renewals)} renewals.`,
    });
  },
  heatmap(body, d, sub) {
    sub.textContent = d.busiest ? `Busiest: ${d.busiest.day} ${String(d.busiest.hour).padStart(2, "0")}:00 (${num(d.busiest.count)} checkouts)` : "No checkouts in this period";
    heatmap(block(body), {
      rows: d.rows, cols: d.cols, values: d.values, rowHeader: "Day", colFormat: (h) => `${String(h).padStart(2, "0")}h`,
      format: (v) => `${num(v)}`, summary: "Checkouts by day of week and hour of day (library local time).",
    });
  },
  turnover(body, d, sub) {
    sub.textContent = `${fixed2(d.overall)} loans per item overall`;
    hBarChart(block(body, "Loans per item, by item type"), {
      items: d.by_type.map((r) => ({ label: r.label, value: r.turnover, note: `${num(r.loans)} loans · ${num(r.items)} items` })),
      format: fixed2, valueLabel: "Loans per item", summary: "Collection turnover (loans per item) by item type",
    });
    hBarChart(block(body, "Top subjects by loans"), {
      items: d.by_subject.map((r) => ({ label: r.label, value: r.loans, note: `${fixed2(r.turnover)} per item`, href: `/search?subject=${encodeURIComponent(r.label)}` })),
      valueLabel: "Loans", summary: "Most borrowed subjects with loans per item",
    });
  },
  collection(body, d, sub) {
    sub.textContent = `${num(d.total_items)} items in circulation`;
    const stats = document.createElement("div");
    stats.className = "mini-stats";
    stats.innerHTML = html`${miniStat("Never borrowed", pct(d.never_borrowed_share, 1), `${num(d.never_borrowed)} items`)}
      ${miniStat("Not borrowed this period", pct(d.idle_share, 1), `${num(d.not_borrowed_in_period)} items`)}
      <div class="meter-pair" aria-hidden="true"><div class="meter"><div style="width:${pct(d.never_borrowed_share)}"></div></div></div>`;
    body.append(stats);
    barChart(block(body, "Items by year acquired"), {
      labels: d.by_acquisition_year.map((r) => r.label), height: 180,
      series: [{ name: "Items", values: d.by_acquisition_year.map((r) => r.value) }], summary: "Items by year of acquisition",
    });
    barChart(block(body, "Items by publication decade"), {
      labels: d.by_publication_decade.map((r) => r.label), height: 180,
      series: [{ name: "Items", values: d.by_publication_decade.map((r) => r.value) }], summary: "Items by publication decade",
    });
  },
  holds(body, d, sub) {
    sub.textContent = `${num(d.totals.placed)} placed · ${deltaText(d.totals.placed, d.totals.previous_placed)}`;
    const stats = document.createElement("div");
    stats.className = "mini-stats";
    stats.innerHTML = html`${miniStat("Median wait", d.median_days_to_ready === null ? "—" : `${d.median_days_to_ready} days`, "placed → ready")}
      ${miniStat("Filled", d.fill_rate === null ? "—" : pct(d.fill_rate), "of holds placed")}
      ${miniStat("Queued now", num(d.queued_now))}${miniStat("On hold shelf", num(d.ready_now))}`;
    body.append(stats);
    lineChart(block(body), {
      labels: d.labels.map(bucketLabel), height: 200, area: false,
      series: [{ name: "Placed", values: d.placed }, { name: "Filled", values: d.filled }],
      summary: `Holds placed (${num(d.totals.placed)}) and filled (${num(d.totals.filled)}) per ${unit()}.`,
    });
  },
  patrons(body, d, sub) {
    sub.textContent = `${num(d.active)} active of ${num(d.registered)} registered (${pct(d.active_share)})`;
    const stats = document.createElement("div");
    stats.className = "mini-stats";
    stats.innerHTML = html`${miniStat("Active borrowers", num(d.active), deltaText(d.active, d.previous_active))}
      ${miniStat("Registered", num(d.registered))}${miniStat("New registrations", num(d.new_total), deltaText(d.new_total, d.previous_new))}`;
    body.append(stats);
    barChart(block(body, "Registered vs active, by category"), {
      labels: d.by_category.map((c) => c.label), height: 200,
      series: [{ name: "Registered", values: d.by_category.map((c) => c.registered) }, { name: "Active", values: d.by_category.map((c) => c.active) }],
      summary: "Registered and active patrons by category",
    });
    donutChart(block(body, "Active borrowers by category"), {
      items: d.by_category.map((c) => ({ label: c.label, value: c.active })), center: { value: num(d.active), label: "active" },
      summary: "Share of active borrowers by patron category",
    });
  },
  fines(body, d, sub) {
    const t = d.totals;
    sub.textContent = `${money(t.charged)} charged · ${money(t.paid)} paid · ${money(t.waived)} waived`;
    const stats = document.createElement("div");
    stats.className = "mini-stats";
    stats.innerHTML = html`${miniStat("Charged", money(t.charged), deltaText(t.charged, d.previous_totals.charged))}
      ${miniStat("Collected", money(t.paid), deltaText(t.paid, d.previous_totals.paid))}${miniStat("Outstanding now", money(d.outstanding))}`;
    body.append(stats);
    barChart(block(body), {
      labels: d.labels.map(bucketLabel), height: 210, format: money,
      series: [{ name: "Charged", values: d.charged }, { name: "Paid", values: d.paid }, { name: "Waived", values: d.waived }],
      summary: `Fines charged, paid and waived per ${unit()}.`,
    });
  },
  top(body, d) {
    const tabs = document.createElement("div");
    tabs.className = "seg";
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Show most borrowed");
    tabs.innerHTML = html`<button type="button" data-top="titles" aria-pressed="true">Titles</button>
      <button type="button" data-top="authors" aria-pressed="false">Authors</button><button type="button" data-top="subjects" aria-pressed="false">Subjects</button>`;
    body.append(tabs);
    const el = block(body);
    const show = (kind) => {
      $$("[data-top]", tabs).forEach((b) => b.setAttribute("aria-pressed", b.dataset.top === kind));
      const items = d[kind].map((r) => ({ ...r, href: kind === "titles" ? `/staff/catalog/${r.id}` : undefined }));
      hBarChart(el, { items, valueLabel: "Loans", summary: `Most borrowed ${kind}` });
    };
    tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-top]"); if (b) show(b.dataset.top); });
    show("titles");
  },
  branches(body, d) {
    const rows = d.branches;
    if (!rows.length) { body.innerHTML = empty("No branches configured."); return; }
    const best = (k) => Math.max(...rows.map((r) => r[k]));
    const cell = (r, k, fmt = num) => html`<td class="num ${r[k] === best(k) && r[k] > 0 && rows.length > 1 ? "lead" : ""}">${fmt(r[k])}</td>`;
    body.innerHTML = html`<div class="table-wrap"><table class="table">
      <caption class="sr-only">Branch comparison for the selected period. The leading branch in each column is highlighted.</caption>
      <thead><tr><th scope="col">Branch</th><th scope="col" class="num">Checkouts</th><th scope="col" class="num">Returns</th>
        <th scope="col" class="num">Active patrons</th><th scope="col" class="num">Holds placed</th><th scope="col" class="num">Items</th>
        <th scope="col" class="num">Loans / item</th><th scope="col" class="num">Open loans</th><th scope="col" class="num">Overdue now</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr class="${r.selected ? "selected" : ""}"><th scope="row">${r.name}${r.selected ? html` <span class="badge info">selected</span>` : ""}</th>
        ${cell(r, "checkouts")}${cell(r, "returns")}${cell(r, "active_patrons")}${cell(r, "holds_placed")}${cell(r, "items")}
        ${cell(r, "turnover", fixed2)}${cell(r, "open_loans")}<td class="num">${num(r.overdue)} <span class="tiny muted">(${pct(r.overdue_rate)})</span></td></tr>`)}</tbody>
    </table></div>`;
  },
};

// ------------------------------------------------------------------ KPIs

async function loadKpis(seq) {
  const box = $("#an-kpis");
  box.innerHTML = html`${Array.from({ length: 8 }, () => html`<div class="card stat">${raw(skeleton(2))}</div>`)}`;
  try {
    const { kpis: k } = await fetchPanel("overview");
    if (seq !== state.seq) return;
    const cmp = `vs ${longDate(addDays(state.start, -dayCount()))} – ${longDate(addDays(state.start, -1))}`;
    const tile = (label, key, opts = {}) => kpiTile({ label, value: k[key].value, previous: k[key].previous, format: k[key].money ? money : num, compareLabel: "vs previous", ...opts });
    box.innerHTML = html`
      ${tile("Checkouts", "checkouts", { spark: k.checkouts.spark, note: cmp })}${tile("Returns", "returns")}${tile("Renewals", "renewals")}
      ${tile("Active borrowers", "active_patrons")}${tile("New patrons", "new_patrons")}${tile("Holds placed", "holds_placed")}
      ${tile("Fines charged", "fines_charged", { invert: true })}${tile("Fines collected", "fines_paid")}`;
  } catch (e) {
    box.innerHTML = html`<div class="alert bad" role="alert">${icon("alert")}<div>${e.message}</div></div>`;
  }
}
const dayCount = () => Math.round((asDate(state.end) - asDate(state.start)) / 86400000) + 1;
const addDays = (s, n) => { const d = asDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function loadAll() {
  const seq = ++state.seq;
  cache.clear();
  writeState();
  syncControls();
  loadKpis(seq);
  $$(".an-panel").forEach((s) => loadPanel(s, seq));
}

// ------------------------------------------------------------------ init

export default async function init() {
  readState();
  try { branches = (await api("/lookups")).branches; } catch (e) { toast(e.message, "error"); }
  $("#an-branch").insertAdjacentHTML("beforeend", html`${branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}`);
  const form = $("#an-filters");
  const err = $("#an-filter-error");
  form.addEventListener("click", (e) => {
    const r = e.target.closest("[data-range]"), g = e.target.closest("[data-gran]");
    if (r) {
      state.range = r.dataset.range;
      if (state.range === "custom") { syncControls(); $("#an-start").focus(); return; }
      Object.assign(state, presetDates(state.range), { g: DEFAULT_GRAN[state.range] });
      loadAll();
    }
    if (g) { state.g = g.dataset.gran; loadAll(); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const s = $("#an-start").value, en = $("#an-end").value;
    err.hidden = true;
    if (!s || !en || s > en) { err.textContent = "Choose a start date on or before the end date."; err.hidden = false; $("#an-start").focus(); return; }
    Object.assign(state, { range: "custom", start: s, end: en });
    const days = dayCount();
    if (days > 1098) { err.textContent = "The longest range is three years."; err.hidden = false; return; }
    if (days > 120 && state.g === "day") state.g = "week";
    loadAll();
  });
  $("#an-branch").addEventListener("change", (e) => { state.branch = e.target.value; loadAll(); });
  $("#an-refresh").addEventListener("click", loadAll);
  loadAll();
}
