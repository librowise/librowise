// Staff › Insights › AI insights — transparent models over live data: late-return risk (filterable by level),
// a natural-language query lab, likely duplicate records, purchase demand and weeding candidates. Shares the
// Insights toolbar (branch; period disabled — these are snapshots), KPI tiles and card patterns.
import { $, $$, api, date, datetime, html, icon, num, openCopilot, qs, toast, withBusy } from "/static/js/core.js";
import { kpiTile } from "/static/js/charts.js";
import { formatList, locale, t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { progress } from "/static/js/ui/stat.js";
import { wireSegmented } from "/static/js/ui/tabs.js";
import { createToolbar, drill, fmt, kpiError, pill, refreshInsightLinks, setKpis } from "/static/js/pages/lib/insights-ui.js";

const page = $("#ins-page");
const canAcq = page.dataset.canAcq === "true";
const canReports = page.dataset.canReports === "true";
const LEVELS = ["high", "medium", "low"];
const TONE = { high: "danger", medium: "warning", low: "success" };
const DUP_PREVIEW = 6;
const state = { risk: [], level: "", dups: [], showAllDups: false, seq: 0 };
let tb, riskTable, demandTable, weedTable;

const levelLabel = (l) => t(`insights.ai.level.${l}`);
const levelPill = (l) => pill(TONE[l] || "neutral", levelLabel(l));
const branchQ = () => qs({ branch_id: tb.state.branch || undefined });

// ------------------------------------------------------------------ overdue risk

/** Humanised model inputs, most telling first. */
function factors(f) {
  return [
    f.historical_late_rate > 0 ? t("insights.ai.risk.f_late_rate", { pct: fmt.pct(f.historical_late_rate) }) : t("insights.ai.risk.f_on_time"),
    f.renewals ? t("insights.ai.risk.f_renewals", { count: f.renewals }) : "",
    f.currently_overdue ? t("insights.ai.risk.f_overdue_now", { count: f.currently_overdue }) : "",
    t("insights.ai.risk.f_days_left", { count: f.days_left }),
  ].filter(Boolean);
}

function riskColumns() {
  return [
    { key: "title", label: t("insights.ai.risk.col_title"), primary: true, hideable: false, sortable: true, csv: (r) => r.title,
      render: (r) => html`<div class="dt-cell-stack">${r.biblio_id ? html`<a href="${drill.record(r.biblio_id)}">${r.title}</a>` : r.title}<span class="sub mono">${r.barcode}</span></div>` },
    { key: "level", label: t("insights.ai.risk.col_level"), csv: (r) => levelLabel(r.level), render: (r) => levelPill(r.level) },
    { key: "risk", label: t("insights.ai.risk.col_risk"), sortable: true, sortDir: "desc", csv: (r) => Math.round(r.risk * 100),
      render: (r) => html`<div class="ins-meter">${progress({ value: Math.round(r.risk * 100), label: t("insights.ai.risk.meter", { title: r.title }), tone: TONE[r.level] })}</div>` },
    { key: "patron", label: t("insights.ai.risk.col_patron"), sortable: true, csv: (r) => r.patron || "",
      render: (r) => (r.patron_id ? html`<a href="${drill.patron(r.patron_id)}">${r.patron}</a>` : html`<span class="muted">—</span>`) },
    { key: "due", label: t("insights.ai.risk.col_due"), sortable: true, sortKey: "due_at", csv: (r) => String(r.due_at).slice(0, 10),
      render: (r) => html`<div class="dt-cell-stack"><span class="nowrap" title="${datetime(r.due_at)}">${date(r.due_at)}</span>
        <span class="sub">${t("insights.ai.risk.in_days", { count: r.factors.days_left })}</span></div>` },
    { key: "factors", label: t("insights.ai.risk.col_factors"), csv: (r) => factors(r.factors).join("; "),
      render: (r) => html`<ul class="ins-factors">${factors(r.factors).map((f) => html`<li>${f}</li>`)}</ul>` },
  ];
}

function riskRows() {
  return state.risk.filter((r) => !state.level || r.level === state.level);
}

function showRisk(pageNo = 1, perPage = riskTable?.state.perPage || 10, sort = riskTable?.state.sort) {
  let rows = riskRows();
  if (sort) {
    const dir = sort.dir === "desc" ? -1 : 1;
    const v = (r) => (sort.key === "title" ? r.title : sort.key === "patron" ? r.patron || "" : sort.key === "due_at" ? String(r.due_at) : r.risk);
    rows = [...rows].sort((a, b) => { const x = v(a), y = v(b); return dir * (typeof x === "number" ? x - y : String(x).localeCompare(String(y), locale)); });
  }
  const start = (pageNo - 1) * perPage;
  riskTable.setRows(rows.slice(start, start + perPage), { total: rows.length, page: pageNo, perPage });
  riskTable._all = rows;
}

function renderLevelCounts() {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, state.risk.filter((r) => r.level === l).length]));
  $$("[data-count]", $("#risk-levels")).forEach((el) => { el.textContent = num(el.dataset.count === "all" ? state.risk.length : counts[el.dataset.count]); });
  return counts;
}

