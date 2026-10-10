// Staff › Patrons › Requests — two review queues: OPAC self-registrations and patron purchase suggestions.
// Tabs (#registrations, #suggestions) → status views (?status=) → data table (J/K moves, Enter opens) →
// side-panel review with Approve/Reject (Accept/Reject for suggestions); bulk decisions run item by item.
import { $, api, date, datetime, html, icon, money, num, relative, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { avatar } from "/static/js/ui/avatar.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { modal } from "/static/js/ui/dialog.js";
import { errorState } from "/static/js/ui/empty.js";
import { sidePanel } from "/static/js/ui/panel.js";
import { statusPill } from "/static/js/ui/status.js";
import { wireTabsPanel } from "/static/js/ui/tabs.js";
import { dl, pill, wireKit } from "/static/js/pages/lib/admin-kit.js";
import { can, freshTableHost, onRowOpen, perms, setTabCount, tablePlaceholder } from "/static/js/pages/lib/people-ui.js";

const VIEWS = {
  registrations: [["pending", "people.requests.view.pending"], ["approved", "people.requests.view.approved"], ["rejected", "people.requests.view.rejected"], ["all", "people.requests.view.all"]],
  suggestions: [["pending", "people.requests.view.pending"], ["accepted", "people.requests.view.accepted"], ["ordered", "people.requests.view.ordered"],
    ["rejected", "people.requests.view.not_accepted"], ["withdrawn", "people.requests.view.withdrawn"], ["all", "people.requests.view.all"]],
};
const REG_STATUS = { pending: "people.requests.status.pending", approved: "people.requests.status.approved", rejected: "people.requests.status.rejected" };
const SUG_STATUS = { pending: "people.requests.status.pending", accepted: "people.requests.status.accepted", ordered: "people.requests.status.ordered",
  rejected: "people.requests.status.not_accepted", withdrawn: "people.requests.status.withdrawn" };
const FORMATS = { book: "people.format.book", ebook: "people.format.ebook", audiobook: "people.format.audiobook", dvd: "people.format.dvd",
  serial: "people.format.serial", comic: "people.format.comic", other: "people.format.other" };

const regPill = (s) => statusPill("registration", s, REG_STATUS[s] ? t(REG_STATUS[s]) : s);
const sugPill = (s) => statusPill("suggestion", s, SUG_STATUS[s] ? t(SUG_STATUS[s]) : s);
const formatName = (f) => (FORMATS[f] ? t(FORMATS[f]) : f);

const state = { tab: "registrations", status: "pending", rows: [], counts: { registrations: {}, suggestions: {} }, lookups: { branches: [], categories: [] } };
let P = new Set(), table = null, loadSeq = 0;
const VIEWS_SKELETON = '<div class="saved-views rq-views-sk" aria-hidden="true"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>';

// ------------------------------------------------------------------ URL (?status=, keeps the #tab hash)

function readStatus(tab) {
  const s = new URLSearchParams(location.search).get("status");
  return VIEWS[tab].some(([v]) => v === s) ? s : "pending";
}
function writeStatus() {
  const q = new URLSearchParams(location.search);
  if (state.status === "pending") q.delete("status"); else q.set("status", state.status);
  const qs = q.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}#${state.tab}`);
}

// ------------------------------------------------------------------ status views (saved-view style)

function renderViews() {
  const counts = state.counts[state.tab] || {};
  const total = Object.values(counts).reduce((a, n) => a + (Number(n) || 0), 0);
  $("#rq-views").innerHTML = html`<div class="saved-views" role="group" aria-label="${t("people.requests.views_label")}">
    ${VIEWS[state.tab].map(([v, key]) => {
      const n = v === "all" ? total : counts[v];
      return html`<span class="view-item"><button type="button" class="view-tab" data-status="${v}" aria-pressed="${v === state.status}">${t(key)}${
        n !== undefined ? html`<span class="n">${num(n)}</span>` : ""}</button></span>`;
    })}</div>`;
}

// ------------------------------------------------------------------ registrations

