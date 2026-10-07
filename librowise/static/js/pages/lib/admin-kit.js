// Shared helpers for the staff People, Insights and Administration page families.
// Styles: /static/css/pages/admin.css (include it from the page template's head_extra block).
// Strings: admin.kit.* in librowise/i18n/admin/<lang>.json.
//
//   pill("success", t("…"))                       → status pill with dot + text (same look as statusPill)
//   rowMenu({ label: name, items: [{ id: "edit", label, icon: "edit" }, { id: "delete", label, icon: "trash", danger: true }] })
//     → "More actions" button; choosing an item dispatches a bubbling `rowmenu` CustomEvent from the trigger
//       ({ detail: { action } }); read the row from e.target.closest("[data-key]"). Danger items are separated.
//   dl([[label, value], …], { cols: 2 })          → <dl class="lw-dl"> facts list
//   copyButton(text, { label })                    → copy-to-clipboard button (toast on success)
//   bytes(n) · duration(seconds) · cronText("0 2 * * *") · jobLabel("ai_warmup") · jobDescription(type)
import { $$, html, icon, raw, toast } from "/static/js/core.js";
import { locale, t } from "/static/js/i18n.js";

// ------------------------------------------------------------------ pills

/** A status pill for values that are not in ui/status.js STATUS (tones: success · warning · danger · info · neutral · ai). */
export const pill = (tone, label, { dot = true, title = "" } = {}) =>
  html`<span class="badge pill ${tone || "neutral"}" ${title ? html`title="${title}"` : ""}>${dot ? raw('<span class="dot" aria-hidden="true"></span>') : ""}${label}</span>`;

// ------------------------------------------------------------------ facts list

/** Definition list of [label, value] pairs. Values may be html``; null/""/undefined render as an em dash. */
export function dl(pairs, { cols = 1, className = "" } = {}) {
  return html`<dl class="lw-dl ${cols > 1 ? `cols-${cols}` : ""} ${className}">${pairs.filter(Boolean).map(([k, v]) =>
    html`<div class="lw-dl-row"><dt>${k}</dt><dd>${v === null || v === undefined || v === "" ? html`<span class="muted">—</span>` : v}</dd></div>`)}</dl>`;
}

// ------------------------------------------------------------------ formatting

const unitFmt = (unit, n, display = "short") => {
  try { return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: display, maximumFractionDigits: n < 10 && unit !== "byte" ? 1 : 0 }).format(n); }
  catch { return `${n} ${unit}`; }
};

/** 1536 → "1.5 kB" (localised). */
export function bytes(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return unitFmt(units[i], i ? v : Math.round(v));
}

/** Seconds → "45 sec" / "12 min" / "3.5 hr" / "2 days" (localised, rounded for humans). */
export function duration(seconds, display = "short") {
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.max(0, Number(seconds));
  if (s < 90) return unitFmt("second", Math.round(s), display);
  if (s < 90 * 60) return unitFmt("minute", Math.round(s / 60), display);
  if (s < 36 * 3600) return unitFmt("hour", Math.round((s / 3600) * 10) / 10, display);
  return unitFmt("day", Math.round((s / 86400) * 10) / 10, display);
}

const pad2 = (n) => String(n).padStart(2, "0");
const timeOf = (h, m) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(2026, 0, 1, h, m));
const weekdayName = (d) => new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(2023, 0, 1 + (Number(d) % 7))); // 2023-01-01 = Sunday
const listFmt = (items) => { try { return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items); } catch { return items.join(", "); } };
const isNum = (s) => /^\d+$/.test(s);

/**
 * Humanise a five-field cron expression ("0 2 * * *" → "Every day at 02:00"). Uncommon expressions return
 * "Custom schedule"; the raw expression is never the primary text (pass it as a tooltip if useful).
 */
