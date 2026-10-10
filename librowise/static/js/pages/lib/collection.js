// Shared helpers for the Collection pages (catalogue record, editor, MARC, authorities, copy cataloguing,
// labels, batch, acquisitions, serials, course reserves). Styles: /static/css/pages/collection.css.
//
//   fmtLabel("ebook") → "E-book"   langName("hi") → "Hindi"   audienceLabel("young_adult") → "Young adult"
//   actionMenu({ label, items: [{ id, label, icon, href, danger, separator }] }) + wireMenus(root, onAction)
//   formModal(opts, action, setup) → modal that stays open until action() succeeds
//   meter({ segments: [{ value, tone, label }], max, label }) → stacked, labelled budget meter
import { $, $$, api, html, icon, modal, money, num, withBusy } from "/static/js/core.js";
import { locale, t } from "/static/js/i18n.js";
import { popover } from "/static/js/ui/menu.js";

// ------------------------------------------------------------------ humanised values

export const fmtLabel = (m) => (m ? t(`format.${m}`, {}, String(m).replace(/_/g, " ")) : "—");
export const audienceLabel = (a) => (a ? t(`coll.audience.${a}`, {}, String(a).replace(/_/g, " ")) : "—");

let langNames = null;
try { langNames = new Intl.DisplayNames([locale], { type: "language" }); } catch { /* old browser */ }
/** Human language name for an ISO 639 code ("en" → "English"), in the UI language. */
export function langName(code) {
  if (!code) return "—";
  const known = t(`lang.${code}`, {}, "");
  if (known && known !== `lang.${code}`) return known;
  try { return langNames?.of(code) || code; } catch { return code; }
}
/** Languages offered in the record editor (ISO 639-1/2 codes), sorted by their name in the UI language. */
export const LANGUAGES = ["en", "hi", "ur", "bn", "ta", "te", "mr", "gu", "kn", "ml", "pa", "or", "as", "sa", "ne", "si",
  "ar", "fa", "fr", "de", "es", "pt", "it", "ru", "zh", "ja", "ko", "la", "el", "he", "tr", "nl", "sv", "pl", "sw"];
export const languageOptions = (current) => {
  const codes = current && !LANGUAGES.includes(current) ? [...LANGUAGES, current] : LANGUAGES;
  return codes.map((c) => [c, langName(c)]).sort((a, b) => a[1].localeCompare(b[1], locale));
};

/** "#12" style reference that reads well in every language. */
export const recNo = (id) => t("coll.common.record_no", { id: String(id) });

/** Plural-aware count label: count("item", 3) → "3 items" (coll.count.<key>). */
export const count = (key, n) => t(`coll.count.${key}`, { count: n, n: num(n) });

// ------------------------------------------------------------------ overflow / row action menus

let menuSeq = 0;
/**
 * A "⋯" (or labelled) button with a WAI-ARIA menu. Items: { id, label, icon, href, danger, separator, disabled }.
 * Destructive items are listed last after a separator and styled as danger. Wire with wireMenus().
 */
export function actionMenu({ label = t("coll.common.more_actions"), text = "", items, size = "", align = "end", data = "" }) {
  const id = `cm-${++menuSeq}`;
  const list = items.filter(Boolean);
  return html`<div class="coll-menu ${align === "start" ? "align-start" : ""}">
    <button type="button" class="btn ${size} ${text ? "" : "icon-only"} ${text ? "" : "ghost"}" data-menu-trigger-coll aria-haspopup="menu" aria-expanded="false"
      aria-controls="${id}" ${text ? "" : html`aria-label="${label}" data-tip="${label}"`} ${data ? html`data-menu-for="${data}"` : ""}>${icon("more")}${text ? html`<span>${text}</span>` : ""}</button>
    <div class="menu popover" role="menu" id="${id}" aria-label="${label}" hidden>
      ${list.map((it) => (it.separator ? html`<hr role="separator">`
        : it.href ? html`<a role="menuitem" href="${it.href}" class="${it.danger ? "danger" : ""}" ${it.download ? "download" : ""} ${it.newTab ? html`target="_blank" rel="noopener"` : ""}>${it.icon ? icon(it.icon) : ""}<span>${it.label}</span></a>`
          : html`<button type="button" role="menuitem" class="${it.danger ? "danger" : ""}" data-menu-action="${it.id}" ${data ? html`data-for="${data}"` : ""} ${it.disabled ? "disabled" : ""}>${it.icon ? icon(it.icon) : ""}<span>${it.label}</span></button>`))}
    </div></div>`;
}

