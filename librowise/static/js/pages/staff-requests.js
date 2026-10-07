// Staff: OPAC self-registration approval queue and patron purchase suggestions review.
import { $, $$, api, badge, date, datetime, empty, html, icon, modal, money, relative, skeleton, toast, withBusy } from "/static/js/core.js";

const STATUSES = {
  registrations: [["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"], ["all", "All"]],
  suggestions: [["pending", "Pending"], ["accepted", "Accepted"], ["ordered", "Ordered"], ["rejected", "Rejected"], ["withdrawn", "Withdrawn"], ["", "All"]],
};
const SUG_BADGE = { pending: "warn", accepted: "ok", ordered: "info", rejected: "bad", withdrawn: "" };
const state = { tab: "registrations", status: "pending", rows: [], lookups: null };
const panel = () => $("#rq-panel");

function setCount(key, n) {
  const el = $(`#count-${key}`);
  el.textContent = n || "";
  el.className = `badge warn ${n ? "" : "hidden"}`;
}

// ------------------------------------------------------------------ registrations

function registrationsView(rows) {
  if (!rows.length) return html`<div class="card">${empty(state.status === "pending" ? "No registrations are waiting for review." : "Nothing here.", "user-plus")}</div>`;
  return html`<div class="stack">${rows.map((r) => html`<article class="card pad" aria-label="Registration from ${r.full_name}">
    <div class="row between" style="align-items:flex-start">
      <div class="stack tight grow">
        <div class="row tight"><h3 style="margin:0">${r.full_name}</h3>${badge(r.status === "pending" ? "warn" : r.status === "approved" ? "ok" : "bad", r.status)}</div>
        <dl class="dl small">
          <dt>Email</dt><dd>${r.email || "—"}</dd><dt>Phone</dt><dd>${r.phone || "—"}</dd>
          <dt>Address</dt><dd>${r.address || "—"}</dd><dt>Date of birth</dt><dd>${r.date_of_birth ? date(r.date_of_birth) : "—"}</dd>
          <dt>Home branch</dt><dd>${r.home_branch.name}</dd><dt>Category</dt><dd>${r.category.name}</dd>
          <dt>Submitted</dt><dd title="${datetime(r.submitted_at)}">${relative(r.submitted_at)}</dd>
          ${r.reviewed_at ? html`<dt>Reviewed</dt><dd>${relative(r.reviewed_at)}${r.reviewed_by ? ` by ${r.reviewed_by}` : ""}${r.decision_note ? html` — <em>${r.decision_note}</em>` : ""}</dd>` : ""}
        </dl>
        ${r.duplicates.length ? html`<div class="alert warn">${icon("alert")}<div><strong>Possible existing member:</strong>
          ${r.duplicates.map((d, i) => html`${i ? ", " : ""}<a href="/staff/patrons/${d.id}">${d.full_name} (${d.card_number})</a>`)}</div></div>` : ""}
      </div>
      <div class="row tight">
        ${r.status !== "approved" ? html`<button class="btn primary" data-approve="${r.patron_id}">${icon("check")}Approve</button>` : html`<a class="btn" href="/staff/patrons/${r.patron_id}">${icon("user")}Open patron</a>`}
        ${r.status === "pending" ? html`<button class="btn danger" data-reject="${r.patron_id}">${icon("x")}Reject</button>` : ""}
      </div></div></article>`)}</div>`;
}

async function approve(id) {
  const r = state.rows.find((x) => x.patron_id === id);
  const lk = state.lookups;
  const fd = await modal({ title: `Approve ${r.full_name}`, submit: "Approve & notify", body: html`<div class="stack">
    <p class="small muted">The account is activated, the membership period starts today and ${r.first_name} is emailed their card number.</p>
    <div class="grid cols-2">
      <div class="field"><label for="ap-cat">Patron category</label><select id="ap-cat" name="category_id">${(lk.categories || []).map((c) =>
        html`<option value="${c.id}" ${c.id === r.category.id ? "selected" : ""}>${c.name}</option>`)}</select></div>
      <div class="field"><label for="ap-br">Home branch</label><select id="ap-br" name="home_branch_id">${lk.branches.map((b) =>
        html`<option value="${b.id}" ${b.id === r.home_branch.id ? "selected" : ""}>${b.name}</option>`)}</select></div></div>
    <div class="field"><label for="ap-note">Internal note (optional)</label><input id="ap-note" name="note" maxlength="500" placeholder="e.g. ID and address verified"></div></div>` });
  if (!fd) return;
  try {
    const out = await api(`/registrations/${id}/approve`, { method: "POST", body: {
      category_id: Number(fd.get("category_id")), home_branch_id: Number(fd.get("home_branch_id")), note: fd.get("note") || null } });
    toast(`${r.full_name} approved — card ${out.card_number}`, "success", 6000);
    load();
  } catch (e) { toast(e.message, "error"); }
}

