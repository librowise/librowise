// Course reserves: create / edit course dialog.
import { $, api, html } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { formModal, peoplePicker, str } from "/static/js/pages/lib/sc-ui.js";

/** Open the course dialog. `facets` provides department/term suggestions. Resolves with the saved course or null. */
export function courseForm(course = null, facets = { departments: [], terms: [] }) {
  const c = course || { active: true, instructors: [] };
  let picker;
  const body = html`<div class="stack">
    <div class="form-grid three">
      <div class="field"><label for="co-code">${t("coll.crs.code")}<span class="req" aria-hidden="true">*</span></label><input id="co-code" name="code" required maxlength="32" value="${c.code || ""}" placeholder="${t("coll.crs.code_ph")}" autocomplete="off"></div>
      <div class="field"><label for="co-section">${t("coll.crs.section")}<span class="optional">${t("ui.form.optional")}</span></label><input id="co-section" name="section" maxlength="16" value="${c.section || ""}" autocomplete="off"></div>
      <div class="field"><label for="co-term">${t("coll.crs.term")}</label><input id="co-term" name="term" maxlength="40" list="co-terms" value="${c.term || ""}" placeholder="${t("coll.crs.term_ph")}" autocomplete="off"></div>
    </div>
    <div class="field"><label for="co-name">${t("coll.crs.name")}<span class="req" aria-hidden="true">*</span></label><input id="co-name" name="name" required maxlength="200" value="${c.name || ""}" autocomplete="off"></div>
    <div class="form-grid">
      <div class="field"><label for="co-dept">${t("coll.crs.department")}</label><input id="co-dept" name="department" maxlength="120" list="co-depts" value="${c.department || ""}" autocomplete="off"></div>
      <label class="checkbox co-active"><input type="checkbox" name="active" ${c.active ? "checked" : ""}> ${t("coll.crs.active_help")}</label>
    </div>
    <datalist id="co-depts">${facets.departments.map((d) => html`<option value="${d}"></option>`)}</datalist>
    <datalist id="co-terms">${facets.terms.map((x) => html`<option value="${x}"></option>`)}</datalist>
    <fieldset class="sc-fieldset"><legend>${t("coll.crs.instructors")}</legend><div id="co-instructors"></div></fieldset>
    <div class="field"><label for="co-pub">${t("coll.crs.public_notes")}<span class="optional">${t("coll.crs.public_notes_hint")}</span></label><textarea id="co-pub" name="public_notes" maxlength="4000">${c.public_notes || ""}</textarea></div>
    <div class="field"><label for="co-staff">${t("coll.crs.staff_notes")}</label><textarea id="co-staff" name="staff_notes" maxlength="4000">${c.staff_notes || ""}</textarea></div>
  </div>`;
  return formModal({ title: course ? t("coll.crs.edit_title", { code: course.code }) : t("coll.crs.new"), body, submit: course ? t("coll.crs.save") : t("coll.crs.create"), size: "lg" },
    (fd) => {
      const data = {
        code: str(fd, "code"), section: str(fd, "section") || null, name: str(fd, "name"), department: str(fd, "department") || null,
        term: str(fd, "term") || null, active: !!fd.get("active"), public_notes: str(fd, "public_notes") || null,
        staff_notes: str(fd, "staff_notes") || null, instructor_ids: picker.value().map((p) => p.id),
      };
      return course ? api(`/courses/${course.id}`, { method: "PUT", body: data }) : api("/courses", { method: "POST", body: data });
    },
    (dlg) => { picker = peoplePicker($("#co-instructors", dlg), { selected: c.instructors.map((i) => ({ ...i })), label: t("coll.crs.add_instructor") }); });
}
