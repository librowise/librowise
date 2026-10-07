// Staff: serials — subscriptions list, late issues & claims, claim history and renewal alerts.
// The same page module also serves the subscription detail and claim-letter screens.
import { $, $$, BOOT, api, badge, date, datetime, debounce, empty, html, icon, num, qs, skeleton, toast } from "/static/js/core.js";
import { errorBox, plural, relDay, setupTabs } from "/static/js/pages/lib/sc-ui.js";
import { claimDialog, endsBadge, issueBadge, renewDialog, subBadge } from "/static/js/pages/serials/common.js";
import { loadRefs, subscriptionForm } from "/static/js/pages/serials/form.js";

const state = { tab: "subs", filters: { q: "", status: "active", vendor_id: "", branch_id: "" }, late: null };
const panel = () => $("#ser-panel");

// ------------------------------------------------------------------ header: stats & renewal alert

async function loadStats() {
  try {
    const s = await api("/serials/stats");
    $("#ser-stats").innerHTML = html`
      <div class="card stat"><span class="label">Active subscriptions</span><span class="value">${num(s.active)}</span>
        <span class="delta">${num(s.received_30d)} issues received in 30 days</span></div>
      <div class="card stat"><span class="label">Expected this week</span><span class="value">${num(s.expected_week)}</span>
        <span class="delta">Due on or before ${date(new Date(Date.now() + 7 * 864e5))}</span></div>
      <div class="card stat ${s.late ? "alert" : ""}"><span class="label">Late issues</span><span class="value">${num(s.late)}</span>
        <span class="delta">${num(s.claimed)} claimed · ${num(s.missing)} missing</span></div>
      <div class="card stat ${s.expiring ? "alert" : ""}"><span class="label">Ending within 60 days</span><span class="value">${num(s.expiring)}</span>
        <span class="delta">Renewal alerts</span></div>`;
    const late = $("#count-late"), outstanding = s.late + s.claimed + s.missing;
    late.textContent = outstanding;
    late.classList.toggle("hidden", !outstanding);
    const ren = $("#count-renewals");
    ren.textContent = s.expiring;
    ren.classList.toggle("hidden", !s.expiring);
    $("#ser-renewal-alert").innerHTML = s.expiring ? html`<div class="alert warn" style="margin-bottom:1rem">${icon("clock")}
      <div class="grow">${plural(s.expiring, "subscription")} end${s.expiring === 1 ? "s" : ""} within 60 days.</div>
      <button class="btn sm" data-goto="renewals">Review renewals</button></div>` : "";
  } catch (e) {
    $("#ser-stats").innerHTML = errorBox(e.message);
  }
}

// ------------------------------------------------------------------ subscriptions tab

function subsToolbar(refs) {
  const f = state.filters;
  return html`<form class="row sc-filters" id="subs-filters" role="search">
    <div class="field grow"><label for="sf-q">Search</label><input id="sf-q" name="q" type="search" value="${f.q}" placeholder="Title, ISSN or vendor reference" autocomplete="off" data-search-focus></div>
    <div class="field"><label for="sf-status">Status</label><select id="sf-status" name="status">
      ${[["", "All"], ["active", "Active"], ["expired", "Expired"], ["cancelled", "Cancelled"]].map(([v, l]) => html`<option value="${v}" ${f.status === v ? "selected" : ""}>${l}</option>`)}</select></div>
    <div class="field"><label for="sf-vendor-f">Vendor</label><select id="sf-vendor-f" name="vendor_id"><option value="">All vendors</option>
      ${refs.vendors.map((v) => html`<option value="${v.id}" ${String(v.id) === f.vendor_id ? "selected" : ""}>${v.name}</option>`)}</select></div>
    <div class="field"><label for="sf-branch-f">Branch</label><select id="sf-branch-f" name="branch_id"><option value="">All branches</option>
      ${refs.branches.map((b) => html`<option value="${b.id}" ${String(b.id) === f.branch_id ? "selected" : ""}>${b.name}</option>`)}</select></div>
  </form><div id="subs-table" style="margin-top:1rem"></div>`;
}

