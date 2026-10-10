// Staff › Circulation desk.
//
// Built for a busy desk with a barcode scanner:
// * The scan field is NEVER disabled. Every scan is queued and processed one request at a time, with its own
//   status row (pending → done / warning / blocked / error) — fast scanners cannot lose characters or items.
// * Every outcome is announced three ways: a status row, a sound (WebAudio, mute switch) and, for problems,
//   a prominent banner that never steals focus (Esc dismisses it). Blocked checkouts don't interrupt the
//   queue: the row offers Override / Retry / Check in & lend.
// * A check-in that fills a hold opens a blocking dialog (hold shelf or transit) with a printable slip;
//   scans that arrive while it is open are queued, not lost.
// * Checkouts and check-ins can be undone for 30 seconds (server-checked and audited).
// * F2 check out · F3 check in · F4 renew · F6 receive transfer; Ctrl+Z undoes the last transaction.
import { $, $$, BOOT, api, date, datetime, html, icon, modal, money, num, parseDate, raw, trapFocus } from "/static/js/core.js";
import { formatList, t } from "/static/js/i18n.js";
import { avatar } from "/static/js/ui/avatar.js";
import { statusPill } from "/static/js/ui/status.js";
import { flash, setSound, soundOn, tone } from "/static/js/pages/lib/desk-feedback.js";
import { holdSlip, printSlip, receiptDoc, transitSlip } from "/static/js/pages/lib/desk-print.js";
import { reasonText } from "/static/js/pages/lib/desk-ui.js";

const MODES = ["checkout", "checkin", "renew", "transfer"];
const FKEYS = { F2: "checkout", F3: "checkin", F4: "renew", F6: "transfer" };
const UNDO_MS = 30_000;
const DAY = 86_400_000;
const UNDO_ICON = raw(`<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`);

const root = () => $("#circ");
const S = {
  mode: "checkout",
  patron: null, // patron context (GET /circulation/patrons/{id}/context)
  visit: 0, // increments whenever a patron is loaded; the receipt prints the current visit only
  override: null, // { reason } — "override for this visit"
  rows: [], // transaction log (newest first)
  queue: [], // jobs waiting for their request
  busy: false,
  paused: 0, // > 0 while a blocking dialog is open
  seq: 0,
  branches: [],
  lastItem: null, // last check-in / receive (side panel in those modes)
  totals: { returned: 0, hold: 0, transit: 0, fines: 0 },
  refreshTimer: 0,
};
const canOverride = () => root().dataset.canOverride === "true";
const branchId = () => Number($("#desk-branch").value) || BOOT.user.home_branch_id;
const branchName = (id = branchId()) => S.branches.find((b) => b.id === id)?.name || "";
const library = () => root().dataset.library || "";
const fmtDue = (v) => date(v, { weekday: "short", day: "numeric", month: "short" });

// ------------------------------------------------------------------ humanised reasons & messages

const reasonsOf = (err) => (err.data?.reason_codes?.length ? err.data.reason_codes : (err.data?.reasons || [err.message]).map((m) => ({ code: "", message: m })));

function errorText(err) {
  const code = err.data?.code;
  if (!err.status) return t("desk.err.network");
  if (code === "not_found" || err.status === 404) return t("desk.err.not_found");
  const known = ["on_loan", "already_on_loan", "withdrawn", "not_on_loan", "undo_expired", "undo_stale", "undo_done", "undo_not_yours", "no_email"];
  if (known.includes(code)) return t(`desk.err.${code}`);
  if (code === "conflict" && /not in transit/i.test(err.message)) return t("desk.err.not_in_transit");
  if (err.status === 403) return t("desk.err.forbidden");
  return err.message || t("desk.err.generic");
}

// ------------------------------------------------------------------ feedback

function announce(msg) {
  const el = $("#circ-announce");
  el.textContent = "";
  setTimeout(() => { el.textContent = msg; }, 30);
}

function feedback(kind) {
  tone(kind);
  flash($("#item-form"), kind === "ok" || kind === "info" ? "ok" : kind);
}

/** The prominent problem banner. Never takes focus; Esc in a scan field or ✕ dismisses it. */
function banner(row) {
  const el = $("#circ-banner");
  if (!row) { el.hidden = true; el.innerHTML = ""; el.dataset.row = ""; return; }
  el.dataset.row = row.id;
  el.className = `circ-banner tone-${row.status === "warn" ? "warn" : "error"}`;
  el.innerHTML = html`<span class="cb-icon">${icon("alert")}</span>
    <div class="grow"><strong>${row.title || row.barcode}</strong><div>${row.problem || ""}</div></div>
    <div class="cb-actions">${rowActions(row, true)}
      <button type="button" class="btn ghost icon-only" data-dismiss-banner aria-label="${t("desk.circ.dismiss")}" data-tip="${t("desk.circ.dismiss_tip")}">${icon("x")}</button></div>`;
  el.hidden = false;
}

// ------------------------------------------------------------------ the transaction log

const STATUS_ICON = { pending: "clock", ok: "check", warn: "alert", hold: "bookmark", blocked: "x-circle", error: "alert", undone: "refresh", info: "info" };
const MODE_ICON = { checkout: "arrow-up", checkin: "arrow-down", renew: "refresh", transfer: "truck" };

function rowActions(r, inBanner = false) {
  const a = [];
  const b = (act, label, cls = "", ic = "") => html`<button type="button" class="btn sm ${cls}" data-act="${act}" data-row="${r.id}">${ic ? (ic === "undo" ? UNDO_ICON : icon(ic)) : ""}${label}</button>`;
  if (r.status === "blocked" && canOverride()) a.push(b("override", t("desk.act.override"), "primary"));
  if (r.code === "on_loan") a.push(b("checkin-lend", t("desk.act.checkin_lend"), "primary"));
  if (r.code === "already_on_loan") a.push(b("renew-instead", t("desk.act.renew_instead"), "primary"));
  if (["error", "blocked"].includes(r.status) && r.retryable !== false) a.push(b("retry", t("desk.act.retry")));
  if (inBanner) return html`${a}`;
  if (r.slip) a.push(b("slip", t("desk.act.print_slip"), "", "printer"));
  if (r.undoToken && r.status !== "undone" && Date.now() < r.undoUntil) {
    a.push(html`<button type="button" class="btn sm ghost circ-undo" data-act="undo" data-row="${r.id}">${UNDO_ICON}${t("desk.act.undo")}
      <span class="undo-left" aria-hidden="true">${Math.ceil((r.undoUntil - Date.now()) / 1000)}</span></button>`);
  }
  return html`${a}`;
}

