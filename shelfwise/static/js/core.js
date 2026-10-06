// Shelfwise UI core: API client, rendering helpers, theming, command palette, AI copilot.
// Pages are ES modules in /static/js/pages/<page>.js exporting a default init function.

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

const LOCALE = navigator.language || "en-IN";
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
export const statusLabel = (s) => ({ available: "Available", on_loan: "On loan", on_hold_shelf: "On hold shelf", in_transit: "In transit",
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

export function toast(message, type = "info", ms = 4200) {
  const box = $("#toasts");
  if (!box) return;
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.setAttribute("role", type === "error" ? "alert" : "status");
  t.innerHTML = html`${icon(type === "error" ? "alert" : type === "success" ? "check" : "info")}<div>${message}</div>`;
  box.append(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, ms);
}

export const skeleton = (rows = 3) => Array.from({ length: rows }, () => `<div class="skeleton" style="height:1.1rem;margin:.6rem 0"></div>`).join("");
export const empty = (msg, ic = "inbox") => html`<div class="empty">${icon(ic)}<div>${msg}</div></div>`;

/** Simple modal built on <dialog>. Resolves with the submitted FormData or null. */
export function modal({ title, body, submit = "Save", wide = false, danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    if (wide) d.classList.add("wide");
    d.innerHTML = html`<form method="dialog" novalidate>
      <div class="dialog-head"><h2>${title}</h2><button type="button" class="btn ghost icon-only" data-dismiss aria-label="Close">${icon("x")}</button></div>
      <div class="dialog-body">${raw(body)}</div>
      <div class="dialog-foot"><button type="button" class="btn" data-dismiss>Cancel</button>
      <button class="btn ${danger ? "danger" : "primary"}" value="ok">${submit}</button></div></form>`;
    document.body.append(d);
    const form = $("form", d);
    // Only the primary button submits, so Enter in a field confirms instead of cancelling.
    d.addEventListener("click", (e) => { if (e.target.closest("[data-dismiss]")) d.close("cancel"); });
    form.addEventListener("submit", (e) => {
      if (e.submitter?.value === "ok" && !form.checkValidity()) { e.preventDefault(); form.reportValidity(); }
    });
    d.addEventListener("close", () => {
      resolve(d.returnValue === "ok" ? new FormData(form) : null);
      d.remove();
    });
    d.showModal();
    $("input,select,textarea", d)?.focus();
  });
}
export const confirmDialog = (title, text, submit = "Confirm", danger = true) =>
  modal({ title, body: `<p>${esc(text)}</p>`, submit, danger }).then((r) => r !== null);

export function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = typeof v === "string" ? v.trim() : v;
  return out;
}

// ------------------------------------------------------------------ book covers

const PALETTES = [["#0f766e", "#134e4a"], ["#7c3aed", "#4c1d95"], ["#b45309", "#78350f"], ["#1d4ed8", "#1e3a8a"],
  ["#be185d", "#831843"], ["#15803d", "#14532d"], ["#9a3412", "#7c2d12"], ["#334155", "#0f172a"]];
