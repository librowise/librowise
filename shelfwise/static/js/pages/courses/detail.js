// Staff: one course — instructors, reserve list, add reserves by barcode scan or record search.
import {
  $, $$, BOOT, api, authors, availabilityBadge, badge, confirmDialog, date, empty, html, icon, qs, skeleton, toast, withBusy,
} from "/static/js/core.js";
import { courseForm } from "/static/js/pages/courses/form.js";
import { errorBox, formModal, optInt, plural, str } from "/static/js/pages/lib/sc-ui.js";

const cid = () => +BOOT.path_params.course_id;
const st = { course: null, itemTypes: [], facets: { departments: [], terms: [] } };
const RES_LOCATION = "Course reserves desk";

function settingsFields(prefix, { itemTypeId, location }) {
  return html`<div class="field"><label for="${prefix}-type">While on reserve, item type becomes</label>
      <select id="${prefix}-type" name="item_type_id"><option value="">Keep current item type</option>${st.itemTypes.map((t) =>
        html`<option value="${t.id}" ${t.id === itemTypeId ? "selected" : ""}>${t.name}</option>`)}</select></div>
    <div class="field"><label for="${prefix}-loc">and shelf location becomes</label>
      <input id="${prefix}-loc" name="shelf_location" maxlength="64" value="${location ?? ""}" placeholder="Keep current location" data-no-submit></div>`;
}

function header(c) {
  return html`<div class="page-head">
    <div>
      <div class="row tight" style="margin-bottom:.35rem">${c.active ? badge("ok", "Active") : badge("", "Inactive")}
        ${c.term ? badge("info", c.term) : ""}${c.department ? html`<span class="small muted">${c.department}</span>` : ""}</div>
      <h1>${c.code}${c.section ? ` · ${c.section}` : ""} — ${c.name}</h1>
      <div class="sub">${c.instructors.length ? html`Taught by ${c.instructors.map((i) => i.name).join(", ")}` : "No instructors assigned"}</div>
    </div>
    <div class="row tight">
      ${c.active ? html`<a class="btn ghost" href="/courses/${c.id}" target="_blank" rel="noopener">${icon("globe")}Public page</a>` : ""}
      <button class="btn" data-course-act="edit">${icon("edit")}Edit</button>
      <button class="btn" data-course-act="toggle">${c.active ? "Deactivate" : "Activate"}</button>
      <button class="btn danger" data-course-act="delete">${icon("trash")}Delete</button>
    </div></div>
    ${c.public_notes ? html`<div class="alert info" style="margin-bottom:1rem">${icon("info")}<div style="white-space:pre-line">${c.public_notes}</div></div>` : ""}
    ${c.staff_notes ? html`<p class="small muted" style="white-space:pre-line">Staff notes: ${c.staff_notes}</p>` : ""}`;
}

function addCard() {
  const res = st.itemTypes.find((t) => t.code === "RES");
  return html`<section class="card pad stack" aria-labelledby="add-h">
    <h2 id="add-h" style="margin:0">Add to reserve</h2>
    <form id="scan-form" class="stack tight" autocomplete="off">
      <div class="field"><label for="scan-barcode">Scan or type an item barcode</label>
        <div class="input-group"><input id="scan-barcode" name="barcode" class="mono" maxlength="32" required placeholder="Barcode" data-search-focus>
        <button class="btn primary">${icon("barcode")}Add</button></div></div>
      <div class="grid cols-2">${settingsFields("scan", { itemTypeId: res?.id, location: RES_LOCATION })}</div>
      <div class="field"><label for="scan-note">Public note <span class="muted">(optional)</span></label><input id="scan-note" name="public_note" maxlength="500" placeholder="e.g. Read chapters 1–3 for week 2"></div>
    </form>
    <div id="scan-log" class="stack tight" aria-live="polite"></div>
    <hr class="sc-sep">
    <form id="find-form" class="stack tight" role="search">
      <div class="field"><label for="find-q">…or find a title in the catalogue</label>
        <div class="input-group"><input id="find-q" name="q" type="search" placeholder="Title, author or ISBN" required>
        <button class="btn">${icon("search")}Search</button></div></div>
    </form>
    <div id="find-results" class="stack tight"></div>
  </section>`;
}

