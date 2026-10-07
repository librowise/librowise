// Data table: the standard way to show records in Shelfwise staff screens.
//
//   const table = dataTable($("#results"), {
//     id: "patrons",                                  // remembers column visibility + density per browser
//     caption: t("…"),                                // screen-reader caption
//     columns: [
//       { key: "name", label: "Name", sortable: true, primary: true, render: (p) => html`…`, csv: (p) => p.full_name },
//       { key: "loans", label: "Loans", align: "num", hideable: true },
//       { key: "email", label: "Email", hidden: true },  // hidden by default; user can show it
//     ],
//     rowKey: (r) => r.id, rowHref: (r) => `/staff/patrons/${r.id}`,
//     selectable: true,
//     bulkActions: [{ id: "export", label: "Export CSV", icon: "download", run: (rows) => … }],
//     sort: { key: "name", dir: "asc" }, onSort: (sort) => …,
//     onPage: ({ page, perPage }) => …, perPageOptions: [25, 50, 100],
//     empty: { art: "people", title: "…", body: "…", actions: html`…` },
//     exportName: "patrons", exportAll: async () => rows,   // CSV export of every match (optional)
//   });
//   table.setLoading(); table.setRows(rows, { total, page, perPage }); table.setError(err, retry);
//
// Accessibility: real <table> with caption, aria-sort on sortable headers (buttons), a polite live region
// for loading/selection/sort announcements, roving-tabindex rows (↑/↓ or J/K, Home/End, Enter opens,
// Space/X selects), checkboxes with labels. Below 640px of its own width the table becomes a card list
// (CSS container query) — no separate mobile markup.
import { $, $$, html, icon, num, raw, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { emptyState, errorState, skeletonRows } from "/static/js/ui/empty.js";
import { popover } from "/static/js/ui/menu.js";
import { pagination, pageRange, wirePagination } from "/static/js/ui/pagination.js";

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/** RFC 4180 CSV with spreadsheet formula-injection neutralised. */
export function toCSV(columns, rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = columns.filter((c) => c.csv !== false);
  const value = (c, r) => (typeof c.csv === "function" ? c.csv(r) : r[c.key]);
  return [cols.map((c) => cell(c.label)).join(","), ...rows.map((r) => cols.map((c) => cell(value(c, r))).join(","))].join("\r\n");
}

export function downloadCSV(name, csv) {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

let seq = 0;

export function dataTable(el, opts) {
  const o = { selectable: false, bulkActions: [], perPageOptions: [25, 50, 100], toolbarStart: "", ...opts };
  const uid = `dt-${o.id || ++seq}`;
  const kCols = `sw-dt:${o.id}:hidden`, kDensity = `sw-dt:${o.id}:density`;
  const defaults = o.columns.filter((c) => c.hidden).map((c) => c.key);
  let hidden = new Set(o.id ? store.get(kCols, defaults) : defaults);
  let density = (o.id && store.get(kDensity, "default")) || "default";
  let rows = [], state = { page: 1, perPage: o.perPage || 25, total: 0 }, sort = o.sort || null;
  const selected = new Map();
  let anchor = null;

  const visible = () => o.columns.filter((c) => !hidden.has(c.key));
  const keyOf = (r) => String(o.rowKey ? o.rowKey(r) : r.id);

  el.classList.add("dt");
  el.dataset.density = density;
  el.innerHTML = html`
    <div class="dt-toolbar">
      <div class="toolbar">${raw(o.toolbarStart)}<span class="dt-summary" data-summary aria-live="polite"></span></div>
      <span class="spacer"></span>
      ${o.exportName ? html`<button type="button" class="btn sm ghost" data-export data-tip="${t("ui.table.export_hint")}">${icon("download")}<span>${t("ui.table.export")}</span></button>` : ""}
      <button type="button" class="btn sm ghost icon-only" data-density-toggle aria-label="${t("ui.table.density")}" data-tip="${t("ui.table.density")}">${icon("density")}</button>
      <div class="dt-menu">
        <button type="button" class="btn sm ghost icon-only" data-cols-trigger aria-haspopup="true" aria-expanded="false" aria-controls="${uid}-cols"
          aria-label="${t("ui.table.columns")}" data-tip="${t("ui.table.columns")}">${icon("columns")}</button>
        <div class="popover dt-col-menu" id="${uid}-cols" hidden><h3>${t("ui.table.show_columns")}</h3>
          ${o.columns.filter((c) => c.hideable !== false && !c.primary).map((c) => html`<label class="checkbox"><input type="checkbox" data-col="${c.key}" ${hidden.has(c.key) ? "" : "checked"}>${c.label}</label>`)}
          <hr><button type="button" class="link-btn" data-cols-reset>${t("ui.table.reset_columns")}</button></div>
      </div>
    </div>
    <div class="bulk-bar" data-bulk hidden role="region" aria-label="${t("ui.table.bulk_actions")}">
      <span class="bulk-count" data-bulk-count></span>
      ${o.bulkActions.map((a) => html`<button type="button" class="btn sm ${a.danger ? "danger" : ""}" data-bulk-action="${a.id}">${a.icon ? icon(a.icon) : ""}${a.label}</button>`)}
      <span class="spacer"></span>
      <button type="button" class="btn sm ghost" data-bulk-clear>${t("ui.table.clear_selection")}</button>
    </div>
    <div class="dt-scroll"><table class="dt-table" id="${uid}"><caption class="sr-only">${o.caption || ""}</caption><thead></thead><tbody></tbody></table></div>
    <div class="dt-footer" data-footer><span class="dt-kbd-hint">${raw(t("ui.table.keyboard_hint"))}</span><div data-pager></div></div>
    <div class="sr-only" aria-live="polite" data-live></div>`;

  const table = $("table", el), thead = $("thead", el), tbody = $("tbody", el);
  const live = $("[data-live]", el), summary = $("[data-summary]", el);
  const announce = (msg) => { live.textContent = ""; requestAnimationFrame(() => { live.textContent = msg; }); };

  function head() {
    const cols = visible();
    const pageKeys = rows.map(keyOf);
    const all = pageKeys.length && pageKeys.every((k) => selected.has(k));
    const some = pageKeys.some((k) => selected.has(k));
    thead.innerHTML = html`<tr>
      ${o.selectable ? html`<th scope="col" class="dt-check"><input type="checkbox" data-select-all aria-label="${t("ui.table.select_page")}" ${all ? "checked" : ""}></th>` : ""}
      ${cols.map((c) => {
        const active = sort && sort.key === (c.sortKey || c.key);
        const ariaSort = c.sortable ? (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : null;
        return html`<th scope="col" class="${c.align === "num" ? "num" : ""} ${c.headClass || ""}" ${ariaSort ? html`aria-sort="${ariaSort}"` : ""} ${c.width ? html`style="width:${c.width}"` : ""}>${
          c.sortable ? html`<button type="button" class="dt-sort" data-sort="${c.sortKey || c.key}">${c.label}${icon(active ? (sort.dir === "asc" ? "sort-asc" : "sort-desc") : "sort")}</button>`
            : c.labelHidden ? html`<span class="sr-only">${c.label}</span>` : c.label}</th>`;
      })}</tr>`;
    const box = $("[data-select-all]", thead);
    if (box) box.indeterminate = !all && some;
  }

  function body() {
    const cols = visible();
    if (!rows.length) {
      tbody.innerHTML = html`<tr class="dt-empty-row"><td class="dt-state" colspan="${cols.length + (o.selectable ? 1 : 0)}">${emptyState(o.empty || {})}</td></tr>`;
      return;
    }
    tbody.innerHTML = html`${rows.map((r, i) => {
      const k = keyOf(r), sel = selected.has(k), href = o.rowHref?.(r);
      return html`<tr data-key="${k}" data-i="${i}" tabindex="${i === 0 ? "0" : "-1"}" ${o.selectable ? html`aria-selected="${sel}"` : ""} class="${href ? "dt-row-link" : ""}" ${href ? html`data-href="${href}"` : ""}>
        ${o.selectable ? html`<td class="dt-check"><input type="checkbox" data-select="${k}" ${sel ? "checked" : ""} aria-label="${t("ui.table.select_row", { name: o.rowLabel ? o.rowLabel(r) : k })}"></td>` : ""}
        ${cols.map((c) => html`<td class="${[c.align === "num" ? "num" : "", c.primary ? "dt-primary" : "", c.media ? "dt-media" : "", c.cardHidden ? "dt-hide-card" : "", c.cellClass || ""].join(" ")}" data-label="${c.label}">${
          c.render ? c.render(r) : (r[c.key] ?? "—")}</td>`)}
      </tr>`;
    })}`;
  }

  function bulk() {
    const bar = $("[data-bulk]", el);
    const n = selected.size;
    bar.hidden = n === 0;
    $(".dt-toolbar", el).hidden = n > 0;
    $("[data-bulk-count]", el).textContent = t("ui.table.selected", { count: n });
  }

  function footer() {
    summary.textContent = pageRange(state);
    $("[data-pager]", el).innerHTML = o.onPage ? pagination({ ...state, perPageOptions: o.perPageOptions }) : "";
  }

  function render() { head(); body(); bulk(); footer(); }

  // ---------------------------------------------------------------- events
  el.addEventListener("click", async (e) => {
    const s = e.target.closest("[data-sort]");
    if (s) {
      const key = s.dataset.sort;
      const col = o.columns.find((c) => (c.sortKey || c.key) === key);
      const dir = sort?.key === key ? (sort.dir === "asc" ? "desc" : "asc") : (col?.sortDir || "asc");
      sort = { key, dir };
      head();
      announce(t(dir === "asc" ? "ui.table.sorted_asc" : "ui.table.sorted_desc", { column: col?.label || key }));
      o.onSort?.(sort);
      $(`[data-sort="${key}"]`, thead)?.focus();
      return;
    }
    if (e.target.closest("[data-density-toggle]")) {
      density = { default: "compact", compact: "comfortable", comfortable: "default" }[density];
      el.dataset.density = density;
      if (o.id) store.set(kDensity, density);
      announce(t(`ui.table.density_${density}`));
      return;
    }
    if (e.target.closest("[data-cols-reset]")) {
      hidden = new Set(defaults);
      if (o.id) store.set(kCols, [...hidden]);
      $$("[data-col]", el).forEach((b) => { b.checked = !hidden.has(b.dataset.col); });
      render();
      return;
    }
    if (e.target.closest("[data-bulk-clear]")) { selected.clear(); render(); announce(t("ui.table.selection_cleared")); return; }
    const act = e.target.closest("[data-bulk-action]");
    if (act) {
      const a = o.bulkActions.find((x) => x.id === act.dataset.bulkAction);
      if (a) await a.run([...selected.values()], { clear: () => { selected.clear(); render(); }, button: act });
      return;
    }
    if (e.target.closest("[data-export]")) { await exportCSV(e.target.closest("[data-export]")); return; }
    if (e.target.closest("[data-retry]")) { o.onRetry?.(); return; }
    const tr = e.target.closest("tbody tr[data-href]");
    if (tr && !e.target.closest("a,button,input,label,select,textarea,summary")) {
      if (e.ctrlKey || e.metaKey) window.open(tr.dataset.href, "_blank", "noopener"); else location.href = tr.dataset.href;
    }
  });

  el.addEventListener("change", (e) => {
    const box = e.target;
    if (box.matches("[data-col]")) {
      if (box.checked) hidden.delete(box.dataset.col); else hidden.add(box.dataset.col);
      if (o.id) store.set(kCols, [...hidden]);
      render();
    } else if (box.matches("[data-select-all]")) {
      for (const r of rows) { if (box.checked) selected.set(keyOf(r), r); else selected.delete(keyOf(r)); }
      render();
      announce(t("ui.table.selected", { count: selected.size }));
    } else if (box.matches("[data-select]")) {
      toggleRow(box.closest("tr"), box.checked, e.shiftKey);
    }
  });
  // Shift+click on a checkbox selects the range since the last clicked row.
  el.addEventListener("click", (e) => { if (e.target.matches("[data-select]")) el.__shift = e.shiftKey; }, true);

  function toggleRow(tr, on, range = el.__shift) {
    const i = +tr.dataset.i;
    const span = range && anchor !== null ? [Math.min(anchor, i), Math.max(anchor, i)] : [i, i];
    for (let n = span[0]; n <= span[1]; n++) {
      const r = rows[n];
      if (on) selected.set(keyOf(r), r); else selected.delete(keyOf(r));
    }
    anchor = i;
    el.__shift = false;
    const focusKey = tr.dataset.key;
    render();
    $(`tr[data-key="${CSS.escape(focusKey)}"]`, tbody)?.focus();
    announce(t("ui.table.selected", { count: selected.size }));
  }

  // keyboard navigation (roving tabindex on rows)
  tbody.addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (!tr || e.target !== tr) return;
    const list = $$("tr[data-key]", tbody);
    const i = list.indexOf(tr);
    const move = (n) => {
      const next = list[Math.max(0, Math.min(list.length - 1, n))];
      if (!next) return;
      list.forEach((r) => { r.tabIndex = -1; });
      next.tabIndex = 0;
      next.focus();
    };
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(i + 1); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); move(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(list.length - 1); }
    else if (e.key === "Enter" && tr.dataset.href) { e.preventDefault(); location.href = tr.dataset.href; }
    else if ((e.key === " " || e.key === "x") && o.selectable) { e.preventDefault(); toggleRow(tr, !selected.has(tr.dataset.key), e.shiftKey); }
  });

  popover($("[data-cols-trigger]", el), $(`#${uid}-cols`, el));
  if (o.onPage) wirePagination($("[data-pager]", el), (s) => { state = { ...state, ...s }; o.onPage(s); }, () => state);

  async function exportCSV(btn) {
    const cols = visible().filter((c) => c.csv !== false && !c.media);
    let data = selected.size ? [...selected.values()] : rows;
    if (!selected.size && o.exportAll) {
      btn.disabled = true;
      try { data = await o.exportAll(); } catch (err) { toast(err.message, "error"); return; } finally { btn.disabled = false; }
    }
    downloadCSV(o.exportName, toCSV(cols, data));
    toast(t("ui.table.exported", { count: data.length }), "success");
  }

  render();
  return {
    el,
    setLoading() {
      table.setAttribute("aria-busy", "true");
      tbody.innerHTML = skeletonRows(Math.min(state.perPage, 8), visible().length + (o.selectable ? 1 : 0));
      announce(t("common.loading"));
    },
    setRows(next, meta = {}) {
      rows = next;
      state = { ...state, ...meta, total: meta.total ?? next.length };
      table.removeAttribute("aria-busy");
      render();
      announce(pageRange(state));
    },
    setError(err, retry) {
      table.removeAttribute("aria-busy");
      o.onRetry = retry;
      tbody.innerHTML = html`<tr class="dt-empty-row"><td class="dt-state" colspan="${visible().length + (o.selectable ? 1 : 0)}">${errorState(err, { retry: !!retry })}</td></tr>`;
      announce(err?.message || String(err));
    },
    setSort(s) { sort = s; head(); },
    selected: () => [...selected.values()],
    clearSelection() { selected.clear(); render(); },
    updateRows(fn) { rows = rows.map(fn); for (const [k, r] of selected) { const u = rows.find((x) => keyOf(x) === k); if (u) selected.set(k, u); else selected.set(k, fn(r)); } render(); },
    get rows() { return rows; },
    get state() { return { ...state, sort }; },
    count: (n) => num(n),
  };
}