function rowHtml(r) {
  const time = r.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return html`<li class="circ-row is-${r.status}" data-row="${r.id}">
    <span class="cr-icon" aria-hidden="true">${r.status === "pending" ? raw('<span class="spinner"></span>') : icon(STATUS_ICON[r.status] || "info")}</span>
    <div class="cr-main">
      <div class="cr-title"><span class="cr-mode">${icon(MODE_ICON[r.mode])}<span class="sr-only">${t(`desk.mode.${r.mode}`)}: </span></span>
        <strong>${r.title || (r.status === "pending" ? t("desk.circ.looking_up") : t("desk.circ.unknown_item"))}</strong></div>
      <div class="cr-meta"><span class="mono">${r.barcode}</span>${r.detail ? html`<span>${r.detail}</span>` : ""}
        <span class="sr-only">${t(`desk.row.${r.status}`)}</span></div>
      ${r.problem ? html`<div class="cr-problem">${r.problem}</div>` : ""}
      ${r.notes?.length ? html`<ul class="cr-notes">${r.notes.map((n) => html`<li>${n}</li>`)}</ul>` : ""}
    </div>
    <div class="cr-side"><time class="cr-time" datetime="${r.at.toISOString()}">${time}</time>
      <div class="cr-actions">${rowActions(r)}</div></div></li>`;
}

function paintRow(r) {
  const list = $("#circ-log");
  const existing = $(`[data-row="${r.id}"]`, list);
  const markup = rowHtml(r);
  if (existing) {
    // Keep keyboard focus on the same action across re-renders.
    const focusedAct = document.activeElement?.closest?.(`[data-row="${r.id}"]`) ? document.activeElement.dataset.act : null;
    existing.outerHTML = markup;
    if (focusedAct) $(`[data-row="${r.id}"] [data-act="${focusedAct}"]`, list)?.focus();
  } else {
    list.insertAdjacentHTML("afterbegin", markup);
  }
  $("#circ-log-empty").hidden = S.rows.length > 0;
  $("#log-count").textContent = S.rows.length ? num(S.rows.filter((x) => x.kind !== "visit").length) : "";
  if ($("#circ-banner").dataset.row === String(r.id)) {
    if (["error", "blocked"].includes(r.status)) banner(r); else banner(null);
  }
}

function addRow(fields) {
  const r = { id: ++S.seq, at: new Date(), status: "pending", visit: S.visit, notes: [], ...fields };
  S.rows.unshift(r);
  paintRow(r);
  return r;
}

function update(r, fields) {
  Object.assign(r, fields);
  paintRow(r);
}

function visitDivider(p) {
  const list = $("#circ-log");
  list.insertAdjacentHTML("afterbegin", html`<li class="circ-visit"><span>${icon("user")}${t("desk.circ.visit", { name: p.full_name })}</span>
    <time>${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></li>`);
}

// Undo countdowns: one timer for every row that can still be undone.
setInterval(() => {
  const now = Date.now();
  for (const r of S.rows) {
    if (!r.undoToken || r.status === "undone") continue;
    if (now >= r.undoUntil) { r.undoToken = null; paintRow(r); continue; }
    const el = $(`[data-row="${r.id}"] .undo-left`);
    if (el) el.textContent = Math.ceil((r.undoUntil - now) / 1000);
  }
}, 1000);

/** A banner that is not tied to a log row (patron not found, payment failed, …). */
function notice(title, problem, status = "error") {
  banner({ id: 0, status, title, problem, barcode: "", retryable: false });
  tone(status === "warn" ? "warn" : "error");
}

// ------------------------------------------------------------------ the scan queue

function queueStatus() {
  const waiting = S.queue.length + (S.busy ? 1 : 0);
  $("#circ-queue").textContent = waiting > 1 || S.paused ? t("desk.circ.queue", { count: waiting }) : "";
  root().classList.toggle("is-busy", S.busy);
}

function enqueue(barcode, opts = {}) {
  barcode = barcode.trim();
  if (!barcode) return;
  const mode = opts.mode || S.mode;
  const row = opts.row || addRow({ mode, barcode });
  if (opts.row) update(row, { status: "pending", problem: "", notes: [], at: new Date() });
  S.queue.push({ row, mode, barcode, patron: opts.patron || S.patron, override: opts.override, overrideReason: opts.overrideReason });
  queueStatus();
  pump();
}

async function pump() {
  if (S.busy) return;
  while (S.queue.length && !S.paused) {
    S.busy = true;
    queueStatus();
    const job = S.queue.shift();
    try {
      await RUN[job.mode](job);
    } catch (e) {
      console.error(e);
      fail(job.row, e);
    }
  }
  S.busy = false;
  queueStatus();
  if (!S.queue.length) schedulePatronRefresh();
}

function fail(row, err, status = "error") {
  update(row, { status, problem: errorText(err), code: err.data?.code });
  feedback("error");
  banner(row);
  announce(`${row.title || row.barcode}: ${row.problem}`);
}

// ------------------------------------------------------------------ transactions

