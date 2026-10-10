// Staff › Acquisitions › Serials — subscriptions, late issues & claims, claim history and renewals.
// (Subscription detail: staff-serial.js · claim letters: staff-serial-claims.js.)
import { $, api, date, datetime, html, icon, num, qs, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { errorState } from "/static/js/ui/empty.js";
import { activeFilters, searchField, selectChip, urlState, wireFilterBar } from "/static/js/ui/filters.js";
import { statTile } from "/static/js/ui/stat.js";
import { setupTabs } from "/static/js/pages/lib/sc-ui.js";
import { claimDialog, endsBadge, freqLabel, issueBadge, renewDialog, subBadge } from "/static/js/pages/serials/common.js";
import { loadRefs, subscriptionForm } from "/static/js/pages/serials/form.js";

const FILTERS = ["q", "status", "vendor_id", "branch_id"];
const state = urlState({ q: "", status: "active", vendor_id: "", branch_id: "" });
const S = { tab: "subs", can: false, refs: null, renewals: [] };
const panel = () => $("#ser-panel");
const vendorName = (v) => (!v || v.id === 0 ? t("coll.ser.no_vendor") : v.name);
const relDays = (d) => { try { return new Intl.RelativeTimeFormat(document.documentElement.lang || "en", { numeric: "auto" }).format(d, "day"); } catch { return ""; } };
const dayDiff = (ymd) => { const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number); const n = new Date(); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5); };

// ------------------------------------------------------------------ stats

async function loadStats() {
  try {
    const s = await api("/serials/stats");
    const outstanding = s.late + s.claimed + s.missing;
    $("#ser-stats").innerHTML = html`
      ${statTile({ label: t("coll.ser.k_active"), value: s.active, icon: "inbox", foot: t("coll.ser.k_received", { n: num(s.received_30d) }) })}
      ${statTile({ label: t("coll.ser.k_week"), value: s.expected_week, icon: "calendar", foot: t("coll.ser.k_week_foot", { date: date(new Date(Date.now() + 7 * 864e5)) }) })}
      ${statTile({ label: t("coll.ser.k_late"), value: s.late, icon: "alert", tone: s.late ? "warning" : "", foot: t("coll.ser.k_late_foot", { claimed: num(s.claimed), missing: num(s.missing) }) })}
      ${statTile({ label: t("coll.ser.k_ending"), value: s.expiring, icon: "clock", tone: s.expiring ? "warning" : "",
        foot: s.expiring ? html`<button type="button" class="link-btn" data-goto="renewals">${t("coll.ser.review_renewals")}</button>` : t("coll.ser.k_ending_none") })}`;
    $("#count-late").textContent = outstanding ? num(outstanding) : "0";
    $("#count-renewals").textContent = s.expiring ? num(s.expiring) : "0";
  } catch (e) { $("#ser-stats").innerHTML = errorState(e, { retry: false }); }
}

// ------------------------------------------------------------------ subscriptions

