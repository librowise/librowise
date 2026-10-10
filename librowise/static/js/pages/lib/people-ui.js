// Helpers shared by the staff People pages (patron detail, patron requests, notices, my account & security).
// Builds on the family kit (/static/js/pages/lib/admin-kit.js) — use that for pills, row menus, facts lists
// and copy buttons. Strings: people.* in librowise/i18n/admin-people/<lang>.json.
import { $, api, datetime, html, icon, num, raw, relative, toast, withBusy } from "/static/js/core.js";
import { formatList, t } from "/static/js/i18n.js";
import { sidePanel } from "/static/js/ui/panel.js";
import { statusPill } from "/static/js/ui/status.js";
import { dl } from "/static/js/pages/lib/admin-kit.js";

// ------------------------------------------------------------------ permissions

let mePromise = null;
/** The signed-in user's permissions (cached for the page). Resolves to a Set; "*" means everything. */
export function perms() {
  mePromise ||= api("/auth/me").then((me) => new Set(me.permissions || [])).catch(() => new Set());
  return mePromise;
}
export const can = (set, perm) => set.has("*") || set.has(perm);

// ------------------------------------------------------------------ header "More" menu

let menuSeq = 0;
/**
 * A labelled "More" button whose menu reuses the kit's row-menu behaviour (wireKit()): choosing an item
 * dispatches the bubbling `rowmenu` CustomEvent with detail.action. Items: { id, label, icon, href, danger, external }.
 */
export function moreMenu({ label = t("people.common.more"), name = "", items }) {
  const list = items.filter((i) => i && !i.hidden);
  if (!list.length) return "";
  const id = `pp-more-${++menuSeq}`;
  const safe = list.filter((i) => !i.danger), danger = list.filter((i) => i.danger);
  const item = (i) => (i.href
    ? html`<a role="menuitem" href="${i.href}" ${i.external ? raw('target="_blank" rel="noopener"') : ""}>${i.icon ? icon(i.icon) : ""}<span>${i.label}</span></a>`
    : html`<button type="button" role="menuitem" class="${i.danger ? "danger" : ""}" data-menu-action="${i.id}">${i.icon ? icon(i.icon) : ""}<span>${i.label}</span></button>`);
  return html`<span class="lw-rowmenu"><button type="button" class="btn" data-rowmenu aria-haspopup="menu" aria-expanded="false" aria-controls="${id}"
      ${name ? html`aria-label="${t("admin.kit.more_actions_for", { name })}"` : ""}>${icon("more")}<span>${label}</span></button>
    <div class="menu popover lw-floating" id="${id}" role="menu" aria-label="${name ? t("admin.kit.more_actions_for", { name }) : label}" hidden>
      ${safe.map(item)}${safe.length && danger.length ? raw('<hr role="separator">') : ""}${danger.map(item)}</div></span>`;
}

// ------------------------------------------------------------------ tabs with reserved counts

/** Fill a server-rendered, space-reserved tab count (`<span class="count pp-count" data-count="x">`). */
export function setTabCount(name, n, { tone = "" } = {}) {
  const el = $(`[data-count="${name}"]`);
  if (!el) return;
  const show = n !== null && n !== undefined && n !== "";
  el.textContent = show ? num(n) : "";
  el.classList.toggle("is-ready", show);
  el.classList.toggle("tone-danger", tone === "danger" && Number(n) > 0);
  el.classList.toggle("tone-warning", tone === "warning" && Number(n) > 0);
  el.setAttribute("aria-hidden", show ? "false" : "true");
}

// ------------------------------------------------------------------ data-table helpers

/** Stable client-side sort for a dataTable that holds every row (no server paging). */
export function sortRows(rows, { key, dir }, getters = {}) {
  const get = getters[key] || ((r) => r[key]);
  const mul = dir === "desc" ? -1 : 1;
  const cmp = (a, b) => {
    const x = get(a), y = get(b);
    if (x === y) return 0;
    if (x === null || x === undefined || x === "") return 1;
    if (y === null || y === undefined || y === "") return -1;
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" })) * mul;
  };
  return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => cmp(a, b) || i - j).map(([r]) => r);
}

/**
 * Placeholder shown where a dataTable will appear, until its first data arrives. Creating the table only
 * then (instead of table.setLoading() on an empty table) avoids a layout shift when the real rows replace
 * eight skeleton rows. Later reloads use setLoading() as usual (they follow user input).
 */