function regColumns() {
  return [
    { key: "name", label: t("people.requests.col.applicant"), primary: true, hideable: false, csv: (r) => r.full_name,
      render: (r) => html`<div class="dt-person">${avatar(r.full_name)}<div class="dt-cell-stack"><button type="button" class="link-btn pp-open" data-open="${r.patron_id}">${r.full_name}</button>
        <span class="sub">${r.email || r.phone || ""}</span></div>${r.duplicates?.length ? pill("warning", t("people.requests.possible_duplicate")) : ""}</div>` },
    { key: "phone", label: t("people.field.phone"), hidden: true, csv: (r) => r.phone || "", render: (r) => (r.phone ? html`<span dir="ltr">${r.phone}</span>` : "—") },
    { key: "category", label: t("people.field.category"), csv: (r) => r.category.name, render: (r) => r.category.name },
    { key: "branch", label: t("people.field.home_branch"), csv: (r) => r.home_branch.name, render: (r) => r.home_branch.name },
    { key: "submitted", label: t("people.requests.col.submitted"), csv: (r) => r.submitted_at,
      render: (r) => html`<span class="num" title="${datetime(r.submitted_at)}">${relative(r.submitted_at)}</span>` },
    { key: "status", label: t("people.col.status"), csv: (r) => t(REG_STATUS[r.status] || r.status), render: (r) => regPill(r.status) },
    { key: "reviewed", label: t("people.requests.col.reviewed"), hidden: true, csv: (r) => r.reviewed_at || "",
      render: (r) => (r.reviewed_at ? html`<div class="dt-cell-stack"><span>${relative(r.reviewed_at)}</span><span class="sub">${r.reviewed_by || ""}</span></div>` : "—") },
    { key: "review", label: t("people.col.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions", cardHidden: true,
      render: (r) => html`<button type="button" class="btn sm" data-open="${r.patron_id}">${r.status === "pending" ? t("people.requests.review") : t("people.requests.view_details")}</button>` },
  ];
}

function regPanelBody(r) {
  const lk = state.lookups;
  const age = r.date_of_birth ? Math.floor((Date.now() - new Date(r.date_of_birth)) / (365.25 * 86400000)) : null;
  const canDecide = can(P, "patrons:approve") && r.status !== "approved";
  return html`<div class="rq-review">
    <div class="rq-review-head">${avatar(r.full_name, { size: "md" })}<div><div class="rq-review-pills">${regPill(r.status)}</div>
      <div class="small muted">${t("people.requests.submitted_on", { date: datetime(r.submitted_at) })}</div></div></div>
    ${r.duplicates?.length ? html`<div class="alert warn rq-dupes" role="note">${icon("alert")}<div><strong>${t("people.requests.dupes_title")}</strong>
      <p>${t("people.requests.dupes_body")}</p><ul>${r.duplicates.map((d) => html`<li><a href="/staff/patrons/${d.id}" target="_blank" rel="noopener">${d.full_name}</a>
        <span class="mono small" dir="ltr">${d.card_number}</span> · ${d.match === "phone" ? t("people.requests.match_phone") : t("people.requests.match_name")}${d.is_active === false ? html` · ${t("ui.status.inactive")}` : ""}</li>`)}</ul></div></div>` : ""}
    <h3 class="rq-h">${t("people.requests.details")}</h3>
    ${dl([
      [t("people.field.email"), r.email ? html`<a href="mailto:${r.email}">${r.email}</a>` : ""],
      [t("people.field.phone"), r.phone ? html`<span dir="ltr">${r.phone}</span>` : ""],
      [t("people.field.address"), r.address],
      [t("people.field.date_of_birth"), r.date_of_birth ? html`${date(r.date_of_birth)}${age !== null ? html` <span class="muted">· ${t("people.requests.age", { count: age })}</span>` : ""}` : ""],
      [t("people.requests.requested_branch"), r.home_branch.name],
      [t("people.field.category"), r.category.name],
      [t("people.field.card_number"), html`<span class="mono" dir="ltr">${r.card_number}</span>`],
    ])}
    ${r.reviewed_at ? html`<h3 class="rq-h">${t("people.requests.decision")}</h3>${dl([
      [t("people.col.status"), regPill(r.status)],
      [t("people.requests.reviewed_by"), r.reviewed_by || ""],
      [t("people.requests.reviewed_at"), datetime(r.reviewed_at)],
      [r.status === "rejected" ? t("people.requests.reason_sent") : t("people.requests.internal_note"), r.decision_note || ""],
    ])}` : ""}
    ${canDecide ? html`<form class="rq-approve" id="rq-approve-form" novalidate><h3 class="rq-h">${t("people.requests.approve_as")}</h3>
      <p class="small muted">${t("people.requests.approve_explain", { name: r.first_name })}</p>
      <div class="form-grid pp-two">
        <div class="field"><label for="ap-cat">${t("people.field.category")}</label><select id="ap-cat" name="category_id">${(lk.categories || []).map((c) =>
          html`<option value="${c.id}" ${c.id === r.category.id ? "selected" : ""}>${c.name}</option>`)}</select></div>
        <div class="field"><label for="ap-br">${t("people.field.home_branch")}</label><select id="ap-br" name="home_branch_id">${lk.branches.map((b) =>
          html`<option value="${b.id}" ${b.id === r.home_branch.id ? "selected" : ""}>${b.name}</option>`)}</select></div></div>
      <div class="field"><label for="ap-note">${t("people.requests.internal_note")} <span class="optional">${t("ui.form.optional")}</span></label>
        <input id="ap-note" name="note" maxlength="500" placeholder="${t("people.requests.internal_note_hint")}"></div></form>` : ""}
  </div>`;
}

function openRegistration(r) {
  if (!r) return;
  const canDecide = can(P, "patrons:approve") && r.status !== "approved";
  const panel = sidePanel({ title: r.full_name, subtitle: r.email || "", body: regPanelBody(r), wide: false,
    footer: html`${r.status === "approved" ? html`<a class="btn" href="/staff/patrons/${r.patron_id}">${icon("user")}${t("people.requests.open_patron")}</a>` : ""}
      <span class="spacer"></span>
      ${canDecide && r.status === "pending" ? html`<button type="button" class="btn danger" data-reject>${icon("x")}${t("people.requests.reject")}</button>` : ""}
      ${canDecide ? html`<button type="button" class="btn primary" data-approve>${icon("check")}${t("people.requests.approve")}</button>` : ""}` });
  panel.el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-approve]")) {
      const f = $("#rq-approve-form", panel.el);
      const btn = e.target.closest("[data-approve]");
      btn.disabled = true;
      try {
        const out = await api(`/registrations/${r.patron_id}/approve`, { method: "POST", body: {
          category_id: Number(f.category_id.value), home_branch_id: Number(f.home_branch_id.value), note: f.note.value.trim() || null } });
        toast(t("people.requests.approved_toast", { name: r.full_name, card: out.card_number }), "success", { action: { label: t("people.requests.open_patron"), run: () => { location.href = `/staff/patrons/${r.patron_id}`; } } });
        panel.close();
        refresh();
      } catch (err) { toast(err.message, "error"); btn.disabled = false; }
    } else if (e.target.closest("[data-reject]")) {
      const reason = await askReason(t("people.requests.reject_title", { name: r.full_name }), t("people.requests.reject_reason_label"), t("people.requests.reject_reason_hint"));
      if (!reason) return;
      try {
        await api(`/registrations/${r.patron_id}/reject`, { method: "POST", body: { reason } });
        toast(t("people.requests.rejected_toast", { name: r.full_name }), "success");
        panel.close();
        refresh();
      } catch (err) { toast(err.message, "error"); }
    }
  });
}