async function loadSubs() {
  const box = $("#subs-table");
  if (!box) return;
  box.innerHTML = skeleton(5);
  try {
    const r = await api(`/serials/subscriptions?${qs(state.filters)}`);
    if (!r.results.length) {
      box.innerHTML = html`<div class="card">${empty(state.filters.q || state.filters.status !== "active"
        ? "No subscriptions match these filters." : "No active subscriptions yet. Create one to start predicting issues.", "inbox")}</div>`;
      return;
    }
    box.innerHTML = html`<div class="card flush"><div class="card-body"><div class="table-wrap"><table class="table">
      <caption class="sr-only">Subscriptions</caption>
      <thead><tr><th scope="col">Title</th><th scope="col">Vendor</th><th scope="col">Frequency</th><th scope="col">Status</th>
        <th scope="col">Next expected issue</th><th scope="col" class="num">Received</th><th scope="col" class="num">Late</th><th scope="col">Period</th></tr></thead>
      <tbody>${r.results.map((s) => {
        const late = (s.counts.late || 0) + (s.counts.claimed || 0);
        return html`<tr>
          <td><a href="/staff/serials/${s.id}"><strong>${s.biblio.title}</strong></a>
            <div class="tiny muted">${s.biblio.issn ? `ISSN ${s.biblio.issn} · ` : ""}${s.branch.name}</div></td>
          <td>${s.vendor ? s.vendor.name : html`<span class="muted">—</span>`}</td>
          <td class="small">${s.frequency_label}</td>
          <td>${subBadge(s.status)}</td>
          <td>${s.next_issue ? html`<div>${s.next_issue.enumeration}</div><div class="tiny muted">${date(s.next_issue.expected_on)} · ${relDay(s.next_issue.expected_on)}</div>`
            : html`<span class="muted small">${s.frequency === "irregular" ? "Irregular" : "—"}</span>`}</td>
          <td class="num">${num(s.counts.arrived || 0)}</td>
          <td class="num">${late ? badge("warn", num(late)) : html`<span class="muted">0</span>`}</td>
          <td class="nowrap"><div class="tiny muted">from ${date(s.start_date)}</div>${endsBadge(s)}</td></tr>`;
      })}</tbody></table></div></div></div>
      <p class="tiny muted">${plural(r.total, "subscription")}</p>`;
  } catch (e) { box.innerHTML = errorBox(e.message); }
}

async function showSubs() {
  const refs = await loadRefs().catch(() => ({ vendors: [], branches: [] }));
  panel().innerHTML = subsToolbar(refs);
  const form = $("#subs-filters");
  const apply = () => {
    const fd = new FormData(form);
    state.filters = { q: String(fd.get("q") || "").trim(), status: fd.get("status"), vendor_id: fd.get("vendor_id"), branch_id: fd.get("branch_id") };
    loadSubs();
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); apply(); });
  form.addEventListener("change", apply);
  $("#sf-q").addEventListener("input", debounce(apply, 300));
  await loadSubs();
}

// ------------------------------------------------------------------ late issues & claims tab

