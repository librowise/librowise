// Course reserves: create / edit course dialog.
import { $, api, html } from "/static/js/core.js";
import { formModal, peoplePicker, str } from "/static/js/pages/lib/sc-ui.js";

/** Open the course dialog. `facets` provides department/term suggestions. Resolves with the saved course or null. */
export function courseForm(course = null, facets = { departments: [], terms: [] }) {
  const c = course || { active: true, instructors: [] };
  let picker;
  const body = html`<div class="stack">
    <div class="grid cols-3">
      <div class="field"><label for="co-code">Course code</label><input id="co-code" name="code" required maxlength="32" value="${c.code || ""}" placeholder="e.g. HIST 210" autocomplete="off"></div>
      <div class="field"><label for="co-section">Section <span class="muted">(optional)</span></label><input id="co-section" name="section" maxlength="16" value="${c.section || ""}" autocomplete="off"></div>
      <div class="field"><label for="co-term">Term</label><input id="co-term" name="term" maxlength="40" list="co-terms" value="${c.term || ""}" placeholder="e.g. Autumn 2026" autocomplete="off"></div>
    </div>
    <div class="field"><label for="co-name">Course name</label><input id="co-name" name="name" required maxlength="200" value="${c.name || ""}" autocomplete="off"></div>
    <div class="grid cols-2">
      <div class="field"><label for="co-dept">Department</label><input id="co-dept" name="department" maxlength="120" list="co-depts" value="${c.department || ""}" autocomplete="off"></div>
      <div class="field"><span class="label-like" aria-hidden="true">&nbsp;</span><label class="checkbox"><input type="checkbox" name="active" ${c.active ? "checked" : ""}> Active (reserves applied, visible in the catalogue)</label></div>
    </div>
    <datalist id="co-depts">${facets.departments.map((d) => html`<option value="${d}"></option>`)}</datalist>
    <datalist id="co-terms">${facets.terms.map((t) => html`<option value="${t}"></option>`)}</datalist>
    <fieldset class="sc-fieldset"><legend>Instructors</legend><div id="co-instructors"></div></fieldset>
    <div class="field"><label for="co-pub">Public notes <span class="muted">(shown in the catalogue)</span></label><textarea id="co-pub" name="public_notes" maxlength="4000">${c.public_notes || ""}</textarea></div>
    <div class="field"><label for="co-staff">Staff notes</label><textarea id="co-staff" name="staff_notes" maxlength="4000">${c.staff_notes || ""}</textarea></div>
  </div>`;
  return formModal({ title: course ? `Edit ${course.code}` : "New course", body, submit: course ? "Save course" : "Create course", wide: true },
    (fd) => {
      const data = {
        code: str(fd, "code"), section: str(fd, "section") || null, name: str(fd, "name"), department: str(fd, "department") || null,
        term: str(fd, "term") || null, active: !!fd.get("active"), public_notes: str(fd, "public_notes") || null,
        staff_notes: str(fd, "staff_notes") || null, instructor_ids: picker.value().map((p) => p.id),
      };
      return course ? api(`/courses/${course.id}`, { method: "PUT", body: data }) : api("/courses", { method: "POST", body: data });
    },
    (dlg) => { picker = peoplePicker($("#co-instructors", dlg), { selected: c.instructors.map((i) => ({ ...i })), label: "Add instructor" }); });
}
