// Serials: create / edit subscription dialog with a live preview of the next predicted issues.
import { $, api, date, debounce, html, icon, money, num, qs } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { combobox } from "/static/js/ui/combobox.js";
import { errorBox, formModal, isoDay, optInt, paise, str } from "/static/js/pages/lib/sc-ui.js";

const LEVELS = ["X", "Y", "Z"];
const DAY_BASED = new Set(["daily", "weekly", "fortnightly", "every_n_days", "every_n_weeks"]);
const weekday = (i) => new Intl.DateTimeFormat(document.documentElement.lang || "en", { weekday: "short" }).format(new Date(Date.UTC(2024, 0, 1 + i)));

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
  refCache = { branches: lookups.branches || [], itemTypes: lookups.item_types || [], vendors: vendors.results, budgets: budgets.results, meta };
  return refCache;
}

function levelRow(key, lvl) {
  const on = !!lvl;
  const v = lvl || { start: 1, increment: 1, max: null, reset: 1, yearly: false, labels: [] };
  return html`<tr data-level="${key}">
    <th scope="row"><label class="checkbox"><input type="checkbox" name="lvl_${key}_on" ${on ? "checked" : ""}> {${key}}</label></th>
    <td><input type="number" name="lvl_${key}_start" value="${v.start}" min="0" aria-label="${t("coll.sf.lvl_start", { key })}"></td>
    <td><input type="number" name="lvl_${key}_increment" value="${v.increment}" min="1" aria-label="${t("coll.sf.lvl_increment", { key })}"></td>
    <td><input type="number" name="lvl_${key}_max" value="${v.max ?? ""}" min="1" placeholder="—" aria-label="${t("coll.sf.lvl_max", { key })}"></td>
    <td><input type="number" name="lvl_${key}_reset" value="${v.reset}" min="0" aria-label="${t("coll.sf.lvl_reset", { key })}"></td>
    <td class="center"><input type="checkbox" name="lvl_${key}_yearly" ${v.yearly ? "checked" : ""} aria-label="${t("coll.sf.lvl_yearly", { key })}"></td>
    <td><input type="text" name="lvl_${key}_labels" value="${(v.labels || []).join(", ")}" placeholder="${t("coll.sf.labels_ph")}" aria-label="${t("coll.sf.lvl_labels", { key })}"></td>
  </tr>`;
}

