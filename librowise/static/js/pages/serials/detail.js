// Staff › Serials › Subscription — detail header, keyboard-first issue grid (↑/↓ or J/K move, R or Enter receive,
// C claim, M missing, U undo receipt, Space/X select; bulk receive / claim / missing), facts, routing and claims.
import { $, $$, BOOT, api, confirmDialog, date, html, icon, num, qs, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { setCrumb } from "/static/js/ui/page-header.js";
import { actionMenu, facts, wireMenus } from "/static/js/pages/lib/collection.js";
import { formModal, isoDay, peoplePicker, relDay, str } from "/static/js/pages/lib/sc-ui.js";
import { claimDialog, endsBadge, freqLabel, issueBadge, renewDialog, subBadge } from "/static/js/pages/serials/common.js";
import { priceLabel, subscriptionForm } from "/static/js/pages/serials/form.js";

const sid = () => +BOOT.path_params.subscription_id;
const st = { sub: null, issues: [], years: [], filter: "all", year: "", focusId: null, can: false, table: null };
const FILTERS = [["all", "coll.ser.f_all"], ["outstanding", "coll.ser.f_outstanding"], ["expected", "coll.ser.f_expected"], ["arrived", "coll.ser.f_arrived"],
  ["missing,not_published", "coll.ser.f_missing"]];
const OPEN = new Set(["expected", "late", "claimed", "missing"]);
const CLAIMABLE = new Set(["late", "claimed", "missing"]);
const root = () => $("#sub-detail");
const weekday = (i) => new Intl.DateTimeFormat(document.documentElement.lang || "en", { weekday: "short" }).format(new Date(Date.UTC(2024, 0, 1 + i)));

// ------------------------------------------------------------------ header

function header(s) {
  const active = s.status === "active";
  const next = s.next_issue && st.issues.find((i) => i.id === s.next_issue.id);
  const menu = st.can ? actionMenu({ label: t("coll.ser.more_actions"), items: [
    { id: "edit", label: t("coll.ser.edit"), icon: "edit" },
    active && s.frequency !== "irregular" ? { id: "generate", label: t("coll.ser.predict"), icon: "clock" } : null,
    { id: "routing", label: t("coll.ser.routing_edit"), icon: "users" },
    { id: "renew", label: t("coll.ser.renew_ellipsis"), icon: "refresh" },
    { href: `/staff/catalog/${s.biblio.id}`, label: t("coll.ser.catalogue_record"), icon: "book" },
    s.status !== "cancelled" ? { separator: true } : null,
    s.status !== "cancelled" ? { id: "cancel", label: t("coll.ser.cancel_sub"), icon: "x", danger: true } : null,
  ] }) : "";
  return html`<header class="detail-head no-cover">
    <div class="dh-main">
      <div class="dh-eyebrow"><span>${freqLabel(s)}</span><span>${s.branch.name}</span>${s.vendor ? html`<span>${s.vendor.name}</span>` : ""}</div>
      <h1 id="page-title">${s.biblio.title}</h1>
      <p class="dh-meta"><span class="mono">${s.numbering_pattern}</span>${s.biblio.issn ? html`<span class="muted">ISSN ${s.biblio.issn}</span>` : ""}</p>
      <div class="dh-pills">${subBadge(s.status)}${endsBadge(s)}</div>
    </div>
    <div class="dh-actions">${menu}
      ${st.can && s.status !== "cancelled" ? html`<button type="button" class="btn" data-act-sub="add">${icon("plus")}${t("coll.ser.add_issue")}</button>` : ""}
      ${st.can && next && OPEN.has(next.status) ? html`<button type="button" class="btn primary" data-act="receive" data-id="${next.id}">${icon("download")}${t("coll.ser.receive_next", { issue: next.enumeration })}</button>` : ""}
    </div></header>
  <ul class="count-strip" role="list" aria-label="${t("coll.ser.issue_counts")}">
    ${["expected", "arrived", "late", "claimed", "missing", "not_published"].map((k) => html`<li class="${s.counts[k] ? "" : "zero"}">${issueBadge(k)}<span class="num">${num(s.counts[k] || 0)}</span></li>`)}
    ${s.next_issue ? html`<li class="next">${t("coll.ser.next", { issue: s.next_issue.enumeration, date: date(s.next_issue.expected_on), rel: relDay(s.next_issue.expected_on) })}</li>` : ""}</ul>`;
}

// ------------------------------------------------------------------ issues

function rowActions(i) {
  if (!st.can) return "";
  const primary = OPEN.has(i.status) ? html`<button type="button" class="btn sm" data-act="receive" data-id="${i.id}" aria-label="${t("coll.ser.receive_named", { issue: i.enumeration })}" aria-keyshortcuts="R">${icon("download")}<span>${t("coll.ser.receive")}</span></button>`
    : "";
  const items = [
    CLAIMABLE.has(i.status) ? { id: "claim", label: i.claim_count ? t("coll.ser.claim_again") : t("coll.ser.claim"), icon: "send" } : null,
    ["expected", "late", "claimed"].includes(i.status) ? { id: "missing", label: t("coll.ser.mark_missing"), icon: "alert" } : null,
    i.status === "expected" ? { id: "notpub", label: t("coll.ser.mark_not_published"), icon: "x-circle" } : null,
    ["missing", "not_published"].includes(i.status) ? { id: "reopen", label: t("coll.ser.reopen"), icon: "refresh" } : null,
    i.status === "arrived" ? { id: "undo", label: t("coll.ser.undo_receive"), icon: "refresh" } : null,
    i.manual && i.status !== "arrived" ? { separator: true } : null,
    i.manual && i.status !== "arrived" ? { id: "delete", label: t("coll.ser.delete_issue"), icon: "trash", danger: true } : null,
  ].filter(Boolean);
  return html`<div class="row-actions">${primary}${items.length ? actionMenu({ label: t("coll.ser.issue_actions", { issue: i.enumeration }), size: "sm", data: String(i.id), items }) : ""}</div>`;
}

function issueColumns() {
  return [
    { key: "issue", label: t("coll.ser.issue"), primary: true, hideable: false, csv: (i) => i.enumeration,
      render: (i) => html`<div class="dt-cell-stack"><strong class="nowrap">${i.enumeration}</strong><span class="sub">${[i.chronology, i.manual ? t("coll.ser.manual") : ""].filter(Boolean).join(" · ")}</span></div>` },
    { key: "expected", label: t("coll.ser.expected"), csv: (i) => i.expected_on,
      render: (i) => html`<div class="dt-cell-stack"><span class="nowrap">${date(i.expected_on)}</span>${i.days_late ? html`<span class="sub">${t("coll.ser.days_late_n", { count: i.days_late, n: num(i.days_late) })}</span>` : ""}</div>` },
    { key: "status", label: t("coll.acq.col_status"), csv: (i) => i.status,
      render: (i) => html`<div class="dt-cell-stack">${issueBadge(i.status)}${i.claim_count ? html`<span class="sub">${t("coll.ser.claimed_times", { count: i.claim_count, n: num(i.claim_count) })} · ${date(i.last_claimed_at)}</span>` : ""}</div>` },
    { key: "received", label: t("coll.ser.received"), csv: (i) => i.received_on || "",
      render: (i) => (i.received_on ? html`<div class="dt-cell-stack"><span>${date(i.received_on)}</span>${i.item ? html`<span class="sub mono">${i.item.barcode}</span>` : ""}</div>` : html`<span class="muted">—</span>`) },
    { key: "act", label: t("coll.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions", render: rowActions },
  ];
}

function issuesSection() {
  return html`<section class="card issues-card" aria-labelledby="issues-h">
    <div class="card-head issues-head"><h2 id="issues-h">${t("coll.ser.issues")}</h2>
      <div class="row tight">
        <div class="segmented" role="radiogroup" aria-label="${t("coll.ser.filter_issues")}">${FILTERS.map(([k, l]) => html`<button type="button" role="radio" data-filter="${k}" aria-checked="${st.filter === k}" tabindex="${st.filter === k ? 0 : -1}">${t(l)}</button>`)}</div>
        <span class="select-chip ${st.year ? "active" : ""}"><label class="sr-only" for="iss-year">${t("coll.ser.year")}</label><select id="iss-year">
          <option value="">${t("coll.ser.all_years")}</option>${st.years.map((y) => html`<option value="${y}" ${String(y) === st.year ? "selected" : ""}>${y}</option>`)}</select></span>
      </div></div>
    <div class="card-body"><div id="issues-table"></div>
      ${st.can ? html`<p class="small muted kbd-help">${t("coll.ser.keys")}</p>` : ""}</div></section>`;
}

function sideHtml(s) {
  const rows = [
    [t("coll.ser.period"), html`${date(s.start_date)} – ${s.end_date ? date(s.end_date) : t("coll.ser.open_ended")}`],
    [t("coll.sf.first"), date(s.first_issue_on || s.start_date)],
    [t("coll.sf.frequency"), `${freqLabel(s)}${s.skip_weekdays?.length ? ` (${t("coll.ser.skips", { days: s.skip_weekdays.map(weekday).join(", ") })})` : ""}`],
    [t("coll.sf.numbering"), html`<code>${s.numbering_pattern}</code>`],
    [t("coll.sf.grace"), num(s.grace_days)],
    [t("coll.acq.col_vendor"), s.vendor ? html`${s.vendor.name}${s.vendor_reference ? html` <span class="muted small">${t("coll.ser.ref", { ref: s.vendor_reference })}</span>` : ""}` : "—"],
    [t("coll.acq.col_budget"), s.budget ? `${s.budget.name} · ${t("coll.acq.fy", { year: String(s.budget.fiscal_year) })}` : "—"],
    [t("coll.sf.annual_cost"), priceLabel(s.price)],
    [t("coll.sf.receiving"), s.create_items ? t("coll.ser.creates_items", { type: s.item_type?.name || "—", location: s.shelf_location || "—", branch: s.branch.name }) : t("coll.ser.no_items")],
  ];
  return html`<section class="card" aria-labelledby="sd-h"><div class="card-head"><h2 id="sd-h">${t("coll.ser.subscription")}</h2></div>
      <div class="card-body">${facts(rows)}${s.notes ? html`<p class="small sub-notes">${s.notes}</p>` : ""}</div></section>
    <section class="card" aria-labelledby="rt-h"><div class="card-head"><h2 id="rt-h">${t("coll.ser.routing")}</h2>
        ${st.can ? html`<button type="button" class="btn sm" data-act-sub="routing">${icon("users")}${t("coll.common.edit")}</button>` : ""}</div>
      <div class="card-body">${s.routing.length ? html`<ol class="sc-routing">${s.routing.map((r) => html`<li>${r.name}${r.notes ? html` <span class="muted small">— ${r.notes}</span>` : ""}</li>`)}</ol>`
        : html`<p class="small muted">${t("coll.ser.no_routing")}</p>`}</div></section>
    <section class="card" aria-labelledby="ch-h"><div class="card-head"><h2 id="ch-h">${t("coll.ser.recent_claims")}</h2></div>
      <div class="card-body" id="sub-claims"><div class="skeleton sk-line w-70"></div><div class="skeleton sk-line w-50"></div></div></section>`;
}

function render() {
  const s = st.sub;
  const el = root();
  el.removeAttribute("aria-busy");
  el.innerHTML = html`<div id="sub-head">${header(s)}</div><div class="coll-split serial-layout"><div>${issuesSection()}</div><aside class="stack" id="sub-side">${sideHtml(s)}</aside></div>`;
  wireMenus($("#sub-head"), (act) => subAction(act));
  st.table = dataTable($("#issues-table"), {
    id: "serial-issues", caption: t("coll.ser.issues_of", { title: s.biblio.title }), columns: issueColumns(), selectable: st.can,
    rowLabel: (i) => i.enumeration, exportName: `issues-${s.id}`,
    bulkActions: st.can ? [
      { id: "receive", label: t("coll.ser.receive"), icon: "download", run: (rows, ctx) => bulk("receive", rows, ctx) },
      { id: "claim", label: t("coll.ser.claim"), icon: "send", run: (rows, ctx) => bulk("claim", rows, ctx) },
      { id: "missing", label: t("coll.ser.mark_missing"), icon: "alert", run: (rows, ctx) => bulk("missing", rows, ctx) },
      { id: "not_published", label: t("coll.ser.mark_not_published"), icon: "x-circle", run: (rows, ctx) => bulk("not_published", rows, ctx) },
    ] : [],
    empty: { art: "inbox", compact: true, title: st.filter === "all" ? (s.frequency === "irregular" ? t("coll.ser.irregular_empty") : t("coll.ser.none_predicted")) : t("coll.ser.no_filter_match") },
  });
  paintIssues();
  loadClaims();
}

function paintIssues() {
  st.table.setRows(st.issues);
  wireMenus($("#issues-table"), (act, btn, key) => rowAction(act, +key, btn));
  const tr = st.focusId && $(`#issues-table tr[data-key="${st.focusId}"]`);
  if (tr) { $$("#issues-table tbody tr").forEach((r) => { r.tabIndex = -1; }); tr.tabIndex = 0; tr.focus(); }
}

async function loadClaims() {
  try {
    const r = await api(`/serials/claims?${qs({ subscription_id: sid(), limit: 8 })}`);
    $("#sub-claims").innerHTML = r.results.length ? html`<ul class="sc-claims">${r.results.map((c) => html`<li>
        <a href="/staff/serials/claims/${c.batch}">${date(c.claimed_at)}</a> · ${c.issue.enumeration}
        <span class="small muted">(${c.vendor.id ? c.vendor.name : t("coll.ser.no_vendor")}${c.by ? `, ${c.by}` : ""})</span></li>`)}</ul>`
      : html`<p class="small muted">${t("coll.ser.no_claims_sent")}</p>`;
  } catch (e) { $("#sub-claims").innerHTML = errorState(e, { retry: false }); }
}

async function loadIssues() {
  const r = await api(`/serials/subscriptions/${sid()}/issues?${qs({ status: st.filter === "all" ? "" : st.filter, year: st.year })}`);
  st.issues = r.results;
  st.years = r.years;
}

async function load() {
  st.sub = await api(`/serials/subscriptions/${sid()}`);
  await loadIssues();
  document.title = `${st.sub.biblio.title} · ${t("nav.serials")}`;
  setCrumb(st.sub.biblio.title);
}

async function refresh({ full = false } = {}) {
  try {
    await load();
    if (full) { render(); return; }
    $("#sub-head").innerHTML = header(st.sub);
    wireMenus($("#sub-head"), (act) => subAction(act));
    $("#sub-side").innerHTML = sideHtml(st.sub);
    st.table.clearSelection();
    paintIssues();
    loadClaims();
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ actions

const byId = (id) => st.issues.find((i) => i.id === id);

async function setStatus(ids, status) {
  const r = await api("/serials/issues/status", { method: "POST", body: { issue_ids: ids, status } });
  toast(t(`coll.ser.set_${status}`, { count: r.updated, n: num(r.updated) }), "success");
  await refresh();
}

async function bulk(kind, issues, { clear }) {
  const ids = issues.map((i) => i.id);
  try {
    if (kind === "claim") {
      const bad = issues.filter((i) => !CLAIMABLE.has(i.status));
      if (bad.length) { toast(t("coll.ser.only_claimable", { list: bad.map((i) => i.enumeration).slice(0, 3).join(", ") }), "error"); return; }
      if (await claimDialog(issues.map((i) => ({ ...i, title: st.sub.biblio.title, vendorName: st.sub.vendor?.name })))) { clear(); await refresh(); }
    } else if (kind === "receive") {
      const r = await formModal({ title: t("coll.ser.receive_issues"), submit: t("coll.ser.receive"), size: "sm", body: html`<div class="stack">
        <p>${t("coll.ser.receive_n", { count: issues.length, n: num(issues.length), title: st.sub.biblio.title })} ${st.sub.create_items ? t("coll.ser.each_item") : ""}</p>
        <div class="field"><label for="br-date">${t("coll.ser.received_on_label")}</label><input id="br-date" name="received_on" type="date" required value="${isoDay()}"></div>
        <label class="checkbox"><input type="checkbox" name="create_item" ${st.sub.create_items ? "checked" : ""}> ${t("coll.ser.create_items")}</label></div>` },
      (fd) => api("/serials/issues/receive", { method: "POST", body: { issue_ids: ids, received_on: fd.get("received_on"), create_item: !!fd.get("create_item") } }));
      if (r) { toast(t("coll.ser.received_n", { count: r.received, n: num(r.received) }), "success"); clear(); await refresh(); }
    } else {
      await setStatus(ids, kind);
      clear();
    }
  } catch (e) { if (!e.toasted) toast(e.message, "error"); }
}

async function receiveDialog(issue) {
  const s = st.sub;
  const call = `${s.call_number || ""} ${issue.enumeration}`.trim();
  const r = await formModal({ title: t("coll.ser.receive_issue"), submit: t("coll.ser.receive"), body: html`<div class="stack">
    <p>${t("coll.ser.receive_intro", { issue: issue.enumeration, chronology: issue.chronology || "", date: date(issue.expected_on) })}</p>
    <div class="form-grid">
      <div class="field"><label for="rc-date">${t("coll.ser.received_on_label")}</label><input id="rc-date" name="received_on" type="date" required value="${isoDay()}"></div>
      <label class="checkbox rc-create"><input type="checkbox" name="create_item" id="rc-create" ${s.create_items ? "checked" : ""}> ${t("coll.ser.create_item")}</label>
    </div>
    <div class="form-grid" id="rc-item">
      <div class="field"><label for="rc-barcode">${t("coll.items.barcode")}<span class="optional">${t("coll.ser.scan_or_blank")}</span></label><input id="rc-barcode" name="barcode" class="mono" maxlength="32" autocomplete="off" pattern="[A-Za-z0-9\\-_.]*"></div>
      <div class="field"><label for="rc-call">${t("coll.items.call_number")}</label><input id="rc-call" name="call_number" maxlength="64" placeholder="${call}"></div>
    </div>
    <div class="field"><label for="rc-notes">${t("coll.items.notes")}<span class="optional">${t("ui.form.optional")}</span></label><input id="rc-notes" name="notes" maxlength="255"></div>
    ${s.routing.length ? html`<div class="alert info">${icon("users")}<div>${t("coll.ser.routing_line", { list: s.routing.map((x) => x.name).join(" → ") })}</div></div>` : ""}
  </div>` }, (fd) => api(`/serials/issues/${issue.id}/receive`, {
    method: "POST",
    body: { received_on: fd.get("received_on"), create_item: !!fd.get("create_item"), barcode: str(fd, "barcode") || null,
      call_number: str(fd, "call_number") || null, notes: str(fd, "notes") || null },
  }), (dlg) => {
    const sync = () => { $("#rc-item", dlg).hidden = !$("#rc-create", dlg).checked; };
    $("#rc-create", dlg).addEventListener("change", sync);
    sync();
    if (s.create_items) setTimeout(() => $("#rc-barcode", dlg).focus(), 0);
  });
  if (!r) return;
  const route = r.routing.length ? ` · ${t("coll.ser.route_to", { list: r.routing.map((p) => p.name).join(" → ") })}` : "";
  toast(`${t("coll.ser.received_issue", { issue: r.issue.enumeration })}${r.issue.item ? ` · ${t("coll.ser.item_barcode", { barcode: r.issue.item.barcode })}` : ""}${route}`, "success", 7000);
  await refresh();
}

async function rowAction(act, id, btn) {
  const issue = byId(id);
  if (!issue) return;
  st.focusId = id;
  try {
    if (act === "receive") await receiveDialog(issue);
    else if (act === "claim") { if (await claimDialog([{ ...issue, title: st.sub.biblio.title, vendorName: st.sub.vendor?.name }])) await refresh(); }
    else if (act === "missing") await withBusy(btn, () => setStatus([id], "missing"));
    else if (act === "notpub") await withBusy(btn, () => setStatus([id], "not_published"));
    else if (act === "reopen") await withBusy(btn, () => setStatus([id], "expected"));
    else if (act === "undo") {
      if (!(await confirmDialog(t("coll.ser.undo_title"), t(issue.item ? "coll.ser.undo_text_item" : "coll.ser.undo_text", { issue: issue.enumeration, barcode: issue.item?.barcode || "" }), t("coll.ser.undo_receive")))) return;
      await api(`/serials/issues/${id}/undo-receive`, { method: "POST" });
      toast(t("coll.ser.undone", { issue: issue.enumeration }), "success");
      await refresh();
    } else if (act === "delete") {
      if (!(await confirmDialog(t("coll.ser.delete_title"), t("coll.ser.delete_text", { issue: issue.enumeration }), t("coll.ser.delete_issue")))) return;
      await api(`/serials/issues/${id}`, { method: "DELETE" });
      toast(t("coll.ser.issue_deleted"), "success");
      await refresh();
    }
  } catch (e) { if (!e.toasted) toast(e.message, "error"); }
}

async function subAction(act) {
  const s = st.sub;
  try {
    if (act === "edit") {
      const r = await subscriptionForm(s);
      if (r) {
        const g = r.regenerated;
        toast(g ? t("coll.ser.saved_regen", { created: num(g.created), updated: num(g.updated), removed: num(g.removed) }) : t("ui.form.saved"), "success");
        await refresh({ full: true });
      }
    } else if (act === "renew") {
      if (await renewDialog(s)) await refresh();
    } else if (act === "cancel") {
      const r = await formModal({ title: t("coll.ser.cancel_title"), submit: t("coll.ser.cancel_sub"), danger: true, size: "sm", body: html`<div class="stack">
        <p>${t("coll.ser.cancel_text", { title: s.biblio.title })}</p>
        <div class="field"><label for="cn-reason">${t("coll.ser.reason")}<span class="optional">${t("ui.form.optional")}</span></label><input id="cn-reason" name="reason" maxlength="255"></div></div>` },
      (fd) => api(`/serials/subscriptions/${s.id}/cancel`, { method: "POST", body: { reason: str(fd, "reason") || null } }));
      if (r) { toast(t("coll.ser.cancelled", { count: r.removed, n: num(r.removed) }), "success"); await refresh({ full: true }); }
    } else if (act === "generate") {
      const r = await formModal({ title: t("coll.ser.predict"), submit: t("coll.ser.predict_go"), size: "sm", body: html`<div class="stack">
        <p>${t("coll.ser.predict_intro")}</p>
        <div class="field"><label for="gn-h">${t("coll.ser.predict_up_to")}</label><select id="gn-h" name="horizon_days" aria-describedby="gn-h-h">
          ${[[90, "coll.ser.h_3m"], [180, "coll.ser.h_6m"], [365, "coll.ser.h_1y"], [730, "coll.ser.h_2y"]].map(([v, l]) => html`<option value="${v}" ${v === 180 ? "selected" : ""}>${t(l)}</option>`)}</select>
          <div class="field-help" id="gn-h-h">${t("coll.ser.predict_help")}</div></div></div>` },
      (fd) => api(`/serials/subscriptions/${s.id}/generate`, { method: "POST", body: { horizon_days: Number(fd.get("horizon_days")) } }));
      if (r) { toast(t("coll.ser.predicted", { created: num(r.created), updated: num(r.updated), removed: num(r.removed) }), "success"); await refresh(); }
    } else if (act === "add") {
      const irregular = s.frequency === "irregular";
      const r = await formModal({ title: t("coll.ser.add_issue"), submit: t("coll.ser.add_issue"), body: html`<div class="stack">
        <p class="small muted">${irregular ? t("coll.ser.add_irregular") : t("coll.ser.add_regular")}</p>
        <div class="form-grid">
          <div class="field"><label for="ai-date">${t("coll.ser.expected")}</label><input id="ai-date" name="expected_on" type="date" required value="${isoDay()}"></div>
          <div class="field"><label for="ai-enum">${t("coll.ser.enumeration")}</label><input id="ai-enum" name="enumeration" maxlength="160" ${irregular ? "" : "required"} placeholder="${irregular ? t("coll.ser.next_in_pattern") : t("coll.ser.enum_ph")}"></div>
          <div class="field"><label for="ai-chron">${t("coll.ser.chronology")}<span class="optional">${t("ui.form.optional")}</span></label><input id="ai-chron" name="chronology" maxlength="64"></div>
          <div class="field"><label for="ai-notes">${t("coll.items.notes")}<span class="optional">${t("ui.form.optional")}</span></label><input id="ai-notes" name="notes" maxlength="255"></div>
        </div></div>` },
      (fd) => api(`/serials/subscriptions/${s.id}/issues`, { method: "POST", body: {
        expected_on: fd.get("expected_on"), enumeration: str(fd, "enumeration") || null, chronology: str(fd, "chronology") || null, notes: str(fd, "notes") || null } }));
      if (r) { toast(t("coll.ser.added", { issue: r.enumeration }), "success"); st.focusId = r.id; await refresh(); }
    } else if (act === "routing") {
      let picker;
      const r = await formModal({ title: t("coll.ser.routing"), submit: t("coll.ser.save_routing"), body: html`<div class="stack">
        <p class="small muted">${t("coll.ser.routing_help")}</p><div id="rt-picker"></div></div>` },
      () => api(`/serials/subscriptions/${s.id}/routing`, { method: "PUT", body: { entries: picker.value().map((p) => ({ patron_id: p.id, notes: p.notes || null })) } }),
      (dlg) => { picker = peoplePicker($("#rt-picker", dlg), { selected: s.routing.map((p) => ({ id: p.patron_id, name: p.name, card_number: p.card_number, notes: p.notes })), ordered: true, notes: true, label: t("coll.ser.add_reader") }); });
      if (r) { toast(t("coll.ser.routing_saved"), "success"); await refresh(); }
    }
  } catch (e) { if (!e.toasted) toast(e.message, "error"); }
}

// ------------------------------------------------------------------ init

export default async function init() {
  st.can = root().dataset.canWrite === "1";
  try { await load(); } catch (e) {
    root().removeAttribute("aria-busy");
    root().innerHTML = e.status === 404 ? emptyState({ art: "search", title: t("coll.ser.not_found"), actions: html`<a class="btn primary" href="/staff/serials">${t("coll.ser.all_subs")}</a>` }) : errorState(e, { retry: false });
    return;
  }
  render();
  const el = root();
  el.addEventListener("click", (e) => {
    const sa = e.target.closest("[data-act-sub]"), a = e.target.closest("[data-act]"), f = e.target.closest("[data-filter]");
    if (sa) subAction(sa.dataset.actSub);
    else if (a) rowAction(a.dataset.act, +a.dataset.id, a);
    else if (f) setFilter(f.dataset.filter, f);
  });
  el.addEventListener("change", (e) => {
    if (e.target.id === "iss-year") { st.year = e.target.value; e.target.closest(".select-chip").classList.toggle("active", !!st.year); loadIssues().then(paintIssues).catch((err) => toast(err.message, "error")); }
  });
  // segmented filter: arrow keys move & select
  el.addEventListener("keydown", (e) => {
    const f = e.target.closest?.("[data-filter]");
    if (f) {
      const all = $$("[data-filter]", el);
      const i = all.indexOf(f);
      const rtl = getComputedStyle(f).direction === "rtl";
      const d = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
      if (d !== undefined) { e.preventDefault(); const n = all[(i + d + all.length) % all.length]; n.focus(); setFilter(n.dataset.filter, n); }
      return;
    }
    const row = e.target.closest?.("#issues-table tr[data-key]");
    if (!row || e.target !== row || e.ctrlKey || e.metaKey || e.altKey || !st.can) return;
    const act = { r: "receive", enter: "receive", c: "claim", m: "missing", u: "undo" }[e.key.toLowerCase()];
    const issue = byId(+row.dataset.key);
    if (!act || !issue) return;
    const allowed = { receive: OPEN.has(issue.status), claim: CLAIMABLE.has(issue.status), missing: ["expected", "late", "claimed"].includes(issue.status), undo: issue.status === "arrived" }[act];
    if (!allowed) return;
    e.preventDefault();
    e.stopPropagation();
    rowAction(act, issue.id, null);
  }, true);
}

function setFilter(key, btn) {
  st.filter = key;
  $$("[data-filter]", root()).forEach((x) => { const on = x === btn; x.setAttribute("aria-checked", String(on)); x.tabIndex = on ? 0 : -1; });
  loadIssues().then(paintIssues).catch((err) => toast(err.message, "error"));
}
