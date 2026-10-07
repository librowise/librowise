// Staff: notice template editor (sandboxed Jinja, live preview) and the delivery outbox.
import { $, $$, api, badge, confirmDialog, datetime, debounce, empty, html, icon, modal, qs, raw, relative, skeleton, toast, withBusy } from "/static/js/core.js";

const COMMON_VARS = ["patron.first_name", "patron.last_name", "patron.full_name", "patron.card_number", "patron.email",
  "patron.home_branch", "patron.expires_on", "library.name"];
const VARS = {
  HOLD_READY: ["biblio.title", "biblio.author", "item.barcode", "item.call_number", "hold.pickup_branch", "hold.pickup_by", "hold.notes"],
  DUE_SOON: ["biblio.title", "biblio.author", "item.barcode", "loan.due_date", "loan.renewals"],
  OVERDUE: ["biblio.title", "biblio.author", "item.barcode", "loan.due_date", "loan.days_overdue"],
  PURCHASE_SUGGESTION_UPDATE: ["suggestion.title", "suggestion.author", "suggestion.status_label", "suggestion.note"],
  REGISTRATION_REJECTED: ["registration.reason"],
};
const STATUS_BADGE = { pending: "warn", sent: "ok", failed: "bad" };

const state = { tab: "templates", data: null, code: null, channel: "email", canEdit: false, outboxPage: 1, filters: {} };
const panel = () => $("#n-panel");

// ------------------------------------------------------------------ templates

const current = () => state.data.results.find((t) => t.code === state.code && t.channel === state.channel);

function templateList() {
  return html`<nav class="card flush notice-list" aria-label="Notice types"><ul>${state.data.codes.map((c) => {
    const rows = state.data.results.filter((t) => t.code === c.code);
    return html`<li><button type="button" data-code="${c.code}" aria-current="${c.code === state.code ? "true" : "false"}">
      <strong>${c.name}</strong><span class="tiny muted mono">${c.code}</span>
      <span class="row tight">${rows.map((t) => html`<span class="badge ${t.customized ? "info" : ""}">${t.channel}${t.customized ? " · edited" : ""}${t.is_active ? "" : " · off"}</span>`)}</span>
    </button></li>`;
  })}</ul></nav>`;
}

function editor() {
  const t = current();
  const meta = state.data.codes.find((c) => c.code === state.code);
  const vars = [...COMMON_VARS, ...(VARS[state.code] || [])];
  const ro = state.canEdit ? "" : "readonly";
  return html`<div class="card pad stack">
    <div class="row between">
      <div><h2 style="margin:0">${meta.name}</h2><div class="small muted">${meta.description}${meta.patron_configurable ? " · patrons choose email, SMS or none" : " · always sent"}</div></div>
      <div class="mode-switch" role="group" aria-label="Channel">${state.data.channels.map((ch) => html`
        <button type="button" data-channel="${ch}" aria-pressed="${ch === state.channel}">${icon(ch === "email" ? "send" : "inbox")}${ch === "email" ? "Email" : "SMS"}</button>`)}</div>
    </div>
    ${state.canEdit ? "" : html`<div class="alert info">${icon("info")}<div>Only administrators can edit notice templates. You can preview them.</div></div>`}
    <form id="tpl-form" class="notice-editor" novalidate>
      <div class="stack">
        ${state.channel === "email" ? html`<div class="field"><label for="tpl-subject">Subject</label>
          <input id="tpl-subject" name="subject" maxlength="255" value="${t.subject}" ${ro} required></div>` : ""}
        <div class="field"><label for="tpl-body">${state.channel === "email" ? "Body (plain text)" : `Message (max 640 characters)`}</label>
          <textarea id="tpl-body" name="body" class="mono" rows="${state.channel === "email" ? 12 : 5}" ${ro} required spellcheck="true">${t.body}</textarea>
          <span class="hint">Jinja syntax, e.g. <code>{{ patron.first_name }}</code>, <code>{% if … %}…{% endif %}</code>, <code>{{ biblio.title|truncate(40) }}</code>. Rendered in a secure sandbox.</span></div>
        <div class="field"><span class="small" style="font-weight:600">Insert a field</span>
          <div class="row tight" id="tpl-vars">${vars.map((v) => html`<button type="button" class="chip mono" data-var="${v}" ${state.canEdit ? "" : "disabled"}>${v}</button>`)}</div></div>
        <label class="checkbox"><input type="checkbox" name="is_active" ${t.is_active ? "checked" : ""} ${state.canEdit ? "" : "disabled"}> Send this notice by ${state.channel === "email" ? "email" : "SMS"}</label>
        ${state.canEdit ? html`<div class="row tight">
          <button class="btn primary" type="submit">${icon("check")}Save template</button>
          <button class="btn" type="button" id="tpl-reset" ${t.customized ? "" : "disabled"}>${icon("refresh")}Restore default</button>
          ${t.updated_at ? html`<span class="tiny muted">Edited ${relative(t.updated_at)}</span>` : ""}</div>` : ""}
      </div>
      <aside class="stack" aria-label="Preview">
        <div class="field"><label for="pv-card">Preview as patron (card number)</label>
          <input id="pv-card" class="mono" maxlength="32" placeholder="Sample patron" autocomplete="off" value="${state.previewCard || ""}"></div>
        <div class="notice-preview" id="tpl-preview" aria-live="polite">${skeleton(3)}</div>
      </aside>
    </form></div>`;
}

