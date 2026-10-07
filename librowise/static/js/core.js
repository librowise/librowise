// Librowise UI core: API client, rendering helpers, theming, command palette, AI copilot.
// Pages are ES modules in /static/js/pages/<page>.js exporting a default init function.
import { locale as I18N_LOCALE, t, wireLanguageSwitchers } from "/static/js/i18n.js";
export { t };

// ------------------------------------------------------------------ utilities

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => (v === null || v === undefined ? "" : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

/** A string already known to be safe HTML. Behaves like a normal string everywhere. */
class SafeHTML extends String {
  get __raw() { return this.toString(); }
}
export const raw = (s) => new SafeHTML(s ?? "");
const part = (x) => (x instanceof SafeHTML ? x.toString() : esc(x));

/** Tagged template that escapes interpolations unless they are SafeHTML (from html`` or raw()). */
export function html(strings, ...values) {
  return raw(strings.reduce((out, s, i) => {
    const v = values[i - 1];
    return out + (Array.isArray(v) ? v.map(part).join("") : part(v)) + s;
  }));
}

export const BOOT = (() => {
  try { return JSON.parse(document.getElementById("boot").textContent); } catch { return {}; }
})();

const LOCALE = I18N_LOCALE || navigator.language || "en-IN";
const CURRENCY = BOOT.currency || "INR";
const moneyFmt = new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY });
export const money = (v) => moneyFmt.format(Number(v || 0));
export const num = (v) => new Intl.NumberFormat(LOCALE).format(Number(v || 0));
/** API timestamps are UTC without an offset; parse them as UTC (date-only values stay calendar dates). */
export const parseDate = (v) => new Date(typeof v === "string" && /T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v) ? `${v}Z` : v);
export const date = (v, opts = { day: "numeric", month: "short", year: "numeric" }) =>
  v ? new Intl.DateTimeFormat(LOCALE, opts).format(parseDate(v)) : "—";
export const datetime = (v) => date(v, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
export function relative(v) {
  if (!v) return "—";
  const diff = (parseDate(v) - Date.now()) / 1000;
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [u, s] of units) if (Math.abs(diff) >= s || u === "minute") return rtf.format(Math.round(diff / s), u);
}
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const initials = (name) => (name || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
export const statusLabel = (s) => t(`status.${s}`, {}, { available: "Available", on_loan: "On loan", on_hold_shelf: "On hold shelf", in_transit: "In transit",
  processing: "Processing", lost: "Lost", damaged: "Damaged", withdrawn: "Withdrawn", queued: "Queued", ready: "Ready for pickup",
  fulfilled: "Fulfilled", cancelled: "Cancelled", expired: "Expired" }[s] || s);
export const badge = (s, label) => raw(`<span class="badge ${esc(s)}">${esc(label || statusLabel(s))}</span>`);
export const icon = (name, cls = "") => raw(`<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`);
export const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)).toString();

// ------------------------------------------------------------------ API client