function mountRisk() {
  riskTable = dataTable($("#ins-risk"), {
    id: "ai-risk", caption: t("insights.ai.risk.caption"), columns: riskColumns(),
    rowKey: (r) => r.loan_id, rowLabel: (r) => r.title, rowHref: (r) => drill.record(r.biblio_id) || undefined,
    perPage: 10, perPageOptions: [10, 25, 50, 100], sort: { key: "risk", dir: "desc" },
    onSort: (s) => showRisk(1, riskTable.state.perPage, s),
    onPage: ({ page: p, perPage }) => showRisk(p || 1, perPage),
    exportName: "late-return-risk", exportAll: async () => riskTable._all || riskRows(),
    empty: { art: "done", title: t("insights.ai.risk.empty_title"), body: t("insights.ai.risk.empty_body") },
  });
  riskTable.setLoading();
}

async function loadRisk(seq) {
  riskTable.setLoading();
  try {
    const { results } = await api(`/reports/insights/risk?${branchQ()}`);
    if (seq !== state.seq) return null;
    state.risk = results;
    renderLevelCounts();
    showRisk(1);
    return results;
  } catch (e) {
    if (seq === state.seq) riskTable.setError(e, () => loadRisk(state.seq));
    throw e;
  }
}

// ------------------------------------------------------------------ duplicates

function renderDups() {
  const box = $("#ins-dups");
  const rows = state.dups;
  if (!rows.length) { box.innerHTML = html`${emptyState({ art: "done", title: t("insights.ai.dup.empty_title"), body: t("insights.ai.dup.empty_body"), compact: true })}`; return; }
  const shown = state.showAllDups ? rows : rows.slice(0, DUP_PREVIEW);
  box.innerHTML = html`<ul class="ins-dup-list">${shown.map((d, i) => html`<li class="ins-dup">
      <div class="ins-dup-main">
        ${d.ids.map((id, j) => html`<a class="ins-dup-rec" href="${drill.record(id)}"><span class="ins-dup-title">${d.titles[j] || t("insights.ai.dup.record", { id })}</span><span class="ins-dup-id mono">#${id}</span></a>`)}
        <span class="ins-dup-reason">${d.reason_code === "isbn" ? t("insights.ai.dup.same_isbn", { isbn: d.isbn || "" }) : t("insights.ai.dup.similar")}</span>
      </div>
      <div class="ins-dup-side">
        ${pill(d.score >= 98 ? "danger" : "warning", t("insights.ai.dup.match", { pct: fmt.pct(d.score / 100) }))}
        <button type="button" class="btn sm" data-open-both="${i}" aria-label="${t("insights.ai.dup.open_both_named", { a: d.titles[0] || d.ids[0], b: d.titles[1] || d.ids[1] })}">${icon("external")}${t("insights.ai.dup.open_both")}</button>
      </div></li>`)}</ul>
    ${rows.length > DUP_PREVIEW ? html`<div class="ins-more"><button type="button" class="btn ghost sm" data-dups-all aria-expanded="${state.showAllDups}">
      ${state.showAllDups ? t("insights.ai.show_fewer") : t("insights.ai.show_all", { count: rows.length })}</button></div>` : ""}`;
}

