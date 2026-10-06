// Staff: one subscription — issue grid (receive / claim / missing), routing list, claims and settings.
import {
  $, $$, BOOT, api, badge, confirmDialog, date, empty, html, icon, num, qs, relative, skeleton, toast, withBusy,
} from "/static/js/core.js";
import { errorBox, formModal, isoDay, peoplePicker, plural, str } from "/static/js/pages/lib/sc-ui.js";
import { claimDialog, endsBadge, issueBadge, renewDialog, subBadge } from "/static/js/pages/serials/common.js";
import { priceLabel, subscriptionForm } from "/static/js/pages/serials/form.js";

const sid = () => +BOOT.path_params.subscription_id;
const st = { sub: null, issues: [], years: [], filter: "all", year: "", focusId: null };
const FILTERS = [["all", "All"], ["outstanding", "Late & claimed"], ["expected", "Expected"], ["arrived", "Arrived"],
  ["missing,not_published", "Missing / not published"]];
const OPEN = new Set(["expected", "late", "claimed", "missing"]);
const CLAIMABLE = new Set(["late", "claimed", "missing"]);

// ------------------------------------------------------------------ rendering

function header(s) {
  const active = s.status === "active";
  return html`<div class="page-head">
    <div>
      <div class="row tight" style="margin-bottom:.35rem">${subBadge(s.status)}${badge("info", s.frequency_label)}${endsBadge(s)}</div>
      <h1>${s.biblio.title}</h1>
      <div class="sub">${s.numbering_pattern} · ${s.vendor ? s.vendor.name : "No vendor"} · ${s.branch.name} ·
        <a href="/staff/catalog/${s.biblio.id}">Catalogue record</a></div>
    </div>
    <div class="row tight">
      <button class="btn" data-act-sub="edit">${icon("edit")}Edit</button>
      ${s.status !== "cancelled" ? html`<button class="btn" data-act-sub="add">${icon("plus")}Add issue</button>` : ""}
      ${active && s.frequency !== "irregular" ? html`<button class="btn" data-act-sub="generate">${icon("clock")}Predict issues</button>` : ""}
      <button class="btn" data-act-sub="renew">${icon("refresh")}Renew</button>
      ${s.status !== "cancelled" ? html`<button class="btn danger" data-act-sub="cancel">${icon("x")}Cancel</button>` : ""}
    </div></div>
    <div class="row tight sc-counts" aria-label="Issue counts">${Object.entries({ expected: "Expected", arrived: "Arrived", late: "Late", claimed: "Claimed", missing: "Missing", not_published: "Not published" })
      .map(([k, l]) => html`<span class="sc-count"><span class="num">${num(s.counts[k] || 0)}</span> ${l}</span>`)}
      ${s.next_issue ? html`<span class="sc-count">Next: <strong>${s.next_issue.enumeration}</strong> · ${date(s.next_issue.expected_on)} (${relative(s.next_issue.expected_on)})</span>` : ""}</div>`;
}

function actions(i) {
  const b = (act, label, cls = "") => html`<button class="btn sm ${cls}" data-act="${act}" data-id="${i.id}" aria-label="${label} ${i.enumeration}">${label}</button>`;
  const out = [];
  if (OPEN.has(i.status)) out.push(b("receive", "Receive", "primary"));
  if (CLAIMABLE.has(i.status)) out.push(b("claim", i.claim_count ? "Claim again" : "Claim"));
  if (["expected", "late", "claimed"].includes(i.status)) out.push(b("missing", "Missing"));
  if (["missing", "not_published"].includes(i.status)) out.push(b("reopen", "Reopen"));
  if (i.status === "expected") out.push(b("notpub", "Not published", "ghost"));
  if (i.status === "arrived") out.push(b("undo", "Undo receive", "ghost"));
  if (i.manual && i.status !== "arrived") out.push(b("delete", "Delete", "danger"));
  return out;
}

