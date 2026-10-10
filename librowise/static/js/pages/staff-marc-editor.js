// Staff › Catalogue › Record › MARC editor — keyboard-first field/subfield grid, MarcEdit text and MARCXML
// views, live checks (errors shown in the checks panel *and* inline under the field), field help from the
// MARC 21 dictionary, and a diff of catalogue fields and MARC lines before saving.
import { $, $$, BOOT, api, debounce, esc, html, icon, modal, num, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { errorState } from "/static/js/ui/empty.js";
import { alertBox, recNo } from "/static/js/pages/lib/collection.js";

const S = { id: +BOOT.path_params.biblio_id, grid: null, view: "grid", dict: {}, dirty: false, updatedAt: null, focus: null,
  problems: { errors: [], warnings: [] }, meta: null };
const isControl = (tag) => /^\d{3}$/.test(tag) && tag < "010";
const blankIn = (v) => (v === " " || v === undefined || v === null ? "" : v);
const blankOut = (v) => (!v || v === "#" || v === "_" || v === "\\" ? " " : v);
const panel = () => $("#editor-panel");

// ------------------------------------------------------------------ grid rendering

const subLabel = (tag, code) => S.dict[tag]?.subfields?.[code] || "";
function fieldLabel(tag) {
  const d = S.dict[tag];
  if (d) return `${d.label}${d.repeatable ? "" : ` · ${t("coll.marc.not_repeatable")}`}`;
  return /^\d{3}$/.test(tag) ? t("coll.marc.local_field") : t("coll.marc.enter_tag");
}

function fieldRow(f, i) {
  const d = S.dict[f.tag];
  const n = S.grid.fields.length;
  const actions = html`<div class="marc-actions">
    <button type="button" class="btn ghost sm icon-only" data-act="up" aria-label="${t("coll.marc.move_up", { tag: f.tag })}" data-tip="${t("coll.marc.move_up_tip")}" ${i === 0 ? "disabled" : ""}>${icon("arrow-up")}</button>
    <button type="button" class="btn ghost sm icon-only" data-act="down" aria-label="${t("coll.marc.move_down", { tag: f.tag })}" data-tip="${t("coll.marc.move_down_tip")}" ${i === n - 1 ? "disabled" : ""}>${icon("arrow-down")}</button>
    <button type="button" class="btn ghost sm icon-only" data-act="add-field" aria-label="${t("coll.marc.add_after", { tag: f.tag })}" data-tip="${t("coll.marc.add_after_tip")}">${icon("plus")}</button>
    <button type="button" class="btn ghost sm icon-only danger" data-act="del-field" aria-label="${t("coll.marc.delete_field", { tag: f.tag })}" data-tip="${t("coll.marc.delete_field_tip")}">${icon("trash")}</button></div>`;
  const tagInput = html`<input class="marc-tag" data-k="tag" value="${f.tag}" maxlength="3" inputmode="numeric" list="marc-tags" autocomplete="off" spellcheck="false" aria-label="${t("coll.marc.tag_of", { n: i + 1 })}">`;
  const label = html`<div class="marc-label">${fieldLabel(f.tag)}${f.tag === "008" ? ` · ${t("coll.marc.chars_008", { n: (f.value || "").length })}` : ""}</div>`;
  if (isControl(f.tag)) {
    return html`<div class="marc-field control" data-f="${i}">${tagInput}
      <input class="marc-value" data-k="value" value="${f.value || ""}" spellcheck="false" aria-label="${t("coll.marc.control_value", { tag: f.tag, label: d?.label || "" })}">
      ${actions}${label}</div>`;
  }
  return html`<div class="marc-field" data-f="${i}">${tagInput}
    <div class="marc-inds"><input data-k="ind1" value="${blankIn(f.ind1)}" maxlength="1" spellcheck="false" placeholder="_" aria-label="${t("coll.marc.ind1_of", { tag: f.tag })}" data-tip="${d?.ind1 || t("coll.marc.ind1")}">
      <input data-k="ind2" value="${blankIn(f.ind2)}" maxlength="1" spellcheck="false" placeholder="_" aria-label="${t("coll.marc.ind2_of", { tag: f.tag })}" data-tip="${d?.ind2 || t("coll.marc.ind2")}"></div>
    <div class="marc-subfields">${(f.subfields || []).map((s, j) => html`<div class="marc-sf" data-s="${j}"><span class="dollar" aria-hidden="true">$</span>
        <input class="marc-code" data-k="code" value="${s.code}" maxlength="1" spellcheck="false" aria-label="${t("coll.marc.code_of", { tag: f.tag, n: j + 1 })}">
        <input class="marc-sfval" data-k="value" value="${s.value}" aria-label="${f.tag} $${s.code} ${subLabel(f.tag, s.code)}">
        <button type="button" class="btn ghost sm icon-only" data-act="del-sf" aria-label="${t("coll.marc.remove_sf", { code: s.code, tag: f.tag })}" data-tip="${t("coll.marc.remove_sf_tip")}">${icon("x")}</button></div>`)}
      <div><button type="button" class="btn ghost sm add-sf" data-act="add-sf">${icon("plus")}${t("coll.marc.subfield")}</button></div></div>
    ${actions}${label}</div>`;
}

function notices() {
  const m = S.meta;
  return html`${m.origin === "generated" ? alertBox(t("coll.marc.generated_notice"), "info") : ""}
    ${m.holdings_fields ? alertBox(html`${t("coll.marc.holdings_notice", { n: num(m.holdings_fields) })} <a href="/staff/catalog/${S.id}#items">${t("coll.marc.items_link")}</a>`, "info") : ""}`;
}

function renderGrid(focus) {
  const g = S.grid;
  panel().innerHTML = html`<div class="card-body marc-top">${notices()}
      <div class="marc-leader"><label for="leader">${t("coll.marc.leader")}</label>
        <input id="leader" data-leader value="${g.leader}" maxlength="24" spellcheck="false" aria-describedby="leader-hint">
        <span class="small muted" id="leader-hint">${t("coll.marc.leader_hint")}</span></div></div>
    <div class="marc-fields" id="grid">${g.fields.map(fieldRow)}</div>
    <div class="card-body marc-foot"><button type="button" class="btn sm" data-act="append-field">${icon("plus")}${t("coll.marc.add_field")}</button>
      <span class="small muted">${t("coll.marc.n_fields", { count: g.fields.length, n: num(g.fields.length) })}</span></div>`;
  markInvalid();
  if (focus) restoreFocus(focus);
}

function restoreFocus({ f, s, k }) {
  const row = $(`#grid [data-f="${f}"]`);
  if (!row) return;
  const el = (s !== undefined && s !== null && $(`[data-s="${s}"] [data-k="${k || "value"}"]`, row)) || $(`[data-k="${k || "tag"}"]`, row) || $("[data-k]", row);
  el?.focus();
  if (el?.select && k === "tag") el.select();
}

function pathOf(el) {
  const row = el.closest("[data-f]");
  if (!row) return null;
  const sf = el.closest("[data-s]");
  return { f: +row.dataset.f, s: sf ? +sf.dataset.s : null, k: el.dataset.k };
}

// ------------------------------------------------------------------ model updates

function markDirty() {
  S.dirty = true;
  $("#revert").disabled = false;
  scheduleCheck();
}

function onInput(e) {
  const el = e.target;
  if (el.dataset.leader !== undefined) { S.grid.leader = el.value; markDirty(); return; }
  const p = pathOf(el);
  if (!p) return;
  const f = S.grid.fields[p.f];
  if (p.k === "tag") {
    const wasControl = isControl(f.tag);
    f.tag = el.value.trim();
    if (/^\d{3}$/.test(f.tag) && wasControl !== isControl(f.tag)) {
      if (isControl(f.tag)) { f.value = (f.subfields || []).map((x) => x.value).join(" "); delete f.subfields; delete f.ind1; delete f.ind2; }
      else { f.subfields = [{ code: "a", value: f.value || "" }]; f.ind1 = " "; f.ind2 = " "; delete f.value; }
      renderGrid({ f: p.f, k: "tag" });
    } else {
      const lbl = $(".marc-label", el.closest("[data-f]"));
      if (lbl) lbl.textContent = fieldLabel(f.tag);
    }
    showHelp(p);
  } else if (p.k === "ind1" || p.k === "ind2") {
    f[p.k] = blankOut(el.value);
  } else if (p.s !== null) {
    f.subfields[p.s][p.k] = el.value;
    if (p.k === "code") showHelp(p);
  } else {
    f.value = el.value;
  }
  el.removeAttribute("aria-invalid");
  markDirty();
}

function act(action, p) {
  const fields = S.grid.fields;
  const f = p ? fields[p.f] : null;
  let focus = null;
  if (action === "append-field" || action === "add-field") {
    const at = action === "append-field" || !p ? fields.length : p.f + 1;
    fields.splice(at, 0, { tag: "", ind1: " ", ind2: " ", subfields: [{ code: "a", value: "" }] });
    focus = { f: at, k: "tag" };
  } else if (action === "del-field") {
    fields.splice(p.f, 1);
    focus = { f: Math.min(p.f, fields.length - 1), k: "tag" };
    toast(t("coll.marc.field_deleted", { tag: f.tag || "???" }), "info", { action: { label: t("ui.undo"), run: () => { fields.splice(p.f, 0, f); renderGrid({ f: p.f, k: "tag" }); markDirty(); } } });
  } else if (action === "up" || action === "down") {
    const to = p.f + (action === "up" ? -1 : 1);
    if (to < 0 || to >= fields.length) return;
    [fields[p.f], fields[to]] = [fields[to], fields[p.f]];
    focus = { ...p, f: to };
  } else if (action === "add-sf") {
    if (isControl(f.tag)) return;
    const at = p.s === null ? f.subfields.length : p.s + 1;
    f.subfields.splice(at, 0, { code: "", value: "" });
    focus = { f: p.f, s: at, k: "code" };
  } else if (action === "del-sf") {
    if (p.s === null || isControl(f.tag)) return;
    f.subfields.splice(p.s, 1);
    focus = f.subfields.length ? { f: p.f, s: Math.min(p.s, f.subfields.length - 1), k: "value" } : { f: p.f, k: "tag" };
  } else if (action === "sf-up" || action === "sf-down") {
    if (p.s === null) return;
    const to = p.s + (action === "sf-up" ? -1 : 1);
    if (to < 0 || to >= f.subfields.length) return;
    [f.subfields[p.s], f.subfields[to]] = [f.subfields[to], f.subfields[p.s]];
    focus = { ...p, s: to };
  }
  renderGrid(focus);
  markDirty();
}

// ------------------------------------------------------------------ aside: checks, help, keys

function asideHtml() {
  const keys = [["coll.marc.key_save", "Ctrl S"], ["coll.marc.key_new_field", "Ctrl Enter"], ["coll.marc.key_new_sf", "Shift Enter"],
    ["coll.marc.key_del_sf", "Alt Del"], ["coll.marc.key_del_field", "Alt Shift Del"], ["coll.marc.key_move_field", "Alt ↑ / ↓"], ["coll.marc.key_move_sf", "Alt Shift ↑ / ↓"]];
  return html`<section class="card" aria-labelledby="checks-h"><div class="card-head"><h2 id="checks-h">${t("coll.marc.checks")}</h2><span id="check-badge"></span></div>
      <div class="card-body" id="problems" aria-live="polite"></div></section>
    <section class="card marc-help" aria-labelledby="help-h"><div class="card-head"><h2 id="help-h">${t("coll.marc.field_help")}</h2></div>
      <div class="card-body small" id="help" aria-live="polite"><p class="muted">${t("coll.marc.help_idle")}</p></div></section>
    <details class="card marc-keys"><summary class="card-head"><h2>${icon("keyboard")} ${t("coll.marc.keyboard")}</h2></summary>
      <div class="card-body"><dl class="key-list">${keys.map(([k, v]) => html`<div><dt>${t(k)}</dt><dd><kbd>${v}</kbd></dd></div>`)}</dl>
        <p class="small muted">${t("coll.marc.blank_hint")}</p></div></details>`;
}

function showHelp(p) {
  const box = $("#help");
  if (!p || !box) return;
  if (p === "leader") {
    const d = S.dict.LDR;
    box.innerHTML = html`<strong>LDR — ${d.label}</strong><p>${d.help}</p>`;
    return;
  }
  const f = S.grid.fields[p.f];
  if (!f) return;
  const d = S.dict[f.tag];
  if (!d) { box.innerHTML = html`<strong class="mono">${f.tag || "???"}</strong><p class="muted">${/^\d{3}$/.test(f.tag) ? t("coll.marc.not_in_dict") : t("coll.marc.type_tag")}</p>`; return; }
  const code = p.s !== null && f.subfields ? f.subfields[p.s]?.code : null;
  box.innerHTML = html`<strong><span class="mono">${f.tag}</span> — ${d.label}</strong>
    <div class="row tight help-pills">${d.repeatable ? html`<span class="badge pill info">${t("coll.marc.repeatable")}</span>` : html`<span class="badge pill warning">${t("coll.marc.not_repeatable_cap")}</span>`}
      ${d.control ? html`<span class="badge pill neutral">${t("coll.marc.control_field")}</span>` : ""}</div>
    ${d.help ? html`<p>${d.help}</p>` : ""}
    ${d.ind1 || d.ind2 ? html`<dl><dt>${t("coll.marc.ind1_short")}</dt><dd>${d.ind1 || t("coll.marc.undefined_ind")}</dd><dt>${t("coll.marc.ind2_short")}</dt><dd>${d.ind2 || t("coll.marc.undefined_ind")}</dd></dl>` : ""}
    ${Object.keys(d.subfields).length ? html`<dl>${Object.entries(d.subfields).map(([c, l]) => html`<dt class="${c === code ? "current" : ""}">$${c}</dt><dd class="${c === code ? "current" : ""}">${l}</dd>`)}</dl>` : ""}`;
}

function clientErrors() {
  const errs = [];
  if ((S.grid.leader || "").length !== 24) errs.push({ part: "leader", message: t("coll.marc.err_leader") });
  S.grid.fields.forEach((f, i) => {
    if (!/^\d{3}$/.test(f.tag)) errs.push({ field: i, part: "tag", message: t("coll.marc.err_tag", { tag: f.tag }) });
    (f.subfields || []).forEach((s, j) => { if (!/^[a-z0-9]$/.test(s.code)) errs.push({ field: i, subfield: j, part: "code", message: t("coll.marc.err_code", { tag: f.tag, code: s.code }) }); });
  });
  return errs;
}

function markInvalid() {
  $$("#editor-panel [aria-invalid]").forEach((el) => { el.removeAttribute("aria-invalid"); el.removeAttribute("aria-errormessage"); });
  $$("#editor-panel .marc-err").forEach((el) => el.remove());
  if (S.view !== "grid") return;
  const add = (row, el, msg, kind, n) => {
    const id = `merr-${n}`;
    row.insertAdjacentHTML("beforeend", html`<div class="marc-err ${kind}" id="${id}">${icon(kind === "error" ? "alert" : "info")}<span>${msg}</span></div>`);
    if (el && kind === "error") { el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-errormessage", id); }
  };
  let n = 0;
  for (const [kind, list] of [["error", S.problems.errors], ["warning", S.problems.warnings]]) {
    for (const e of list) {
      n++;
      if (e.part === "leader") { const lead = $("#leader"); if (lead) add(lead.closest(".marc-leader"), lead, e.message, kind, n); continue; }
      if (e.field === null || e.field === undefined) continue;
      const row = $(`#grid [data-f="${e.field}"]`);
      if (!row) continue;
      let el;
      if (e.subfield !== null && e.subfield !== undefined) el = $(`[data-s="${e.subfield}"] [data-k="${e.part === "code" ? "code" : "value"}"]`, row);
      else el = $(`[data-k="${["tag", "ind1", "ind2", "value"].includes(e.part) ? e.part : "tag"}"]`, row);
      add(row, el, e.message, kind, n);
    }
  }
}

function renderProblems() {
  const { errors, warnings } = S.problems;
  const badge = $("#check-badge");
  if (!badge) return;
  badge.innerHTML = errors.length ? html`<span class="badge pill danger"><span class="dot" aria-hidden="true"></span>${t("coll.marc.n_errors", { count: errors.length, n: num(errors.length) })}</span>`
    : warnings.length ? html`<span class="badge pill warning"><span class="dot" aria-hidden="true"></span>${t("coll.marc.n_warnings", { count: warnings.length, n: num(warnings.length) })}</span>`
      : html`<span class="badge pill success"><span class="dot" aria-hidden="true"></span>${t("coll.marc.valid")}</span>`;
  const item = (p, kind) => html`<li class="${kind}"><button type="button" data-goto="${p.field ?? ""}" data-sub="${p.subfield ?? ""}" data-part="${p.part || ""}">${p.line ? `${t("coll.marc.line", { n: p.line })} ` : ""}${p.message}</button></li>`;
  $("#problems").innerHTML = errors.length || warnings.length
    ? html`${errors.length ? html`<h3 class="coll-label">${t("coll.marc.errors_fix")}</h3><ul class="problems">${errors.map((p) => item(p, "error"))}</ul>` : ""}
      ${warnings.length ? html`<h3 class="coll-label">${t("coll.marc.warnings")}</h3><ul class="problems">${warnings.map((p) => item(p, "warning"))}</ul>` : ""}`
    : html`<p class="small muted">${icon("check-circle")} ${t("coll.marc.no_problems")}</p>`;
  markInvalid();
}

const scheduleCheck = debounce(async () => {
  if (S.view !== "grid") return;
  const local = clientErrors();
  try {
    const r = await api("/marc/validate", { method: "POST", body: S.grid });
    S.problems = { errors: r.errors, warnings: r.warnings };
  } catch (e) {
    S.problems = { errors: local.length ? local : [{ message: e.message }], warnings: [] };
  }
  renderProblems();
}, 400);

// ------------------------------------------------------------------ views

async function gridFromView() {
  if (S.view === "grid") return S.grid;
  const text = $("#marc-text").value;
  const r = await api("/marc/convert", { method: "POST", body: { from: S.view, to: "grid", text } });
  if (r.errors.length) {
    S.problems = { errors: r.errors, warnings: [] };
    renderProblems();
    throw new Error(t("coll.marc.unreadable", { count: r.errors.length, n: num(r.errors.length) }));
  }
  return r.grid;
}

async function switchView(view) {
  if (view === S.view) return;
  let grid;
  try { grid = await gridFromView(); } catch (e) { toast(e.message, "error"); selectTab(S.view); return; }
  if (S.view !== "grid" && JSON.stringify(grid) !== JSON.stringify(S.grid)) { S.grid = grid; markDirty(); }
  S.view = view;
  selectTab(view);
  if (view === "grid") { renderGrid(); scheduleCheck(); return; }
  const r = await api("/marc/convert", { method: "POST", body: { from: "grid", to: view, grid: S.grid } });
  panel().innerHTML = html`<div class="card-body stack tight">
    <label for="marc-text">${view === "xml" ? t("coll.marc.xml_label") : t("coll.marc.text_label")}</label>
    <textarea id="marc-text" class="marc-text" spellcheck="false" wrap="off" aria-describedby="marc-text-hint">${r.text}</textarea>
    <span class="small muted" id="marc-text-hint">${view === "xml" ? t("coll.marc.xml_hint") : t("coll.marc.text_hint")} ${t("coll.marc.switch_back")}</span></div>`;
  $("#marc-text").addEventListener("input", () => { S.dirty = true; $("#revert").disabled = false; });
  S.problems = r.validation;
  renderProblems();
}

function selectTab(view) {
  $$("#view-tabs [role=tab]").forEach((tb) => { const on = tb.dataset.view === view; tb.setAttribute("aria-selected", String(on)); tb.tabIndex = on ? 0 : -1; });
  panel().setAttribute("aria-labelledby", `tab-${view}`);
}

// ------------------------------------------------------------------ save

function diffView(rows) {
  if (!rows.length) return html`<p class="small muted">${t("coll.marc.no_marc_changes")}</p>`;
  return html`<div class="diff" role="list">${rows.map((r) => {
    if (r.op === "skip") return html`<div class="skip" role="listitem">…</div>`;
    const cls = r.op === "+" ? "add" : r.op === "-" ? "del" : "";
    const sr = r.op === "+" ? t("coll.marc.added") : r.op === "-" ? t("coll.marc.removed") : "";
    return html`<div class="${cls}" role="listitem">${sr ? html`<span class="sr-only">${sr} </span>` : ""}<span aria-hidden="true">${r.op === " " ? " " : r.op}</span> ${r.text}</div>`;
  })}</div>`;
}

const fmtVal = (v) => (Array.isArray(v) ? v.join("; ") : v === null || v === undefined || v === "" ? "—" : String(v));

async function reviewAndSave(btn) {
  let grid;
  try { grid = await gridFromView(); } catch (e) { toast(e.message, "error"); return; }
  const p = await withBusy(btn, () => api(`/biblios/${S.id}/marc/preview`, { method: "POST", body: grid }));
  if (p.errors.length) {
    S.problems = { errors: p.errors, warnings: p.warnings };
    if (S.view !== "grid") { S.grid = grid; await switchView("grid"); }
    renderProblems();
    toast(t("coll.marc.fix_first", { count: p.errors.length, n: num(p.errors.length) }), "error");
    $("#problems button")?.focus();
    return;
  }
  if (p.unchanged) { toast(t("coll.marc.nothing_changed"), "info"); return; }
  const ok = await modal({ title: t("coll.marc.review_title"), size: "lg", submit: t("coll.marc.save_record"), body: html`<div class="stack">
    ${p.warnings.length ? alertBox(html`${p.warnings.map((w) => html`<div>${w.message}</div>`)}`, "warn") : ""}
    <div><h3 class="coll-label">${t("coll.marc.catalogue_changes")}</h3>
      ${p.field_changes.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="${t("coll.marc.catalogue_changes")}"><table class="table compact"><caption class="sr-only">${t("coll.marc.catalogue_changes")}</caption>
        <thead><tr><th scope="col">${t("coll.dupes.field")}</th><th scope="col">${t("coll.marc.before")}</th><th scope="col">${t("coll.marc.after")}</th></tr></thead><tbody>
        ${p.field_changes.map((c) => html`<tr><td>${t(`coll.field.${c.field}`, {}, c.field.replace(/_/g, " "))}</td><td class="small"><del class="change-before">${fmtVal(c.before)}</del></td><td class="small"><ins class="change-after">${fmtVal(c.after)}</ins></td></tr>`)}</tbody></table></div>`
        : html`<p class="small muted">${t("coll.marc.only_marc")}</p>`}</div>
    <div><h3 class="coll-label">${t("coll.marc.marc_changes")}</h3>${diffView(p.marc_diff)}</div>
    <p class="small muted">${t("coll.marc.items_untouched")}</p></div>` });
  if (!ok) return;
  try {
    const r = await api(`/biblios/${S.id}/marc`, { method: "PUT", body: { grid, expected_updated_at: S.updatedAt } });
    toast(r.changed_fields.length ? t("coll.marc.saved_fields", { fields: r.changed_fields.map((f) => t(`coll.field.${f}`, {}, f)).join(", ") }) : t("coll.marc.saved"), "success");
    await load();
  } catch (e) {
    toast(e.message, "error");
    if (e.data?.errors) { S.problems = { errors: e.data.errors, warnings: [] }; renderProblems(); }
  }
}

// ------------------------------------------------------------------ load & wiring

async function load() {
  const data = await api(`/biblios/${S.id}/marc`);
  S.meta = data;
  S.grid = data.grid;
  S.updatedAt = data.updated_at;
  S.dirty = false;
  $("#revert").disabled = true;
  document.title = `${t("nav.detail.marc_editor")} · ${data.title}`;
  $("#crumb-record").textContent = data.title;
  $("#sub").innerHTML = html`<strong>${data.title}</strong> · <span class="mono">${recNo(data.biblio_id)}</span> · ${data.origin === "stored" ? t("coll.marc.stored") : t("coll.marc.generated")}
    · ${t("coll.marc.n_items", { count: data.items, n: num(data.items) })} · ${t("coll.rec.updated", { when: relative(data.updated_at) })}`;
  S.view = "grid";
  selectTab("grid");
  panel().removeAttribute("aria-busy");
  renderGrid();
  if (!$("#problems")) $("#marc-aside").innerHTML = asideHtml();
  scheduleCheck();
}

export default async function init() {
  try {
    const d = await api("/marc/dictionary");
    S.dict = d.fields;
    $("#marc-tags").innerHTML = Object.entries(S.dict).filter(([k]) => k !== "LDR").map(([k, x]) => `<option value="${esc(k)}">${esc(x.label)}</option>`).join("");
    await load();
  } catch (e) {
    panel().removeAttribute("aria-busy");
    panel().innerHTML = errorState(e, { retry: false });
    return;
  }
  panel().addEventListener("input", onInput);
  panel().addEventListener("focusin", (e) => {
    if (e.target.dataset.leader !== undefined) { showHelp("leader"); return; }
    const p = pathOf(e.target);
    if (p) { S.focus = p; showHelp(p); }
  });
  panel().addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) act(b.dataset.act, pathOf(b));
  });
  panel().addEventListener("keydown", (e) => {
    if (S.view !== "grid") return;
    const p = pathOf(e.target);
    if (!p) return;
    const key = e.key;
    let action = null;
    if ((e.ctrlKey || e.metaKey) && key === "Enter") action = "add-field";
    else if (e.shiftKey && !e.altKey && key === "Enter" && p.s !== null) action = "add-sf";
    else if (e.altKey && key === "Delete") action = e.shiftKey ? "del-field" : (p.s !== null ? "del-sf" : "del-field");
    else if (e.altKey && (key === "ArrowUp" || key === "ArrowDown")) action = e.shiftKey ? (key === "ArrowUp" ? "sf-up" : "sf-down") : (key === "ArrowUp" ? "up" : "down");
    else if (key === "Enter" && !e.shiftKey) {
      // Enter moves to the next input (spreadsheet-like), never submits anything.
      e.preventDefault();
      const inputs = $$("#editor-panel input");
      inputs[inputs.indexOf(e.target) + 1]?.focus();
      return;
    }
    if (action) { e.preventDefault(); act(action, p); }
  });
  $("#view-tabs").addEventListener("click", (e) => { const tb = e.target.closest("[role=tab]"); if (tb) switchView(tb.dataset.view); });
  $("#view-tabs").addEventListener("keydown", (e) => {
    const list = $$("#view-tabs [role=tab]");
    const i = list.indexOf(document.activeElement);
    const rtl = getComputedStyle($("#view-tabs")).direction === "rtl";
    const next = { [rtl ? "ArrowLeft" : "ArrowRight"]: i + 1, [rtl ? "ArrowRight" : "ArrowLeft"]: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    const tb = list[(next + list.length) % list.length];
    tb.focus();
    switchView(tb.dataset.view);
  });
  $("#marc-aside").addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (!b || S.view !== "grid") return;
    if (b.dataset.part === "leader") { $("#leader")?.focus(); return; }
    if (b.dataset.goto === "") return;
    restoreFocus({ f: +b.dataset.goto, s: b.dataset.sub === "" ? null : +b.dataset.sub, k: b.dataset.part === "code" ? "code" : b.dataset.sub === "" ? (b.dataset.part || "tag") : "value" });
  });
  $("#save").addEventListener("click", (e) => reviewAndSave(e.currentTarget).catch((err) => { if (!err.toasted) toast(err.message, "error"); }));
  $("#revert").addEventListener("click", async () => {
    if (!(await modal({ title: t("coll.marc.discard_title"), body: html`<p>${t("coll.marc.discard_text")}</p>`, submit: t("coll.marc.discard"), danger: true, size: "sm" }))) return;
    await load();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !document.querySelector("dialog[open]")) { e.preventDefault(); $("#save").click(); }
  });
  window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
}
