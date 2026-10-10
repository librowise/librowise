// Staff › Patrons › patron — DETAIL PAGE (docs/DESIGN_SYSTEM.md §6): header with avatar, status pills and
// quick actions → tabs with hash deep links (#loans, #holds, #history, #account, #messages, #activity, #recs)
// → panels that each have a sized skeleton, an empty state with a next step and an error state with retry.
import { $, $$, BOOT, api, authors, cover, date, datetime, html, icon, modal, money, num, parseDate, raw, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { avatar } from "/static/js/ui/avatar.js";
import { combobox } from "/static/js/ui/combobox.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { confirmDestructive, confirmDialog } from "/static/js/ui/dialog.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { setCrumb } from "/static/js/ui/page-header.js";
import { progress, statTile } from "/static/js/ui/stat.js";
import { statusPill } from "/static/js/ui/status.js";
import { wireTabsPanel } from "/static/js/ui/tabs.js";
import { copyButton, dl, pill, rowMenu, wireKit } from "/static/js/pages/lib/admin-kit.js";
import { activityInfo, can, channelIcon, channelLabel, freshTableHost, ledgerKind, moreMenu, noticeDescription, noticeName, noticeStatus, onRowOpen, openNotice, perms, setTabCount, sortRows, tablePlaceholder } from "/static/js/pages/lib/people-ui.js";
import { patronForm, patronPayload } from "/static/js/pages/staff-patrons.js";

const DAY = 86400000;
const pid = () => Number(BOOT.path_params.patron_id);
let p = null, lk = { branches: [], categories: [] }, P = new Set(), tabsCtl = null, current = "overview";
const allow = (perm) => can(P, perm);
const panelEl = () => $("#pp-panel");
// Listeners a panel adds are bound to the tab that is showing; switching tabs aborts them.
let panelScope = new AbortController(), lastShow = null;
const on = (el, type, fn) => el.addEventListener(type, fn, { signal: panelScope.signal });

// ------------------------------------------------------------------ derived state

function membership() {
  if (!p.expires_on) return { state: "none", days: null };
  const days = Math.ceil((parseDate(p.expires_on) - Date.now()) / DAY);
  return { state: days < 0 ? "expired" : days <= 30 ? "expiring" : "ok", days };
}
const overdueLoans = () => p.loans.filter((l) => l.overdue);
const readyHolds = () => p.holds.filter((h) => h.status === "ready");

function blockText(b) {
  if (b.code === "inactive") return t("people.patron.block.inactive");
  if (b.code === "expired") return t("people.patron.block.expired", { date: date(b.date) });
  if (b.code === "fines") return t("people.patron.block.fines", { amount: money(b.amount), limit: money(b.limit) });
  return b.code;
}

// ------------------------------------------------------------------ header

function statusPills() {
  const m = membership();
  const out = [p.is_active ? statusPill("patron", "active") : statusPill("patron", "inactive")];
  if (p.registration_status === "pending") {
    out.push(html`<a class="badge pill warning pp-pill-link" href="/staff/requests">${raw('<span class="dot" aria-hidden="true"></span>')}${t("people.patron.pill.registration_pending")}</a>`);
  }
  if (m.state === "expired") out.push(statusPill("patron", "expired", t("people.patron.pill.expired")));
  else if (m.state === "expiring") out.push(statusPill("patron", "expiring", m.days <= 0 ? t("people.patron.pill.expires_today") : t("people.patron.pill.expires_in", { count: m.days })));
  if ((p.block_reasons || p.blocks || []).length) out.push(pill("danger", t("people.patron.pill.blocked")));
  if (p.balance > 0) out.push(statusPill("patron", "owing", t("people.patron.pill.owes", { amount: money(p.balance) })));
  if (overdueLoans().length) out.push(statusPill("loan", "overdue", t("people.patron.pill.overdue", { count: overdueLoans().length })));
  if (p.role !== "patron") out.push(statusPill("patron", "staff", t(`ui.role.${p.role}`)));
  if (p.staff_role) out.push(pill("info", p.staff_role.name));
  if (!p.keep_history) out.push(pill("neutral", t("people.patron.pill.history_off")));
  return out;
}

function headerActions() {
  const m = membership();
  const more = moreMenu({ name: p.full_name, items: [
    allow("patrons:write") && { id: "prefs", label: t("people.patron.action.notification_prefs"), icon: "bell" },
    allow("circulation") && { id: "pay", label: t("people.patron.action.take_payment"), icon: "wallet" },
    allow("labels") && { id: "card", label: t("people.patron.action.print_card"), icon: "printer",
      href: `/staff/labels/print?kind=patron&patron_ids=${p.id}`, external: true },
    { id: "activity", label: t("people.patron.action.view_activity"), icon: "activity" },
  ] });
  return html`<div class="pp-actions">
    ${allow("holds:manage") ? html`<button type="button" class="btn" data-act="hold">${icon("bookmark-plus")}${t("people.patron.action.place_hold")}</button>` : ""}
    ${allow("patrons:write") ? html`<button type="button" class="btn" data-act="edit">${icon("edit")}${t("people.patron.action.edit")}</button>` : ""}
    ${allow("patrons:write") && m.state !== "ok" && m.state !== "none" ? html`<button type="button" class="btn" data-act="renew-membership">${icon("refresh")}${t("people.patron.action.renew_membership")}</button>` : ""}
    ${more}
    ${allow("circulation") ? html`<a class="btn primary" href="/staff/circulation?patron=${encodeURIComponent(p.card_number)}#checkout">${icon("arrow-up")}${t("people.patron.action.checkout")}</a>` : ""}
  </div>`;
}

function renderHeader() {
  const blocks = p.block_reasons ? p.block_reasons.map(blockText) : (p.blocks || []);
  const contact = [
    p.email ? html`<a href="mailto:${p.email}">${icon("send")}<span>${p.email}</span></a>` : "",
    p.phone ? html`<a href="tel:${p.phone}" class="num"><span class="sr-only">${t("people.field.phone")}</span><span dir="ltr">${p.phone}</span></a>` : "",
    p.address ? html`<span>${icon("map")}<span>${p.address}</span></span>` : "",
  ].filter(Boolean);
  const head = $("#pp-head");
  head.removeAttribute("aria-busy");
  head.classList.toggle("is-blocked", blocks.length > 0);
  head.innerHTML = html`<div class="pp-head-main">
      ${avatar(p.full_name, { size: "lg" })}
      <div class="pp-head-text">
        <div class="pp-title-row"><h1 id="page-title">${p.full_name}</h1><div class="pp-pills">${statusPills()}</div></div>
        <div class="pp-meta"><span class="pp-cardno"><span class="sr-only">${t("people.patron.card_number")}</span><span class="mono" dir="ltr">${p.card_number}</span>${copyButton(p.card_number, { label: t("people.patron.copy_card") })}</span>
          <span class="pp-sep" aria-hidden="true">·</span><span>${p.category.name}</span><span class="pp-sep" aria-hidden="true">·</span><span>${p.home_branch.name}</span></div>
        ${contact.length ? html`<div class="pp-contact">${contact}</div>` : html`<div class="pp-contact muted">${t("people.patron.no_contact")}</div>`}
      </div>
      ${headerActions()}
    </div>
    ${blocks.length ? html`<div class="pp-block" role="status">${icon("alert")}<div><strong>${t("people.patron.blocked_title")}</strong>
      <ul>${blocks.map((b) => html`<li>${b}</li>`)}</ul></div>
      <div class="pp-block-actions">
        ${allow("patrons:write") && (p.block_reasons || []).some((b) => b.code === "expired") ? html`<button type="button" class="btn sm" data-act="renew-membership">${icon("refresh")}${t("people.patron.action.renew_membership")}</button>` : ""}
        ${allow("circulation") && (p.block_reasons || []).some((b) => b.code === "fines") ? html`<button type="button" class="btn sm" data-act="pay">${icon("wallet")}${t("people.patron.action.take_payment")}</button>` : ""}
      </div></div>` : ""}
    ${p.notes ? html`<div class="pp-note">${icon("info")}<div><span class="pp-note-label">${t("people.patron.staff_note")}</span> ${p.notes}</div></div>` : ""}`;
  setTabCount("loans", p.loans.length, { tone: overdueLoans().length ? "danger" : "" });
  setTabCount("holds", p.holds.length, { tone: readyHolds().length ? "warning" : "" });
}

// ------------------------------------------------------------------ panels

const card = (title, body, { id = "", actions = "", cls = "" } = {}) => {
  const hid = id || `pp-h-${title.length}-${Math.random().toString(36).slice(2, 7)}`;
  return html`<section class="card pp-card ${cls}" aria-labelledby="${hid}"><div class="card-head"><h2 id="${hid}">${title}</h2>${actions}</div><div class="card-body">${body}</div></section>`;
};

const titleCell = (b, sub = "") => html`<div class="dt-cell-stack"><a href="/staff/catalog/${b.id}">${b.title}</a><span class="sub">${sub || authors(b.authors) || ""}</span></div>`;

// ---- overview

function timeline(events, { compact = false } = {}) {
  return html`<ol class="pp-timeline ${compact ? "compact" : ""}">${events.map((e) => {
    const info = activityInfo(e, { money, date });
    const who = e.by_patron ? t("people.activity.by_patron") : e.actor ? t("people.activity.by", { name: e.actor.full_name }) : t("people.activity.by_system");
    return html`<li class="tone-${info.tone}"><span class="pp-tl-icon" aria-hidden="true">${icon(info.icon)}</span>
      <div class="pp-tl-body"><div class="pp-tl-text">${e.subject?.biblio_id ? html`${info.text} <a class="pp-tl-link" href="/staff/catalog/${e.subject.biblio_id}" aria-label="${t("people.activity.open_record", { title: e.subject.title })}">${icon("arrow-right")}</a>` : info.text}</div>
        <div class="pp-tl-meta"><span>${who}</span><span aria-hidden="true">·</span><time datetime="${e.at}" title="${datetime(e.at)}">${relative(e.at)}</time></div></div></li>`;
  })}</ol>`;
}

async function overview(panel) {
  const recent = await (recentPromise || fetchRecent());
  const m = membership();
  const lim = p.limits || {};
  const loanTile = statTile({ label: t("people.patron.tile.loans"), icon: "repeat",
    value: lim.max_loans ? html`${num(p.loans.length)}<span class="pp-of">/ ${num(lim.max_loans)}</span>` : num(p.loans.length),
    tone: overdueLoans().length ? "danger" : "",
    foot: html`${lim.max_loans ? progress({ value: Math.min(p.loans.length, lim.max_loans), max: lim.max_loans, label: t("people.patron.tile.loans_usage"), showValue: false, tone: p.loans.length >= lim.max_loans ? "warning" : "" }) : ""}
      <span>${overdueLoans().length ? t("people.patron.tile.overdue", { count: overdueLoans().length }) : t("people.patron.tile.none_overdue")}</span>` });
  const holdTile = statTile({ label: t("people.patron.tile.holds"), icon: "bookmark",
    value: lim.max_holds ? html`${num(p.holds.length)}<span class="pp-of">/ ${num(lim.max_holds)}</span>` : num(p.holds.length),
    foot: html`${lim.max_holds ? progress({ value: Math.min(p.holds.length, lim.max_holds), max: lim.max_holds, label: t("people.patron.tile.holds_usage"), showValue: false }) : ""}
      <span>${readyHolds().length ? t("people.patron.tile.ready", { count: readyHolds().length }) : t("people.patron.tile.none_ready")}</span>` });
  const balTile = statTile({ label: t("people.patron.tile.balance"), icon: "wallet", value: money(p.balance), tone: p.balance > 0 ? "danger" : "",
    foot: html`<span>${p.balance > 0 ? t("people.patron.tile.owes") : t("people.patron.tile.settled")}</span>` });
  const memTile = statTile({ label: t("people.patron.tile.membership"), icon: "calendar",
    value: m.state === "none" ? t("people.patron.tile.no_expiry") : m.state === "expired" ? t("people.patron.tile.expired")
      : m.days <= 0 ? t("people.patron.pill.expires_today") : t("people.patron.tile.days_left", { count: m.days }),
    tone: m.state === "expired" ? "danger" : m.state === "expiring" ? "warning" : "",
    foot: html`<span>${p.expires_on ? (m.state === "expired" ? t("people.patron.expired_on", { date: date(p.expires_on) }) : t("people.patron.valid_until", { date: date(p.expires_on) })) : t("people.patron.tile.no_expiry_hint")}</span>` });

  const contact = dl([
    [t("people.field.email"), p.email ? html`<a href="mailto:${p.email}">${p.email}</a>` : ""],
    [t("people.field.phone"), p.phone ? html`<span dir="ltr">${p.phone}</span>` : ""],
    [t("people.field.address"), p.address],
    [t("people.field.date_of_birth"), p.date_of_birth ? date(p.date_of_birth) : ""],
  ]);
  const regLabel = { pending: t("people.patron.reg.pending"), approved: t("people.patron.reg.approved"), rejected: t("people.patron.reg.rejected") };
  const member = dl([
    [t("people.field.card_number"), html`<span class="mono" dir="ltr">${p.card_number}</span>`],
    [t("people.field.category"), p.category.name],
    [t("people.field.home_branch"), p.home_branch.name],
    [t("people.field.member_since"), p.created_at ? date(p.created_at) : ""],
    [t("people.field.expires_on"), p.expires_on ? date(p.expires_on) : t("people.patron.tile.no_expiry")],
    lim.max_loans ? [t("people.field.limits"), t("people.patron.limits_text", { loans: num(lim.max_loans), holds: num(lim.max_holds) })] : null,
    [t("people.field.last_login"), p.last_login_at ? html`<span title="${datetime(p.last_login_at)}">${relative(p.last_login_at)}</span>` : t("people.patron.never")],
    [t("people.field.keep_history"), p.keep_history ? t("people.patron.history_on") : t("people.patron.history_off")],
    p.registration_status ? [t("people.field.registration"), regLabel[p.registration_status] || p.registration_status] : null,
    p.role !== "patron" || p.staff_role ? [t("people.field.role"), [t(`ui.role.${p.role}`), p.staff_role?.name].filter(Boolean).join(" · ")] : null,
  ]);

  const canErase = allow("patrons:delete") && p.id !== BOOT.user?.id;
  const eraseBlockers = [p.loans.length ? t("people.patron.erase_blocker_loans", { count: p.loans.length }) : "",
    p.balance > 0 ? t("people.patron.erase_blocker_balance", { amount: money(p.balance) }) : ""].filter(Boolean);

  panel.innerHTML = html`<div class="pp-overview">
    <div class="pp-main">
      <section class="grid kpi-grid compact pp-tiles" aria-label="${t("people.patron.at_a_glance")}">${loanTile}${holdTile}${balTile}${memTile}</section>
      ${card(t("people.patron.recent_activity"), html`<div id="pp-recent" class="pp-recent">${recent.error ? errorState(recent.error, { retry: false })
        : recent.results.length ? timeline(recent.results, { compact: true })
          : emptyState({ art: "inbox", compact: true, title: t("people.patron.activity_empty_title"), body: t("people.patron.activity_empty_body") })}</div>`, { id: "pp-recent-h",
        actions: html`<button type="button" class="btn sm ghost" data-goto="activity">${t("people.patron.view_all")}${icon("arrow-right", "pp-flip")}</button>` })}
      ${canErase ? html`<section class="card pp-danger" aria-labelledby="pp-danger-h"><div class="card-head"><h2 id="pp-danger-h">${icon("alert")}${t("people.patron.danger_zone")}</h2></div>
        <div class="card-body pp-danger-row"><div><strong>${t("people.patron.erase_heading")}</strong><p>${t("people.patron.erase_explain")}</p>
          ${eraseBlockers.length ? html`<p class="pp-danger-blocked" id="pp-erase-why">${icon("info")}${t("people.patron.erase_blocked")} ${eraseBlockers.join(" ")}</p>` : ""}</div>
          <button type="button" class="btn danger" data-act="erase" ${eraseBlockers.length ? raw('aria-describedby="pp-erase-why"') : ""}>${icon("trash")}${t("people.patron.action.erase")}</button></div></section>` : ""}
    </div>
    <aside class="pp-side">
      ${card(t("people.patron.contact"), contact, { id: "pp-contact-h", actions: allow("patrons:write") ? html`<button type="button" class="btn sm ghost" data-act="edit">${icon("edit")}${t("people.patron.action.edit")}</button>` : "" })}
      ${card(t("people.patron.membership"), member, { id: "pp-member-h" })}
      ${card(t("people.patron.staff_notes"), p.notes ? html`<p class="pp-notes-text">${p.notes}</p>` : html`<p class="muted small">${t("people.patron.no_notes")}</p>`, { id: "pp-notes-h" })}
    </aside></div>`;
}

// Recent activity for the overview, fetched alongside the patron so the overview renders in one pass (no shift).
let recentPromise = null;
const fetchRecent = () => (recentPromise = api(`/patrons/${pid()}/activity?per_page=6`).catch((error) => ({ error, results: [] })));

const skeletonTimeline = (n) => html`<div class="pp-sk-timeline" aria-hidden="true">${Array.from({ length: n }, () => html`<div class="pp-sk-tl"><div class="skeleton sk-circle"></div><div class="pp-sk-tl-lines"><div class="skeleton sk-line"></div><div class="skeleton sk-line short"></div></div></div>`)}</div>`;

// ---- loans

function loans(panel) {
  panel.innerHTML = html`<div id="pp-loans"></div>`;
  let sort = { key: "due", dir: "asc" };
  const getters = { title: (l) => l.item.biblio.title, due: (l) => l.due_at, issued: (l) => l.issued_at, renewals: (l) => l.renewals };
  const table = dataTable($("#pp-loans"), {
    id: "patron-loans", caption: t("people.patron.loans_caption", { name: p.full_name }), selectable: allow("circulation"),
    rowLabel: (l) => l.item.biblio.title, sort, exportName: `loans-${p.card_number}`,
    onSort: (s) => { sort = s; table.setRows(sortRows(p.loans, s, getters)); },
    columns: [
      { key: "title", label: t("people.col.title"), sortable: true, primary: true, hideable: false, csv: (l) => l.item.biblio.title, render: (l) => titleCell(l.item.biblio) },
      { key: "barcode", label: t("people.col.barcode"), csv: (l) => l.item.barcode, render: (l) => html`<span class="mono small" dir="ltr">${l.item.barcode}</span>` },
      { key: "issued", label: t("people.col.issued"), sortable: true, csv: (l) => l.issued_at, render: (l) => html`<span class="num">${date(l.issued_at)}</span>` },
      { key: "due", label: t("people.col.due"), sortable: true, csv: (l) => l.due_at, render: dueCell },
      { key: "renewals", label: t("people.col.renewals"), align: "num", sortable: true, csv: (l) => l.renewals, render: (l) => num(l.renewals) },
      { key: "actions", label: t("people.col.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions",
        render: (l) => (allow("circulation") ? html`<div class="pp-row-actions"><button type="button" class="btn sm" data-renew="${l.id}">${icon("refresh")}${t("people.patron.action.renew")}</button>
          ${rowMenu({ label: l.item.biblio.title, items: [{ id: "lost", label: t("people.patron.action.mark_lost"), icon: "alert", danger: true }] })}</div>` : "") },
    ],
    bulkActions: allow("circulation") ? [{ id: "renew", label: t("people.patron.action.renew_selected"), icon: "refresh", run: bulkRenew }] : [],
    empty: { art: "books", title: t("people.patron.loans_empty_title"), body: t("people.patron.loans_empty_body"),
      actions: allow("circulation") ? html`<a class="btn primary" href="/staff/circulation?patron=${encodeURIComponent(p.card_number)}#checkout">${icon("arrow-up")}${t("people.patron.action.checkout")}</a>` : "" },
  });
  table.setRows(sortRows(p.loans, sort, getters));
  on(panel, "rowmenu", async (e) => {
    const tr = e.target.closest("[data-key]");
    if (e.detail.action === "lost" && tr) await markLost(Number(tr.dataset.key));
  });
}

function dueCell(l) {
  if (l.overdue) return html`<div class="dt-cell-stack">${statusPill("loan", "overdue", t("people.patron.days_overdue", { count: l.days_overdue }))}<span class="sub num">${date(l.due_at)}</span></div>`;
  const days = Math.ceil((parseDate(l.due_at) - Date.now()) / DAY);
  if (days <= 2) return html`<div class="dt-cell-stack">${statusPill("loan", "due_soon", days <= 0 ? t("people.patron.due_today") : t("people.patron.due_in", { count: days }))}<span class="sub num">${date(l.due_at)}</span></div>`;
  return html`<span class="num">${date(l.due_at)}</span>`;
}

async function renewLoan(id, { quiet = false } = {}) {
  try {
    return await api(`/loans/${id}/renew`, { method: "POST", body: { override: false } });
  } catch (err) {
    if (quiet || err.status !== 422 || !allow("circulation:override")) throw err;
    if (!(await confirmDialog(t("people.patron.renew_blocked_title"), t("people.patron.renew_blocked_text", { reason: err.message }), t("people.patron.renew_override"), false))) return null;
    return api(`/loans/${id}/renew`, { method: "POST", body: { override: true } });
  }
}

async function bulkRenew(rows, ctx) {
  let ok = 0;
  const failed = [];
  await withBusy(ctx.button, async () => {
    for (const l of rows) {
      try { await renewLoan(l.id, { quiet: true }); ok++; } catch (err) { failed.push(`${l.item.biblio.title}: ${err.message}`); }
    }
  }).catch(() => {});
  ctx.clear();
  toast(failed.length ? t("people.patron.renewed_some", { count: ok, failed: failed.length }) : t("people.patron.renewed", { count: ok }), failed.length ? "warn" : "success", failed.length ? 9000 : 4200);
  if (failed.length) console.info(failed.join("\n")); // eslint-disable-line no-console
  await reload();
}

async function markLost(id) {
  const l = p.loans.find((x) => x.id === id);
  if (!l || !(await confirmDialog(t("people.patron.lost_title"), t("people.patron.lost_text", { title: l.item.biblio.title }), t("people.patron.action.mark_lost")))) return;
  try {
    const r = await api(`/loans/${id}/lost`, { method: "POST" });
    toast(t("people.patron.lost_done", { amount: money(r.charged) }), "success");
    await reload();
  } catch (err) { toast(err.message, "error"); }
}

// ---- holds

function holdStatus(h) {
  if (h.suspended) return statusPill("hold", "suspended", h.suspended_until ? t("people.patron.hold.suspended_until", { date: date(h.suspended_until) }) : t("ui.status.suspended"));
  if (h.status === "ready") return html`<div class="dt-cell-stack">${statusPill("hold", "ready")}${h.expires_at ? html`<span class="sub">${t("people.patron.hold.collect_by", { date: date(h.expires_at) })}</span>` : ""}</div>`;
  return html`<div class="dt-cell-stack">${statusPill("hold", h.status)}${h.queue_position ? html`<span class="sub">${t("people.patron.hold.position", { n: num(h.queue_position) })}</span>` : ""}</div>`;
}

function holds(panel) {
  panel.innerHTML = html`<div id="pp-holds"></div>`;
  let sort = { key: "placed", dir: "asc" };
  const getters = { title: (h) => h.biblio.title, placed: (h) => h.created_at, pickup: (h) => h.pickup_branch.name, status: (h) => h.status };
  const table = dataTable($("#pp-holds"), {
    id: "patron-holds", caption: t("people.patron.holds_caption", { name: p.full_name }), rowLabel: (h) => h.biblio.title, sort,
    exportName: `holds-${p.card_number}`, onSort: (s) => { sort = s; table.setRows(sortRows(p.holds, s, getters)); },
    columns: [
      { key: "title", label: t("people.col.title"), sortable: true, primary: true, hideable: false, csv: (h) => h.biblio.title,
        render: (h) => titleCell(h.biblio, [h.item_level && h.requested_item ? t("people.patron.hold.copy_only", { barcode: h.requested_item.barcode }) : authors(h.biblio.authors), h.notes].filter(Boolean).join(" · ")) },
      { key: "status", label: t("people.col.status"), sortable: true, csv: (h) => (h.suspended ? "suspended" : h.status), render: holdStatus },
      { key: "pickup", label: t("people.col.pickup"), sortable: true, csv: (h) => h.pickup_branch.name, render: (h) => h.pickup_branch.name },
      { key: "placed", label: t("people.col.placed"), sortable: true, csv: (h) => h.created_at, render: (h) => html`<span title="${datetime(h.created_at)}">${relative(h.created_at)}</span>` },
      { key: "until", label: t("people.col.not_needed_after"), hidden: true, csv: (h) => h.not_needed_after || "", render: (h) => (h.not_needed_after ? date(h.not_needed_after) : "—") },
      { key: "actions", label: t("people.col.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions",
        render: (h) => (allow("holds:manage") ? rowMenu({ label: h.biblio.title, items: [
          h.status === "queued" && !h.item && !h.suspended && { id: "suspend", label: t("people.patron.hold.suspend"), icon: "clock" },
          h.status === "queued" && !h.item && h.suspended && { id: "resume", label: t("people.patron.hold.resume"), icon: "refresh" },
          h.status === "queued" && { id: "pickup", label: t("people.patron.hold.change_pickup"), icon: "map" },
          { id: "cancel", label: t("people.patron.hold.cancel"), icon: "x-circle", danger: true },
        ] }) : "") },
    ],
    empty: { art: "books", title: t("people.patron.holds_empty_title"), body: t("people.patron.holds_empty_body"),
      actions: allow("holds:manage") ? html`<button type="button" class="btn primary" data-act="hold">${icon("bookmark-plus")}${t("people.patron.action.place_hold")}</button>` : "" },
  });
  table.setRows(sortRows(p.holds, sort, getters));
  on(panel, "rowmenu", (e) => {
    const tr = e.target.closest("[data-key]");
    if (tr) holdAction(e.detail.action, p.holds.find((h) => h.id === Number(tr.dataset.key)));
  });
}

async function holdAction(action, h) {
  if (!h) return;
  try {
    if (action === "suspend") {
      const fd = await modal({ title: t("people.patron.hold.suspend_title"), submit: t("people.patron.hold.suspend"), size: "sm",
        body: html`<p class="small muted">${t("people.patron.hold.suspend_text", { title: h.biblio.title })}</p>
          <div class="field"><label for="hs-until">${t("people.patron.hold.resume_on")} <span class="optional">${t("ui.form.optional")}</span></label><input id="hs-until" name="until" type="date"></div>` });
      if (!fd) return;
      await api(`/holds/${h.id}/suspend`, { method: "POST", body: { until: fd.get("until") || null } });
      toast(t("people.patron.hold.suspended"), "success");
    } else if (action === "resume") {
      await api(`/holds/${h.id}/resume`, { method: "POST" });
      toast(t("people.patron.hold.resumed"), "success");
    } else if (action === "pickup") {
      const fd = await modal({ title: t("people.patron.hold.change_pickup"), submit: t("common.save"), size: "sm",
        body: html`<div class="field"><label for="hp-br">${t("people.col.pickup")}</label><select id="hp-br" name="pickup_branch_id">${lk.branches.map((b) => html`<option value="${b.id}" ${b.id === h.pickup_branch.id ? "selected" : ""}>${b.name}</option>`)}</select></div>` });
      if (!fd) return;
      await api(`/holds/${h.id}`, { method: "PATCH", body: { pickup_branch_id: Number(fd.get("pickup_branch_id")) } });
      toast(t("people.patron.hold.pickup_changed"), "success");
    } else if (action === "cancel") {
      if (!(await confirmDialog(t("people.patron.hold.cancel_title"), t("people.patron.hold.cancel_text", { title: h.biblio.title }), t("people.patron.hold.cancel")))) return;
      await api(`/holds/${h.id}`, { method: "DELETE" });
      toast(t("people.patron.hold.cancelled"), "success");
    } else return;
    await reload();
  } catch (err) { if (!err.toasted) toast(err.message, "error"); }
}

// ---- history

async function history(panel) {
  panel.innerHTML = html`<div id="pp-history">${tablePlaceholder(4)}</div>`;
  let rows = [], sort = { key: "returned", dir: "desc" };
  const getters = { title: (l) => l.item.biblio.title, issued: (l) => l.issued_at, returned: (l) => l.returned_at, fine: (l) => l.fine_charged };
  let table = null;
  const make = () => (table = dataTable(freshTableHost($("#pp-history")), {
    id: "patron-history", caption: t("people.patron.history_caption", { name: p.full_name }), sort, exportName: `history-${p.card_number}`,
    onSort: (s) => { sort = s; table.setRows(sortRows(rows, s, getters)); },
    columns: [
      { key: "title", label: t("people.col.title"), sortable: true, primary: true, hideable: false, csv: (l) => l.item.biblio.title, render: (l) => titleCell(l.item.biblio) },
      { key: "barcode", label: t("people.col.barcode"), hidden: true, csv: (l) => l.item.barcode, render: (l) => html`<span class="mono small" dir="ltr">${l.item.barcode}</span>` },
      { key: "issued", label: t("people.col.borrowed"), sortable: true, csv: (l) => l.issued_at, render: (l) => html`<span class="num">${date(l.issued_at)}</span>` },
      { key: "returned", label: t("people.col.returned"), sortable: true, csv: (l) => l.returned_at, render: (l) => html`<span class="num">${date(l.returned_at)}</span>` },
      { key: "fine", label: t("people.col.fine"), align: "num", sortable: true, csv: (l) => l.fine_charged, render: (l) => (l.fine_charged ? money(l.fine_charged) : html`<span class="muted">—</span>`) },
    ],
    empty: p.keep_history ? { art: "books", title: t("people.patron.history_empty_title"), body: t("people.patron.history_empty_body") }
      : { art: "inbox", title: t("people.patron.history_off_title"), body: t("people.patron.history_off_body") },
  }));
  const load = async () => {
    table?.setLoading();
    try { rows = (await api(`/patrons/${p.id}/history`)).results; (table || make()).setRows(sortRows(rows, sort, getters)); } catch (e) { (table || make()).setError(e, load); }
  };
  await load();
}

// ---- account & payments

async function account(panel) {
  panel.innerHTML = html`<div class="pp-account">
    <section class="grid kpi-grid compact pp-tiles" aria-label="${t("people.patron.account_summary")}" id="pp-ledger-tiles">${Array.from({ length: 4 }, () => html`<div class="card kpi-tile pp-sk-tile" aria-hidden="true"><div class="skeleton sk-line short"></div><div class="skeleton sk-line"></div></div>`)}</section>
    <div class="pp-account-actions">
      ${allow("circulation") ? html`<button type="button" class="btn ${p.balance > 0 ? "primary" : ""}" data-money="pay">${icon("wallet")}${t("people.patron.action.take_payment")}</button>` : ""}
      ${allow("fines:waive") ? html`<button type="button" class="btn" data-money="waive">${t("people.patron.action.waive")}</button>` : ""}
      ${allow("fines:charge") ? html`<button type="button" class="btn" data-money="charge">${icon("plus")}${t("people.patron.action.add_charge")}</button>` : ""}
    </div>
    <div id="pp-ledger">${tablePlaceholder(3)}</div></div>`;
  let rows = [], table = null;
  const make = () => (table = dataTable(freshTableHost($("#pp-ledger")), {
    id: "patron-ledger", caption: t("people.patron.ledger_caption", { name: p.full_name }), exportName: `account-${p.card_number}`,
    columns: [
      { key: "date", label: t("people.col.date"), csv: (e) => e.created_at, render: (e) => html`<span class="num" title="${datetime(e.created_at)}">${date(e.created_at)}</span>` },
      { key: "kind", label: t("people.col.type"), primary: true, hideable: false, csv: (e) => ledgerKind(e.kind)[1], render: (e) => { const [tone, label] = ledgerKind(e.kind); return pill(tone, label); } },
      { key: "note", label: t("people.col.note"), csv: (e) => e.note || "", render: (e) => e.note || html`<span class="muted">—</span>` },
      { key: "amount", label: t("people.col.amount"), align: "num", csv: (e) => e.amount,
        render: (e) => html`<span class="pp-amount ${e.amount > 0 ? "is-charge" : "is-credit"}">${e.amount > 0 ? "+" : "−"}${money(Math.abs(e.amount))}</span>` },
      { key: "after", label: t("people.col.balance_after"), align: "num", csv: (e) => e.after, render: (e) => money(e.after) },
    ],
    empty: { art: "done", title: t("people.patron.ledger_empty_title"), body: t("people.patron.ledger_empty_body") },
  }));
  const load = async () => {
    table?.setLoading();
    try {
      const r = await api(`/patrons/${p.id}/ledger`);
      let run = 0;
      rows = [...r.entries].reverse().map((e) => { run = Math.round((run + e.amount) * 100) / 100; return { ...e, after: run }; }).reverse();
      const sum = (k) => r.entries.filter((e) => e.kind === k).reduce((a, e) => a + Math.abs(e.amount), 0);
      const charged = r.entries.filter((e) => e.amount > 0).reduce((a, e) => a + e.amount, 0);
      $("#pp-ledger-tiles").innerHTML = html`${statTile({ label: t("people.patron.tile.balance"), icon: "wallet", value: money(r.balance), tone: r.balance > 0 ? "danger" : "",
          foot: html`<span>${r.balance > 0 ? t("people.patron.tile.owes") : t("people.patron.tile.settled")}</span>` })}
        ${statTile({ label: t("people.patron.tile.charged"), value: money(charged), icon: "plus" })}
        ${statTile({ label: t("people.patron.tile.paid"), value: money(sum("payment")), icon: "check" })}
        ${statTile({ label: t("people.patron.tile.waived"), value: money(sum("waiver")), icon: "heart" })}`;
      (table || make()).setRows(rows);
    } catch (e) { (table || make()).setError(e, load); $("#pp-ledger-tiles").innerHTML = ""; }
  };
  await load();
}

async function moneyAction(kind) {
  const titles = { pay: t("people.patron.money.pay_title"), waive: t("people.patron.money.waive_title"), charge: t("people.patron.money.charge_title") };
  const submit = { pay: t("people.patron.money.pay_submit"), waive: t("people.patron.money.waive_submit"), charge: t("people.patron.money.charge_submit") };
  const noteRequired = kind !== "pay";
  const fd = await modal({ title: titles[kind], submit: submit[kind], size: "sm", body: html`<div class="stack">
    ${p.balance > 0 && kind !== "charge" ? html`<p class="small muted">${t("people.patron.money.current_balance", { amount: money(p.balance) })}</p>` : ""}
    <div class="field"><label for="m-amt">${t("people.patron.money.amount")}</label><input id="m-amt" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required value="${kind !== "charge" && p.balance > 0 ? p.balance : ""}"></div>
    <div class="field"><label for="m-note">${t("people.patron.money.note")}${noteRequired ? "" : html` <span class="optional">${t("ui.form.optional")}</span>`}</label>
      <input id="m-note" name="note" maxlength="255" ${noteRequired ? "required" : ""} placeholder="${kind === "pay" ? t("people.patron.money.note_pay_hint") : t("people.patron.money.note_hint")}"></div></div>` });
  if (!fd) return;
  try {
    const r = await api(`/patrons/${p.id}/${kind}`, { method: "POST", body: { amount: Math.round(Number(fd.get("amount")) * 100), note: String(fd.get("note") || "").trim() || null } });
    toast(t("people.patron.money.done", { amount: money(r.balance) }), "success");
    current = "account";
    await reload();
  } catch (err) { toast(err.message, "error"); }
}

// ---- messages (notices sent to this patron)

async function messages(panel) {
  if (!allow("notices:outbox")) {
    panel.innerHTML = emptyState({ art: "inbox", title: t("people.patron.messages_denied_title"), body: t("people.patron.messages_denied_body") });
    return;
  }
  panel.innerHTML = html`<div class="pp-messages"><div id="pp-prefs" class="pp-prefs card"><div class="pp-prefs-sk" aria-hidden="true"><div class="skeleton sk-line short"></div><div class="skeleton sk-line"></div></div></div><div id="pp-notices">${tablePlaceholder(3)}</div></div>`;
  let rows = [], page = 1, table = null;
  const make = () => (table = dataTable(freshTableHost($("#pp-notices")), {
    id: "patron-notices", caption: t("people.patron.messages_caption", { name: p.full_name }), rowLabel: (n) => n.subject,
    onPage: ({ page: pg }) => { page = pg; load(); }, perPageOptions: [50], perPage: 50,
    columns: [
      { key: "created", label: t("people.col.created"), csv: (n) => n.created_at, render: (n) => html`<span class="num" title="${datetime(n.created_at)}">${relative(n.created_at)}</span>` },
      { key: "notice", label: t("people.col.message"), primary: true, hideable: false, csv: (n) => n.subject,
        render: (n) => html`<div class="dt-cell-stack"><button type="button" class="link-btn pp-open" data-open="${n.id}">${n.subject || noticeName(n.code)}</button><span class="sub">${noticeName(n.code)}</span></div>` },
      { key: "channel", label: t("people.col.channel"), csv: (n) => channelLabel(n.channel), render: (n) => html`<span class="pp-channel">${icon(channelIcon(n.channel))}${channelLabel(n.channel)}</span>` },
      { key: "to", label: t("people.col.to"), hidden: true, csv: (n) => n.to || "", render: (n) => (n.to ? html`<span dir="ltr">${n.to}</span>` : html`<span class="muted">${t("people.notices.no_address")}</span>`) },
      { key: "status", label: t("people.col.status"), csv: (n) => n.status, render: (n) => noticeStatus(n.status) },
      { key: "attempts", label: t("people.col.attempts"), align: "num", csv: (n) => n.attempts, render: (n) => num(n.attempts) },
    ],
    empty: { art: "inbox", title: t("people.patron.messages_empty_title"), body: t("people.patron.messages_empty_body") },
  }));
  onRowOpen($("#pp-notices"), (k) => rows.find((n) => String(n.id) === k), (n) => openNotice(n, load));
  $("#pp-notices").addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) openNotice(rows.find((n) => n.id === Number(b.dataset.open)), load); });
  async function load() {
    table?.setLoading();
    try {
      const r = await api(`/patrons/${p.id}/notices?page=${page}`);
      rows = r.results;
      (table || make()).setRows(rows, { total: r.total, page, perPage: 50 });
    } catch (e) { (table || make()).setError(e, load); }
  }
  loadPrefs();
  await load();
}

