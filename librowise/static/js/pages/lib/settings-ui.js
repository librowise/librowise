// Shared building blocks for the Administration pages (Settings, Roles & permissions, System, Interoperability).
// Styles: /static/css/pages/admin-settings.css · strings: admin.settings.*, admin.common.* (librowise/i18n/admin-settings).
//
//   toggleSwitch({ id, name, checked, describedBy })        → <input type="checkbox" role="switch">
//   numField({ name, label, unit, value, min, max, help })  → number field with a unit suffix (same slots as ui/form field())
//   wireValidation(form, { onSubmit, validate })            → inline validation + 422 mapping for any <form>
//   editDialog({ title, body, submit, size, onSubmit })     → modal() that stays open until onSubmit succeeds
//   guardUnsaved(isDirty)                                   → one beforeunload guard for many forms
//   humanize("snake_case") · rupees(paise) · paise(rupees)
import { $, $$, html, modal, money, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { setFieldError } from "/static/js/ui/form.js";

// ------------------------------------------------------------------ formatting

/** "staff_role_assigned" → "Staff role assigned" (fallback label for values without a translation). */
export const humanize = (s) => String(s ?? "").replace(/[_-]+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());
/** Amounts are stored in paise (minor units). */
export const rupees = (p) => money(Number(p || 0) / 100);
export const paise = (v) => Math.round(Number(v || 0) * 100);
export const attrIf = (cond, name) => (cond ? ` ${name}` : "");

// ------------------------------------------------------------------ controls

export const toggleSwitch = ({ id, name, checked = false, describedBy = "", disabled = false, label = "" }) =>
  html`<input type="checkbox" role="switch" class="as-switch" id="${id}" name="${name || id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}
    ${describedBy ? html`aria-describedby="${describedBy}"` : ""} ${label ? html`aria-label="${label}"` : ""}>`;

let seq = 0;
/** Number input with a visible unit ("days", "₹") — label, help and error slot wired like ui/form field(). */
export function numField({ name, label, unit = "", value = "", min = "", max = "", step = 1, help = "", required = true, prefix = false, span = 1 }) {
  const id = `nf-${name}-${++seq}`;
  const desc = [unit ? `${id}-unit` : "", help ? `${id}-help` : "", `${id}-err`].filter(Boolean).join(" ");
  const u = unit ? html`<span class="as-unit" id="${id}-unit">${unit}</span>` : "";
  return html`<div class="field ${span === 2 ? "span-2" : ""}" data-field="${name}">
    <label for="${id}">${label}${required ? html`<span class="req" aria-hidden="true">*</span>` : ""}</label>
    <div class="as-input-unit ${prefix ? "prefix" : ""}">${prefix ? u : ""}<input type="number" id="${id}" name="${name}" value="${value}" inputmode="${step === 1 ? "numeric" : "decimal"}"
      ${min !== "" ? html`min="${min}"` : ""} ${max !== "" ? html`max="${max}"` : ""} step="${step}" ${required ? "required" : ""} aria-describedby="${desc}">${prefix ? "" : u}</div>
    ${help ? html`<div class="field-help" id="${id}-help">${help}</div>` : ""}
    <div class="field-error" id="${id}-err" hidden></div></div>`;
}

/** A switch row inside a form ("Holdable", "Account enabled" …) with label, help and an error slot. */
export function switchField({ name, label, checked = false, help = "", span = 2 }) {
  const id = `sw-${name}-${++seq}`;
  return html`<div class="field as-switch-field ${span === 2 ? "span-2" : ""}" data-field="${name}">
    <div class="as-switch-text"><label for="${id}">${label}</label>${help ? html`<div class="field-help" id="${id}-help">${help}</div>` : ""}</div>
    ${toggleSwitch({ id, name, checked, describedBy: [help ? `${id}-help` : "", `${id}-err`].filter(Boolean).join(" ") })}
    <div class="field-error" id="${id}-err" hidden></div></div>`;
}

// ------------------------------------------------------------------ validation

function nativeMessage(input) {
  const v = input.validity;
  if (v.valueMissing) return t("ui.form.required");
  if (v.typeMismatch && input.type === "email") return t("ui.form.email");
  if (v.typeMismatch) return t("ui.form.invalid");
  if (v.badInput) return t("ui.form.invalid");
  if (v.tooShort) return t("ui.form.too_short", { min: input.minLength });
  if (v.tooLong) return t("ui.form.too_long", { max: input.maxLength });
  if (v.rangeUnderflow) return t("ui.form.min", { min: input.min });
  if (v.rangeOverflow) return t("ui.form.max", { max: input.max });
  if (v.stepMismatch) return t("admin.common.whole_number");
  if (v.patternMismatch) return input.title || t("ui.form.invalid");
  return input.validationMessage || "";
}

/**
 * Inline validation for a form that is submitted by our own code (dialogs, side panels, settings sections).
 * Errors show on blur, update live once touched, and on submit the first invalid field gets focus and the
 * count is announced. `onSubmit(data, form)` may throw an ApiError; 422 `errors` are mapped onto fields.
 */
export function wireValidation(form, { onSubmit, validate = {}, live } = {}) {
  form.noValidate = true;
  const announcer = live || Object.assign(document.createElement("div"), { className: "sr-only" });
  if (!live) { announcer.setAttribute("aria-live", "assertive"); form.append(announcer); }
  const touched = new Set();
  const check = (input) => {
    if (!input.name || input.type === "hidden" || input.disabled || input.type === "submit" || input.type === "button") return true;
    let msg = input.checkValidity() ? "" : nativeMessage(input);
    if (!msg && validate[input.name]) {
      const r = validate[input.name](input.value, Object.fromEntries(new FormData(form)), input);
      if (r !== true && r) msg = r;
    }
    setFieldError(input, msg);
    return !msg;
  };
  const checkAll = () => {
    const bad = $$("input,select,textarea", form).filter((i) => !check(i));
    if (bad.length) { bad[0].focus(); announcer.textContent = t("ui.form.errors", { count: bad.length }); }
    return !bad.length;
  };
  const setErrors = (errors) => {
    let first = null;
    for (const { field: name, message } of errors) {
      const input = form.elements[String(name || "").split(".").at(-1)];
      if (input && input.nodeType === 1) { setFieldError(input, message); first ||= input; }
    }
    first?.focus();
    announcer.textContent = t("ui.form.errors", { count: errors.length });
    return !!first;
  };
  form.addEventListener("focusout", (e) => { if (e.target.name && form.contains(e.target)) { touched.add(e.target.name); check(e.target); } });
  form.addEventListener("input", (e) => { if (touched.has(e.target.name)) check(e.target); });
  const submit = async (button) => {
    if (!checkAll()) return false;
    const busy = button && !button.disabled;
    if (busy) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>'); }
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), form);
      return true;
    } catch (err) {
      // 422s whose errors map onto fields stay inline; everything else is toasted.
      if (!(err?.status === 422 && Array.isArray(err.data?.errors) && setErrors(err.data.errors))) toast(err?.message || String(err), "error");
      return false;
    } finally {
      if (busy) { button.querySelector(":scope > .spinner")?.remove(); button.disabled = false; button.removeAttribute("aria-busy"); }
    }
  };
  return { check: checkAll, setErrors, submit };
}