function lateGroup(g, gi) {
  return html`<section class="card flush sc-vendor" aria-labelledby="lg-${gi}">
    <div class="card-head" style="padding-bottom:var(--pad)">
      <div><h3 id="lg-${gi}">${g.vendor.name}</h3>
        <div class="tiny muted">${g.vendor.email || "No email on file"}${g.vendor.phone ? ` · ${g.vendor.phone}` : ""}</div></div>
      <div class="row tight"><label class="checkbox small"><input type="checkbox" data-select-group="${gi}"> Select all</label>
        <button class="btn sm" data-claim-group="${gi}">${icon("send")}Claim selected</button></div>
    </div>
    <div class="card-body"><div class="table-wrap"><table class="table">
      <caption class="sr-only">Outstanding issues from ${g.vendor.name}</caption>
      <thead><tr><th scope="col"><span class="sr-only">Select</span></th><th scope="col">Title</th><th scope="col">Issue</th><th scope="col">Expected</th>
        <th scope="col" class="num">Days late</th><th scope="col">Status</th><th scope="col">Claims</th></tr></thead>
      <tbody>${g.issues.map((i) => html`<tr>
        <td><input type="checkbox" data-issue="${i.id}" data-group="${gi}" aria-label="Select ${i.title} ${i.enumeration}"></td>
        <td><a href="/staff/serials/${i.subscription_id}">${i.title}</a>${i.vendor_reference ? html`<div class="tiny muted">Ref ${i.vendor_reference}</div>` : ""}</td>
        <td>${i.enumeration}<div class="tiny muted">${i.chronology || ""}</div></td>
        <td class="nowrap">${date(i.expected_on)}</td>
        <td class="num">${num(i.days_late)}</td>
        <td>${issueBadge(i.status)}</td>
        <td class="small">${i.claim_count ? html`${i.claim_count}× · last ${date(i.last_claimed_at)}` : html`<span class="muted">Not claimed</span>`}</td></tr>`)}</tbody>
    </table></div></div></section>`;
}

async function showLate() {
  const p = panel();
  p.innerHTML = skeleton(6);
  try {
    const r = await api("/serials/late");
    state.late = r;
    if (!r.groups.length) { p.innerHTML = html`<div class="card">${empty("No late or missing issues. Everything has arrived on time.", "check")}</div>`; return; }
    p.innerHTML = html`<div class="row between" style="margin-bottom:1rem">
        <p class="small muted" style="margin:0">${plural(r.total, "outstanding issue")} from ${plural(r.groups.length, "vendor")}. Issues become late after their expected date plus the subscription's grace period.</p>
        <button class="btn primary" id="claim-all-selected" disabled>${icon("send")}Claim selected</button></div>
      <div class="stack">${r.groups.map(lateGroup)}</div>`;
  } catch (e) { p.innerHTML = errorBox(e.message); }
}

function lateSelection(group = null) {
  const ids = $$("[data-issue]:checked", panel()).filter((c) => group === null || c.dataset.group === String(group)).map((c) => +c.dataset.issue);
  const all = state.late.groups.flatMap((g) => g.issues.map((i) => ({ ...i, vendorName: g.vendor.name })));
  return all.filter((i) => ids.includes(i.id));
}

// ------------------------------------------------------------------ claim history tab

async function showHistory() {
  const p = panel();
  p.innerHTML = skeleton(6);
  try {
    const r = await api("/serials/claims?limit=300");
    if (!r.results.length) { p.innerHTML = html`<div class="card">${empty("No claims have been sent yet.", "send")}</div>`; return; }
    p.innerHTML = html`<div class="card flush"><div class="card-body"><div class="table-wrap"><table class="table">
      <caption class="sr-only">Claim history</caption>
      <thead><tr><th scope="col">Claimed</th><th scope="col">Vendor</th><th scope="col">Title</th><th scope="col">Issue</th>
        <th scope="col">Claim #</th><th scope="col">Current status</th><th scope="col">By</th><th scope="col"><span class="sr-only">Letter</span></th></tr></thead>
      <tbody>${r.results.map((c) => html`<tr>
        <td class="nowrap" title="${datetime(c.claimed_at)}">${date(c.claimed_at)}</td>
        <td>${c.vendor.name}</td>
        <td><a href="/staff/serials/${c.subscription.id}">${c.subscription.title}</a></td>
        <td>${c.issue.enumeration}${c.note ? html`<div class="tiny muted">${c.note}</div>` : ""}</td>
        <td class="num">${c.issue.claim_count}</td>
        <td>${issueBadge(c.issue.status)}</td>
        <td class="small">${c.by || "—"}</td>
        <td class="right"><a class="btn sm ghost" href="/staff/serials/claims/${c.batch}">${icon("list")}Letter</a></td></tr>`)}</tbody>
    </table></div></div></div>`;
  } catch (e) { p.innerHTML = errorBox(e.message); }
}