const RUN = {
  async checkout(job) {
    const { row } = job;
    const p = job.patron;
    if (!p) {
      update(row, { status: "error", problem: t("desk.err.no_patron"), retryable: false });
      feedback("error");
      banner(row);
      return;
    }
    const override = job.override || (!!S.override && S.override.visit === row.visit && canOverride());
    try {
      const r = await api("/circulation/checkout", { method: "POST", body: {
        patron_card: p.card_number, barcode: job.barcode, branch_id: branchId(), override,
        override_reason: override ? (job.overrideReason || S.override?.reason || null) : null } });
      const warnings = (r.warning_codes || []).map(reasonText);
      update(row, { status: warnings.length ? "warn" : "ok", title: r.loan.item.biblio.title, kind: "checkout",
        detail: t("desk.circ.due", { date: fmtDue(r.loan.due_at) }), notes: warnings, loan: r.loan, patronId: p.id,
        undoToken: r.undo_token, undoUntil: Date.now() + UNDO_MS, problem: "" });
      feedback(warnings.length ? "warn" : "ok");
      announce(t("desk.say.checked_out", { title: r.loan.item.biblio.title, date: fmtDue(r.loan.due_at) }));
    } catch (e) {
      const code = e.data?.code;
      if (code === "checkout_blocked") {
        update(row, { status: "blocked", problem: formatList(reasonsOf(e).map(reasonText)), code, retryable: true });
        feedback("error");
        banner(row);
        announce(`${row.barcode}: ${row.problem}`);
        return;
      }
      fail(row, e);
    }
  },

  async checkin(job) {
    const { row } = job;
    try {
      const r = await api("/circulation/checkin", { method: "POST", body: { barcode: job.barcode, branch_id: branchId() } });
      const notes = [];
      if (Number(r.fine) > 0) notes.push(t("desk.circ.fine_charged", { amount: money(r.fine) }));
      if (r.lost_found) notes.push(t("desk.circ.lost_found"));
      const route = routingText(r);
      const isHold = r.hold && ["hold_shelf", "transit"].includes(r.routing);
      const status = isHold ? "hold" : (notes.length || ["home_branch", "already_on_hold_shelf"].includes(r.routing)) ? "warn" : "ok";
      update(row, { status, title: r.item.biblio.title, kind: "checkin", detail: route, hadLoan: !!r.loan, fine: Number(r.fine) || 0,
        notes, problem: "", undoToken: r.undo_token, undoUntil: Date.now() + UNDO_MS, item: r.item, hold: r.hold,
        routing: r.routing, toBranch: r.to_branch, patronId: r.loan?.patron?.id ?? null,
        slip: isHold || r.routing === "home_branch" ? slipFor(r) : null });
      S.totals.returned += r.loan ? 1 : 0;
      if (r.routing === "hold_shelf") S.totals.hold += 1;
      if (r.routing === "transit") S.totals.transit += 1;
      S.totals.fines += Number(r.fine) || 0;
      S.lastItem = { ...r, route };
      if (S.mode === "checkin" || S.mode === "transfer") renderSide();
      announce(`${t("desk.say.checked_in", { title: r.item.biblio.title })} ${route}`);
      if (isHold) { feedback("hold"); await holdDialog(r, row); }
      else feedback(status === "warn" ? "warn" : "ok");
      if (S.patron && r.loan?.patron?.id === S.patron.id) schedulePatronRefresh();
    } catch (e) { fail(row, e); }
  },

  async renew(job) {
    const { row } = job;
    try {
      const l = await api("/circulation/renew", { method: "POST", body: { barcode: job.barcode, override: !!job.override,
        override_reason: job.override ? job.overrideReason || S.override?.reason || null : null } });
      update(row, { status: "ok", title: l.item.biblio.title, kind: "renew", loan: l, patronId: l.patron?.id ?? null,
        detail: t("desk.circ.renewed_due", { date: fmtDue(l.due_at), count: l.renewals }), problem: "" });
      feedback("ok");
      announce(t("desk.say.renewed", { title: l.item.biblio.title, date: fmtDue(l.due_at) }));
      if (S.patron && l.patron?.id === S.patron.id) schedulePatronRefresh();
    } catch (e) {
      if (e.data?.code === "renewal_blocked") {
        update(row, { status: "blocked", problem: formatList(reasonsOf(e).map(reasonText)), code: "renewal_blocked" });
        feedback("error");
        banner(row);
        announce(`${row.barcode}: ${row.problem}`);
        return;
      }
      fail(row, e);
    }
  },

  async transfer(job) {
    const { row } = job;
    try {
      const r = await api("/circulation/transfer/receive", { method: "POST", body: { barcode: job.barcode, branch_id: branchId() } });
      const route = routingText(r);
      const isHold = r.hold && ["hold_shelf", "transit"].includes(r.routing);
      update(row, { status: isHold ? "hold" : r.routing === "home_branch" ? "warn" : "ok", title: r.item.biblio.title, kind: "transfer",
        detail: route, item: r.item, hold: r.hold, routing: r.routing, toBranch: r.to_branch, problem: "",
        slip: isHold || r.routing === "home_branch" ? slipFor(r) : null });
      S.lastItem = { ...r, route };
      renderSide();
      announce(`${t("desk.say.received", { title: r.item.biblio.title })} ${route}`);
      if (isHold) { feedback("hold"); await holdDialog(r, row); } else feedback(r.routing === "home_branch" ? "warn" : "ok");
    } catch (e) { fail(row, e); }
  },
};

function routingText(r) {
  const to = r.to_branch?.name || "";
  switch (r.routing) {
    case "hold_shelf": return t("desk.route.hold_shelf", { name: r.hold?.patron?.full_name || "" });
    case "transit": return t("desk.route.transit", { branch: to });
    case "home_branch": return t("desk.route.home_branch", { branch: to });
    case "already_on_hold_shelf": return t("desk.route.already_on_hold_shelf");
    case "reshelve": return r.item?.call_number ? t("desk.route.reshelve_at", { call: r.item.call_number }) : t("desk.route.reshelve");
    default: return "";
  }
}

function slipFor(r) {
  const title = r.item.biblio.title;
  if (r.routing === "hold_shelf" && r.hold) return () => holdSlip({ hold: r.hold, item: r.item, title, library: library(), branch: branchName() });
  return () => transitSlip({ to: r.to_branch?.name || r.hold?.pickup_branch?.name || "", from: branchName(), item: r.item, title,
    hold: r.routing === "transit" ? r.hold : null, library: library() });
}

// ------------------------------------------------------------------ hold found (blocking dialog)

/** "Hold found" dialog. Blocking: the queue pauses while it is open. Scanner input that lands here (digits
 *  followed by Enter) is captured and queued instead of activating a button. Esc = Done. */
