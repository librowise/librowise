// Staff dashboard: branch-aware KPIs with sparklines and deltas, today's desk work, alerts and recent
// activity. Refreshes every 60 s while the tab is visible.
import { $, BOOT, api, badge, date, datetime, empty, html, icon, num, qs, relative, toast } from "/static/js/core.js";
import { barChart, hBarChart, kpiTile } from "/static/js/charts.js";
import { t } from "/static/js/i18n.js";

const REFRESH_MS = 60_000;
const STORE = "sw-dash-branch";
const state = { branch: "", auto: true, timer: 0, last: 0, loading: false };

function initialBranch(branches) {
  const p = new URLSearchParams(location.search).get("branch");
  let saved = null;
  try { saved = localStorage.getItem(STORE); } catch { /* ignore */ }
  const candidate = p ?? saved ?? String(BOOT.user?.home_branch_id ?? "");
  return candidate === "" || branches.some((b) => String(b.id) === candidate) ? candidate : "";
}

const pctText = (v) => `${Math.round((v || 0) * 100)}%`;

function renderKpis(k) {
  const branchQ = state.branch ? `?${qs({ branch: state.branch })}` : "";
  return html`
    ${kpiTile({ label: t("dash.kpi_checkouts"), value: k.checkouts_7d.value, previous: k.checkouts_7d.previous, spark: k.checkouts_7d.spark,
      href: `/staff/analytics${branchQ}`, compareLabel: t("dash.vs_prev_week") })}
    ${kpiTile({ label: t("dash.kpi_returns"), value: k.returns_7d.value, previous: k.returns_7d.previous, spark: k.returns_7d.spark,
      href: `/staff/analytics${branchQ}`, compareLabel: t("dash.vs_prev_week") })}
    ${kpiTile({ label: t("dash.kpi_on_loan"), value: k.open_loans.value, href: "/staff/circulation",
      note: t("dash.kpi_overdue_note", { count: k.overdue.value, rate: pctText(k.overdue.rate) }), alert: k.overdue.rate >= 0.15 })}
    ${kpiTile({ label: t("dash.kpi_holds"), value: k.holds_queued.value, href: "/staff/holds", note: t("dash.kpi_holds_note", { count: k.holds_queued.ready }) })}
    ${kpiTile({ label: t("dash.kpi_active"), value: k.active_patrons_7d.value, previous: k.active_patrons_7d.previous, compareLabel: t("dash.vs_prev_week") })}
    ${kpiTile({ label: t("dash.kpi_new_patrons"), value: k.new_patrons_30d.value, previous: k.new_patrons_30d.previous, href: "/staff/patrons",
      compareLabel: t("dash.vs_prev_30") })}`;
}

function vsLastWeek(now, then) {
  if (!then && !now) return "";
  const d = now - then;
  return t("dash.same_day_last_week", { count: then, diff: `${d > 0 ? "+" : ""}${d}` });
}

function renderDesk(d) {
  const list = (items, row, emptyMsg) => (items.length ? html`<ul class="desk-list">${items.map(row)}</ul>` : html`<p class="small muted">${emptyMsg}</p>`);
  return html`<div class="desk-stats">
      <div class="desk-stat"><span class="value">${num(d.checkouts_today)}</span><span class="label">${t("dash.checkouts_today")}</span><span class="tiny muted">${vsLastWeek(d.checkouts_today, d.checkouts_same_day_last_week)}</span></div>
      <div class="desk-stat"><span class="value">${num(d.checkins_today)}</span><span class="label">${t("dash.checkins_today")}</span><span class="tiny muted">${vsLastWeek(d.checkins_today, d.checkins_same_day_last_week)}</span></div>
      <a class="desk-stat ${d.holds_to_pull ? "attn" : ""}" href="/staff/holds#pull"><span class="value">${num(d.holds_to_pull)}</span><span class="label">${t("dash.holds_to_pull")}</span></a>
      <a class="desk-stat" href="/staff/holds"><span class="value">${num(d.holds_ready)}</span><span class="label">${t("dash.holds_ready")}</span></a>
      <div class="desk-stat ${d.in_transit_stale ? "warn" : ""}"><span class="value">${num(d.in_transit_stale)}</span><span class="label">${t("dash.in_transit")}</span></div>
    </div>
    <div class="desk-lists">
      <div><h3 class="an-block-title">${t("dash.pull_list")}</h3>${list(d.holds_to_pull_sample, (r) => html`<li>
        <span class="grow"><strong>${r.title}</strong><span class="tiny muted"> · ${r.patron} → ${r.pickup}</span></span>
        <span class="mono small">${r.call_number || r.barcode}</span></li>`, t("dash.nothing_to_pull"))}</div>
      <div><h3 class="an-block-title">${t("dash.expiring")}</h3>${list(d.holds_expiring, (h) => html`<li>
        <span class="grow"><strong>${h.title}</strong><span class="tiny muted"> · <a href="/staff/patrons/${h.patron_id}">${h.patron}</a></span></span>
        ${badge("warn", t("dash.expires", { when: relative(h.expires_at) }))}</li>`, t("dash.none_expiring"))}</div>
      ${d.in_transit_sample.length ? html`<div><h3 class="an-block-title">${t("dash.transit_list")}</h3>${list(d.in_transit_sample, (i) => html`<li>
        <span class="grow"><strong>${i.title}</strong><span class="tiny muted"> · ${i.home}</span></span>
        <span class="mono small">${i.barcode}</span><span class="tiny muted">${date(i.since)}</span></li>`, "")}</div>` : ""}
    </div>`;
}

