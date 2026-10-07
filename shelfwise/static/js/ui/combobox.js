// Combobox / typeahead (WAI-ARIA 1.2 combobox with listbox popup, list autocomplete).
//
//   combobox(input, {
//     source: async (q, signal) => (await api(`/patrons?q=${q}&per_page=8`, { signal })).results,
//     render: (p) => html`${p.full_name} <span class="sub">${p.card_number}</span>`,
//     value: (p) => p.full_name,           // text written into the input on selection
//     onSelect: (p) => …,
//     minChars: 2, debounceMs: 200,
//   });
//
// ↓/↑ move, Enter selects, Esc closes (second Esc clears), mouse works too; results and "no matches"
// are announced through a polite live region; requests are debounced and stale ones aborted.
import { debounce, esc, html, raw } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

let seq = 0;

export const highlight = (text, q) => {
  if (!q) return raw(esc(text));
  const i = String(text).toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? raw(esc(text)) : raw(`${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`);
};

export function combobox(input, { source, render = (x) => String(x), value = (x) => String(x), onSelect, minChars = 1, debounceMs = 200 } = {}) {
  const id = `combo-${++seq}`;
  const wrap = document.createElement("div");
  wrap.className = "combo";
  input.replaceWith(wrap);
  wrap.append(input);
  const list = document.createElement("ul");
  list.className = "combo-list";
  list.id = `${id}-list`;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  wrap.append(list);
  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("aria-live", "polite");
  wrap.append(live);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);
  input.autocomplete = "off";

  let items = [], active = -1, ctrl = null;
  const open = (on) => { list.hidden = !on; input.setAttribute("aria-expanded", String(on)); if (!on) input.removeAttribute("aria-activedescendant"); };
  const paint = () => {
    list.innerHTML = items.length ? html`${items.map((it, i) => html`<li role="option" id="${id}-o${i}" data-i="${i}" aria-selected="${i === active}">${render(it, input.value.trim())}</li>`)}`
      : html`<li class="combo-empty" role="presentation">${t("ui.combo.no_matches")}</li>`;
    if (active >= 0) { input.setAttribute("aria-activedescendant", `${id}-o${active}`); list.children[active]?.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < minChars) { open(false); return; }
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      items = await source(q, ctrl.signal) || [];
      active = items.length ? 0 : -1;
      paint();
      open(true);
      live.textContent = items.length ? t("ui.combo.results", { count: items.length }) : t("ui.combo.no_matches");
    } catch (e) {
      if (e.name !== "AbortError") { items = []; paint(); open(true); }
    }
  }, debounceMs);
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    input.value = value(it);
    open(false);
    onSelect?.(it);
  };
  input.addEventListener("input", search);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) { search(); return; }
      active = items.length ? (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : -1;
      paint();
    } else if (e.key === "Enter" && !list.hidden && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === "Escape") { if (!list.hidden) { e.preventDefault(); e.stopPropagation(); open(false); } else if (input.value) { e.preventDefault(); input.value = ""; } }
  });
  list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
  list.addEventListener("click", (e) => { const li = e.target.closest("[data-i]"); if (li) choose(+li.dataset.i); });
  input.addEventListener("blur", () => setTimeout(() => open(false), 120));
  return { close: () => open(false), get items() { return items; } };
}