function issueRow(i) {
  return html`<tr tabindex="0" data-row="${i.id}" class="sc-issue" aria-label="${i.enumeration}, ${i.status.replace("_", " ")}">
    <td><input type="checkbox" data-sel="${i.id}" aria-label="Select ${i.enumeration}" tabindex="-1"></td>
    <td><strong>${i.enumeration}</strong> ${i.manual ? badge("", "Manual") : ""}<div class="tiny muted">${i.chronology || ""}</div></td>
    <td class="nowrap">${date(i.expected_on)}${i.days_late ? html`<div class="tiny muted">${plural(i.days_late, "day")} ago</div>` : ""}</td>
    <td>${issueBadge(i.status)}${i.claim_count ? html`<div class="tiny muted">Claimed ${i.claim_count}× · ${date(i.last_claimed_at)}</div>` : ""}</td>
    <td class="small">${i.received_on ? date(i.received_on) : html`<span class="muted">—</span>`}
      ${i.item ? html`<div class="tiny mono">${i.item.barcode}</div>` : ""}</td>
    <td class="right nowrap">${actions(i)}</td></tr>`;
}

function issuesCard() {
  return html`<section class="card flush" aria-labelledby="issues-h">
    <div class="card-head" style="flex-wrap:wrap">
      <h2 id="issues-h">Issues</h2>
      <div class="row tight">
        <div class="row tight" role="group" aria-label="Filter issues">${FILTERS.map(([k, l]) => html`<button class="chip" data-filter="${k}" aria-pressed="${st.filter === k}">${l}</button>`)}</div>
        <label for="iss-year" class="sr-only">Year</label>
        <select id="iss-year" style="width:auto"><option value="">All years</option>${st.years.map((y) => html`<option value="${y}" ${String(y) === st.year ? "selected" : ""}>${y}</option>`)}</select>
      </div>
    </div>
    <div class="row tight sc-bulkbar" id="iss-bulk" role="toolbar" aria-label="Bulk actions">
      <label class="checkbox small"><input type="checkbox" id="iss-all"> Select all</label>
      <span class="small muted" id="iss-selcount">No issues selected</span>
      <span class="spacer"></span>
      <button class="btn sm primary" data-bulk="receive" disabled>${icon("download")}Receive</button>
      <button class="btn sm" data-bulk="claim" disabled>${icon("send")}Claim</button>
      <button class="btn sm" data-bulk="missing" disabled>Mark missing</button>
      <button class="btn sm ghost" data-bulk="not_published" disabled>Not published</button>
    </div>
    <div class="card-body"><div class="table-wrap"><table class="table sc-issues">
      <caption class="sr-only">Issues of ${st.sub.biblio.title}</caption>
      <thead><tr><th scope="col"><span class="sr-only">Select</span></th><th scope="col">Issue</th><th scope="col">Expected</th><th scope="col">Status</th>
        <th scope="col">Received</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody id="iss-body"></tbody></table></div>
      <p class="tiny muted sc-kbd-hint">Keyboard: <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>R</kbd> receive · <kbd>C</kbd> claim · <kbd>M</kbd> missing · <kbd>Space</kbd> select · <kbd>Enter</kbd> receive</p>
    </div></section>`;
}

function sidePanel(s) {
  const rows = [
    ["Period", html`${date(s.start_date)} – ${s.end_date ? date(s.end_date) : "open-ended"}`],
    ["First issue", s.first_issue_on ? date(s.first_issue_on) : date(s.start_date)],
    ["Frequency", s.frequency_label + (s.skip_weekdays?.length ? ` (skips ${s.skip_weekdays.map((d) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d]).join(", ")})` : "")],
    ["Numbering", html`<code>${s.numbering_pattern}</code>`],
    ["Grace period", plural(s.grace_days, "day")],
    ["Vendor", s.vendor ? html`${s.vendor.name}${s.vendor_reference ? html` <span class="muted small">ref ${s.vendor_reference}</span>` : ""}` : "—"],
    ["Budget", s.budget ? `${s.budget.name} · FY ${s.budget.fiscal_year}` : "—"],
    ["Annual cost", priceLabel(s.price)],
    ["Receiving", s.create_items ? html`Creates ${s.item_type?.name || "an"} item${s.shelf_location ? ` in ${s.shelf_location}` : ""} at ${s.branch.name}` : "No items created"],
  ];
  return html`<div class="stack">
    <section class="card pad" aria-labelledby="sd-h"><h3 id="sd-h" style="margin-top:0">Subscription</h3>
      <dl class="dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      ${s.notes ? html`<p class="small" style="margin:.75rem 0 0;white-space:pre-line">${s.notes}</p>` : ""}</section>
    <section class="card pad" aria-labelledby="rt-h">
      <div class="row between"><h3 id="rt-h" style="margin:0">Routing list</h3><button class="btn sm" data-act-sub="routing">${icon("users")}Edit</button></div>
      ${s.routing.length ? html`<ol class="sc-routing">${s.routing.map((r) => html`<li>${r.name}${r.notes ? html` <span class="muted small">— ${r.notes}</span>` : ""}</li>`)}</ol>`
        : html`<p class="small muted" style="margin:.5rem 0 0">No routing list. Received issues go straight to the shelf.</p>`}</section>
    <section class="card pad" aria-labelledby="ch-h"><h3 id="ch-h" style="margin-top:0">Recent claims</h3><div id="sub-claims">${skeleton(2)}</div></section>
  </div>`;
}