const ALERT_ICON = { overdue_spike: "alert", budget: "wallet", holds_ratio: "bookmark", failed_notices: "bell" };
function renderAlerts(alerts) {
  $("#alerts-count").textContent = alerts.length ? num(alerts.length) : "";
  $("#alerts-count").className = `badge ${alerts.length ? "warn" : ""}`;
  if (!alerts.length) return html`<div class="alert ok">${icon("check")}<div>${t("dash.no_alerts")}</div></div>`;
  return html`<ul class="alert-list">${alerts.map((a) => html`<li class="alert ${a.level}">${icon(ALERT_ICON[a.kind] || "info")}
    <div class="grow"><strong>${t(`dash.alert_${a.kind}`, {}, "")}</strong><div>${t(`dash.alert_msg_${a.kind}`, a.params || {}, a.message)}</div></div>
    ${a.href ? html`<a class="btn sm" href="${a.href}">${t("dash.review")}</a>` : ""}</li>`)}</ul>`;
}

async function refresh({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const branchParam = state.branch ? `?${qs({ branch_id: state.branch })}` : "";
  try {
    const [d, recent, top] = await Promise.all([
      api(`/analytics/dashboard${branchParam}`),
      api("/circulation/recent?limit=10").catch(() => ({ results: [] })),
      api(`/analytics/top?${qs({ branch_id: state.branch || undefined })}`).catch(() => null),
    ]);
    $("#kpis").innerHTML = renderKpis(d.kpis);
    $("#kpis").removeAttribute("aria-busy");
    $("#desk").innerHTML = renderDesk(d.desk);
    $("#alerts").innerHTML = renderAlerts(d.alerts);
    const hours = d.hourly_today;
    const total = hours.reduce((a, b) => a + b, 0);
    $("#hourly-total").textContent = t("dash.checkouts_count", { count: total });
    const firstHour = Math.min(8, ...hours.map((v, i) => (v ? i : 24)));
    const lastHour = Math.max(20, ...hours.map((v, i) => (v ? i : 0)));
    const span = hours.slice(firstHour, lastHour + 1);
    barChart($("#hourly"), { labels: span.map((_, i) => `${String(firstHour + i).padStart(2, "0")}:00`), height: 170,
      series: [{ name: t("dash.kpi_checkouts_short"), values: span }], summary: t("dash.hourly_summary", { count: total }) });
    if (top?.titles?.length) {
      hBarChart($("#top"), { items: top.titles.slice(0, 6).map((r) => ({ label: r.label, value: r.value, href: `/staff/catalog/${r.id}` })),
        valueLabel: t("dash.loans"), summary: t("dash.top_title") });
    } else $("#top").innerHTML = empty(t("dash.no_loans_month"), "book");
    $("#recent").innerHTML = recent.results.length ? html`<div class="table-wrap"><table class="table">
      <caption class="sr-only">${t("dash.recent_title")}</caption>
      <thead><tr><th scope="col">${t("dash.col_title")}</th><th scope="col">${t("dash.col_patron")}</th><th scope="col">${t("dash.col_event")}</th><th scope="col">${t("dash.col_when")}</th></tr></thead><tbody>
      ${recent.results.map((l) => html`<tr><td><a href="/staff/catalog/${l.item.biblio.id}">${l.item.biblio.title}</a><div class="tiny muted mono">${l.item.barcode}</div></td>
        <td>${l.patron ? html`<a href="/staff/patrons/${l.patron.id}">${l.patron.full_name}</a>` : html`<span class="muted">${t("dash.anonymised")}</span>`}</td>
        <td>${l.returned_at ? badge("ok", t("dash.returned")) : l.overdue ? badge("overdue", t("dash.overdue")) : badge("info", t("dash.due", { date: date(l.due_at) }))}</td>
        <td class="muted small nowrap">${relative(l.returned_at || l.issued_at)}</td></tr>`)}</tbody></table></div>` : empty(t("dash.no_activity"));
    state.last = Date.now();
    $("#dash-updated").textContent = t("dash.updated", { time: datetime(new Date().toISOString().slice(0, 19)) });
  } catch (e) {
    if (!quiet) toast(e.message, "error");
    $("#dash-updated").textContent = t("dash.update_failed");
  } finally {
    state.loading = false;
  }
}

async function loadRisk() {
  try {
    const d = await api("/reports/dashboard");
    $("#risk").innerHTML = d.risk.length ? html`<ul class="desk-list">${d.risk.map((r) => html`<li>
      <span class="grow"><strong>${r.title}</strong><span class="tiny muted"> · <a href="/staff/patrons/${r.patron_id}">${r.patron}</a> · ${t("dash.due", { date: date(r.due_at) })}</span></span>
      ${badge(r.level, `${Math.round(r.risk * 100)}%`)}</li>`)}</ul>` : empty(t("dash.no_risk"));
  } catch (e) {
    $("#risk").innerHTML = empty(e.message, "alert");
  }
}

function schedule() {
  clearInterval(state.timer);
  if (!state.auto) return;
  state.timer = setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, REFRESH_MS);
}

function setAuto(on) {
  state.auto = on;
  const b = $("#dash-auto");
  b.setAttribute("aria-pressed", String(on));
  $("[data-label]", b).textContent = on ? t("dash.auto_refresh_on") : t("dash.auto_refresh_off");
  schedule();
}

export default async function init() {
  $("#today").textContent = new Intl.DateTimeFormat(document.documentElement.lang || undefined,
    { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  let branches = [];
  try { branches = (await api("/lookups")).branches; } catch { /* fall back to "all branches" */ }
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
