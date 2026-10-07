// Staff › Catalogue › Records — LIST PAGE on the design system (see staff-patrons.js for the annotated
// reference). Search + format/branch/availability filters, saved views, sortable year column, covers,
// selection with MARC/CSV export.
import { $, api, authors, cover, html, icon, num, qs } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { activeFilters, savedViews, searchField, selectChip, urlState, wireFilterBar } from "/static/js/ui/filters.js";
import { setCount } from "/static/js/ui/page-header.js";
import { statusPill } from "/static/js/ui/status.js";

const FILTERS = ["q", "material_type", "branch_id", "available_only"];
const state = urlState({ q: "", material_type: "", branch_id: "", available_only: "", sort: "", page: 1, per_page: 25 });
const fmt = (m) => t(`format.${m}`, {}, m);

function availability(a) {
  if (!a) return "—";
  if (!a.total) return statusPill("item", "withdrawn", t("availability.none"));
  return a.available
    ? statusPill("item", "available", t("availability.some", { available: a.available, total: a.total, count: a.total }))
    : statusPill("item", "on_loan", t("availability.all_out"));
}

function columns() {
  return [
    { key: "cover", label: t("ui.catalog.col_cover"), labelHidden: true, media: true, hideable: true, csv: false, width: "3.75rem",
      render: (b) => html`<a href="/staff/catalog/${b.id}" tabindex="-1" aria-hidden="true">${cover(b, "sm")}</a>` },
    { key: "title", label: t("ui.catalog.col_title"), primary: true, hideable: false, csv: (b) => b.title,
      render: (b) => html`<div class="dt-cell-stack"><a href="/staff/catalog/${b.id}">${b.title}</a>
        <span class="sub">${authors(b.authors) || t("opac.search.unknown_author")}</span></div>` },
    { key: "authors", label: t("ui.catalog.col_authors"), hidden: true, csv: (b) => authors(b.authors), render: (b) => authors(b.authors) || "—" },
    { key: "year", label: t("ui.catalog.col_year"), sortable: true, sortDir: "desc", align: "num", csv: (b) => b.pub_year || "", render: (b) => b.pub_year || "—" },
    { key: "format", label: t("ui.catalog.col_format"), csv: (b) => b.material_type, render: (b) => fmt(b.material_type) },
    { key: "class", label: t("ui.catalog.col_class"), csv: (b) => b.classification || "", render: (b) => html`<span class="mono small">${b.classification || "—"}</span>` },
    { key: "isbn", label: "ISBN", hidden: true, csv: (b) => b.isbn || "", render: (b) => html`<span class="mono small">${b.isbn || "—"}</span>` },
    { key: "publisher", label: t("ui.catalog.col_publisher"), hidden: true, csv: (b) => b.publisher || "", render: (b) => b.publisher || "—" },
    { key: "language", label: t("ui.catalog.col_language"), hidden: true, csv: (b) => b.language, render: (b) => t(`lang.${b.language}`, {}, b.language) },
    { key: "availability", label: t("ui.catalog.col_copies"), csv: (b) => (b.availability ? `${b.availability.available}/${b.availability.total}` : ""),
      render: (b) => availability(b.availability) },
  ];
}

const apiSort = (s) => s.sort || (s.q ? "relevance" : "newest");
const tableSort = (sort) => (sort === "year_desc" ? { key: "year", dir: "desc" } : sort === "year_asc" ? { key: "year", dir: "asc" } : null);
const params = (s) => ({ q: s.q, material_type: s.material_type, branch_id: s.branch_id, available_only: s.available_only === "true" || undefined,
  sort: apiSort(s), page: s.page, per_page: s.per_page });