async function loadDups(seq) {
  const box = $("#ins-dups");
  try {
    const { results } = await api("/reports/insights/duplicates");
    if (seq !== state.seq) return null;
    state.dups = results;
    renderDups();
    return results;
  } catch (e) {
    if (seq === state.seq) { box.innerHTML = html`${errorState(e)}`; $("[data-retry]", box)?.addEventListener("click", () => loadDups(state.seq), { once: true }); }
    throw e;
  }
}

// ------------------------------------------------------------------ purchase demand & weeding

function mountDemand() {
  demandTable = dataTable($("#ins-demand"), {
    id: "ai-demand", caption: t("insights.ai.demand.caption"), rowKey: (r) => r.biblio_id, rowLabel: (r) => r.title,
    rowHref: (r) => drill.record(r.biblio_id), exportName: "purchase-demand",
    columns: [
      { key: "title", label: t("insights.ai.demand.col_title"), primary: true, hideable: false, csv: (r) => r.title, render: (r) => html`<a href="${drill.record(r.biblio_id)}">${r.title}</a>` },
      { key: "holds", label: t("insights.ai.demand.col_holds"), align: "num", csv: (r) => r.holds, render: (r) => num(r.holds) },
      { key: "copies", label: t("insights.ai.demand.col_copies"), align: "num", csv: (r) => r.copies, render: (r) => num(r.copies) },
      { key: "ratio", label: t("insights.ai.demand.col_ratio"), align: "num", csv: (r) => r.ratio,
        render: (r) => pill(r.ratio >= 4 ? "danger" : "warning", t("insights.ai.demand.ratio", { ratio: fmt.dec(r.ratio, 1) })) },
      { key: "buy", label: t("insights.ai.demand.col_buy"), align: "num", csv: (r) => r.suggested_copies,
        render: (r) => html`<strong class="ins-buy">${t("insights.ai.demand.buy", { count: r.suggested_copies })}</strong>` },
    ],
    empty: { art: "done", title: t("insights.ai.demand.empty_title"), body: t("insights.ai.demand.empty_body") },
  });
  demandTable.setLoading();
}

function mountWeeding() {
  weedTable = dataTable($("#ins-weeding"), {
    id: "ai-weeding", caption: t("insights.ai.weed.caption"), rowKey: (r) => r.item_id, rowLabel: (r) => r.title,
    rowHref: (r) => drill.record(r.biblio_id) || undefined, exportName: "weeding-candidates", perPage: 10, perPageOptions: [10, 25, 50],
    onPage: ({ page: p, perPage }) => showWeeding(p || 1, perPage),
    columns: [
      { key: "title", label: t("insights.ai.weed.col_title"), primary: true, hideable: false, csv: (r) => r.title,
        render: (r) => (r.biblio_id ? html`<a href="${drill.record(r.biblio_id)}">${r.title}</a>` : r.title) },
      { key: "barcode", label: t("insights.ai.weed.col_barcode"), csv: (r) => r.barcode, render: (r) => html`<span class="mono">${r.barcode}</span>` },
      { key: "last", label: t("insights.ai.weed.col_last"), csv: (r) => (r.last_borrowed ? String(r.last_borrowed).slice(0, 10) : t("insights.reports.never")),
        render: (r) => (r.last_borrowed ? html`<span class="nowrap">${date(r.last_borrowed)}</span>` : pill("neutral", t("insights.reports.never"))) },
      { key: "times", label: t("insights.ai.weed.col_times"), align: "num", csv: (r) => r.times_borrowed, render: (r) => num(r.times_borrowed) },
    ],
    exportAll: async () => weedTable._all || [],
    empty: { art: "done", title: t("insights.ai.weed.empty_title"), body: t("insights.ai.weed.empty_body") },
  });
  weedTable.setLoading();
}

function showWeeding(pageNo = 1, perPage = weedTable.state.perPage || 10) {
  const rows = weedTable._all || [];
  const start = (pageNo - 1) * perPage;
  weedTable.setRows(rows.slice(start, start + perPage), { total: rows.length, page: pageNo, perPage });
}

