// OPAC: browse course reserves and see live availability of each course's readings.
import { $, BOOT, api, authors, availabilityBadge, cover, date, debounce, html, icon, qs, relative } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { statusPill } from "/static/js/ui/status.js";

const view = () => $("#courses-view");
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ course list

function courseCard(c) {
  return html`<a class="course-card" href="/courses/${c.id}">
    <div class="row between tight"><span class="cc-code">${c.code}${c.section ? ` · ${c.section}` : ""}</span>${c.term ? html`<span class="badge info">${icon("calendar")}${c.term}</span>` : ""}</div>
    <h2>${c.name}</h2>
    <div class="cc-meta">${c.department ? html`<span>${icon("layers")}${c.department}</span>` : ""}
      ${c.instructors.length ? html`<span>${icon("user")}${c.instructors.map((i) => i.name).join(", ")}</span>` : ""}</div>
    <div class="cc-foot"><span>${t("opac.courses.on_reserve_n", { count: c.reserve_count })}</span>${icon("arrow-right", "flip-rtl")}</div></a>`;
}

async function listView() {
  const f = { q: params.get("q") || "", department: params.get("department") || "", term: params.get("term") || "", instructor: params.get("instructor") || "" };
  const form = $("#oc-filters"), results = $("#oc-results");
  let facetsDone = false, seq = 0;
  const load = async () => {
    const mine = ++seq;
    const fd = new FormData(form);
    // Until the facet options are loaded, the department/term selects cannot hold the URL's values.
    const query = facetsDone ? { q: String(fd.get("q") || "").trim(), department: fd.get("department"), term: fd.get("term"),
      instructor: String(fd.get("instructor") || "").trim() } : { ...f };
    history.replaceState(null, "", `${location.pathname}${qs(query) ? `?${qs(query)}` : ""}`);
    try {
      const r = await api(`/courses/public?${qs(query)}`);
      if (mine !== seq) return;
      if (!facetsDone) {
        const fill = (sel, values, cur) => values.forEach((v) => sel.insertAdjacentHTML("beforeend", html`<option value="${v}" ${v === cur ? "selected" : ""}>${v}</option>`));
        fill($("#oc-dept"), r.facets.departments, f.department);
        fill($("#oc-term"), r.facets.terms, f.term);
        facetsDone = true;
      }
      $("#oc-count").textContent = t("opac.courses.count", { count: r.total });
      const filtered = Object.values(query).some(Boolean);
      results.innerHTML = r.results.length ? html`<div class="course-grid">${r.results.map(courseCard)}</div>`
        : emptyState({ art: "search", title: filtered ? t("opac.courses.none_match") : t("opac.courses.none"),
          body: filtered ? t("opac.courses.none_match_body") : t("opac.courses.none_body"),
          actions: filtered ? html`<a class="btn" href="/courses">${t("ui.filters.clear_all")}</a>` : "" });
    } catch (e) {
      results.innerHTML = errorState(e);
    }
    results.removeAttribute("aria-busy");
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); load(); });
  form.addEventListener("change", load);
  form.addEventListener("input", debounce(load, 350));
  results.addEventListener("click", (e) => { if (e.target.closest("[data-retry]")) load(); });
  await load();
}

// ------------------------------------------------------------------ one course

function status(r) {
  if (!r.item) return availabilityBadge(r.availability);
  const i = r.item;
  if (i.status === "on_loan") return html`${statusPill("item", "on_loan")}${i.due_at ? html`<span class="tiny muted">${t("opac.courses.due", { date: date(i.due_at), when: relative(i.due_at) })}</span>` : ""}`;
  return statusPill("item", i.status);
}

