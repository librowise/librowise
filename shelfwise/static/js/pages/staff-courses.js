// Staff: course reserves — course list with filters and bulk (end-of-term) deactivation.
// The same page module serves the course detail screen (/staff/courses/{id}).
import { $, $$, BOOT, api, badge, debounce, empty, html, num, qs, skeleton, toast, withBusy } from "/static/js/core.js";
import { courseForm } from "/static/js/pages/courses/form.js";
import { errorBox, formModal, plural } from "/static/js/pages/lib/sc-ui.js";

const state = { facets: { departments: [], terms: [] }, rows: [] };

function filters() {
  const fd = new FormData($("#course-filters"));
  const active = fd.get("active");
  return { q: String(fd.get("q") || "").trim(), department: fd.get("department"), term: fd.get("term"), active: active === "" ? undefined : active };
}

function fillFacets() {
  const fill = (sel, values, label) => {
    const cur = sel.value;
    sel.innerHTML = html`<option value="">${label}</option>${values.map((v) => html`<option value="${v}" ${v === cur ? "selected" : ""}>${v}</option>`)}`;
  };
  fill($("#cf-dept"), state.facets.departments, "All departments");
  fill($("#cf-term"), state.facets.terms, "All terms");
}

function updateBulk() {
  const n = $$("[data-course]:checked").length;
  $("#course-bulk").hidden = !n;
  $("#course-selected").textContent = `${plural(n, "course")} selected`;
}

async function load() {
  const box = $("#course-list");
  box.innerHTML = skeleton(5);
  try {
    const r = await api(`/courses?${qs(filters())}`);
    state.rows = r.results;
    state.facets = r.facets;
    fillFacets();
    $("#course-count").textContent = `(${r.total})`;
    box.innerHTML = r.results.length ? html`<div class="table-wrap"><table class="table">
      <caption class="sr-only">Courses</caption>
      <thead><tr><th scope="col"><input type="checkbox" id="course-all" aria-label="Select all courses"></th><th scope="col">Course</th><th scope="col">Department</th>
        <th scope="col">Term</th><th scope="col">Instructors</th><th scope="col" class="num">Reserves</th><th scope="col">Status</th></tr></thead>
      <tbody>${r.results.map((c) => html`<tr>
        <td><input type="checkbox" data-course="${c.id}" aria-label="Select ${c.code}"></td>
        <td><a href="/staff/courses/${c.id}"><strong>${c.code}${c.section ? ` · ${c.section}` : ""}</strong></a><div class="small">${c.name}</div></td>
        <td>${c.department || html`<span class="muted">—</span>`}</td><td>${c.term || html`<span class="muted">—</span>`}</td>
        <td class="small">${c.instructors.map((i) => i.name).join(", ") || html`<span class="muted">—</span>`}</td>
        <td class="num">${num(c.reserve_count)}</td>
        <td>${c.active ? badge("ok", "Active") : badge("", "Inactive")}</td></tr>`)}</tbody></table></div>`
      : empty("No courses match these filters.", "list");
    updateBulk();
  } catch (e) { box.innerHTML = errorBox(e.message); }
}

async function bulkStatus(active, btn) {
  const ids = $$("[data-course]:checked").map((c) => +c.dataset.course);
  if (!ids.length) return;
  try {
    const r = await withBusy(btn, () => api("/courses/bulk-status", { method: "POST", body: { active, course_ids: ids } }));
    toast(`${plural(r.courses, "course")} ${active ? "activated" : "deactivated"} · ${plural(active ? r.swapped : r.restored, "item")} ${active ? "moved to reserve" : "restored"}`, "success");
    load();
  } catch { /* toasted */ }
}

async function endOfTerm() {
  if (!state.facets.terms.length) { toast("No courses have a term set.", "error"); return; }
  const body = html`<div class="stack">
    <p style="margin:0">Deactivate every active course in a term. Items on reserve only for those courses get their original item type and shelf location back; the courses and their reserve lists are kept for next time.</p>
    <div class="field"><label for="eot-term">Term</label><select id="eot-term" name="term" required>${state.facets.terms.map((t) => html`<option value="${t}">${t}</option>`)}</select></div></div>`;
  const r = await formModal({ title: "End of term", body, submit: "Deactivate courses", danger: true },
    (fd) => api("/courses/bulk-status", { method: "POST", body: { active: false, term: fd.get("term") } }));
  if (r) { toast(`${plural(r.courses, "course")} deactivated · ${plural(r.restored, "item")} restored`, "success"); load(); }
}

async function listPage() {
  const form = $("#course-filters");
  form.addEventListener("submit", (e) => { e.preventDefault(); load(); });
  form.addEventListener("change", load);
  $("#cf-q").addEventListener("input", debounce(load, 300));
  $("#new-course").addEventListener("click", async () => {
    const c = await courseForm(null, state.facets);
    if (c) { toast(`Course ${c.code} created`, "success"); location.href = `/staff/courses/${c.id}`; }
  });
  $("#end-term").addEventListener("click", endOfTerm);
  $("#course-list").addEventListener("change", (e) => {
    if (e.target.id === "course-all") $$("[data-course]").forEach((c) => { c.checked = e.target.checked; });
    updateBulk();
  });
  $("#course-bulk").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bulk]");
    if (b) bulkStatus(b.dataset.bulk === "activate", b);
  });
  await load();
}

export default async function init() {
  if (BOOT.path_params?.course_id) return (await import("/static/js/pages/courses/detail.js")).default();
  return listPage();
}
