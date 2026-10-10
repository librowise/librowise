// Staff › Catalogue › Batch & inventory.
// Batch modify / withdraw-delete: 1 choose items (barcodes or a catalogue search) → 2 choose changes → preview every
// item's change → apply (delete needs the number of items typed to confirm). Inventory: scan a shelf, compare with
// the catalogue and fix what is wrong (missing, out of place, wrong status) from the report.
import { $, $$, BOOT, api, confirmDialog, date, html, icon, num, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { confirmDestructive } from "/static/js/ui/dialog.js";
import { dataTable, downloadCSV } from "/static/js/ui/data-table.js";
import { statTile } from "/static/js/ui/stat.js";
import { statusPill } from "/static/js/ui/status.js";
import { alertBox, fmtLabel } from "/static/js/pages/lib/collection.js";

let lk = { branches: [], item_types: [], material_types: [] };
const panel = () => $("#batch-panel");
const STATUSES = ["available", "on_loan", "on_hold_shelf", "in_transit", "processing", "lost", "damaged", "withdrawn"];
const EDITABLE = ["available", "processing", "lost", "damaged", "withdrawn"];
const SCANS_KEY = "sw-inventory-scans";
const opts = (list, sel, any) => html`${any ? html`<option value="">${any}</option>` : ""}${list.map((x) => html`<option value="${x.id}" ${String(x.id) === String(sel ?? "") ? "selected" : ""}>${x.name}</option>`)}`;
const statusOpts = (list, any) => html`${any ? html`<option value="">${any}</option>` : ""}${list.map((s) => html`<option value="${s}">${t(`status.${s}`)}</option>`)}`;
const splitCodes = (text) => text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

function mount(content) {
  const root = document.createElement("div");
  root.className = "batch-root";
  root.innerHTML = content;
  panel().replaceChildren(root);
  return root;
}

function loadFileInto(input, textarea, after) {
  input.addEventListener("change", async () => {
    const f = input.files[0];
    if (!f) return;
    textarea.value = [textarea.value.trim(), (await f.text()).trim()].filter(Boolean).join("\n");
    input.value = "";
    after?.();
  });
}

// ------------------------------------------------------------------ step 1: item selection (shared)

function selectionStep(p) {
  return html`<fieldset class="step"><legend><span class="step-no" aria-hidden="true">1</span>${t("coll.batch.step_choose")}</legend>
    <div class="segmented" role="radiogroup" aria-label="${t("coll.batch.how_choose")}">
      <label><input type="radio" name="${p}-mode" value="barcodes" checked><span>${t("coll.batch.by_barcode")}</span></label>
      <label><input type="radio" name="${p}-mode" value="search"><span>${t("coll.batch.by_search")}</span></label></div>
    <div data-mode="barcodes" class="field"><label for="${p}-codes">${t("coll.labels.barcodes")}</label>
      <textarea id="${p}-codes" rows="6" class="mono" spellcheck="false" placeholder="${t("coll.labels.barcodes_placeholder")}" aria-describedby="${p}-count"></textarea>
      <div class="row between"><span class="field-help" id="${p}-count" data-count aria-live="polite">${t("coll.labels.n_barcodes", { count: 0, n: num(0) })}</span>
        <span><input type="file" id="${p}-file" accept=".txt,.csv,text/plain" class="sr-only" tabindex="-1" aria-hidden="true"><button type="button" class="btn sm" data-load="${p}-file">${icon("upload")}${t("coll.labels.load_file")}</button></span></div></div>
    <div data-mode="search" hidden class="form-grid three">
      <div class="field span-all"><label for="${p}-q">${t("coll.batch.keywords")}</label><input id="${p}-q" data-s="q" type="search" autocomplete="off"></div>
      <div class="field"><label for="${p}-mt">${t("coll.field.format")}</label><select id="${p}-mt" data-s="material_type"><option value="">${t("coll.labels.any")}</option>${lk.material_types.map((m) => html`<option value="${m}">${fmtLabel(m)}</option>`)}</select></div>
      <div class="field"><label for="${p}-br">${t("common.branch")}</label><select id="${p}-br" data-s="branch_id">${opts(lk.branches, "", t("coll.labels.any"))}</select></div>
      <div class="field"><label for="${p}-it">${t("coll.items.type")}</label><select id="${p}-it" data-s="item_type_id">${opts(lk.item_types, "", t("coll.labels.any"))}</select></div>
      <div class="field"><label for="${p}-st">${t("coll.items.status")}</label><select id="${p}-st" data-s="status">${statusOpts(STATUSES, t("coll.labels.any"))}</select></div>
      <div class="field"><label for="${p}-loc">${t("coll.items.shelf_location")}</label><input id="${p}-loc" data-s="shelf_location" list="locations" autocomplete="off" placeholder="${t("coll.labels.any")}"></div>
      <div class="field"><label for="${p}-cn">${t("coll.batch.cn_prefix")}</label><input id="${p}-cn" data-s="call_number_prefix" class="mono" autocomplete="off"></div>
    </div></fieldset>`;
}

function wireSelection(root, p) {
  const ta = $(`#${p}-codes`, root);
  const count = () => { const n = splitCodes(ta.value).length; $("[data-count]", root).textContent = t("coll.labels.n_barcodes", { count: n, n: num(n) }); };
  ta.addEventListener("input", count);
  loadFileInto($(`#${p}-file`, root), ta, count);
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-load]"); if (b) $(`#${b.dataset.load}`).click(); });
  root.addEventListener("change", (e) => {
    if (e.target.name === `${p}-mode`) $$("[data-mode]", root).forEach((d) => { d.hidden = d.dataset.mode !== e.target.value; });
  });
}

