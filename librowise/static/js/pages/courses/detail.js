// Staff › Course reserves › Course — detail header, "add to reserve" (scan a barcode, or find a title and pick a
// copy or the whole title) and the reserve list as a data table (edit · remove).
import { $, BOOT, api, authors, confirmDialog, date, html, icon, num, qs, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { combobox } from "/static/js/ui/combobox.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { setCrumb } from "/static/js/ui/page-header.js";
import { statusPill } from "/static/js/ui/status.js";
import { actionMenu, alertBox, recNo, wireMenus } from "/static/js/pages/lib/collection.js";
import { courseForm } from "/static/js/pages/courses/form.js";
import { formModal, optInt, str } from "/static/js/pages/lib/sc-ui.js";

const cid = () => +BOOT.path_params.course_id;
const st = { course: null, itemTypes: [], facets: { departments: [], terms: [] }, can: false, table: null, found: null };
const root = () => $("#course-detail");

function settingsFields(prefix, { itemTypeId, location }) {
  return html`<div class="field"><label for="${prefix}-type">${t("coll.crs.reserve_type")}</label>
      <select id="${prefix}-type" name="item_type_id"><option value="">${t("coll.crs.keep_type")}</option>${st.itemTypes.map((x) =>
        html`<option value="${x.id}" ${x.id === itemTypeId ? "selected" : ""}>${x.name}</option>`)}</select></div>
    <div class="field"><label for="${prefix}-loc">${t("coll.crs.reserve_location")}</label>
      <input id="${prefix}-loc" name="shelf_location" maxlength="64" value="${location ?? ""}" placeholder="${t("coll.crs.keep_location")}"></div>`;
}

function header(c) {
  const menu = st.can ? actionMenu({ label: t("coll.crs.more_actions"), items: [
    c.active ? { href: `/courses/${c.id}`, label: t("coll.crs.public_page"), icon: "globe", newTab: true } : null,
    { id: "toggle", label: c.active ? t("coll.crs.deactivate") : t("coll.crs.activate"), icon: c.active ? "x-circle" : "check-circle" },
    { separator: true },
    { id: "delete", label: t("coll.crs.delete"), icon: "trash", danger: true },
  ] }) : "";
  return html`<header class="detail-head no-cover">
    <div class="dh-main">
      <div class="dh-eyebrow">${c.department ? html`<span>${c.department}</span>` : ""}${c.term ? html`<span>${c.term}</span>` : ""}<span class="mono">${c.code}${c.section ? ` · ${c.section}` : ""}</span></div>
      <h1 id="page-title">${c.name}</h1>
      <p class="dh-meta">${c.instructors.length ? t("coll.crs.taught_by", { names: c.instructors.map((i) => i.name).join(", ") }) : html`<span class="muted">${t("coll.crs.no_instructors")}</span>`}</p>
      <div class="dh-pills">${statusPill("patron", c.active ? "active" : "inactive")}<span class="small muted">${t("coll.crs.n_reserves", { count: c.reserves.length, n: num(c.reserves.length) })}</span></div>
    </div>
    <div class="dh-actions">${menu}${st.can ? html`<button type="button" class="btn" data-course-act="edit">${icon("edit")}${t("coll.crs.edit")}</button>` : ""}
      ${st.can && !c.active ? html`<button type="button" class="btn primary" data-course-act="toggle">${icon("check-circle")}${t("coll.crs.activate_course")}</button>` : ""}</div>
  </header>
  ${c.public_notes ? alertBox(html`<span class="pre-line">${c.public_notes}</span>`, "info") : ""}
  ${c.staff_notes ? html`<p class="small muted pre-line staff-notes">${t("coll.crs.staff_notes_line", { notes: c.staff_notes })}</p>` : ""}`;
}

function addCard() {
  const res = st.itemTypes.find((x) => x.code === "RES");
  return html`<section class="card add-reserve" aria-labelledby="add-h">
    <div class="card-head"><h2 id="add-h">${icon("plus")} ${t("coll.crs.add_title")}</h2></div>
    <div class="card-body add-grid">
      <form id="scan-form" class="stack tight" autocomplete="off">
        <div class="field"><label for="scan-barcode">${t("coll.crs.scan")}</label>
          <div class="input-group"><input id="scan-barcode" name="barcode" class="mono big" maxlength="32" required placeholder="${t("coll.items.barcode")}" data-search-focus>
          <button class="btn primary">${icon("barcode")}${t("coll.auth.add")}</button></div></div>
        <details class="reserve-settings"><summary>${t("coll.crs.settings")}</summary>
          <div class="form-grid">${settingsFields("scan", { itemTypeId: res?.id, location: t("coll.crs.desk") })}
            <div class="field span-2"><label for="scan-note">${t("coll.crs.public_note")}<span class="optional">${t("ui.form.optional")}</span></label><input id="scan-note" name="public_note" maxlength="500" placeholder="${t("coll.crs.public_note_ph")}"></div></div></details>
        <div id="scan-log" class="stack tight" aria-live="polite"></div>
      </form>
      <div class="stack tight">
        <div class="field"><label for="find-q">${t("coll.crs.find")}</label><input id="find-q" type="search" placeholder="${t("coll.labels.record_placeholder")}" autocomplete="off"></div>
        <div id="find-result" aria-live="polite"></div>
      </div>
    </div></section>`;
}

function reserveColumns() {
  return [
    { key: "title", label: t("coll.field.title"), primary: true, hideable: false, csv: (r) => r.biblio.title,
      render: (r) => html`<div class="dt-cell-stack"><a href="/staff/catalog/${r.biblio.id}">${r.biblio.title}</a>
        <span class="sub">${[authors(r.biblio.authors), r.biblio.pub_year].filter(Boolean).join(" · ")}</span>
        ${r.other_courses.length ? html`<span class="sub">${t("coll.crs.also_on")} ${r.other_courses.map((o, i) => html`${i ? ", " : ""}<a href="/staff/courses/${o.id}">${o.code}</a>${o.active ? "" : ` (${t("coll.crs.inactive_lc")})`}`)}</span>` : ""}</div>` },
    { key: "copy", label: t("coll.holds.copy"), csv: (r) => r.item?.barcode || "",
      render: (r) => (r.item ? html`<div class="dt-cell-stack"><span class="mono">${r.item.barcode}</span><span class="sub">${[r.item.call_number, r.item.branch.name].filter(Boolean).join(" · ")}</span></div>` : html`<span class="small">${t("coll.crs.any_copy")}</span>`) },
    { key: "status", label: t("coll.items.status"), csv: (r) => r.item?.status || "",
      render: (r) => (r.item ? html`<div class="dt-cell-stack">${statusPill("item", r.item.status)}${r.item.due_at ? html`<span class="sub">${t("coll.items.due", { date: date(r.item.due_at) })}</span>` : ""}</div>`
        : r.availability ? statusPill("item", r.availability.available ? "available" : "on_loan", t("availability.some", { available: r.availability.available, total: r.availability.total, count: r.availability.total })) : "—") },
    { key: "where", label: t("coll.crs.type_location"), csv: (r) => (r.item ? `${r.item.item_type.name} ${r.item.shelf_location || ""}` : ""),
      render: (r) => (r.item ? html`<div class="dt-cell-stack"><span class="small">${r.item.item_type.name}${r.item.shelf_location ? ` · ${r.item.shelf_location}` : ""}</span>
          ${r.swapped && (r.original_item_type || r.original_location) ? html`<span class="sub">${t("coll.crs.normally", { where: [r.original_item_type?.name || r.item.item_type.name, r.original_location].filter(Boolean).join(" · ") })}</span>` : ""}
          ${!r.swapped && (r.reserve_item_type || r.reserve_location) ? html`<span class="sub">${t("coll.crs.on_activation", { where: [r.reserve_item_type?.name, r.reserve_location].filter(Boolean).join(" · ") })}</span>` : ""}</div>` : html`<span class="muted">—</span>`) },
    { key: "notes", label: t("coll.items.notes"), csv: (r) => r.public_note || "",
      render: (r) => html`<div class="dt-cell-stack"><span class="small">${r.public_note || ""}</span>${r.staff_note ? html`<span class="sub">${r.staff_note}</span>` : ""}</div>` },
    { key: "act", label: t("coll.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions",
      render: (r) => (st.can ? html`<div class="row-actions"><button type="button" class="btn sm ghost" data-edit-reserve="${r.id}" aria-label="${t("coll.crs.edit_reserve_named", { title: r.biblio.title })}">${icon("edit")}<span>${t("coll.common.edit")}</span></button>
        ${actionMenu({ label: t("coll.crs.reserve_actions", { title: r.biblio.title }), size: "sm", data: String(r.id), items: [{ id: "remove", label: t("coll.crs.remove"), icon: "x", danger: true }] })}</div>` : "") },
  ];
}

function render() {
  const c = st.course;
  document.title = `${c.code} · ${t("nav.courses")}`;
  setCrumb(`${c.code}${c.section ? ` · ${c.section}` : ""}`);
  const el = root();
  el.removeAttribute("aria-busy");
  el.innerHTML = html`<div id="course-head">${header(c)}</div>${st.can ? addCard() : ""}
    <section aria-labelledby="res-h" class="reserves-section"><div class="section-head"><h2 id="res-h">${t("coll.crs.on_reserve")}<span class="ph-count">${num(c.reserves.length)}</span></h2></div><div id="res-table"></div></section>`;
  wireMenus($("#course-head"), courseAction);
  st.table = dataTable($("#res-table"), {
    id: "course-reserves", caption: t("coll.crs.reserves_for", { code: c.code }), columns: reserveColumns(), exportName: `reserves-${c.code}`,
    empty: { art: "books", title: t("coll.crs.no_reserves_title"), body: t("coll.crs.no_reserves_body") },
  });
  paintReserves();
  if (st.can) wireAdd();
}

function paintReserves() {
  st.table.setRows(st.course.reserves);
  wireMenus($("#res-table"), async (act, btn, key) => { if (act === "remove") await removeReserve(+key); });
  $("#res-h .ph-count").textContent = num(st.course.reserves.length);
}

async function reload() {
  st.course = await api(`/courses/${cid()}`);
  $("#course-head").innerHTML = header(st.course);
  wireMenus($("#course-head"), courseAction);
  paintReserves();
}

function settingsFrom(form) {
  const fd = new FormData(form);
  return { item_type_id: optInt(fd.get("item_type_id")), shelf_location: str(fd, "shelf_location") || null, public_note: str(fd, "public_note") || null };
}

async function addReserve(payload, label) {
  const r = await api(`/courses/${cid()}/reserves`, { method: "POST", body: payload });
  const where = r.swapped ? ` → ${[r.item.item_type.name, r.item.shelf_location].filter(Boolean).join(" · ")}` : "";
  $("#scan-log").insertAdjacentHTML("afterbegin", alertBox(html`<strong>${label || r.biblio.title}</strong> ${t("coll.crs.added")}${where}`, "ok"));
  await reload();
  return r;
}

function wireAdd() {
  const form = $("#scan-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#scan-barcode");
    const barcode = input.value.trim();
    if (!barcode) { input.focus(); return; }
    try {
      await withBusy($("button.primary", form), () => addReserve({ barcode, ...settingsFrom(form) }, t("coll.crs.item_label", { barcode })));
      input.value = "";
    } catch { /* toasted */ }
    input.focus();
  });
  combobox($("#find-q"), {
    minChars: 2,
    source: async (q, signal) => (await api(`/search?${qs({ q, per_page: 8 })}`, { signal })).results,
    render: (b) => html`<span class="combo-main">${b.title}<span class="sub">${[authors(b.authors), b.pub_year, recNo(b.id)].filter(Boolean).join(" · ")}</span></span>`,
    value: (b) => b.title,
    onSelect: (b) => showCopies(b.id),
  });
}

