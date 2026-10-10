// Staff › Patrons › Notices — Templates: notice list | editor (sandboxed Jinja, insert-field chips, unsaved-changes
// guard) | live preview (email / SMS mock). Outbox: URL-backed filters, data table, side panel with Resend.
import { $, $$, api, datetime, debounce, html, icon, num, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { confirmDialog } from "/static/js/ui/dialog.js";
import { errorState } from "/static/js/ui/empty.js";
import { activeFilters, searchField, selectChip, wireFilterBar } from "/static/js/ui/filters.js";
import { enhanceForm, saveBar } from "/static/js/ui/form.js";
import { wireTabsPanel } from "/static/js/ui/tabs.js";
import { pill, wireKit } from "/static/js/pages/lib/admin-kit.js";
import { can, channelIcon, channelLabel, excerpt, freshTableHost, noticeDescription, noticeName, noticeStatus, onRowOpen, openNotice, perms, setTabCount, tablePlaceholder } from "/static/js/pages/lib/people-ui.js";

const COMMON_VARS = ["patron.first_name", "patron.last_name", "patron.full_name", "patron.card_number", "patron.email",
  "patron.home_branch", "patron.expires_on", "library.name"];
const VARS = {
  HOLD_READY: ["biblio.title", "biblio.author", "item.barcode", "item.call_number", "hold.pickup_branch", "hold.pickup_by", "hold.notes"],
  DUE_SOON: ["biblio.title", "biblio.author", "item.barcode", "loan.due_date", "loan.renewals"],
  OVERDUE: ["biblio.title", "biblio.author", "item.barcode", "loan.due_date", "loan.days_overdue"],
  PURCHASE_SUGGESTION_UPDATE: ["suggestion.title", "suggestion.author", "suggestion.status_label", "suggestion.note"],
  REGISTRATION_REJECTED: ["registration.reason"],
};
const GROUPS = [
  ["people.notices.group.circulation", ["HOLD_READY", "DUE_SOON", "OVERDUE"]],
  ["people.notices.group.account", ["WELCOME", "REGISTRATION_APPROVED", "REGISTRATION_REJECTED"]],
  ["people.notices.group.requests", ["PURCHASE_SUGGESTION_UPDATE"]],
];
const SMS_MAX = 640;
const GSM = /^[\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€]*$/;

let P = new Set();
const T = { data: null, code: null, channel: "email", form: null, guard: null, lastField: null, previewCard: "" };

// ------------------------------------------------------------------ templates: list

const tpl = (code = T.code, channel = T.channel) => T.data.results.find((x) => x.code === code && x.channel === channel);
const canEdit = () => can(P, "notices:manage");
// "Edited" = the wording differs from the built-in default (older servers only report `customized`).
const edited = (x) => (x.is_default === undefined ? x.customized : !x.is_default);

function channelChip(x) {
  const label = x.channel === "email" ? t("people.channel.email") : t("people.notices.sms_short");
  if (!x.is_active) return pill("neutral", t("people.notices.chip.off", { channel: label }), { dot: false });
  if (edited(x)) return pill("info", t("people.notices.chip.edited", { channel: label }), { dot: false });
  return pill("neutral", label, { dot: false });
}

function listHtml() {
  const known = new Set(GROUPS.flatMap(([, codes]) => codes));
  const extra = T.data.codes.map((c) => c.code).filter((c) => !known.has(c));
  const groups = [...GROUPS, ...(extra.length ? [["people.notices.group.other", extra]] : [])];
  return html`<nav class="card nt-list" aria-label="${t("people.notices.list_label")}">${groups.map(([key, codes]) => {
    const present = codes.filter((c) => T.data.codes.some((x) => x.code === c));
    if (!present.length) return "";
    return html`<div class="nt-group"><h2 class="nt-group-title">${t(key)}</h2><ul>${present.map((code) => {
      const meta = T.data.codes.find((x) => x.code === code);
      return html`<li><button type="button" class="nt-item" data-code="${code}" aria-current="${code === T.code ? "true" : "false"}">
        <span class="nt-item-name">${noticeName(code, meta.name)}</span>
        <span class="nt-item-chips">${T.data.results.filter((x) => x.code === code).map(channelChip)}</span></button></li>`;
    })}</ul></div>`;
  })}</nav>`;
}

// ------------------------------------------------------------------ templates: editor + preview

function editorHtml() {
  const x = tpl();
  const meta = T.data.codes.find((c) => c.code === T.code);
  const vars = [...COMMON_VARS, ...(VARS[T.code] || [])];
  const ro = !canEdit();
  const email = T.channel === "email";
  return html`<section class="card nt-editor" aria-labelledby="nt-ed-h">
    <div class="nt-ed-head"><div class="nt-ed-title"><h2 id="nt-ed-h">${noticeName(T.code, meta.name)}</h2>
        <p class="small muted">${noticeDescription(T.code, meta.description)} ${meta.patron_configurable ? t("people.notices.patron_chooses") : t("people.notices.always_sent")}</p></div>
      <div class="segmented" role="radiogroup" aria-label="${t("people.col.channel")}">${T.data.channels.map((ch) => html`<button type="button" role="radio" data-channel="${ch}"
        aria-checked="${ch === T.channel}" tabindex="${ch === T.channel ? "0" : "-1"}">${icon(channelIcon(ch))}<span>${channelLabel(ch)}</span></button>`)}</div></div>
    ${ro ? html`<div class="alert info nt-ro">${icon("info")}<div>${t("people.notices.read_only")}</div></div>` : ""}
    <form id="nt-form" class="nt-form" novalidate>
      <div data-fields class="nt-fields">
        ${email ? html`<div class="field"><label for="nt-subject">${t("people.notices.subject")}</label>
          <input id="nt-subject" name="subject" maxlength="255" value="${x.subject}" ${ro ? "readonly" : ""} required></div>` : ""}
        <div class="field"><label for="nt-body">${email ? t("people.notices.body_email") : t("people.notices.body_sms")}</label>
          <textarea id="nt-body" name="body" class="mono nt-body" rows="${email ? 13 : 6}" ${ro ? "readonly" : ""} required spellcheck="true" aria-describedby="nt-body-help">${x.body}</textarea>
          <div class="field-help" id="nt-body-help">${t("people.notices.syntax_help")} <code>{{ patron.first_name }}</code> · <code>{% if … %}…{% endif %}</code></div></div>
        ${ro ? "" : html`<div class="nt-vars"><span class="nt-vars-label" id="nt-vars-label">${t("people.notices.insert_field")}</span>
          <div class="nt-chips" role="group" aria-labelledby="nt-vars-label">${vars.map((v) => html`<button type="button" class="chip nt-chip" data-var="${v}" aria-label="${t("people.notices.insert_named", { field: v })}"><span class="mono" dir="ltr">${v}</span></button>`)}</div></div>`}
        <label class="nt-switch"><input type="checkbox" name="is_active" role="switch" ${x.is_active ? "checked" : ""} ${ro ? "disabled" : ""}>
          <span class="nt-switch-ui" aria-hidden="true"></span><span>${email ? t("people.notices.active_email") : t("people.notices.active_sms")}</span></label>
        ${metaHtml(x)}
      </div>
      ${canEdit() ? saveBar({ submit: t("people.notices.save_template"), cancel: t("people.notices.discard") }) : ""}
    </form></section>`;
}

function metaHtml(x) {
  return html`<div class="nt-ed-meta small muted">${edited(x) ? html`${pill("info", t("people.notices.customised"), { dot: false })} ${x.updated_at ? t("people.notices.edited_ago", { when: relative(x.updated_at) }) : ""}`
    : t("people.notices.using_default")}
    ${canEdit() && edited(x) ? html`<button type="button" class="btn sm ghost" id="nt-reset">${icon("refresh")}${t("people.notices.restore_default")}</button>` : ""}</div>`;
}

function previewHtml() {
  const email = T.channel === "email";
  return html`<section class="card nt-preview" aria-labelledby="nt-pv-h">
    <div class="nt-pv-head"><h2 id="nt-pv-h">${icon("monitor")}${t("people.notices.preview")}</h2>
      <div class="field nt-pv-card"><label for="nt-pv-card">${t("people.notices.preview_as")}</label>
        <input id="nt-pv-card" class="mono" maxlength="32" placeholder="${t("people.notices.preview_as_hint")}" autocomplete="off" value="${T.previewCard}" dir="ltr"></div></div>
    <div class="nt-pv-stage ${email ? "is-email" : "is-sms"}" id="nt-preview" aria-live="polite">
      ${email ? html`<div class="nt-mail"><div class="nt-mail-bar"><span></span><span></span><span></span></div><div class="nt-mail-head"><div class="skeleton sk-line"></div></div><div class="nt-mail-body"><div class="skeleton nt-sk-block"></div></div></div>`
        : html`<div class="nt-phone"><div class="nt-bubble"><div class="skeleton sk-line"></div></div></div>`}
    </div>
    <p class="small muted nt-pv-foot" id="nt-pv-foot"></p></section>`;
}

function smsStats(text) {
  const len = [...text].length;
  const gsm = GSM.test(text);
  const per = gsm ? (len <= 160 ? 160 : 153) : (len <= 70 ? 70 : 67);
  return { len, parts: Math.max(1, Math.ceil(len / per)), gsm };
}

const runPreview = debounce(async () => {
  const box = $("#nt-preview"), form = $("#nt-form");
  if (!box || !form) return;
  const body = { code: T.code, channel: T.channel, subject: form.subject?.value || "", body: form.body.value, patron_card: T.previewCard.trim() || null };
  try {
    const r = await api("/notices/preview", { method: "POST", body });
    if (T.channel === "email") {
      box.innerHTML = html`<div class="nt-mail"><div class="nt-mail-bar" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="nt-mail-head"><div class="nt-mail-subject">${r.subject || html`<span class="muted">${t("people.notices.no_subject")}</span>`}</div>
          <div class="small muted">${body.patron_card ? t("people.notices.to_patron", { card: body.patron_card }) : t("people.notices.to_sample")}</div></div>
        <div class="nt-mail-body">${r.body}</div></div>`;
      $("#nt-pv-foot").textContent = body.patron_card ? t("people.notices.preview_real") : t("people.notices.preview_sample");
    } else {
      const s = smsStats(r.body);
      box.innerHTML = html`<div class="nt-phone"><div class="nt-bubble">${r.body}</div></div>`;
      $("#nt-pv-foot").innerHTML = html`<span class="nt-counter ${s.len > SMS_MAX ? "is-over" : ""}">${t("people.notices.sms_count", { count: num(s.len), max: num(SMS_MAX) })}</span> ·
        ${t("people.notices.sms_parts", { count: s.parts })}${s.gsm ? "" : html` · ${t("people.notices.sms_unicode")}`}`;
    }
  } catch (e) {
    box.innerHTML = html`<div class="alert bad" role="alert">${icon("alert")}<div><strong>${t("people.notices.preview_error")}</strong><div class="nt-err">${e.message}</div></div></div>`;
    $("#nt-pv-foot").textContent = "";
  }
}, 300);

function renderTemplates(panel) {
  if (!T.code) T.code = GROUPS[0][1].find((c) => T.data.codes.some((x) => x.code === c)) || T.data.codes[0].code;
  panel.innerHTML = html`<div class="nt-layout">${listHtml()}${editorHtml()}${previewHtml()}</div>`;
  const form = $("#nt-form");
  T.form = form;
  if (canEdit()) {
    T.guard = enhanceForm(form, { guard: false, onSubmit: save });
    form.addEventListener("reset", () => setTimeout(runPreview));
  } else T.guard = null;
  runPreview();
}

const dirty = () => !!T.guard?.isDirty();

async function save() {
  const f = T.form;
  const out = await api(`/notices/templates/${T.code}/${T.channel}`, { method: "PUT", body: {
    subject: f.subject?.value || "", body: f.body.value, is_active: f.is_active.checked } });
  Object.assign(tpl(), out);
  toast(t("people.notices.saved"), "success");
  // Refresh the list chips (edited/off) without losing focus in the editor.
  const list = $(".nt-list");
  if (list) list.outerHTML = listHtml();
  const meta = $(".nt-ed-meta");
  if (meta) meta.outerHTML = metaHtml(tpl());
}

async function confirmLeave() {
  if (!dirty()) return true;
  return confirmDialog(t("people.notices.discard_title"), t("people.notices.discard_text"), t("people.notices.discard_changes"), false);
}

async function resetTemplate() {
  if (!(await confirmDialog(t("people.notices.restore_title"), t("people.notices.restore_text"), t("people.notices.restore_default"), false))) return;
  try {
    Object.assign(tpl(), await api(`/notices/templates/${T.code}/${T.channel}`, { method: "DELETE" }));
    toast(t("people.notices.restored"), "success");
    renderTemplates($("#nt-panel"));
  } catch (e) { toast(e.message, "error"); }
}

function insertVar(v) {
  const remembered = T.lastField?.isConnected;
  const target = remembered ? T.lastField : $("#nt-body");
  if (!remembered) target.setSelectionRange(target.value.length, target.value.length); // never focused: append
  const token = `{{ ${v} }}`;
  const s = target.selectionStart ?? target.value.length, e = target.selectionEnd ?? target.value.length;
  target.focus();
  // execCommand keeps the browser's undo history; fall back to direct assignment.
  if (!document.execCommand?.("insertText", false, token)) {
    target.value = target.value.slice(0, s) + token + target.value.slice(e);
    target.selectionStart = target.selectionEnd = s + token.length;
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

async function showTemplates(panel) {
  try {
    T.data ||= await api("/notices/templates");
    renderTemplates(panel);
  } catch (e) {
    panel.innerHTML = errorState(e);
  }
}

// ------------------------------------------------------------------ outbox

const OB_KEYS = ["status", "channel", "code", "patron_card"];
const ob = { table: null, rows: [], seq: 0 };

function obState() {
  const q = new URLSearchParams(location.search);
  return { status: q.get("status") || "", channel: q.get("channel") || "", code: q.get("code") || "", patron_card: q.get("patron_card") || "",
    page: Number(q.get("page")) || 1, per_page: Number(q.get("per_page")) || 50 };
}
function obWrite(s) {
  const q = new URLSearchParams();
  for (const k of [...OB_KEYS, "page", "per_page"]) if (s[k] && !(k === "page" && s[k] === 1) && !(k === "per_page" && s[k] === 50)) q.set(k, s[k]);
  history.replaceState(null, "", `${location.pathname}${q.toString() ? `?${q}` : ""}#outbox`);
}

function obViews(counts = {}) {
  const s = obState();
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  const views = [["", t("people.notices.view.all"), total], ["failed", t("people.notices.view.failed"), counts.failed || 0],
    ["pending", t("people.notices.view.pending"), counts.pending || 0], ["sent", t("people.notices.view.sent"), counts.sent || 0]];
  $("#ob-views").innerHTML = html`<div class="saved-views" role="group" aria-label="${t("people.notices.views_label")}">${views.map(([v, label, n]) => html`<span class="view-item">
    <button type="button" class="view-tab ${v === "failed" && n ? "nt-view-failed" : ""}" data-ob-status="${v}" aria-pressed="${s.status === v}">${label}<span class="n">${num(n)}</span></button></span>`)}</div>`;
}

function obChips() {
  const s = obState();
  const list = [];
  if (s.channel) list.push({ key: "channel", label: t("people.col.channel"), value: channelLabel(s.channel) });
  if (s.code) list.push({ key: "code", label: t("people.notices.notice"), value: noticeName(s.code) });
  if (s.patron_card) list.push({ key: "patron_card", label: t("people.notices.patron_card"), value: s.patron_card });
  $("#ob-chips").innerHTML = activeFilters(list);
}

function obColumns() {
  return [
    { key: "created", label: t("people.col.created"), csv: (n) => n.created_at, render: (n) => html`<span class="num" title="${datetime(n.created_at)}">${relative(n.created_at)}</span>` },
    { key: "message", label: t("people.col.message"), primary: true, hideable: false, csv: (n) => n.subject,
      render: (n) => html`<div class="dt-cell-stack"><button type="button" class="link-btn pp-open" data-open="${n.id}">${n.subject || noticeName(n.code)}</button><span class="sub">${noticeName(n.code)}</span></div>` },
    { key: "patron", label: t("people.col.patron"), csv: (n) => n.patron?.full_name || "",
      render: (n) => (n.patron ? html`<div class="dt-cell-stack"><a href="/staff/patrons/${n.patron.id}">${n.patron.full_name}</a><span class="sub mono" dir="ltr">${n.patron.card_number}</span></div>` : html`<span class="muted">—</span>`) },
    { key: "channel", label: t("people.col.channel"), csv: (n) => channelLabel(n.channel), render: (n) => html`<span class="pp-channel">${icon(channelIcon(n.channel))}${channelLabel(n.channel)}</span>` },
    { key: "to", label: t("people.col.to"), hidden: true, csv: (n) => n.to || "", render: (n) => (n.to ? html`<span dir="ltr">${n.to}</span>` : html`<span class="muted">${t("people.notices.no_address")}</span>`) },
    { key: "status", label: t("people.col.status"), csv: (n) => n.status,
      render: (n) => html`<div class="dt-cell-stack">${noticeStatus(n.status)}${n.status === "failed" && n.last_error ? html`<span class="sub nt-err-sub" title="${n.last_error}">${excerpt(n.last_error, 70)}</span>`
        : n.status === "pending" && n.next_attempt_at ? html`<span class="sub">${t("people.notices.retry_at", { when: relative(n.next_attempt_at) })}</span>`
          : n.sent_at ? html`<span class="sub">${relative(n.sent_at)}</span>` : ""}</div>` },
    { key: "attempts", label: t("people.col.attempts"), align: "num", csv: (n) => n.attempts, render: (n) => num(n.attempts) },
  ];
}

function obTable() {
  const s = obState();
  ob.table = dataTable(freshTableHost($("#ob-table")), {
    id: "notices-outbox", caption: t("people.notices.tab_outbox"), columns: obColumns(), rowLabel: (n) => n.subject,
    perPage: s.per_page, perPageOptions: [25, 50, 100], exportName: "notice-outbox",
    onPage: ({ page, perPage }) => obApply({ page, per_page: perPage }),
    empty: { art: "inbox", title: t("people.notices.outbox_empty_title"), body: t("people.notices.outbox_empty_body"),
      actions: html`<button type="button" class="btn" data-clear-filters>${t("ui.filters.clear_all")}</button>` },
  });
}

async function obLoad() {
  const s = obState();
  const seq = ++ob.seq;
  ob.table?.setLoading();
  try {
    const r = await api(`/notices/outbox?${new URLSearchParams(Object.entries({ ...s }).filter(([, v]) => v !== "" && v !== null && v !== undefined)).toString()}`);
    if (seq !== ob.seq) return;
    ob.rows = r.results;
    if (!ob.table) obTable(); // created with its first data: no skeleton-rows → rows layout shift
    ob.table.setRows(r.results, { total: r.total, page: s.page, perPage: s.per_page });
    obViews(r.counts || {});
    setTabCount("failed", r.counts?.failed || 0, { tone: "danger" });
  } catch (e) {
    if (seq !== ob.seq) return;
    if (!ob.table) obTable();
    ob.table.setError(e, obLoad);
  }
}

function obApply(changes, sync = false) {
  const cur = obState();
  const reset = Object.keys(changes).some((k) => OB_KEYS.includes(k));
  const next = { ...cur, ...changes, ...(reset ? { page: 1 } : {}) };
  obWrite(next);
  if (sync) {
    for (const k of OB_KEYS) { const el = $(`#ob-filters [name="${k}"]`); if (el) { el.value = next[k]; el.closest(".select-chip")?.classList.toggle("active", !!next[k]); } }
    const clear = $("#ob-filters [data-clear]");
    if (clear) clear.hidden = !next.patron_card;
  }
  obChips();
  obLoad();
}

function showOutbox(panel) {
  const s = obState();
  const codes = T.data?.codes || [];
  panel.innerHTML = html`<div class="nt-outbox">
    <div class="filter-bar" id="ob-filters" role="region" aria-label="${t("ui.filters.label")}">
      <div id="ob-views" class="nt-views"><div class="saved-views rq-views-sk" aria-hidden="true">${[1, 2, 3, 4].map(() => html`<span class="skeleton"></span>`)}</div></div>
      <div class="filter-row">
        ${searchField({ name: "patron_card", label: t("people.notices.patron_card"), value: s.patron_card, placeholder: t("people.notices.patron_card_hint"), shortcut: "" })}
        ${selectChip({ name: "channel", label: t("people.col.channel"), value: s.channel, options: [["", t("people.notices.any_channel")], ["email", t("people.channel.email")], ["sms", t("people.channel.sms")]] })}
        ${selectChip({ name: "code", label: t("people.notices.notice"), value: s.code, options: [["", t("people.notices.any_notice")], ...codes.map((c) => [c.code, noticeName(c.code, c.name)])] })}
      </div>
      <div id="ob-chips"></div>
    </div>
    <div id="ob-table">${tablePlaceholder(3)}</div></div>`;
  ob.table = null;
  onRowOpen($("#ob-table"), (k) => ob.rows.find((n) => String(n.id) === k), (n) => openNotice(n, obLoad));
  $("#ob-table").addEventListener("click", (e) => {
    const b = e.target.closest("[data-open]");
    if (b) openNotice(ob.rows.find((n) => n.id === Number(b.dataset.open)), obLoad);
    if (e.target.closest("[data-clear-filters]")) obApply({ status: "", channel: "", code: "", patron_card: "" }, true);
  });
  wireFilterBar($("#ob-filters"), (c) => obApply(c, true), { keys: OB_KEYS });
  $("#ob-views").addEventListener("click", (e) => { const b = e.target.closest("[data-ob-status]"); if (b) obApply({ status: b.dataset.obStatus }); });
  obChips();
  obLoad();
}

// ------------------------------------------------------------------ wiring

export default async function init() {
  wireKit();
  P = await perms();
  if (!T.data) api("/notices/templates").then((d) => { T.data ||= d; }).catch(() => {});
  const panel = $("#nt-panel");
  let current = null;
  let suppress = false;
  const tabs = wireTabsPanel($(".nt-page"), async (tab) => {
    if (suppress) return;
    if (current === "templates" && tab !== "templates" && dirty() && !(await confirmLeave())) {
      suppress = true; tabs.select("templates"); suppress = false; // put the tab back without re-rendering the editor
      return;
    }
    current = tab;
    if (tab === "templates") {
      // Keep any outbox filters out of the address when editing templates.
      if (location.search) history.replaceState(null, "", `${location.pathname}#templates`);
      showTemplates(panel);
    } else {
      if (!T.data) T.data = await api("/notices/templates").catch(() => null);
      showOutbox(panel);
    }
  }, { hash: true });

  panel.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.code && b.dataset.code !== T.code) {
      if (!(await confirmLeave())) return;
      T.code = b.dataset.code;
      renderTemplates(panel);
      $(`.nt-item[data-code="${T.code}"]`)?.focus();
    } else if (b.dataset.channel && b.dataset.channel !== T.channel) {
      if (!(await confirmLeave())) return;
      T.channel = b.dataset.channel;
      renderTemplates(panel);
      $(`[data-channel="${T.channel}"]`)?.focus();
    } else if (b.dataset.var) insertVar(b.dataset.var);
    else if (b.id === "nt-reset") resetTemplate();
  });
  panel.addEventListener("keydown", (e) => {
    const r = e.target.closest?.('[role="radio"][data-channel]');
    if (!r || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const radios = $$('[role="radio"][data-channel]', panel);
    const next = radios[(radios.indexOf(r) + 1) % radios.length];
    next.click();
  });
  panel.addEventListener("focusin", (e) => { if (e.target.id === "nt-subject" || e.target.id === "nt-body") T.lastField = e.target; });
  panel.addEventListener("input", (e) => {
    if (e.target.id === "nt-pv-card") { T.previewCard = e.target.value; runPreview(); }
    else if (e.target.id === "nt-subject" || e.target.id === "nt-body") runPreview();
  });
  // Unsaved-changes guard for the template editor (one listener for the page, not one per rendered form).
  window.addEventListener("beforeunload", (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || e.defaultPrevented || !dirty()) return;
    const url = new URL(a.href, location.href);
    if (url.pathname === location.pathname && url.search === location.search) return;
    if (!window.confirm(t("ui.form.leave_confirm"))) e.preventDefault(); // eslint-disable-line no-alert
  }, true);

  $("#deliver-now")?.addEventListener("click", async (e) => {
    try {
      const r = await withBusy(e.currentTarget, () => api("/notices/outbox/deliver", { method: "POST" }));
      toast(t("people.notices.delivered", { sent: num(r.sent), retry: num(r.retry), failed: num(r.failed) }), r.failed ? "warn" : "success");
      if (current === "outbox") obLoad();
      else api("/notices/outbox?status=failed&per_page=1").then((x) => setTabCount("failed", x.counts?.failed || 0, { tone: "danger" })).catch(() => {});
    } catch { /* toasted */ }
  });
  if (current !== "outbox") api("/notices/outbox?status=failed&per_page=1").then((r) => setTabCount("failed", r.counts?.failed || 0, { tone: "danger" })).catch(() => setTabCount("failed", null));
}
