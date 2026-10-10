// Staff › Course reserves — LIST PAGE: search, department/term/status filters (in the URL), saved views, data
// table with bulk activate / deactivate and the end-of-term wizard. (Course detail: staff-course.js.)
import { $, api, html, icon, num, qs, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { activeFilters, savedViews, searchField, selectChip, urlState, wireFilterBar } from "/static/js/ui/filters.js";
import { setCount } from "/static/js/ui/page-header.js";
import { statusPill } from "/static/js/ui/status.js";
import { courseForm } from "/static/js/pages/courses/form.js";
import { alertBox, formModal } from "/static/js/pages/lib/collection.js";

const FILTERS = ["q", "department", "term", "active"];
const state = urlState({ q: "", department: "", term: "", active: "true" });
const S = { facets: { departments: [], terms: [] }, rows: [], can: false };
const activePill = (on) => statusPill("patron", on ? "active" : "inactive");

function filterRow() {
  const s = state.get();
  const dept = [["", t("coll.crs.any_department")], ...S.facets.departments.map((d) => [d, d])];
  const term = [["", t("coll.crs.any_term")], ...S.facets.terms.map((x) => [x, x])];
  if (s.department && !S.facets.departments.includes(s.department)) dept.push([s.department, s.department]);
  if (s.term && !S.facets.terms.includes(s.term)) term.push([s.term, s.term]);
  return { dept, term, status: [["true", t("coll.crs.active")], ["false", t("coll.crs.inactive")], ["all", t("coll.crs.any_status")]] };
}

function paintFilters() {
  const s = state.get();
  const o = filterRow();
  $("#c-filter-row").innerHTML = html`${searchField({ name: "q", label: t("coll.crs.search_label"), value: s.q, placeholder: t("coll.crs.search_placeholder") })}
    ${selectChip({ name: "department", label: t("coll.crs.department"), value: s.department, options: o.dept })}
    ${selectChip({ name: "term", label: t("coll.crs.term"), value: s.term, options: o.term })}
    ${selectChip({ name: "active", label: t("coll.acq.col_status"), value: s.active, options: o.status })}`;
  paintChips();
}

/** Refresh the department/term options in place (keeps focus and typing in the search box). */
function paintOptions() {
  const s = state.get();
  const o = filterRow();
  for (const [name, list] of [["department", o.dept], ["term", o.term]]) {
    const sel = $(`#c-filter-row select[name="${name}"]`);
    if (!sel) continue;
    sel.innerHTML = html`${list.map(([v, l]) => html`<option value="${v}" ${v === s[name] ? "selected" : ""}>${l}</option>`)}`;
  }
}

function paintChips() {
  const s = state.get();
  const labels = { q: t("common.search"), department: t("coll.crs.department"), term: t("coll.crs.term") };
  $("#c-chips").innerHTML = activeFilters(["q", "department", "term"].filter((k) => s[k]).map((k) => ({ key: k, label: labels[k], value: k === "q" ? `“${s.q}”` : s[k] })));
}

export default async function init() {
  S.can = $("#courses").dataset.canWrite === "1";
  paintFilters();
  const views = savedViews($("#c-views"), {
    id: "courses", keys: FILTERS, current: () => state.get(),
    presets: [{ id: "active", label: t("coll.crs.view_active"), params: { active: "true" } }, { id: "inactive", label: t("coll.crs.view_inactive"), params: { active: "false" } },
      { id: "all", label: t("coll.crs.view_all"), params: { active: "all" } }],
    onSelect: (p) => apply(p),
  });
  const table = dataTable($("#c-table"), {
    id: "courses", caption: t("nav.courses"), selectable: S.can, rowHref: (c) => `/staff/courses/${c.id}`, rowLabel: (c) => c.code, exportName: "courses",
    columns: [
      { key: "course", label: t("coll.crs.course"), primary: true, hideable: false, csv: (c) => `${c.code}${c.section ? ` ${c.section}` : ""}`,
        render: (c) => html`<div class="dt-cell-stack"><a href="/staff/courses/${c.id}">${c.code}${c.section ? ` · ${c.section}` : ""}</a><span class="sub">${c.name}</span></div>` },
      { key: "department", label: t("coll.crs.department"), csv: (c) => c.department || "", render: (c) => c.department || html`<span class="muted">—</span>` },
      { key: "term", label: t("coll.crs.term"), csv: (c) => c.term || "", render: (c) => c.term || html`<span class="muted">—</span>` },
      { key: "instructors", label: t("coll.crs.instructors"), csv: (c) => c.instructors.map((i) => i.name).join("; "),
        render: (c) => html`<span class="small">${c.instructors.map((i) => i.name).join(", ") || "—"}</span>` },
      { key: "reserves", label: t("coll.crs.reserves"), align: "num", csv: (c) => c.reserve_count, render: (c) => num(c.reserve_count) },
      { key: "status", label: t("coll.acq.col_status"), csv: (c) => (c.active ? "active" : "inactive"), render: (c) => activePill(c.active) },
    ],
    bulkActions: S.can ? [
      { id: "activate", label: t("coll.crs.activate"), icon: "check-circle", run: (rows, ctx) => bulk(true, rows, ctx) },
      { id: "deactivate", label: t("coll.crs.deactivate"), icon: "x-circle", run: (rows, ctx) => bulk(false, rows, ctx) },
    ] : [],
    empty: { art: "books", title: t("coll.crs.empty_title"), body: t("coll.crs.empty_body"),
      actions: html`<button type="button" class="btn" data-clear-filters>${t("ui.filters.clear_all")}</button>${S.can ? html`<button type="button" class="btn primary" data-new>${icon("plus")}${t("coll.crs.new")}</button>` : ""}` },
  });

  async function load() {
    table.setLoading();
    const s = state.get();
    try {
      const r = await api(`/courses?${qs({ q: s.q, department: s.department, term: s.term, active: s.active === "all" ? undefined : s.active })}`);
      S.rows = r.results;
      const changed = JSON.stringify(r.facets) !== JSON.stringify(S.facets);
      S.facets = r.facets;
      if (changed) paintOptions();
      table.setRows(r.results);
      setCount(r.total);
    } catch (e) { table.setError(e, load); }
  }
  function apply(changes, sync = true) {
    state.set(changes);
    const st = state.get();
    if (sync) {
      for (const k of ["department", "term", "active"]) { const el = $(`#c-filter-row select[name="${k}"]`); if (el) { el.value = st[k]; el.closest(".select-chip")?.classList.toggle("active", !!st[k]); } }
      const q = $("#c-filter-row input[name=q]");
      if (q && q !== document.activeElement) q.value = st.q;
    }
    paintChips();
    views.render();
    load();
  }
  async function bulk(active, rows, { clear }) {
    try {
      const r = await api("/courses/bulk-status", { method: "POST", body: { active, course_ids: rows.map((c) => c.id) } });
      toast(t(active ? "coll.crs.activated" : "coll.crs.deactivated", { count: r.courses, n: num(r.courses), items: num(active ? r.swapped : r.restored) }), "success");
      clear();
      load();
    } catch (e) { toast(e.message, "error"); }
  }
  wireFilterBar($("#c-filters"), (ch) => apply(ch), { keys: ["q", "department", "term"] });
  $("#c-table").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-filters]")) apply({ q: "", department: "", term: "", active: "all" });
    if (e.target.closest("[data-new]")) $("#new-course")?.click();
  });
  $("#new-course")?.addEventListener("click", async () => {
    const c = await courseForm(null, S.facets);
    if (c) { toast(t("coll.crs.created", { code: c.code }), "success"); location.href = `/staff/courses/${c.id}`; }
  });
  $("#end-term")?.addEventListener("click", async () => {
    if (!S.facets.terms.length) { toast(t("coll.crs.no_terms"), "warn"); return; }
    const r = await formModal({ title: t("coll.crs.end_term_title"), submit: t("coll.crs.deactivate_courses"), danger: true, size: "sm", body: html`<div class="stack">
      <p>${t("coll.crs.end_term_text")}</p>
      <div class="field"><label for="eot-term">${t("coll.crs.term")}</label><select id="eot-term" name="term" required>${S.facets.terms.map((x) => html`<option value="${x}">${x}</option>`)}</select></div>
      ${alertBox(t("coll.crs.end_term_keep"), "info")}</div>` },
    (fd) => api("/courses/bulk-status", { method: "POST", body: { active: false, term: fd.get("term") } }));
    if (r) { toast(t("coll.crs.deactivated", { count: r.courses, n: num(r.courses), items: num(r.restored) }), "success"); load(); }
  });
  await load();
}