function readSelection(root, p) {
  const mode = $(`input[name="${p}-mode"]:checked`, root).value;
  if (mode === "barcodes") {
    const codes = splitCodes($(`#${p}-codes`, root).value);
    if (!codes.length) throw new Error(t("coll.batch.need_barcode"));
    return { barcodes: codes };
  }
  const search = {};
  $$("[data-s]", root).forEach((el) => { if (el.value.trim()) search[el.dataset.s] = ["branch_id", "item_type_id"].includes(el.dataset.s) ? +el.value : el.value.trim(); });
  if (!Object.keys(search).length) throw new Error(t("coll.batch.need_criterion"));
  return { search };
}

// ------------------------------------------------------------------ results

const RESULT_TONE = { change: "info", changed: "success", unchanged: "neutral", skipped: "warning", withdraw: "warning", delete: "danger", withdrawn: "success", deleted: "success" };
const resultPill = (r) => html`<span class="badge pill ${RESULT_TONE[r] || "neutral"}"><span class="dot" aria-hidden="true"></span>${t(`coll.batch.result_${r}`, {}, r)}</span>`;

function summaryRow(summary, unknown) {
  return html`<ul class="tag-list result-summary" role="list">${Object.entries(summary).map(([k, n]) => html`<li>${resultPill(k)} <span class="num">${num(n)}</span></li>`)}
      ${unknown.length ? html`<li><span class="badge pill danger"><span class="dot" aria-hidden="true"></span>${t("coll.batch.unknown")}</span> <span class="num">${num(unknown.length)}</span></li>` : ""}</ul>
    ${unknown.length ? alertBox(html`<strong>${t("coll.batch.not_in_catalogue")}</strong> <span class="mono small">${unknown.slice(0, 100).join(", ")}${unknown.length > 100 ? " …" : ""}</span>`, "warn") : ""}`;
}

