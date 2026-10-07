// Staff: MARC editor — field/subfield grid, MarcEdit text and MARCXML views, live checks, diff-before-save.
import { $, $$, BOOT, api, debounce, empty, esc, html, icon, modal, num, raw, relative, toast, withBusy } from "/static/js/core.js";

const S = { id: +BOOT.path_params.biblio_id, grid: null, view: "grid", dict: {}, dirty: false, updatedAt: null, focus: null, problems: { errors: [], warnings: [] } };
const isControl = (tag) => /^\d{3}$/.test(tag) && tag < "010";
const blankIn = (v) => (v === " " || v === undefined || v === null ? "" : v);
const blankOut = (v) => (!v || v === "#" || v === "_" || v === "\\" ? " " : v);
const panel = () => $("#editor-panel");

// ------------------------------------------------------------------ grid rendering

function subLabel(tag, code) {
  return S.dict[tag]?.subfields?.[code] || "";
}

function fieldRow(f, i) {
  const d = S.dict[f.tag];
  const label = d ? `${d.label}${d.repeatable ? "" : " · not repeatable"}` : (/^\d{3}$/.test(f.tag) ? "Local or unlisted field" : "Enter a 3-digit tag");
  const actions = html`<div class="marc-actions">
    <button type="button" class="btn ghost sm" data-act="up" aria-label="Move field ${f.tag} up" title="Move up (Alt+↑)" ${i === 0 ? "disabled" : ""}>${icon("arrow-up")}</button>
    <button type="button" class="btn ghost sm" data-act="down" aria-label="Move field ${f.tag} down" title="Move down (Alt+↓)" ${i === S.grid.fields.length - 1 ? "disabled" : ""}>${icon("arrow-down")}</button>
    <button type="button" class="btn ghost sm" data-act="add-field" aria-label="Add a field after ${f.tag}" title="New field below (Ctrl+Enter)">${icon("plus")}</button>
    <button type="button" class="btn ghost sm danger" data-act="del-field" aria-label="Delete field ${f.tag}" title="Delete field (Alt+Shift+Del)">${icon("trash")}</button></div>`;
  const tagInput = html`<input class="marc-tag" data-k="tag" value="${f.tag}" maxlength="3" inputmode="numeric" list="marc-tags" autocomplete="off" spellcheck="false" aria-label="Tag of field ${i + 1}">`;
  if (isControl(f.tag)) {
    return html`<div class="marc-field control" data-f="${i}">${tagInput}
      <input class="marc-value" data-k="value" value="${f.value || ""}" spellcheck="false" aria-label="${f.tag} ${d?.label || "control field"} value">
      ${actions}<div class="marc-label">${label}${f.tag === "008" ? ` · ${(f.value || "").length}/40 characters` : ""}</div></div>`;
  }
  return html`<div class="marc-field" data-f="${i}">${tagInput}
    <div class="marc-inds"><input data-k="ind1" value="${blankIn(f.ind1)}" maxlength="1" spellcheck="false" placeholder="_" aria-label="${f.tag} first indicator" title="${d?.ind1 || "First indicator"}">
      <input data-k="ind2" value="${blankIn(f.ind2)}" maxlength="1" spellcheck="false" placeholder="_" aria-label="${f.tag} second indicator" title="${d?.ind2 || "Second indicator"}"></div>
    <div class="marc-subfields">${(f.subfields || []).map((s, j) => html`<div class="marc-sf" data-s="${j}"><span class="dollar" aria-hidden="true">$</span>
        <input class="marc-code" data-k="code" value="${s.code}" maxlength="1" spellcheck="false" aria-label="${f.tag} subfield ${j + 1} code" title="${subLabel(f.tag, s.code)}">
        <input class="marc-sfval" data-k="value" value="${s.value}" aria-label="${f.tag} $${s.code} ${subLabel(f.tag, s.code)}">
        <button type="button" class="btn ghost sm" data-act="del-sf" aria-label="Remove subfield $${s.code} of ${f.tag}" title="Remove subfield (Alt+Del)">${icon("x")}</button></div>`)}
      <div><button type="button" class="btn ghost sm" data-act="add-sf" title="New subfield (Shift+Enter)">${icon("plus")}Subfield</button></div></div>
    ${actions}<div class="marc-label">${label}</div></div>`;
}

