// Serials: create / edit subscription dialog with a live preview of the next predicted issues.
import { $, $$, api, date, debounce, html, icon, money, qs } from "/static/js/core.js";
import { errorBox, formModal, isoDay, optInt, paise, str } from "/static/js/pages/lib/sc-ui.js";

const LEVELS = ["X", "Y", "Z"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_BASED = new Set(["daily", "weekly", "fortnightly", "every_n_days", "every_n_weeks"]);

let refCache = null;
/** Reference data for the form: lookups, vendors, budgets and serial metadata (cached per page). */
export async function loadRefs() {
  if (refCache) return refCache;
  const [lookups, vendors, budgets, meta] = await Promise.all([
    api("/lookups"),
    api("/acquisitions/vendors").catch(() => ({ results: [] })),
    api("/acquisitions/budgets").catch(() => ({ results: [] })),
    api("/serials/meta"),
  ]);
  refCache = { branches: lookups.branches || [], itemTypes: lookups.item_types || [], vendors: vendors.results,
    budgets: budgets.results, meta };
  return refCache;
}

function levelRow(key, lvl) {
  const on = !!lvl;
  const v = lvl || { start: 1, increment: 1, max: null, reset: 1, yearly: false, labels: [] };
  return html`<tr data-level="${key}">
    <th scope="row"><label class="checkbox"><input type="checkbox" name="lvl_${key}_on" ${on ? "checked" : ""}> {${key}}</label></th>
    <td><input type="number" name="lvl_${key}_start" value="${v.start}" min="0" aria-label="${key} start value"></td>
    <td><input type="number" name="lvl_${key}_increment" value="${v.increment}" min="1" aria-label="${key} increment"></td>
    <td><input type="number" name="lvl_${key}_max" value="${v.max ?? ""}" min="1" placeholder="—" aria-label="${key} rollover after"></td>
    <td><input type="number" name="lvl_${key}_reset" value="${v.reset}" min="0" aria-label="${key} reset to"></td>
    <td class="center"><input type="checkbox" name="lvl_${key}_yearly" ${v.yearly ? "checked" : ""} aria-label="${key} restarts each year"></td>
    <td><input type="text" name="lvl_${key}_labels" value="${(v.labels || []).join(", ")}" placeholder="e.g. Spring, Summer…" aria-label="${key} labels"></td>
  </tr>`;
}

function body(sub, refs) {
  const s = sub || {};
  const opt = (rows, sel, label = (r) => r.name) => rows.map((r) => html`<option value="${r.id}" ${r.id === sel ? "selected" : ""}>${label(r)}</option>`);
  const mag = refs.itemTypes.find((t) => t.code === "MAG");
  const itemTypeSel = s.item_type_id ?? mag?.id;
  const freq = s.frequency || "monthly";
  return html`<div class="grid split sc-form">
  <div class="stack">
    <fieldset class="stack tight"><legend>Serial record</legend>
      ${sub ? html`<p style="margin:0"><strong>${s.biblio.title}</strong> ${s.biblio.issn ? html`<span class="muted small">ISSN ${s.biblio.issn}</span>` : ""}</p>
        <input type="hidden" name="biblio_id" value="${s.biblio.id}">`
      : html`<div class="field"><label for="sf-bq">Find a serial record</label>
          <div class="input-group"><input id="sf-bq" type="search" placeholder="Title or ISSN" autocomplete="off" data-no-submit>
          <button type="button" class="btn" id="sf-bsearch">${icon("search")}<span class="sr-only">Search records</span></button></div></div>
        <div id="sf-bresults" class="row tight" role="list"></div>
        <input type="hidden" name="biblio_id" id="sf-biblio">
        <div id="sf-bchosen" class="small" aria-live="polite"></div>
        <label class="checkbox"><input type="checkbox" name="new_biblio" id="sf-newb"> Create a new serial record</label>
        <div class="grid cols-3 hidden" id="sf-newfields">
          <div class="field"><label for="sf-nt">Title</label><input id="sf-nt" name="nb_title" maxlength="500"></div>
          <div class="field"><label for="sf-ni">ISSN</label><input id="sf-ni" name="nb_issn" maxlength="20" class="mono"></div>
          <div class="field"><label for="sf-np">Publisher</label><input id="sf-np" name="nb_publisher" maxlength="255"></div>
        </div>`}
    </fieldset>

    <fieldset class="grid cols-3"><legend>Ordering</legend>
      <div class="field"><label for="sf-vendor">Vendor</label><select id="sf-vendor" name="vendor_id"><option value="">— None —</option>${opt(refs.vendors, s.vendor?.id)}</select></div>
      <div class="field"><label for="sf-budget">Budget</label><select id="sf-budget" name="budget_id"><option value="">— None —</option>${opt(refs.budgets, s.budget?.id, (b) => `${b.name} · FY ${b.fiscal_year}`)}</select></div>
      <div class="field"><label for="sf-branch">Receiving branch</label><select id="sf-branch" name="branch_id" required>${opt(refs.branches, s.branch?.id)}</select></div>
      <div class="field"><label for="sf-vref">Vendor's reference</label><input id="sf-vref" name="vendor_reference" maxlength="64" value="${s.vendor_reference || ""}"></div>
      <div class="field"><label for="sf-price">Annual cost (₹)</label><input id="sf-price" name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${s.price ?? ""}"></div>
      <div class="field"><label for="sf-grace">Grace period (days)</label><input id="sf-grace" name="grace_days" type="number" min="0" max="365" value="${s.grace_days ?? 7}" required>
        <span class="hint">Late after expected date + grace</span></div>
    </fieldset>

    <fieldset class="grid cols-3"><legend>Period &amp; frequency</legend>
      <div class="field"><label for="sf-start">Start date</label><input id="sf-start" name="start_date" type="date" required value="${s.start_date || isoDay()}"></div>
      <div class="field"><label for="sf-end">End date</label><input id="sf-end" name="end_date" type="date" value="${s.end_date || ""}"></div>
      <div class="field"><label for="sf-first">First issue expected</label><input id="sf-first" name="first_issue_on" type="date" value="${s.first_issue_on || ""}">
        <span class="hint">Defaults to the start date</span></div>
      <div class="field"><label for="sf-freq">Frequency</label><select id="sf-freq" name="frequency">${refs.meta.frequencies.map((f) =>
        html`<option value="${f.key}" ${f.key === freq ? "selected" : ""}>${f.label}</option>`)}</select></div>
      <div class="field" id="sf-interval-f"><label for="sf-interval">N (interval)</label><input id="sf-interval" name="frequency_interval" type="number" min="1" max="366" value="${s.frequency_interval || 1}"></div>
      <fieldset class="field sc-weekdays" id="sf-skip-f"><legend>Not published on</legend>
        <div class="row tight">${WEEKDAYS.map((d, i) => html`<label class="checkbox small"><input type="checkbox" name="skip" value="${i}" ${(s.skip_weekdays || []).includes(i) ? "checked" : ""}>${d}</label>`)}</div></fieldset>
    </fieldset>

    <fieldset class="stack tight"><legend>Numbering</legend>
      <div class="grid cols-2">
        <div class="field"><label for="sf-preset">Start from a preset</label><select id="sf-preset"><option value="">Custom…</option>${refs.meta.presets.map((p) =>
          html`<option value="${p.key}">${p.label}</option>`)}</select></div>
        <div class="field"><label for="sf-pattern">Pattern</label><input id="sf-pattern" name="numbering_pattern" required maxlength="160" class="mono" value="${s.numbering_pattern || "Vol. {X}, No. {Y}"}">
          <span class="hint">Placeholders: {X} {Y} {Z} {YEAR} {MONTH} {MON} {DAY}</span></div>
      </div>
      <div class="table-wrap"><table class="table sc-levels"><caption class="sr-only">Numbering levels</caption>
        <thead><tr><th scope="col">Level</th><th scope="col">Start</th><th scope="col">Add</th><th scope="col">Rollover after</th><th scope="col">Reset to</th><th scope="col">Yearly</th><th scope="col">Labels</th></tr></thead>
        <tbody>${LEVELS.map((k) => levelRow(k, sub ? s.numbering?.[k] : { X: { start: 1, increment: 1, reset: 1 }, Y: { start: 1, increment: 1, max: 12, reset: 1 } }[k]))}</tbody></table></div>
      <p class="tiny muted" style="margin:0">The innermost level advances every issue; when it passes “rollover after” it resets and the next level out advances. “Yearly” restarts a level each January.</p>
    </fieldset>

    <fieldset class="grid cols-3"><legend>Receiving</legend>
      <label class="checkbox" style="grid-column:1/-1"><input type="checkbox" name="create_items" ${s.create_items === false ? "" : "checked"}> Create an item (with barcode) for each received issue</label>
      <div class="field"><label for="sf-itype">Item type</label><select id="sf-itype" name="item_type_id"><option value="">—</option>${opt(refs.itemTypes, itemTypeSel)}</select></div>
      <div class="field"><label for="sf-loc">Shelf location</label><input id="sf-loc" name="shelf_location" maxlength="64" value="${s.shelf_location ?? "Periodicals"}"></div>
      <div class="field"><label for="sf-call">Call number prefix</label><input id="sf-call" name="call_number" maxlength="48" value="${s.call_number || ""}" placeholder="Defaults to classification"></div>
    </fieldset>
    <div class="field"><label for="sf-notes">Notes</label><textarea id="sf-notes" name="notes" maxlength="4000">${s.notes || ""}</textarea></div>
  </div>
  <aside class="card pad sc-preview" aria-labelledby="sf-prev-h">
    <h3 id="sf-prev-h" style="margin-top:0">${icon("clock")} Next 6 predicted issues</h3>
    <div id="sf-preview" aria-live="polite"></div>
  </aside>
  </div>`;
}

function levelsFrom(fd) {
  const out = {};
  for (const k of LEVELS) {
    if (!fd.get(`lvl_${k}_on`)) continue;
    out[k] = {
      start: Number(fd.get(`lvl_${k}_start`) || 0), increment: Number(fd.get(`lvl_${k}_increment`) || 1),
      max: optInt(fd.get(`lvl_${k}_max`)), reset: Number(fd.get(`lvl_${k}_reset`) ?? 1),
      yearly: !!fd.get(`lvl_${k}_yearly`),
      labels: str(fd, `lvl_${k}_labels`).split(",").map((x) => x.trim()).filter(Boolean),
    };
  }
  return out;
}

function patternFrom(fd) {
  return {
    frequency: fd.get("frequency"), frequency_interval: Number(fd.get("frequency_interval") || 1),
    skip_weekdays: DAY_BASED.has(fd.get("frequency")) ? fd.getAll("skip").map(Number) : [],
    numbering_pattern: str(fd, "numbering_pattern"), numbering: levelsFrom(fd),
    start_date: fd.get("start_date"), first_issue_on: fd.get("first_issue_on") || null, end_date: fd.get("end_date") || null,
  };
}

function payload(fd) {
  const out = {
    ...patternFrom(fd),
    vendor_id: optInt(fd.get("vendor_id")), budget_id: optInt(fd.get("budget_id")), branch_id: Number(fd.get("branch_id")),
    grace_days: Number(fd.get("grace_days") || 0), create_items: !!fd.get("create_items"),
    item_type_id: optInt(fd.get("item_type_id")), shelf_location: str(fd, "shelf_location") || null,
    call_number: str(fd, "call_number") || null, price: fd.get("price") === "" ? null : paise(fd.get("price")),
    vendor_reference: str(fd, "vendor_reference") || null, notes: str(fd, "notes") || null,
  };
  if (fd.get("new_biblio")) {
    out.new_biblio = { title: str(fd, "nb_title"), issn: str(fd, "nb_issn") || null, publisher: str(fd, "nb_publisher") || null };
  } else {
    out.biblio_id = optInt(fd.get("biblio_id"));
  }
  return out;
}

function wire(dlg, refs) {
  const form = $("form", dlg);
  const box = $("#sf-preview", dlg);
  let seq = 0;
  const syncVisibility = () => {
    const f = $("#sf-freq", dlg).value;
    $("#sf-interval-f", dlg).classList.toggle("hidden", !f.startsWith("every_n_"));
    $("#sf-skip-f", dlg).classList.toggle("hidden", !DAY_BASED.has(f));
    $("#sf-itype", dlg).required = form.elements.create_items.checked;
  };
  const refresh = debounce(async () => {
    const mine = ++seq;
    const fd = new FormData(form);
    if (!fd.get("start_date")) { box.innerHTML = html`<p class="muted small">Enter a start date to see predictions.</p>`; return; }
    try {
      const r = await api("/serials/preview", { method: "POST", body: { ...patternFrom(fd), count: 6 } });
      if (mine !== seq) return;
      if (r.irregular) { box.innerHTML = html`<p class="muted small">Irregular serials are not predicted — add each issue by hand when it is announced.</p>`; return; }
      box.innerHTML = r.issues.length ? html`<ol class="sc-predicted">${r.issues.map((i) => html`<li>
          <strong>${i.enumeration}</strong><span class="small muted">${i.chronology} · expected ${date(i.expected_on)}</span></li>`)}</ol>
        <p class="tiny muted" style="margin:.5rem 0 0">≈ ${r.per_year} issue${r.per_year === 1 ? "" : "s"} in the first year.</p>`
        : html`<p class="muted small">No issues fall between today and the end date.</p>`;
    } catch (e) {
      if (mine === seq) box.innerHTML = errorBox(e.message);
    }
  }, 300);
  $("#sf-preset", dlg).addEventListener("change", (e) => {
    const p = refs.meta.presets.find((x) => x.key === e.target.value);
    if (!p) return;
    form.elements.numbering_pattern.value = p.pattern;
    for (const k of LEVELS) {
      const lvl = p.numbering[k];
      form.elements[`lvl_${k}_on`].checked = !!lvl;
      form.elements[`lvl_${k}_start`].value = lvl?.start ?? 1;
      form.elements[`lvl_${k}_increment`].value = lvl?.increment ?? 1;
      form.elements[`lvl_${k}_max`].value = lvl?.max ?? "";
      form.elements[`lvl_${k}_reset`].value = lvl?.reset ?? 1;
      form.elements[`lvl_${k}_yearly`].checked = !!lvl?.yearly;
      form.elements[`lvl_${k}_labels`].value = (lvl?.labels || []).join(", ");
    }
    refresh();
  });
  dlg.addEventListener("input", (e) => { if (!e.target.closest("#sf-bq")) refresh(); });
  dlg.addEventListener("change", () => { syncVisibility(); refresh(); });

  // record search (create mode only)
  const bq = $("#sf-bq", dlg);
  if (bq) {
    const results = $("#sf-bresults", dlg);
    const search = async () => {
      const q = bq.value.trim();
      if (!q) return;
      try {
        const r = await api(`/search?${qs({ q, material_type: "serial", per_page: 8 })}`);
        results.innerHTML = r.results.length ? html`${r.results.map((b) => html`<button type="button" class="chip" role="listitem" data-pick="${b.id}" data-title="${b.title}">${b.title}</button>`)}`
          : html`<span class="small muted">No serial records match. Tick “Create a new serial record” below.</span>`;
      } catch (e) { results.innerHTML = errorBox(e.message); }
    };
    bq.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
    $("#sf-bsearch", dlg).addEventListener("click", search);
    results.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (!b) return;
      $("#sf-biblio", dlg).value = b.dataset.pick;
      $("#sf-bchosen", dlg).innerHTML = html`${icon("check")} Linked to <strong>${b.dataset.title}</strong>`;
      $$("[data-pick]", results).forEach((x) => x.setAttribute("aria-pressed", x === b));
    });
    $("#sf-newb", dlg).addEventListener("change", (e) => {
      $("#sf-newfields", dlg).classList.toggle("hidden", !e.target.checked);
      $("#sf-nt", dlg).required = e.target.checked;
      if (e.target.checked && !$("#sf-nt", dlg).value) $("#sf-nt", dlg).value = bq.value.trim();
    });
  }
  syncVisibility();
  refresh();
}

/** Open the subscription dialog. Resolves with the saved subscription or null. */
export async function subscriptionForm(sub = null) {
  const refs = await loadRefs();
  return formModal({ title: sub ? `Edit subscription — ${sub.biblio.title}` : "New subscription", body: body(sub, refs),
    submit: sub ? "Save changes" : "Create subscription", wide: true },
  (fd) => {
    const data = payload(fd);
    if (!sub && !data.biblio_id && !data.new_biblio) throw new Error("Choose a serial record or create a new one");
    return sub ? api(`/serials/subscriptions/${sub.id}`, { method: "PUT", body: data })
      : api("/serials/subscriptions", { method: "POST", body: data });
  }, (dlg) => { dlg.classList.add("sc-xwide"); wire(dlg, refs); });
}

export const priceLabel = (v) => (v === null || v === undefined ? "—" : money(v));