async function showCopies(id) {
  const box = $("#find-result");
  box.innerHTML = html`<div class="skeleton sk-line w-70"></div><div class="skeleton sk-line w-50"></div>`;
  try {
    const b = await api(`/biblios/${id}`);
    st.found = b;
    const usable = b.items.filter((i) => !["withdrawn", "lost"].includes(i.status));
    box.innerHTML = html`<div class="found card">
      <div class="found-head"><strong>${b.title}</strong><button type="button" class="btn sm" data-reserve-title="${b.id}">${icon("plus")}${t("coll.crs.whole_title")}</button></div>
      ${usable.length ? html`<ul class="copy-list" role="list">${usable.map((i) => html`<li><span class="mono">${i.barcode}</span>
          <span class="small muted">${i.branch.name} · ${i.item_type.name}</span>${statusPill("item", i.status)}
          <button type="button" class="btn sm" data-reserve-item="${i.barcode}" aria-label="${t("coll.crs.reserve_copy_named", { barcode: i.barcode })}">${t("coll.crs.reserve_copy")}</button></li>`)}</ul>`
        : html`<p class="small muted">${t("coll.crs.no_copies")}</p>`}</div>`;
  } catch (e) { box.innerHTML = errorState(e, { retry: false }); }
}

async function editReserve(id) {
  const r = st.course.reserves.find((x) => x.id === id);
  if (!r) return;
  const out = await formModal({ title: t("coll.crs.edit_reserve"), submit: t("common.save"), body: html`<div class="stack">
    <p><strong>${r.biblio.title}</strong>${r.item ? html` · <span class="mono">${r.item.barcode}</span>` : ` (${t("coll.crs.whole_title_lc")})`}</p>
    ${r.item ? html`<div class="form-grid">${settingsFields("er", { itemTypeId: r.reserve_item_type?.id, location: r.reserve_location })}</div>
      ${r.other_courses.length ? alertBox(t("coll.crs.shared_settings", { codes: r.other_courses.map((o) => o.code).join(", ") }), "info") : ""}` : ""}
    <div class="field"><label for="er-pub">${t("coll.crs.public_note")}</label><input id="er-pub" name="public_note" maxlength="500" value="${r.public_note || ""}"></div>
    <div class="field"><label for="er-staff">${t("coll.crs.staff_note")}</label><input id="er-staff" name="staff_note" maxlength="500" value="${r.staff_note || ""}"></div></div>` },
  (fd) => {
    const data = { public_note: str(fd, "public_note") || null, staff_note: str(fd, "staff_note") || null };
    if (r.item) Object.assign(data, { item_type_id: optInt(fd.get("item_type_id")), shelf_location: str(fd, "shelf_location") || null });
    return api(`/courses/reserves/${id}`, { method: "PATCH", body: data });
  });
  if (out) { toast(t("coll.crs.reserve_saved"), "success"); await reload(); }
}