function holdDialog(r, row) {
  return new Promise((resolve) => {
    S.paused += 1;
    queueStatus();
    const shelf = r.routing === "hold_shelf";
    const h = r.hold;
    const d = document.createElement("dialog");
    d.className = `circ-hold-dialog ${shelf ? "is-shelf" : "is-transit"}`;
    d.setAttribute("aria-labelledby", "hd-title");
    d.setAttribute("aria-describedby", "hd-dest");
    const until = h.expires_at ? date(h.expires_at, { weekday: "long", day: "numeric", month: "long" }) : "";
    d.innerHTML = html`<div class="hd-band">${icon(shelf ? "bookmark" : "truck")}<span>${t("desk.hold.found")}</span></div>
      <div class="dialog-body">
        <h2 id="hd-title">${shelf ? t("desk.hold.title_shelf") : t("desk.hold.title_transit", { branch: r.to_branch?.name || h.pickup_branch.name })}</h2>
        <div class="hd-dest" id="hd-dest">${shelf ? t("desk.hold.dest_shelf", { branch: h.pickup_branch.name }) : t("desk.hold.dest_transit", { branch: r.to_branch?.name || h.pickup_branch.name })}</div>
        <dl class="hd-facts">
          <div><dt>${t("desk.hold.for")}</dt><dd><strong>${h.patron.full_name}</strong> <span class="mono muted">${h.patron.card_number}</span></dd></div>
          <div><dt>${t("desk.hold.pickup")}</dt><dd>${h.pickup_branch.name}</dd></div>
          <div><dt>${t("desk.hold.until")}</dt><dd>${until || t("desk.hold.until_on_arrival")}</dd></div>
          <div><dt>${t("desk.hold.item")}</dt><dd>${r.item.biblio.title}<div class="mono small">${r.item.barcode}${r.item.call_number ? ` · ${r.item.call_number}` : ""}</div></dd></div>
        </dl>
        <p class="hd-waiting small muted" aria-live="polite"></p>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" data-hd="done">${t("desk.hold.done")} <kbd>Esc</kbd></button>
        <button type="button" class="btn primary" data-hd="print">${icon("printer")}${shelf ? t("desk.hold.print_hold") : t("desk.hold.print_transit")}</button>
      </div>`;
    document.body.append(d);
    const release = trapFocus(d);
    let buffer = "", last = 0;
    const waiting = $(".hd-waiting", d);
    const showWaiting = () => { waiting.textContent = S.queue.length ? t("desk.hold.scans_waiting", { count: S.queue.length }) : ""; };
    const close = async (print) => {
      if (print && row.slip) await printSlip(row.slip());
      d.close();
    };
    d.addEventListener("keydown", (e) => {
      const now = performance.now();
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
        // A printable key inside the dialog can only be the scanner (nothing here takes text): keep it.
        buffer = now - last > 1000 ? e.key : buffer + e.key;
        last = now;
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && buffer && now - last < 2000) {
        e.preventDefault();
        enqueue(buffer);
        buffer = "";
        showWaiting();
      }
    });
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-hd]");
      if (b) close(b.dataset.hd === "print");
    });
    d.addEventListener("cancel", (e) => { e.preventDefault(); close(false); });
    d.addEventListener("close", () => {
      release();
      d.remove();
      S.paused -= 1;
      activeInput().focus();
      resolve();
    }, { once: true });
    d.showModal();
    $('[data-hd="print"]', d).focus();
  });
}

// ------------------------------------------------------------------ patron

async function fetchContext(id) {
  return api(`/circulation/patrons/${id}/context`);
}

async function loadPatron(term) {
  term = term.trim();
  if (!term) { $("#patron-card").focus(); return; }
  const matches = $("#patron-matches");
  matches.hidden = true;
  let p = null;
  try {
    try { p = await api(`/circulation/patrons/by-card/${encodeURIComponent(term)}/context`); }
    catch (e) {
      if (e.status !== 404) throw e;
      const found = await api(`/patrons?${new URLSearchParams({ q: term, per_page: 8 })}`);
      if (found.results.length === 1) p = await fetchContext(found.results[0].id);
      else if (found.results.length > 1) { showMatches(term, found.results, found.total); return; }
      else throw Object.assign(new Error(t("desk.err.no_patron_match", { term })), { status: 404, data: { code: "no_match" } });
    }
  } catch (e) {
    flash($("#patron-form"), "error");
    notice(t("desk.err.patron_title"), e.data?.code === "no_match" ? e.message : errorText(e));
    $("#patron-card").select();
    return;
  }
  setPatron(p);
}

function showMatches(term, rows, total) {
  const box = $("#patron-matches");
  box.innerHTML = html`<p class="small" id="pm-h">${t("desk.circ.matches", { count: total, term })}</p>
    <ul class="pm-list" role="list" aria-labelledby="pm-h">${rows.map((r) => html`<li><button type="button" class="pm-item" data-pick="${r.id}">
      ${avatar(r.full_name)}<span class="grow"><strong>${r.full_name}</strong><span class="small muted"><span class="mono">${r.card_number}</span> · ${r.category?.name || ""} · ${r.home_branch?.name || ""}</span></span>
      ${r.balance > 0 ? statusPill("patron", "owing", money(r.balance)) : ""}</button></li>`)}</ul>`;
  box.hidden = false;
  tone("info");
  $(".pm-item", box)?.focus();
}

function setPatron(p) {
  const fresh = !S.patron || S.patron.id !== p.id;
  S.patron = p;
  if (fresh) {
    S.visit += 1;
    S.override = null;
    visitDivider(p);
    tone("info");
    announce(t("desk.say.patron_loaded", { name: p.full_name, count: p.loans.length }));
    if (p.block_reasons?.length) announce(t("desk.say.patron_blocked", { name: p.full_name }));
  }
  $("#patron-card").value = "";
  $("#patron-matches").hidden = true;
  if ($("#circ-banner").dataset.row === "0") banner(null); // a "patron not found" notice is now stale
  syncMode();
  renderSide();
  if (fresh) $("#barcode").focus();
}

function clearPatron() {
  S.patron = null;
  S.override = null;
  syncMode();
  renderSide();
  $("#patron-card").focus();
}

function schedulePatronRefresh() {
  if (!S.patron) return;
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(async () => {
    if (!S.patron || S.busy || S.queue.length) return;
    try { S.patron = await fetchContext(S.patron.id); renderSide(); } catch { /* keep the last copy */ }
  }, 350);
}

function dueState(l) {
  const ms = parseDate(l.due_at) - Date.now();
  if (l.overdue) return statusPill("loan", "overdue", t("desk.due.overdue", { count: l.days_overdue || 1 }));
  if (ms < DAY) return statusPill("loan", "due_soon", t("desk.due.today"));
  if (ms < 3 * DAY) return statusPill("loan", "due_soon", t("desk.due.soon", { date: fmtDue(l.due_at) }));
  return html`<span class="pt-due">${t("desk.circ.due", { date: fmtDue(l.due_at) })}</span>`;
}