async function showSubs() {
  const refs = S.refs || (S.refs = await loadRefs().catch(() => ({ vendors: [], branches: [] })));
  const s0 = state.get();
  const statusOpts = [["all", t("coll.ser.any_status")], ["active", t("coll.ser.sub_active")], ["expired", t("coll.ser.sub_expired")], ["cancelled", t("coll.ser.sub_cancelled")]];
  const vendorOpts = [["", t("coll.acq.any_vendor")], ...refs.vendors.map((v) => [String(v.id), v.name])];
  const branchOpts = [["", t("common.all_branches")], ...refs.branches.map((b) => [String(b.id), b.name])];
  panel().innerHTML = html`<div class="filter-bar" id="subs-filters"><div class="filter-row">
      ${searchField({ name: "q", label: t("coll.ser.search_label"), value: s0.q, placeholder: t("coll.ser.search_placeholder") })}
      ${selectChip({ name: "status", label: t("coll.acq.col_status"), value: s0.status, options: statusOpts })}
      ${selectChip({ name: "vendor_id", label: t("coll.acq.col_vendor"), value: s0.vendor_id, options: vendorOpts })}
      ${selectChip({ name: "branch_id", label: t("common.branch"), value: s0.branch_id, options: branchOpts })}</div><div id="subs-chips"></div></div>
    <div id="subs-table"></div>`;
  const table = dataTable($("#subs-table"), {
    id: "serial-subs", caption: t("coll.ser.tab_subs"), exportName: "subscriptions", rowHref: (s) => `/staff/serials/${s.id}`,
    columns: [
      { key: "title", label: t("coll.field.title"), primary: true, hideable: false, csv: (s) => s.biblio.title,
        render: (s) => html`<div class="dt-cell-stack"><a href="/staff/serials/${s.id}">${s.biblio.title}</a><span class="sub">${[s.biblio.issn ? `ISSN ${s.biblio.issn}` : "", s.branch.name].filter(Boolean).join(" · ")}</span></div>` },
      { key: "vendor", label: t("coll.acq.col_vendor"), csv: (s) => vendorName(s.vendor), render: (s) => (s.vendor ? s.vendor.name : html`<span class="muted">—</span>`) },
      { key: "freq", label: t("coll.sf.frequency"), csv: (s) => freqLabel(s), render: (s) => html`<span class="small">${freqLabel(s)}</span>` },
      { key: "status", label: t("coll.acq.col_status"), csv: (s) => s.status, render: (s) => subBadge(s.status) },
      { key: "next", label: t("coll.ser.next_issue"), csv: (s) => s.next_issue?.enumeration || "",
        render: (s) => (s.next_issue ? html`<div class="dt-cell-stack"><span>${s.next_issue.enumeration}</span><span class="sub">${date(s.next_issue.expected_on)} · ${relDays(dayDiff(s.next_issue.expected_on))}</span></div>`
          : html`<span class="muted small">${s.frequency === "irregular" ? t("coll.freq.irregular_short") : "—"}</span>`) },
      { key: "received", label: t("coll.ser.received"), align: "num", csv: (s) => s.counts.arrived || 0, render: (s) => num(s.counts.arrived || 0) },
      { key: "late", label: t("coll.ser.late"), align: "num", csv: (s) => (s.counts.late || 0) + (s.counts.claimed || 0),
        render: (s) => { const n = (s.counts.late || 0) + (s.counts.claimed || 0); return n ? html`<span class="badge pill warning">${num(n)}</span>` : html`<span class="muted">0</span>`; } },
      { key: "period", label: t("coll.ser.period"), csv: (s) => `${s.start_date}–${s.end_date || ""}`,
        render: (s) => html`<div class="dt-cell-stack"><span class="sub">${t("coll.ser.from", { date: date(s.start_date) })}</span>${endsBadge(s)}</div>` },
    ],
    empty: { art: "inbox", title: t("coll.ser.no_subs_title"), body: t("coll.ser.no_subs_body"),
      actions: html`<button type="button" class="btn" data-clear-filters>${t("ui.filters.clear_all")}</button>` },
  });
  const labels = { q: t("common.search"), status: t("coll.acq.col_status"), vendor_id: t("coll.acq.col_vendor"), branch_id: t("common.branch") };
  const optMap = { status: statusOpts, vendor_id: vendorOpts, branch_id: branchOpts };
  const chips = () => {
    const s = state.get();
    $("#subs-chips").innerHTML = activeFilters(["q", "vendor_id", "branch_id"].filter((k) => s[k]).map((k) => ({ key: k, label: labels[k],
      value: k === "q" ? `“${s.q}”` : optMap[k].find(([v]) => v === s[k])?.[1] || s[k] })));
  };
  const load = async () => {
    table.setLoading();
    try {
      const q = state.get();
      const r = await api(`/serials/subscriptions?${qs({ ...q, status: q.status === "all" ? "" : q.status })}`);
      table.setRows(r.results);
    } catch (e) { table.setError(e, load); }
  };
  wireFilterBar($("#subs-filters"), (ch) => {
    state.set(ch);
    const s = state.get();
    for (const k of FILTERS) { const el = $(`#subs-filters [name="${k}"]`); if (el && el.tagName === "SELECT") { el.value = s[k]; el.closest(".select-chip")?.classList.toggle("active", !!s[k]); } }
    chips();
    load();
  }, { keys: FILTERS });
  $("#subs-table").addEventListener("click", (e) => { if (e.target.closest("[data-clear-filters]")) { state.set({ q: "", status: "all", vendor_id: "", branch_id: "" }); showSubs(); } });
  chips();
  await load();
}