async function removeReserve(id) {
  const r = st.course.reserves.find((x) => x.id === id);
  if (!r) return;
  const restores = r.item && r.swapped && !r.other_courses.some((o) => o.active);
  if (!(await confirmDialog(t("coll.crs.remove_title"), `${t("coll.crs.remove_text", { title: r.biblio.title, code: st.course.code })}${restores ? ` ${t("coll.crs.remove_restores")}` : ""}`, t("coll.crs.remove")))) return;
  try {
    const out = await api(`/courses/reserves/${id}`, { method: "DELETE" });
    toast(out.restored ? t("coll.crs.removed_restored") : t("coll.crs.removed"), "success");
    await reload();
  } catch (e) { toast(e.message, "error"); }
}

async function courseAction(act, btn) {
  const c = st.course;
  try {
    if (act === "edit") {
      const out = await courseForm(c, st.facets);
      if (out) { toast(t("coll.crs.saved"), "success"); await reload(); }
    } else if (act === "toggle") {
      const out = await api("/courses/bulk-status", { method: "POST", body: { active: !c.active, course_ids: [c.id] } });
      toast(t(c.active ? "coll.crs.deactivated" : "coll.crs.activated", { count: 1, n: num(1), items: num(c.active ? out.restored : out.swapped) }), "success");
      await reload();
    } else if (act === "delete") {
      if (!(await confirmDialog(t("coll.crs.delete_title", { code: c.code }), t("coll.crs.delete_text", { count: c.reserves.length, n: num(c.reserves.length) }), t("coll.crs.delete")))) return;
      await api(`/courses/${c.id}`, { method: "DELETE" });
      location.href = "/staff/courses";
    }
  } catch (e) { if (!e.toasted) toast(e.message, "error"); }
  return btn;
}