async function loadPrefs() {
  const box = $("#pp-prefs");
  if (!box) return;
  try {
    const r = await api(`/patrons/${p.id}/messaging`);
    box.innerHTML = html`<div class="pp-prefs-head"><div><h2 class="pp-prefs-title">${t("people.patron.prefs_title")}</h2>
        <p class="small muted">${t("people.patron.prefs_sub")}</p></div>
        ${allow("patrons:write") ? html`<button type="button" class="btn sm" data-menu-prefs>${icon("edit")}${t("people.patron.prefs_edit")}</button>` : ""}</div>
      <ul class="pp-prefs-list">${r.results.map((x) => html`<li><span>${noticeName(x.code, x.name)}</span><span class="pp-channel ${x.channel === "none" ? "muted" : ""}">${icon(x.channel === "none" ? "volume-off" : channelIcon(x.channel))}${channelLabel(x.channel)}</span></li>`)}</ul>`;
  } catch (e) { box.innerHTML = errorState(e, { retry: false }); }
}

async function editPrefs() {
  try {
    const r = await api(`/patrons/${p.id}/messaging`);
    const fd = await modal({ title: t("people.patron.prefs_title"), submit: t("common.save"), size: "md", body: html`<p class="small muted">${t("people.patron.prefs_sub")}</p>
      <div class="pp-prefs-form">${r.results.map((x) => html`<div class="field"><label for="pref-${x.code}">${noticeName(x.code, x.name)}</label>
        <select id="pref-${x.code}" name="${x.code}">${["email", "sms", "none"].map((c) => html`<option value="${c}" ${c === x.channel ? "selected" : ""}>${channelLabel(c)}</option>`)}</select>
        <span class="field-help">${noticeDescription(x.code, x.description)}</span></div>`)}</div>` });
    if (!fd) return;
    await api(`/patrons/${p.id}/messaging`, { method: "PUT", body: { preferences: Object.fromEntries([...fd].map(([k, v]) => [k, String(v)])) } });
    toast(t("people.patron.prefs_saved"), "success");
    loadPrefs();
  } catch (err) { if (!err.toasted) toast(err.message, "error"); }
}

