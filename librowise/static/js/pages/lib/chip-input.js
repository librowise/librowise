// Multi-value "chip" input with authority-controlled typeahead (authors, subjects, variants…).
//
//   el.innerHTML = chipField({ name: "authors", label, values, help, group: "authors" });
//   const chips = wireChipField($('[data-chip-field="authors"]', form), { group: "authors", onChange });
//   chips.values() → ["Doyle, Arthur Conan", …]   chips.add("Heading", { authority: true })   chips.flush()
//
// Each value is a removable token with a hidden <input name=…> (so FormData / dirty tracking see it). The
// typeahead (ARIA combobox) searches /authorities?group=…; the first option always keeps exactly what was
// typed ("Add “…” as typed") so new, uncontrolled headings are one Enter away. ; and , also add the text.
import { $, $$, api, html, icon, num, qs } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { combobox, highlight } from "/static/js/ui/combobox.js";

let seq = 0;

const token = (name, value, controlled) => html`<li class="chip-token ${controlled ? "controlled" : ""}" data-value="${value}">
  ${controlled ? html`<span class="ct-auth" data-tip="${t("coll.chips.controlled")}">${icon("check-circle")}<span class="sr-only">${t("coll.chips.controlled")}</span></span>` : ""}
  <span class="ct-text">${value}</span><input type="hidden" name="${name}" value="${value}">
  <button type="button" class="ct-rm" data-chip-rm aria-label="${t("coll.chips.remove", { value })}">${icon("x")}</button></li>`;

/** Markup for a chip field (label, token list, text input, help and error slot like ui/form.js field()). */
export function chipField({ name, label, values = [], help = "", placeholder = "", controlled = [], span = 2, required = false }) {
  const id = `chip-${name}-${++seq}`;
  const lc = new Set(controlled.map((x) => x.toLowerCase()));
  return html`<div class="field ${span === 2 ? "span-2" : ""}" data-field="${name}" data-chip-field="${name}">
    <label for="${id}">${label}${required ? html`<span class="req" aria-hidden="true">*</span>` : ""}</label>
    <div class="chip-input">
      <ul class="chip-tokens" role="list" aria-label="${label}">${values.map((v) => token(name, v, lc.has(v.toLowerCase())))}</ul>
      <input id="${id}" data-chip-text autocomplete="off" spellcheck="false" placeholder="${placeholder}" aria-describedby="${id}-help ${id}-err">
    </div>
    <div class="field-help" id="${id}-help">${help}</div>
    <div class="field-error" id="${id}-err" hidden></div>
    <div class="sr-only" aria-live="polite" data-chip-live></div>
  </div>`;
}

/** Behaviour for a chipField. `group` = authorities browse group (authors | subjects | titles) or null. */
export function wireChipField(wrap, { group = null, type = null, onChange } = {}) {
  const name = wrap.dataset.chipField;
  const list = $(".chip-tokens", wrap), input = $("[data-chip-text]", wrap), live = $("[data-chip-live]", wrap);
  const values = () => $$("input[type=hidden]", list).map((i) => i.value);
  const changed = () => { input.dispatchEvent(new Event("input", { bubbles: true })); onChange?.(values()); };
  const add = (value, { authority = false, announce = true } = {}) => {
    const v = String(value || "").trim().replace(/\s+/g, " ");
    if (!v) return false;
    if (values().some((x) => x.toLowerCase() === v.toLowerCase())) { live.textContent = t("coll.chips.duplicate", { value: v }); return false; }
    list.insertAdjacentHTML("beforeend", token(name, v, authority));
    if (announce) live.textContent = t("coll.chips.added", { value: v });
    changed();
    return true;
  };
  const flush = () => { if (input.value.trim()) { add(input.value); input.value = ""; } };
  wrap.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-chip-rm]");
    if (rm) {
      const li = rm.closest(".chip-token");
      const next = li.nextElementSibling?.querySelector("[data-chip-rm]") || input;
      live.textContent = t("coll.chips.removed", { value: li.dataset.value });
      li.remove();
      next.focus();
      changed();
    } else if (e.target === wrap.querySelector(".chip-input")) input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if ((e.key === ";" || (e.key === "," && group === "subjects")) && input.value.trim()) { e.preventDefault(); flush(); }
    else if (e.key === "Backspace" && !input.value) {
      const last = list.lastElementChild;
      if (last) { e.preventDefault(); $("[data-chip-rm]", last).focus(); }
    } else if (e.key === "Enter" && input.value.trim() && input.getAttribute("aria-expanded") !== "true") { e.preventDefault(); e.stopPropagation(); flush(); }
    else if (e.key === "Enter" && !input.value.trim()) { e.preventDefault(); e.stopPropagation(); } // never submit the whole form from an empty chip box
  });
  list.addEventListener("keydown", (e) => {
    if ((e.key === "Backspace" || e.key === "Delete") && e.target.matches("[data-chip-rm]")) { e.preventDefault(); e.target.click(); }
  });
  if (group || type) {
    combobox(input, {
      minChars: 2,
      source: async (q, signal) => {
        const r = await api(`/authorities?${qs({ q, group: group || undefined, type: type || undefined, per_page: 8, sort: "usage" })}`, { signal });
        const rows = r.results.map((a) => ({ heading: a.heading, label: a.type_label, usage: a.usage, variant: a.variants.find((v) => v.toLowerCase().includes(q.toLowerCase()) && !a.heading.toLowerCase().includes(q.toLowerCase())) }));
        const exact = rows.some((x) => x.heading.toLowerCase() === q.toLowerCase());
        return exact ? rows : [{ raw: q }, ...rows];
      },
      render: (it, q) => (it.raw ? html`<span class="combo-raw">${icon("plus")}${t("coll.chips.add_as_typed", { value: it.raw })}</span>`
        : html`${icon("check-circle")}<span class="combo-main">${highlight(it.heading, q)}${it.variant ? html`<span class="sub">${t("coll.chips.see_from", { value: it.variant })}</span>` : ""}</span>
          <span class="sub">${it.label} · ${t("coll.chips.uses", { count: it.usage || 0, n: num(it.usage || 0) })}</span>`),
      value: () => "",
      onSelect: (it) => { add(it.raw || it.heading, { authority: !it.raw }); input.value = ""; input.focus(); },
    });
  }
  return { values, add, flush, input };
}
