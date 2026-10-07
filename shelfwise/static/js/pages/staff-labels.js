// Staff: labels & patron cards — build a print job, check it, manage sheet layouts.
import { $, $$, api, confirmDialog, empty, html, icon, modal, num, raw, toast, withBusy } from "/static/js/core.js";

let lk = { branches: [], categories: [] };
let layouts = [];
const form = () => $("#job");
const kindOf = () => form().elements.kind.value;
const opts = (list, sel, any = "Any") => html`<option value="">${any}</option>${list.map((x) => html`<option value="${x.id}" ${String(x.id) === String(sel ?? "") ? "selected" : ""}>${x.name}</option>`)}`;
const KIND_LABEL = { spine: "Spine", item: "Item", patron: "Patron card", any: "Any" };

// ------------------------------------------------------------------ source fields

function sourceFields(kind, p = {}) {
  if (kind === "patron") {
    return html`<div class="grid cols-2">
      <div class="field" style="grid-column:1/-1"><label for="patron_q">Name or card number</label><input id="patron_q" name="patron_q" value="${p.patron_q || ""}" autocomplete="off"></div>
      <div class="field"><label for="category_id">Category</label><select id="category_id" name="category_id">${opts(lk.categories, p.category_id)}</select></div>
      <div class="field"><label for="p-branch">Home branch</label><select id="p-branch" name="branch_id">${opts(lk.branches, p.branch_id)}</select></div>
      <div class="field"><label for="new_days">Registered in the last (days)</label><input id="new_days" name="new_days" type="number" min="1" max="3650" value="${p.new_days || ""}"></div>
    </div><span class="hint">Combine any of these; at least one is needed. Up to 5,000 cards per job.</span>`;
  }
  const src = p.source || "barcodes";
  return html`<div class="row tight" role="radiogroup" aria-label="Which items">
      ${[["barcodes", "Barcode list"], ["recent", "Recently added"], ["biblio", "One record's items"]].map(([v, l]) =>
        html`<label class="checkbox chip"><input type="radio" name="source" value="${v}" ${v === src ? "checked" : ""}> ${l}</label>`)}</div>
    <div data-src="barcodes" ${src !== "barcodes" ? "hidden" : ""} class="field"><label for="barcodes">Barcodes</label>
      <textarea id="barcodes" name="barcodes" rows="6" class="mono" placeholder="Scan or paste barcodes, one per line" spellcheck="false">${p.barcodes || ""}</textarea>
      <div class="row between"><span class="hint" id="bc-count" aria-live="polite"></span>
        <span><input type="file" id="bc-file" accept=".txt,.csv,text/plain" hidden><button type="button" class="btn sm" id="bc-load">${icon("upload")}Load from file</button></span></div></div>
    <div data-src="recent" ${src !== "recent" ? "hidden" : ""} class="grid cols-2">
      <div class="field"><label for="days">Added in the last (days)</label><input id="days" name="days" type="number" min="1" max="3650" value="${p.days || 7}"></div>
      <div class="field"><label for="r-branch">Branch</label><select id="r-branch" name="branch_id">${opts(lk.branches, p.branch_id, "All branches")}</select></div></div>
    <div data-src="biblio" ${src !== "biblio" ? "hidden" : ""} class="field"><label for="biblio_id">Record number</label>
      <input id="biblio_id" name="biblio_id" type="number" min="1" value="${p.biblio_id || ""}"><span class="hint" id="biblio-hint">The # shown on the record page.</span></div>`;
}

function renderSource(p = {}) {
  $("#source-fields").innerHTML = sourceFields(kindOf(), p);
  $("#split-wrap").hidden = kindOf() !== "spine";
  countBarcodes();
}

function countBarcodes() {
  const ta = $("#barcodes");
  if (!ta) return;
  const n = ta.value.split(/[\s,;]+/).filter(Boolean).length;
  $("#bc-count").textContent = `${num(n)} barcode${n === 1 ? "" : "s"}`;
}

// ------------------------------------------------------------------ layouts & sheet picker

function currentLayout() {
  return layouts.find((l) => l.id === +form().elements.layout_id.value);
}