async function loadTable(table, path, seq, after) {
  table.setLoading();
  try {
    const { results } = await api(path);
    if (seq !== state.seq) return null;
    after ? after(results) : table.setRows(results);
    return results;
  } catch (e) {
    if (seq === state.seq) table.setError(e, () => loadTable(table, path, state.seq, after));
    throw e;
  }
}

// ------------------------------------------------------------------ KPI tiles

function renderKpis(results) {
  const [risk, dups, demand, weed] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
  const counts = risk ? Object.fromEntries(LEVELS.map((l) => [l, risk.filter((r) => r.level === l).length])) : null;
  const val = (v) => (v === null || v === undefined ? "—" : v);
  const capped = (list, cap) => (list ? (list.length >= cap ? t("insights.ai.kpi.at_least", { count: cap }) : num(list.length)) : "—");
  setKpis($("#ins-kpis"), [
    kpiTile({ label: t("insights.ai.kpi.high_risk"), value: val(counts?.high), format: (v) => (v === "—" ? v : num(v)), href: "#risk", className: "ins-kpi",
      alert: !!counts?.high, note: counts ? t("insights.ai.kpi.medium_note", { count: counts.medium }) : "" }),
    kpiTile({ label: t("insights.ai.kpi.duplicates"), value: capped(dups, 50), format: String, href: "#duplicates", className: "ins-kpi",
      note: t("insights.ai.kpi.duplicates_note") }),
    kpiTile({ label: t("insights.ai.kpi.demand"), value: capped(demand, 20), format: String, href: canAcq ? drill.acquisitions() : "", className: "ins-kpi",
      note: demand ? t("insights.ai.kpi.demand_note", { count: demand.reduce((a, r) => a + r.suggested_copies, 0) }) : "" }),
    kpiTile({ label: t("insights.ai.kpi.weeding"), value: capped(weed, 50), format: String, className: "ins-kpi",
      href: canReports ? drill.insights("reports", { branch: tb.state.branch }, "weeding") : "", note: t("insights.ai.kpi.weeding_note") }),
  ]);
}

// ------------------------------------------------------------------ natural-language query lab

const FIELDS = ["keywords", "author", "language", "material_type", "audience", "year_from", "year_to", "available_only"];

function fieldValue(k, v) {
  if (k === "available_only") return t("insights.ai.nl.yes");
  if (k === "material_type") return t(`insights.ai.nl.material.${v}`, {}, String(v).replace(/_/g, " "));
  if (k === "audience") return t(`insights.ai.nl.audience.${v}`, {}, String(v).replace(/_/g, " "));
  if (k === "language" && /^[a-z]{2,3}$/i.test(v)) { try { return new Intl.DisplayNames([locale], { type: "language" }).of(v) || v; } catch { return v; } }
  if (k === "year_from" || k === "year_to") return String(v);
  return String(v);
}

function renderParsed(q, p) {
  const chips = FIELDS.filter((k) => p[k] !== null && p[k] !== undefined && p[k] !== "" && p[k] !== false)
    .map((k) => html`<span class="ins-parse-chip"><span class="k">${t(`insights.ai.nl.field.${k}`)}</span><strong>${fieldValue(k, p[k])}</strong></span>`);
  return html`<div class="ins-parse">
    <div class="ins-parse-chips">${icon("sparkle")}${chips.length ? chips : html`<span>${t("insights.ai.nl.no_fields")}</span>`}</div>
    ${p.interpretation?.length ? html`<p class="ins-parse-notes"><span class="muted">${t("insights.ai.nl.notes")}</span> ${formatList(p.interpretation)}</p>` : ""}
    <div class="ins-parse-foot">
      <span class="muted small">${p.engine === "claude" ? t("insights.ai.nl.parsed_claude") : t("insights.ai.nl.parsed_local")}</span>
      <span class="ins-parse-actions">
        <a class="btn sm" href="${drill.catalog(q)}">${icon("search")}${t("insights.ai.nl.staff_catalogue")}</a>
        <a class="btn sm primary" href="/search?${qs({ q, mode: "smart" })}" target="_blank" rel="noopener">${icon("external")}${t("insights.ai.nl.run_opac")}<span class="sr-only"> ${t("insights.ai.new_tab")}</span></a>
      </span>
    </div></div>`;
}