function renderIssues() {
  const body = $("#iss-body");
  if (!body) return;
  body.innerHTML = st.issues.length ? html`${st.issues.map(issueRow)}`
    : html`<tr><td colspan="6">${empty(st.filter === "all" ? (st.sub.frequency === "irregular"
      ? "Irregular serial: add issues as they are announced." : "No issues predicted yet.") : "No issues match this filter.")}</td></tr>`;
  updateBulk();
  const target = st.focusId && $(`[data-row="${st.focusId}"]`, body);
  if (target) target.focus();
}

async function loadClaims() {
  try {
    const r = await api(`/serials/claims?${qs({ subscription_id: sid(), limit: 8 })}`);
    $("#sub-claims").innerHTML = r.results.length ? html`<ul class="sc-claims">${r.results.map((c) => html`<li>
        <a href="/staff/serials/claims/${c.batch}">${date(c.claimed_at)}</a> · ${c.issue.enumeration}
        <span class="tiny muted">(${c.vendor.name}${c.by ? `, ${c.by}` : ""})</span></li>`)}</ul>`
      : html`<p class="small muted" style="margin:0">No claims sent.</p>`;
  } catch (e) { $("#sub-claims").innerHTML = errorBox(e.message); }
}

async function loadIssues() {
  const status = st.filter === "all" ? "" : st.filter;
  const r = await api(`/serials/subscriptions/${sid()}/issues?${qs({ status, year: st.year })}`);
  st.issues = r.results;
  st.years = r.years;
  renderIssues();
}

async function load({ full = true } = {}) {
  const root = $("#sub-detail");
  try {
    st.sub = await api(`/serials/subscriptions/${sid()}`);
  } catch (e) {
    root.innerHTML = e.status === 404 ? empty("This subscription does not exist.", "alert") : errorBox(e.message);
    return;
  }
  document.title = `${st.sub.biblio.title} · Serials`;
  if (full || !$("#iss-body")) {
    const r = await api(`/serials/subscriptions/${sid()}/issues?${qs({ status: st.filter === "all" ? "" : st.filter, year: st.year })}`);
    st.issues = r.results;
    st.years = r.years;
    root.innerHTML = html`<div id="sub-head">${header(st.sub)}</div>
      <div class="grid split" style="margin-top:1rem"><div>${issuesCard()}</div><div id="sub-side">${sidePanel(st.sub)}</div></div>`;
    renderIssues();
    loadClaims();
  } else {
    $("#sub-head").innerHTML = header(st.sub);
    $("#sub-side").innerHTML = sidePanel(st.sub);
    loadClaims();
    await loadIssues();
  }
}

const refresh = () => load({ full: false }).catch((e) => toast(e.message, "error"));

// ------------------------------------------------------------------ selection & bulk actions

const selected = () => $$("[data-sel]:checked").map((c) => +c.dataset.sel);
const byId = (id) => st.issues.find((i) => i.id === id);

function updateBulk() {
  const n = selected().length;
  $("#iss-selcount").textContent = n ? `${plural(n, "issue")} selected` : "No issues selected";
  $$("#iss-bulk [data-bulk]").forEach((b) => { b.disabled = !n; });
  const all = $("#iss-all");
  const boxes = $$("[data-sel]");
  all.checked = !!boxes.length && n === boxes.length;
  all.indeterminate = n > 0 && n < boxes.length;
}

