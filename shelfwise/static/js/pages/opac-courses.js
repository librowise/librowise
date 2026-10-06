// OPAC: browse course reserves and see live availability of each course's readings.
import { $, BOOT, api, authors, availabilityBadge, badge, date, debounce, empty, html, icon, qs, relative, skeleton } from "/static/js/core.js";

const view = () => $("#courses-view");
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ course list

function courseCard(c) {
  return html`<a class="card pad stack tight sc-course-card" href="/courses/${c.id}">
    <div class="row between"><strong class="mono">${c.code}${c.section ? ` · ${c.section}` : ""}</strong>${c.term ? badge("info", c.term) : ""}</div>
    <div style="font-weight:650">${c.name}</div>
    <div class="small muted">${c.department || ""}</div>
    <div class="small">${c.instructors.length ? html`${icon("user")} ${c.instructors.map((i) => i.name).join(", ")}` : ""}</div>
    <div class="tiny muted">${c.reserve_count} item${c.reserve_count === 1 ? "" : "s"} on reserve</div></a>`;
}

async function listView() {
  document.title = `Course reserves · ${document.title}`;
  const f = { q: params.get("q") || "", department: params.get("department") || "", term: params.get("term") || "", instructor: params.get("instructor") || "" };
  view().innerHTML = html`<div class="page-head"><div><h1>Course reserves</h1>
      <div class="sub">Readings your instructors have set aside for short loan. Search by course, department or instructor.</div></div></div>
    <form class="card pad row" id="oc-filters" role="search" style="margin-bottom:1.25rem">
      <div class="field grow"><label for="oc-q">Course code or name</label><input id="oc-q" name="q" type="search" value="${f.q}" placeholder="e.g. HIST 210" autocomplete="off" data-search-focus></div>
      <div class="field"><label for="oc-dept">Department</label><select id="oc-dept" name="department"><option value="">All departments</option></select></div>
      <div class="field"><label for="oc-term">Term</label><select id="oc-term" name="term"><option value="">All terms</option></select></div>
      <div class="field"><label for="oc-inst">Instructor</label><input id="oc-inst" name="instructor" type="search" value="${f.instructor}" autocomplete="off"></div>
    </form>
    <div id="oc-results" aria-live="polite">${skeleton(4)}</div>`;
  const form = $("#oc-filters");
  let facetsDone = false;
  const load = async () => {
    const fd = new FormData(form);
    // Until the facet options are loaded, the department/term selects cannot hold the URL's values.
    const query = facetsDone ? { q: String(fd.get("q") || "").trim(), department: fd.get("department"), term: fd.get("term"),
      instructor: String(fd.get("instructor") || "").trim() } : { ...f };
    history.replaceState(null, "", `${location.pathname}${qs(query) ? `?${qs(query)}` : ""}`);
    try {
      const r = await api(`/courses/public?${qs(query)}`);
      if (!facetsDone) {
        const fill = (sel, values, cur) => values.forEach((v) => sel.insertAdjacentHTML("beforeend", html`<option value="${v}" ${v === cur ? "selected" : ""}>${v}</option>`));
        fill($("#oc-dept"), r.facets.departments, f.department);
        fill($("#oc-term"), r.facets.terms, f.term);
        facetsDone = true;
      }
      $("#oc-results").innerHTML = r.results.length ? html`<p class="small muted">${r.total} course${r.total === 1 ? "" : "s"}</p>
        <div class="grid auto">${r.results.map(courseCard)}</div>` : empty("No courses match your search.", "search");
    } catch (e) { $("#oc-results").innerHTML = empty(e.message, "alert"); }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); load(); });
  form.addEventListener("change", load);
  form.addEventListener("input", debounce(load, 350));
  await load();
}

// ------------------------------------------------------------------ one course

function status(r) {
  if (!r.item) return availabilityBadge(r.availability);
  const i = r.item;
  if (i.status === "on_loan") return html`${badge("on_loan", "On loan")}${i.due_at ? html`<div class="tiny muted">Due ${date(i.due_at)} (${relative(i.due_at)})</div>` : ""}`;
  return badge(i.status);
}

function reservesTable(c) {
  if (!c.reserves.length) return empty("Nothing has been placed on reserve for this course yet.", "bookmark");
  return html`<div class="table-wrap"><table class="table">
    <caption class="sr-only">Readings on reserve for ${c.code}</caption>
    <thead><tr><th scope="col">Title</th><th scope="col">Where to find it</th><th scope="col">Loan</th><th scope="col">Availability</th></tr></thead>
    <tbody>${c.reserves.map((r) => html`<tr>
      <td><a href="/record/${r.biblio.id}"><strong>${r.biblio.title}</strong></a>
        <div class="small muted">${authors(r.biblio.authors)}${r.biblio.pub_year ? ` · ${r.biblio.pub_year}` : ""}</div>
        ${r.public_note ? html`<div class="small">${icon("info")} ${r.public_note}</div>` : ""}</td>
      <td class="small">${r.item ? html`${r.item.branch.name}${r.item.shelf_location ? html`<div>${r.item.shelf_location}</div>` : ""}<div class="mono tiny">${r.item.call_number || ""}</div>`
        : html`Any copy — <a href="/record/${r.biblio.id}">see all copies</a>`}</td>
      <td class="small">${r.item ? r.item.item_type.name : "Normal loan"}</td>
      <td>${status(r)}</td></tr>`)}</tbody></table></div>`;
}

async function courseView(id) {
  let c;
  try {
    c = await api(`/courses/public/${id}`);
  } catch (e) {
    view().innerHTML = html`<nav class="small muted" style="margin-bottom:1rem"><a href="/courses">← All courses</a></nav>
      ${empty(e.status === 404 ? "This course is not available." : e.message, "alert")}`;
    return;
  }
  document.title = `${c.code} · Course reserves · ${document.title}`;
  view().innerHTML = html`<nav class="small muted" style="margin-bottom:1rem"><a href="/courses">← All courses</a></nav>
    <div class="page-head"><div>
      <div class="row tight" style="margin-bottom:.35rem">${c.term ? badge("info", c.term) : ""}${c.department ? html`<span class="small muted">${c.department}</span>` : ""}</div>
      <h1>${c.code}${c.section ? ` · ${c.section}` : ""} — ${c.name}</h1>
      <div class="sub">${c.instructors.length ? html`Instructor${c.instructors.length > 1 ? "s" : ""}: ${c.instructors.map((i, n) => html`${n ? ", " : ""}<a href="/courses?instructor=${encodeURIComponent(i.name)}">${i.name}</a>`)}` : ""}</div>
    </div></div>
    ${c.public_notes ? html`<div class="alert info" style="margin-bottom:1rem">${icon("info")}<div style="white-space:pre-line">${c.public_notes}</div></div>` : ""}
    <section class="card"><div class="card-head"><h2>On reserve</h2><span class="tiny muted" id="oc-updated" aria-live="polite"></span></div>
      <div class="card-body" id="oc-reserves">${reservesTable(c)}</div></section>`;
  const stamp = () => { $("#oc-updated").textContent = `Availability updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`; };
  stamp();
  // Keep availability live while the page is open and visible.
  setInterval(async () => {
    if (document.hidden) return;
    try { $("#oc-reserves").innerHTML = reservesTable(await api(`/courses/public/${id}`)); stamp(); } catch { /* keep last view */ }
  }, 60000);
}

export default async function init() {
  const id = BOOT.path_params?.course_id;
  if (id) await courseView(id);
  else await listView();
}
