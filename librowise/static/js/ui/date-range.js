// Date & date-range picker built on native <input type="date"> (accessible, localised by the browser,
// mobile-friendly), with quick presets and validation (end ≥ start, optional max span).
//
//   el.innerHTML = dateRange({ name: "period", label: "Period", start: "2026-09-01", end: "2026-09-30",
//                              presets: ["today", "7d", "30d", "month", "year"], max: today });
//   wireDateRange(el, ({ start, end }) => reload(start, end));
//   datePicker({ name: "due", label: "Due date", value, min, max })   → single date field
import { $, $$, html } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export function presetRange(id, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n);
  switch (id) {
    case "today": return { start: iso(d), end: iso(d) };
    case "7d": return { start: iso(back(6)), end: iso(d) };
    case "30d": return { start: iso(back(29)), end: iso(d) };
    case "90d": return { start: iso(back(89)), end: iso(d) };
    case "month": return { start: iso(new Date(d.getFullYear(), d.getMonth(), 1)), end: iso(d) };
    case "last_month": return { start: iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), end: iso(new Date(d.getFullYear(), d.getMonth(), 0)) };
    case "year": return { start: iso(new Date(d.getFullYear(), 0, 1)), end: iso(d) };
    default: return null;
  }
}

let seq = 0;
export function datePicker({ name, label, value = "", min = "", max = "", required = false, help = "" }) {
  const id = `dp-${name}-${++seq}`;
  return html`<div class="field"><label for="${id}">${label}</label>
    <input type="date" id="${id}" name="${name}" value="${value}" ${min ? html`min="${min}"` : ""} ${max ? html`max="${max}"` : ""} ${required ? "required" : ""} ${help ? html`aria-describedby="${id}-h"` : ""}>
    ${help ? html`<div class="field-help" id="${id}-h">${help}</div>` : ""}</div>`;
}

export function dateRange({ name = "range", label, start = "", end = "", min = "", max = "", presets = ["7d", "30d", "month", "year"] }) {
  const id = `dr-${name}-${++seq}`;
  return html`<fieldset class="date-range" data-date-range="${name}" style="border:0;padding:0;margin:0">
    <legend class="sr-only">${label}</legend>
    ${presets.length ? html`<div class="date-presets segmented" role="group" aria-label="${t("ui.date.presets")}">${presets.map((p) => html`<button type="button" data-preset="${p}" aria-pressed="false">${t(`ui.date.preset_${p}`)}</button>`)}</div>` : ""}
    <label class="sr-only" for="${id}-s">${t("ui.date.from")}</label>
    <input type="date" id="${id}-s" data-start value="${start}" ${min ? html`min="${min}"` : ""} ${max ? html`max="${max}"` : ""}>
    <span class="sep" aria-hidden="true">–</span>
    <label class="sr-only" for="${id}-e">${t("ui.date.to")}</label>
    <input type="date" id="${id}-e" data-end value="${end}" ${min ? html`min="${min}"` : ""} ${max ? html`max="${max}"` : ""}>
    <div class="field-error date-error" role="alert" hidden></div>
  </fieldset>`;
}

export function wireDateRange(root, onChange, { maxDays = 0 } = {}) {
  const box = root.matches?.("[data-date-range]") ? root : $("[data-date-range]", root);
  const s = $("[data-start]", box), e = $("[data-end]", box), err = $(".date-error", box);
  const sync = () => {
    $$("[data-preset]", box).forEach((b) => { const r = presetRange(b.dataset.preset); b.setAttribute("aria-pressed", String(!!r && r.start === s.value && r.end === e.value)); });
    e.min = s.value || e.getAttribute("min") || "";
  };
  const emit = () => {
    let msg = "";
    if (s.value && e.value && e.value < s.value) msg = t("ui.date.end_before_start");
    else if (maxDays && s.value && e.value && (new Date(e.value) - new Date(s.value)) / 86400000 > maxDays) msg = t("ui.date.too_long", { days: maxDays });
    err.hidden = !msg;
    err.textContent = msg;
    [s, e].forEach((i) => (msg ? i.setAttribute("aria-invalid", "true") : i.removeAttribute("aria-invalid")));
    sync();
    if (!msg) onChange({ start: s.value, end: e.value });
  };
  box.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-preset]");
    if (!b) return;
    const r = presetRange(b.dataset.preset);
    s.value = r.start; e.value = r.end;
    emit();
  });
  s.addEventListener("change", emit);
  e.addEventListener("change", emit);
  sync();
  return { get: () => ({ start: s.value, end: e.value }) };
}