function resultsTable(el, rows, withChanges, id) {
  const table = dataTable(el, {
    id, caption: t("coll.batch.results"), exportName: id, rowKey: (r) => r.item_id ?? r.barcode,
    columns: [
      { key: "barcode", label: t("coll.items.barcode"), primary: true, hideable: false, csv: (r) => r.barcode,
        render: (r) => html`<a class="mono" href="/staff/catalog/${r.biblio_id}#items">${r.barcode}</a>` },
      { key: "title", label: t("coll.field.title"), csv: (r) => r.title,
        render: (r) => html`<div class="dt-cell-stack"><span>${r.title}</span><span class="sub">${[r.branch, r.shelf_location, r.call_number].filter(Boolean).join(" · ")}</span></div>` },
      { key: "status", label: t("coll.items.status"), csv: (r) => r.status, render: (r) => statusPill("item", r.status) },
      { key: "result", label: t("coll.batch.result"), csv: (r) => r.result,
        render: (r) => html`<div class="dt-cell-stack">${resultPill(r.result)}${r.reason ? html`<span class="sub">${r.reason}</span>` : ""}</div>` },
      ...(withChanges ? [{ key: "changes", label: t("coll.batch.changes"), csv: (r) => (r.changes || []).map((c) => `${c.label}: ${c.before ?? ""} → ${c.after ?? ""}`).join("; "),
        render: (r) => html`<div class="change-list">${(r.changes || []).map((c) => html`<div><span class="muted">${c.label}:</span> <del class="change-before">${c.before ?? "—"}</del> → <ins class="change-after">${c.after ?? "—"}</ins></div>`)}</div>` }] : []),
    ],
    empty: { art: "filter", compact: true, title: t("coll.batch.no_match_title"), body: t("coll.batch.no_match_body") },
  });
  table.setRows(rows);
  return table;
}

function resultsCard(r, { dryRun, title, applyBtn }) {
  return html`<section class="card batch-results" aria-labelledby="res-h">
    <div class="card-head"><h2 id="res-h">${title}</h2>${dryRun && applyBtn ? applyBtn : ""}</div>
    <div class="card-body stack">${summaryRow(r.summary, r.unknown)}<div id="res-table"></div></div></section>`;
}

// ------------------------------------------------------------------ batch modify

function changeRow(key, label, control, hint = "") {
  return html`<div class="change-row" data-change-row="${key}">
    <label class="checkbox change-toggle-box"><input type="checkbox" data-toggle="${key}" aria-describedby="${hint ? `ch-${key}-h` : ""}"><span>${label}</span></label>
    <div class="change-control" data-change="${key}" aria-disabled="true">${control}${hint ? html`<div class="field-help" id="ch-${key}-h">${hint}</div>` : ""}</div></div>`;
}

function renderModify() {
  const root = mount(html`<div class="card pad batch-steps">${selectionStep("m")}
    <fieldset class="step"><legend><span class="step-no" aria-hidden="true">2</span>${t("coll.batch.step_changes")}</legend>
      <p class="small muted">${t("coll.batch.changes_help")}</p>
      <div class="change-rows" id="changes">
        ${changeRow("branch_id", t("coll.items.branch"), html`<select data-v="branch_id" aria-label="${t("coll.batch.new_branch")}" disabled>${opts(lk.branches)}</select>`)}
        ${changeRow("item_type_id", t("coll.items.type"), html`<select data-v="item_type_id" aria-label="${t("coll.batch.new_type")}" disabled>${opts(lk.item_types)}</select>`)}
        ${changeRow("shelf_location", t("coll.items.shelf_location"), html`<input data-v="shelf_location" aria-label="${t("coll.batch.new_location")}" list="locations" maxlength="64" disabled>`, t("coll.items.location_clear_hint"))}
        ${changeRow("status", t("coll.items.status"), html`<select data-v="status" aria-label="${t("coll.items.new_status")}" disabled>${statusOpts(EDITABLE)}</select>`, t("coll.items.protected_hint"))}
        ${changeRow("notes", t("coll.items.notes"), html`<div class="inline-pair"><select data-v="notes_mode" aria-label="${t("coll.batch.notes_how")}" disabled><option value="replace">${t("coll.batch.notes_replace")}</option><option value="append">${t("coll.batch.notes_append")}</option><option value="clear">${t("coll.batch.notes_clear")}</option></select>
          <input data-v="notes" aria-label="${t("coll.batch.note_text")}" maxlength="2000" disabled></div>`)}
        ${changeRow("call_number_prefix", t("coll.batch.cn_prefix_change"), html`<div class="inline-pair"><select data-v="call_number_prefix_mode" aria-label="${t("coll.batch.prefix_how")}" disabled><option value="add">${t("coll.batch.prefix_add")}</option><option value="remove">${t("coll.batch.prefix_remove")}</option></select>
          <input data-v="call_number_prefix" class="mono" aria-label="${t("coll.batch.prefix")}" maxlength="16" placeholder="REF" disabled></div>`)}
      </div></fieldset>
    <div class="step-actions"><button type="button" class="btn primary" id="m-preview">${icon("search")}${t("coll.batch.preview_changes")}</button></div></div>
    <div id="m-results"></div><datalist id="locations"></datalist>`);
  wireSelection(root, "m");
  loadLocations();
  $("#changes").addEventListener("change", (e) => {
    const key = e.target.dataset.toggle;
    if (!key) return;
    const box = $(`[data-change="${key}"]`);
    box.setAttribute("aria-disabled", String(!e.target.checked));
    box.closest(".change-row").classList.toggle("on", e.target.checked);
    $$("[data-v]", box).forEach((el) => { el.disabled = !e.target.checked; });
    if (e.target.checked) $("[data-v]", box)?.focus();
  });
  $("#m-preview").addEventListener("click", (e) => runModify(e.currentTarget, true).catch(() => {}));
}

