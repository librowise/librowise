// Small UI helpers for the front-desk pages.
//
// rowMenu(trigger, items) — a row's actions in one overflow menu ("⋯"), so tables show one calm control per row
// instead of three differently styled buttons. The menu is fixed-positioned on <body>, so scrolling table
// containers can't clip it. WAI-ARIA menu keys: ↑/↓, Home/End, typeahead, Esc (focus returns to the trigger).
// Destructive items ({ danger: true }) are separated by a rule and drawn in red.
//
//   rowMenu(btn, [{ label: "Suspend", icon: "clock", run }, { label: "Cancel hold", icon: "x", danger: true, run }])
import { date, html, icon, money } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

/** Translate a structured block / warning from the circulation API ({ code, message, params }) into the UI
 *  language — never a raw code; the server's English text is the fallback for codes this build doesn't know. */
export function reasonText(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  const p = { ...(r.params || {}) };
  if (p.date) p.date = date(p.date);
  if (p.amount !== undefined) p.amount = money(p.amount);
  if (p.limit !== undefined) p.limit = money(p.limit);
  if (p.status) p.status = t(`status.${p.status}`, {}, p.status);
  if (r.code === "renew_limit" && !Number(p.max)) return t("desk.reason.renew_none");
  if (r.code === "overridden") return t("desk.reason.overridden", { reason: reasonText({ code: p.reason, params: r.params, message: r.message }) });
  return r.code ? t(`desk.reason.${r.code}`, p, r.message) : r.message;
}

let current = null;

export function closeRowMenu(restore = true) {
  if (!current) return;
  const { el, trigger, cleanup } = current;
  current = null;
  cleanup();
  el.remove();
  trigger.setAttribute("aria-expanded", "false");
  if (restore && trigger.isConnected) trigger.focus();
}

export function rowMenu(trigger, items) {
  if (current?.trigger === trigger) { closeRowMenu(); return; }
  closeRowMenu(false);
  const safe = items.filter((i) => i && !i.danger), danger = items.filter((i) => i && i.danger);
  const el = document.createElement("div");
  el.className = "popover menu desk-rowmenu";
  el.setAttribute("role", "menu");
  if (trigger.getAttribute("aria-label")) el.setAttribute("aria-label", trigger.getAttribute("aria-label"));
  const item = (it, i) => html`<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? "is-danger" : ""}" ${it.disabled ? "disabled" : ""}>${it.icon ? icon(it.icon) : ""}<span>${it.label}</span></button>`;
  const all = [...safe, ...danger];
  el.innerHTML = html`${safe.map((it) => item(it, all.indexOf(it)))}${safe.length && danger.length ? html`<hr role="separator">` : ""}${danger.map((it) => item(it, all.indexOf(it)))}`;
  document.body.append(el);
  // position: below the trigger, aligned to its inline end; flip up when there is no room
  const r = trigger.getBoundingClientRect();
  const rtl = document.documentElement.dir === "rtl";
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = rtl ? r.left : r.right - w;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  Object.assign(el.style, { position: "fixed", left: `${left}px`, top: `${top}px`, insetInlineEnd: "auto" });
  const buttons = () => [...el.querySelectorAll("[role=menuitem]:not([disabled])")];
  const onKey = (e) => {
    const list = buttons(), i = list.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); closeRowMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); (e.key === "Home" ? list[0] : list.at(-1))?.focus(); }
    else if (e.key === "Tab") closeRowMenu(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      [...list.slice(i + 1), ...list.slice(0, i + 1)].find((b) => b.textContent.trim().toLowerCase().startsWith(k))?.focus();
    }
  };
  const onClick = (e) => {
    const b = e.target.closest("[role=menuitem]");
    if (!b) return;
    const it = all[Number(b.dataset.i)];
    closeRowMenu();
    it.run?.();
  };
  const outside = (e) => { if (!el.contains(e.target) && !trigger.contains(e.target)) closeRowMenu(false); };
  const onScroll = () => closeRowMenu(false);
  el.addEventListener("keydown", onKey);
  el.addEventListener("click", onClick);
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", onScroll);
  document.addEventListener("scroll", onScroll, true);
  current = { el, trigger, cleanup: () => {
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", onScroll);
    document.removeEventListener("scroll", onScroll, true);
  } };
  trigger.setAttribute("aria-expanded", "true");
  buttons()[0]?.focus();
}

/** The ⋯ trigger for a row menu (aria-haspopup, labelled with what it acts on). */
export const menuTrigger = (attrs, label) => html`<button type="button" class="btn sm ghost icon-only row-menu-btn" aria-haspopup="menu" aria-expanded="false"
  aria-label="${label}" data-tip="${label}" ${attrs}>${icon("more")}</button>`;
