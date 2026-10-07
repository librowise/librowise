// Staff: reports — live dashboard plus vetted, parameterised reports with CSV export.
import { $, $$, api, barChart, date, empty, hbars, html, icon, money, num, qs, raw, skeleton, toast } from "/static/js/core.js";

// Reports whose query is bounded by the "days" window (the others are point-in-time snapshots).
const DATED = new Set(["circulation_by_branch", "circulation_by_category", "top_titles"]);
const DAY_OPTIONS = [7, 30, 90, 365];
const state = { reports: [], key: null, days: 30, seq: 0 };

const errorBox = (msg) => html`<div class="alert bad" role="alert">${icon("alert")}<div>${msg}</div></div>`;
const isoDay = (d) => d.toISOString().slice(0, 10);

// ------------------------------------------------------------------ dashboard

const stat = (label, value, { delta = "", alert = false } = {}) =>
  html`<div class="card stat ${alert ? "alert" : ""}"><span class="label">${label}</span><span class="value">${value}</span>
    ${delta ? html`<span class="delta">${delta}</span>` : ""}</div>`;

/** Fill in the days with no checkouts so the chart shows a true 30-day timeline. */
function trendSeries(trend, days = 30) {
  const counts = new Map(trend.map((t) => [t.date, t.count]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    out.push({ key: isoDay(d), count: counts.get(isoDay(d)) || 0 });
  }
  return out;
}

function renderDashboard(d) {
  const s = d.stats;
  const series = trendSeries(d.trend || []);
  const total = series.reduce((a, x) => a + x.count, 0);
  const labels = series.map((x) => date(`${x.key}T00:00:00`, { day: "numeric", month: "short" }));
  return html`
    <div class="grid cols-4" style="margin-bottom:var(--gap)">
      ${stat("Titles", num(s.titles))}
      ${stat("Items", num(s.items), { delta: `${num(s.items_by_status?.available || 0)} available` })}
      ${stat("Patrons", num(s.patrons))}
      ${stat("Open loans", num(s.loans_open), { delta: `${num(s.loans_today)} issued today` })}
      ${stat("Overdue", num(s.loans_overdue), { alert: s.loans_overdue > 0, delta: s.loans_overdue ? html`<a href="#overdues" data-run="overdues">View overdue report</a>` : "All loans on time" })}
      ${stat("Holds queued", num(s.holds_queued), { delta: `${num(s.holds_ready)} ready for pickup` })}
      ${stat("Outstanding fines", money(s.fines_outstanding), { alert: s.fines_outstanding > 0 })}
      ${stat("Checkouts (30 days)", num(total), { delta: `≈ ${(total / 30).toFixed(1)} per day` })}
    </div>
    <div class="grid cols-2" style="margin-bottom:var(--gap)">
      <section class="card" aria-labelledby="trend-h">
        <div class="card-head"><h3 id="trend-h">Checkouts — last 30 days</h3><span class="small muted">${num(total)} total</span></div>
        <div class="card-body">${total ? barChart(series.map((x) => x.count), { labels, format: (v) => `${v} checkout${v === 1 ? "" : "s"}` }) : empty("No checkouts in the last 30 days.", "chart")}</div>
      </section>
      <section class="card" aria-labelledby="top-h">
        <div class="card-head"><h3 id="top-h">Most borrowed — 30 days</h3><a class="small" href="#top_titles" data-run="top_titles">Full report</a></div>
        <div class="card-body">${d.top_titles?.length ? html`<ol class="stack tight" style="margin:0;padding-left:1.3rem">${d.top_titles.map((t) =>
          html`<li><div class="row between" style="flex-wrap:nowrap"><span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${t.title}">${t.title}</span>
            <span class="badge">${num(t.loans)} loan${t.loans === 1 ? "" : "s"}</span></div></li>`)}</ol>` : empty("No loans yet.", "book")}</div>
      </section>
    </div>
    <div class="grid cols-2">
      <section class="card" aria-labelledby="branch-h">
        <div class="card-head"><h3 id="branch-h">Checkouts by branch — 30 days</h3></div>
        <div class="card-body">${d.by_branch?.length ? hbars([...d.by_branch].sort((a, b) => b.value - a.value)) : empty("No checkouts in this period.", "map")}</div>
      </section>
      <section class="card" aria-labelledby="mat-h">
        <div class="card-head"><h3 id="mat-h">Collection by material type</h3></div>
        <div class="card-body">${d.by_material?.length ? hbars([...d.by_material].sort((a, b) => b.value - a.value)
          .map((m) => ({ ...m, label: m.label ? m.label[0].toUpperCase() + m.label.slice(1) : "Unspecified" }))) : empty("No titles catalogued.", "book")}</div>
      </section>
    </div>`;
}

async function loadDashboard() {
  const box = $("#rep-dashboard");
  box.innerHTML = html`<div class="grid cols-4">${Array.from({ length: 4 }, () => html`<div class="card pad">${skeletonHtml(2)}</div>`)}</div>`;
  try {
    box.innerHTML = renderDashboard(await api("/reports/dashboard"));
  } catch (e) {
    box.innerHTML = errorBox(e.message);
    toast(e.message, "error");
  }
}
const skeletonHtml = (n) => html`${raw(skeleton(n))}`;

// ------------------------------------------------------------------ report list & runner

function renderList() {
  $("#rep-list").innerHTML = html`<div class="facet"><h4 id="rep-list-h">Reports</h4>
    <div class="stack tight" role="group" aria-labelledby="rep-list-h">${state.reports.map((r) => html`
      <button type="button" data-report="${r.key}" aria-pressed="${r.key === state.key}">
        <span>${r.name}</span>${DATED.has(r.key) ? "" : html`<span class="n" title="Point-in-time snapshot">${icon("clock")}</span>`}</button>`)}</div></div>
    <p class="tiny muted" style="margin:.75rem 0 0">Every report is a vetted query — no free-form SQL ever reaches the database.</p>`;
}

const cell = (v) => {
  if (typeof v === "number") return html`<td class="num">${num(v)}</td>`;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return html`<td class="nowrap">${date(v)}</td>`;
  return html`<td>${v ?? "—"}</td>`;
};

function renderOutput(data) {
  const dated = DATED.has(state.key);
  const csv = `/api/v1/reports/run/${encodeURIComponent(state.key)}?${qs({ days: state.days, fmt: "csv" })}`;
  const numericCols = data.headers.map((_, i) => data.rows.length > 0 && data.rows.every((r) => typeof r[i] === "number"));
  return html`<div class="card-head" style="padding-bottom:var(--pad);flex-wrap:wrap">
      <div><h2>${data.name}</h2><div class="small muted">${num(data.rows.length)} row${data.rows.length === 1 ? "" : "s"}${dated ? ` · last ${state.days} days` : " · current snapshot"}</div></div>
      <div class="row tight">
        <label for="rep-days" class="sr-only">Period</label>
        <select id="rep-days" style="width:auto" ${dated ? "" : "disabled"} title="${dated ? "Reporting period" : "This report is a current snapshot"}">
          ${DAY_OPTIONS.map((d) => html`<option value="${d}" ${d === state.days ? "selected" : ""}>Last ${d} days</option>`)}</select>
        <a class="btn" href="${csv}" download>${icon("download")}Download CSV</a>
      </div></div>
    ${data.rows.length ? html`<div class="table-wrap" style="max-height:70vh" tabindex="0" role="region" aria-label="${data.name}"><table class="table">
      <caption class="sr-only">${data.name}</caption>
      <thead><tr>${data.headers.map((h, i) => html`<th scope="col" class="${numericCols[i] ? "num" : ""}">${h}</th>`)}</tr></thead>
      <tbody>${data.rows.map((r) => html`<tr>${r.map(cell)}</tr>`)}</tbody></table></div>`
      : empty("This report has no rows for the selected period.", "inbox")}`;
}

async function runReport(key) {
  if (!state.reports.some((r) => r.key === key)) return;
  state.key = key;
  history.replaceState(null, "", `#${key}`);
  $$("#rep-list [data-report]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.report === key));
  const out = $("#rep-output");
  const seq = ++state.seq;
  out.innerHTML = html`<div class="card-body">${skeletonHtml(8)}</div>`;
  try {
    const data = await api(`/reports/run/${encodeURIComponent(key)}?${qs({ days: state.days })}`);
    if (seq !== state.seq) return;
    out.innerHTML = renderOutput(data);
  } catch (e) {
    if (seq !== state.seq) return;
    out.innerHTML = html`<div class="card-body">${errorBox(e.message)}</div>`;
    toast(e.message, "error");
  }
}

// ------------------------------------------------------------------ init

export default async function init() {
  $("#rep-list").addEventListener("click", (e) => { const b = e.target.closest("[data-report]"); if (b) runReport(b.dataset.report); });
  $("#rep-dashboard").addEventListener("click", (e) => {
    const a = e.target.closest("[data-run]");
    if (!a) return;
    e.preventDefault();
    runReport(a.dataset.run);
    $("#rep-output").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#rep-output").addEventListener("change", (e) => {
    if (e.target.id !== "rep-days") return;
    state.days = Number(e.target.value);
    runReport(state.key);
  });
  $("#reports-refresh").addEventListener("click", () => { loadDashboard(); if (state.key) runReport(state.key); });

  loadDashboard();
  $("#rep-list").innerHTML = skeleton(7);
  $("#rep-output").innerHTML = html`<div class="card-body">${skeletonHtml(6)}</div>`;
  try {
    state.reports = (await api("/reports")).results;
  } catch (e) {
    $("#rep-list").innerHTML = errorBox(e.message);
    $("#rep-output").innerHTML = "";
    toast(e.message, "error");
    return;
  }
  const initial = location.hash.slice(1);
  state.key = state.reports.some((r) => r.key === initial) ? initial : state.reports[0]?.key;
  renderList();
  if (state.key) runReport(state.key);
  else $("#rep-output").innerHTML = empty("No reports are available.", "chart");
}