const runPreview = debounce(async () => {
  const box = $("#tpl-preview");
  const form = $("#tpl-form");
  if (!box || !form) return;
  const body = { code: state.code, channel: state.channel, subject: form.subject?.value || "", body: form.body.value,
    patron_card: $("#pv-card").value.trim() || null };
  try {
    const r = await api("/notices/preview", { method: "POST", body });
    box.innerHTML = html`${state.channel === "email" ? html`<div class="small muted">Subject</div><div class="pv-subject">${r.subject || "—"}</div>` : ""}
      <div class="small muted">${state.channel === "email" ? "Body" : `SMS · ${r.body.length} characters`}</div><div class="pv-body">${r.body}</div>`;
  } catch (e) {
    box.innerHTML = html`<div class="alert bad" role="alert">${icon("alert")}<div>${e.message}</div></div>`;
  }
}, 350);

function showTemplates() {
  if (!state.code) state.code = state.data.codes[0].code;
  panel().innerHTML = html`<div class="notice-layout">${templateList()}<div>${editor()}</div></div>`;
  runPreview();
}

async function loadTemplates() {
  panel().innerHTML = `<div class="card pad">${skeleton(6)}</div>`;
  try {
    state.data = await api("/notices/templates");
    showTemplates();
  } catch (e) { panel().innerHTML = html`<div class="card">${empty(e.message, "alert")}</div>`; }
}

function insertVar(v) {
  const ta = $("#tpl-body");
  const token = `{{ ${v} }}`;
  const [s, e] = [ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.value.length];
  ta.value = ta.value.slice(0, s) + token + ta.value.slice(e);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = s + token.length;
  runPreview();
}

async function saveTemplate(form) {
  const btn = $("button[type=submit]", form);
  try {
    const out = await withBusy(btn, () => api(`/notices/templates/${state.code}/${state.channel}`, { method: "PUT", body: {
      subject: form.subject?.value || "", body: form.body.value, is_active: form.is_active.checked } }));
    Object.assign(current(), out);
    toast("Template saved", "success");
    showTemplates();
  } catch { /* toasted */ }
}

