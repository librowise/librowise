// Staff: AI insights — overdue risk, duplicates, weeding, purchase demand and a natural-language query lab.
import {
  $, api, badge, date, datetime, empty, html, icon, num, openCopilot, qs, skeleton, toast, withBusy,
} from "/static/js/core.js";

const RISK_LIMIT = 15;
const LEVELS = ["high", "medium", "low"];
const COPILOT_QUESTION = "Which loans are at risk of being returned late, and what should we do about them?";
const EXAMPLES = [
  "space books for kids published after 2010",
  "mystery novels by Agatha Christie available now",
  "audiobooks in Hindi",
  "young adult fantasy",
];
const state = { risk: [], level: "", showAll: false };

const errorBox = (msg) => html`<div class="alert bad" role="alert">${icon("alert")}<div>${msg}</div></div>`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const pct = (v) => Math.round(Number(v || 0) * 100);

/** Load one section: skeleton, fetch, render, or an inline error. */
async function section(sel, path, render) {
  const box = $(sel);
  box.innerHTML = skeleton(4);
  try {
    const { results } = await api(path);
    box.innerHTML = render(results);
    return results;
  } catch (e) {
    box.innerHTML = errorBox(e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ overdue risk

function factorText(f) {
  const parts = [
    `${pct(f.historical_late_rate)}% historical late rate`,
    `${f.renewals} renewal${f.renewals === 1 ? "" : "s"}`,
    `${f.currently_overdue} overdue now`,
    `${f.days_left} day${f.days_left === 1 ? "" : "s"} left`,
  ];
  return parts.join(" · ");
}

function renderRiskFilter() {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, state.risk.filter((r) => r.level === l).length]));
  $("#risk-filter").innerHTML = html`
    <button type="button" class="chip" data-level="" aria-pressed="${!state.level}">All ${num(state.risk.length)}</button>
    ${LEVELS.map((l) => html`<button type="button" class="chip" data-level="${l}" aria-pressed="${state.level === l}">${cap(l)} ${num(counts[l])}</button>`)}`;
}

function renderRisk() {
  renderRiskFilter();
  const rows = state.risk.filter((r) => !state.level || r.level === state.level);
  if (!state.risk.length) return empty("No open loans to score — nothing is currently on loan and not yet due.", "check");
  if (!rows.length) return empty(`No ${state.level}-risk loans.`, "check");
  const shown = state.showAll ? rows : rows.slice(0, RISK_LIMIT);
  return html`<div class="table-wrap"><table class="table">
    <caption class="sr-only">Open loans ranked by late-return risk</caption>
    <thead><tr><th scope="col">Level</th><th scope="col" class="num">Risk</th><th scope="col" style="min-width:8rem"><span class="sr-only">Risk meter</span></th>
      <th scope="col">Title</th><th scope="col">Patron</th><th scope="col">Due</th></tr></thead>
    <tbody>${shown.map((r) => html`<tr>
      <td>${badge(r.level, cap(r.level))}</td>
      <td class="num"><strong>${pct(r.risk)}%</strong></td>
      <td><div class="meter ${r.level === "high" ? "bad" : r.level === "medium" ? "warn" : ""}" role="progressbar"
        aria-label="Late-return risk" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct(r.risk)}"><div style="width:${pct(r.risk)}%"></div></div>
        <div class="tiny muted" style="margin-top:.3rem">${factorText(r.factors)}</div></td>
      <td>${r.title}<div class="tiny muted mono">${r.barcode}</div></td>
      <td>${r.patron_id ? html`<a href="/staff/patrons/${r.patron_id}">${r.patron}</a>` : html`<span class="muted">—</span>`}</td>
      <td class="nowrap" title="${datetime(r.due_at)}">${date(r.due_at)}</td></tr>`)}</tbody></table></div>
    <div class="row between" style="margin-top:.75rem">
      <span class="tiny muted">Logistic model; the patron's late rate uses a Bayesian prior so new borrowers aren't penalised.</span>
      ${rows.length > RISK_LIMIT ? html`<button type="button" class="btn sm" data-risk-all>${state.showAll ? "Show fewer" : `Show all ${num(rows.length)}`}</button>` : ""}
    </div>`;
}

