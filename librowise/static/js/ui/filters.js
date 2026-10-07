// Filter bar building blocks: URL-backed state, a search field, select "chips", removable active-filter
// chips and saved views. Filters live in the query string so every view is linkable and survives reloads.
//
//   const state = urlState({ q: "", status: "", sort: "name", page: 1 });
//   bar.innerHTML = html`<div class="filter-row">${searchField({ name: "q", label: "Search", value: state.get().q })}
//     ${selectChip({ name: "status", label: "Status", value, options: [["", "Any status"], ["active", "Active"]] })}</div>
//     ${activeFilters([{ key: "status", label: "Status", value: "Active" }])}`;
//   wireFilterBar(bar, (changes) => state.set({ ...changes, page: 1 }));
import { $, debounce, html, icon, modal } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

/** Typed query-string state. Numbers in `defaults` are parsed as numbers; defaults are omitted from the URL. */
export function urlState(defaults) {
  const get = () => {
    const p = new URLSearchParams(location.search);
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) {
      if (!p.has(k)) continue;
      out[k] = typeof defaults[k] === "number" ? Number(p.get(k)) || defaults[k] : p.get(k);
    }
    return out;
  };
  const toQuery = (s) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(s)) if (v !== "" && v !== null && v !== undefined && v !== defaults[k]) p.set(k, v);
    const q = p.toString();
    return q ? `?${q}` : location.pathname;
  };
  return {
    get,
    defaults,
    query: (s) => toQuery({ ...get(), ...s }),
    /** Update the URL (history.replaceState by default) and return the new state. */
    set(changes, { push = false } = {}) {
      const next = { ...get(), ...changes };
      history[push ? "pushState" : "replaceState"](null, "", toQuery(next));
      return next;
    },
  };
}

let fieldSeq = 0;
export function searchField({ name = "q", label, value = "", placeholder = "", shortcut = "/" } = {}) {
  const id = `sf-${name}-${++fieldSeq}`;
  return html`<div class="search-field" role="search">
    <label class="sr-only" for="${id}">${label}</label>${icon("search")}
    <input id="${id}" name="${name}" type="search" value="${value}" placeholder="${placeholder || label}" autocomplete="off" spellcheck="false"
      ${shortcut === "/" ? html`data-search-focus aria-keyshortcuts="/"` : ""}>
    <button type="button" class="clear" data-clear="${name}" aria-label="${t("ui.filters.clear_search")}" ${value ? "" : "hidden"}>${icon("x")}</button>
  </div>`;
}