/** Wire every not-yet-wired action menu inside `root`; `onAction(id, button, forKey)` runs for button items. */
export function wireMenus(root, onAction) {
  $$("[data-menu-trigger-coll]", root).forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    const panel = document.getElementById(btn.getAttribute("aria-controls"));
    if (!panel) return;
    popover(btn, panel, { menu: true });
    panel.addEventListener("click", (e) => {
      const it = e.target.closest("[data-menu-action]");
      if (it && !it.disabled) onAction?.(it.dataset.menuAction, btn, it.dataset.for);
    });
  });
}

// ------------------------------------------------------------------ dialogs

/** Modal form that stays open until `action(FormData, dialog)` resolves (errors are toasted). Resolves to the
 *  result, or null when cancelled. An input that handles Enter itself should stopPropagation() so the dialog
 *  does not submit. */
export function formModal(opts, action, setup) {
  let result = null;
  const done = modal(opts);
  const dlg = $$("dialog").at(-1);
  const form = $("form", dlg);
  const ok = $('button[value="ok"]', dlg);
  form.addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter !== ok) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!form.checkValidity()) { const bad = form.querySelector(":invalid"); bad?.setAttribute("aria-invalid", "true"); form.reportValidity(); return; }
    try {
      result = await withBusy(ok, () => action(new FormData(form), dlg));
      dlg.returnValue = "ok";
      dlg.close("ok");
    } catch { /* toasted by withBusy */ }
  }, true);
  setup?.(dlg);
  return done.then(() => result);
}

// ------------------------------------------------------------------ small components

/** Description list from [[label, value], …]; empty values are skipped. */
export const facts = (rows, cls = "") => html`<dl class="facts ${cls}">${rows.filter(([, v]) => v !== null && v !== undefined && v !== "")
  .map(([k, v]) => html`<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;

/** Stacked meter: segments [{ value, tone, label }] of `max`. Accessible as a progressbar with a text summary. */
export function meter({ segments, max, label, valueText }) {
  const total = segments.reduce((a, s) => a + Number(s.value || 0), 0);
  const pct = (v) => (max > 0 ? Math.max(0, Math.min(100, (100 * v) / max)) : 0);
  const over = max > 0 && total > max;
  return html`<div class="coll-meter ${over ? "over" : ""}" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${max}"
    aria-valuenow="${Math.min(total, max)}" aria-valuetext="${valueText || `${Math.round(pct(total))}%`}">
    ${segments.filter((s) => Number(s.value) > 0).map((s) => html`<span class="seg tone-${s.tone}" style="inline-size:${pct(s.value)}%" title="${s.label}"></span>`)}</div>`;
}

export const moneyOrDash = (v) => (v === null || v === undefined ? "—" : money(v));
export const paise = (rupees) => Math.round(Number(rupees || 0) * 100);
export const str = (fd, k) => String(fd.get(k) ?? "").trim();
export const optInt = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v));
/** Local calendar date as YYYY-MM-DD (for <input type=date> defaults). */
export const isoDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Lazily cached GET (lookups, vendors…) shared by a page's modules. */
const cache = new Map();
export const cached = (path) => {
  if (!cache.has(path)) cache.set(path, api(path).catch((e) => { cache.delete(path); throw e; }));
  return cache.get(path);
};
export const invalidate = (path) => cache.delete(path);

/** Inline alert used for page-level failures (toasts are for background actions). */
export const alertBox = (msg, tone = "bad") => html`<div class="alert ${tone}" role="${tone === "bad" ? "alert" : "status"}">${icon(tone === "bad" ? "alert" : "info")}<div>${msg}</div></div>`;