async function askReason(title, label, placeholder, { submit = t("people.requests.reject_submit") } = {}) {
  const fd = await modal({ title, submit, danger: true, size: "sm", body: html`<div class="field"><label for="rj-reason">${label}</label>
    <textarea id="rj-reason" name="reason" maxlength="500" rows="3" required placeholder="${placeholder}"></textarea>
    <span class="field-help">${t("people.requests.reason_help")}</span></div>` });
  return fd ? String(fd.get("reason") || "").trim() : null;
}

/** Run `fn(row)` for each row with progress on the bulk button; returns { ok, failed: [message] }. */
async function eachWithProgress(rows, button, fn) {
  const label = button.innerHTML;
  const out = { ok: 0, failed: [] };
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  for (const [i, r] of rows.entries()) {
    button.textContent = t("people.requests.progress", { done: num(i + 1), total: num(rows.length) });
    try { await fn(r); out.ok++; } catch (err) { out.failed.push(err.message); }
  }
  button.innerHTML = label;
  button.disabled = false;
  button.removeAttribute("aria-busy");
  return out;
}

const summary = (key, res) => {
  if (!res.failed.length) toast(t(`people.requests.bulk.${key}`, { count: res.ok }), "success");
  else toast(t("people.requests.bulk.partial", { count: res.ok, failed: res.failed.length, reason: res.failed[0] }), "warn", 9000);
};