export function cover(b, size = "") {
  const h = [...(b.title || "")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const [c1, c2] = PALETTES[h % PALETTES.length];
  const author = (b.authors || [])[0] || "";
  const img = b.cover_url ? `<img src="${esc(b.cover_url)}" alt="" loading="lazy">` : "";
  return raw(`<div class="cover ${size}" style="background:linear-gradient(160deg,${c1},${c2})">
    <div class="gen"><div class="gt">${esc(b.title)}</div><div class="ga">${esc(author.split(",")[0])}</div></div>${img}</div>`);
}
// CSP forbids inline handlers, so remove broken cover images via a capturing error listener instead.
document.addEventListener("error", (e) => { if (e.target.tagName === "IMG" && e.target.closest(".cover")) e.target.remove(); }, true);

export const authors = (list) => (list || []).map((a) => a.split(",").reverse().join(" ").trim()).join(", ");
export const availabilityBadge = (a) => {
  if (!a) return raw("");
  if (!a.total) return badge("withdrawn", "No copies");
  return a.available ? badge("available", `${a.available} of ${a.total} available`) : badge("on_loan", "All copies out");
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

async function appearanceDialog() {
  const t = prefs.theme || "system";
  const body = html`<div class="stack">
    <div class="field"><label>Theme</label><div class="row tight">${["system", "light", "dark", "sepia", "contrast"].map((v) =>
      raw(`<button type="button" class="chip" data-theme-pick="${v}" aria-pressed="${t === v}">${{ system: "System", light: "Light", dark: "Dark", sepia: "Sepia", contrast: "High contrast" }[v]}</button>`))}</div></div>
    <div class="field"><label>Density</label><div class="row tight">${["comfortable", "compact"].map((v) =>
      raw(`<button type="button" class="chip" data-density-pick="${v}" aria-pressed="${(prefs.density || "comfortable") === v}">${v[0].toUpperCase() + v.slice(1)}</button>`))}</div></div>
    <div class="field"><label for="fs">Text size <span class="muted" id="fs-v">${Math.round((prefs.font_scale || 1) * 100)}%</span></label>
      <input id="fs" type="range" min="0.85" max="1.4" step="0.05" value="${prefs.font_scale || 1}"></div>
    <p class="small muted">Preferences follow your account across devices when you are signed in.</p></div>`;
  const p = modal({ title: "Appearance", body, submit: "Done" });
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
const COMMANDS = [
  ...(STAFF ? [
    { group: "Go to", label: "Dashboard", hint: "Alt+1", run: () => (location.href = "/staff"), icon: "home" },
    { group: "Go to", label: "Circulation desk", hint: "Alt+2", run: () => (location.href = "/staff/circulation"), icon: "repeat" },
    { group: "Go to", label: "Catalogue", hint: "Alt+3", run: () => (location.href = "/staff/catalog"), icon: "book" },
    { group: "Go to", label: "Patrons", hint: "Alt+4", run: () => (location.href = "/staff/patrons"), icon: "users" },
    { group: "Go to", label: "Holds", hint: "Alt+5", run: () => (location.href = "/staff/holds"), icon: "bookmark" },
    { group: "Go to", label: "Acquisitions", hint: "Alt+6", run: () => (location.href = "/staff/acquisitions"), icon: "cart" },
    { group: "Go to", label: "Reports", hint: "Alt+7", run: () => (location.href = "/staff/reports"), icon: "chart" },
    { group: "Go to", label: "AI insights", hint: "Alt+8", run: () => (location.href = "/staff/insights"), icon: "sparkle" },
    { group: "Go to", label: "Administration", hint: "Alt+9", run: () => (location.href = "/staff/admin"), icon: "settings" },
    { group: "Actions", label: "New catalogue record", run: () => (location.href = "/staff/catalog/new"), icon: "plus" },
    { group: "Actions", label: "Check out items", run: () => (location.href = "/staff/circulation#checkout"), icon: "arrow-up" },
    { group: "Actions", label: "Check in items", run: () => (location.href = "/staff/circulation#checkin"), icon: "arrow-down" },
    { group: "Actions", label: "Register a patron", run: () => (location.href = "/staff/patrons#new"), icon: "user-plus" },
    { group: "Actions", label: "Ask the AI copilot", hint: "Ctrl+J", run: () => openCopilot(), icon: "sparkle" },
    { group: "Go to", label: "Public catalogue (OPAC)", run: () => (location.href = "/"), icon: "globe" },
    { group: "Go to", label: "My account & security (2FA, sessions, API tokens)", run: () => (location.href = "/staff/security"), icon: "shield" },
    { group: "Go to", label: "Roles & permissions", run: () => (location.href = "/staff/roles"), icon: "shield" },
  ] : [
    { group: "Go to", label: "Home", run: () => (location.href = "/"), icon: "home" },
    { group: "Go to", label: "My account", run: () => (location.href = "/account"), icon: "user" },
  ]),
  { group: "Preferences", label: "Appearance: theme, density & text size", run: () => appearanceDialog(), icon: "palette" },
  { group: "Preferences", label: "Toggle dark mode", run: () => applyPrefs({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }), icon: "moon" },
  { group: "Help", label: "Keyboard shortcuts", run: () => shortcutsHelp(), icon: "keyboard" },
  { group: "Help", label: "API documentation", run: () => window.open("/api/docs"), icon: "code" },
];

function shortcutsHelp() {
  modal({ title: "Keyboard shortcuts", submit: "Close", body: `<div class="stack tight">
    ${[["Ctrl/⌘ + K", "Command palette"], ["/", "Focus search"], ["Ctrl/⌘ + J", "AI copilot (staff)"], ["Alt + 1…9", "Staff sections"],
      ["F2 / F3", "Circulation: check out / check in"], ["Esc", "Close dialogs"]].map(([k, v]) => `<div class="kv"><span>${v}</span><kbd>${k}</kbd></div>`).join("")}</div>` });
}

function openPalette() {
  const d = document.createElement("dialog");
  d.className = "palette";
  d.innerHTML = `<input type="search" placeholder="Type a command, title, card number or barcode…" aria-label="Command">
    <ul role="listbox"></ul><div class="foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>`;
  document.body.append(d);
  const input = $("input", d), list = $("ul", d);
  let items = [], sel = 0;
  const dynamic = (q) => {
    if (!q) return [];
    const out = [{ group: "Search", label: `Search catalogue for “${q}”`, icon: "search",
      run: () => (location.href = STAFF ? `/staff/catalog?q=${encodeURIComponent(q)}` : `/search?q=${encodeURIComponent(q)}`) }];
    if (STAFF) {
      out.push({ group: "Search", label: `Find patron “${q}”`, icon: "users", run: () => (location.href = `/staff/patrons?q=${encodeURIComponent(q)}`) });
      out.push({ group: "Search", label: `Ask copilot: “${q}”`, icon: "sparkle", run: () => openCopilot(q) });
    }
    return out;
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const matches = COMMANDS.filter((c) => !q || q.split(/\s+/).every((w) => c.label.toLowerCase().includes(w)));
    items = [...dynamic(input.value.trim()), ...matches];
    sel = Math.min(sel, Math.max(items.length - 1, 0));
    let last = "";
    list.innerHTML = items.map((c, i) => {
      const head = c.group !== last ? `<li class="group" role="presentation">${esc(c.group)}</li>` : "";
      last = c.group;
      return `${head}<li role="option" data-i="${i}" aria-selected="${i === sel}">${icon(c.icon || "chevron").__raw}<span>${esc(c.label)}</span>${c.hint ? `<span class="hint">${esc(c.hint)}</span>` : ""}</li>`;
    }).join("") || `<li class="group">No matches</li>`;
    $(`[aria-selected="true"]`, list)?.scrollIntoView({ block: "nearest" });
  };
  const run = (i) => { const c = items[i]; d.close(); c?.run(); };
  input.addEventListener("input", () => { sel = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = (sel + 1) % items.length; render(); e.preventDefault(); }
    if (e.key === "ArrowUp") { sel = (sel - 1 + items.length) % items.length; render(); e.preventDefault(); }
    if (e.key === "Enter") { run(sel); e.preventDefault(); }
  });
  list.addEventListener("click", (e) => { const li = e.target.closest("[data-i]"); if (li) run(+li.dataset.i); });
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  render();
  d.showModal();
  input.focus();
}

// ------------------------------------------------------------------ AI copilot drawer (staff)

const chat = [];
export function openCopilot(question) {
  const drawer = $("#copilot");
  if (!drawer) return;
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
  const close = () => { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); };
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
      const tools = (r.trace || []).map((t) => t.tool.replace(/_/g, " ")).join(" · ");
      typing.outerHTML = html`<div class="msg bot">${markdown(r.answer)}<div class="trace">${r.engine === "claude" ? "Claude" : "Local AI"}${tools ? " · used: " + tools : ""}</div></div>`;
    } catch (err) {
      typing.outerHTML = html`<div class="msg bot">Sorry — ${err.message}</div>`;
    }
    body.scrollTop = body.scrollHeight;
  });
}

// ------------------------------------------------------------------ global wiring

function initShell() {
  $$("[data-open-palette]").forEach((b) => b.addEventListener("click", openPalette));
  $$("[data-appearance]").forEach((b) => b.addEventListener("click", appearanceDialog));
  $$("[data-logout]").forEach((b) => b.addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  }));
  const sidebar = $(".sidebar");
  $(".menu-toggle")?.addEventListener("click", () => sidebar?.classList.toggle("open"));
  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j" && STAFF) { e.preventDefault(); openCopilot(); }
    else if (e.key === "/" && !typing) { const s = $("[data-search-focus]"); if (s) { e.preventDefault(); s.focus(); } else if (STAFF) { e.preventDefault(); openPalette(); } }
    else if (e.altKey && /^[1-9]$/.test(e.key) && STAFF) {
      const link = $$(".sidebar .nav-link")[+e.key - 1];
      if (link) { e.preventDefault(); location.href = link.href; }
    }
  });
  initCopilot();
}

initShell();
const page = document.body.dataset.page;
if (page) {
  import(`/static/js/pages/${page}.js`)
    .then((m) => m.default?.())
    .catch((e) => { console.error(e); toast(`Could not load this page: ${e.message}`, "error"); });
}