// ---- activity

async function activity(panel) {
  panel.innerHTML = html`<section class="card pp-card" aria-labelledby="pp-act-h"><div class="card-head"><h2 id="pp-act-h">${t("people.patron.tab.activity")}</h2><span class="small muted" id="pp-act-count" aria-live="polite"></span></div>
    <div class="card-body"><p class="small muted pp-act-sub">${t("people.patron.activity_sub")}</p><div id="pp-act">${skeletonTimeline(6)}</div><div id="pp-act-more" class="pp-more"></div></div></section>`;
  let page = 1, shown = [];
  const load = async () => {
    try {
      const r = await api(`/patrons/${p.id}/activity?page=${page}&per_page=50`);
      shown = [...shown, ...r.results];
      $("#pp-act-count").textContent = t("people.patron.activity_count", { count: r.total });
      $("#pp-act").innerHTML = shown.length ? timeline(shown)
        : emptyState({ art: "inbox", title: t("people.patron.activity_empty_title"), body: t("people.patron.activity_empty_body") });
      $("#pp-act-more").innerHTML = shown.length < r.total ? html`<button type="button" class="btn" data-more>${t("people.patron.load_more")}</button>` : "";
    } catch (e) {
      $("#pp-act").innerHTML = errorState(e);
    }
  };
  on(panel, "click", async (e) => {
    if (e.target.closest("[data-retry]")) { shown = []; $("#pp-act").innerHTML = skeletonTimeline(6); load(); }
    const more = e.target.closest("[data-more]");
    if (more) { page++; await withBusy(more, load).catch(() => {}); }
  });
  await load();
}