function renderLayoutSelect(selected) {
  const kind = kindOf();
  const fit = layouts.filter((l) => l.kind === kind || l.kind === "any");
  const other = layouts.filter((l) => !fit.includes(l));
  const keep = selected ?? (fit.find((l) => l.id === +form().elements.layout_id.value)?.id) ?? fit[0]?.id ?? layouts[0]?.id;
  const opt = (l) => html`<option value="${l.id}" ${l.id === keep ? "selected" : ""}>${l.name}</option>`;
  form().elements.layout_id.innerHTML = html`<optgroup label="Suitable for ${KIND_LABEL[kind].toLowerCase()}s">${fit.map(opt)}</optgroup>
    ${other.length ? html`<optgroup label="Other layouts">${other.map(opt)}</optgroup>` : ""}`;
  layoutChanged();
}

function layoutChanged() {
  const l = currentLayout();
  if (!l) return;
  $("#layout-hint").textContent = `${l.cols} × ${l.rows} = ${l.per_sheet} per sheet · ${l.label_width} × ${l.label_height} mm · ${l.page_size === "custom" ? `${l.page_width} × ${l.page_height} mm` : l.page_size}`;
  const start = $("#start");
  start.max = l.per_sheet;
  if (+start.value > l.per_sheet) start.value = 1;
  renderPicker();
}

function renderPicker() {
  const l = currentLayout();
  if (!l) return;
  const start = Math.min(Math.max(+$("#start").value || 1, 1), l.per_sheet);
  const box = $("#sheet-picker");
  box.style.gridTemplateColumns = `repeat(${l.cols}, auto)`;
  box.innerHTML = Array.from({ length: l.per_sheet }, (_, i) => {
    const n = i + 1;
    return `<button type="button" data-start="${n}" class="${n < start ? "used" : ""}" aria-pressed="${n === start}" aria-label="Start at label ${n} (row ${Math.floor(i / l.cols) + 1}, column ${(i % l.cols) + 1})" title="Label ${n}"></button>`;
  }).join("");
}

function renderLayouts() {
  $("#layouts").innerHTML = layouts.length ? html`<ul class="stack tight" style="list-style:none;margin:0;padding:0">${layouts.map((l) => html`<li class="row between" style="gap:.5rem">
      <div><div class="small" style="font-weight:600">${l.name}</div>
        <div class="tiny muted">${KIND_LABEL[l.kind]} · ${l.cols}×${l.rows} · ${l.label_width}×${l.label_height} mm · ${l.page_size}${l.is_preset ? " · preset" : ""}</div></div>
      <div class="row tight nowrap"><button type="button" class="btn sm ghost" data-copy="${l.id}" aria-label="Duplicate ${l.name}" title="Duplicate">${icon("copy")}</button>
        ${l.is_preset ? "" : html`<button type="button" class="btn sm ghost" data-edit="${l.id}" aria-label="Edit ${l.name}" title="Edit">${icon("edit")}</button>
        <button type="button" class="btn sm ghost danger" data-del="${l.id}" aria-label="Delete ${l.name}" title="Delete">${icon("trash")}</button>`}</div></li>`)}</ul>`
    : empty("No layouts");
}

async function loadLayouts(selected) {
  layouts = (await api("/labels/layouts")).results;
  renderLayouts();
  renderLayoutSelect(selected);
}