function membershipPill(p) {
  if (!p.is_active) return statusPill("patron", "inactive");
  if (!p.expires_on) return statusPill("patron", "active");
  const days = (parseDate(p.expires_on) - Date.now()) / DAY;
  if (days < 0) return statusPill("patron", "expired", t("desk.pt.expired_on", { date: date(p.expires_on) }));
  if (days <= 30) return statusPill("patron", "expiring", t("desk.pt.expires_on", { date: date(p.expires_on) }));
  return statusPill("patron", "active");
}

function patronPanel(p) {
  const ready = p.holds.filter((h) => h.status === "ready");
  const waiting = p.holds.filter((h) => h.status !== "ready");
  const blocks = p.block_reasons || [];
  const loans = [...p.loans].sort((a, b) => parseDate(a.due_at) - parseDate(b.due_at));
  return html`<section class="card circ-panel" aria-labelledby="pt-name">
    <div class="pt-head">${avatar(p.full_name, { size: "lg" })}
      <div class="grow"><h2 id="pt-name"><a href="/staff/patrons/${p.id}">${p.full_name}</a></h2>
        <div class="pt-sub"><span class="mono">${p.card_number}</span> · ${p.category.name}</div>
        <div class="pt-sub">${p.home_branch.name}</div></div>
      <button type="button" class="btn sm" id="end-visit" data-tip="${t("desk.pt.end_visit_tip")}">${icon("check")}${t("desk.pt.end_visit")}</button></div>
    <div class="pt-pills">${membershipPill(p)}
      ${statusPill("loan", "active", t("desk.pt.loans", { count: p.loans.length, max: p.max_loans }))}
      ${ready.length ? statusPill("hold", "ready", t("desk.pt.holds_ready", { count: ready.length })) : ""}</div>
    ${blocks.length ? html`<div class="pt-block" role="group" aria-labelledby="pt-block-h">
      <div class="pt-block-head">${icon("x-circle")}<h3 id="pt-block-h">${t("desk.pt.blocked")}</h3></div>
      <ul>${blocks.map((b) => html`<li>${reasonText(b)}</li>`)}</ul>
      ${S.override?.visit === S.visit ? html`<div class="pt-override">${icon("shield")}<span class="grow">${t("desk.pt.override_on", { reason: S.override.reason })}</span>
          <button type="button" class="btn sm ghost" id="stop-override">${t("desk.pt.override_stop")}</button></div>`
        : p.can_override ? html`<button type="button" class="btn sm danger" id="start-override">${icon("shield")}${t("desk.pt.override_visit")}</button>`
          : html`<p class="small">${t("desk.pt.override_ask")}</p>`}</div>` : ""}
    ${p.notes ? html`<div class="pt-note">${icon("info")}<div><strong>${t("desk.pt.note")}</strong> ${p.notes}</div></div>` : ""}
    ${p.balance > 0 ? html`<div class="pt-money"><div><span class="pt-label">${t("desk.pt.balance")}</span><strong class="pt-amount">${money(p.balance)}</strong></div>
      <button type="button" class="btn sm" id="take-payment">${icon("wallet")}${t("desk.pt.take_payment")}</button></div>` : ""}
    ${ready.length ? html`<div class="pt-section"><h3>${t("desk.pt.ready_title", { count: ready.length })}</h3>
      <ul class="pt-list">${ready.map((h) => html`<li><span class="grow"><strong>${h.biblio.title}</strong>
        <span class="small muted">${h.pickup_branch.name}${h.item ? html` · <span class="mono">${h.item.barcode}</span>` : ""}</span></span>
        ${h.expires_at ? html`<span class="small">${t("desk.pt.until", { date: fmtDue(h.expires_at) })}</span>` : ""}</li>`)}</ul></div>` : ""}
    <div class="pt-section"><div class="pt-section-head"><h3>${t("desk.pt.loans_title", { count: loans.length })}</h3>
      ${loans.length ? html`<button type="button" class="btn sm" id="renew-all">${icon("refresh")}${t("desk.pt.renew_all")}</button>` : ""}</div>
      ${loans.length ? html`<ul class="pt-list pt-loans">${loans.map((l) => html`<li class="${l.overdue ? "is-overdue" : ""}">
        <span class="grow"><strong>${l.item.biblio.title}</strong><span class="small muted"><span class="mono">${l.item.barcode}</span>${l.renewals ? html` · ${t("desk.pt.renewed_n", { count: l.renewals })}` : ""}</span></span>
        ${dueState(l)}
        <button type="button" class="btn sm ghost" data-renew-barcode="${l.item.barcode}" aria-label="${t("desk.pt.renew_one", { title: l.item.biblio.title })}">${icon("refresh")}<span class="pt-btn-label">${t("desk.pt.renew")}</span></button></li>`)}</ul>`
        : html`<p class="small muted">${t("desk.pt.no_loans")}</p>`}</div>
    ${waiting.length ? html`<details class="pt-section"><summary>${t("desk.pt.waiting_title", { count: waiting.length })}</summary>
      <ul class="pt-list">${waiting.map((h) => html`<li><span class="grow">${h.biblio.title}</span>
        <span class="small muted">${h.queue_position ? t("desk.pt.queue_pos", { n: h.queue_position }) : t(`status.${h.status}`)}</span></li>`)}</ul></details>` : ""}
  </section>`;
}