async function reject(id) {
  const r = state.rows.find((x) => x.patron_id === id);
  const fd = await modal({ title: `Reject ${r.full_name}?`, submit: "Reject & notify", danger: true, body: html`<div class="stack">
    <div class="field"><label for="rj-reason">Reason (sent to the applicant)</label>
      <textarea id="rj-reason" name="reason" maxlength="500" required rows="3" placeholder="e.g. We could not verify the address provided."></textarea></div></div>` });
  if (!fd) return;
  try {
    await api(`/registrations/${id}/reject`, { method: "POST", body: { reason: String(fd.get("reason")).trim() } });
    toast("Registration rejected", "success");
    load();
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ suggestions

function suggestionsView(rows) {
  if (!rows.length) return html`<div class="card">${empty("No suggestions match.", "cart")}</div>`;
  return html`<div class="card flush"><div class="table-wrap"><table class="table">
    <caption class="sr-only">Purchase suggestions</caption>
    <thead><tr><th scope="col">Title</th><th scope="col">Patron</th><th scope="col">Why</th><th scope="col">Status</th><th scope="col">Suggested</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map((s) => html`<tr>
      <td><strong>${s.title}</strong><div class="tiny muted">${[s.author, s.isbn, s.format].filter(Boolean).join(" · ")}</div>
        ${s.holdings ? html`<a class="tiny" href="/staff/catalog/${s.holdings}">${icon("book")}Already in the catalogue</a>` : ""}</td>
      <td>${s.patron ? html`<a href="/staff/patrons/${s.patron.id}">${s.patron.full_name}</a><div class="tiny muted mono">${s.patron.card_number}</div>` : html`<span class="muted">—</span>`}</td>
      <td class="small">${s.reason || html`<span class="muted">—</span>`}</td>
      <td>${badge(SUG_BADGE[s.status] ?? "", s.status_label)}${s.decision_note ? html`<div class="tiny muted">${s.decision_note}</div>` : ""}
        ${s.order_id ? html`<div class="tiny"><a href="/staff/acquisitions">Draft order #${s.order_id}</a></div>` : ""}</td>
      <td class="nowrap" title="${datetime(s.created_at)}">${relative(s.created_at)}</td>
      <td class="right nowrap">${s.status === "pending" ? html`<button class="btn sm primary" data-accept="${s.id}">${icon("check")}Accept</button>
        <button class="btn sm danger" data-sreject="${s.id}" aria-label="Reject suggestion ${s.title}">${icon("x")}Reject</button>` : ""}</td></tr>`)}</tbody></table></div></div>`;
}

async function accept(id) {
  const s = state.rows.find((x) => x.id === id);
  let vendors = [], budgets = [];
  try {
    [vendors, budgets] = await Promise.all([api("/acquisitions/vendors").then((r) => r.results), api("/acquisitions/budgets").then((r) => r.results)]);
  } catch { /* ordering simply unavailable without acquisitions access */ }
  const canOrder = vendors.length && budgets.length;
  const fd = await modal({ title: "Accept suggestion", submit: "Accept & notify", wide: true, body: html`<div class="stack">
    <p><strong>${s.title}</strong>${s.author ? ` — ${s.author}` : ""}</p>
    <div class="field"><label for="ac-note">Message to the patron (optional)</label><input id="ac-note" name="note" maxlength="500" placeholder="e.g. We'll order two copies"></div>
    ${canOrder ? html`<label class="checkbox"><input type="checkbox" name="create_order" id="ac-order"> Create a draft purchase order now</label>
      <div class="grid cols-2" id="ac-order-fields">
        <div class="field"><label for="ac-vendor">Vendor</label><select id="ac-vendor" name="vendor_id">${vendors.map((v) => html`<option value="${v.id}">${v.name}</option>`)}</select></div>
        <div class="field"><label for="ac-budget">Budget</label><select id="ac-budget" name="budget_id">${budgets.map((b) => html`<option value="${b.id}">${b.name} (${b.fiscal_year}) · ${money(b.remaining)} left</option>`)}</select></div>
        <div class="field"><label for="ac-qty">Copies</label><input id="ac-qty" name="quantity" type="number" min="1" max="1000" value="1"></div>
        <div class="field"><label for="ac-price">Unit price (₹)</label><input id="ac-price" name="unit_price" type="number" min="0" step="0.01" placeholder="0.00"></div></div>`
      : html`<p class="small muted">Draft orders need acquisitions access and at least one vendor and budget.</p>`}</div>` });
  if (!fd) return;
  const body = { note: fd.get("note") || null };
  if (fd.has("create_order")) {
    const price = Number(fd.get("unit_price"));
    if (!fd.get("unit_price") || Number.isNaN(price)) { toast("Enter a unit price for the order", "error"); return; }
    Object.assign(body, { create_order: true, vendor_id: Number(fd.get("vendor_id")), budget_id: Number(fd.get("budget_id")),
      quantity: Number(fd.get("quantity") || 1), unit_price: Math.round(price * 100) });
  }
  try {
    const out = await api(`/suggestions/${id}/accept`, { method: "POST", body });
    toast(out.order_id ? `Accepted — draft order #${out.order_id} created` : "Suggestion accepted", "success");
    load();
  } catch (e) { toast(e.message, "error"); }
}

async function rejectSuggestion(id) {
  const s = state.rows.find((x) => x.id === id);
  const fd = await modal({ title: "Reject suggestion?", submit: "Reject & notify", danger: true, body: html`<div class="stack">
    <p><strong>${s.title}</strong></p>
    <div class="field"><label for="sr-reason">Reason (the patron will see this)</label>
      <textarea id="sr-reason" name="reason" maxlength="500" rows="3" required placeholder="e.g. Out of print; available via inter-library loan"></textarea></div></div>` });
  if (!fd) return;
  try {
    await api(`/suggestions/${id}/reject`, { method: "POST", body: { reason: String(fd.get("reason")).trim() } });
    toast("Suggestion rejected", "success");
    load();
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ data & wiring

async function load() {
  const tab = state.tab;
  panel().innerHTML = `<div class="card pad">${skeleton(5)}</div>`;
  try {
    if (tab === "registrations") {
      const r = await api(`/registrations?status=${encodeURIComponent(state.status || "pending")}`);
      if (tab !== state.tab) return;
      state.rows = r.results;
      setCount("registrations", r.pending);
      panel().innerHTML = registrationsView(r.results);
    } else {
      const r = await api(`/suggestions${state.status ? `?status=${encodeURIComponent(state.status)}` : ""}`);
      if (tab !== state.tab) return;
      state.rows = r.results;
      setCount("suggestions", r.counts.pending || 0);
      panel().innerHTML = suggestionsView(r.results);
    }
  } catch (e) {
    panel().innerHTML = html`<div class="card">${empty(e.message, "alert")}</div>`;
  }
}

function select(tab) {
  state.tab = tab;
  state.status = "pending";
  $$("#rq-tabs [role=tab]").forEach((t) => { const on = t.dataset.tab === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
  panel().setAttribute("aria-labelledby", `tab-${tab}`);
  $("#rq-status").innerHTML = html`${STATUSES[tab].map(([v, l]) => html`<option value="${v}" ${v === state.status ? "selected" : ""}>${l}</option>`)}`;
  history.replaceState(null, "", `#${tab}`);
  load();
}

export default async function init() {
  try { state.lookups = await api("/lookups"); } catch (e) { toast(e.message, "error"); }
  const tabs = $$("#rq-tabs [role=tab]");
  $("#rq-tabs").addEventListener("click", (e) => { const t = e.target.closest("[role=tab]"); if (t) select(t.dataset.tab); });
  $("#rq-tabs").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const next = tabs[(i + 1) % tabs.length];
    next.focus();
    select(next.dataset.tab);
  });
  $("#rq-status").addEventListener("change", (e) => { state.status = e.target.value; load(); });
  $("#rq-refresh").addEventListener("click", (e) => withBusy(e.currentTarget, load).catch(() => {}));
  panel().addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.approve) approve(Number(b.dataset.approve));
    else if (b.dataset.reject) reject(Number(b.dataset.reject));
    else if (b.dataset.accept) accept(Number(b.dataset.accept));
    else if (b.dataset.sreject) rejectSuggestion(Number(b.dataset.sreject));
  });
  select(location.hash === "#suggestions" ? "suggestions" : "registrations");
  // Badge counts for the other tab
  api("/registrations/count").then((r) => setCount("registrations", r.pending)).catch(() => {});
  api("/suggestions?status=pending").then((r) => setCount("suggestions", r.counts.pending || 0)).catch(() => {});
}