function renderGrid(focus) {
  const g = S.grid;
  panel().innerHTML = html`<div class="card-body stack">
      <div class="marc-leader"><label for="leader" class="small" style="font-weight:600">Leader</label>
        <input id="leader" data-leader value="${g.leader}" maxlength="24" spellcheck="false" aria-describedby="leader-hint">
        <span class="tiny muted" id="leader-hint">24 positions · 05 status · 06 type · 07 level · 09 coding (a = Unicode)</span></div>
    </div>
    <div class="marc-fields" id="grid">${g.fields.map(fieldRow)}</div>
    <div class="card-body row between"><button type="button" class="btn sm" data-act="append-field">${icon("plus")}Add field</button>
      <span class="tiny muted">${num(g.fields.length)} fields</span></div>`;
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
      const d = S.dict[f.tag];
      const lbl = $(".marc-label", el.closest("[data-f]"));
      if (lbl) lbl.textContent = d ? `${d.label}${d.repeatable ? "" : " · not repeatable"}` : "Local or unlisted field";
    }
    showHelp(p);
  } else if (p.k === "ind1" || p.k === "ind2") {
    f[p.k] = blankOut(el.value);
  } else if (p.s !== null) {
    f.subfields[p.s][p.k] = el.value;
    if (p.k === "code") { el.title = subLabel(f.tag, el.value); showHelp(p); }
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

// ------------------------------------------------------------------ help & checks

function showHelp(p) {
  const box = $("#help");
  if (!p) return;
  if (p === "leader") {
    const d = S.dict.LDR;
    box.innerHTML = html`<strong>LDR — ${d.label}</strong><p>${d.help}</p>`;
    return;
  }
  const f = S.grid.fields[p.f];
  if (!f) return;
  const d = S.dict[f.tag];
  if (!d) { box.innerHTML = html`<strong class="mono">${f.tag || "???"}</strong><p class="muted">${/^\d{3}$/.test(f.tag) ? "Not in the built-in dictionary (local or rarely used field)." : "Type a three-digit tag — suggestions appear as you type."}</p>`; return; }
  const code = p.s !== null && f.subfields ? f.subfields[p.s]?.code : null;
  box.innerHTML = html`<strong><span class="mono">${f.tag}</span> — ${d.label}</strong>
    <div class="row tight" style="margin:.35rem 0">${d.repeatable ? raw('<span class="badge info">Repeatable</span>') : raw('<span class="badge warn">Not repeatable</span>')}${d.control ? raw('<span class="badge">Control field</span>') : ""}</div>
    ${d.help ? html`<p>${d.help}</p>` : ""}
    ${d.ind1 || d.ind2 ? html`<dl><dt>Ind 1</dt><dd>${d.ind1 || "Undefined (blank)"}</dd><dt>Ind 2</dt><dd>${d.ind2 || "Undefined (blank)"}</dd></dl>` : ""}
    ${Object.keys(d.subfields).length ? html`<dl>${Object.entries(d.subfields).map(([c, l]) => html`<dt ${c === code ? raw('style="text-decoration:underline"') : ""}>$${c}</dt><dd>${l}</dd>`)}</dl>` : ""}`;
}

function clientErrors() {
  const errs = [];
  if ((S.grid.leader || "").length !== 24) errs.push({ part: "leader", message: "Leader must be 24 characters" });
  S.grid.fields.forEach((f, i) => {
    if (!/^\d{3}$/.test(f.tag)) errs.push({ field: i, part: "tag", message: `Tag “${f.tag}” must be three digits` });
    (f.subfields || []).forEach((s, j) => { if (!/^[a-z0-9]$/.test(s.code)) errs.push({ field: i, subfield: j, part: "code", message: `${f.tag}: bad subfield code “${s.code}”` }); });
  });
  return errs;
}

function markInvalid() {
  $$("#editor-panel [aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  if (S.view !== "grid") return;
  for (const e of S.problems.errors) {
    let el = null;
    if (e.part === "leader") el = $("#leader");
    else if (e.field !== null && e.field !== undefined) {
      const row = $(`#grid [data-f="${e.field}"]`);
      if (!row) continue;
      if (e.subfield !== null && e.subfield !== undefined) el = $(`[data-s="${e.subfield}"] [data-k="${e.part === "code" ? "code" : "value"}"]`, row);
      else el = $(`[data-k="${["tag", "ind1", "ind2", "value"].includes(e.part) ? e.part : "tag"}"]`, row);
    }
    el?.setAttribute("aria-invalid", "true");
  }
}

function renderProblems() {
  const { errors, warnings } = S.problems;
  $("#check-badge").innerHTML = errors.length ? html`<span class="badge bad">${errors.length} error${errors.length > 1 ? "s" : ""}</span>`
    : warnings.length ? html`<span class="badge warn">${warnings.length} warning${warnings.length > 1 ? "s" : ""}</span>` : html`<span class="badge ok">Valid</span>`;
  const item = (p, kind) => html`<li class="${kind}"><button type="button" data-goto="${p.field ?? ""}" data-sub="${p.subfield ?? ""}" data-part="${p.part || ""}">${p.line ? `Line ${p.line}: ` : ""}${p.message}</button></li>`;
  $("#problems").innerHTML = errors.length || warnings.length
    ? html`${errors.length ? html`<strong class="small">Errors — fix before saving</strong><ul class="problems">${errors.map((p) => item(p, "error"))}</ul>` : ""}
      ${warnings.length ? html`<strong class="small">Warnings</strong><ul class="problems">${warnings.map((p) => item(p, "warning"))}</ul>` : ""}`
    : html`<p class="muted">${icon("check")} No problems found. Required: a 245 field with $a.</p>`;
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
    const err = new Error(`${r.errors.length} line(s) could not be read — see Checks`);
    throw err;
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
    <label for="marc-text" class="small" style="font-weight:600">${view === "xml" ? "MARCXML (one record)" : "MarcEdit mnemonic — one field per line: =245  10$aTitle"}</label>
    <textarea id="marc-text" class="marc-text" spellcheck="false" wrap="off">${r.text}</textarea>
    <span class="tiny muted">${view === "xml" ? "Paste a MARCXML record to replace this one." : "Blanks are shown as \\ in indicators and fixed fields; a literal $ is written {dollar}."} Switch back to Fields to see checks and help.</span></div>`;
  $("#marc-text").addEventListener("input", () => { S.dirty = true; $("#revert").disabled = false; });
  S.problems = r.validation;
  renderProblems();
}

function selectTab(view) {
  $$("#view-tabs [role=tab]").forEach((t) => { const on = t.dataset.view === view; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
  panel().setAttribute("aria-labelledby", `tab-${view}`);
}

// ------------------------------------------------------------------ save

function diffView(rows) {
  if (!rows.length) return html`<p class="small muted">No MARC changes.</p>`;
  return html`<div class="diff" role="list">${rows.map((r) => {
    if (r.op === "skip") return html`<div class="skip" role="listitem">…</div>`;
    const cls = r.op === "+" ? "add" : r.op === "-" ? "del" : "";
    const sr = r.op === "+" ? "Added: " : r.op === "-" ? "Removed: " : "";
    return html`<div class="${cls}" role="listitem"><span class="sr-only">${sr}</span><span aria-hidden="true">${r.op === " " ? " " : r.op}</span> ${r.text}</div>`;
  })}</div>`;
}

const fmt = (v) => (Array.isArray(v) ? v.join("; ") : v === null || v === undefined || v === "" ? "—" : String(v));

async function reviewAndSave(btn) {
  let grid;
  try { grid = await gridFromView(); } catch (e) { toast(e.message, "error"); return; }
  const p = await withBusy(btn, () => api(`/biblios/${S.id}/marc/preview`, { method: "POST", body: grid }));
  if (p.errors.length) {
    S.problems = { errors: p.errors, warnings: p.warnings };
    if (S.view !== "grid") { S.grid = grid; await switchView("grid"); }
    renderProblems();
    toast(`Fix ${p.errors.length} error(s) before saving`, "error");
    return;
  }
  if (p.unchanged) { toast("Nothing has changed", "info"); return; }
  const ok = await modal({ title: "Review changes", wide: true, submit: "Save record", body: html`<div class="stack">
    ${p.warnings.length ? html`<div class="alert warn">${icon("alert")}<div>${p.warnings.map((w) => html`<div>${w.message}</div>`)}</div></div>` : ""}
    <div><strong class="small">Catalogue fields that will change</strong>
      ${p.field_changes.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
        ${p.field_changes.map((c) => html`<tr><td>${c.field.replace("_", " ")}</td><td class="small change-before">${fmt(c.before)}</td><td class="small change-after">${fmt(c.after)}</td></tr>`)}</tbody></table></div>`
        : html`<p class="small muted">None — only MARC detail changes.</p>`}</div>
    <div><strong class="small">MARC changes</strong>${diffView(p.marc_diff)}</div>
    <p class="tiny muted">Items are not affected. 005 is updated automatically.</p></div>` });
  if (!ok) return;
  try {
    const r = await api(`/biblios/${S.id}/marc`, { method: "PUT", body: { grid, expected_updated_at: S.updatedAt } });
    toast(r.changed_fields.length ? `Saved · updated ${r.changed_fields.join(", ")}` : "Saved", "success");
    await load();
  } catch (e) {
    toast(e.message, "error");
    if (e.data?.errors) { S.problems = { errors: e.data.errors, warnings: [] }; renderProblems(); }
  }
}

// ------------------------------------------------------------------ load & wiring

async function load() {
  const data = await api(`/biblios/${S.id}/marc`);
  S.grid = data.grid;
  S.updatedAt = data.updated_at;
  S.dirty = false;
  $("#revert").disabled = true;
  document.title = `MARC · ${data.title} · Staff`;
  $("#heading").textContent = data.title;
  $("#crumb-record").textContent = data.title;
  $("#sub").textContent = `Record #${data.biblio_id} · ${data.origin === "stored" ? "stored MARC" : "generated from catalogue fields"} · ${data.items} item(s) · updated ${relative(data.updated_at)}`;
  $("#notices").innerHTML = html`${data.origin === "generated" ? html`<div class="alert info" style="margin-bottom:1rem">${icon("info")}<div>This record has no stored MARC yet, so one was generated from its catalogue fields. Saving stores it.</div></div>` : ""}
    ${data.holdings_fields ? html`<div class="alert info" style="margin-bottom:1rem">${icon("barcode")}<div>${data.holdings_fields} holdings field(s) (952) are hidden here — items are managed on the <a href="/staff/catalog/${S.id}">record page</a> and are never changed by this editor.</div></div>` : ""}`;
  S.view = "grid";
  selectTab("grid");
  renderGrid();
  scheduleCheck();
}

export default async function init() {
  try {
    const d = await api("/marc/dictionary");
    S.dict = d.fields;
    $("#marc-tags").innerHTML = Object.entries(S.dict).filter(([t]) => t !== "LDR").map(([t, x]) => `<option value="${esc(t)}">${esc(x.label)}</option>`).join("");
    await load();
  } catch (e) {
    panel().innerHTML = empty(e.message, "alert");
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
    if (action) { e.preventDefault(); act(action, p); }
  });
  $("#view-tabs").addEventListener("click", (e) => { const t = e.target.closest("[role=tab]"); if (t) switchView(t.dataset.view); });
  $("#view-tabs").addEventListener("keydown", (e) => {
    const tabs = $$("#view-tabs [role=tab]");
    const i = tabs.indexOf(document.activeElement);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    t.focus();
    switchView(t.dataset.view);
  });
  $("#problems").addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (!b || S.view !== "grid") return;
    if (b.dataset.part === "leader") { $("#leader")?.focus(); return; }
    if (b.dataset.goto === "") return;
    restoreFocus({ f: +b.dataset.goto, s: b.dataset.sub === "" ? null : +b.dataset.sub, k: b.dataset.part === "code" ? "code" : b.dataset.sub === "" ? (b.dataset.part || "tag") : "value" });
  });
  $("#save").addEventListener("click", (e) => reviewAndSave(e.currentTarget).catch((err) => { if (!err.toasted) toast(err.message, "error"); }));
  $("#revert").addEventListener("click", async () => {
    if (!(await modal({ title: "Discard changes?", body: "<p>Your unsaved edits will be lost and the stored record reloaded.</p>", submit: "Discard", danger: true }))) return;
    await load();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); $("#save").click(); }
  });
  window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
}