function itemPanel() {
  const r = S.lastItem;
  const tot = S.totals;
  const summary = html`<section class="card circ-panel circ-summary" aria-labelledby="sum-h"><h2 id="sum-h">${t("desk.side.summary")}</h2>
    <dl class="sum-grid">
      <div><dt>${t("desk.side.returned")}</dt><dd>${num(tot.returned)}</dd></div>
      <div><dt>${t("desk.side.to_hold_shelf")}</dt><dd>${num(tot.hold)}</dd></div>
      <div><dt>${t("desk.side.in_transit")}</dt><dd>${num(tot.transit)}</dd></div>
      <div><dt>${t("desk.side.fines")}</dt><dd>${money(tot.fines)}</dd></div></dl></section>`;
  if (!r) {
    return html`<section class="card circ-panel circ-welcome"><h2>${t(`desk.side.${S.mode}_title`)}</h2><p class="muted">${t(`desk.side.${S.mode}_body`)}</p></section>${summary}`;
  }
  const ic = { hold_shelf: "bookmark", transit: "truck", home_branch: "truck", reshelve: "book", already_on_hold_shelf: "bookmark" }[r.routing] || "book";
  const toneCls = { hold_shelf: "info", transit: "info", home_branch: "warn", reshelve: "ok", already_on_hold_shelf: "warn" }[r.routing] || "ok";
  return html`<section class="card circ-panel circ-last" aria-labelledby="last-h">
    <h2 id="last-h" class="eyebrow">${t("desk.side.last_item")}</h2>
    <div class="route-box tone-${toneCls}">${icon(ic)}<span>${r.route}</span></div>
    <div class="last-title">${r.item.biblio.title}</div>
    <dl class="last-facts">
      <div><dt>${t("desk.side.barcode")}</dt><dd class="mono">${r.item.barcode}</dd></div>
      ${r.item.call_number ? html`<div><dt>${t("desk.side.call_number")}</dt><dd class="mono">${r.item.call_number}</dd></div>` : ""}
      <div><dt>${t("desk.side.home")}</dt><dd>${r.item.branch.name}</dd></div>
      ${r.loan?.patron ? html`<div><dt>${t("desk.side.returned_by")}</dt><dd><a href="/staff/patrons/${r.loan.patron.id}">${r.loan.patron.full_name}</a></dd></div>` : ""}
      ${Number(r.fine) > 0 ? html`<div><dt>${t("desk.side.fine")}</dt><dd>${money(r.fine)}</dd></div>` : ""}
    </dl></section>${summary}`;
}

function renderSide() {
  const side = $("#circ-side");
  const patronMode = S.mode === "checkout" || S.mode === "renew";
  if (patronMode && S.patron) side.innerHTML = patronPanel(S.patron);
  else if (patronMode) {
    side.innerHTML = html`<section class="card circ-panel circ-welcome"><h2>${t(`desk.side.${S.mode}_title`)}</h2>
      <p class="muted">${t(`desk.side.${S.mode}_body`)}</p>
      <ul class="circ-keys-list">${[["F2", "desk.mode.checkout"], ["F3", "desk.mode.checkin"], ["F4", "desk.mode.renew"], ["F6", "desk.mode.transfer"],
        ["Ctrl Z", "desk.keys.undo"], ["Esc", "desk.keys.dismiss"]].map(([k, l]) => html`<li><kbd>${k}</kbd><span>${t(l)}</span></li>`)}</ul></section>`;
  } else side.innerHTML = itemPanel();
}

// ------------------------------------------------------------------ dialogs (payment, override, receipt)

async function takePayment() {
  const p = S.patron;
  const fd = await modal({ title: t("desk.pay.title", { name: p.full_name }), submit: t("desk.pay.submit"), size: "sm",
    body: html`<div class="stack">
      <p>${t("desk.pay.owes", { amount: money(p.balance) })}</p>
      <div class="field"><label for="pay-amount">${t("desk.pay.amount")}</label>
        <input id="pay-amount" name="amount" type="number" inputmode="decimal" min="0.01" max="${p.balance}" step="0.01" required value="${Number(p.balance).toFixed(2)}"></div>
      <div class="field"><label for="pay-note">${t("desk.pay.note")} <span class="muted">${t("desk.optional")}</span></label>
        <input id="pay-note" name="note" maxlength="255" autocomplete="off"></div></div>` });
  if (!fd) return;
  const amount = Math.round(Number(fd.get("amount")) * 100);
  try {
    const r = await api(`/patrons/${p.id}/pay`, { method: "POST", body: { amount, note: String(fd.get("note") || "").trim() || null } });
    tone("ok");
    announce(t("desk.pay.done", { amount: money(amount / 100), balance: money(r.balance) }));
    addRow({ mode: "checkout", barcode: "—", status: "ok", kind: "payment", title: t("desk.pay.row", { amount: money(amount / 100) }),
      detail: t("desk.pay.balance_now", { balance: money(r.balance) }) });
    S.patron = await fetchContext(p.id);
    renderSide();
  } catch (e) { notice(t("desk.pay.failed"), errorText(e)); }
}

async function startOverride() {
  const reasons = ["manager", "paid", "renewing", "returned", "other"];
  const fd = await modal({ title: t("desk.ov.title"), submit: t("desk.ov.submit"), size: "sm", danger: true,
    body: html`<div class="stack"><p>${t("desk.ov.body", { name: S.patron.full_name })}</p>
      <fieldset class="stack tight ov-reasons"><legend>${t("desk.ov.reason")}</legend>
        ${reasons.map((r, i) => html`<label class="checkbox"><input type="radio" name="reason" value="${r}" ${i === 0 ? "checked" : ""} required> ${t(`desk.ov.r_${r}`)}</label>`)}</fieldset>
      <div class="field"><label for="ov-note">${t("desk.ov.note")} <span class="muted">${t("desk.optional")}</span></label>
        <input id="ov-note" name="note" maxlength="200" autocomplete="off"></div>
      <p class="small muted">${t("desk.ov.audited")}</p></div>` });
  if (!fd) return;
  const label = t(`desk.ov.r_${fd.get("reason")}`);
  const note = String(fd.get("note") || "").trim();
  S.override = { visit: S.visit, reason: note ? `${label}: ${note}` : label };
  renderSide();
  announce(t("desk.say.override_on"));
  const blocked = S.rows.filter((r) => r.visit === S.visit && r.status === "blocked" && r.mode === "checkout");
  for (const r of blocked) enqueue(r.barcode, { row: r, mode: "checkout", override: true, overrideReason: S.override.reason });
  $("#barcode").focus();
}

async function overrideRow(row) {
  const fd = await modal({ title: t("desk.ov.row_title"), submit: t("desk.ov.row_submit"), size: "sm", danger: true,
    body: html`<div class="stack"><p><strong>${row.title || row.barcode}</strong></p><p>${row.problem}</p>
      <div class="field"><label for="ovr-note">${t("desk.ov.row_reason")}</label>
        <input id="ovr-note" name="note" maxlength="200" required autocomplete="off"></div>
      <p class="small muted">${t("desk.ov.audited")}</p></div>` });
  if (!fd) return;
  enqueue(row.barcode, { row, mode: row.mode, override: true, overrideReason: String(fd.get("note")).trim() });
}