async function setStatus(ids, status) {
  const r = await api("/serials/issues/status", { method: "POST", body: { issue_ids: ids, status } });
  toast(`${plural(r.updated, "issue")} ${status === "expected" ? "reopened" : `marked ${status.replace("_", " ")}`}`, "success");
  await refresh();
}

async function bulk(kind, btn) {
  const ids = selected();
  if (!ids.length) return;
  const issues = ids.map(byId).filter(Boolean);
  try {
    if (kind === "claim") {
      const bad = issues.filter((i) => !CLAIMABLE.has(i.status));
      if (bad.length) { toast(`Only late, missing or claimed issues can be claimed (${bad.map((i) => i.enumeration).slice(0, 3).join(", ")}…)`, "error"); return; }
      if (await claimDialog(issues.map((i) => ({ ...i, title: st.sub.biblio.title, vendorName: st.sub.vendor?.name })))) await refresh();
    } else if (kind === "receive") {
      const body = html`<div class="stack"><p style="margin:0">Receive <strong>${plural(issues.length, "issue")}</strong> of ${st.sub.biblio.title}.
        ${st.sub.create_items ? "Each gets a new item with an automatic barcode." : ""}</p>
        <div class="field"><label for="br-date">Received on</label><input id="br-date" name="received_on" type="date" required value="${isoDay()}"></div>
        <label class="checkbox"><input type="checkbox" name="create_item" ${st.sub.create_items ? "checked" : ""}> Create items</label></div>`;
      const r = await formModal({ title: "Receive issues", body, submit: "Receive" }, (fd) => api("/serials/issues/receive", {
        method: "POST", body: { issue_ids: ids, received_on: fd.get("received_on"), create_item: !!fd.get("create_item") } }));
      if (r) { toast(`Received ${plural(r.received, "issue")}`, "success"); await refresh(); }
    } else {
      await withBusy(btn, () => setStatus(ids, kind));
    }
  } catch (e) { if (!e.toasted) toast(e.message, "error"); }
}

// ------------------------------------------------------------------ row actions

async function receiveDialog(issue) {
  const s = st.sub;
  const call = `${s.call_number || ""} ${issue.enumeration}`.trim();
  const body = html`<div class="stack">
    <p style="margin:0">Receive <strong>${issue.enumeration}</strong> <span class="muted">(${issue.chronology || ""}, expected ${date(issue.expected_on)})</span>.</p>
    <div class="grid cols-2">
      <div class="field"><label for="rc-date">Received on</label><input id="rc-date" name="received_on" type="date" required value="${isoDay()}"></div>
      <div class="field"><label class="checkbox" style="margin-top:1.6rem"><input type="checkbox" name="create_item" id="rc-create" ${s.create_items ? "checked" : ""}> Create an item</label></div>
    </div>
    <div class="grid cols-2" id="rc-item">
      <div class="field"><label for="rc-barcode">Barcode <span class="muted">(scan, or leave blank)</span></label><input id="rc-barcode" name="barcode" class="mono" maxlength="32" autocomplete="off" pattern="[A-Za-z0-9\\-_.]*"></div>
      <div class="field"><label for="rc-call">Call number</label><input id="rc-call" name="call_number" maxlength="64" placeholder="${call}"></div>
    </div>
    <div class="field"><label for="rc-notes">Note <span class="muted">(optional)</span></label><input id="rc-notes" name="notes" maxlength="255"></div>
    ${s.routing.length ? html`<div class="alert info">${icon("users")}<div>Routing list: ${s.routing.map((r) => r.name).join(" → ")}</div></div>` : ""}
  </div>`;
  const r = await formModal({ title: "Receive issue", body, submit: "Receive" }, (fd) => api(`/serials/issues/${issue.id}/receive`, {
    method: "POST",
    body: { received_on: fd.get("received_on"), create_item: !!fd.get("create_item"), barcode: str(fd, "barcode") || null,
      call_number: str(fd, "call_number") || null, notes: str(fd, "notes") || null },
  }), (dlg) => {
    const sync = () => $("#rc-item", dlg).classList.toggle("hidden", !$("#rc-create", dlg).checked);
    $("#rc-create", dlg).addEventListener("change", sync);
    sync();
    if (s.create_items) setTimeout(() => $("#rc-barcode", dlg).focus(), 0);
  });
  if (!r) return;
  const route = r.routing.length ? ` · route to ${r.routing.map((p) => p.name).join(" → ")}` : "";
  toast(`Received ${r.issue.enumeration}${r.issue.item ? ` · item ${r.issue.item.barcode}` : ""}${route}`, "success", 7000);
  await refresh();
}