function readChanges() {
  const out = {};
  $$("[data-toggle]:checked").forEach((tg) => {
    const box = $(`[data-change="${tg.dataset.toggle}"]`);
    $$("[data-v]", box).forEach((el) => {
      const k = el.dataset.v;
      out[k] = ["branch_id", "item_type_id"].includes(k) ? +el.value : el.value.trim();
    });
  });
  if (!Object.keys(out).length) throw new Error(t("coll.batch.need_change"));
  if ("call_number_prefix" in out && !out.call_number_prefix) throw new Error(t("coll.batch.need_prefix"));
  return out;
}

async function runModify(btn, dryRun) {
  let body;
  try { body = { selection: readSelection(panel(), "m"), changes: readChanges(), dry_run: dryRun }; } catch (e) { toast(e.message, "error"); throw e; }
  const r = await withBusy(btn, () => api("/batch/items/modify", { method: "POST", body }));
  const pending = r.results.filter((x) => x.result === "change").length;
  $("#m-results").innerHTML = resultsCard(r, { dryRun, title: t(dryRun ? "coll.batch.preview" : "coll.batch.results"),
    applyBtn: pending ? html`<button type="button" class="btn primary" id="m-apply">${icon("check")}${t("coll.batch.apply_n", { count: pending, n: num(pending) })}</button>` : "" });
  resultsTable($("#res-table"), r.results, true, "batch-modify");
  $("#m-apply")?.addEventListener("click", async (e) => {
    if (!(await confirmDialog(t("coll.batch.apply_title"), t("coll.batch.apply_text", { count: pending, n: num(pending) }), t("coll.batch.apply"), false))) return;
    const out = await runModify(e.currentTarget, false).catch(() => null);
    if (out) toast(t("coll.items.bulk_done", { count: out.summary.changed || 0 }), "success");
  });
  $("#m-results").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  $("#res-h")?.setAttribute("tabindex", "-1");
  $("#res-h")?.focus({ preventScroll: true });
  return r;
}

// ------------------------------------------------------------------ withdraw / delete