function reservesList(c) {
  if (!c.reserves.length) return emptyState({ art: "books", title: t("opac.courses.no_reserves"), body: t("opac.courses.no_reserves_body") });
  return html`<ul class="reserve-list">${c.reserves.map((r) => html`<li class="reserve-row">
    <a href="/record/${r.biblio.id}" tabindex="-1" aria-hidden="true">${cover(r.biblio)}</a>
    <div style="min-width:0"><h3><a href="/record/${r.biblio.id}">${r.biblio.title}</a></h3>
      <div class="small muted">${[authors(r.biblio.authors), r.biblio.pub_year].filter(Boolean).join(" · ")}</div>
      ${r.public_note ? html`<div class="small" style="margin-top:.25rem">${icon("info")} ${r.public_note}</div>` : ""}</div>
    <div class="rr-where">${r.item ? html`<strong>${r.item.branch.name}</strong>${r.item.shelf_location ? html` · ${r.item.shelf_location}` : ""}
        <div><span class="mono">${r.item.call_number || ""}</span>${r.item.item_type?.name ? html` · ${r.item.item_type.name}` : ""}</div>`
      : html`${t("opac.courses.any_copy")} · <a href="/record/${r.biblio.id}">${t("opac.courses.see_copies")}</a>`}</div>
    <div class="rr-status">${status(r)}</div></li>`)}</ul>`;
}

async function courseView(id) {
  let c;
  try {
    c = await api(`/courses/public/${id}`);
  } catch (e) {
    view().innerHTML = html`<nav class="crumbs-opac" aria-label="${t("opac.record.breadcrumb")}"><a href="/courses">${icon("chevron-left", "icon-back")}${t("opac.courses.all")}</a></nav>
      ${e.status === 404 ? emptyState({ art: "search", title: t("opac.courses.not_found"), body: t("opac.courses.not_found_body"),
        actions: html`<a class="btn primary" href="/courses">${t("opac.courses.all")}</a>` }) : errorState(e)}`;
    return;
  }
  document.title = `${c.code} · ${document.title}`;
  const instructors = c.instructors.map((i, n) => html`${n ? ", " : ""}<a href="/courses?${qs({ instructor: i.name })}">${i.name}</a>`);
  view().innerHTML = html`<nav class="crumbs-opac" aria-label="${t("opac.record.breadcrumb")}"><a href="/courses">${icon("chevron-left", "icon-back")}${t("opac.courses.all")}</a></nav>
    <header class="course-head"><div>
      <div class="row tight">${c.term ? html`<span class="badge info">${icon("calendar")}${c.term}</span>` : ""}${c.department ? html`<span class="small muted">${c.department}</span>` : ""}</div>
      <h1><span class="course-code">${c.code}${c.section ? ` · ${c.section}` : ""}</span>${c.name}</h1>
      ${c.instructors.length ? html`<p class="lead" style="margin:.3rem 0 0">${t("opac.courses.taught_by")} ${instructors}</p>` : ""}
    </div><span class="tiny muted" id="oc-updated" aria-live="polite"></span></header>
    ${c.public_notes ? html`<div class="alert info" style="margin-bottom:1.25rem">${icon("info")}<div style="white-space:pre-line">${c.public_notes}</div></div>` : ""}
    <section aria-labelledby="oc-reserves-h"><div class="section-head"><h2 id="oc-reserves-h">${t("opac.courses.readings")}</h2>
      <span class="small muted">${t("opac.courses.on_reserve_n", { count: c.reserves.length })}</span></div>
      <div id="oc-reserves">${reservesList(c)}</div></section>`;
  const stamp = () => { $("#oc-updated").textContent = t("opac.courses.updated", { time: new Date().toLocaleTimeString(document.documentElement.lang || [], { hour: "2-digit", minute: "2-digit" }) }); };
  stamp();
  // Keep availability live while the page is open and visible.
  setInterval(async () => {
    if (document.hidden) return;
    try { $("#oc-reserves").innerHTML = reservesList(await api(`/courses/public/${id}`)); stamp(); } catch { /* keep last view */ }
  }, 60000);
}

export default async function init() {
  const id = BOOT.path_params?.course_id;
  if (id) await courseView(id);
  else await listView();
}