export const tablePlaceholder = (rows = 3) => html`<div class="card pp-table-sk" aria-hidden="true"><div class="pp-table-sk-bar"><span class="skeleton sk-line"></span></div>
  ${Array.from({ length: rows }, () => html`<div class="pp-table-sk-row"><span class="skeleton sk-line"></span><span class="skeleton sk-line"></span><span class="skeleton sk-line"></span></div>`)}</div>`;

/** A fresh element inside `host` for dataTable() (so listeners from a previous table never stack up). */
export function freshTableHost(host) {
  host.innerHTML = "<div></div>";
  return host.firstElementChild;
}

/**
 * Open something (usually a side panel) when a table row is clicked or Enter is pressed on it — for tables
 * whose rows are reviewed in place rather than navigated to. `find(key)` returns the row for a data-key.
 */
export function onRowOpen(tableEl, find, open) {
  const ignore = "a,button,input,label,select,textarea,summary,[data-rowmenu]";
  tableEl.addEventListener("click", (e) => {
    const tr = e.target.closest("tbody tr[data-key]");
    if (!tr || e.target.closest(ignore)) return;
    const row = find(tr.dataset.key);
    if (row) open(row, tr);
  });
  tableEl.addEventListener("keydown", (e) => {
    const tr = e.target.closest?.("tbody tr[data-key]");
    if (!tr || e.target !== tr || e.key !== "Enter") return;
    const row = find(tr.dataset.key);
    if (row) { e.preventDefault(); open(row, tr); }
  });
  tableEl.classList.add("pp-rows-open");
}

// ------------------------------------------------------------------ humanised values

const NOTICE_CODES = {
  HOLD_READY: ["people.notices.code.hold_ready", "people.notices.code_desc.hold_ready"],
  DUE_SOON: ["people.notices.code.due_soon", "people.notices.code_desc.due_soon"],
  OVERDUE: ["people.notices.code.overdue", "people.notices.code_desc.overdue"],
  PURCHASE_SUGGESTION_UPDATE: ["people.notices.code.purchase_suggestion_update", "people.notices.code_desc.purchase_suggestion_update"],
  WELCOME: ["people.notices.code.welcome", "people.notices.code_desc.welcome"],
  REGISTRATION_APPROVED: ["people.notices.code.registration_approved", "people.notices.code_desc.registration_approved"],
  REGISTRATION_REJECTED: ["people.notices.code.registration_rejected", "people.notices.code_desc.registration_rejected"],
};
const deSnake = (s) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Translated name of a notice type ("HOLD_READY" → "Hold ready for pickup"); unknown codes use the server's name. */
export const noticeName = (code, fallback = "") => (NOTICE_CODES[code] ? t(NOTICE_CODES[code][0]) : (fallback || (code ? deSnake(code) : t("people.notices.custom_notice"))));
export const noticeDescription = (code, fallback = "") => (NOTICE_CODES[code] ? t(NOTICE_CODES[code][1]) : fallback);

export const channelLabel = (ch) => ({ email: t("people.channel.email"), sms: t("people.channel.sms"), none: t("people.channel.none") }[ch] || deSnake(ch));
export const channelIcon = (ch) => ({ email: "send", sms: "inbox" }[ch] || "bell");

const LEDGER = {
  overdue: ["warning", "people.ledger.kind.overdue"], lost: ["danger", "people.ledger.kind.lost"],
  manual: ["warning", "people.ledger.kind.manual"], payment: ["success", "people.ledger.kind.payment"],
  waiver: ["info", "people.ledger.kind.waiver"],
};
/** [tone, label] for a ledger entry kind. */
export const ledgerKind = (kind) => (LEDGER[kind] ? [LEDGER[kind][0], t(LEDGER[kind][1])] : ["neutral", deSnake(kind)]);

const FIELDS = {
  first_name: "people.field.first_name", last_name: "people.field.last_name", email: "people.field.email", phone: "people.field.phone",
  address: "people.field.address", date_of_birth: "people.field.date_of_birth", category_id: "people.field.category",
  home_branch_id: "people.field.home_branch", expires_on: "people.field.expires_on", role: "people.field.role",
  password: "people.field.password", notes: "people.field.notes", is_active: "people.field.is_active",
  keep_history: "people.field.keep_history", card_number: "people.field.card_number", preferences: "people.field.preferences",
};
export const fieldName = (f) => (FIELDS[f] ? t(FIELDS[f]) : deSnake(f));