function renderDelete() {
  const root = mount(html`<div class="card pad batch-steps">${selectionStep("d")}
    <fieldset class="step"><legend><span class="step-no" aria-hidden="true">2</span>${t("coll.batch.step_action")}</legend>
      <div class="segmented" role="radiogroup" aria-label="${t("coll.batch.step_action")}">
        <label><input type="radio" name="d-action" value="withdraw" checked><span>${t("coll.batch.withdraw_keep")}</span></label>
        <label><input type="radio" name="d-action" value="delete"><span>${t("coll.batch.delete")}</span></label></div>
      <label class="checkbox" id="d-empty-wrap" hidden><input type="checkbox" id="d-empty"> ${t("coll.batch.delete_empty")}</label>
      <p class="small muted">${t("coll.batch.protected")}</p></fieldset>
    <div class="step-actions"><button type="button" class="btn primary" id="d-preview">${icon("search")}${t("coll.batch.preview")}</button></div></div>
    <div id="d-results"></div><datalist id="locations"></datalist>`);
  wireSelection(root, "d");
  loadLocations();
  root.addEventListener("change", (e) => { if (e.target.name === "d-action") $("#d-empty-wrap").hidden = e.target.value !== "delete"; });
  $("#d-preview").addEventListener("click", (e) => runDelete(e.currentTarget, true).catch(() => {}));
}

async function runDelete(btn, dryRun) {
  const action = $('input[name="d-action"]:checked').value;
  let body;
  try { body = { selection: readSelection(panel(), "d"), action, delete_empty_biblios: action === "delete" && $("#d-empty").checked, dry_run: dryRun }; } catch (e) { toast(e.message, "error"); throw e; }
  const r = await withBusy(btn, () => api("/batch/items/delete", { method: "POST", body }));
  const pending = r.results.filter((x) => x.result === action).length;
  $("#d-results").innerHTML = resultsCard(r, { dryRun, title: t(dryRun ? "coll.batch.preview" : "coll.batch.results"),
    applyBtn: pending ? html`<button type="button" class="btn danger solid" id="d-apply">${icon(action === "delete" ? "trash" : "check")}${t(action === "delete" ? "coll.batch.delete_n" : "coll.batch.withdraw_n", { count: pending, n: num(pending) })}</button>` : "" });
  if (r.biblios_deleted?.length) $("#d-results .card-body").insertAdjacentHTML("afterbegin", alertBox(t("coll.batch.biblios_deleted", { count: r.biblios_deleted.length, n: num(r.biblios_deleted.length), titles: r.biblios_deleted.map((b) => b.title).join("; ") }), "info"));
  resultsTable($("#res-table"), r.results, false, "batch-delete");
  $("#d-apply")?.addEventListener("click", async (e) => {
    const ok = action === "delete"
      ? await confirmDestructive({ title: t("coll.batch.delete_title", { count: pending, n: num(pending) }), text: t("coll.batch.delete_text"), word: String(pending), submit: t("coll.batch.delete") })
      : await confirmDialog(t("coll.batch.withdraw_title", { count: pending, n: num(pending) }), t("coll.batch.withdraw_text"), t("coll.batch.withdraw"));
    if (!ok) return;
    const out = await runDelete(e.currentTarget, false).catch(() => null);
    if (out) toast(t(action === "delete" ? "coll.items.deleted_n" : "coll.batch.withdrawn_n", { count: out.summary[action === "delete" ? "deleted" : "withdrawn"] || 0 }), "success");
  });
  return r;
}

async function loadLocations(branchId) {
  const r = await api(`/inventory/locations${branchId ? `?branch_id=${branchId}` : ""}`).catch(() => ({ results: [] }));
  const dl = $("#locations");
  if (dl) dl.innerHTML = html`${r.results.filter((x) => x.value !== "(none)").map((x) => html`<option value="${x.value}"></option>`)}`;
  return r.results;
}

// ------------------------------------------------------------------ inventory

const inv = { scans: [] };
const saveScans = () => { try { sessionStorage.setItem(SCANS_KEY, JSON.stringify(inv.scans)); } catch { /* storage unavailable */ } };