async function resetTemplate() {
  if (!(await confirmDialog("Restore the default text?", "Your edits to this template will be discarded.", "Restore default"))) return;
  try {
    Object.assign(current(), await api(`/notices/templates/${state.code}/${state.channel}`, { method: "DELETE" }));
    toast("Default restored", "success");
    showTemplates();
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ outbox

function outboxFilters() {
  const f = state.filters;
  const codes = state.data?.codes || [];
  const sel = (name, label, opts) => html`<div class="field"><label for="ob-${name}">${label}</label><select id="ob-${name}" name="${name}">
    <option value="">All</option>${opts.map(([v, l]) => html`<option value="${v}" ${f[name] === v ? "selected" : ""}>${l}</option>`)}</select></div>`;
  return html`<form class="card pad row" id="ob-filters" role="search" style="margin-bottom:1rem">
    ${sel("status", "Status", [["pending", "Pending"], ["sent", "Sent"], ["failed", "Failed"]])}
    ${sel("channel", "Channel", [["email", "Email"], ["sms", "SMS"]])}
    ${sel("code", "Notice", codes.map((c) => [c.code, c.name]))}
    <div class="field"><label for="ob-card">Patron card</label><input id="ob-card" name="patron_card" class="mono" value="${f.patron_card || ""}" autocomplete="off"></div>
    <div class="field"><label>&nbsp;</label><button class="btn primary">${icon("filter")}Filter</button></div></form>`;
}

function outboxTable(r) {
  if (!r.results.length) return html`<div class="card">${empty("No notices match.", "inbox")}</div>`;
  const pages = Math.ceil(r.total / 50);
  return html`<div class="card flush"><div class="table-wrap"><table class="table">
    <caption class="sr-only">Notice outbox</caption>
    <thead><tr><th scope="col">Created</th><th scope="col">Patron</th><th scope="col">Notice</th><th scope="col">To</th>
      <th scope="col">Status</th><th scope="col" class="num">Attempts</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${r.results.map((n) => html`<tr>
      <td class="nowrap" title="${datetime(n.created_at)}">${relative(n.created_at)}</td>
      <td>${n.patron ? html`<a href="/staff/patrons/${n.patron.id}">${n.patron.full_name}</a><div class="tiny muted mono">${n.patron.card_number}</div>` : "—"}</td>
      <td><div>${n.subject}</div><div class="tiny muted"><span class="mono">${n.code || "custom"}</span> · ${n.channel}</div></td>
      <td class="small">${n.to || html`<span class="muted">no address</span>`}</td>
      <td>${badge(STATUS_BADGE[n.status] || "", n.status)}${n.last_error ? html`<div class="tiny muted" title="${n.last_error}">${n.last_error.slice(0, 60)}</div>` : ""}
        ${n.status === "pending" && n.next_attempt_at ? html`<div class="tiny muted">retry ${relative(n.next_attempt_at)}</div>` : ""}
        ${n.sent_at ? html`<div class="tiny muted">sent ${relative(n.sent_at)}</div>` : ""}</td>
      <td class="num">${n.attempts}</td>
      <td class="right nowrap"><button class="btn sm ghost" data-view="${n.id}" aria-label="View notice ${n.id}">${icon("search")}</button>
        ${n.status !== "pending" ? html`<button class="btn sm" data-resend="${n.id}">${icon("refresh")}Resend</button>` : ""}</td></tr>`)}</tbody></table></div></div>
    ${pages > 1 ? html`<div class="pager"><button class="btn sm" data-page="${r.page - 1}" ${r.page <= 1 ? "disabled" : ""}>Previous</button>
      <span class="muted small">Page ${r.page} of ${pages}</span><button class="btn sm" data-page="${r.page + 1}" ${r.page >= pages ? "disabled" : ""}>Next</button></div>` : ""}`;
}

let outboxRows = [];
async function loadOutbox() {
  if (!state.data) { try { state.data = await api("/notices/templates"); } catch { /* filters fall back */ } }
  panel().innerHTML = html`${outboxFilters()}<div id="ob-summary" class="row tight small muted" style="margin-bottom:.5rem"></div><div id="ob-table">${raw(skeleton(6))}</div>`;
  try {
    const r = await api(`/notices/outbox?${qs({ ...state.filters, page: state.outboxPage })}`);
    outboxRows = r.results;
    const c = r.counts || {};
    $("#ob-summary").innerHTML = html`<span>${r.total} matching</span>·<span>${c.pending || 0} pending</span>·<span>${c.sent || 0} sent</span>·<span>${c.failed || 0} failed</span>`;
    setFailed(c.failed || 0);
    $("#ob-table").innerHTML = outboxTable(r);
  } catch (e) { $("#ob-table").innerHTML = html`<div class="card">${empty(e.message, "alert")}</div>`; }
}

function setFailed(n) {
  const el = $("#count-failed");
  el.textContent = n || "";
  el.className = `badge bad ${n ? "" : "hidden"}`;
}

// ------------------------------------------------------------------ wiring

function select(tab) {
  state.tab = tab;
  $$("#n-tabs [role=tab]").forEach((t) => { const on = t.dataset.tab === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
  panel().setAttribute("aria-labelledby", `tab-${tab}`);
  history.replaceState(null, "", `#${tab}`);
  (tab === "templates" ? loadTemplates : loadOutbox)();
}

export default async function init() {
  try {
    const me = await api("/auth/me");
    state.canEdit = me.permissions.includes("*") || me.permissions.includes("notices:manage");
  } catch { /* read-only */ }
  if (state.canEdit) $("#deliver-now").classList.remove("hidden");

  const tabs = $$("#n-tabs [role=tab]");
  $("#n-tabs").addEventListener("click", (e) => { const t = e.target.closest("[role=tab]"); if (t) select(t.dataset.tab); });
  $("#n-tabs").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    select(next.dataset.tab);
  });

  panel().addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.code) { state.code = t.dataset.code; showTemplates(); $(`[data-code="${state.code}"]`)?.focus(); }
    else if (t.dataset.channel) { state.channel = t.dataset.channel; showTemplates(); }
    else if (t.dataset.var) insertVar(t.dataset.var);
    else if (t.id === "tpl-reset") resetTemplate();
    else if (t.dataset.page) { state.outboxPage = Number(t.dataset.page); loadOutbox(); }
    else if (t.dataset.view) {
      const n = outboxRows.find((x) => x.id === Number(t.dataset.view));
      if (n) modal({ title: n.subject, submit: "Close", wide: true, body: html`<div class="stack tight">
        <div class="small muted">${n.channel} to ${n.to || "—"} · ${n.code || "custom"} · created ${datetime(n.created_at)}</div>
        <div class="pv-body notice-preview">${n.body}</div>
        ${n.last_error ? html`<div class="alert bad">${icon("alert")}<div>${n.last_error}</div></div>` : ""}</div>` });
    } else if (t.dataset.resend) {
      try {
        await withBusy(t, () => api(`/notices/outbox/${t.dataset.resend}/resend`, { method: "POST" }));
        toast("Queued for delivery again", "success");
        loadOutbox();
      } catch { /* toasted */ }
    }
  });
  panel().addEventListener("input", (e) => {
    if (["tpl-subject", "tpl-body", "pv-card"].includes(e.target.id)) {
      if (e.target.id === "pv-card") state.previewCard = e.target.value;
      runPreview();
    }
  });
  panel().addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "tpl-form" && state.canEdit) saveTemplate(e.target);
    if (e.target.id === "ob-filters") {
      state.filters = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));
      state.outboxPage = 1;
      loadOutbox();
    }
  });
  $("#deliver-now").addEventListener("click", async (e) => {
    try {
      const r = await withBusy(e.currentTarget, () => api("/notices/outbox/deliver", { method: "POST" }));
      toast(`${r.sent} sent · ${r.retry} will retry · ${r.failed} failed`, r.failed ? "info" : "success");
      if (state.tab === "outbox") loadOutbox();
    } catch { /* toasted */ }
  });
  select(location.hash === "#outbox" ? "outbox" : "templates");
  api("/notices/outbox?status=failed&per_page=1").then((r) => setFailed(r.total)).catch(() => {});
}
