// Form system: consistent fields, inline validation announced to screen readers, sections and a sticky
// save bar that guards against losing unsaved changes.
//
//   form.innerHTML = html`
//     ${formSection({ title: "Contact", description: "How we reach the patron.", body: html`<div class="form-grid">
//       ${field({ name: "email", label: "Email", type: "email", help: "Used for notices", required: true })}
//       ${field({ name: "notes", label: "Notes", as: "textarea", span: 2 })}</div>` })}
//     ${saveBar()}`;
//   const f = enhanceForm(form, { onSubmit: async (data) => api(...), validate: { email: (v) => v.includes("@") || "…" } });
//
// Errors: each field gets an id'd error slot wired via aria-describedby + aria-invalid; on submit the
// first invalid field is focused and a polite summary is announced. Server errors (422 with `errors`
// [{field, message}]) are mapped back onto the fields with setErrors().
import { $, $$, html, icon, raw, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

let seq = 0;

export function field({ name, label, type = "text", value = "", help = "", required = false, as = "input", options = [],
  placeholder = "", span = 1, attrs = "", optional = false, id } = {}) {
  const fid = id || `f-${name}-${++seq}`;
  const describedBy = [help ? `${fid}-help` : "", `${fid}-err`].filter(Boolean).join(" ");
  const common = html`id="${fid}" name="${name}" ${required ? raw("required") : ""} aria-describedby="${describedBy}" ${placeholder ? html`placeholder="${placeholder}"` : ""} ${raw(attrs)}`;
  let control;
  if (as === "textarea") control = html`<textarea ${common}>${value}</textarea>`;
  else if (as === "select") control = html`<select ${common}>${options.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value) ? "selected" : ""}>${l}</option>`)}</select>`;
  else if (type === "checkbox") return html`<div class="field ${span === 2 ? "span-2" : ""}"><label class="checkbox"><input type="checkbox" ${common} ${value ? "checked" : ""}> ${label}</label>
    ${help ? html`<div class="field-help" id="${fid}-help">${help}</div>` : ""}<div class="field-error" id="${fid}-err" hidden></div></div>`;
  else control = html`<input type="${type}" value="${value}" ${common}>`;
  return html`<div class="field ${span === 2 ? "span-2" : ""}" data-field="${name}">
    <label for="${fid}">${label}${required ? html`<span class="req" aria-hidden="true">*</span>` : ""}${optional ? html`<span class="optional">${t("ui.form.optional")}</span>` : ""}</label>
    ${control}
    ${help ? html`<div class="field-help" id="${fid}-help">${help}</div>` : ""}
    <div class="field-error" id="${fid}-err" hidden></div>
  </div>`;
}

export function formSection({ title, description = "", body }) {
  return html`<section class="form-section"><header><h2>${title}</h2>${description ? html`<p>${description}</p>` : ""}</header><div>${body}</div></section>`;
}

export function saveBar({ submit = t("common.save"), cancel = t("common.cancel"), cancelHref = "" } = {}) {
  return html`<div class="save-bar" data-save-bar>
    <span class="save-status" data-save-status aria-live="polite">${t("ui.form.no_changes")}</span>
    ${cancelHref ? html`<a class="btn" href="${cancelHref}">${cancel}</a>` : html`<button type="reset" class="btn">${cancel}</button>`}
    <button type="submit" class="btn primary">${icon("check")}${submit}</button></div>`;
}

function errorSlot(input) {
  const ids = (input.getAttribute("aria-describedby") || "").split(/\s+/);
  return ids.map((x) => document.getElementById(x)).find((n) => n?.classList.contains("field-error"));
}

export function setFieldError(input, message) {
  const slot = errorSlot(input);
  const wrap = input.closest(".field");
  if (message) {
    input.setAttribute("aria-invalid", "true");
    wrap?.classList.add("has-error");
    if (slot) { slot.hidden = false; slot.innerHTML = html`${icon("alert")}<span>${message}</span>`; }
  } else {
    input.removeAttribute("aria-invalid");
    wrap?.classList.remove("has-error");
    if (slot) { slot.hidden = true; slot.textContent = ""; }
  }
}

function nativeMessage(input) {
  const v = input.validity;
  if (v.valueMissing) return t("ui.form.required");
  if (v.typeMismatch && input.type === "email") return t("ui.form.email");
  if (v.typeMismatch) return t("ui.form.invalid");
  if (v.tooShort) return t("ui.form.too_short", { min: input.minLength });
  if (v.tooLong) return t("ui.form.too_long", { max: input.maxLength });
  if (v.rangeUnderflow) return t("ui.form.min", { min: input.min });
  if (v.rangeOverflow) return t("ui.form.max", { max: input.max });
  if (v.patternMismatch) return input.title || t("ui.form.invalid");
  return input.validationMessage || "";
}

/**
 * Progressive enhancement for a <form>: inline validation (on blur, then live once a field has been
 * touched), unsaved-changes guard (beforeunload + in-page link clicks), sticky save bar status, and
 * busy state while `onSubmit(data, form)` runs. Returns { setErrors, reset, isDirty, markClean }.
 */
export function enhanceForm(form, { onSubmit, validate = {}, guard = true } = {}) {
  form.noValidate = true;
  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("aria-live", "assertive");
  form.append(live);
  const status = $("[data-save-status]", form), bar = $("[data-save-bar]", form);
  const snapshot = () => JSON.stringify([...new FormData(form)].map(([k, v]) => [k, typeof v === "string" ? v : v.name]));
  let clean = snapshot();
  const touched = new Set();

  const check = (input) => {
    if (!input.name || input.type === "hidden" || input.disabled) return true;
    let msg = input.checkValidity() ? "" : nativeMessage(input);
    if (!msg && validate[input.name]) {
      const r = validate[input.name](input.value, Object.fromEntries(new FormData(form)));
      if (r !== true && r) msg = r;
    }
    setFieldError(input, msg);
    return !msg;
  };
  const isDirty = () => snapshot() !== clean;
  const refresh = () => {
    const dirty = isDirty();
    bar?.classList.toggle("dirty", dirty);
    if (status) status.innerHTML = dirty ? html`<span class="dot" aria-hidden="true"></span>${t("ui.form.unsaved")}` : t("ui.form.no_changes");
  };

  form.addEventListener("focusout", (e) => { if (e.target.name) { touched.add(e.target.name); check(e.target); } });
  form.addEventListener("input", (e) => { if (touched.has(e.target.name)) check(e.target); refresh(); });
  form.addEventListener("change", refresh);
  form.addEventListener("reset", () => setTimeout(() => { $$("[aria-invalid]", form).forEach((i) => setFieldError(i, "")); touched.clear(); refresh(); }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const inputs = $$("input,select,textarea", form);
    const bad = inputs.filter((i) => !check(i));
    if (bad.length) {
      bad[0].focus();
      live.textContent = t("ui.form.errors", { count: bad.length });
      return;
    }
    const btn = e.submitter || $('[type="submit"]', form);
    btn?.setAttribute("aria-busy", "true");
    if (btn) btn.disabled = true;
    try {
      await onSubmit?.(Object.fromEntries(new FormData(form)), form);
      clean = snapshot();
      refresh();
      if (status) status.textContent = t("ui.form.saved");
    } catch (err) {
      if (err?.data?.errors?.length) api.setErrors(err.data.errors);
      else toast(err.message || String(err), "error");
    } finally {
      btn?.removeAttribute("aria-busy");
      if (btn) btn.disabled = false;
    }
  });

  if (guard) {
    window.addEventListener("beforeunload", (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } });
    document.addEventListener("click", (e) => {
      const a = e.target.closest("a[href]");
      if (!a || a.target === "_blank" || e.defaultPrevented || !isDirty()) return;
      const url = new URL(a.href, location.href);
      if (url.pathname === location.pathname && url.search === location.search && url.hash) return; // in-page anchor
      // eslint-disable-next-line no-alert
      if (!window.confirm(t("ui.form.leave_confirm"))) e.preventDefault();
    }, true);
  }

  const api = {
    setErrors(errors) {
      let first = null;
      for (const { field: name, message } of errors) {
        const input = form.elements[name?.split(".").at(-1)];
        if (input && input.nodeType === 1) { setFieldError(input, message); first ||= input; }
      }
      first?.focus();
      live.textContent = t("ui.form.errors", { count: errors.length });
    },
    isDirty,
    markClean() { clean = snapshot(); refresh(); },
    check: () => $$("input,select,textarea", form).every(check),
  };
  refresh();
  return api;
}