async function loadRisk() {
  const box = $("#ins-risk");
  box.innerHTML = skeleton(6);
  try {
    state.risk = (await api("/reports/insights/risk")).results;
    box.innerHTML = renderRisk();
  } catch (e) {
    box.innerHTML = errorBox(e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ other sections

const renderDuplicates = (rows) => (!rows.length ? empty("No likely duplicates", "check") : html`<div class="stack tight">${rows.map((d) => html`
  <div class="kv" style="align-items:flex-start;gap:1rem">
    <div class="grow stack tight">
      ${d.ids.map((id, i) => html`<a href="/staff/catalog/${id}">${d.titles[i] || `Record #${id}`} <span class="tiny muted">#${id}</span></a>`)}
      <span class="tiny muted">${d.reason}</span>
    </div>
    ${badge(d.score >= 98 ? "bad" : "warn", `${d.score}% match`)}
  </div>`)}</div>`);

const renderWeeding = (rows) => (!rows.length ? empty("No weeding candidates — every shelved item has circulated in the last two years.", "check") : html`
  <div class="table-wrap"><table class="table">
    <caption class="sr-only">Items idle for two or more years</caption>
    <thead><tr><th scope="col">Barcode</th><th scope="col">Title</th><th scope="col">Last borrowed</th><th scope="col" class="num">Times borrowed</th></tr></thead>
    <tbody>${rows.map((w) => html`<tr><td class="mono">${w.barcode}</td><td>${w.title}</td>
      <td>${w.last_borrowed ? date(w.last_borrowed) : badge("", "Never")}</td><td class="num">${num(w.times_borrowed)}</td></tr>`)}</tbody></table></div>
  <p class="tiny muted" style="margin:.75rem 0 0">CREW-style rule: available items held 2+ years that haven't been borrowed in 2 years. Review before withdrawing.</p>`);

const renderDemand = (rows) => (!rows.length ? empty("Hold queues are in balance with copies.", "check") : html`
  <div class="table-wrap"><table class="table">
    <caption class="sr-only">Titles whose holds outstrip copies</caption>
    <thead><tr><th scope="col">Title</th><th scope="col" class="num">Holds</th><th scope="col" class="num">Copies</th><th scope="col" class="num">Ratio</th><th scope="col" class="num">Buy</th></tr></thead>
    <tbody>${rows.map((s) => html`<tr><td><a href="/staff/catalog/${s.biblio_id}">${s.title}</a></td>
      <td class="num">${num(s.holds)}</td><td class="num">${num(s.copies)}</td>
      <td class="num">${badge(s.ratio >= 4 ? "bad" : "warn", `${s.ratio}×`)}</td><td class="num"><strong>+${num(s.suggested_copies)}</strong></td></tr>`)}</tbody></table></div>`);

// ------------------------------------------------------------------ natural-language query lab

const FIELD_LABELS = {
  keywords: "Keywords", author: "Author", language: "Language", material_type: "Material", audience: "Audience",
  year_from: "From year", year_to: "To year", available_only: "Available only",
};

function renderParsed(q, p) {
  const chips = Object.entries(FIELD_LABELS)
    .filter(([k]) => p[k] !== null && p[k] !== undefined && p[k] !== "" && p[k] !== false)
    .map(([k, label]) => html`<span class="chip"><span class="muted">${label}:</span> <strong>${p[k] === true ? "yes" : String(p[k]).replace(/_/g, " ")}</strong></span>`);
  return html`<div class="stack tight">
    <div class="interpretation" style="margin:0">${icon("sparkle")}
      ${chips.length ? chips : html`<span>No structured fields detected — the whole query is used for ranking.</span>`}</div>
    ${p.interpretation?.length ? html`<ul class="small" style="margin:0;padding-left:1.2rem">${p.interpretation.map((t) => html`<li>${t}</li>`)}</ul>` : ""}
    <div class="row between">
      <span class="tiny muted">Parsed by ${p.engine === "claude" ? "Claude" : "the local parser"}</span>
      <a class="btn sm primary" href="/search?${qs({ q, mode: "smart" })}" target="_blank" rel="noopener">${icon("search")}Run in catalogue</a>
    </div></div>`;
}

async function interpret(q, btn) {
  const out = $("#nl-result");
  out.innerHTML = skeleton(2);
  try {
    const p = await withBusy(btn, () => api(`/ai/parse-query?${qs({ q })}`));
    out.innerHTML = renderParsed(q, p);
  } catch (e) {
    out.innerHTML = errorBox(e.message);
  }
}

// ------------------------------------------------------------------ init

async function loadAll() {
  const jobs = [
    loadRisk(),
    section("#ins-dups", "/reports/insights/duplicates", renderDuplicates),
    section("#ins-weeding", "/reports/insights/weeding", renderWeeding),
    section("#ins-demand", "/acquisitions/suggestions", renderDemand),
  ];
  const failed = (await Promise.allSettled(jobs)).find((r) => r.status === "rejected");
  if (failed) toast(failed.reason.message, "error");
}

export default async function init() {
  api("/ai/status")
    .then((s) => { $("#ai-engine").innerHTML = badge("ai", s.claude ? "Claude" : "Local AI"); $("#ai-engine").title = s.claude ? "Insights narrated by Claude" : "Running on the built-in local models"; })
    .catch(() => {});

  $("#ask-copilot").addEventListener("click", () => openCopilot(COPILOT_QUESTION));
  $("#insights-refresh").addEventListener("click", (e) => withBusy(e.currentTarget, loadAll).catch(() => {}));

  $("#risk-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-level]");
    if (!b) return;
    state.level = b.dataset.level;
    state.showAll = false;
    $("#ins-risk").innerHTML = renderRisk();
  });
  $("#ins-risk").addEventListener("click", (e) => {
    if (!e.target.closest("[data-risk-all]")) return;
    state.showAll = !state.showAll;
    $("#ins-risk").innerHTML = renderRisk();
  });

  const form = $("#nl-form"), input = $("#nl-q");
  $("#nl-examples").innerHTML = html`<span class="tiny muted">Try:</span>${EXAMPLES.map((x) => html`<button type="button" class="chip" data-example="${x}">${x}</button>`)}`;
  $("#nl-examples").addEventListener("click", (e) => {
    const b = e.target.closest("[data-example]");
    if (!b) return;
    input.value = b.dataset.example;
    form.requestSubmit();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) interpret(q, $('button[type="submit"]', form));
  });

  await loadAll();
}