// Audit actions → [icon, tone, i18n key]. Keys take {title} {amount} {due} {date} {fields} {count} {method}.
const ACTIVITY = {
  create: ["user-plus", "info", "people.activity.action.create"],
  update: ["edit", "neutral", "people.activity.action.update"],
  renew_membership: ["refresh", "success", "people.activity.action.renew_membership"],
  erase: ["trash", "danger", "people.activity.action.erase"],
  payment: ["wallet", "success", "people.activity.action.payment"],
  waive: ["wallet", "info", "people.activity.action.waive"],
  charge: ["wallet", "warning", "people.activity.action.charge"],
  self_register: ["user-plus", "info", "people.activity.action.self_register"],
  registration_approved: ["check-circle", "success", "people.activity.action.registration_approved"],
  registration_rejected: ["x-circle", "danger", "people.activity.action.registration_rejected"],
  messaging_preferences: ["bell", "neutral", "people.activity.action.messaging_preferences"],
  login: ["key", "neutral", "people.activity.action.login"],
  login_failed: ["alert", "warning", "people.activity.action.login_failed"],
  login_locked: ["shield", "danger", "people.activity.action.login_locked"],
  logout: ["logout", "neutral", "people.activity.action.logout"],
  login_mfa_challenge: ["shield", "neutral", "people.activity.action.login_mfa_challenge"],
  mfa_failed: ["shield", "warning", "people.activity.action.mfa_failed"],
  mfa_recovery_code_used: ["shield", "warning", "people.activity.action.mfa_recovery_code_used"],
  mfa_setup_started: ["shield", "neutral", "people.activity.action.mfa_setup_started"],
  mfa_enabled: ["shield", "success", "people.activity.action.mfa_enabled"],
  mfa_disabled: ["shield", "warning", "people.activity.action.mfa_disabled"],
  mfa_recovery_codes_regenerated: ["shield", "neutral", "people.activity.action.mfa_recovery_codes_regenerated"],
  mfa_reset: ["shield", "warning", "people.activity.action.mfa_reset"],
  password_changed: ["key", "neutral", "people.activity.action.password_changed"],
  password_reset_requested: ["key", "neutral", "people.activity.action.password_reset_requested"],
  password_reset: ["key", "neutral", "people.activity.action.password_reset"],
  session_revoked: ["logout", "neutral", "people.activity.action.session_revoked"],
  sessions_revoked_all: ["logout", "warning", "people.activity.action.sessions_revoked_all"],
  api_token_created: ["code", "neutral", "people.activity.action.api_token_created"],
  api_token_revoked: ["code", "neutral", "people.activity.action.api_token_revoked"],
  api_tokens_revoked_all: ["code", "warning", "people.activity.action.api_tokens_revoked_all"],
  identity_linked: ["globe", "neutral", "people.activity.action.identity_linked"],
  identity_unlinked: ["globe", "neutral", "people.activity.action.identity_unlinked"],
  staff_role_assigned: ["shield", "info", "people.activity.action.staff_role_assigned"],
  unlock: ["key", "success", "people.activity.action.unlock"],
  kiosk_login: ["monitor", "neutral", "people.activity.action.kiosk_login"],
  kiosk_login_failed: ["monitor", "warning", "people.activity.action.kiosk_login_failed"],
  kiosk_logout: ["monitor", "neutral", "people.activity.action.kiosk_logout"],
  sip2_block_patron: ["alert", "danger", "people.activity.action.sip2_block_patron"],
  sip2_patron_enable: ["check-circle", "success", "people.activity.action.sip2_patron_enable"],
  checkout: ["arrow-up", "info", "people.activity.action.checkout"],
  kiosk_checkout: ["arrow-up", "info", "people.activity.action.kiosk_checkout"],
  renew: ["refresh", "info", "people.activity.action.renew"],
  kiosk_renew: ["refresh", "info", "people.activity.action.kiosk_renew"],
  checkin: ["arrow-down", "success", "people.activity.action.checkin"],
  mark_lost: ["alert", "danger", "people.activity.action.mark_lost"],
  place_hold: ["bookmark-plus", "info", "people.activity.action.place_hold"],
  hold_cancelled: ["x-circle", "neutral", "people.activity.action.hold_cancelled"],
  hold_expired: ["clock", "neutral", "people.activity.action.hold_expired"],
  hold_fulfilled: ["check-circle", "success", "people.activity.action.hold_fulfilled"],
  hold_ready: ["bookmark", "info", "people.activity.action.hold_ready"],
  hold_queued: ["bookmark", "neutral", "people.activity.action.hold_queued"],
  hold_suspended: ["clock", "neutral", "people.activity.action.hold_suspended"],
  hold_resumed: ["refresh", "info", "people.activity.action.hold_resumed"],
  hold_updated: ["edit", "neutral", "people.activity.action.hold_updated"],
  suggestion_created: ["cart", "info", "people.activity.action.suggestion_created"],
  suggestion_withdrawn: ["cart", "neutral", "people.activity.action.suggestion_withdrawn"],
  suggestion_accepted: ["cart", "success", "people.activity.action.suggestion_accepted"],
  suggestion_rejected: ["cart", "neutral", "people.activity.action.suggestion_rejected"],
};

