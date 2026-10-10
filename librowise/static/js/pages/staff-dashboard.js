// Staff › Home (Today). Scannable at a glance: today's numbers with 14-day sparklines, desk tasks with counts
// that deep-link into the filtered page, alerts, the next items to pull, recent activity and late-return risk.
// The template lays everything out at its final size; this script only fills values (no layout shift).
// Refreshes every 60 s while the tab is visible; the branch choice is remembered.
import { $, BOOT, api, date, datetime, html, icon, num, qs, relative } from "/static/js/core.js";
import { barChart, hBarChart, sparkline } from "/static/js/charts.js";
import { locale, t } from "/static/js/i18n.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { statusPill } from "/static/js/ui/status.js";

const REFRESH_MS = 60_000;
const STORE = "sw-dash-branch";
const state = { branch: "", auto: true, timer: 0, last: 0, loading: false };
const pct = (v) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(v || 0);

function initialBranch(branches) {
  const p = new URLSearchParams(location.search).get("branch");
  let saved = null;
  try { saved = localStorage.getItem(STORE); } catch { /* ignore */ }
  const candidate = p ?? saved ?? String(BOOT.user?.home_branch_id ?? "");
  return candidate === "" || branches.some((b) => String(b.id) === candidate) ? candidate : "";
}

/** "+3 vs last Wednesday" style comparison, coloured by good/bad, with screen-reader words. */
function compare(now, then, label, { goodWhen = "up" } = {}) {
  if (then === undefined || then === null) return html`<span class="tk-cmp">${label}</span>`;
  const d = now - then;
  const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
  const tone = dir === "flat" ? "flat" : dir === goodWhen ? "good" : "bad";
  const n = new Intl.NumberFormat(locale, { signDisplay: "exceptZero" }).format(d);
  return html`<span class="tk-delta ${tone}"><span aria-hidden="true">${dir === "up" ? "▲" : dir === "down" ? "▼" : "■"}</span> ${d === 0 ? t("desk.today.same") : n}</span>
    <span class="tk-cmp">${label}</span>`;
}

function fillKpi(key, { value, note, spark, alert = false }) {
  const tile = $(`[data-kpi="${key}"]`);
  if (!tile) return;
  $(".tk-value", tile).textContent = num(value);
  $(".tk-spark", tile).innerHTML = spark ? sparkline(spark, { width: 96, height: 30 }) : "";
  $(".tk-note", tile).innerHTML = note || "&nbsp;";
  tile.classList.toggle("is-alert", alert);
}

function renderKpis(d) {
  const k = d.kpis, desk = d.desk;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date());
  const lastWeek = t("desk.today.vs_last", { weekday });
  fillKpi("checkouts", { value: desk.checkouts_today, spark: k.checkouts_7d.spark,
    note: compare(desk.checkouts_today, desk.checkouts_same_day_last_week, lastWeek) });
  fillKpi("checkins", { value: desk.checkins_today, spark: k.returns_7d.spark,
    note: compare(desk.checkins_today, desk.checkins_same_day_last_week, lastWeek) });
  fillKpi("on_loan", { value: k.open_loans.value, alert: k.overdue.rate >= 0.15,
    note: k.overdue.value ? html`<span class="tk-delta bad">${t("desk.today.overdue_n", { count: k.overdue.value, rate: pct(k.overdue.rate) })}</span>`
      : html`<span class="tk-delta good">${t("desk.today.none_overdue")}</span>` });
  fillKpi("holds", { value: k.holds_queued.value, note: html`<span class="tk-cmp">${t("desk.today.on_shelf_n", { count: k.holds_queued.ready })}</span>` });
  fillKpi("active", { value: k.active_patrons_7d.value, note: compare(k.active_patrons_7d.value, k.active_patrons_7d.previous, t("dash.vs_prev_week")) });
  fillKpi("new_patrons", { value: k.new_patrons_30d.value, note: compare(k.new_patrons_30d.value, k.new_patrons_30d.previous, t("dash.vs_prev_30")) });
  $("#kpis").removeAttribute("aria-busy");
}