// ---- AI picks

async function recs(panel) {
  panel.innerHTML = html`<div class="pp-recs-grid" aria-hidden="true">${Array.from({ length: 6 }, () => html`<div class="card pp-rec pp-sk-rec"><div class="skeleton sk-cover"></div><div class="pp-rec-text"><div class="skeleton sk-line"></div><div class="skeleton sk-line short"></div></div></div>`)}</div>`;
  const load = async () => {
    try {
      const r = await api(`/patrons/${p.id}/recommendations`);
      panel.innerHTML = html`<p class="pp-recs-why">${icon("sparkle")}${r.reason === "personalised" ? t("people.patron.recs_personal") : t("people.patron.recs_trending")}</p>
        ${r.results.length ? html`<ul class="pp-recs-grid">${r.results.map((b) => html`<li class="card pp-rec">
          <a href="/staff/catalog/${b.id}" tabindex="-1" aria-hidden="true">${cover(b, "sm")}</a>
          <div class="pp-rec-text"><a class="pp-rec-title" href="/staff/catalog/${b.id}">${b.title}</a><span class="small muted">${authors(b.authors)}</span>
            <div class="pp-rec-foot">${b.availability?.available ? statusPill("item", "available", t("people.patron.on_shelf")) : statusPill("item", "on_loan", t("people.patron.all_out"))}
              ${allow("holds:manage") ? html`<button type="button" class="btn sm" data-hold-for="${b.id}" aria-label="${t("people.patron.hold_for", { title: b.title })}">${icon("bookmark-plus")}${t("people.patron.hold_short")}</button>` : ""}</div></div></li>`)}</ul>`
        : emptyState({ art: "books", title: t("people.patron.recs_empty_title"), body: t("people.patron.recs_empty_body") })}`;
    } catch (e) { panel.innerHTML = errorState(e); }
  };
  await load();
}