function layoutForm(l = {}) {
  const n = (name, label, value, step = "0.01", min = "0") => html`<div class="field"><label for="l-${name}">${label}</label>
    <input id="l-${name}" name="${name}" type="number" step="${step}" min="${min}" value="${value ?? ""}" required></div>`;
  return html`<div class="stack">
    <div class="grid cols-2">
      <div class="field" style="grid-column:1/-1"><label for="l-name">Name</label><input id="l-name" name="name" required maxlength="120" value="${l.name || ""}"></div>
      <div class="field"><label for="l-kind">Used for</label><select id="l-kind" name="kind">${Object.entries(KIND_LABEL).map(([v, t]) => html`<option value="${v}" ${v === (l.kind || "any") ? "selected" : ""}>${t}</option>`)}</select></div>
      <div class="field"><label for="l-page">Page</label><select id="l-page" name="page_size">${["A4", "Letter", "custom"].map((v) => html`<option value="${v}" ${v === (l.page_size || "A4") ? "selected" : ""}>${v}</option>`)}</select></div>
      ${n("page_width", "Page width (mm)", l.page_width ?? 210)}${n("page_height", "Page height (mm)", l.page_height ?? 297)}
      ${n("cols", "Columns", l.cols ?? 3, "1", "1")}${n("rows", "Rows", l.rows ?? 7, "1", "1")}
      ${n("label_width", "Label width (mm)", l.label_width ?? 63.5)}${n("label_height", "Label height (mm)", l.label_height ?? 38.1)}
      ${n("margin_left", "Left margin (mm)", l.margin_left ?? 7)}${n("margin_top", "Top margin (mm)", l.margin_top ?? 15)}
      ${n("gutter_x", "Gap between columns (mm)", l.gutter_x ?? 2.5)}${n("gutter_y", "Gap between rows (mm)", l.gutter_y ?? 0)}
      ${n("padding", "Inner padding (mm)", l.padding ?? 2)}${n("font_size", "Font size (pt)", l.font_size ?? 9, "0.5", "3")}
    </div><p class="tiny muted">Measure from the top-left corner of the sheet. Print a test sheet with “Print outlines” to check alignment.</p></div>`;
}

async function editLayout(l, copy = false) {
  const body = copy ? { ...l, name: `${l.name} (copy)` } : l;
  let saved = null;
  const done = modal({ title: copy ? "New layout" : `Edit ${l?.name || "layout"}`, body: layoutForm(body), submit: "Save layout", wide: true });
  const dlg = $$("dialog").at(-1);
  const f = $("form", dlg);
  const syncPage = () => {
    const custom = f.elements.page_size.value === "custom";
    for (const k of ["page_width", "page_height"]) { f.elements[k].readOnly = !custom; }
    if (!custom) {
      const a4 = f.elements.page_size.value === "A4";
      f.elements.page_width.value = a4 ? 210 : 215.9;
      f.elements.page_height.value = a4 ? 297 : 279.4;
    }
  };
  f.elements.page_size.addEventListener("change", syncPage);
  syncPage();
  const ok = $('button[value="ok"]', dlg);
  f.addEventListener("submit", async (e) => {
    if (e.submitter !== ok) return;
    e.preventDefault();
    if (!f.checkValidity()) { f.reportValidity(); return; }
    const fd = new FormData(f);
    const payload = Object.fromEntries([...fd].map(([k, v]) => [k, ["name", "kind", "page_size"].includes(k) ? v : Number(v)]));
    try {
      saved = await withBusy(ok, () => (l?.id && !copy ? api(`/labels/layouts/${l.id}`, { method: "PUT", body: payload }) : api("/labels/layouts", { method: "POST", body: payload })));
      dlg.close("ok");
    } catch { /* toasted */ }
  });
  await done;
  if (saved) { toast(`Layout “${saved.name}” saved`, "success"); await loadLayouts(saved.id); }
}

// ------------------------------------------------------------------ job preview

function jobBody() {
  const fd = new FormData(form());
  const body = {};
  for (const [k, v] of fd) if (typeof v === "string" && v.trim() !== "") body[k] = v.trim();
  for (const k of ["layout_id", "start", "copies", "days", "branch_id", "biblio_id", "category_id", "new_days"]) if (k in body) body[k] = +body[k];
  body.split_decimal = fd.get("split_decimal") === "on";
  if (body.kind === "patron") {
    body.source = "patrons";
  } else {
    if (body.source !== "recent") { delete body.days; delete body.branch_id; }
    if (body.source !== "barcodes") delete body.barcodes;
    if (body.source !== "biblio") delete body.biblio_id;
  }
  return body;
}