/**
 * modal() that keeps the dialog open until `onSubmit(data, form)` resolves (errors stay inline / toasted).
 * Resolves with onSubmit's result, or null when cancelled.
 */
export function editDialog({ title, body, submit, size = "md", danger = false, onSubmit, validate, onOpen }) {
  let result = null;
  const done = modal({ title, body, submit, size, danger });
  const dlg = $$("dialog").at(-1);
  const form = $("form", dlg);
  const primary = $("[data-primary]", dlg);
  const v = wireValidation(form, { validate, onSubmit: async (data, f) => { result = await onSubmit(data, f); } });
  dlg.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.submitter && e.submitter !== primary) return;
    if (await v.submit(primary)) dlg.close("ok");
  }, true);
  onOpen?.(dlg);
  return done.then(() => result);
}

// ------------------------------------------------------------------ unsaved changes

const dirtyChecks = new Set();
let guarded = false;
/** Register an `isDirty()` function; leaving the page asks first while any of them returns true. */
export function guardUnsaved(isDirty) {
  dirtyChecks.add(isDirty);
  if (!guarded) {
    guarded = true;
    window.addEventListener("beforeunload", (e) => {
      if ([...dirtyChecks].some((f) => f())) { e.preventDefault(); e.returnValue = ""; }
    });
  }
  return () => dirtyChecks.delete(isDirty);
}
export const anyDirty = () => [...dirtyChecks].some((f) => f());