async function interpret(q, btn) {
  const out = $("#nl-result");
  out.innerHTML = '<div class="ins-skel ins-skel-parse" aria-hidden="true"></div>';
  try {
    const p = await withBusy(btn, () => api(`/ai/parse-query?${qs({ q })}`));
    out.innerHTML = renderParsed(q, p);
  } catch (e) {
    out.innerHTML = html`<div class="alert bad" role="alert">${icon("alert")}<div>${e.message}</div></div>`;
  }
}

// ------------------------------------------------------------------ loading & init

async function loadAll() {
  const seq = ++state.seq;
  refreshInsightLinks(page, tb.state);
  const where = tb.branchName();
  $$("#risk [data-sub], #weeding [data-sub]").forEach((el) => { el.dataset.base ||= el.textContent; el.textContent = `${el.dataset.base} · ${where}`; });
  const jobs = [
    loadRisk(seq),
    loadDups(seq),
    canAcq ? loadTable(demandTable, "/acquisitions/suggestions", seq) : Promise.resolve(null),
    loadTable(weedTable, `/reports/insights/weeding?${branchQ()}`, seq, (rows) => { weedTable._all = rows; showWeeding(1); }),
  ];
  const results = await Promise.allSettled(jobs);
  if (seq !== state.seq) return;
  renderKpis(results);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) toast(failed.reason.message, "error");
}

export default async function init() {
  tb = createToolbar({ onChange: loadAll });
  tb.setSnapshot(true);
  mountRisk();
  mountDemand();
  mountWeeding();
  if (!canAcq) demandTable.setError(new Error(t("insights.ai.demand.no_access")));

  api("/ai/status").then((s) => {
    const el = $("#ai-engine");
    $("[data-engine]", el).textContent = s.claude ? t("insights.ai.engine_claude") : t("insights.ai.engine_local");
    el.title = s.claude ? t("insights.ai.engine_hint_claude") : t("insights.ai.engine_hint_local");
  }).catch(() => {});

  $("#ask-copilot").addEventListener("click", () => openCopilot(t("insights.ai.copilot_question")));
  $("#ins-refresh").addEventListener("click", (e) => withBusy(e.currentTarget, loadAll));

  wireSegmented($("#risk-levels"), (level) => { state.level = level; showRisk(1); });
  page.addEventListener("click", (e) => {
    const both = e.target.closest("[data-open-both]");
    if (both) {
      const d = state.dups[Number(both.dataset.openBoth)];
      const first = window.open(drill.record(d.ids[0]), "_blank", "noopener");
      const second = window.open(drill.record(d.ids[1]), "_blank", "noopener");
      if (!first || !second) toast(t("insights.ai.dup.popup_blocked"), "warn");
      return;
    }
    if (e.target.closest("[data-dups-all]")) { state.showAllDups = !state.showAllDups; renderDups(); $("[data-dups-all]")?.focus(); return; }
    const k = e.target.closest('a[href="#risk"], a[href="#duplicates"]');
    if (k) {
      e.preventDefault();
      const target = $(k.getAttribute("href"));
      if (k.getAttribute("href") === "#risk" && state.level !== "high") $('#risk-levels [data-value="high"]').click();
      target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      target.focus({ preventScroll: true });
    }
  });

  const form = $("#nl-form"), input = $("#nl-q"), err = $("#nl-err");
  $$("[data-example]", form).forEach((b) => b.addEventListener("click", () => { input.value = b.dataset.example; form.requestSubmit(); }));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    err.hidden = !!q;
    if (q) input.removeAttribute("aria-invalid"); else input.setAttribute("aria-invalid", "true");
    if (!q) { input.focus(); return; }
    interpret(q, $('button[type="submit"]', form));
  });

  loadAll();
  tb.loadBranches().then(() => {
    const where = tb.branchName();
    $$("#risk [data-sub], #weeding [data-sub]").forEach((el) => { el.textContent = `${el.dataset.base} · ${where}`; });
  });
}