async function bulkApprove(rows, ctx) {
  const list = rows.filter((r) => r.status !== "approved");
  const fd = await modal({ title: t("people.requests.bulk_approve_title", { count: list.length }), submit: t("people.requests.approve"), size: "sm",
    body: html`<p>${t("people.requests.bulk_approve_body")}</p>${list.some((r) => r.duplicates?.length) ? html`<div class="alert warn">${icon("alert")}<div>${t("people.requests.bulk_has_dupes")}</div></div>` : ""}` });
  if (!fd) return;
  const res = await eachWithProgress(list, ctx.button, (r) => api(`/registrations/${r.patron_id}/approve`, { method: "POST", body: {} }));
  ctx.clear();
  summary("approved", res);
  refresh();
}

async function bulkRejectRegistrations(rows, ctx) {
  const list = rows.filter((r) => r.status === "pending");
  const reason = await askReason(t("people.requests.bulk_reject_title", { count: list.length }), t("people.requests.reject_reason_label"), t("people.requests.reject_reason_hint"));
  if (!reason) return;
  const res = await eachWithProgress(list, ctx.button, (r) => api(`/registrations/${r.patron_id}/reject`, { method: "POST", body: { reason } }));
  ctx.clear();
  summary("rejected", res);
  refresh();
}

// ------------------------------------------------------------------ suggestions