function cookie(name) {
  return document.cookie.split("; ").find((c) => c.startsWith(name + "="))?.split("=")[1];
}

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.detail || `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = "GET", body, form } = {}) {
  const headers = { Accept: "application/json" };
  const csrf = cookie("sw_csrf");
  if (csrf) headers["X-CSRF-Token"] = decodeURIComponent(csrf);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`/api/v1${path}`, { method, headers, body: payload, credentials: "same-origin" });
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/login")) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
    throw new ApiError(res.status, typeof data === "object" ? data : { detail: data });
  }
  return data;
}

/** Run an async action with a busy button and error toast. */
export async function withBusy(btn, fn) {
  const busy = btn && !btn.querySelector(":scope > .spinner");
  if (busy) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.insertAdjacentHTML("afterbegin", `<span class="spinner" aria-hidden="true"></span>`);
  }
  try { return await fn(); }
  catch (e) { toast(e.message, "error"); e.toasted = true; throw e; }
  finally {
    if (busy) {
      btn.querySelector(":scope > .spinner")?.remove();
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  }
}

// ------------------------------------------------------------------ feedback

/**
 * Show a toast. `opts` may be a number (duration in ms, legacy) or
 * `{ duration, action: { label, run }, dismissible }`. An action (e.g. Undo) keeps the toast up longer and
 * the returned handle lets callers close it early: `const h = toast("Deleted", "success", { action: { label: "Undo", run } })`.
 */
export function toast(message, type = "info", opts = 4200) {
  const box = $("#toasts");
  if (!box) return { close() {} };
  const o = typeof opts === "number" ? { duration: opts } : { ...opts };
  const duration = o.duration ?? (o.action ? 8000 : 4200);
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  const ic = { error: "alert", success: "check", warn: "alert" }[type] || "info";
  el.innerHTML = html`${icon(ic)}<div class="toast-msg">${message}</div>
    ${o.action ? html`<button type="button" class="toast-action">${o.action.label}</button>` : ""}
    <button type="button" class="toast-close" aria-label="${t("common.close", {}, "Close")}">${icon("x")}</button>`;
  box.append(el);
  let timer;
  const close = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 260);
  };
  const arm = () => { clearTimeout(timer); if (duration > 0) timer = setTimeout(close, duration); };
  el.querySelector(".toast-close").addEventListener("click", close);
  el.querySelector(".toast-action")?.addEventListener("click", async () => { close(); await o.action.run(); });
  // WCAG 2.2.1: pause the timer while the pointer or keyboard focus is on the toast.
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", arm);
  el.addEventListener("focusin", () => clearTimeout(timer));
  el.addEventListener("focusout", arm);
  arm();
  return { close, el };
}

export const skeleton = (rows = 3) => Array.from({ length: rows }, () => `<div class="skeleton" style="height:1.1rem;margin:.6rem 0"></div>`).join("");
export const empty = (msg, ic = "inbox") => html`<div class="empty">${icon(ic)}<div>${msg}</div></div>`;

const FOCUSABLE = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
/** Keep Tab / Shift+Tab inside `root` (modal dialogs, side panels). Returns a function that removes the trap. */
export function trapFocus(root) {
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const items = [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener("keydown", onKey);
  return () => root.removeEventListener("keydown", onKey);
}

let dialogSeq = 0;
/**
 * Modal dialog built on <dialog>. Resolves with the submitted FormData, or null when cancelled.
 * Options: title, body (html``), submit (label), size ("sm" | "md" | "lg" | "xl"; `wide` = "lg"), danger,
 * cancel (label or false to hide), className. Enter in any single-line field submits the primary action,
 * focus is trapped while open and returned to the opener afterwards.
 */
export function modal({ title, body, submit = t("common.save", {}, "Save"), wide = false, danger = false, size, cancel, className = "" }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const d = document.createElement("dialog");
    const sz = size || (wide ? "lg" : "md");
    if (sz !== "md") d.classList.add(sz);
    if (wide) d.classList.add("wide");
    if (className) d.classList.add(...className.split(/\s+/).filter(Boolean));
    const titleId = `dlg-${++dialogSeq}`;
    d.setAttribute("aria-labelledby", titleId);
    d.innerHTML = html`<form method="dialog" novalidate>
      <div class="dialog-head"><h2 id="${titleId}">${title}</h2><button type="button" class="btn ghost icon-only" data-dismiss aria-label="${t("common.close", {}, "Close")}">${icon("x")}</button></div>
      <div class="dialog-body">${raw(body)}</div>
      <div class="dialog-foot">${cancel === false ? "" : html`<button type="button" class="btn" data-dismiss>${cancel || t("common.cancel", {}, "Cancel")}</button>`}
      <button type="submit" class="btn ${danger ? "danger solid" : "primary"}" value="ok" data-primary>${submit}</button></div></form>`;
    document.body.append(d);
    const form = $("form", d);
    const primary = $("[data-primary]", d);
    const release = trapFocus(d);
    d.addEventListener("click", (e) => { if (e.target.closest("[data-dismiss]")) d.close("cancel"); });
    // Buttons inside the body default to type=submit; make them plain buttons so they never close the dialog.
    $$(".dialog-body button:not([type])", d).forEach((b) => { b.type = "button"; });
    // Enter in a single-line field always runs the primary action (never a body button or "cancel").
    form.addEventListener("keydown", (e) => {
      const el = e.target;
      if (e.key !== "Enter" || e.isComposing || e.shiftKey || e.altKey) return;
      if (el.tagName === "TEXTAREA" || el.tagName === "BUTTON" || el.tagName === "A" || el.closest("[role=listbox],[role=combobox][aria-expanded=true]")) return;
      if (el.tagName === "INPUT" && /^(checkbox|radio|file|button|submit|reset|range|color)$/.test(el.type)) return;
      e.preventDefault();
      form.requestSubmit(primary);
    });
    form.addEventListener("input", (e) => { if (e.target.getAttribute?.("aria-invalid") && e.target.checkValidity()) e.target.removeAttribute("aria-invalid"); });
    form.addEventListener("submit", (e) => {
      if (e.submitter && e.submitter !== primary) { e.preventDefault(); return; }
      if (!form.checkValidity()) {
        e.preventDefault();
        const bad = form.querySelector(":invalid");
        bad?.setAttribute("aria-invalid", "true");
        form.reportValidity();
        return;
      }
      d.returnValue = "ok";
    });
    d.addEventListener("close", () => {
      release();
      resolve(d.returnValue === "ok" ? new FormData(form) : null);
      d.remove();
      // Return focus to whatever opened the dialog (WCAG 2.4.3).
      if (opener?.isConnected) opener.focus?.();
    });
    d.showModal();
    ($("[autofocus]", d) || $(".dialog-body input:not([type=hidden]):not([disabled]),.dialog-body select,.dialog-body textarea", d) || primary).focus();
  });
}
export const confirmDialog = (title, text, submit = t("common.confirm", {}, "Confirm"), danger = true) =>
  modal({ title, body: html`<p>${text}</p>`, submit, danger, size: "sm" }).then((r) => r !== null);

export function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = typeof v === "string" ? v.trim() : v;
  return out;
}

// ------------------------------------------------------------------ book covers

const PALETTES = [["#0f766e", "#134e4a"], ["#7c3aed", "#4c1d95"], ["#b45309", "#78350f"], ["#1d4ed8", "#1e3a8a"],
  ["#be185d", "#831843"], ["#15803d", "#14532d"], ["#9a3412", "#7c2d12"], ["#334155", "#0f172a"]];
/** URL of a record's cover image via the cover service (/covers/{id}.jpg), or null when none can exist.
 *  The server serves an uploaded cover, else a cached Open Library cover by ISBN; on 404 the generated
 *  gradient cover underneath stays visible. `large` asks for the high-resolution variant. */
export function coverSrc(b, large = false) {
  if (b.cover) return large ? `${b.cover}${b.cover.includes("?") ? "&" : "?"}size=L` : b.cover;
  if (b.id && (b.isbn || b.cover_url)) return `/covers/${encodeURIComponent(b.id)}.jpg${large ? "?size=L" : ""}`;
  return null;
}
export function cover(b, size = "") {
  const h = [...(b.title || "")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const [c1, c2] = PALETTES[h % PALETTES.length];
  const author = (b.authors || [])[0] || "";
  const src = coverSrc(b, size === "lg");
  const img = src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : "";
  return raw(`<div class="cover ${size}" style="background:linear-gradient(160deg,${c1},${c2})">
    <div class="gen"><div class="gt">${esc(b.title)}</div><div class="ga">${esc(author.split(",")[0])}</div></div>${img}</div>`);
}
// CSP forbids inline handlers, so handle cover images with capturing listeners: fade in when loaded,
// remove when broken (the generated cover underneath then shows).
document.addEventListener("error", (e) => { if (e.target.tagName === "IMG" && e.target.closest(".cover")) e.target.remove(); }, true);
document.addEventListener("load", (e) => {
  const img = e.target;
  if (img.tagName !== "IMG" || !img.closest(".cover")) return;
  // Open Library answers unknown ISBNs with a 1×1 placeholder; treat tiny images as missing.
  if (img.naturalWidth < 8) img.remove(); else img.classList.add("loaded");
}, true);

export const authors = (list) => (list || []).map((a) => a.split(",").reverse().join(" ").trim()).join(", ");
export const availabilityBadge = (a) => {
  if (!a) return raw("");
  if (!a.total) return badge("withdrawn", t("availability.none", {}, "No copies"));
  return a.available ? badge("available", t("availability.some", { available: a.available, total: a.total, count: a.total }, `${a.available} of ${a.total} available`))
    : badge("on_loan", t("availability.all_out", {}, "All copies out"));
};

// ------------------------------------------------------------------ charts

export function barChart(values, { height = 180, labels = [], format = (v) => v } = {}) {
  const w = 600, pad = 24, max = Math.max(1, ...values);
  const bw = (w - pad) / Math.max(values.length, 1);
  const bars = values.map((v, i) => {
    const bh = (v / max) * (height - pad);
    return `<rect class="bar" x="${pad + i * bw + bw * 0.15}" y="${height - pad - bh}" width="${bw * 0.7}" height="${Math.max(bh, 1)}" rx="3"><title>${esc(labels[i] || "")}: ${esc(format(v))}</title></rect>`;
  }).join("");
  const grid = [0.25, 0.5, 0.75, 1].map((f) => `<line class="grid-line" x1="${pad}" x2="${w}" y1="${height - pad - f * (height - pad)}" y2="${height - pad - f * (height - pad)}"/>
    <text x="0" y="${height - pad - f * (height - pad) + 4}">${Math.round(max * f)}</text>`).join("");
  const step = Math.ceil(labels.length / 8);
  const xl = labels.map((l, i) => (i % step === 0 ? `<text x="${pad + i * bw + bw / 2}" y="${height - 6}" text-anchor="middle">${esc(l)}</text>` : "")).join("");
  return raw(`<svg class="chart" viewBox="0 0 ${w} ${height}" role="img" aria-label="Bar chart">${grid}${bars}${xl}</svg>`);
}

export function hbars(items, { format = (v) => num(v), color } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return raw(items.map((i, n) => `<div class="hbar"><span class="lbl" title="${esc(i.label)}">${esc(i.label)}</span>
    <div class="track"><div class="fill" style="width:${(100 * i.value) / max}%;background:${color || `var(--chart-${(n % 5) + 1})`}"></div></div>
    <span class="num small">${esc(format(i.value))}</span></div>`).join(""));
}

// ------------------------------------------------------------------ minimal, safe markdown (for AI answers)

export function markdown(text) {
  const lines = esc(text).split("\n");
  let out = "", list = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/`(.+?)`/g, "<code>$1</code>");
  for (const line of lines) {
    const ul = line.match(/^\s*[-*]\s+(.*)/), ol = line.match(/^\s*\d+\.\s+(.*)/);
    const kind = ul ? "ul" : ol ? "ol" : null;
    if (kind !== list) { if (list) out += `</${list}>`; if (kind) out += `<${kind}>`; list = kind; }
    if (kind) out += `<li>${inline((ul || ol)[1])}</li>`;
    else if (line.trim()) out += `<p>${inline(line)}</p>`;
  }
  if (list) out += `</${list}>`;
  return raw(`<div class="md">${out}</div>`);
}

// ------------------------------------------------------------------ appearance

const prefs = (() => { try { return JSON.parse(localStorage.getItem("sw-prefs") || "{}"); } catch { return {}; } })();
export function applyPrefs(p) {
  Object.assign(prefs, p);
  try { localStorage.setItem("sw-prefs", JSON.stringify(prefs)); } catch { /* ignore */ }
  const d = document.documentElement;
  if (!prefs.theme || prefs.theme === "system") delete d.dataset.theme; else d.dataset.theme = prefs.theme;
  d.dataset.density = prefs.density || "comfortable";
  d.style.setProperty("--scale", prefs.font_scale || 1);
  if (BOOT.user) api("/auth/preferences", { method: "PATCH", body: p }).catch(() => {});
}
if (BOOT.user?.preferences && Object.keys(BOOT.user.preferences).length) {
  Object.assign(prefs, BOOT.user.preferences);
  try { localStorage.setItem("sw-prefs", JSON.stringify(prefs)); } catch { /* ignore */ }
  const d = document.documentElement;
  if (prefs.theme && prefs.theme !== "system") d.dataset.theme = prefs.theme;
  if (prefs.density) d.dataset.density = prefs.density;
  if (prefs.font_scale) d.style.setProperty("--scale", prefs.font_scale);
}

export async function appearanceDialog() {
  const cur = prefs.theme || "system";
  const themes = { system: t("ui.appearance.system"), light: t("ui.appearance.light"), dark: t("ui.appearance.dark"),
    sepia: t("ui.appearance.sepia"), contrast: t("ui.appearance.contrast") };
  const densities = { comfortable: t("ui.appearance.comfortable"), compact: t("ui.appearance.compact") };
  const body = html`<div class="stack">
    <div class="field"><span class="label-like" id="ap-theme">${t("ui.appearance.theme")}</span><div class="row tight" role="group" aria-labelledby="ap-theme">${Object.entries(themes).map(([v, l]) =>
      html`<button type="button" class="chip" data-theme-pick="${v}" aria-pressed="${cur === v}">${l}</button>`)}</div></div>
    <div class="field"><span class="label-like" id="ap-density">${t("ui.appearance.density")}</span><div class="row tight" role="group" aria-labelledby="ap-density">${Object.entries(densities).map(([v, l]) =>
      html`<button type="button" class="chip" data-density-pick="${v}" aria-pressed="${(prefs.density || "comfortable") === v}">${l}</button>`)}</div></div>
    <div class="field"><label for="fs">${t("ui.appearance.text_size")} <span class="muted" id="fs-v">${Math.round((prefs.font_scale || 1) * 100)}%</span></label>
      <input id="fs" type="range" min="0.85" max="1.4" step="0.05" value="${prefs.font_scale || 1}"></div>
    <p class="small muted">${t("ui.appearance.synced")}</p></div>`;
  const p = modal({ title: t("ui.appearance.title"), body, submit: t("ui.appearance.done"), cancel: false });
  const dlg = $$("dialog").at(-1);
  dlg.addEventListener("click", (e) => {
    const tp = e.target.closest("[data-theme-pick]"), dp = e.target.closest("[data-density-pick]");
    if (tp) { $$("[data-theme-pick]", dlg).forEach((b) => b.setAttribute("aria-pressed", b === tp)); applyPrefs({ theme: tp.dataset.themePick }); }
    if (dp) { $$("[data-density-pick]", dlg).forEach((b) => b.setAttribute("aria-pressed", b === dp)); applyPrefs({ density: dp.dataset.densityPick }); }
  });
  $("#fs", dlg).addEventListener("input", (e) => {
    $("#fs-v", dlg).textContent = `${Math.round(e.target.value * 100)}%`;
    document.documentElement.style.setProperty("--scale", e.target.value);
  });
  $("#fs", dlg).addEventListener("change", (e) => applyPrefs({ font_scale: Number(e.target.value) }));
  await p;
}

// ------------------------------------------------------------------ command palette

const STAFF = !!BOOT.user?.is_staff;
const go = (href) => () => (location.href = href);
/** Static commands. Staff navigation commands are added from the sidebar (so they follow permissions). */
export const COMMANDS = [
  ...(STAFF ? [
    { group: "actions", label: t("ui.cmd.new_record"), run: go("/staff/catalog/new"), icon: "plus", keywords: "catalogue add create" },
    { group: "actions", label: t("ui.cmd.checkout"), hint: "F2", run: go("/staff/circulation#checkout"), icon: "arrow-up", keywords: "issue loan" },
    { group: "actions", label: t("ui.cmd.checkin"), hint: "F3", run: go("/staff/circulation#checkin"), icon: "arrow-down", keywords: "return discharge" },
    { group: "actions", label: t("ui.cmd.register_patron"), run: go("/staff/patrons#new"), icon: "user-plus", keywords: "member new" },
    { group: "actions", label: t("ui.cmd.copilot"), hint: "Ctrl+J", run: () => openCopilot(), icon: "sparkle", keywords: "ai assistant" },
    { group: "goto", label: t("ui.shell.account_security"), run: go("/staff/security"), icon: "shield", keywords: "2fa sessions tokens password" },
    { group: "goto", label: t("nav.public_catalogue"), run: go("/"), icon: "globe", keywords: "opac" },
    { group: "goto", label: t("ui.shell.design_system"), run: go("/staff/styleguide"), icon: "swatch", keywords: "style guide components" },
  ] : [
    { group: "goto", label: t("ui.cmd.home"), run: go("/"), icon: "home" },
    { group: "goto", label: t("opac.nav.account"), run: go("/account"), icon: "user" },
  ]),
  { group: "prefs", label: t("ui.cmd.appearance"), run: () => appearanceDialog(), icon: "palette", keywords: "theme density font size" },
  { group: "prefs", label: t("ui.cmd.toggle_dark"), run: () => applyPrefs({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }), icon: "moon" },
  { group: "help", label: t("ui.shell.shortcuts"), hint: "?", run: () => shortcutsHelp(), icon: "keyboard" },
  { group: "help", label: t("nav.api_docs"), run: () => window.open("/api/docs"), icon: "code" },
];

export function shortcutsHelp() {
  const rows = [["Ctrl/⌘ + K", t("ui.keys.palette")], ["/", t("ui.keys.search")], ["?", t("ui.keys.help")],
    ...(STAFF ? [["Ctrl/⌘ + J", t("ui.keys.copilot")], ["Alt + 1…9", t("ui.keys.hubs")], ["[", t("ui.keys.sidebar")],
      ["F2 / F3", t("ui.keys.desk")], ["J / K, ↑ / ↓", t("ui.keys.rows")], ["X / Space", t("ui.keys.select")]] : []),
    ["Esc", t("ui.keys.close")]];
  modal({ title: t("ui.shell.shortcuts"), submit: t("common.close"), cancel: false, size: "sm",
    body: html`<div class="stack tight">${rows.map(([k, v]) => html`<div class="kv"><span>${v}</span><kbd>${k}</kbd></div>`)}</div>` });
}

/** Open the command palette (global search over records, patrons, items and commands). */
export function openPalette(initial = "") {
  return import("/static/js/ui/palette.js").then((m) => m.openPalette({ commands: COMMANDS, staff: STAFF, initial }));
}

// ------------------------------------------------------------------ AI copilot drawer (staff)

const chat = [];
export function openCopilot(question) {
  const drawer = $("#copilot");
  if (!drawer) return;
  drawer.inert = false;  // closed drawer is inert: not focusable, not announced
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  const input = $("#copilot-input");
  input.focus();
  if (question) { input.value = question; $("#copilot-form").requestSubmit(); }
}
function initCopilot() {
  const drawer = $("#copilot");
  if (!drawer) return;
  const body = $("#copilot-body"), form = $("#copilot-form"), input = $("#copilot-input");
  const close = () => { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); drawer.inert = true; };
  $("#copilot-close").addEventListener("click", close);
  $$("[data-open-copilot]").forEach((b) => b.addEventListener("click", () => openCopilot()));
  drawer.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  body.addEventListener("click", (e) => {
    const s = e.target.closest("[data-suggest]");
    if (s) { input.value = s.dataset.suggest; form.requestSubmit(); }
  });
  api("/ai/status").then((s) => { $("#copilot-engine").textContent = s.claude ? "Claude" : "Local AI"; }).catch(() => {});
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    $(".copilot-welcome", body)?.remove();
    body.insertAdjacentHTML("beforeend", html`<div class="msg user">${q}</div>`);
    const typing = document.createElement("div");
    typing.className = "msg bot typing";
    typing.innerHTML = "<span></span><span></span><span></span>";
    body.append(typing);
    body.scrollTop = body.scrollHeight;
    try {
      const r = await api("/ai/ask", { method: "POST", body: { question: q, history: chat.slice(-8) } });
      chat.push({ role: "user", content: q }, { role: "assistant", content: r.answer });
      const tools = (r.trace || []).map((x) => x.tool.replace(/_/g, " ")).join(" · ");
      typing.outerHTML = html`<div class="msg bot">${markdown(r.answer)}<div class="trace">${r.engine === "claude" ? "Claude" : "Local AI"}${tools ? " · used: " + tools : ""}</div></div>`;
    } catch (err) {
      typing.outerHTML = html`<div class="msg bot">Sorry — ${err.message}</div>`;
    }
    body.scrollTop = body.scrollHeight;
  });
}

// ------------------------------------------------------------------ global wiring

const isTyping = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;

function initShell() {
  wireLanguageSwitchers();
  $$("[data-open-palette]").forEach((b) => b.addEventListener("click", () => openPalette()));
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-appearance]")) appearanceDialog();
    else if (e.target.closest("[data-shortcuts]")) shortcutsHelp();
  });
  $$("[data-logout]").forEach((b) => b.addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  }));
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j" && STAFF) { e.preventDefault(); openCopilot(); }
    else if (e.key === "/" && !isTyping() && !e.ctrlKey && !e.metaKey) {
      const s = $("[data-search-focus]");
      if (s) { e.preventDefault(); s.focus(); s.select?.(); } else if (STAFF) { e.preventDefault(); openPalette(); }
    } else if (e.key === "?" && !isTyping() && !document.querySelector("dialog[open]")) { e.preventDefault(); shortcutsHelp(); }
  });
  initCopilot();
  // Staff shell (sidebar, hubs, user menu, notifications) and global tooltips load on demand.
  if ($("[data-shell]")) import("/static/js/ui/shell.js").then((m) => m.initShell()).catch((err) => console.error(err));
  import("/static/js/ui/tooltip.js").then((m) => m.initTooltips()).catch(() => {});
}

initShell();
const page = document.body.dataset.page;
if (page) {
  import(`/static/js/pages/${page}.js`)
    .then((m) => m.default?.())
    .catch((e) => { console.error(e); toast(`Could not load this page: ${e.message}`, "error"); });
}