function body(sub, refs) {
  const s = sub || {};
  const opt = (rows, sel, label = (r) => r.name) => rows.map((r) => html`<option value="${r.id}" ${r.id === sel ? "selected" : ""}>${label(r)}</option>`);
  const mag = refs.itemTypes.find((x) => x.code === "MAG");
  const itemTypeSel = s.item_type_id ?? mag?.id;
  const freq = s.frequency || "monthly";
  const fyLabel = (b) => `${b.name} · ${t("coll.acq.fy", { year: String(b.fiscal_year) })}`;
  return html`<div class="sc-form-layout">
  <div class="stack">
    <fieldset class="sc-fieldset"><legend>${t("coll.sf.record")}</legend>
      ${sub ? html`<p><strong>${s.biblio.title}</strong> ${s.biblio.issn ? html`<span class="muted small">ISSN ${s.biblio.issn}</span>` : ""}</p>
        <input type="hidden" name="biblio_id" value="${s.biblio.id}">`
      : html`<div class="field"><label for="sf-bq">${t("coll.sf.find_record")}</label>
          <input id="sf-bq" placeholder="${t("coll.sf.find_record_ph")}" autocomplete="off" aria-describedby="sf-bchosen"></div>
        <input type="hidden" name="biblio_id" id="sf-biblio">
        <div id="sf-bchosen" class="small" aria-live="polite"></div>
        <label class="checkbox"><input type="checkbox" name="new_biblio" id="sf-newb"> ${t("coll.sf.new_record")}</label>
        <div class="form-grid three" id="sf-newfields" hidden>
          <div class="field"><label for="sf-nt">${t("coll.field.title")}</label><input id="sf-nt" name="nb_title" maxlength="500"></div>
          <div class="field"><label for="sf-ni">${t("coll.field.issn")}</label><input id="sf-ni" name="nb_issn" maxlength="20" class="mono"></div>
          <div class="field"><label for="sf-np">${t("coll.field.publisher")}</label><input id="sf-np" name="nb_publisher" maxlength="255"></div>
        </div>`}
    </fieldset>

    <fieldset class="sc-fieldset"><legend>${t("coll.sf.ordering")}</legend><div class="form-grid three">
      <div class="field"><label for="sf-vendor">${t("coll.acq.col_vendor")}</label><select id="sf-vendor" name="vendor_id"><option value="">${t("coll.sf.none")}</option>${opt(refs.vendors, s.vendor?.id)}</select></div>
      <div class="field"><label for="sf-budget">${t("coll.acq.col_budget")}</label><select id="sf-budget" name="budget_id"><option value="">${t("coll.sf.none")}</option>${opt(refs.budgets, s.budget?.id, fyLabel)}</select></div>
      <div class="field"><label for="sf-branch">${t("coll.acq.receiving_branch")}</label><select id="sf-branch" name="branch_id" required>${opt(refs.branches, s.branch?.id)}</select></div>
      <div class="field"><label for="sf-vref">${t("coll.sf.vendor_ref")}</label><input id="sf-vref" name="vendor_reference" maxlength="64" value="${s.vendor_reference || ""}"></div>
      <div class="field"><label for="sf-price">${t("coll.sf.annual_cost")}</label><input id="sf-price" name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${s.price ?? ""}"></div>
      <div class="field"><label for="sf-grace">${t("coll.sf.grace")}</label><input id="sf-grace" name="grace_days" type="number" min="0" max="365" value="${s.grace_days ?? 7}" required aria-describedby="sf-grace-h">
        <div class="field-help" id="sf-grace-h">${t("coll.sf.grace_help")}</div></div>
    </div></fieldset>

    <fieldset class="sc-fieldset"><legend>${t("coll.sf.period")}</legend><div class="form-grid three">
      <div class="field"><label for="sf-start">${t("coll.sf.start")}</label><input id="sf-start" name="start_date" type="date" required value="${s.start_date || isoDay()}"></div>
      <div class="field"><label for="sf-end">${t("coll.sf.end")}</label><input id="sf-end" name="end_date" type="date" value="${s.end_date || ""}"></div>
      <div class="field"><label for="sf-first">${t("coll.sf.first")}</label><input id="sf-first" name="first_issue_on" type="date" value="${s.first_issue_on || ""}" aria-describedby="sf-first-h">
        <div class="field-help" id="sf-first-h">${t("coll.sf.first_help")}</div></div>
      <div class="field"><label for="sf-freq">${t("coll.sf.frequency")}</label><select id="sf-freq" name="frequency">${refs.meta.frequencies.map((f) =>
        html`<option value="${f.key}" ${f.key === freq ? "selected" : ""}>${t(`coll.freq.${f.key}`, { n: "N" }, f.label)}</option>`)}</select></div>
      <div class="field" id="sf-interval-f"><label for="sf-interval">${t("coll.sf.interval")}</label><input id="sf-interval" name="frequency_interval" type="number" min="1" max="366" value="${s.frequency_interval || 1}"></div>
      <fieldset class="field plain-fieldset" id="sf-skip-f"><legend class="label-like">${t("coll.sf.skip")}</legend>
        <div class="row tight">${[0, 1, 2, 3, 4, 5, 6].map((i) => html`<label class="checkbox small"><input type="checkbox" name="skip" value="${i}" ${(s.skip_weekdays || []).includes(i) ? "checked" : ""}>${weekday(i)}</label>`)}</div></fieldset>
    </div></fieldset>

    <fieldset class="sc-fieldset"><legend>${t("coll.sf.numbering")}</legend>
      <div class="form-grid">
        <div class="field"><label for="sf-preset">${t("coll.sf.preset")}</label><select id="sf-preset"><option value="">${t("coll.sf.custom")}</option>${refs.meta.presets.map((p) =>
          html`<option value="${p.key}">${t(`coll.sf.preset_${p.key}`, {}, p.label)}</option>`)}</select></div>
        <div class="field"><label for="sf-pattern">${t("coll.sf.pattern")}</label><input id="sf-pattern" name="numbering_pattern" required maxlength="160" class="mono" value="${s.numbering_pattern || "Vol. {X}, No. {Y}"}" aria-describedby="sf-pattern-h">
          <div class="field-help" id="sf-pattern-h">${t("coll.sf.pattern_help")}</div></div>
      </div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="${t("coll.sf.levels")}"><table class="table sc-levels"><caption class="sr-only">${t("coll.sf.levels")}</caption>
        <thead><tr><th scope="col">${t("coll.sf.level")}</th><th scope="col">${t("coll.sf.l_start")}</th><th scope="col">${t("coll.sf.l_add")}</th><th scope="col">${t("coll.sf.l_max")}</th><th scope="col">${t("coll.sf.l_reset")}</th><th scope="col">${t("coll.sf.l_yearly")}</th><th scope="col">${t("coll.sf.l_labels")}</th></tr></thead>
        <tbody>${LEVELS.map((k) => levelRow(k, sub ? s.numbering?.[k] : { X: { start: 1, increment: 1, reset: 1 }, Y: { start: 1, increment: 1, max: 12, reset: 1 } }[k]))}</tbody></table></div>
      <p class="small muted">${t("coll.sf.levels_help")}</p>
    </fieldset>

    <fieldset class="sc-fieldset"><legend>${t("coll.sf.receiving")}</legend><div class="form-grid three">
      <label class="checkbox span-all"><input type="checkbox" name="create_items" ${s.create_items === false ? "" : "checked"}> ${t("coll.sf.create_items")}</label>
      <div class="field"><label for="sf-itype">${t("coll.items.type")}</label><select id="sf-itype" name="item_type_id"><option value="">—</option>${opt(refs.itemTypes, itemTypeSel)}</select></div>
      <div class="field"><label for="sf-loc">${t("coll.items.shelf_location")}</label><input id="sf-loc" name="shelf_location" maxlength="64" value="${s.shelf_location ?? t("coll.sf.periodicals")}"></div>
      <div class="field"><label for="sf-call">${t("coll.sf.cn_prefix")}</label><input id="sf-call" name="call_number" maxlength="48" value="${s.call_number || ""}" placeholder="${t("coll.sf.cn_prefix_ph")}"></div>
    </div></fieldset>
    <div class="field"><label for="sf-notes">${t("coll.items.notes")}</label><textarea id="sf-notes" name="notes" maxlength="4000">${s.notes || ""}</textarea></div>
  </div>
  <aside class="card pad sc-preview" aria-labelledby="sf-prev-h">
    <h3 id="sf-prev-h">${icon("clock")} ${t("coll.sf.next_six")}</h3>
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
  if (fd.get("new_biblio")) out.new_biblio = { title: str(fd, "nb_title"), issn: str(fd, "nb_issn") || null, publisher: str(fd, "nb_publisher") || null };
  else out.biblio_id = optInt(fd.get("biblio_id"));
  return out;
}

function wire(dlg, refs) {
  const form = $("form", dlg);
  const box = $("#sf-preview", dlg);
  let seq = 0;
  const syncVisibility = () => {
    const f = $("#sf-freq", dlg).value;
    $("#sf-interval-f", dlg).hidden = !f.startsWith("every_n_");
    $("#sf-skip-f", dlg).hidden = !DAY_BASED.has(f);
    $("#sf-itype", dlg).required = form.elements.create_items.checked;
  };
  const refresh = debounce(async () => {
    const mine = ++seq;
    const fd = new FormData(form);
    if (!fd.get("start_date")) { box.innerHTML = html`<p class="muted small">${t("coll.sf.need_start")}</p>`; return; }
    try {
      const r = await api("/serials/preview", { method: "POST", body: { ...patternFrom(fd), count: 6 } });
      if (mine !== seq) return;
      if (r.irregular) { box.innerHTML = html`<p class="muted small">${t("coll.sf.irregular")}</p>`; return; }
      box.innerHTML = r.issues.length ? html`<ol class="sc-predicted">${r.issues.map((i) => html`<li>
          <strong>${i.enumeration}</strong><span class="small muted">${i.chronology} · ${t("coll.ser.expected_on", { date: date(i.expected_on) })}</span></li>`)}</ol>
        <p class="small muted">${t("coll.sf.per_year", { count: r.per_year, n: num(r.per_year) })}</p>`
        : html`<p class="muted small">${t("coll.sf.none_in_range")}</p>`;
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

  const bq = $("#sf-bq", dlg);
  if (bq) {
    combobox(bq, {
      minChars: 2,
      source: async (q, signal) => (await api(`/search?${qs({ q, material_type: "serial", per_page: 8 })}`, { signal })).results,
      render: (b) => html`<span class="combo-main">${b.title}<span class="sub">${b.issn || b.publisher || ""}</span></span>`,
      value: (b) => b.title,
      onSelect: (b) => { $("#sf-biblio", dlg).value = b.id; $("#sf-bchosen", dlg).innerHTML = html`${icon("check")} ${t("coll.sf.linked_to", { title: b.title })}`; },
    });
    $("#sf-newb", dlg).addEventListener("change", (e) => {
      $("#sf-newfields", dlg).hidden = !e.target.checked;
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
  return formModal({ title: sub ? t("coll.sf.edit_title", { title: sub.biblio.title }) : t("coll.sf.new_title"), body: body(sub, refs),
    submit: sub ? t("coll.auth.save") : t("coll.sf.create"), size: "xl" },
  (fd) => {
    const data = payload(fd);
    if (!sub && !data.biblio_id && !data.new_biblio) throw new Error(t("coll.sf.need_record"));
    return sub ? api(`/serials/subscriptions/${sub.id}`, { method: "PUT", body: data }) : api("/serials/subscriptions", { method: "POST", body: data });
  }, (dlg) => wire(dlg, refs));
}

export const priceLabel = (v) => (v === null || v === undefined ? "—" : money(v));