export default async function init() {
  const lk = await api("/lookups");
  const s0 = state.get();
  const fmtOpts = [["", t("ui.catalog.any_format")], ...lk.material_types.map((m) => [m, fmt(m)])];
  const brOpts = [["", t("common.all_branches")], ...lk.branches.map((b) => [String(b.id), b.name])];
  const availOpts = [["", t("ui.catalog.any_availability")], ["true", t("opac.search.available_now")]];
  const sortOpts = [["", t("ui.catalog.sort_auto")], ["relevance", t("opac.search.sort_relevance")], ["newest", t("opac.search.sort_newest")],
    ["title", t("opac.search.sort_title")], ["year_desc", t("opac.search.sort_year_desc")], ["year_asc", t("opac.search.sort_year_asc")]];
  const label = { q: t("common.search"), material_type: t("ui.catalog.col_format"), branch_id: t("common.branch"), available_only: t("ui.catalog.col_copies") };
  const optLabel = { material_type: fmtOpts, branch_id: brOpts, available_only: availOpts };

  $("#c-filter-row").innerHTML = html`
    ${searchField({ name: "q", label: t("ui.catalog.search_label"), value: s0.q, placeholder: t("ui.catalog.search_placeholder") })}
    ${selectChip({ name: "material_type", label: label.material_type, value: s0.material_type, options: fmtOpts })}
    ${selectChip({ name: "branch_id", label: label.branch_id, value: s0.branch_id, options: brOpts })}
    ${selectChip({ name: "available_only", label: label.available_only, value: s0.available_only, options: availOpts })}
    ${selectChip({ name: "sort", label: t("opac.search.sort"), value: s0.sort, options: sortOpts })}`;

  const views = savedViews($("#c-views"), {
    id: "catalog", keys: FILTERS, current: () => state.get(),
    presets: [
      { id: "all", label: t("ui.catalog.view_all"), params: {} },
      { id: "available", label: t("opac.search.available_now"), params: { available_only: "true" } },
      { id: "book", label: fmt("book"), params: { material_type: "book" } },
      { id: "ebook", label: fmt("ebook"), params: { material_type: "ebook" } },
      { id: "audiobook", label: fmt("audiobook"), params: { material_type: "audiobook" } },
    ],
    onSelect: (p) => apply(p, true),
  });

  const chips = () => {
    const s = state.get();
    $("#c-chips").innerHTML = activeFilters(FILTERS.filter((k) => s[k]).map((k) => ({ key: k, label: label[k],
      value: k === "q" ? `“${s.q}”` : (optLabel[k].find(([v]) => v === String(s[k]))?.[1] || s[k]) })));
  };

  const exportMarc = (rows, f) => { location.href = `/api/v1/cataloging/export?${qs({ fmt: f, ids: rows.map((b) => b.id).join(",") })}`; };
  const table = dataTable($("#c-table"), {
    id: "catalog", caption: t("ui.catalog.title"), columns: columns(), selectable: true,
    rowHref: (b) => `/staff/catalog/${b.id}`, rowLabel: (b) => b.title,
    sort: tableSort(s0.sort), perPage: s0.per_page,
    onSort: (srt) => apply({ sort: srt.key === "year" ? (srt.dir === "desc" ? "year_desc" : "year_asc") : "", page: 1 }, true),
    onPage: ({ page, perPage }) => apply({ page, per_page: perPage }),
    exportName: "catalogue",
    empty: { art: "books", title: t("ui.catalog.empty_title"), body: t("ui.catalog.empty_body"),
      actions: html`<button type="button" class="btn" data-clear-filters>${t("ui.filters.clear_all")}</button>
        <a class="btn primary" href="/staff/catalog/new">${icon("plus")}${t("ui.catalog.new")}</a>` },
    bulkActions: [
      { id: "marcxml", label: t("ui.catalog.bulk_marcxml"), icon: "code", run: (rows) => exportMarc(rows, "xml") },
      { id: "mrc", label: t("ui.catalog.bulk_mrc"), icon: "download", run: (rows) => exportMarc(rows, "mrc") },
      { id: "csv", label: t("ui.patrons.bulk_export"), icon: "table", run: () => $("[data-export]", table.el).click() },
    ],
  });

  async function load() {
    const s = state.get();
    table.setLoading();
    try {
      const r = await api(`/search?${qs(params(s))}`);
      table.setRows(r.results, { total: r.total, page: s.page, perPage: s.per_page });
      setCount(r.total);
      $("[data-summary]", table.el).textContent += r.took_ms !== undefined ? ` · ${t("opac.search.took", { ms: num(r.took_ms) })}` : "";
    } catch (e) {
      table.setError(e, load);
    }
  }

  function apply(changes, syncInputs = false) {
    const resetPage = Object.keys(changes).some((k) => FILTERS.includes(k) || k === "sort");
    state.set({ ...changes, ...(resetPage && !("page" in changes) ? { page: 1 } : {}) });
    const s = state.get();
    if (syncInputs) {
      for (const k of [...FILTERS, "sort"]) {
        const el = $(`#c-filter-row [name="${k}"]`);
        if (el) { el.value = s[k]; el.closest(".select-chip")?.classList.toggle("active", !!s[k]); }
      }
      const clear = $("#c-filter-row [data-clear]");
      if (clear) clear.hidden = !s.q;
    }
    table.setSort(tableSort(s.sort));
    chips();
    views.render();
    load();
  }

  wireFilterBar($("#c-filters"), (c) => apply(c, true), { keys: FILTERS });
  $("#c-table").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-filters]")) apply(Object.fromEntries(FILTERS.map((k) => [k, ""])), true);
  });
  chips();
  load();
}