function sugColumns() {
  return [
    { key: "title", label: t("people.col.title"), primary: true, hideable: false, csv: (s) => s.title,
      render: (s) => html`<div class="dt-cell-stack"><button type="button" class="link-btn pp-open" data-open="${s.id}">${s.title}</button>
        <span class="sub">${[s.author, formatName(s.format)].filter(Boolean).join(" · ")}</span></div>${s.holdings ? html` ${pill("info", t("people.requests.in_catalogue"))}` : ""}` },
    { key: "isbn", label: t("people.requests.col.isbn"), hidden: true, csv: (s) => s.isbn || "", render: (s) => (s.isbn ? html`<span class="mono small" dir="ltr">${s.isbn}</span>` : "—") },
    { key: "patron", label: t("people.requests.col.suggested_by"), csv: (s) => s.patron?.full_name || "",
      render: (s) => (s.patron ? html`<div class="dt-cell-stack"><a href="/staff/patrons/${s.patron.id}">${s.patron.full_name}</a><span class="sub mono" dir="ltr">${s.patron.card_number}</span></div>` : html`<span class="muted">—</span>`) },
    { key: "reason", label: t("people.requests.col.why"), cardHidden: true, csv: (s) => s.reason || "",
      render: (s) => (s.reason ? html`<span class="rq-clamp">${s.reason}</span>` : html`<span class="muted">—</span>`) },
    { key: "status", label: t("people.col.status"), csv: (s) => t(SUG_STATUS[s.status] || s.status), render: (s) => sugPill(s.status) },
    { key: "created", label: t("people.requests.col.suggested"), csv: (s) => s.created_at, render: (s) => html`<span class="num" title="${datetime(s.created_at)}">${relative(s.created_at)}</span>` },
    { key: "review", label: t("people.col.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions", cardHidden: true,
      render: (s) => html`<button type="button" class="btn sm" data-open="${s.id}">${s.status === "pending" ? t("people.requests.review") : t("people.requests.view_details")}</button>` },
  ];
}

let acq = null;
async function acquisitionsOptions() {
  if (acq) return acq;
  if (!can(P, "acquisitions:write")) return (acq = { vendors: [], budgets: [] });
  try {
    const [v, b] = await Promise.all([api("/acquisitions/vendors"), api("/acquisitions/budgets")]);
    acq = { vendors: v.results || [], budgets: b.results || [] };
  } catch { acq = { vendors: [], budgets: [] }; }
  return acq;
}

function sugPanelBody(s, opts) {
  const canDecide = can(P, "suggestions:manage") && s.status === "pending";
  const canOrder = opts.vendors.length && opts.budgets.length;
  return html`<div class="rq-review">
    <div class="rq-review-pills">${sugPill(s.status)}${s.holdings ? pill("info", t("people.requests.in_catalogue")) : ""}</div>
    ${s.holdings ? html`<div class="alert info">${icon("book")}<div>${t("people.requests.holdings_body")} <a href="/staff/catalog/${s.holdings}" target="_blank" rel="noopener">${t("people.requests.open_record")}</a></div></div>` : ""}
    <h3 class="rq-h">${t("people.requests.details")}</h3>
    ${dl([
      [t("people.requests.col.author"), s.author],
      [t("people.requests.col.isbn"), s.isbn ? html`<span class="mono" dir="ltr">${s.isbn}</span>` : ""],
      [t("people.requests.col.format"), formatName(s.format)],
      [t("people.requests.col.suggested_by"), s.patron ? html`<a href="/staff/patrons/${s.patron.id}">${s.patron.full_name}</a> <span class="mono small" dir="ltr">${s.patron.card_number}</span>` : ""],
      [t("people.requests.col.suggested"), datetime(s.created_at)],
    ])}
    ${s.reason ? html`<h3 class="rq-h">${t("people.requests.col.why")}</h3><blockquote class="rq-quote">${s.reason}</blockquote>` : ""}
    ${s.reviewed_at ? html`<h3 class="rq-h">${t("people.requests.decision")}</h3>${dl([
      [t("people.requests.reviewed_by"), s.reviewed_by || ""],
      [t("people.requests.reviewed_at"), datetime(s.reviewed_at)],
      [t("people.requests.message_to_patron"), s.decision_note || ""],
      s.order_id ? [t("people.requests.order"), html`<a href="/staff/acquisitions">${t("people.requests.draft_order", { id: s.order_id })}</a>`] : null,
    ])}` : ""}
    ${canDecide ? html`<form class="rq-approve" id="rq-accept-form" novalidate><h3 class="rq-h">${t("people.requests.accept_heading")}</h3>
      <div class="field"><label for="ac-note">${t("people.requests.message_to_patron")} <span class="optional">${t("ui.form.optional")}</span></label>
        <input id="ac-note" name="note" maxlength="500" placeholder="${t("people.requests.accept_note_hint")}"></div>
      ${canOrder ? html`<label class="checkbox rq-order-toggle"><input type="checkbox" name="create_order" id="ac-order"> ${t("people.requests.create_order")}</label>
        <fieldset class="rq-order" id="ac-order-fields" disabled hidden><legend class="sr-only">${t("people.requests.order")}</legend><div class="form-grid pp-two">
          <div class="field"><label for="ac-vendor">${t("people.requests.vendor")}</label><select id="ac-vendor" name="vendor_id">${opts.vendors.map((v) => html`<option value="${v.id}">${v.name}</option>`)}</select></div>
          <div class="field"><label for="ac-budget">${t("people.requests.budget")}</label><select id="ac-budget" name="budget_id">${opts.budgets.map((b) => html`<option value="${b.id}">${t("people.requests.budget_option", { name: b.name, year: b.fiscal_year, left: money(b.remaining) })}</option>`)}</select></div>
          <div class="field"><label for="ac-qty">${t("people.requests.copies")}</label><input id="ac-qty" name="quantity" type="number" min="1" max="1000" value="1" required></div>
          <div class="field"><label for="ac-price">${t("people.requests.unit_price")}</label><input id="ac-price" name="unit_price" type="number" inputmode="decimal" min="0" step="0.01" required></div></div></fieldset>`
        : html`<p class="small muted">${t("people.requests.no_order_access")}</p>`}</form>` : ""}
  </div>`;
}

async function openSuggestion(s) {
  if (!s) return;
  const canDecide = can(P, "suggestions:manage") && s.status === "pending";
  const panel = sidePanel({ title: s.title, subtitle: s.author || "", body: html`<div class="rq-review" aria-busy="true"><div class="skeleton sk-line"></div></div>`,
    footer: canDecide ? html`<span class="spacer"></span><button type="button" class="btn danger" data-reject>${icon("x")}${t("people.requests.reject")}</button>
      <button type="button" class="btn primary" data-accept>${icon("check")}${t("people.requests.accept")}</button>` : html`<span class="spacer"></span><button type="button" class="btn" data-close>${t("common.close")}</button>` });
  const opts = canDecide ? await acquisitionsOptions() : { vendors: [], budgets: [] };
  panel.setBody(sugPanelBody(s, opts));
  const toggle = $("#ac-order", panel.el);
  toggle?.addEventListener("change", () => { const f = $("#ac-order-fields", panel.el); f.hidden = !toggle.checked; f.disabled = !toggle.checked; if (toggle.checked) $("#ac-price", panel.el).focus(); });
  panel.el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-accept]")) {
      const f = $("#rq-accept-form", panel.el);
      const body = { note: f.note.value.trim() || null };
      if (toggle?.checked) {
        const price = $("#ac-price", panel.el);
        if (!price.value || Number.isNaN(Number(price.value))) { price.setAttribute("aria-invalid", "true"); price.focus(); toast(t("people.requests.price_required"), "error"); return; }
        Object.assign(body, { create_order: true, vendor_id: Number(f.vendor_id.value), budget_id: Number(f.budget_id.value),
          quantity: Number(f.quantity.value || 1), unit_price: Math.round(Number(price.value) * 100) });
      }
      const btn = e.target.closest("[data-accept]");
      btn.disabled = true;
      try {
        const out = await api(`/suggestions/${s.id}/accept`, { method: "POST", body });
        toast(out.order_id ? t("people.requests.accepted_order_toast", { id: out.order_id }) : t("people.requests.accepted_toast"), "success");
        panel.close();
        refresh();
      } catch (err) { toast(err.message, "error"); btn.disabled = false; }
    } else if (e.target.closest("[data-reject]")) {
      const reason = await askReason(t("people.requests.reject_suggestion_title"), t("people.requests.reject_suggestion_label"), t("people.requests.reject_suggestion_hint"));
      if (!reason) return;
      try {
        await api(`/suggestions/${s.id}/reject`, { method: "POST", body: { reason } });
        toast(t("people.requests.suggestion_rejected_toast"), "success");
        panel.close();
        refresh();
      } catch (err) { toast(err.message, "error"); }
    }
  });
}