function previewOut(r) {
  const isPatron = r.kind === "patron";
  return html`<div class="stack">
    <div class="row tight"><span class="badge ok">${num(r.count)} ${isPatron ? "card" : "label"}${r.count === 1 ? "" : "s"}</span>
      <span class="badge info">${num(r.sheets)} sheet${r.sheets === 1 ? "" : "s"}</span><span class="badge">${num(r.blank_cells)} blank</span></div>
    ${r.missing.length ? html`<div class="alert warn">${icon("alert")}<div><strong>Not found (${r.missing.length}):</strong> <span class="mono small">${r.missing.slice(0, 50).join(", ")}${r.missing.length > 50 ? " …" : ""}</span></div></div>` : ""}
    ${r.errors.length ? html`<div class="alert warn">${icon("alert")}<div>${r.errors.length} value(s) cannot be printed as a barcode (unsupported characters).</div></div>` : ""}
    ${r.entries.length ? html`<div class="table-wrap" style="max-height:16rem;overflow:auto"><table class="table"><thead><tr>${isPatron ? raw("<th>Card</th><th>Name</th><th>Expires</th>") : raw("<th>Barcode</th><th>Title</th><th>Call no.</th>")}</tr></thead><tbody>
      ${r.entries.map((e) => (isPatron ? html`<tr><td class="mono small">${e.card_number}</td><td>${e.name}</td><td class="small">${e.expires_on || "—"}</td></tr>`
        : html`<tr><td class="mono small">${e.barcode}</td><td class="small">${e.title}</td><td class="mono small">${r.kind === "spine" ? e.lines.join(" / ") : e.call_number}</td></tr>`))}</tbody></table></div>` : ""}
  </div>`;
}

async function preview(btn) {
  const r = await withBusy(btn, () => api("/labels/preview", { method: "POST", body: jobBody() }));
  $("#preview-out").innerHTML = previewOut(r);
  return r;
}

// ------------------------------------------------------------------ init

export default async function init() {
  lk = await api("/lookups");
  const p = Object.fromEntries(new URLSearchParams(location.search));
  if (p.kind && form().elements.kind) {
    const radio = $(`input[name=kind][value="${CSS.escape(p.kind)}"]`, form());
    if (radio) radio.checked = true;
  }
  renderSource(p);
  try { await loadLayouts(); } catch (e) { toast(e.message, "error"); }

  form().addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "kind") { renderSource(Object.fromEntries(new FormData(form()))); renderLayoutSelect(); }
    else if (t.name === "source") $$("[data-src]", form()).forEach((d) => { d.hidden = d.dataset.src !== t.value; });
    else if (t.name === "layout_id") layoutChanged();
    else if (t.id === "start") renderPicker();
    else if (t.id === "bc-file" && t.files[0]) {
      t.files[0].text().then((txt) => {
        const ta = $("#barcodes");
        ta.value = [ta.value.trim(), txt.trim()].filter(Boolean).join("\n");
        countBarcodes();
        t.value = "";
      });
    }
  });
  form().addEventListener("input", (e) => { if (e.target.id === "barcodes") countBarcodes(); if (e.target.id === "start") renderPicker(); });
  form().addEventListener("click", (e) => {
    const cell = e.target.closest("[data-start]");
    if (cell) { $("#start").value = cell.dataset.start; renderPicker(); $(`[data-start="${cell.dataset.start}"]`)?.focus(); }
    if (e.target.closest("#bc-load")) $("#bc-file").click();
  });
  form().addEventListener("submit", (e) => {
    if (!currentLayout()) { e.preventDefault(); toast("Choose a sheet layout first", "error"); }
  });
  $("#preview-btn").addEventListener("click", (e) => preview(e.currentTarget).catch(() => {}));
  $("#new-layout").addEventListener("click", () => editLayout(currentLayout() || {}, true));
  $("#layouts").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const l = layouts.find((x) => x.id === +(b.dataset.copy || b.dataset.edit || b.dataset.del));
    if (!l) return;
    try {
      if (b.dataset.copy) await editLayout(l, true);
      else if (b.dataset.edit) await editLayout(l);
      else if (b.dataset.del && (await confirmDialog("Delete layout?", `“${l.name}” will be removed.`, "Delete"))) {
        await api(`/labels/layouts/${l.id}`, { method: "DELETE" });
        toast("Layout deleted", "success");
        await loadLayouts();
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
}