function renderTasks(tasks) {
  for (const task of tasks) {
    const a = $(`[data-task="${task.id}"]`);
    if (!a) continue;
    const c = $("[data-count]", a);
    c.textContent = num(task.count);
    a.dataset.tone = task.count ? task.tone : "neutral";
  }
}

const ALERT_ICON = { overdue_spike: "trend", budget: "wallet", holds_ratio: "bookmark", failed_notices: "send" };
function renderAlerts(alerts) {
  const count = $("#alerts-count");
  count.textContent = alerts.length ? num(alerts.length) : "";
  count.className = `badge ${alerts.length ? "warn" : ""}`;
  $("#alerts").innerHTML = alerts.length ? html`<ul class="today-alert-list">${alerts.map((a) => html`<li class="today-alert tone-${a.level}">
      <span class="ta-icon" aria-hidden="true">${icon(ALERT_ICON[a.kind] || "alert")}</span>
      <div class="grow"><strong>${t(`dash.alert_${a.kind}`, {}, "")}</strong><div class="small">${t(`dash.alert_msg_${a.kind}`, a.params || {}, a.message)}</div></div>
      ${a.href ? html`<a class="btn sm" href="${a.href}">${t("dash.review")}</a>` : ""}</li>`)}</ul>`
    : emptyState({ art: "done", compact: true, title: t("desk.today.all_clear"), body: t("dash.no_alerts") });
}

function renderPull(desk) {
  const el = $("#pull");
  if (!el) return;
  const rows = desk.holds_to_pull_sample.slice(0, 5);
  el.innerHTML = rows.length ? html`<ul class="today-rows">${rows.map((r) => html`<li>
      <span class="mono tr-call">${r.call_number || r.barcode}</span>
      <span class="grow"><strong>${r.title}</strong><span class="small muted">${t("desk.today.for_at", { name: r.patron, branch: r.pickup })}</span></span></li>`)}</ul>
    ${desk.holds_to_pull > rows.length ? html`<p class="small today-more"><a href="/staff/holds#pull">${t("desk.today.more_to_pull", { count: desk.holds_to_pull - rows.length })}</a></p>` : ""}`
    : emptyState({ art: "done", compact: true, title: t("dash.nothing_to_pull") });
}

function renderRecent(rows) {
  $("#recent").innerHTML = rows.length ? html`<ul class="today-rows">${rows.slice(0, 7).map((l) => html`<li>
      <span class="tr-event ${l.returned_at ? "in" : "out"}" aria-hidden="true">${icon(l.returned_at ? "arrow-down" : "arrow-up")}</span>
      <span class="grow"><a href="/staff/catalog/${l.item.biblio.id}"><strong>${l.item.biblio.title}</strong></a>
        <span class="small muted">${l.returned_at ? t("desk.today.ev_returned") : t("desk.today.ev_borrowed")}${l.patron ? html` · <a href="/staff/patrons/${l.patron.id}">${l.patron.full_name}</a>` : html` · ${t("dash.anonymised")}`}</span></span>
      ${!l.returned_at && l.overdue ? statusPill("loan", "overdue") : ""}
      <time class="small muted nowrap" datetime="${l.returned_at || l.issued_at}" title="${datetime(l.returned_at || l.issued_at)}">${relative(l.returned_at || l.issued_at)}</time></li>`)}</ul>`
    : emptyState({ art: "inbox", compact: true, title: t("dash.no_activity") });
}