async function bulkAccept(rows, ctx) {
  const list = rows.filter((s) => s.status === "pending");
  const fd = await modal({ title: t("people.requests.bulk_accept_title", { count: list.length }), submit: t("people.requests.accept"), size: "sm",
    body: html`<p>${t("people.requests.bulk_accept_body")}</p><div class="field"><label for="ba-note">${t("people.requests.message_to_patron")} <span class="optional">${t("ui.form.optional")}</span></label>
      <input id="ba-note" name="note" maxlength="500"></div>` });
  if (!fd) return;
  const note = String(fd.get("note") || "").trim() || null;
  const res = await eachWithProgress(list, ctx.button, (s) => api(`/suggestions/${s.id}/accept`, { method: "POST", body: { note } }));
  ctx.clear();
  summary("accepted", res);
  refresh();
}

async function bulkRejectSuggestions(rows, ctx) {
  const list = rows.filter((s) => s.status === "pending");
  const reason = await askReason(t("people.requests.bulk_reject_suggestions_title", { count: list.length }), t("people.requests.reject_suggestion_label"), t("people.requests.reject_suggestion_hint"));
  if (!reason) return;
  const res = await eachWithProgress(list, ctx.button, (s) => api(`/suggestions/${s.id}/reject`, { method: "POST", body: { reason } }));
  ctx.clear();
  summary("not_accepted", res);
  refresh();
}

// ------------------------------------------------------------------ table per tab

/** Before the first data of a tab/status arrives: placeholders instead of an empty table (no layout shift). */
function resetTable() {
  table = null;
  $("#rq-table").innerHTML = tablePlaceholder(3);
}

