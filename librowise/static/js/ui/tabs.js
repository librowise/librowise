// In-page tabs and the segmented control.
//
// Tabs (WAI-ARIA tabs pattern; ←/→/Home/End via a11y.wireTabs, RTL-aware):
//   el.innerHTML = tabs({ id: "acq", label: "Acquisitions views", items: [{ id: "orders", label: "Orders", count: 3 }, …], selected: "orders" });
//   wireTabsPanel(el, (id) => render(id), { hash: true });   // hash: remember the tab in location.hash
//
// Navigation between pages uses the shell's hub tabs (links with aria-current), not these.
//
// Segmented control (single choice among 2–5 options, e.g. list/grid view or a period):
//   segmented({ name: "view", label: "View", value: "list", options: [["list", "List", "rows"], ["grid", "Grid", "grid"]] })
//   wireSegmented(el, (value) => …)
import { $, $$, html, icon } from "/static/js/core.js";
import { wireTabs } from "/static/js/a11y.js";

export function tabs({ id, label, items, selected }) {
  return html`<div class="tablist" role="tablist" aria-label="${label}">
    ${items.map((it) => html`<button type="button" role="tab" id="${id}-tab-${it.id}" aria-controls="${id}-panel" data-tab="${it.id}"
      aria-selected="${it.id === selected}" tabindex="${it.id === selected ? "0" : "-1"}">${it.icon ? icon(it.icon) : ""}${it.label}${
      it.count !== undefined && it.count !== null ? html`<span class="count">${it.count}</span>` : ""}</button>`)}
  </div><div role="tabpanel" id="${id}-panel" aria-labelledby="${id}-tab-${selected}" tabindex="0"></div>`;
}

export function wireTabsPanel(root, onSelect, { hash = false } = {}) {
  const list = $('[role="tablist"]', root), panel = $('[role="tabpanel"]', root);
  const select = (tab) => {
    $$('[role="tab"]', list).forEach((b) => b.setAttribute("aria-selected", String(b === tab)));
    if (hash) history.replaceState(null, "", `#${tab.dataset.tab}`);
    onSelect(tab.dataset.tab, panel);
  };
  list.addEventListener("click", (e) => { const b = e.target.closest('[role="tab"]'); if (b) select(b); });
  wireTabs(list, panel);
  const initial = (hash && location.hash && $(`[data-tab="${CSS.escape(location.hash.slice(1))}"]`, list)) || $('[aria-selected="true"]', list);
  if (initial) select(initial);
  return { select: (id) => { const b = $(`[data-tab="${CSS.escape(id)}"]`, list); if (b) select(b); }, panel };
}

export function segmented({ name, label, value, options }) {
  return html`<div class="segmented" role="radiogroup" aria-label="${label}" data-segmented="${name}">
    ${options.map(([v, l, ic]) => html`<button type="button" role="radio" aria-checked="${v === value}" tabindex="${v === value ? "0" : "-1"}" data-value="${v}">${ic ? icon(ic) : ""}<span>${l}</span></button>`)}
  </div>`;
}

export function wireSegmented(root, onChange) {
  const group = root.matches?.("[data-segmented]") ? root : $("[data-segmented]", root);
  const set = (btn, focus = false) => {
    $$('[role="radio"]', group).forEach((b) => { const on = b === btn; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; });
    if (focus) btn.focus();
    onChange(btn.dataset.value);
  };
  group.addEventListener("click", (e) => { const b = e.target.closest('[role="radio"]'); if (b) set(b); });
  group.addEventListener("keydown", (e) => {
    const items = $$('[role="radio"]', group);
    const i = items.indexOf(document.activeElement);
    const rtl = getComputedStyle(group).direction === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowDown: 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -1 }[e.key];
    if (step === undefined || i < 0) return;
    e.preventDefault();
    set(items[(i + step + items.length) % items.length], true);
  });
}
