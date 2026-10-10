// Staff › Catalogue › Labels & cards — what to print, which items/patrons, which sheet, with a live to-scale
// preview of the first sheet (click a position to start part-way through a used sheet) and a layout manager.
import { $, $$, api, authors, confirmDialog, debounce, html, icon, num, qs, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { combobox } from "/static/js/ui/combobox.js";
import { emptyState } from "/static/js/ui/empty.js";
import { sidePanel } from "/static/js/ui/panel.js";
import { actionMenu, alertBox, formModal, recNo, wireMenus } from "/static/js/pages/lib/collection.js";

let lk = { branches: [], categories: [] };
let layouts = [];
let lastPreview = null;
const form = () => $("#job");
const kindOf = () => form().elements.kind.value;
const opts = (list, sel, any) => html`<option value="">${any}</option>${list.map((x) => html`<option value="${x.id}" ${String(x.id) === String(sel ?? "") ? "selected" : ""}>${x.name}</option>`)}`;
const kindLabel = (k) => t(`coll.labels.kind_${k}`, {}, k);

// ------------------------------------------------------------------ source fields

function sourceFields(kind, p = {}) {
  if (kind === "patron") {
    return html`<div class="form-grid">
      <div class="field span-2"><label for="patron_q">${t("coll.labels.patron_q")}</label><input id="patron_q" name="patron_q" value="${p.patron_q || ""}" autocomplete="off"></div>
      <div class="field"><label for="category_id">${t("coll.labels.category")}</label><select id="category_id" name="category_id">${opts(lk.categories, p.category_id, t("coll.labels.any"))}</select></div>
      <div class="field"><label for="p-branch">${t("coll.items.branch")}</label><select id="p-branch" name="branch_id">${opts(lk.branches, p.branch_id, t("coll.labels.any"))}</select></div>
      <div class="field span-2"><label for="new_days">${t("coll.labels.new_days")}</label><input id="new_days" name="new_days" type="number" min="1" max="3650" value="${p.new_days || ""}" class="num-input"></div>
    </div><p class="field-help">${t("coll.labels.patron_help")}</p>`;
  }
  const src = p.source || "barcodes";
  return html`<div class="segmented" role="radiogroup" aria-label="${t("coll.labels.which_items")}">
      ${[["barcodes", t("coll.labels.src_barcodes")], ["recent", t("coll.labels.src_recent")], ["biblio", t("coll.labels.src_biblio")]].map(([v, l]) =>
        html`<label><input type="radio" name="source" value="${v}" ${v === src ? "checked" : ""}><span>${l}</span></label>`)}</div>
    <div data-src="barcodes" ${src !== "barcodes" ? "hidden" : ""} class="field"><label for="barcodes">${t("coll.labels.barcodes")}</label>
      <textarea id="barcodes" name="barcodes" rows="5" class="mono" placeholder="${t("coll.labels.barcodes_placeholder")}" spellcheck="false" aria-describedby="bc-count">${p.barcodes || ""}</textarea>
      <div class="row between"><span class="field-help" id="bc-count" aria-live="polite"></span>
        <span><input type="file" id="bc-file" accept=".txt,.csv,text/plain" class="sr-only" tabindex="-1" aria-hidden="true"><button type="button" class="btn sm" id="bc-load">${icon("upload")}${t("coll.labels.load_file")}</button></span></div></div>
    <div data-src="recent" ${src !== "recent" ? "hidden" : ""} class="form-grid">
      <div class="field"><label for="days">${t("coll.labels.days")}</label><input id="days" name="days" type="number" min="1" max="3650" value="${p.days || 7}"></div>
      <div class="field"><label for="r-branch">${t("common.branch")}</label><select id="r-branch" name="branch_id">${opts(lk.branches, p.branch_id, t("common.all_branches"))}</select></div></div>
    <div data-src="biblio" ${src !== "biblio" ? "hidden" : ""} class="field"><label for="biblio-q">${t("coll.labels.record")}</label>
      <input id="biblio-q" autocomplete="off" placeholder="${t("coll.labels.record_placeholder")}" aria-describedby="biblio-hint">
      <input type="hidden" name="biblio_id" id="biblio_id" value="${p.biblio_id || ""}">
      <div class="field-help" id="biblio-hint">${t("coll.labels.record_help")}</div></div>`;
}

function renderSource(p = {}) {
  $("#source-fields").innerHTML = sourceFields(kindOf(), p);
  $("#split-wrap").hidden = kindOf() !== "spine";
  countBarcodes();
  const q = $("#biblio-q");
  if (q) {
    combobox(q, {
      minChars: 2,
      source: async (term, signal) => (await api(`/search?${qs({ q: term, per_page: 8 })}`, { signal })).results,
      render: (b) => html`<span class="combo-main">${b.title}<span class="sub">${[authors(b.authors), b.pub_year, recNo(b.id)].filter(Boolean).join(" · ")}</span></span>`,
      value: (b) => b.title,
      onSelect: (b) => { $("#biblio_id").value = b.id; $("#biblio-hint").textContent = t("coll.labels.record_chosen", { no: recNo(b.id) }); refresh(); },
    });
    if (p.biblio_id) api(`/biblios/${p.biblio_id}`).then((b) => { q.value = b.title; $("#biblio-hint").textContent = t("coll.labels.record_chosen", { no: recNo(b.id) }); }).catch(() => {});
  }
}

function countBarcodes() {
  const ta = $("#barcodes");
  if (!ta) return;
  const n = ta.value.split(/[\s,;]+/).filter(Boolean).length;
  $("#bc-count").textContent = t("coll.labels.n_barcodes", { count: n, n: num(n) });
}

// ------------------------------------------------------------------ layouts

const currentLayout = () => layouts.find((l) => l.id === +form().elements.layout_id.value);
const layoutSummary = (l) => t("coll.labels.layout_summary", { cols: num(l.cols), rows: num(l.rows), per: num(l.per_sheet), w: num(l.label_width), h: num(l.label_height),
  page: l.page_size === "custom" ? `${num(l.page_width)} × ${num(l.page_height)} mm` : l.page_size });

function renderLayoutSelect(selected) {
  const kind = kindOf();
  const fit = layouts.filter((l) => l.kind === kind || l.kind === "any");
  const other = layouts.filter((l) => !fit.includes(l));
  const keep = selected ?? (fit.find((l) => l.id === +form().elements.layout_id.value)?.id) ?? fit[0]?.id ?? layouts[0]?.id;
  const opt = (l) => html`<option value="${l.id}" ${l.id === keep ? "selected" : ""}>${l.name}</option>`;
  form().elements.layout_id.innerHTML = html`<optgroup label="${t("coll.labels.suitable", { kind: kindLabel(kind) })}">${fit.map(opt)}</optgroup>
    ${other.length ? html`<optgroup label="${t("coll.labels.other_layouts")}">${other.map(opt)}</optgroup>` : ""}`;
  layoutChanged();
}

function layoutChanged() {
  const l = currentLayout();
  if (!l) return;
  $("#layout-hint").textContent = layoutSummary(l);
  const start = $("#start");
  start.max = l.per_sheet;
  if (+start.value > l.per_sheet) start.value = 1;
  refresh();
}

async function loadLayouts(selected) {
  layouts = (await api("/labels/layouts")).results;
  renderLayoutSelect(selected);
}

function layoutForm(l = {}) {
  const n = (name, label, value, step = "0.01", min = "0") => html`<div class="field"><label for="l-${name}">${label}</label>
    <input id="l-${name}" name="${name}" type="number" step="${step}" min="${min}" value="${value ?? ""}" required></div>`;
  return html`<div class="stack"><div class="form-grid">
      <div class="field span-2"><label for="l-name">${t("coll.labels.l_name")}</label><input id="l-name" name="name" required maxlength="120" value="${l.name || ""}"></div>
      <div class="field"><label for="l-kind">${t("coll.labels.l_kind")}</label><select id="l-kind" name="kind">${["spine", "item", "patron", "any"].map((v) => html`<option value="${v}" ${v === (l.kind || "any") ? "selected" : ""}>${kindLabel(v)}</option>`)}</select></div>
      <div class="field"><label for="l-page">${t("coll.labels.l_page")}</label><select id="l-page" name="page_size">${["A4", "Letter", "custom"].map((v) => html`<option value="${v}" ${v === (l.page_size || "A4") ? "selected" : ""}>${v === "custom" ? t("coll.labels.l_custom") : v}</option>`)}</select></div>
      ${n("page_width", t("coll.labels.l_page_w"), l.page_width ?? 210)}${n("page_height", t("coll.labels.l_page_h"), l.page_height ?? 297)}
      ${n("cols", t("coll.labels.l_cols"), l.cols ?? 3, "1", "1")}${n("rows", t("coll.labels.l_rows"), l.rows ?? 7, "1", "1")}
      ${n("label_width", t("coll.labels.l_label_w"), l.label_width ?? 63.5)}${n("label_height", t("coll.labels.l_label_h"), l.label_height ?? 38.1)}
      ${n("margin_left", t("coll.labels.l_margin_l"), l.margin_left ?? 7)}${n("margin_top", t("coll.labels.l_margin_t"), l.margin_top ?? 15)}
      ${n("gutter_x", t("coll.labels.l_gap_x"), l.gutter_x ?? 2.5)}${n("gutter_y", t("coll.labels.l_gap_y"), l.gutter_y ?? 0)}
      ${n("padding", t("coll.labels.l_padding"), l.padding ?? 2)}${n("font_size", t("coll.labels.l_font"), l.font_size ?? 9, "0.5", "3")}
    </div><p class="small muted">${t("coll.labels.l_hint")}</p></div>`;
}

async function editLayout(l, copy = false) {
  const body = copy ? { ...l, name: t("coll.labels.copy_name", { name: l.name }) } : l;
  const saved = await formModal({ title: copy ? t("coll.labels.new_layout") : t("coll.labels.edit_layout", { name: l.name }), body: layoutForm(body), submit: t("coll.labels.save_layout"), size: "lg" },
    (fd) => {
      const payload = Object.fromEntries([...fd].map(([k, v]) => [k, ["name", "kind", "page_size"].includes(k) ? v : Number(v)]));
      return l?.id && !copy ? api(`/labels/layouts/${l.id}`, { method: "PUT", body: payload }) : api("/labels/layouts", { method: "POST", body: payload });
    },
    (dlg) => {
      const f = $("form", dlg);
      const sync = () => {
        const custom = f.elements.page_size.value === "custom";
        for (const k of ["page_width", "page_height"]) f.elements[k].readOnly = !custom;
        if (!custom) {
          const a4 = f.elements.page_size.value === "A4";
          f.elements.page_width.value = a4 ? 210 : 215.9;
          f.elements.page_height.value = a4 ? 297 : 279.4;
        }
      };
      f.elements.page_size.addEventListener("change", sync);
      sync();
    });
  if (saved) { toast(t("coll.labels.layout_saved", { name: saved.name }), "success"); await loadLayouts(saved.id); }
  return saved;
}

function layoutsPanel() {
  const list = () => (layouts.length ? html`<ul class="layout-list" role="list">${layouts.map((l) => html`<li>
      <div class="ll-main"><strong>${l.name}</strong><span class="small muted">${kindLabel(l.kind)} · ${layoutSummary(l)}${l.is_preset ? ` · ${t("coll.labels.preset")}` : ""}</span></div>
      ${actionMenu({ label: t("coll.labels.layout_actions", { name: l.name }), size: "sm", data: String(l.id), items: [
        { id: "copy", label: t("coll.labels.duplicate"), icon: "copy" },
        l.is_preset ? null : { id: "edit", label: t("coll.common.edit"), icon: "edit" },
        l.is_preset ? null : { separator: true },
        l.is_preset ? null : { id: "delete", label: t("coll.labels.delete_layout"), icon: "trash", danger: true },
      ] })}</li>`)}</ul>` : emptyState({ compact: true, title: t("coll.labels.no_layouts") }));
  const p = sidePanel({ title: t("coll.labels.layouts"), subtitle: t("coll.labels.layouts_sub"), body: list(),
    footer: html`<button type="button" class="btn primary" data-new-layout>${icon("plus")}${t("coll.labels.new_layout")}</button>` });
  const rewire = () => { p.setBody(list()); wireMenus(p.el, onAct); };
  const onAct = async (act, btn, key) => {
    const l = layouts.find((x) => String(x.id) === key);
    if (!l) return;
    try {
      if (act === "copy") { if (await editLayout(l, true)) rewire(); }
      else if (act === "edit") { if (await editLayout(l)) rewire(); }
      else if (act === "delete" && (await confirmDialog(t("coll.labels.delete_title"), t("coll.labels.delete_text", { name: l.name }), t("coll.labels.delete_layout")))) {
        await api(`/labels/layouts/${l.id}`, { method: "DELETE" });
        toast(t("coll.labels.layout_deleted"), "success");
        await loadLayouts();
        rewire();
      }
    } catch (e) { toast(e.message, "error"); }
  };
  wireMenus(p.el, onAct);
  p.el.addEventListener("click", async (e) => { if (e.target.closest("[data-new-layout]") && (await editLayout(currentLayout() || {}, true))) rewire(); });
}

// ------------------------------------------------------------------ live preview

function jobBody() {
  const fd = new FormData(form());
  const body = {};
  for (const [k, v] of fd) if (typeof v === "string" && v.trim() !== "") body[k] = v.trim();
  for (const k of ["layout_id", "start", "copies", "days", "branch_id", "biblio_id", "category_id", "new_days"]) if (k in body) body[k] = +body[k];
  body.split_decimal = fd.get("split_decimal") === "on";
  if (body.kind === "patron") body.source = "patrons";
  else {
    if (body.source !== "recent") { delete body.days; delete body.branch_id; }
    if (body.source !== "barcodes") delete body.barcodes;
    if (body.source !== "biblio") delete body.biblio_id;
  }
  return body;
}

function hasSelection(b) {
  if (b.kind === "patron") return !!(b.patron_q || b.category_id || b.branch_id || b.new_days);
  if (b.source === "barcodes") return !!b.barcodes;
  if (b.source === "biblio") return !!b.biblio_id;
  return true;
}

function cellContent(e, kind) {
  if (!e) return "";
  if (kind === "spine") return html`${(e.lines || [e.barcode]).map((l) => html`<span class="pl">${l}</span>`)}`;
  if (kind === "patron") return html`<span class="pt">${e.name}</span><span class="bars" aria-hidden="true"></span><span class="pl mono">${e.card_number}</span>`;
  return html`<span class="pt">${e.title}</span><span class="bars" aria-hidden="true"></span><span class="pl mono">${e.barcode}</span>`;
}

function drawSheet(l, entries = [], kind = kindOf()) {
  const start = Math.min(Math.max(+$("#start").value || 1, 1), l.per_sheet);
  const pct = (v, of) => `${(100 * v) / of}%`;
  const cells = [];
  let idx = 0;
  for (let i = 0; i < l.per_sheet; i++) {
    const r = Math.floor(i / l.cols), c = i % l.cols, n = i + 1;
    const used = n < start;
    const e = !used ? entries[idx++] : null;
    const style = `inset-inline-start:${pct(l.margin_left + c * (l.label_width + l.gutter_x), l.page_width)};top:${pct(l.margin_top + r * (l.label_height + l.gutter_y), l.page_height)};`
      + `width:${pct(l.label_width, l.page_width)};height:${pct(l.label_height, l.page_height)}`;
    cells.push(html`<button type="button" class="cell ${used ? "used" : ""} ${e ? "filled" : ""} ${n === start ? "start" : ""}" style="${style}" data-start="${n}"
      aria-pressed="${n === start}" aria-label="${t("coll.labels.cell_label", { n, row: r + 1, col: c + 1 })}${used ? ` · ${t("coll.labels.used")}` : ""}">${cellContent(e, kind)}</button>`);
  }
  // keep every target at least ~26px tall: grow the sheet when labels are small (WCAG 2.5.8)
  const minH = Math.max(1, Math.ceil(26 / (l.label_height / l.page_height)));
  $("#sheet-wrap").innerHTML = html`<div class="sheet ${kind}" role="group" aria-label="${t("coll.labels.sheet_label")}" style="aspect-ratio:${l.page_width}/${l.page_height};min-block-size:${Math.min(minH, 1400)}px">${cells}</div>`;
}

const refresh = debounce(async () => {
  const l = currentLayout();
  if (!l) return;
  const body = jobBody();
  drawSheet(l, lastPreview?.kind === body.kind ? lastPreview.entries : []);
  const sum = $("#preview-summary");
  if (!hasSelection(body)) {
    lastPreview = null;
    drawSheet(l, []);
    $("#preview-status").textContent = "";
    sum.innerHTML = html`<p class="small muted">${t(body.kind === "patron" ? "coll.labels.choose_patrons" : "coll.labels.choose_items")}</p>`;
    return;
  }
  $("#preview-status").textContent = t("coll.labels.updating");
  try {
    const r = await api("/labels/preview", { method: "POST", body });
    lastPreview = r;
    drawSheet(l, r.entries, r.kind);
    $("#preview-status").textContent = "";
    sum.innerHTML = html`<ul class="tag-list" role="list">
        <li><span class="badge pill success"><span class="dot" aria-hidden="true"></span>${t(r.kind === "patron" ? "coll.labels.n_cards" : "coll.labels.n_labels", { count: r.count, n: num(r.count) })}</span></li>
        <li><span class="badge pill info"><span class="dot" aria-hidden="true"></span>${t("coll.labels.n_sheets", { count: r.sheets, n: num(r.sheets) })}</span></li>
        <li><span class="badge pill neutral"><span class="dot" aria-hidden="true"></span>${t("coll.labels.n_blank", { n: num(r.blank_cells) })}</span></li></ul>
      ${r.missing.length ? alertBox(html`<strong>${t("coll.labels.not_found", { count: r.missing.length, n: num(r.missing.length) })}</strong> <span class="mono small">${r.missing.slice(0, 40).join(", ")}${r.missing.length > 40 ? " …" : ""}</span>`, "warn") : ""}
      ${r.errors.length ? alertBox(t("coll.labels.unencodable", { count: r.errors.length, n: num(r.errors.length) }), "warn") : ""}
      ${r.sheets > 1 ? html`<p class="small muted">${t("coll.labels.first_sheet_only")}</p>` : ""}`;
  } catch (e) {
    $("#preview-status").textContent = "";
    sum.innerHTML = alertBox(e.message);
  }
}, 350);

// ------------------------------------------------------------------ init

export default async function init() {
  lk = await api("/lookups");
  const p = Object.fromEntries(new URLSearchParams(location.search));
  if (p.kind) { const radio = $(`input[name=kind][value="${CSS.escape(p.kind)}"]`, form()); if (radio) radio.checked = true; }
  renderSource(p);
  try { await loadLayouts(); } catch (e) { toast(e.message, "error"); }

  const remembered = { item: p, patron: p };
  let shownKind = kindOf();
  form().addEventListener("change", (e) => {
    const el = e.target;
    if (el.name === "kind") {
      const group = (k) => (k === "patron" ? "patron" : "item");
      remembered[group(shownKind)] = Object.fromEntries(new FormData(form()));
      shownKind = el.value;
      lastPreview = null;
      renderSource({ ...remembered[group(shownKind)], kind: shownKind });
      renderLayoutSelect();
      return;
    }
    if (el.name === "source") $$("[data-src]", form()).forEach((d) => { d.hidden = d.dataset.src !== el.value; });
    else if (el.name === "layout_id") { layoutChanged(); return; }
    else if (el.id === "bc-file" && el.files[0]) {
      el.files[0].text().then((txt) => {
        const ta = $("#barcodes");
        ta.value = [ta.value.trim(), txt.trim()].filter(Boolean).join("\n");
        countBarcodes();
        el.value = "";
        refresh();
      });
      return;
    }
    refresh();
  });
  form().addEventListener("input", (e) => { if (e.target.id === "barcodes") countBarcodes(); if (e.target.id !== "biblio-q") refresh(); });
  form().addEventListener("click", (e) => { if (e.target.closest("#bc-load")) $("#bc-file").click(); });
  $("#sheet-wrap").addEventListener("click", (e) => {
    const cell = e.target.closest("[data-start]");
    if (!cell) return;
    $("#start").value = cell.dataset.start;
    const l = currentLayout();
    drawSheet(l, lastPreview?.entries || [], lastPreview?.kind);
    $(`#sheet-wrap [data-start="${cell.dataset.start}"]`)?.focus();
  });
  // arrow keys move between positions on the preview sheet
  $("#sheet-wrap").addEventListener("keydown", (e) => {
    const cell = e.target.closest("[data-start]");
    const l = currentLayout();
    if (!cell || !l) return;
    const n = +cell.dataset.start;
    const rtl = getComputedStyle(cell).direction === "rtl";
    const d = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: l.cols, ArrowUp: -l.cols }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    const to = Math.min(l.per_sheet, Math.max(1, n + d));
    $(`#sheet-wrap [data-start="${to}"]`)?.focus();
  });
  form().addEventListener("submit", (e) => {
    const body = jobBody();
    if (!currentLayout()) { e.preventDefault(); toast(t("coll.labels.choose_layout"), "error"); return; }
    if (!hasSelection(body)) { e.preventDefault(); toast(t(body.kind === "patron" ? "coll.labels.choose_patrons" : "coll.labels.choose_items"), "error"); }
  });
  $("#layouts-btn").addEventListener("click", layoutsPanel);
  refresh();
}