function buildTable() {
  const el = freshTableHost($("#rq-table"));
  const reg = state.tab === "registrations";
  const pending = state.status === "pending";
  const decide = reg ? can(P, "patrons:approve") : can(P, "suggestions:manage");
  table = dataTable(el, {
    id: reg ? "requests-registrations" : "requests-suggestions",
    caption: reg ? t("people.requests.tab_registrations") : t("people.requests.tab_suggestions"),
    columns: reg ? regColumns() : sugColumns(),
    rowKey: (r) => (reg ? r.patron_id : r.id), rowLabel: (r) => (reg ? r.full_name : r.title),
    selectable: decide && pending,
    exportName: reg ? "registrations" : "purchase-suggestions",
    bulkActions: decide && pending ? (reg
      ? [{ id: "approve", label: t("people.requests.bulk_approve"), icon: "check", run: bulkApprove },
        { id: "reject", label: t("people.requests.bulk_reject"), icon: "x", danger: true, run: bulkRejectRegistrations }]
      : [{ id: "accept", label: t("people.requests.bulk_accept"), icon: "check", run: bulkAccept },
        { id: "reject", label: t("people.requests.bulk_reject"), icon: "x", danger: true, run: bulkRejectSuggestions }]) : [],
    empty: reg
      ? { art: pending ? "done" : "filter", title: pending ? t("people.requests.empty_reg_title") : t("people.requests.empty_filtered_title"),
        body: pending ? t("people.requests.empty_reg_body") : t("people.requests.empty_filtered_body"),
        actions: pending ? "" : html`<button type="button" class="btn" data-status="pending">${t("people.requests.show_pending")}</button>` }
      : { art: pending ? "done" : "filter", title: pending ? t("people.requests.empty_sug_title") : t("people.requests.empty_filtered_title"),
        body: pending ? t("people.requests.empty_sug_body") : t("people.requests.empty_filtered_body"),
        actions: pending ? "" : html`<button type="button" class="btn" data-status="pending">${t("people.requests.show_pending")}</button>` },
  });
  const open = (r) => (reg ? openRegistration(r) : openSuggestion(r));
  onRowOpen(el, (k) => state.rows.find((r) => String(reg ? r.patron_id : r.id) === k), open);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open]");
    if (b) open(state.rows.find((r) => String(reg ? r.patron_id : r.id) === b.dataset.open));
  });
}

async function load() {
  const seq = ++loadSeq;
  const tab = state.tab;
  table?.setLoading();
  try {
    if (tab === "registrations") {
      const r = await api(`/registrations?status=${encodeURIComponent(state.status)}`);
      if (seq !== loadSeq) return;
      state.rows = r.results;
      state.counts.registrations = r.counts || { pending: r.pending };
      setTabCount("registrations", r.pending, { tone: "warning" });
    } else {
      const r = await api(`/suggestions${state.status === "all" ? "" : `?status=${encodeURIComponent(state.status)}`}`);
      if (seq !== loadSeq) return;
      state.rows = r.results;
      state.counts.suggestions = { pending: 0, accepted: 0, ordered: 0, rejected: 0, withdrawn: 0, ...r.counts };
      setTabCount("suggestions", r.counts.pending || 0, { tone: "warning" });
    }
    renderViews();
    if (!table) buildTable();
    table.setRows(state.rows);
  } catch (e) {
    if (seq !== loadSeq) return;
    if (!table) buildTable();
    table.setError(e, load);
  }
}

function refresh() { load(); refreshCounts(); }

function refreshCounts() {
  if (can(P, "patrons:approve")) api("/registrations/count").then((r) => setTabCount("registrations", r.pending, { tone: "warning" })).catch(() => {});
  if (can(P, "suggestions:manage")) api("/suggestions?status=pending").then((r) => setTabCount("suggestions", r.counts.pending || 0, { tone: "warning" })).catch(() => {});
}

function select(tab, { keepStatus = false } = {}) {
  state.tab = tab;
  state.status = keepStatus ? readStatus(tab) : "pending";
  writeStatus();
  $("#rq-views").innerHTML = VIEWS_SKELETON;
  const allowed = tab === "registrations" ? can(P, "patrons:approve") : can(P, "suggestions:manage");
  if (!allowed) {
    $("#rq-table").innerHTML = errorState(new Error(t("people.requests.no_access")), { retry: false, title: t("people.requests.no_access_title") });
    return;
  }
  resetTable();
  load();
}

export default async function init() {
  wireKit();
  [P, state.lookups] = await Promise.all([perms(), api("/lookups").catch(() => ({ branches: [], categories: [] }))]);
  let first = true;
  wireTabsPanel($(".rq-page"), (tab) => { select(tab, { keepStatus: first }); first = false; }, { hash: true });
  $("#rq-views").addEventListener("click", (e) => {
    const b = e.target.closest("[data-status]");
    if (!b || b.dataset.status === state.status) return;
    state.status = b.dataset.status;
    writeStatus();
    renderViews();
    resetTable();
    load();
  });
  $("#rq-table").addEventListener("click", (e) => {
    const b = e.target.closest(".empty-state [data-status]");
    if (b) { state.status = b.dataset.status; writeStatus(); renderViews(); resetTable(); load(); }
  });
  $("#rq-refresh").addEventListener("click", refresh);
  refreshCounts();
}

