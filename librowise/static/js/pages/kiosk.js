// Self-checkout kiosk: touch-first, large type, three clear steps (sign in → scan → finish), audio feedback,
// idle auto sign-out with a visible countdown, printed or emailed receipt.
// * Authenticates ONLY with the device token (localStorage) + a short-lived patron session token; it never
//   relies on cookies and signs out any staff session left open in this browser.
// * Scans are queued and processed one at a time (each gets its own line), so a fast scanner never loses one.
// * Works in every UI language and direction; honours the reader's high-contrast and sound choices.
import { $, $$, html, icon, trapFocus } from "/static/js/core.js";
import { formatDate, t } from "/static/js/i18n.js";
import { tone } from "/static/js/pages/lib/desk-feedback.js";
import { reasonText } from "/static/js/pages/lib/desk-ui.js";

const TOKEN_KEY = "sw-kiosk-token";
const PREFS_KEY = "sw-kiosk-prefs";
const IDLE_WARN_MS = 45_000; // inactivity before "Are you still there?"
const IDLE_GRACE_S = 15; // countdown before automatic sign-out
const DONE_RETURN_S = 15; // the goodbye screen returns to the start
const WELCOME_CLEAR_MS = 60_000; // half-typed credentials are wiped

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const prefs = (() => { try { return JSON.parse(store.get(PREFS_KEY) || "{}"); } catch { return {}; } })();
const savePrefs = () => store.set(PREFS_KEY, JSON.stringify(prefs));

const state = { device: null, session: null, data: null, screen: "loading", idleTimer: 0, countdown: 0, doneTimer: 0, welcomeTimer: 0,
  receipt: null, lines: [], queue: [], busy: false, seq: 0, releaseIdle: null };

// ------------------------------------------------------------------ API (kiosk headers only)

class KioskError extends Error {
  constructor(status, data) { super(data?.detail || `HTTP ${status}`); this.status = status; this.data = data || {}; }
}