export function selectChip({ name, label, value = "", options }) {
  const id = `sc-${name}-${++fieldSeq}`;
  return html`<span class="select-chip ${value ? "active" : ""}"><label class="sr-only" for="${id}">${label}</label>
    <select id="${id}" name="${name}" data-filter="${name}">${options.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value) ? "selected" : ""}>${l}</option>`)}</select></span>`;
}

/** Removable chips for the filters currently applied, plus "Clear all". */
export function activeFilters(list) {
  if (!list.length) return "";
  return html`<div class="filter-chips" aria-label="${t("ui.filters.active")}" role="group">
    ${list.map((f) => html`<span class="filter-chip"><span class="k">${f.label}:</span> ${f.value}
      <button type="button" data-remove-filter="${f.key}" aria-label="${t("ui.filters.remove", { filter: `${f.label}: ${f.value}` })}">${icon("x")}</button></span>`)}
    <button type="button" class="link-btn" data-clear-filters>${t("ui.filters.clear_all")}</button></div>`;
}

/**
 * Wire a filter bar: search input (debounced), selects, chip removal, clear-all.
 * `onChange(changes)` receives only what changed, e.g. { q: "rao" } or { status: "" }.
 */
export function wireFilterBar(root, onChange, { keys = [], debounceMs = 300 } = {}) {
  const fire = debounce((name, value) => onChange({ [name]: value }), debounceMs);
  root.addEventListener("input", (e) => {
    if (e.target.matches(".search-field input")) {
      const clear = $(`[data-clear="${e.target.name}"]`, root);
      if (clear) clear.hidden = !e.target.value;
      fire(e.target.name, e.target.value.trim());
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.target.matches(".search-field input") && e.key === "Enter") { e.preventDefault(); onChange({ [e.target.name]: e.target.value.trim() }); }
    if (e.target.matches(".search-field input") && e.key === "Escape" && e.target.value) { e.preventDefault(); e.target.value = ""; onChange({ [e.target.name]: "" }); }
  });
  root.addEventListener("change", (e) => {
    if (e.target.matches("[data-filter]")) {
      e.target.closest(".select-chip")?.classList.toggle("active", !!e.target.value);
      onChange({ [e.target.name]: e.target.value });
    }
  });
  root.addEventListener("click", (e) => {
    const clear = e.target.closest("[data-clear]");
    if (clear) {
      const input = root.querySelector(`input[name="${clear.dataset.clear}"]`);
      input.value = "";
      clear.hidden = true;
      input.focus();
      onChange({ [clear.dataset.clear]: "" });
    }
    const rm = e.target.closest("[data-remove-filter]");
    if (rm) onChange({ [rm.dataset.removeFilter]: "" });
    if (e.target.closest("[data-clear-filters]")) onChange(Object.fromEntries(keys.map((k) => [k, ""])));
  });
}

/**
 * Saved views: preset tabs (e.g. "Expired", "Owes money") plus views the user saves, kept per browser.
 *   const views = savedViews($("#views"), { id: "patrons", presets, current: () => filters, onSelect: (params) => … });
 * A preset is { id, label, params }. The view whose params match the current filters is shown as pressed.
 */
export function savedViews(el, { id, presets = [], current, onSelect, keys }) {
  const k = `sw-views:${id}`;
  const load = () => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
  const save = (v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
  const same = (a, b) => keys.every((key) => String(a[key] ?? "") === String(b[key] ?? ""));
  function render() {
    const cur = current();
    const custom = load();
    const all = [...presets.map((p) => ({ ...p, preset: true })), ...custom];
    const match = all.find((v) => same(v.params, cur));
    el.innerHTML = html`<div class="saved-views" role="group" aria-label="${t("ui.filters.views")}">
      ${all.map((v) => html`<span class="view-item"><button type="button" class="view-tab" data-view="${v.id}" aria-pressed="${match?.id === v.id}">${v.icon ? icon(v.icon) : ""}${v.label}</button>${
        v.preset ? "" : html`<button type="button" class="view-rm" data-delete-view="${v.id}" aria-label="${t("ui.filters.delete_view", { name: v.label })}" data-tip="${t("ui.filters.delete_view", { name: v.label })}">${icon("x")}</button>`}</span>`)}
      ${match ? "" : html`<button type="button" class="view-tab" data-save-view>${icon("plus")}${t("ui.filters.save_view")}</button>`}
    </div>`;
  }
  el.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-delete-view]");
    if (del) { e.stopPropagation(); save(load().filter((v) => v.id !== del.dataset.deleteView)); render(); return; }
    const b = e.target.closest("[data-view]");
    if (b) {
      const v = [...presets, ...load()].find((x) => x.id === b.dataset.view);
      if (v) onSelect({ ...Object.fromEntries(keys.map((key) => [key, ""])), ...v.params });
      return;
    }
    if (e.target.closest("[data-save-view]")) {
      const fd = await modal({ title: t("ui.filters.save_view"), size: "sm", submit: t("common.save"),
        body: html`<div class="field"><label for="view-name">${t("ui.filters.view_name")}</label><input id="view-name" name="name" required maxlength="40"></div>` });
      if (!fd) return;
      const params = Object.fromEntries(keys.map((key) => [key, current()[key] ?? ""]));
      save([...load(), { id: `v${Date.now()}`, label: String(fd.get("name")).trim(), params }]);
      render();
    }
  });
  render();
  return { render };
}