async function refresh({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const branchQ = state.branch ? { branch_id: state.branch } : {};
  try {
    const [d, tasks, recent, top] = await Promise.all([
      api(`/analytics/dashboard?${qs(branchQ)}`),
      api(`/circulation/today?${qs(branchQ)}`).catch(() => ({ tasks: [] })),
      api("/circulation/recent?limit=7").catch(() => ({ results: [] })),
      api(`/analytics/top?${qs(branchQ)}`).catch(() => null),
    ]);
    renderKpis(d);
    renderTasks(tasks.tasks);
    renderAlerts(d.alerts);
    renderPull(d.desk);
    const hours = d.hourly_today;
    const total = hours.reduce((a, b) => a + b, 0);
    $("#hourly-total").textContent = t("dash.checkouts_count", { count: total });
    const first = Math.min(8, ...hours.map((v, i) => (v ? i : 24)));
    const last = Math.max(20, ...hours.map((v, i) => (v ? i : 0)));
    const span = hours.slice(first, last + 1);
    const fmtHour = new Intl.DateTimeFormat(locale, { hour: "numeric" });
    barChart($("#hourly"), { labels: span.map((_, i) => fmtHour.format(new Date(2024, 0, 1, first + i))), height: 170,
      series: [{ name: t("dash.kpi_checkouts_short"), values: span }], summary: t("dash.hourly_summary", { count: total }) });
    const topEl = $("#top");
    if (top?.titles?.length) {
      hBarChart(topEl, { items: top.titles.slice(0, 5).map((r) => ({ label: r.label, value: r.value, href: `/staff/catalog/${r.id}` })),
        valueLabel: t("dash.loans"), summary: t("dash.top_title") });
    } else topEl.innerHTML = emptyState({ art: "books", compact: true, title: t("dash.no_loans_month") });
    renderRecent(recent.results);
    state.last = Date.now();
    $("#dash-updated").textContent = t("dash.updated", { time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date()) });
  } catch (e) {
    $("#dash-updated").textContent = t("dash.update_failed");
    if (!quiet && !state.last) $("#alerts").innerHTML = errorState(e, { retry: false });
  } finally {
    state.loading = false;
  }
}

async function loadRisk() {
  try {
    const d = await api("/reports/dashboard");
    $("#risk").innerHTML = d.risk.length ? html`<ul class="today-rows">${d.risk.slice(0, 5).map((r) => html`<li>
      <span class="grow"><strong>${r.title}</strong><span class="small muted"><a href="/staff/patrons/${r.patron_id}">${r.patron}</a> · ${t("dash.due", { date: date(r.due_at) })}</span></span>
      ${statusPill("loan", r.level === "high" ? "overdue" : r.level === "medium" ? "due_soon" : "active", t("desk.today.risk", { pct: pct(r.risk) }))}</li>`)}</ul>`
      : emptyState({ art: "done", compact: true, title: t("dash.no_risk") });
  } catch (e) {
    $("#risk").innerHTML = errorState(e, { retry: false });
  }
}

function schedule() {
  clearInterval(state.timer);
  if (state.auto) state.timer = setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, REFRESH_MS);
}

function setAuto(on) {
  state.auto = on;
  const b = $("#dash-auto");
  b.setAttribute("aria-pressed", String(on));
  $("[data-label]", b).textContent = on ? t("dash.auto_refresh_on") : t("dash.auto_refresh_off");
  schedule();
}

export default async function init() {
  $("#today-date").textContent = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  let branches = [];
  try { branches = (await api("/lookups")).branches; } catch { /* "All branches" still works */ }
  const sel = $("#dash-branch");
  sel.insertAdjacentHTML("beforeend", html`${branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}`);
  state.branch = initialBranch(branches);
  sel.value = state.branch;
  sel.addEventListener("change", () => {
    state.branch = sel.value;
    try { localStorage.setItem(STORE, state.branch); } catch { /* ignore */ }
    history.replaceState(null, "", state.branch ? `?${qs({ branch: state.branch })}` : location.pathname);
    refresh();
  });
  $("#dash-auto").addEventListener("click", () => setAuto(!state.auto));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.auto && Date.now() - state.last > REFRESH_MS) refresh({ quiet: true });
  });
  refresh();
  loadRisk();
  schedule();
  const health = $("#sys-health");
  if (health) import("/static/js/pages/lib/system-health.js").then((m) => m.renderSystemHealth(health)).catch(() => {});
}