function renderInventory() {
  try { inv.scans = JSON.parse(sessionStorage.getItem(SCANS_KEY) || "[]"); } catch { inv.scans = []; }
  mount(html`<div class="coll-split wide-side inv-layout">
    <div class="card pad batch-steps">
      <fieldset class="step"><legend><span class="step-no" aria-hidden="true">1</span>${t("coll.inv.step_shelf")}</legend>
        <div class="form-grid">
          <div class="field"><label for="i-branch">${t("common.branch")}</label><select id="i-branch" required>${opts(lk.branches, BOOT.user?.home_branch_id)}</select></div>
          <div class="field"><label for="i-loc">${t("coll.items.shelf_location")}</label><select id="i-loc"><option value="">${t("coll.inv.any_location")}</option></select></div>
          <div class="field"><label for="i-from">${t("coll.inv.cn_from")}</label><input id="i-from" class="mono" placeholder="800"></div>
          <div class="field"><label for="i-to">${t("coll.inv.cn_to")}</label><input id="i-to" class="mono" placeholder="899"></div>
          <div class="field"><label for="i-type">${t("coll.items.type")}</label><select id="i-type">${opts(lk.item_types, "", t("coll.labels.any"))}</select></div>
          <label class="checkbox span-2"><input type="checkbox" id="i-seen" checked> ${t("coll.inv.mark_seen")}</label>
        </div></fieldset>
      <fieldset class="step"><legend><span class="step-no" aria-hidden="true">2</span>${t("coll.inv.step_scan")}</legend>
        <form id="i-scan-form" class="input-group scan-group" autocomplete="off"><label for="i-scan" class="sr-only">${t("coll.inv.scan_label")}</label>
          <input id="i-scan" class="big mono" placeholder="${t("coll.inv.scan_placeholder")}" autocomplete="off" spellcheck="false">
          <button class="btn primary">${icon("plus")}${t("coll.auth.add")}</button></form>
        <div class="row between"><strong aria-live="polite" id="i-count"></strong>
          <span class="row tight"><input type="file" id="i-file" accept=".txt,.csv,text/plain" class="sr-only" tabindex="-1" aria-hidden="true">
            <button type="button" class="btn sm" id="i-load">${icon("upload")}${t("coll.inv.upload")}</button>
            <button type="button" class="btn sm ghost danger" id="i-clear">${icon("trash")}${t("coll.inv.clear")}</button></span></div>
        <ul class="scan-feed" id="i-feed" aria-label="${t("coll.inv.feed")}" tabindex="0"></ul></fieldset>
      <div class="step-actions"><button type="button" class="btn primary" id="i-run">${icon("check")}${t("coll.inv.compare")}</button></div>
    </div>
    <aside class="stack" id="i-report" aria-live="polite">${alertBox(t("coll.inv.intro"), "info")}</aside>
  </div>`);
  const branch = $("#i-branch");
  const refreshLocs = async () => {
    const locs = await loadLocations(branch.value);
    $("#i-loc").innerHTML = html`<option value="">${t("coll.inv.any_location")}</option>${locs.map((l) => html`<option value="${l.value}">${l.label} (${num(l.items)})</option>`)}`;
  };
  branch.addEventListener("change", refreshLocs);
  refreshLocs();
  renderFeed();
  $("#i-scan-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#i-scan");
    const codes = splitCodes(input.value);
    if (!codes.length) return;
    inv.scans.push(...codes);
    saveScans();
    input.value = "";
    renderFeed();
  });
  $("#i-load").addEventListener("click", () => $("#i-file").click());
  $("#i-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    inv.scans.push(...splitCodes(await f.text()));
    e.target.value = "";
    saveScans();
    renderFeed();
  });
  $("#i-clear").addEventListener("click", async () => {
    if (!inv.scans.length || !(await confirmDialog(t("coll.inv.clear_title"), t("coll.inv.clear_text", { count: inv.scans.length, n: num(inv.scans.length) }), t("coll.inv.clear")))) return;
    inv.scans = [];
    saveScans();
    renderFeed();
  });
  $("#i-feed").addEventListener("click", (e) => {
    const b = e.target.closest("[data-unscan]");
    if (!b) return;
    inv.scans.splice(+b.dataset.unscan, 1);
    saveScans();
    renderFeed();
    $("#i-scan").focus();
  });
  $("#i-run").addEventListener("click", (e) => runInventory(e.currentTarget).catch(() => {}));
  $("#i-report").addEventListener("click", onReportClick);
  $("#i-scan").focus();
}