function reserveRow(r) {
  const i = r.item;
  const other = r.other_courses.length ? html`<div class="tiny muted">Also on: ${r.other_courses.map((o) => html`<a href="/staff/courses/${o.id}">${o.code}</a>${o.active ? "" : " (inactive)"} `)}</div>` : "";
  return html`<tr>
    <td><a href="/staff/catalog/${r.biblio.id}"><strong>${r.biblio.title}</strong></a><div class="tiny muted">${authors(r.biblio.authors)}${r.biblio.pub_year ? ` · ${r.biblio.pub_year}` : ""}</div>${other}</td>
    <td>${i ? html`<span class="mono small">${i.barcode}</span><div class="tiny muted">${i.call_number || ""} · ${i.branch.name}</div>` : html`<span class="small">Any copy</span>`}</td>
    <td>${i ? html`${badge(i.status)}${i.due_at ? html`<div class="tiny muted">Due ${date(i.due_at)}</div>` : ""}` : availabilityBadge(r.availability)}</td>
    <td class="small">${i ? html`${i.item_type.name}${i.shelf_location ? html` · ${i.shelf_location}` : ""}
        ${r.swapped && (r.original_item_type || r.original_location) ? html`<div class="tiny muted">Normally ${r.original_item_type?.name || i.item_type.name}${r.original_location ? ` · ${r.original_location}` : ""}</div>` : ""}
        ${!r.swapped && (r.reserve_item_type || r.reserve_location) ? html`<div class="tiny muted">On activation: ${[r.reserve_item_type?.name, r.reserve_location].filter(Boolean).join(" · ")}</div>` : ""}`
      : html`<span class="muted">—</span>`}</td>
    <td class="small">${r.public_note || ""}${r.staff_note ? html`<div class="tiny muted">${r.staff_note}</div>` : ""}</td>
    <td class="right nowrap"><button class="btn sm" data-edit-reserve="${r.id}" aria-label="Edit reserve ${r.biblio.title}">${icon("edit")}Edit</button>
      <button class="btn sm danger" data-remove-reserve="${r.id}" aria-label="Remove ${r.biblio.title} from reserve">${icon("x")}Remove</button></td></tr>`;
}

function reservesCard(c) {
  return html`<section class="card flush" aria-labelledby="res-h">
    <div class="card-head" style="padding-bottom:var(--pad)"><h2 id="res-h">On reserve <span class="muted small">(${c.reserves.length})</span></h2></div>
    <div class="card-body">${c.reserves.length ? html`<div class="table-wrap"><table class="table">
      <caption class="sr-only">Reserve items for ${c.code}</caption>
      <thead><tr><th scope="col">Title</th><th scope="col">Copy</th><th scope="col">Status</th><th scope="col">Reserve type &amp; location</th><th scope="col">Notes</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${c.reserves.map(reserveRow)}</tbody></table></div>` : empty("Nothing on reserve yet. Scan a barcode to add items.", "bookmark")}</div></section>`;
}

function render() {
  const c = st.course;
  document.title = `${c.code} · Course reserves`;
  $("#course-detail").innerHTML = html`<div id="course-head">${header(c)}</div>
    <div class="grid split"><div id="course-reserves">${reservesCard(c)}</div><div>${addCard()}</div></div>`;
}

async function reload() {
  st.course = await api(`/courses/${cid()}`);
  $("#course-head").innerHTML = header(st.course);
  $("#course-reserves").innerHTML = reservesCard(st.course);
}

function settingsFrom(form) {
  const fd = new FormData(form);
  return { item_type_id: optInt(fd.get("item_type_id")), shelf_location: str(fd, "shelf_location") || null, public_note: str(fd, "public_note") || null };
}

async function addReserve(payload, label) {
  const r = await api(`/courses/${cid()}/reserves`, { method: "POST", body: payload });
  const note = r.swapped ? ` → ${r.item.item_type.name}${r.item.shelf_location ? ` · ${r.item.shelf_location}` : ""}` : "";
  $("#scan-log").insertAdjacentHTML("afterbegin", html`<div class="alert ok small">${icon("check")}<div><strong>${label || r.biblio.title}</strong> added${note}</div></div>`);
  await reload();
  return r;
}

async function search(q) {
  const box = $("#find-results");
  box.innerHTML = skeleton(3);
  try {
    const r = await api(`/search?${qs({ q, per_page: 8 })}`);
    box.innerHTML = r.results.length ? html`${r.results.map((b) => html`<div class="sc-find">
      <div class="grow"><strong>${b.title}</strong><div class="tiny muted">${authors(b.authors)}${b.pub_year ? ` · ${b.pub_year}` : ""}</div></div>
      <button class="btn sm" data-reserve-title="${b.id}" data-title="${b.title}">Whole title</button>
      <button class="btn sm" data-show-copies="${b.id}" aria-expanded="false">Copies…</button>
      <div class="sc-copies hidden" id="copies-${b.id}"></div></div>`)}`
      : empty("No matching titles.");
  } catch (e) { box.innerHTML = errorBox(e.message); }
}

async function showCopies(btn) {
  const id = +btn.dataset.showCopies;
  const box = $(`#copies-${id}`);
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", String(!open));
  box.classList.toggle("hidden", open);
  if (open || box.dataset.loaded) return;
  box.innerHTML = skeleton(2);
  try {
    const b = await api(`/biblios/${id}`);
    box.dataset.loaded = "1";
    box.innerHTML = b.items.length ? html`${b.items.map((i) => html`<div class="row tight small">
      <span class="mono">${i.barcode}</span><span class="muted">${i.branch.name} · ${i.item_type.name}</span>${badge(i.status)}
      <button class="btn sm" data-reserve-item="${i.barcode}">Reserve copy</button></div>`)}` : html`<p class="small muted">No copies.</p>`;
  } catch (e) { box.innerHTML = errorBox(e.message); }
}