// ------------------------------------------------------------------ late issues & claims

async function showLate() {
  panel().innerHTML = html`<p class="small muted tab-intro">${t("coll.ser.late_intro")}</p><div id="late-table"></div>`;
  const table = dataTable($("#late-table"), {
    id: "serial-late", caption: t("coll.ser.tab_late"), selectable: S.can, exportName: "late-issues", rowLabel: (i) => `${i.title} ${i.enumeration}`,
    columns: [
      { key: "title", label: t("coll.field.title"), primary: true, hideable: false, csv: (i) => i.title,
        render: (i) => html`<div class="dt-cell-stack"><a href="/staff/serials/${i.subscription_id}">${i.title}</a>${i.vendor_reference ? html`<span class="sub">${t("coll.ser.ref", { ref: i.vendor_reference })}</span>` : ""}</div>` },
      { key: "vendor", label: t("coll.acq.col_vendor"), csv: (i) => i.vendorName, render: (i) => i.vendorName },
      { key: "issue", label: t("coll.ser.issue"), csv: (i) => i.enumeration, render: (i) => html`<div class="dt-cell-stack"><span>${i.enumeration}</span><span class="sub">${i.chronology || ""}</span></div>` },
      { key: "expected", label: t("coll.ser.expected"), csv: (i) => i.expected_on, render: (i) => html`<span class="nowrap">${date(i.expected_on)}</span>` },
      { key: "late", label: t("coll.ser.days_late"), align: "num", csv: (i) => i.days_late, render: (i) => num(i.days_late) },
      { key: "status", label: t("coll.acq.col_status"), csv: (i) => i.status, render: (i) => issueBadge(i.status) },
      { key: "claims", label: t("coll.ser.claims"), csv: (i) => i.claim_count,
        render: (i) => (i.claim_count ? html`<span class="small">${t("coll.ser.claimed_times", { count: i.claim_count, n: num(i.claim_count) })} · ${date(i.last_claimed_at)}</span>` : html`<span class="small muted">${t("coll.ser.not_claimed")}</span>`) },
    ],
    bulkActions: S.can ? [{ id: "claim", label: t("coll.ser.claim_selected"), icon: "send", run: async (rows, { clear }) => { if (await claimDialog(rows)) { clear(); loadStats(); showLate(); } } }] : [],
    empty: { art: "done", title: t("coll.ser.no_late_title"), body: t("coll.ser.no_late_body") },
  });
  table.setLoading();
  try {
    const r = await api("/serials/late");
    table.setRows(r.groups.flatMap((g) => g.issues.map((i) => ({ ...i, vendorName: vendorName(g.vendor) }))));
  } catch (e) { table.setError(e, showLate); }
}

// ------------------------------------------------------------------ claim history

async function showHistory() {
  panel().innerHTML = html`<div id="hist-table"></div>`;
  const table = dataTable($("#hist-table"), {
    id: "serial-claims", caption: t("coll.ser.tab_history"), exportName: "serial-claims",
    columns: [
      { key: "at", label: t("coll.ser.claimed"), csv: (c) => c.claimed_at, render: (c) => html`<span class="nowrap" title="${datetime(c.claimed_at)}">${date(c.claimed_at)}</span>` },
      { key: "vendor", label: t("coll.acq.col_vendor"), csv: (c) => vendorName(c.vendor), render: (c) => vendorName(c.vendor) },
      { key: "title", label: t("coll.field.title"), primary: true, csv: (c) => c.subscription.title, render: (c) => html`<a href="/staff/serials/${c.subscription.id}">${c.subscription.title}</a>` },
      { key: "issue", label: t("coll.ser.issue"), csv: (c) => c.issue.enumeration, render: (c) => html`<div class="dt-cell-stack"><span>${c.issue.enumeration}</span>${c.note ? html`<span class="sub">${c.note}</span>` : ""}</div>` },
      { key: "n", label: t("coll.ser.claim_no"), align: "num", csv: (c) => c.issue.claim_count, render: (c) => num(c.issue.claim_count) },
      { key: "status", label: t("coll.ser.now"), csv: (c) => c.issue.status, render: (c) => issueBadge(c.issue.status) },
      { key: "by", label: t("coll.ser.by"), hidden: true, csv: (c) => c.by || "", render: (c) => c.by || "—" },
      { key: "letter", label: t("coll.ser.letter"), labelHidden: true, csv: false, cellClass: "dt-actions",
        render: (c) => html`<a class="btn sm ghost" href="/staff/serials/claims/${c.batch}">${icon("list")}${t("coll.ser.letter")}</a>` },
    ],
    empty: { art: "inbox", title: t("coll.ser.no_claims_title"), body: t("coll.ser.no_claims_body") },
  });
  table.setLoading();
  try { table.setRows((await api("/serials/claims?limit=300")).results); } catch (e) { table.setError(e, showHistory); }
}

