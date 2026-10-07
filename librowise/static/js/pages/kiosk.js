// Self-checkout kiosk: touch-first, large type, audio feedback, idle auto sign-out, printable receipt.
// Authenticates ONLY with the device token (localStorage) + a short-lived patron session token; it never
// relies on cookies and signs out any staff session left open in this browser.
import { $, $$, html, icon } from "/static/js/core.js";
import { formatDate, t } from "/static/js/i18n.js";

const TOKEN_KEY = "sw-kiosk-token";
const PREFS_KEY = "sw-kiosk-prefs";
const IDLE_WARN_MS = 45_000; // inactivity before "Are you still there?"
const IDLE_GRACE_S = 15; // countdown before automatic sign-out
const DONE_RETURN_S = 20; // receipt screen returns to welcome
const WELCOME_CLEAR_MS = 60_000; // half-typed credentials are wiped

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const prefs = (() => { try { return JSON.parse(store.get(PREFS_KEY) || "{}"); } catch { return {}; } })();
const savePrefs = () => store.set(PREFS_KEY, JSON.stringify(prefs));

const state = { device: null, session: null, data: null, screen: "loading", idleTimer: 0, countdown: 0, doneTimer: 0, welcomeTimer: 0, receipt: null };

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
  const res = await fetch(`/api/v1/kiosk${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit" });
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  if (!res.ok) throw new KioskError(res.status, data);
  return data;
}

// ------------------------------------------------------------------ audio feedback (WebAudio)

let audio = null;
function beep(kind) {
  if (prefs.sound === false) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    const tones = { ok: [[880, 0.09], [1320, 0.12]], error: [[196, 0.22], [147, 0.3]], info: [[660, 0.08]], done: [[660, 0.09], [880, 0.09], [1320, 0.16]] }[kind] || [[660, 0.08]];
    let at = audio.currentTime;
    for (const [freq, dur] of tones) {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = kind === "error" ? "square" : "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(kind === "error" ? 0.12 : 0.2, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + dur + 0.02);
      at += dur + 0.03;
    }
  } catch { /* audio unavailable */ }
}

// ------------------------------------------------------------------ screens & status

function show(screen, focusSel) {
  state.screen = screen;
  $$("[data-screen]").forEach((s) => { s.hidden = s.dataset.screen !== screen; });
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
  if (e.status === 429) return t("kiosk.err_rate");
  if (code === "reserved") return t("kiosk.err_reserved");
  if (code === "not_found") return t("kiosk.err_not_found");
  if (code === "already_on_loan") return t("kiosk.err_already_yours");
  if (code === "on_loan") return t("kiosk.err_on_loan");
  if (code === "checkout_blocked" || code === "renewal_blocked" || code === "policy_blocked") {
    return `${t(code === "renewal_blocked" ? "kiosk.err_renew_blocked" : "kiosk.err_blocked")} (${(e.data.reasons || [e.message]).join("; ")})`;
  }
  if (code === "conflict") return t("kiosk.err_conflict");
  return e.message || t("kiosk.err_generic");
}

// ------------------------------------------------------------------ device setup

async function hello() {
  if (!store.get(TOKEN_KEY)) { show("setup", "#k-token"); return; }
  try {
    state.device = await kapi("/hello");
    $("#k-library").textContent = state.device.library_name;
    $("#k-branch").textContent = `${t("kiosk.title")} · ${state.device.branch.name}`;
    document.title = `${t("kiosk.title")} · ${state.device.library_name}`;
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

function renderSession() {
  const d = state.data;
  $("#k-session-h").textContent = t("kiosk.hello", { name: d.patron.first_name });
  $("#k-blocks").innerHTML = d.blocks.length ? html`<div class="kiosk-alert">${icon("alert")}<div><strong>${t("kiosk.blocked_title")}</strong><div>${d.blocks.join("; ")}</div></div></div>` : "";
  const visit = (d.activity || []).length;
  $("#k-now").innerHTML = state.visitLines?.length ? html`${state.visitLines.map((l) => html`<li class="kiosk-line ${l.kind}">
      <span class="kiosk-line-icon" aria-hidden="true">${icon(l.kind === "renew" ? "refresh" : "check")}</span>
      <span class="grow"><strong>${l.title}</strong><span class="small muted">${l.kind === "renew" ? t("kiosk.renewed") : t("kiosk.borrowed")} · ${t("kiosk.due", { date: due(l.due_at) })}</span></span></li>`)}`
    : html`<li class="kiosk-empty">${visit ? "" : t("kiosk.nothing_yet")}</li>`;
  $("#k-loans").innerHTML = d.loans.length ? html`${d.loans.map((l) => html`<li class="kiosk-line ${l.overdue ? "overdue" : ""}">
      <span class="grow"><strong>${l.title}</strong><span class="small ${l.overdue ? "kiosk-overdue" : "muted"}">${l.overdue ? t("kiosk.overdue") : t("kiosk.due", { date: due(l.due_at) })}</span></span>
      ${state.device?.allow_renewal ? html`<button type="button" class="btn kiosk-btn sm" data-renew="${l.id}" ${l.can_renew ? "" : "disabled"}
        aria-label="${t("kiosk.renew_item", { title: l.title })}" title="${l.can_renew ? "" : l.renew_blocks.join("; ")}">${icon("refresh")}${t("kiosk.renew")}</button>` : ""}</li>`)}`
    : html`<li class="kiosk-empty">${t("kiosk.no_loans")}</li>`;
  $("#k-holds-wrap").hidden = !d.holds_ready.length;
  $("#k-holds").innerHTML = html`${d.holds_ready.map((h) => html`<li class="kiosk-line"><span class="grow"><strong>${h.title}</strong>
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
  state.visitLines = [];
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
  btn.disabled = true;
  try {
    const r = await kapi("/session", { method: "POST", body: { card, password } });
    state.session = r.session_token;
    state.data = r;
    state.visitLines = [];
    form.reset();
    beep("info");
    renderSession();
    show("session", "#k-barcode");
    status(t("kiosk.signed_in", { name: r.patron.first_name }));
  } catch (ex) {
    beep("error");
    showError(err, ex.status === 401 ? t("kiosk.err_login") : errorMessage(ex));
    form.password.value = "";
    form.password.focus();
  } finally { btn.disabled = false; }
}

async function borrow(e) {
  e.preventDefault();
  const input = $("#k-barcode"), out = $("#k-scan-result");
  const barcode = input.value.trim();
  if (!barcode) { input.focus(); return; }
  input.value = "";
  out.className = "kiosk-result";
  out.textContent = t("kiosk.working");
  try {
    const r = await kapi("/checkout", { method: "POST", body: { barcode } });
    state.visitLines = [{ kind: "checkout", title: r.loan.title, due_at: r.loan.due_at }, ...(state.visitLines || [])];
    out.className = "kiosk-result ok";
    out.innerHTML = html`${icon("check")}<span><strong>${r.loan.title}</strong> — ${t("kiosk.due", { date: due(r.loan.due_at) })}</span>`;
    beep("ok");
    await refreshSession();
  } catch (ex) {
    if (ex.status === 401) { sessionExpired(); return; }
    out.className = "kiosk-result bad";
    out.innerHTML = html`${icon("alert")}<span>${errorMessage(ex)}</span>`;
    beep("error");
  }
  input.focus();
}

async function renewLoan(btn) {
  btn.disabled = true;
  const out = $("#k-scan-result");
  try {
    const r = await kapi("/renew", { method: "POST", body: { loan_id: Number(btn.dataset.renew) } });
    state.visitLines = [{ kind: "renew", title: r.loan.title, due_at: r.loan.due_at }, ...(state.visitLines || [])];
    out.className = "kiosk-result ok";
    out.innerHTML = html`${icon("refresh")}<span>${t("kiosk.renewed_until", { title: r.loan.title, date: due(r.loan.due_at) })}</span>`;
    beep("ok");
    await refreshSession();
  } catch (ex) {
    if (ex.status === 401) { sessionExpired(); return; }
    out.className = "kiosk-result bad";
    out.innerHTML = html`${icon("alert")}<span>${errorMessage(ex)}</span>`;
    beep("error");
    btn.disabled = false;
  }
}

async function finish() {
  hideIdle();
  let receipt = null;
  try { receipt = await kapi("/session/end", { method: "POST" }); } catch { /* session may already have expired */ }
  state.session = null;
  state.data = null;
  state.receipt = receipt;
  state.visitLines = [];
  status("");
  $("#k-scan-result").textContent = "";
  const n = receipt?.lines?.length || 0;
  $("#k-done-lead").textContent = n ? t("kiosk.done_lead", { count: n }) : t("kiosk.done_lead_none");
  $("#k-print").hidden = !receipt;
  beep("done");
  show("done", "#k-print");
  let left = DONE_RETURN_S;
  const tick = () => {
    $("#k-done-timer").textContent = t("kiosk.returning", { count: left });
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
  clearInterval(state.doneTimer);
  window.print();
  setTimeout(backToWelcome, 1500);
}

// ------------------------------------------------------------------ inactivity

function resetIdle() {
  clearTimeout(state.idleTimer);
  if (state.screen === "session") state.idleTimer = setTimeout(showIdle, IDLE_WARN_MS);
  else if (state.screen === "welcome") {
    clearTimeout(state.welcomeTimer);
    state.welcomeTimer = setTimeout(() => { $("#k-login-form").reset(); showError($("#k-login-error"), ""); }, WELCOME_CLEAR_MS);
  }
}

function showIdle() {
  const box = $("#k-idle");
  box.hidden = false;
  let left = IDLE_GRACE_S;
  const tick = () => {
    $("#k-idle-count").textContent = left;
    $("#k-idle-text").textContent = t("kiosk.idle_text", { count: left });
    if (left === IDLE_GRACE_S || left <= 5) beep("info");
    if (left-- <= 0) { hideIdle(); finish(); }
  };
  tick();
  clearInterval(state.countdown);
  state.countdown = setInterval(tick, 1000);
  $("#k-idle-stay").focus();
}

function hideIdle() {
  clearInterval(state.countdown);
  $("#k-idle").hidden = true;
}

// ------------------------------------------------------------------ preferences

function applyPrefs() {
  const d = document.documentElement;
  if (prefs.contrast) d.dataset.theme = "contrast"; else if (d.dataset.theme === "contrast") delete d.dataset.theme;
  $("#k-contrast").setAttribute("aria-pressed", String(!!prefs.contrast));
  $("#k-sound").setAttribute("aria-pressed", String(prefs.sound !== false));
  $("#k-sound use").setAttribute("href", prefs.sound === false ? "#i-volume-off" : "#i-volume");
}

async function scanWithCamera() {
  const dlg = document.createElement("dialog");
  dlg.className = "scanner";
  dlg.innerHTML = html`<div class="dialog-head"><h2>${t("kiosk.camera")}</h2><button class="btn ghost icon-only" data-close aria-label="${t("common.close")}">${icon("x")}</button></div>
    <div class="dialog-body"><video autoplay playsinline muted></video></div>`;
  document.body.append(dlg);
  dlg.showModal();
  let stream, active = true;
  const stop = () => { active = false; stream?.getTracks().forEach((tr) => tr.stop()); dlg.close(); dlg.remove(); $("#k-barcode").focus(); };
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
    if (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) e.stopImmediatePropagation();
  }, true);
  applyPrefs();
  ["pointerdown", "keydown", "input", "touchstart"].forEach((ev) => document.addEventListener(ev, () => { if ($("#k-idle").hidden) resetIdle(); }, { passive: true }));

  $("#k-contrast").addEventListener("click", () => { prefs.contrast = !prefs.contrast; savePrefs(); applyPrefs(); });
  $("#k-sound").addEventListener("click", () => { prefs.sound = prefs.sound === false; savePrefs(); applyPrefs(); beep("info"); });
  $("#k-fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => {});
  });
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
  $("#k-idle-stay").addEventListener("click", () => { hideIdle(); resetIdle(); $("#k-barcode").focus(); refreshSession(); });
  $("#k-idle-end").addEventListener("click", finish);
  $("#k-print").addEventListener("click", printReceipt);
  $("#k-no-receipt").addEventListener("click", backToWelcome);
  if ("BarcodeDetector" in window && navigator.mediaDevices) { $("#k-camera").hidden = false; $("#k-camera").addEventListener("click", scanWithCamera); }
  await hello();
}