export function cronText(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) return t("admin.kit.cron.custom");
  const [mi, hr, dom, mon, dow] = f;
  if (f.every((x) => x === "*")) return t("admin.kit.cron.every_minute");
  const everyN = (s) => (s.match(/^\*\/(\d+)$/) || [])[1];
  if (everyN(mi) && hr === "*" && dom === "*" && mon === "*" && dow === "*") return t("admin.kit.cron.every_n_minutes", { count: Number(everyN(mi)) });
  if (isNum(mi) && hr === "*" && dom === "*" && mon === "*" && dow === "*") return t("admin.kit.cron.hourly_at", { minute: pad2(mi) });
  if (isNum(mi) && everyN(hr) && dom === "*" && mon === "*" && dow === "*") return t("admin.kit.cron.every_n_hours", { count: Number(everyN(hr)), minute: pad2(mi) });
  if (!isNum(mi) || !(isNum(hr) || /^\d+(,\d+)+$/.test(hr)) || mon !== "*") return t("admin.kit.cron.custom");
  const time = listFmt(hr.split(",").map((h) => timeOf(Number(h), Number(mi))));
  if (dom === "*" && dow === "*") return t("admin.kit.cron.daily", { time });
  if (dom === "*" && (dow === "1-5" || dow === "MON-FRI")) return t("admin.kit.cron.weekdays", { time });
  if (dom === "*" && (dow === "0,6" || dow === "6,0" || dow === "6,7")) return t("admin.kit.cron.weekends", { time });
  if (dom === "*" && /^\d(,\d)*$/.test(dow)) return t("admin.kit.cron.weekly", { days: listFmt(dow.split(",").map(weekdayName)), time });
  if (isNum(dom) && dow === "*") return t("admin.kit.cron.monthly", { day: Number(dom), time });
  return t("admin.kit.cron.custom");
}

// ------------------------------------------------------------------ background job names