// ------------------------------------------------------------------ dialogs

async function placeHold(biblio = null) {
  const body = html`<div class="stack">
    <div class="field"><label for="ph-title">${t("people.patron.hold_dialog.title_label")}</label>
      <input id="ph-title" type="search" autocomplete="off" required placeholder="${t("people.patron.hold_dialog.title_placeholder")}" value="${biblio?.title || ""}" ${biblio ? "readonly" : ""}>
      <input type="hidden" name="biblio_id" value="${biblio?.id || ""}"><span class="field-help">${t("people.patron.hold_dialog.title_help")}</span></div>
    <div class="form-grid pp-two">
      <div class="field"><label for="ph-br">${t("people.col.pickup")}</label><select id="ph-br" name="pickup_branch_id">${lk.branches.map((b) => html`<option value="${b.id}" ${b.id === p.home_branch.id ? "selected" : ""}>${b.name}</option>`)}</select></div>
      <div class="field"><label for="ph-until">${t("people.col.not_needed_after")} <span class="optional">${t("ui.form.optional")}</span></label><input id="ph-until" name="not_needed_after" type="date"></div></div>
    <div class="field"><label for="ph-notes">${t("people.patron.hold_dialog.notes")} <span class="optional">${t("ui.form.optional")}</span></label><input id="ph-notes" name="notes" maxlength="255"></div></div>`;
  const pending = modal({ title: t("people.patron.hold_dialog.heading", { name: p.full_name }), submit: t("people.patron.action.place_hold"), size: "md", body });
  const dlg = $$("dialog").at(-1);
  const input = $("#ph-title", dlg), hidden = $('[name="biblio_id"]', dlg);
  if (!biblio) {
    combobox(input, {
      minChars: 2,
      source: async (q) => (await api(`/search?q=${encodeURIComponent(q)}&per_page=8`)).results,
      render: (b) => html`${b.title}<span class="sub">${[authors(b.authors), b.pub_year].filter(Boolean).join(" · ")}</span>`,
      value: (b) => b.title,
      onSelect: (b) => { hidden.value = b.id; input.setCustomValidity(""); },
    });
    input.addEventListener("input", () => { hidden.value = ""; input.setCustomValidity(t("people.patron.hold_dialog.pick_title")); });
  }
  const fd = await pending;
  if (!fd) return;
  const bid = Number(fd.get("biblio_id"));
  if (!bid) { toast(t("people.patron.hold_dialog.pick_title"), "error"); return; }
  const payload = { biblio_id: bid, patron_card: p.card_number, pickup_branch_id: Number(fd.get("pickup_branch_id")),
    notes: String(fd.get("notes") || "").trim() || null, not_needed_after: fd.get("not_needed_after") || null };
  try {
    try { await api("/holds", { method: "POST", body: payload }); }
    catch (err) {
      if (err.status !== 422 || !allow("circulation:override")) throw err;
      if (!(await confirmDialog(t("people.patron.hold_dialog.blocked_title"), t("people.patron.hold_dialog.blocked_text", { reason: err.message }), t("people.patron.hold_dialog.override"), false))) return;
      await api("/holds", { method: "POST", body: { ...payload, override: true } });
    }
    toast(t("people.patron.hold_placed"), "success");
    current = "holds";
    await reload();
  } catch (err) { toast(err.message, "error"); }
}