function visitLines() {
  if (!S.patron) return [];
  return S.rows.filter((r) => r.visit === S.visit && r.patronId === S.patron.id && ["ok", "warn"].includes(r.status)
    && (r.kind === "checkout" || r.kind === "renew") && r.loan)
    .map((r) => ({ kind: r.kind, loan_id: r.loan.id, title: r.loan.item.biblio.title, barcode: r.loan.item.barcode, due_at: r.loan.due_at }));
}

function needPatronForReceipt() {
  if (!S.patron) { notice(t("desk.receipt.no_patron_title"), t("desk.receipt.no_patron"), "warn"); return true; }
  if (!visitLines().length) { notice(t("desk.receipt.empty_title"), t("desk.receipt.empty"), "warn"); return true; }
  return false;
}

async function printReceipt() {
  if (needPatronForReceipt()) return;
  await printSlip(receiptDoc({ patron: S.patron, lines: visitLines(), library: library(), branch: branchName() }));
  activeInput().focus();
}

async function emailReceipt(btn) {
  if (needPatronForReceipt()) return;
  if (!S.patron.email) { notice(t("desk.receipt.email_title"), t("desk.err.no_email"), "warn"); return; }
  btn.setAttribute("aria-busy", "true");
  try {
    const r = await api("/circulation/receipt", { method: "POST", body: { patron_id: S.patron.id, lines: visitLines().map((l) => ({ loan_id: l.loan_id, kind: l.kind })) } });
    tone("ok");
    announce(t("desk.receipt.emailed", { to: r.to }));
    addRow({ mode: "checkout", barcode: "—", status: "ok", kind: "receipt", title: t("desk.receipt.emailed", { to: r.to }) });
  } catch (e) { notice(t("desk.receipt.email_title"), errorText(e)); }
  finally { btn.removeAttribute("aria-busy"); }
}

async function undoRow(row) {
  if (!row?.undoToken || row.status === "undone") return;
  const token = row.undoToken;
  update(row, { undoToken: null }); // one click = one request
  try {
    const r = await api("/circulation/undo", { method: "POST", body: { token } });
    const notes = r.notice_sent ? [t("desk.undo.notice_sent")] : [];
    update(row, { status: "undone", detail: t(r.undone === "checkout" ? "desk.undo.checkout_done" : "desk.undo.checkin_done"), notes, slip: null });
    if (row.kind === "checkin") {
      if (row.hadLoan) S.totals.returned = Math.max(0, S.totals.returned - 1);
      if (row.routing === "hold_shelf") S.totals.hold = Math.max(0, S.totals.hold - 1);
      if (row.routing === "transit") S.totals.transit = Math.max(0, S.totals.transit - 1);
      S.totals.fines = Math.max(0, S.totals.fines - (row.fine || 0));
      if (S.lastItem?.item?.barcode === row.barcode) S.lastItem = null;
      if (S.mode !== "checkout") renderSide();
    }
    tone("info");
    announce(t("desk.say.undone", { title: row.title }));
    schedulePatronRefresh();
  } catch (e) {
    notice(t("desk.undo.failed", { title: row.title }), errorText(e));
  }
  activeInput().focus();
}

function keysHelp() {
  const rows = [["F2", "desk.mode.checkout"], ["F3", "desk.mode.checkin"], ["F4", "desk.mode.renew"], ["F6", "desk.mode.transfer"],
    ["Enter", "desk.keys.submit"], ["Ctrl Z", "desk.keys.undo"], ["Esc", "desk.keys.dismiss"], ["Ctrl K", "desk.keys.palette"]];
  modal({ title: t("desk.circ.keys_title"), submit: t("common.close"), cancel: false, size: "sm",
    body: html`<div class="stack tight">${rows.map(([k, l]) => html`<div class="kv"><span>${t(l)}</span><kbd>${k}</kbd></div>`)}</div>
      <p class="small muted" style="margin-top:1rem">${t("desk.keys.note")}</p>` });
}

// ------------------------------------------------------------------ camera

async function scanWithCamera(target) {
  const dlg = document.createElement("dialog");
  dlg.className = "scanner sm";
  dlg.setAttribute("aria-labelledby", "cam-h");
  dlg.innerHTML = html`<div class="dialog-head"><h2 id="cam-h">${t("desk.circ.camera")}</h2><button type="button" class="btn ghost icon-only" data-close aria-label="${t("common.close")}">${icon("x")}</button></div>
    <div class="dialog-body"><video autoplay playsinline muted></video><p class="small muted">${t("desk.circ.camera_hint")}</p></div>`;
  document.body.append(dlg);
  dlg.showModal();
  let stream, active = true;
  const stop = () => { active = false; stream?.getTracks().forEach((tr) => tr.stop()); if (dlg.open) dlg.close(); dlg.remove(); activeInput().focus(); };
  dlg.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) stop(); });
  dlg.addEventListener("cancel", stop);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = $("video", dlg);
    video.srcObject = stream;
    const detector = new window.BarcodeDetector();
    while (active) {
      const codes = await detector.detect(video).catch(() => []);
      if (codes.length) {
        const value = codes[0].rawValue;
        stop();
        if (target === "patron") loadPatron(value); else enqueue(value);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    stop();
    notice(t("desk.circ.camera"), t("desk.err.camera", { reason: e.message }));
  }
}

// ------------------------------------------------------------------ modes & wiring

const activeInput = () => (S.mode === "checkout" && !S.patron ? $("#patron-card") : $("#barcode"));

function syncMode() {
  const m = S.mode;
  root().dataset.mode = m;
  document.documentElement.dataset.deskMode = m; // read by desk.css before this script ran (desk-boot.js)
  $$("#circ-modes [data-mode]").forEach((b) => { const on = b.dataset.mode === m; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; });
  $("#patron-form").hidden = !(m === "checkout" && !S.patron);
  $("#item-form").hidden = m === "checkout" && !S.patron;
  $("#barcode-label").textContent = t(`desk.circ.item_label.${m}`);
  $("#item-submit").textContent = t(`desk.circ.submit.${m}`);
}

function setMode(m, { focus = true } = {}) {
  if (!MODES.includes(m)) return;
  S.mode = m;
  history.replaceState(null, "", `${location.pathname}${location.search}#${m}`);
  syncMode();
  renderSide();
  if (focus) activeInput().focus();
}