// ------------------------------------------------------------------ renewals tab

let renewals = [];
async function showRenewals() {
  const p = panel();
  p.innerHTML = skeleton(4);
  try {
    renewals = (await api("/serials/expiring?days=90")).results;
    if (!renewals.length) { p.innerHTML = html`<div class="card">${empty("No subscriptions end in the next 90 days.", "check")}</div>`; return; }
    p.innerHTML = html`<div class="card flush"><div class="card-body"><div class="table-wrap"><table class="table">
      <caption class="sr-only">Subscriptions due for renewal</caption>
      <thead><tr><th scope="col">Title</th><th scope="col">Vendor</th><th scope="col">Budget</th><th scope="col">Status</th><th scope="col">Ends</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${renewals.map((s, i) => html`<tr>
        <td><a href="/staff/serials/${s.id}">${s.biblio.title}</a></td>
        <td>${s.vendor?.name || "—"}</td><td class="small">${s.budget ? `${s.budget.name} · FY ${s.budget.fiscal_year}` : "—"}</td>
        <td>${subBadge(s.status)}</td><td>${endsBadge(s)}</td>
        <td class="right"><button class="btn sm primary" data-renew="${i}">${icon("refresh")}Renew…</button></td></tr>`)}</tbody>
    </table></div></div></div>
    <p class="tiny muted">Shows subscriptions ending within 90 days and those that lapsed in the last 30 days.</p>`;
  } catch (e) { p.innerHTML = errorBox(e.message); }
}

// ------------------------------------------------------------------ init

const SHOW = { subs: showSubs, late: showLate, history: showHistory, renewals: showRenewals };

async function listPage() {
  const selectTab = setupTabs($("#ser-tabs"), (key) => {
    state.tab = key;
    history.replaceState(null, "", key === "subs" ? location.pathname : `#${key}`);
    SHOW[key]();
  });
  $("#new-sub").addEventListener("click", async () => {
    const sub = await subscriptionForm();
    if (sub) { toast(`Subscription created · ${plural(sub.counts.expected || 0, "issue")} predicted`, "success"); location.href = `/staff/serials/${sub.id}`; }
  });
  $("#ser-refresh").addEventListener("click", () => { loadStats(); SHOW[state.tab](); });
  document.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) selectTab(g.dataset.goto); });
  panel().addEventListener("change", (e) => {
    const all = e.target.closest("[data-select-group]");
    if (all) $$(`[data-group="${all.dataset.selectGroup}"]`, panel()).forEach((c) => { c.checked = all.checked; });
    const btn = $("#claim-all-selected");
    if (btn) btn.disabled = !$$("[data-issue]:checked", panel()).length;
  });
  panel().addEventListener("click", async (e) => {
    const g = e.target.closest("[data-claim-group]"), all = e.target.closest("#claim-all-selected"), rn = e.target.closest("[data-renew]");
    if (g || all) {
      const sel = lateSelection(g ? +g.dataset.claimGroup : null);
      if (!sel.length) { toast("Select the issues to claim first", "error"); return; }
      if (await claimDialog(sel)) { loadStats(); showLate(); }
    } else if (rn) {
      if (await renewDialog(renewals[+rn.dataset.renew])) { loadStats(); showRenewals(); }
    }
  });
  loadStats();
  const initial = location.hash.slice(1);
  if (!(SHOW[initial] && selectTab(initial))) await showSubs();
}

export default async function init() {
  if ($("#claim-letters")) return (await import("/static/js/pages/serials/claims.js")).default();
  if (BOOT.path_params?.subscription_id) return (await import("/static/js/pages/serials/detail.js")).default();
  return listPage();
}