function renderFeed() {
  const n = inv.scans.length;
  $("#i-count").textContent = n ? t("coll.inv.n_scans", { count: n, n: num(n), unique: num(new Set(inv.scans).size) }) : t("coll.inv.no_scans");
  const recent = inv.scans.map((c, i) => [c, i]).slice(-50).reverse();
  $("#i-feed").innerHTML = html`${recent.map(([c, i]) => html`<li><span>${c}</span><button type="button" class="btn ghost sm icon-only" data-unscan="${i}" aria-label="${t("coll.inv.remove_scan", { barcode: c })}">${icon("x")}</button></li>`)}`;
  $("#i-feed").hidden = !n;
}

function inventoryBody(markSeen) {
  const loc = $("#i-loc").value;
  return {
    branch_id: +$("#i-branch").value, shelf_location: loc || null, call_number_from: $("#i-from").value.trim() || null,
    call_number_to: $("#i-to").value.trim() || null, item_type_id: $("#i-type").value ? +$("#i-type").value : null,
    barcodes: inv.scans, mark_seen: markSeen,
  };
}

function invTable(el, rows, id, caption, { action = false } = {}) {
  const table = dataTable(el, {
    id, caption, exportName: id, rowKey: (r) => r.barcode,
    columns: [
      { key: "barcode", label: t("coll.items.barcode"), primary: true, hideable: false, csv: (r) => r.barcode, render: (r) => html`<a class="mono" href="/staff/catalog/${r.biblio_id}#items">${r.barcode}</a>` },
      { key: "title", label: t("coll.field.title"), csv: (r) => r.title, render: (r) => html`<div class="dt-cell-stack"><span>${r.title}</span><span class="sub mono">${r.call_number || ""}</span></div>` },
      { key: "status", label: t("coll.items.status"), csv: (r) => r.status, render: (r) => statusPill("item", r.status) },
      { key: "problem", label: t("coll.inv.problem"), csv: (r) => (r.problems || []).map((p) => p.message).join("; "), render: (r) => html`${(r.problems || []).map((p) => html`<div class="small">${p.message}</div>`)}` },
      { key: "seen", label: t("coll.inv.last_seen"), csv: (r) => r.last_seen_at || "", render: (r) => html`<span class="small muted">${r.last_seen_at ? relative(r.last_seen_at) : t("coll.inv.never")}</span>` },
      ...(action ? [{ key: "act", label: t("coll.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions",
        render: (r) => (r.action === "checkin" ? html`<button type="button" class="btn sm" data-checkin="${r.barcode}">${icon("arrow-down")}${t("coll.inv.check_in")}</button>` : "") }] : []),
    ],
    empty: { compact: true, art: "done", title: t("coll.inv.none") },
  });
  table.setRows(rows);
}

async function runInventory(btn) {
  if (!inv.scans.length) { toast(t("coll.inv.need_scans"), "error"); $("#i-scan").focus(); throw new Error("no scans"); }
  const body = inventoryBody($("#i-seen").checked);
  const r = await withBusy(btn, () => api("/inventory", { method: "POST", body }));
  inv.report = r;
  inv.branchId = body.branch_id;
  const problems = r.scanned.filter((x) => x.result !== "ok");
  const ok = r.scanned.filter((x) => x.result === "ok");
  const s = r.summary;
  $("#i-report").innerHTML = html`<div class="kpi-row inv-kpis">
      ${statTile({ label: t("coll.inv.k_scanned"), value: s.unique, icon: "barcode" })}${statTile({ label: t("coll.inv.k_ok"), value: s.ok, icon: "check-circle" })}
      ${statTile({ label: t("coll.inv.k_missing"), value: s.missing, icon: "alert", tone: s.missing ? "danger" : "" })}${statTile({ label: t("coll.inv.k_misplaced"), value: s.out_of_place, icon: "map", tone: s.out_of_place ? "warning" : "" })}
      ${statTile({ label: t("coll.inv.k_status"), value: s.wrong_status, icon: "info", tone: s.wrong_status ? "warning" : "" })}${statTile({ label: t("coll.inv.k_unknown"), value: s.unknown, icon: "x-circle", tone: s.unknown ? "danger" : "" })}</div>
    <div class="row between"><span class="small muted">${[r.branch.name, r.shelf_location, date(r.run_at), s.marked_seen ? t("coll.inv.marked_seen", { n: num(s.marked_seen) }) : "", s.duplicates ? t("coll.inv.duplicates", { n: num(s.duplicates) }) : ""].filter(Boolean).join(" · ")}</span>
      <button type="button" class="btn sm" id="i-csv">${icon("download")}${t("coll.inv.csv")}</button></div>
    ${problems.length ? html`<section aria-labelledby="ip-h"><h2 class="tab-title" id="ip-h">${t("coll.inv.attention", { n: num(problems.length) })}</h2><div id="inv-problems"></div></section>` : ""}
    ${r.missing.length ? html`<section aria-labelledby="im-h"><h2 class="tab-title" id="im-h">${t("coll.inv.missing", { n: num(r.missing.length) })}</h2><div id="inv-missing"></div></section>` : ""}
    ${r.unknown.length ? html`<section class="card pad" aria-labelledby="iu-h"><h2 class="tab-title" id="iu-h">${t("coll.inv.unknown", { n: num(r.unknown.length) })}</h2><p class="mono small">${r.unknown.join(", ")}</p></section>` : ""}
    ${ok.length ? html`<details class="card inv-ok"><summary>${t("coll.inv.ok", { n: num(ok.length) })}</summary><div id="inv-ok"></div></details>` : ""}`;
  if (problems.length) invTable($("#inv-problems"), problems, "inv-problems", t("coll.inv.problems"), { action: true });
  if (r.missing.length) invTable($("#inv-missing"), r.missing, "inv-missing", t("coll.inv.k_missing"));
  if (ok.length) invTable($("#inv-ok"), ok, "inv-ok", t("coll.inv.ok_table"));
  return r;
}

async function onReportClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.id === "i-csv") {
      const text = await withBusy(b, () => api("/inventory?format=csv", { method: "POST", body: { ...inventoryBody(false), barcodes: inv.scans } }));
      downloadCSV("inventory", text.replace(/^﻿/, ""));
    } else if (b.dataset.checkin) {
      const r = await withBusy(b, () => api("/circulation/checkin", { method: "POST", body: { barcode: b.dataset.checkin, branch_id: inv.branchId } }));
      toast(r.messages?.length ? r.messages.join(" · ") : t("coll.inv.checked_in_toast", { barcode: b.dataset.checkin }), "success", 6000);
      b.replaceWith(Object.assign(document.createElement("span"), { className: "badge pill success", textContent: t("coll.inv.checked_in") }));
    }
  } catch (err) { if (!err.toasted) toast(err.message, "error"); }
}

// ------------------------------------------------------------------ init

export default async function init() {
  lk = await api("/lookups");
  const list = $("#batch-tabs");
  const tabsEls = $$('[role="tab"]', list);
  const SHOW = { modify: renderModify, delete: renderDelete, inventory: renderInventory };
  const select = (key, focus = false) => {
    tabsEls.forEach((b) => { const on = b.dataset.tab === key; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    panel().setAttribute("aria-labelledby", `tab-${key}`);
    history.replaceState(null, "", `#${key}`);
    SHOW[key]();
  };
  list.addEventListener("click", (e) => { const b = e.target.closest('[role="tab"]'); if (b) select(b.dataset.tab); });
  list.addEventListener("keydown", (e) => {
    const i = tabsEls.indexOf(document.activeElement);
    if (i < 0) return;
    const rtl = getComputedStyle(list).direction === "rtl";
    const next = { [rtl ? "ArrowLeft" : "ArrowRight"]: i + 1, [rtl ? "ArrowRight" : "ArrowLeft"]: i - 1, Home: 0, End: tabsEls.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabsEls[(next + tabsEls.length) % tabsEls.length].dataset.tab, true);
  });
  select(SHOW[location.hash.slice(1)] ? location.hash.slice(1) : "modify");
}