const isField = (el) => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

export default async function init() {
  // Branch list (the server-rendered option keeps the select stable while this loads).
  try {
    S.branches = (await api("/lookups")).branches || [];
    const sel = $("#desk-branch");
    let saved = null;
    try { saved = Number(localStorage.getItem("sw-desk-branch")); } catch { /* ignore */ }
    const current = S.branches.some((b) => b.id === saved) ? saved : BOOT.user.home_branch_id;
    sel.innerHTML = html`${S.branches.map((b) => html`<option value="${b.id}" ${b.id === current ? "selected" : ""}>${b.name}</option>`)}`;
    sel.addEventListener("change", () => { try { localStorage.setItem("sw-desk-branch", sel.value); } catch { /* ignore */ } announce(t("desk.say.branch", { branch: branchName() })); });
  } catch { /* the home branch option stays */ }

  // Sound switch
  const snd = $("#circ-sound");
  const paintSound = () => {
    snd.setAttribute("aria-pressed", String(soundOn()));
    $("use", snd).setAttribute("href", soundOn() ? "#i-volume" : "#i-volume-off");
  };
  paintSound();
  snd.addEventListener("click", () => { setSound(!soundOn()); paintSound(); if (soundOn()) tone("ok", { force: true }); });
  $("#circ-keys").addEventListener("click", keysHelp);

  if ("BarcodeDetector" in window && navigator.mediaDevices) $$("[data-camera]").forEach((b) => { b.hidden = false; });

  // Mode switch: radiogroup with arrow keys
  const modes = $("#circ-modes");
  modes.addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) setMode(b.dataset.mode); });
  modes.addEventListener("keydown", (e) => {
    const items = $$("[data-mode]", modes), i = items.indexOf(document.activeElement);
    const rtl = document.documentElement.dir === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowDown: 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -1 }[e.key];
    if (step === undefined || i < 0) return;
    e.preventDefault();
    const next = items[(i + step + items.length) % items.length];
    setMode(next.dataset.mode, { focus: false });
    next.focus();
  });

  // Forms: patron + item (the item field is never disabled; Enter queues the scan immediately)
  $("#patron-form").addEventListener("submit", (e) => { e.preventDefault(); loadPatron($("#patron-card").value); });
  $("#item-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#barcode");
    const value = input.value;
    input.value = "";
    if (!value.trim()) { input.focus(); return; }
    enqueue(value);
    input.focus();
  });
  $("#patron-matches").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    try { setPatron(await fetchContext(Number(b.dataset.pick))); } catch (err) { notice(t("desk.err.patron_title"), errorText(err)); }
  });
  $("#patron-matches").addEventListener("keydown", (e) => {
    const items = $$(".pm-item", e.currentTarget), i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (j === undefined) { if (e.key === "Escape") { e.currentTarget.hidden = true; $("#patron-card").focus(); } return; }
    e.preventDefault();
    items[(j + items.length) % items.length].focus();
  });

  // Log + banner actions (event delegation)
  const onAction = async (e) => {
    const b = e.target.closest("[data-act]");
    if (b) {
      const row = S.rows.find((r) => String(r.id) === b.dataset.row);
      if (!row) return;
      const act = b.dataset.act;
      if (act === "undo") undoRow(row);
      else if (act === "retry") enqueue(row.barcode, { row, mode: row.mode });
      else if (act === "override") overrideRow(row);
      else if (act === "slip" && row.slip) { await printSlip(row.slip()); activeInput().focus(); }
      else if (act === "checkin-lend") {
        const lend = { ...row };
        enqueue(row.barcode, { mode: "checkin" });
        enqueue(lend.barcode, { row, mode: "checkout" });
      } else if (act === "renew-instead") enqueue(row.barcode, { row, mode: "renew" });
      return;
    }
    if (e.target.closest("[data-dismiss-banner]")) { banner(null); activeInput().focus(); }
  };
  $("#circ-log").addEventListener("click", onAction);
  $("#circ-banner").addEventListener("click", onAction);
  $("#print-receipt").addEventListener("click", printReceipt);
  $("#email-receipt").addEventListener("click", (e) => emailReceipt(e.currentTarget));

  // Patron panel actions
  $("#circ-side").addEventListener("click", (e) => {
    if (e.target.closest("#end-visit")) clearPatron();
    else if (e.target.closest("#take-payment")) takePayment();
    else if (e.target.closest("#start-override")) startOverride();
    else if (e.target.closest("#stop-override")) { S.override = null; renderSide(); }
    else if (e.target.closest("#renew-all")) { S.patron.loans.forEach((l) => enqueue(l.item.barcode, { mode: "renew" })); }
    else {
      const r = e.target.closest("[data-renew-barcode]");
      if (r) enqueue(r.dataset.renewBarcode, { mode: "renew" });
    }
  });
  document.addEventListener("click", (e) => { const c = e.target.closest("[data-camera]"); if (c) scanWithCamera(c.dataset.camera); });

  // Keyboard: F-keys, Ctrl+Z (undo last), Esc (dismiss banner) and "type anywhere" → the active scan field.
  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    if (FKEYS[e.key] && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); setMode(FKEYS[e.key]); return; }
    const el = document.activeElement;
    const inScan = el === $("#barcode") || el === $("#patron-card");
    if (e.key === "Escape" && !$("#circ-banner").hidden && (inScan || !isField(el))) { banner(null); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey && (!isField(el) || (inScan && !el.value))) {
      const last = S.rows.find((r) => r.undoToken && r.status !== "undone" && Date.now() < r.undoUntil);
      if (last) { e.preventDefault(); undoRow(last); }
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !isField(el) && !["?", "/", " "].includes(e.key)
      && !el?.closest?.(".popover,[role=menu],[role=dialog],.drawer")) {
      const input = activeInput();
      if (input && !input.closest("[hidden]")) { input.focus(); input.value += e.key; e.preventDefault(); }
    }
  }, true);

  // Initial mode and patron (?patron=<card> deep link from the patron page and the audit)
  const start = location.hash.slice(1);
  S.mode = MODES.includes(start) ? start : "checkout";
  syncMode();
  const card = new URLSearchParams(location.search).get("patron");
  if (card) await loadPatron(card); else renderSide();
  activeInput().focus();
}