async function rowAction(act, id, btn) {
  const issue = byId(id);
  if (!issue) return;
  st.focusId = id;
  try {
    if (act === "receive") await receiveDialog(issue);
    else if (act === "claim") {
      if (await claimDialog([{ ...issue, title: st.sub.biblio.title, vendorName: st.sub.vendor?.name }])) await refresh();
    } else if (act === "missing") await withBusy(btn, () => setStatus([id], "missing"));
    else if (act === "notpub") await withBusy(btn, () => setStatus([id], "not_published"));
    else if (act === "reopen") await withBusy(btn, () => setStatus([id], "expected"));
    else if (act === "undo") {
      if (!(await confirmDialog("Undo receipt?", `${issue.enumeration} goes back to expected${issue.item ? ` and item ${issue.item.barcode} is deleted` : ""}. This is only possible if the item has never been loaned.`, "Undo receipt"))) return;
      await withBusy(btn, () => api(`/serials/issues/${id}/undo-receive`, { method: "POST" }));
      toast(`Receipt of ${issue.enumeration} undone`, "success");
      await refresh();
    } else if (act === "delete") {
      if (!(await confirmDialog("Delete issue?", `Delete the manually added issue “${issue.enumeration}”?`, "Delete"))) return;
      await withBusy(btn, () => api(`/serials/issues/${id}`, { method: "DELETE" }));
      toast("Issue deleted", "success");
      await refresh();
    }
  } catch (e) { if (!e.toasted) toast(e.message, "error"); }
}

// ------------------------------------------------------------------ subscription-level actions

async function subAction(act) {
  const s = st.sub;
  if (act === "edit") {
    const r = await subscriptionForm(s);
    if (r) {
      const g = r.regenerated;
      toast(g ? `Saved · predictions refreshed (${g.created} new, ${g.updated} updated, ${g.removed} removed)` : "Saved", "success");
      await load();
    }
  } else if (act === "renew") {
    if (await renewDialog(s)) await load();
  } else if (act === "cancel") {
    const r = await formModal({ title: "Cancel subscription", submit: "Cancel subscription", danger: true, body: html`<div class="stack">
      <p style="margin:0">Cancel the subscription to <strong>${s.biblio.title}</strong>? Future predicted issues that have not been touched are removed; received and claimed issues are kept.</p>
      <div class="field"><label for="cn-reason">Reason <span class="muted">(optional)</span></label><input id="cn-reason" name="reason" maxlength="255"></div></div>` },
    (fd) => api(`/serials/subscriptions/${s.id}/cancel`, { method: "POST", body: { reason: str(fd, "reason") || null } }));
    if (r) { toast(`Subscription cancelled · ${plural(r.removed, "future issue")} removed`, "success"); await load(); }
  } else if (act === "generate") {
    const r = await formModal({ title: "Predict issues", submit: "Predict", body: html`<div class="stack">
      <p style="margin:0">Create or refresh predicted issues. Issues already received, claimed, marked missing or added by hand are never changed.</p>
      <div class="field"><label for="gn-h">Predict up to</label><select id="gn-h" name="horizon_days">
        ${[[90, "3 months ahead"], [180, "6 months ahead"], [365, "1 year ahead"], [730, "2 years ahead"]].map(([v, l]) => html`<option value="${v}" ${v === 180 ? "selected" : ""}>${l}</option>`)}</select>
        <span class="hint">Never beyond the subscription end date.</span></div></div>` },
    (fd) => api(`/serials/subscriptions/${s.id}/generate`, { method: "POST", body: { horizon_days: Number(fd.get("horizon_days")) } }));
    if (r) { toast(`${plural(r.created, "new issue")}, ${r.updated} updated, ${r.removed} removed`, "success"); await refresh(); }
  } else if (act === "add") {
    const irregular = s.frequency === "irregular";
    const r = await formModal({ title: "Add an issue", submit: "Add issue", body: html`<div class="stack">
      <p class="small muted" style="margin:0">${irregular ? "Leave the enumeration blank to continue the numbering pattern." : "Use this for special issues, supplements or an issue the prediction missed."}</p>
      <div class="grid cols-2">
        <div class="field"><label for="ai-date">Expected on</label><input id="ai-date" name="expected_on" type="date" required value="${isoDay()}"></div>
        <div class="field"><label for="ai-enum">Enumeration</label><input id="ai-enum" name="enumeration" maxlength="160" ${irregular ? "" : "required"} placeholder="${irregular ? "Next in pattern" : "e.g. Special issue"}"></div>
        <div class="field"><label for="ai-chron">Chronology <span class="muted">(optional)</span></label><input id="ai-chron" name="chronology" maxlength="64" placeholder="e.g. Winter 2026"></div>
        <div class="field"><label for="ai-notes">Note <span class="muted">(optional)</span></label><input id="ai-notes" name="notes" maxlength="255"></div>
      </div></div>` },
    (fd) => api(`/serials/subscriptions/${s.id}/issues`, { method: "POST", body: {
      expected_on: fd.get("expected_on"), enumeration: str(fd, "enumeration") || null, chronology: str(fd, "chronology") || null, notes: str(fd, "notes") || null } }));
    if (r) { toast(`Added ${r.enumeration}`, "success"); st.focusId = r.id; await refresh(); }
  } else if (act === "routing") {
    let picker;
    const r = await formModal({ title: "Routing list", submit: "Save routing list", body: html`<div class="stack">
      <p class="small muted" style="margin:0">Received issues are passed along this list in order before going to the shelf.</p><div id="rt-picker"></div></div>` },
    () => api(`/serials/subscriptions/${s.id}/routing`, { method: "PUT", body: { entries: picker.value().map((p) => ({ patron_id: p.id, notes: p.notes || null })) } }),
    (dlg) => { picker = peoplePicker($("#rt-picker", dlg), { selected: s.routing.map((p) => ({ id: p.patron_id, name: p.name, card_number: p.card_number, notes: p.notes })), ordered: true, notes: true, label: "Add staff member or patron" }); });
    if (r) { toast("Routing list saved", "success"); await refresh(); }
  }
}