// ------------------------------------------------------------------ renewals

async function showRenewals() {
  panel().innerHTML = html`<p class="small muted tab-intro">${t("coll.ser.renewals_intro")}</p><div id="ren-table"></div>`;
  const table = dataTable($("#ren-table"), {
    id: "serial-renewals", caption: t("coll.ser.tab_renewals"), exportName: "renewals",
    columns: [
      { key: "title", label: t("coll.field.title"), primary: true, hideable: false, csv: (s) => s.biblio.title, render: (s) => html`<a href="/staff/serials/${s.id}">${s.biblio.title}</a>` },
      { key: "vendor", label: t("coll.acq.col_vendor"), csv: (s) => s.vendor?.name || "", render: (s) => s.vendor?.name || "—" },
      { key: "budget", label: t("coll.acq.col_budget"), csv: (s) => s.budget?.name || "", render: (s) => (s.budget ? `${s.budget.name} · ${t("coll.acq.fy", { year: String(s.budget.fiscal_year) })}` : "—") },
      { key: "status", label: t("coll.acq.col_status"), csv: (s) => s.status, render: (s) => subBadge(s.status) },
      { key: "ends", label: t("coll.ser.ends"), csv: (s) => s.end_date || "", render: (s) => endsBadge(s) },
      { key: "act", label: t("coll.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions",
        render: (s) => (S.can ? html`<button type="button" class="btn sm" data-renew="${s.id}">${icon("refresh")}${t("coll.ser.renew_ellipsis")}</button>` : "") },
    ],
    empty: { art: "done", title: t("coll.ser.no_renewals_title"), body: t("coll.ser.no_renewals_body") },
  });
  table.setLoading();
  try { S.renewals = (await api("/serials/expiring?days=90")).results; table.setRows(S.renewals); } catch (e) { table.setError(e, showRenewals); }
}

// ------------------------------------------------------------------ init

const SHOW = { subs: showSubs, late: showLate, history: showHistory, renewals: showRenewals };

export default async function init() {
  S.can = $("#serials").dataset.canWrite === "1";
  const selectTab = setupTabs($("#ser-tabs"), (key) => {
    S.tab = key;
    history.replaceState(null, "", key === "subs" ? `${location.pathname}${location.search}` : `${location.pathname}${location.search}#${key}`);
    SHOW[key]().catch((e) => { panel().innerHTML = errorState(e, { retry: false }); });
  });
  $("#new-sub")?.addEventListener("click", async () => {
    const sub = await subscriptionForm();
    if (sub) { toast(t("coll.ser.created", { count: sub.counts?.expected || 0, n: num(sub.counts?.expected || 0) }), "success"); location.href = `/staff/serials/${sub.id}`; }
  });
  $("#ser-refresh").addEventListener("click", () => { loadStats(); SHOW[S.tab](); });
  document.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) { selectTab(g.dataset.goto); $(`#tab-${g.dataset.goto}`)?.focus(); } });
  panel().addEventListener("click", async (e) => {
    const rn = e.target.closest("[data-renew]");
    if (rn && (await renewDialog(S.renewals.find((s) => s.id === +rn.dataset.renew)))) { loadStats(); showRenewals(); }
  });
  loadStats();
  const initial = location.hash.slice(1);
  if (!(SHOW[initial] && selectTab(initial))) selectTab("subs");
}