async function editPatron() {
  const fd = await modal({ title: t("people.patron.edit_title", { name: p.full_name }), body: patronForm(lk, p), submit: t("common.save"), size: "lg" });
  if (!fd) return;
  try {
    await api(`/patrons/${p.id}`, { method: "PATCH", body: patronPayload(fd, false) });
    toast(t("people.patron.updated"), "success");
    await reload();
  } catch (err) { toast(err.message, "error"); }
}

async function renewMembership() {
  const before = p.expires_on;
  try {
    const r = await api("/patrons/renew", { method: "POST", body: { ids: [p.id] } });
    if (!r.renewed.length) { toast(t("people.patron.renew_skipped"), "warn"); return; }
    toast(t("people.patron.membership_renewed", { date: date(r.renewed[0].expires_on) }), "success", { action: { label: t("ui.undo"), run: async () => {
      await api(`/patrons/${p.id}`, { method: "PATCH", body: { expires_on: before || null } });
      toast(t("ui.patrons.renew_undone"), "info");
      await reload();
    } } });
    await reload();
  } catch (err) { toast(err.message, "error"); }
}

async function erase() {
  if (p.loans.length || p.balance > 0) {
    toast([p.loans.length ? t("people.patron.erase_blocker_loans", { count: p.loans.length }) : "", p.balance > 0 ? t("people.patron.erase_blocker_balance", { amount: money(p.balance) }) : ""].filter(Boolean).join(" "), "error");
    return;
  }
  const ok = await confirmDestructive({ title: t("people.patron.erase_title", { name: p.full_name }), text: t("people.patron.erase_confirm_text"),
    word: p.card_number, submit: t("people.patron.action.erase") });
  if (!ok) return;
  try {
    await api(`/patrons/${p.id}`, { method: "DELETE" });
    toast(t("people.patron.erased"), "success");
    location.href = "/staff/patrons";
  } catch (err) { toast(err.message, "error"); }
}