// ------------------------------------------------------------------ init

export default async function init() {
  const root = $("#sub-detail");
  root.addEventListener("click", (e) => {
    const sa = e.target.closest("[data-act-sub]"), a = e.target.closest("[data-act]"), f = e.target.closest("[data-filter]"), b = e.target.closest("[data-bulk]");
    if (sa) subAction(sa.dataset.actSub).catch((err) => toast(err.message, "error"));
    else if (a) rowAction(a.dataset.act, +a.dataset.id, a);
    else if (b) bulk(b.dataset.bulk, b);
    else if (f) {
      st.filter = f.dataset.filter;
      $$("[data-filter]", root).forEach((x) => x.setAttribute("aria-pressed", x === f));
      loadIssues().catch((err) => toast(err.message, "error"));
    } else if (e.target.closest("tr[data-row]") && !e.target.closest("button,input,a")) {
      e.target.closest("tr[data-row]").focus();
    }
  });
  root.addEventListener("change", (e) => {
    if (e.target.id === "iss-all") { $$("[data-sel]").forEach((c) => { c.checked = e.target.checked; }); updateBulk(); }
    else if (e.target.matches("[data-sel]")) updateBulk();
    else if (e.target.id === "iss-year") { st.year = e.target.value; loadIssues().catch((err) => toast(err.message, "error")); }
  });
  root.addEventListener("keydown", (e) => {
    const row = e.target.closest?.("tr[data-row]");
    if (!row || e.target !== row || e.ctrlKey || e.metaKey || e.altKey) return;
    const rows = $$("tr[data-row]", root);
    const i = rows.indexOf(row), id = +row.dataset.row, issue = byId(id);
    const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1 }[e.key];
    if (move !== undefined) { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, move))]?.focus(); return; }
    const key = e.key.toLowerCase();
    if (key === " " || key === "x") { e.preventDefault(); const c = $("[data-sel]", row); c.checked = !c.checked; updateBulk(); return; }
    const act = { r: "receive", enter: "receive", c: "claim", m: "missing", u: "undo" }[key];
    if (!act || !issue) return;
    const btn = $(`[data-act="${act}"]`, row);
    if (btn) { e.preventDefault(); rowAction(act, id, btn); }
  });
  await load();
}