/** { icon, tone, text } for an event from GET /patrons/{id}/activity — never the raw action code. */
export function activityInfo(e, { money = (v) => v, date = (v) => v } = {}) {
  const d = e.details || {};
  const params = {
    title: e.subject?.title || t("people.activity.unknown_title"),
    amount: d.amount !== undefined ? money(d.amount) : d.charged !== undefined ? money(d.charged) : "",
    due: d.due ? date(d.due) : "",
    date: d.expires_on ? date(d.expires_on) : d.until ? date(d.until) : "",
    fields: Array.isArray(d.fields) && d.fields.length ? formatList(d.fields.map(fieldName)) : t("people.activity.some_details"),
    count: Number(d.count ?? d.sessions_revoked ?? 0),
  };
  const def = ACTIVITY[e.action];
  if (def) return { icon: def[0], tone: def[1], text: t(def[2], params) };
  return { icon: "activity", tone: "neutral", text: t("people.activity.action.other", { action: deSnake(e.action) }) };
}

// ------------------------------------------------------------------ one outbox message in a side panel

const noticeStatus = (s) => statusPill("notice", s, { pending: t("people.notices.status.pending"), sent: t("people.notices.status.sent"), failed: t("people.notices.status.failed") }[s]);
export { noticeStatus };

function noticeBody(n) {
  return html`${dl([
    [t("people.col.message"), noticeName(n.code)],
    n.patron ? [t("people.col.patron"), html`<a href="/staff/patrons/${n.patron.id}">${n.patron.full_name}</a> <span class="mono small" dir="ltr">${n.patron.card_number}</span>`] : null,
    [t("people.col.channel"), channelLabel(n.channel)],
    [t("people.col.to"), n.to ? html`<span dir="ltr">${n.to}</span>` : t("people.notices.no_address")],
    [t("people.col.status"), noticeStatus(n.status)],
    [t("people.col.created"), datetime(n.created_at)],
    n.sent_at ? [t("people.notices.sent_at"), datetime(n.sent_at)] : null,
    [t("people.col.attempts"), num(n.attempts)],
    n.status === "pending" && n.next_attempt_at ? [t("people.notices.next_attempt"), html`<span title="${datetime(n.next_attempt_at)}">${relative(n.next_attempt_at)}</span>`] : null,
  ])}
  ${n.last_error ? html`<div class="alert bad pp-error" role="alert">${icon("alert")}<div class="pp-error-text"><strong>${t("people.notices.last_error")}</strong>
    <pre class="pp-pre" tabindex="0" role="region" aria-label="${t("people.notices.last_error")}">${n.last_error}</pre></div></div>` : ""}
  <h3 class="pp-mail-label">${t("people.notices.message_as_sent")}</h3>
  <div class="pp-mail ${n.channel === "sms" ? "is-sms" : ""}">${n.channel !== "sms" ? html`<div class="pp-mail-subject">${n.subject}</div>` : ""}<div class="pp-mail-body">${n.body}</div></div>`;
}

/** Full outbox message (meta, error, body as sent) in a side panel with Resend. `after()` runs after a resend. */
export function openNotice(n, after) {
  if (!n) return null;
  const canResend = n.status !== "pending";
  const panel = sidePanel({ title: n.subject || noticeName(n.code), subtitle: noticeDescription(n.code), wide: true, body: noticeBody(n),
    footer: html`<button type="button" class="btn" data-close>${t("common.close")}</button>${canResend ? html`<button type="button" class="btn primary" data-resend>${icon("refresh")}${t("people.notices.resend")}</button>` : ""}` });
  $("[data-resend]", panel.el)?.addEventListener("click", async (e) => {
    try {
      await withBusy(e.currentTarget, () => api(`/notices/outbox/${n.id}/resend`, { method: "POST" }));
      toast(t("people.notices.resent"), "success");
      panel.close();
      after?.();
    } catch { /* toasted */ }
  });
  return panel;
}

/** Plain-text excerpt (first line, trimmed) of a long message. */
export const excerpt = (s, n = 90) => {
  const line = String(s || "").split("\n").find((l) => l.trim()) || "";
  return line.length > n ? `${line.slice(0, n - 1).trimEnd()}…` : line;
};