export default async function init() {
  st.can = root().dataset.canWrite === "1";
  try {
    const [course, lookups, list] = await Promise.all([api(`/courses/${cid()}`), api("/lookups"), api("/courses").catch(() => null)]);
    st.course = course;
    st.itemTypes = lookups.item_types || [];
    if (list) st.facets = list.facets;
  } catch (e) {
    root().removeAttribute("aria-busy");
    root().innerHTML = e.status === 404 ? emptyState({ art: "search", title: t("coll.crs.not_found"), actions: html`<a class="btn primary" href="/staff/courses">${t("coll.crs.all_courses")}</a>` }) : errorState(e, { retry: false });
    return;
  }
  render();
  root().addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.courseAct) await courseAction(b.dataset.courseAct, b);
      else if (b.dataset.editReserve) await editReserve(+b.dataset.editReserve);
      else if (b.dataset.reserveTitle) {
        const s = settingsFrom($("#scan-form"));
        await withBusy(b, () => addReserve({ biblio_id: +b.dataset.reserveTitle, public_note: s.public_note }, st.found?.title));
        $("#find-result").innerHTML = "";
        $("#find-q").value = "";
      } else if (b.dataset.reserveItem) {
        await withBusy(b, () => addReserve({ barcode: b.dataset.reserveItem, ...settingsFrom($("#scan-form")) }, t("coll.crs.item_label", { barcode: b.dataset.reserveItem })));
        if (st.found) showCopies(st.found.id);
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
  $("#scan-barcode")?.focus();
}