async function editReserve(id) {
  const r = st.course.reserves.find((x) => x.id === id);
  if (!r) return;
  const body = html`<div class="stack">
    <p style="margin:0"><strong>${r.biblio.title}</strong>${r.item ? html` · <span class="mono">${r.item.barcode}</span>` : " (whole title)"}</p>
    ${r.item ? html`<div class="grid cols-2">${settingsFields("er", { itemTypeId: r.reserve_item_type?.id, location: r.reserve_location })}</div>
      ${r.other_courses.length ? html`<p class="small muted" style="margin:0">${icon("info")} These settings are shared with ${r.other_courses.map((o) => o.code).join(", ")}.</p>` : ""}` : ""}
    <div class="field"><label for="er-pub">Public note</label><input id="er-pub" name="public_note" maxlength="500" value="${r.public_note || ""}"></div>
    <div class="field"><label for="er-staff">Staff note</label><input id="er-staff" name="staff_note" maxlength="500" value="${r.staff_note || ""}"></div></div>`;
  const out = await formModal({ title: "Edit reserve", body, submit: "Save" }, (fd) => {
    const data = { public_note: str(fd, "public_note") || null, staff_note: str(fd, "staff_note") || null };
    if (r.item) Object.assign(data, { item_type_id: optInt(fd.get("item_type_id")), shelf_location: str(fd, "shelf_location") || null });
    return api(`/courses/reserves/${id}`, { method: "PATCH", body: data });
  });
  if (out) { toast("Reserve updated", "success"); await reload(); }
}

async function removeReserve(id, btn) {
  const r = st.course.reserves.find((x) => x.id === id);
  if (!r) return;
  const restores = r.item && r.swapped && !r.other_courses.some((o) => o.active);
  if (!(await confirmDialog("Remove from reserve?", `Remove “${r.biblio.title}”${r.item ? ` (${r.item.barcode})` : ""} from ${st.course.code}?`
    + (restores ? " The item's original item type and shelf location will be restored." : ""), "Remove"))) return;
  try {
    const out = await withBusy(btn, () => api(`/courses/reserves/${id}`, { method: "DELETE" }));
    toast(out.restored ? "Removed · item restored to its normal type and location" : "Removed from reserve", "success");
    await reload();
  } catch { /* toasted */ }
}

async function courseAction(act, btn) {
  const c = st.course;
  if (act === "edit") {
    const out = await courseForm(c, st.facets);
    if (out) { toast("Course saved", "success"); await reload(); }
  } else if (act === "toggle") {
    try {
      const out = await withBusy(btn, () => api("/courses/bulk-status", { method: "POST", body: { active: !c.active, course_ids: [c.id] } }));
      toast(c.active ? `Deactivated · ${plural(out.restored, "item")} restored` : `Activated · ${plural(out.swapped, "item")} moved to reserve`, "success");
      await reload();
    } catch { /* toasted */ }
  } else if (act === "delete") {
    if (!(await confirmDialog(`Delete ${c.code}?`, `Delete the course and its ${plural(c.reserves.length, "reserve")}? Items return to their normal type and location unless another active course still reserves them.`, "Delete course"))) return;
    try {
      await withBusy(btn, () => api(`/courses/${c.id}`, { method: "DELETE" }));
      location.href = "/staff/courses";
    } catch { /* toasted */ }
  }
}

export default async function init() {
  const root = $("#course-detail");
  try {
    const [course, lookups, list] = await Promise.all([api(`/courses/${cid()}`), api("/lookups"), api("/courses").catch(() => null)]);
    st.course = course;
    st.itemTypes = lookups.item_types || [];
    if (list) st.facets = list.facets;
  } catch (e) {
    root.innerHTML = e.status === 404 ? empty("This course does not exist.", "alert") : errorBox(e.message);
    return;
  }
  render();
  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $("button", form);
    if (form.id === "scan-form") {
      const input = $("#scan-barcode");
      const barcode = input.value.trim();
      if (!barcode) return;
      try {
        await withBusy(btn, () => addReserve({ barcode, ...settingsFrom(form) }, `Item ${barcode}`));
        input.value = "";
      } catch { /* toasted */ }
      input.focus();
    } else if (form.id === "find-form") {
      search($("#find-q").value.trim());
    }
  });
  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const scan = $("#scan-form");
    try {
      if (t.dataset.courseAct) await courseAction(t.dataset.courseAct, t);
      else if (t.dataset.editReserve) await editReserve(+t.dataset.editReserve);
      else if (t.dataset.removeReserve) await removeReserve(+t.dataset.removeReserve, t);
      else if (t.dataset.showCopies) await showCopies(t);
      else if (t.dataset.reserveTitle) {
        const s = settingsFrom(scan);
        await withBusy(t, () => addReserve({ biblio_id: +t.dataset.reserveTitle, public_note: s.public_note }, t.dataset.title));
      } else if (t.dataset.reserveItem) {
        await withBusy(t, () => addReserve({ barcode: t.dataset.reserveItem, ...settingsFrom(scan) }, `Item ${t.dataset.reserveItem}`));
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
  $("#scan-barcode").focus();
}