async function kapi(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  const token = store.get(TOKEN_KEY);
  if (token) headers["X-Kiosk-Token"] = token;
  if (state.session) headers["X-Kiosk-Session"] = state.session;
  const csrf = document.cookie.split("; ").find((c) => c.startsWith("sw_csrf="));
  if (csrf) headers["X-CSRF-Token"] = decodeURIComponent(csrf.split("=")[1]);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(`/api/v1/kiosk${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit" });
  } catch { throw new KioskError(0, { code: "network" }); }
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  if (!res.ok) throw new KioskError(res.status, data);
  return data;
}

const beep = (kind) => tone(kind, { enabled: prefs.sound !== false });

// ------------------------------------------------------------------ screens & status

function show(screen, focusSel) {
  state.screen = screen;
  $("#kiosk").dataset.screenNow = screen;
  $$("[data-screen]").forEach((s) => { s.hidden = s.dataset.screen !== screen; });
  const steps = $("#k-steps");
  steps.classList.toggle("is-hidden", !["welcome", "session", "receipt", "done"].includes(screen));
  const order = ["welcome", "session", "receipt"];
  const at = screen === "done" ? 3 : order.indexOf(screen);
  $$("[data-step]", steps).forEach((li, i) => {
    li.classList.toggle("is-done", i < at);
    if (i === at) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
  clearTimeout(state.welcomeTimer);
  const target = focusSel ? $(focusSel) : $(`[data-screen="${screen}"] h1`);
  if (target) {
    if (!target.matches("input,button,select,textarea")) target.setAttribute("tabindex", "-1");
    requestAnimationFrame(() => target.focus({ preventScroll: false }));
  }
  resetIdle();
}

function status(msg) { $("#k-status").textContent = msg || ""; }

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = !msg;
}

const due = (iso) => formatDate(new Date(`${iso}Z`), { weekday: "short", day: "numeric", month: "short" });

function errorMessage(e) {
  const code = e.data?.code;
  if (!e.status) return t("kiosk.err_offline");
  if (e.status === 429) return t("kiosk.err_rate");
  if (code === "reserved") return t("kiosk.err_reserved");
  if (code === "not_found" || e.status === 404) return t("kiosk.err_not_found");
  if (code === "already_on_loan") return t("kiosk.err_already_yours");
  if (code === "on_loan") return t("kiosk.err_on_loan");
  if (code === "checkout_blocked" || code === "renewal_blocked" || code === "policy_blocked") {
    const reasons = (e.data.reason_codes?.length ? e.data.reason_codes : (e.data.reasons || [e.message]).map((m) => ({ message: m }))).map(reasonText);
    return `${t(code === "renewal_blocked" ? "kiosk.err_renew_blocked" : "kiosk.err_blocked")}: ${reasons.join("; ")}`;
  }
  if (code === "conflict" || code === "withdrawn") return t("kiosk.err_conflict");
  return t("kiosk.err_generic");
}

// ------------------------------------------------------------------ device setup

async function hello() {
  if (!store.get(TOKEN_KEY)) { show("setup", "#k-token"); return; }
  try {
    state.device = await kapi("/hello");
    $("#k-library").textContent = state.device.library_name;
    $("#k-branch").textContent = `${t("kiosk.title")} · ${state.device.branch.name}`;
    document.title = `${t("kiosk.title")} · ${state.device.library_name}`;
    status("");
    show("welcome", "#k-card");
  } catch (e) {
    if (e.status === 401) {
      store.set(TOKEN_KEY, null);
      showError($("#k-setup-error"), t("kiosk.setup_invalid"));
      show("setup", "#k-token");
    } else {
      status(t("kiosk.err_offline"));
      setTimeout(hello, 10_000);
    }
  }
}

// ------------------------------------------------------------------ session rendering

function lineHtml(l) {
  const ic = l.status === "pending" ? html`<span class="spinner" aria-hidden="true"></span>` : icon(l.status === "error" ? "alert" : l.kind === "renew" ? "refresh" : "check");
  const text = l.status === "pending" ? t("kiosk.working")
    : l.status === "error" ? l.error
      : `${l.kind === "renew" ? t("kiosk.renewed") : t("kiosk.borrowed")} · ${t("kiosk.due", { date: due(l.due_at) })}`;
  return html`<li class="kiosk-line is-${l.status} ${l.kind}">
    <span class="kiosk-line-icon" aria-hidden="true">${ic}</span>
    <span class="grow"><strong>${l.title || l.barcode}</strong><span class="small ${l.status === "error" ? "kiosk-overdue" : "muted"}">${text}</span></span></li>`;
}

function renderLines() {
  const done = state.lines.filter((l) => l.status === "ok");
  $("#k-now-count").textContent = done.length ? `(${done.length})` : "";
  $("#k-now").innerHTML = state.lines.length ? html`${state.lines.map(lineHtml)}` : html`<li class="kiosk-empty">${t("kiosk.nothing_yet")}</li>`;
}

function renderSession() {
  const d = state.data;
  $("#k-session-h").textContent = t("kiosk.hello", { name: d.patron.first_name });
  $("#k-session-sub").textContent = t("desk.kiosk.session_sub", { count: d.loans.length, max: d.max_loans });
  const blocks = d.block_codes?.length ? d.block_codes.map(reasonText) : d.blocks;
  $("#k-blocks").innerHTML = blocks.length ? html`<div class="kiosk-alert" role="note">${icon("alert")}<div><strong>${t("kiosk.blocked_title")}</strong>
    <ul>${blocks.map((b) => html`<li>${b}</li>`)}</ul><div class="small">${t("desk.kiosk.blocked_help")}</div></div></div>` : "";
  renderLines();
  $("#k-loans-count").textContent = d.loans.length ? `(${d.loans.length})` : "";
  $("#k-loans").innerHTML = d.loans.length ? html`${d.loans.map((l) => html`<li class="kiosk-line ${l.overdue ? "overdue" : ""}">
      <span class="grow"><strong>${l.title}</strong><span class="small ${l.overdue ? "kiosk-overdue" : "muted"}">${l.overdue ? t("kiosk.overdue") : t("kiosk.due", { date: due(l.due_at) })}</span>
        ${state.device?.allow_renewal && !l.can_renew ? html`<span class="small kiosk-why">${t("desk.kiosk.cant_renew", { reason: (l.renew_codes || []).map(reasonText).join("; ") || l.renew_blocks.join("; ") })}</span>` : ""}</span>
      ${state.device?.allow_renewal && l.can_renew ? html`<button type="button" class="btn kiosk-btn sm" data-renew="${l.id}" aria-label="${t("kiosk.renew_item", { title: l.title })}">${icon("refresh")}${t("kiosk.renew")}</button>` : ""}</li>`)}`
    : html`<li class="kiosk-empty">${t("kiosk.no_loans")}</li>`;
  $("#k-holds-wrap").hidden = !d.holds_ready.length;
  $("#k-holds").innerHTML = html`${d.holds_ready.map((h) => html`<li class="kiosk-line"><span class="kiosk-line-icon hold" aria-hidden="true">${icon("bookmark")}</span><span class="grow"><strong>${h.title}</strong>
    <span class="small muted">${h.here ? t("kiosk.hold_here") : t("kiosk.hold_at", { branch: h.pickup })}</span></span></li>`)}`;
}

async function refreshSession() {
  try {
    state.data = await kapi("/me");
    renderSession();
  } catch (e) { if (e.status === 401) sessionExpired(); }
}

function sessionExpired() {
  state.session = null;
  state.data = null;
  state.lines = [];
  state.queue = [];
  hideIdle();
  status(t("kiosk.session_expired"));
  show("welcome", "#k-card");
}

// ------------------------------------------------------------------ actions

async function signIn(e) {
  e.preventDefault();
  const form = e.target, err = $("#k-login-error");
  const card = form.card.value.trim(), password = form.password.value;
  if (!card || !password) { showError(err, t("kiosk.err_missing")); beep("error"); (card ? form.password : form.card).focus(); return; }
  showError(err, "");
  const btn = $("button[type=submit]", form);
  btn.setAttribute("aria-busy", "true");
  try {
    const r = await kapi("/session", { method: "POST", body: { card, password } });
    state.session = r.session_token;
    state.data = r;
    state.lines = [];
    form.reset();
    setPwVisible(false);
    beep("info");
    renderSession();
    $("#k-scan-result").className = "kiosk-result";
    $("#k-scan-result").textContent = "";
    show("session", "#k-barcode");
    status(t("kiosk.signed_in", { name: r.patron.first_name }));
  } catch (ex) {
    beep("error");
    showError(err, ex.status === 401 ? t("kiosk.err_login") : errorMessage(ex));
    form.password.value = "";
    form.password.focus();
  } finally { btn.removeAttribute("aria-busy"); }
}

function result(kind, msg) {
  const out = $("#k-scan-result");
  out.className = `kiosk-result ${kind}`;
  out.innerHTML = html`${icon(kind === "ok" ? "check" : kind === "bad" ? "alert" : "info")}<span>${msg}</span>`;
}

/** Queue a scan; the field is never disabled and is cleared at once for the next one. */
function borrow(e) {
  e.preventDefault();
  const input = $("#k-barcode");
  const barcode = input.value.trim();
  input.value = "";
  input.focus();
  if (!barcode) return;
  const line = { id: ++state.seq, kind: "checkout", status: "pending", barcode };
  state.lines.unshift(line);
  renderLines();
  state.queue.push(line);
  pump();
}

async function pump() {
  if (state.busy) return;
  state.busy = true;
  while (state.queue.length && state.session) {
    const line = state.queue.shift();
    try {
      const r = await kapi("/checkout", { method: "POST", body: { barcode: line.barcode } });
      Object.assign(line, { status: "ok", title: r.loan.title, due_at: r.loan.due_at });
      result("ok", html`<strong>${r.loan.title}</strong> · ${t("kiosk.due", { date: due(r.loan.due_at) })}`);
      beep("ok");
    } catch (ex) {
      if (ex.status === 401) { state.busy = false; sessionExpired(); return; }
      Object.assign(line, { status: "error", error: errorMessage(ex) });
      result("bad", line.error);
      beep("error");
    }
    renderLines();
  }
  state.busy = false;
  if (state.session) refreshSession();
}

async function renewLoan(btn) {
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  try {
    const r = await kapi("/renew", { method: "POST", body: { loan_id: Number(btn.dataset.renew) } });
    state.lines.unshift({ id: ++state.seq, kind: "renew", status: "ok", title: r.loan.title, due_at: r.loan.due_at, barcode: r.loan.barcode });
    result("ok", t("kiosk.renewed_until", { title: r.loan.title, date: due(r.loan.due_at) }));
    beep("ok");
    await refreshSession();
  } catch (ex) {
    if (ex.status === 401) { sessionExpired(); return; }
    result("bad", errorMessage(ex));
    beep("error");
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

/** Finish → receipt choice (only when something happened this visit) → goodbye. */
function finish() {
  hideIdle();
  const n = state.lines.filter((l) => l.status === "ok").length;
  if (!n || !state.session) { endSession("none"); return; }
  $("#k-receipt-lead").textContent = t("desk.kiosk.receipt_lead", { count: n });
  const hint = state.data?.patron?.email_hint;
  $("#k-email-choice").hidden = !hint;
  $("#k-email-to").textContent = hint || "";
  show("receipt", '[data-receipt="print"]');
}

async function endSession(choice) {
  hideIdle();
  let receipt = null;
  if (state.session) {
    try { receipt = await kapi("/session/end", { method: "POST", body: { email_receipt: choice === "email" } }); } catch { /* may have expired */ }
  }
  state.session = null;
  state.data = null;
  state.receipt = receipt;
  const lines = receipt?.lines || [];
  state.lines = [];
  state.queue = [];
  status("");
  $("#k-scan-result").textContent = "";
  let lead = t("kiosk.done_lead_none");
  if (choice === "print" && receipt) lead = t("desk.kiosk.printing");
  else if (choice === "email") lead = receipt?.emailed_to ? t("desk.kiosk.emailed", { to: receipt.emailed_to }) : t("desk.kiosk.email_failed");
  else if (lines.length) lead = t("desk.kiosk.goodbye");
  $("#k-done-lead").textContent = lead;
  $("#k-done-list").innerHTML = html`${lines.filter((l) => l.kind === "checkout").slice(0, 6).map((l) => html`<li><span>${l.title}</span><strong>${t("kiosk.due", { date: due(l.due_at) })}</strong></li>`)}`;
  beep("done");
  show("done", "#k-again");
  if (choice === "print" && receipt) printReceipt();
  countdownHome();
}

function countdownHome() {
  let left = DONE_RETURN_S;
  const bar = $("#k-done-bar");
  const tick = () => {
    $("#k-done-timer").textContent = t("kiosk.returning", { count: left });
    bar.style.width = `${(100 * left) / DONE_RETURN_S}%`;
    if (left-- <= 0) { clearInterval(state.doneTimer); backToWelcome(); }
  };
  clearInterval(state.doneTimer);
  tick();
  state.doneTimer = setInterval(tick, 1000);
}

function backToWelcome() {
  clearInterval(state.doneTimer);
  state.receipt = null;
  $("#k-receipt").innerHTML = "";
  status("");
  show("welcome", "#k-card");
}

function printReceipt() {
  const r = state.receipt;
  if (!r) return;
  const when = formatDate(new Date(`${r.generated_at}Z`), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  $("#k-receipt").innerHTML = html`<h1>${r.library_name}</h1><p>${r.branch} · ${when}</p>
    <p>${t("kiosk.receipt_for", { name: r.patron.first_name, card: r.patron.card })}</p>
    <h2>${t("kiosk.receipt_this_visit")}</h2>
    ${r.lines.length ? html`<ol>${r.lines.map((l) => html`<li><strong>${l.title}</strong><br>${l.kind === "renew" ? t("kiosk.renewed") : t("kiosk.borrowed")} · ${t("kiosk.due", { date: due(l.due_at) })}<br><small>${l.barcode}</small></li>`)}</ol>` : html`<p>${t("kiosk.nothing_yet")}</p>`}
    ${r.open_loans.length ? html`<h2>${t("kiosk.your_loans")}</h2><ul>${r.open_loans.map((l) => html`<li>${l.title} — ${due(l.due_at)}</li>`)}</ul>` : ""}
    <p class="thanks">${t("kiosk.receipt_thanks")}</p>`;
  setTimeout(() => { try { window.print(); } catch { /* no printer */ } }, 50);
}

// ------------------------------------------------------------------ inactivity

function resetIdle() {
  clearTimeout(state.idleTimer);
  if (state.screen === "session" || state.screen === "receipt") state.idleTimer = setTimeout(showIdle, IDLE_WARN_MS);
  else if (state.screen === "welcome") {
    clearTimeout(state.welcomeTimer);
    state.welcomeTimer = setTimeout(() => { $("#k-login-form").reset(); showError($("#k-login-error"), ""); }, WELCOME_CLEAR_MS);
  }
}

function showIdle() {
  const box = $("#k-idle");
  box.hidden = false;
  state.releaseIdle = trapFocus(box);
  let left = IDLE_GRACE_S;
  const ring = $("#k-idle-ring");
  const tick = () => {
    $("#k-idle-count").textContent = left;
    $("#k-idle-text").textContent = t("kiosk.idle_text", { count: left });
    ring.style.strokeDashoffset = String(326.7 * (1 - left / IDLE_GRACE_S));
    if (left === IDLE_GRACE_S || left <= 5) beep("info");
    if (left-- <= 0) { hideIdle(); endSession("none"); }
  };
  tick();
  clearInterval(state.countdown);
  state.countdown = setInterval(tick, 1000);
  $("#k-idle-stay").focus();
}

function hideIdle() {
  clearInterval(state.countdown);
  state.releaseIdle?.();
  state.releaseIdle = null;
  $("#k-idle").hidden = true;
}

// ------------------------------------------------------------------ preferences

function applyPrefs() {
  const d = document.documentElement;
  // The kiosk's own high-contrast switch wins; otherwise keep the device's appearance setting (sw-prefs.theme).
  let base = null;
  try { base = JSON.parse(store.get("sw-prefs") || "{}").theme || null; } catch { /* ignore */ }
  if (prefs.contrast) d.dataset.theme = "contrast";
  else if (base && base !== "system" && base !== "contrast") d.dataset.theme = base;
  else delete d.dataset.theme;
  $("#k-contrast").setAttribute("aria-pressed", String(!!prefs.contrast));
  $("#k-sound").setAttribute("aria-pressed", String(prefs.sound !== false));
  $("#k-sound use").setAttribute("href", prefs.sound === false ? "#i-volume-off" : "#i-volume");
}

function setPwVisible(on) {
  $("#k-password").type = on ? "text" : "password";
  $("#k-show-pw").setAttribute("aria-pressed", String(on));
  $("#k-show-pw").textContent = on ? t("desk.kiosk.hide_pw") : t("desk.kiosk.show_pw");
}

async function scanWithCamera() {
  const dlg = document.createElement("dialog");
  dlg.className = "scanner";
  dlg.setAttribute("aria-labelledby", "k-cam-h");
  dlg.innerHTML = html`<div class="dialog-head"><h2 id="k-cam-h">${t("kiosk.camera")}</h2><button type="button" class="btn ghost icon-only" data-close aria-label="${t("common.close")}">${icon("x")}</button></div>
    <div class="dialog-body"><video autoplay playsinline muted></video></div>`;
  document.body.append(dlg);
  dlg.showModal();
  let stream, active = true;
  const stop = () => { active = false; stream?.getTracks().forEach((tr) => tr.stop()); if (dlg.open) dlg.close(); dlg.remove(); $("#k-barcode").focus(); };
  dlg.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) stop(); });
  dlg.addEventListener("cancel", stop);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = $("video", dlg);
    video.srcObject = stream;
    const detector = new window.BarcodeDetector();
    while (active) {
      const codes = await detector.detect(video).catch(() => []);
      if (codes.length) { $("#k-barcode").value = codes[0].rawValue; stop(); $("#k-scan-form").requestSubmit(); return; }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch { stop(); beep("error"); }
}

// ------------------------------------------------------------------ init

export default async function init() {
  document.documentElement.dataset.kiosk = "";
  // A kiosk is a public device: drop any staff/patron web session left in this browser.
  if (document.cookie.includes("sw_csrf=")) await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  // Keep patrons inside the kiosk: no command palette / navigation shortcuts.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["k", "j"].includes(e.key.toLowerCase())) { e.stopImmediatePropagation(); e.preventDefault(); }
    if ((e.key === "/" || e.key === "?") && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) e.stopImmediatePropagation();
    if (e.key === "Escape" && !$("#k-idle").hidden) { e.preventDefault(); hideIdle(); resetIdle(); refreshSession(); }
  }, true);
  applyPrefs();
  ["pointerdown", "keydown", "input", "touchstart"].forEach((ev) => document.addEventListener(ev, () => { if ($("#k-idle").hidden) resetIdle(); }, { passive: true }));

  $("#k-contrast").addEventListener("click", () => { prefs.contrast = !prefs.contrast; savePrefs(); applyPrefs(); });
  $("#k-sound").addEventListener("click", () => { prefs.sound = prefs.sound === false; savePrefs(); applyPrefs(); beep("info"); });
  $("#k-fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  $("#k-show-pw").addEventListener("click", () => setPwVisible($("#k-password").type === "password"));
  $("#k-setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = e.target.token.value.trim();
    if (!token) { showError($("#k-setup-error"), t("kiosk.setup_required")); return; }
    store.set(TOKEN_KEY, token);
    showError($("#k-setup-error"), "");
    e.target.reset();
    await hello();
  });
  $("#k-login-form").addEventListener("submit", signIn);
  $("#k-scan-form").addEventListener("submit", borrow);
  $("#k-loans").addEventListener("click", (e) => { const b = e.target.closest("[data-renew]"); if (b) renewLoan(b); });
  $("#k-finish").addEventListener("click", finish);
  $("#k-back").addEventListener("click", () => show("session", "#k-barcode"));
  $$("[data-receipt]").forEach((b) => b.addEventListener("click", () => endSession(b.dataset.receipt)));
  $("#k-again").addEventListener("click", backToWelcome);
  $("#k-idle-stay").addEventListener("click", () => { hideIdle(); resetIdle(); if (state.screen === "session") $("#k-barcode").focus(); refreshSession(); });
  $("#k-idle-end").addEventListener("click", () => { hideIdle(); finish(); });
  if ("BarcodeDetector" in window && navigator.mediaDevices) { $("#k-camera").hidden = false; $("#k-camera").addEventListener("click", scanWithCamera); }
  await hello();
}