// ------------------------------------------------------------------ wiring

const PANELS = { overview, loans, holds, history, account, messages, activity, recs };

async function show(tab) {
  current = tab;
  panelScope.abort();
  panelScope = new AbortController();
  const panel = panelEl();
  try { await PANELS[tab](panel); } catch (e) {
    panel.innerHTML = errorState(e);
    on(panel, "click", (ev) => { if (ev.target.closest("[data-retry]")) show(tab); });
  }
}

async function reload() {
  fetchRecent();
  try { p = await api(`/patrons/${pid()}`); } catch (e) { toast(e.message, "error"); return; }
  renderHeader();
  const y = window.scrollY;
  tabsCtl.select(current); // keeps the selected tab and #hash in sync when an action switched tabs
  await lastShow;
  window.scrollTo({ top: y });
}

export default async function init() {
  wireKit();
  let loadError = null;
  fetchRecent();
  [p, lk, P] = await Promise.all([
    api(`/patrons/${pid()}`).catch((e) => { loadError = e; return null; }),
    api("/lookups").catch(() => ({ branches: [], categories: [] })),
    perms(),
  ]);
  if (!p) {
    $("#pp-head").outerHTML = html`<div class="card pp-head pp-head-error">${loadError?.status === 404
      ? emptyState({ art: "people", title: t("people.patron.not_found_title"), body: t("people.patron.not_found_body"),
        actions: html`<a class="btn primary" href="/staff/patrons">${t("people.patron.back_to_patrons")}</a>` })
      : errorState(loadError, { retry: true })}</div>`;
    $(".pp-tabs")?.remove();
    panelEl().remove();
    $(".pp-page").addEventListener("click", (e) => { if (e.target.closest("[data-retry]")) location.reload(); });
    return;
  }
  setCrumb(p.full_name);
  document.title = `${p.full_name} · ${document.title.split(" · ").slice(1).join(" · ")}`;
  renderHeader();
  tabsCtl = wireTabsPanel($(".pp-page"), (tab) => { lastShow = show(tab); }, { hash: true });

  $(".pp-page").addEventListener("click", (e) => {
    const b = e.target.closest("button, a");
    if (!b) return;
    const act = b.dataset.act;
    if (b.dataset.goto) { tabsCtl.select(b.dataset.goto); $(`#pp-tab-${b.dataset.goto}`)?.focus(); }
    else if (act === "edit") editPatron();
    else if (act === "hold") placeHold();
    else if (act === "renew-membership") renewMembership();
    else if (act === "erase") erase();
    else if (act === "pay") moneyAction("pay");
    else if (b.dataset.money) moneyAction(b.dataset.money);
    else if (b.dataset.renew) {
      withBusy(b, () => renewLoan(Number(b.dataset.renew))).then((r) => { if (r) { toast(t("people.patron.renewed", { count: 1 }), "success"); reload(); } }).catch(() => {});
    } else if (b.dataset.holdFor) {
      placeHold({ id: Number(b.dataset.holdFor), title: b.closest(".pp-rec")?.querySelector(".pp-rec-title")?.textContent || "" });
    } else if (b.hasAttribute("data-menu-prefs")) editPrefs();
  });
  // Header "More" menu.
  $("#pp-head").addEventListener("rowmenu", (e) => {
    const a = e.detail.action;
    if (a === "prefs") editPrefs();
    else if (a === "pay") moneyAction("pay");
    else if (a === "activity") { tabsCtl.select("activity"); $("#pp-tab-activity")?.focus(); }
  });
}