const JOBS = ["nightly", "reindex", "ai_warmup", "deliver_notices", "backup", "maintenance"];
/** Human name of a job type ("ai_warmup" → "Warm up the AI search index"); unknown types are de-snaked. */
export const jobLabel = (type) => (JOBS.includes(type) ? t(`admin.kit.job.${type}`) : String(type || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
export const jobDescription = (type, fallback = "") => (JOBS.includes(type) ? t(`admin.kit.job_desc.${type}`) : fallback);

// ------------------------------------------------------------------ copy to clipboard

export const copyButton = (text, { label = t("admin.kit.copy"), iconOnly = true } = {}) =>
  html`<button type="button" class="btn sm ghost ${iconOnly ? "icon-only" : ""}" data-copy="${text}" aria-label="${label}" data-tip="${label}">${icon("copy")}${iconOnly ? "" : html`<span>${label}</span>`}</button>`;

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;inset-block-start:-1000px;opacity:0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

// ------------------------------------------------------------------ row action menu

let menuSeq = 0;
/**
 * A compact "More actions" menu for a table row or card. Items: { id, label, icon, danger, href, disabled }.
 * Links navigate; buttons dispatch `rowmenu` (bubbles) from the trigger with detail.action = id.
 */
export function rowMenu({ label, items }) {
  const list = items.filter((i) => i && !i.hidden);
  if (!list.length) return "";
  const id = `lw-rm-${++menuSeq}`;
  const safe = list.filter((i) => !i.danger), danger = list.filter((i) => i.danger);
  const item = (i) => (i.href
    ? html`<a role="menuitem" href="${i.href}" ${i.external ? raw('target="_blank" rel="noopener"') : ""}>${i.icon ? icon(i.icon) : ""}<span>${i.label}</span></a>`
    : html`<button type="button" role="menuitem" class="${i.danger ? "danger" : ""}" data-menu-action="${i.id}" ${i.disabled ? "disabled" : ""}>${i.icon ? icon(i.icon) : ""}<span>${i.label}</span></button>`);
  return html`<span class="lw-rowmenu"><button type="button" class="btn sm ghost icon-only" data-rowmenu aria-haspopup="menu" aria-expanded="false" aria-controls="${id}"
      aria-label="${t("admin.kit.more_actions_for", { name: label })}" data-tip="${t("admin.kit.more_actions")}">${icon("more")}</button>
    <div class="menu popover lw-floating" id="${id}" role="menu" aria-label="${t("admin.kit.more_actions_for", { name: label })}" hidden>
      ${safe.map(item)}${safe.length && danger.length ? raw('<hr role="separator">') : ""}${danger.map(item)}</div></span>`;
}

let open = null; // { trigger, panel }
const items = () => (open ? [...open.panel.querySelectorAll('[role="menuitem"]:not([disabled])')] : []);

function place(trigger, panel) {
  const r = trigger.getBoundingClientRect();
  const rtl = getComputedStyle(trigger).direction === "rtl";
  const w = panel.offsetWidth, h = panel.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  let left = rtl ? r.left : r.right - w;
  left = Math.max(8, Math.min(left, vw - w - 8));
  let top = r.bottom + 4;
  if (top + h > vh - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function closeMenu(restore = true) {
  if (!open) return;
  const { trigger, panel } = open;
  open = null;
  panel.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  if (trigger.isConnected) trigger.after(panel); else panel.remove();
  if (restore && trigger.isConnected) trigger.focus();
}

function openMenu(trigger) {
  closeMenu(false);
  const panel = trigger.nextElementSibling;
  if (!panel || panel.getAttribute("role") !== "menu") return;
  document.body.append(panel); // portal: escapes scroll containers and card overflow
  panel.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  open = { trigger, panel };
  place(trigger, panel);
  requestAnimationFrame(() => items()[0]?.focus());
}

let wired = false;
/** Install the (document-level, idempotent) behaviour for rowMenu() and copyButton(). Call once per page. */
export function wireKit() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", async (e) => {
    const trig = e.target.closest("[data-rowmenu]");
    if (trig) { if (open?.trigger === trig) closeMenu(); else openMenu(trig); return; }
    const act = e.target.closest("[data-menu-action]");
    if (act && open && open.panel.contains(act)) {
      const { trigger } = open;
      closeMenu(true); // focus returns to the trigger, so dialogs opened by the action restore focus there
      trigger.dispatchEvent(new CustomEvent("rowmenu", { bubbles: true, detail: { action: act.dataset.menuAction } }));
      return;
    }
    if (open && e.target.closest('[role="menuitem"]') && open.panel.contains(e.target)) { closeMenu(false); return; }
    const copy = e.target.closest("[data-copy]");
    if (copy) toast(await copyText(copy.dataset.copy) ? t("admin.kit.copied") : t("admin.kit.copy_failed"), "success", 2200);
  });
  document.addEventListener("pointerdown", (e) => {
    if (open && !open.panel.contains(e.target) && !open.trigger.contains(e.target)) closeMenu(false);
  }, true);
  document.addEventListener("keydown", (e) => {
    const trig = e.target.closest?.("[data-rowmenu]");
    if (trig && (e.key === "ArrowDown" || e.key === "ArrowUp") && !open) { e.preventDefault(); openMenu(trig); return; }
    if (!open || !open.panel.contains(e.target)) return;
    const list = items(), i = list.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
    else if (e.key === "Tab") closeMenu(false);
    else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list.at(-1)?.focus(); }
  });
  const dismiss = () => closeMenu(false);
  window.addEventListener("resize", dismiss);
  document.addEventListener("scroll", (e) => { if (open && !open.panel.contains(e.target)) dismiss(); }, true);
}

/** Close any open row menu (e.g. before re-rendering a table). */
export const closeRowMenus = () => closeMenu(false);

/** Convenience: all rowMenu triggers inside `root` (useful in tests). */
export const rowMenuTriggers = (root = document) => $$("[data-rowmenu]", root);
