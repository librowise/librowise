// Staff: batch modify / withdraw / delete items (preview first) and inventory (stocktake).
import { $, $$, BOOT, api, badge, confirmDialog, date, empty, html, icon, num, raw, relative, statusLabel, toast, withBusy } from "/static/js/core.js";

let lk = { branches: [], item_types: [], material_types: [] };
const panel = () => $("#batch-panel");
const STATUSES = ["available", "on_loan", "on_hold_shelf", "in_transit", "processing", "lost", "damaged", "withdrawn"];
const EDITABLE = ["available", "processing", "lost", "damaged", "withdrawn"];
const SCANS_KEY = "sw-inventory-scans";
const opts = (list, sel, any) => html`${any ? html`<option value="">${any}</option>` : ""}${list.map((x) => html`<option value="${x.id}" ${String(x.id) === String(sel ?? "") ? "selected" : ""}>${x.name}</option>`)}`;
const statusOpts = (list, any) => html`${any ? html`<option value="">${any}</option>` : ""}${list.map((s) => html`<option value="${s}">${statusLabel(s)}</option>`)}`;
const splitCodes = (text) => text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

function setupTabs(root, onSelect) {
  const tabs = $$('[role="tab"]', root);
  const select = (tab, focus = false) => {
    tabs.forEach((t) => { const on = t === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
    $(`#${tab.getAttribute("aria-controls")}`)?.setAttribute("aria-labelledby", tab.id);
    if (focus) tab.focus();
    onSelect(tab.dataset.tab);
  };
  root.addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t) select(t); });
  root.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
  return (key) => { const t = tabs.find((x) => x.dataset.tab === key); if (t) select(t); };
}

/** Replace the panel with a fresh root so listeners from a previous tab never pile up. */
function mount(content) {
  const root = document.createElement("div");
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

// ------------------------------------------------------------------ item selection (shared)

function selectionCard(p) {
  return html`<div class="card pad stack"><h2 class="small" style="margin:0"><span class="step-num">1</span>Choose items</h2>
    <div class="row tight" role="radiogroup" aria-label="How to choose items">
      <label class="checkbox chip"><input type="radio" name="${p}-mode" value="barcodes" checked> Barcode list</label>
      <label class="checkbox chip"><input type="radio" name="${p}-mode" value="search"> Catalogue search</label></div>
    <div data-mode="barcodes" class="field"><label for="${p}-codes">Barcodes</label>
      <textarea id="${p}-codes" rows="6" class="mono" spellcheck="false" placeholder="Scan or paste barcodes, one per line"></textarea>
      <div class="row between"><span class="hint" data-count aria-live="polite">0 barcodes</span>
        <span><input type="file" id="${p}-file" accept=".txt,.csv,text/plain" hidden><button type="button" class="btn sm" data-load="${p}-file">${icon("upload")}Load from file</button></span></div></div>
    <div data-mode="search" hidden class="grid cols-3">
      <div class="field" style="grid-column:1/-1"><label for="${p}-q">Keywords (title, author, subject, ISBN)</label><input id="${p}-q" data-s="q" type="search" autocomplete="off"></div>
      <div class="field"><label for="${p}-mt">Format</label><select id="${p}-mt" data-s="material_type"><option value="">Any</option>${lk.material_types.map((m) => html`<option value="${m}">${m}</option>`)}</select></div>
      <div class="field"><label for="${p}-br">Branch</label><select id="${p}-br" data-s="branch_id">${opts(lk.branches, "", "Any")}</select></div>
      <div class="field"><label for="${p}-it">Item type</label><select id="${p}-it" data-s="item_type_id">${opts(lk.item_types, "", "Any")}</select></div>
      <div class="field"><label for="${p}-st">Status</label><select id="${p}-st" data-s="status">${statusOpts(STATUSES, "Any")}</select></div>
      <div class="field"><label for="${p}-loc">Shelf location</label><input id="${p}-loc" data-s="shelf_location" list="locations" autocomplete="off" placeholder="Any"></div>
      <div class="field"><label for="${p}-cn">Call number starts with</label><input id="${p}-cn" data-s="call_number_prefix" class="mono" autocomplete="off"></div>
    </div></div>`;
}

function wireSelection(root, p) {
  const ta = $(`#${p}-codes`, root);
  const count = () => { const n = splitCodes(ta.value).length; $("[data-count]", root).textContent = `${num(n)} barcode${n === 1 ? "" : "s"}`; };
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
    if (!codes.length) throw new Error("Enter or scan at least one barcode");
    return { barcodes: codes };
  }
  const search = {};
  $$("[data-s]", root).forEach((el) => { if (el.value.trim()) search[el.dataset.s] = ["branch_id", "item_type_id"].includes(el.dataset.s) ? +el.value : el.value.trim(); });
  if (!Object.keys(search).length) throw new Error("Give at least one search criterion");
  return { search };
}

// ------------------------------------------------------------------ results

const RESULT = {
  change: ["info", "Will change"], changed: ["ok", "Changed"], unchanged: ["", "No change"], skipped: ["warn", "Skipped"],
  withdraw: ["warn", "Will withdraw"], delete: ["bad", "Will delete"], withdrawn: ["ok", "Withdrawn"], deleted: ["ok", "Deleted"],
};
const resultBadge = (r) => badge(RESULT[r]?.[0] || "", RESULT[r]?.[1] || r);

function summaryBadges(summary, unknown) {
  return html`<div class="row tight">${Object.entries(summary).map(([k, n]) => html`${resultBadge(k)}<span class="small">${num(n)}</span>`)}
    ${unknown.length ? html`<span class="badge bad">Unknown barcodes</span><span class="small">${num(unknown.length)}</span>` : ""}</div>
    ${unknown.length ? html`<div class="alert warn">${icon("alert")}<div><strong>Not in the catalogue:</strong> <span class="mono small">${unknown.slice(0, 100).join(", ")}${unknown.length > 100 ? " …" : ""}</span></div></div>` : ""}`;
}

function resultsTable(rows, withChanges) {
  if (!rows.length) return empty("No items matched");
  return html`<div class="table-wrap" style="max-height:32rem;overflow:auto"><table class="table"><thead><tr><th>Barcode</th><th>Title</th><th>Status</th><th>Result</th>${withChanges ? raw("<th>Changes</th>") : ""}</tr></thead><tbody>
    ${rows.map((r) => html`<tr class="result-row ${r.result}"><td class="mono small"><a href="/staff/catalog/${r.biblio_id}" target="_blank">${r.barcode}</a></td>
      <td class="small">${r.title}<div class="tiny muted">${r.branch}${r.shelf_location ? ` · ${r.shelf_location}` : ""}${r.call_number ? ` · ${r.call_number}` : ""}</div></td>
      <td>${badge(r.status)}</td><td>${resultBadge(r.result)}${r.reason ? html`<div class="tiny muted">${r.reason}</div>` : ""}</td>
      ${withChanges ? html`<td class="small">${(r.changes || []).map((c) => html`<div><span class="muted">${c.label}:</span> <span class="change-before">${c.before ?? "—"}</span> → <span class="change-after">${c.after ?? "—"}</span></div>`)}</td>` : ""}</tr>`)}
  </tbody></table></div>`;
}

// ------------------------------------------------------------------ batch modify

function changeRow(key, label, control) {
  return html`<label class="checkbox"><input type="checkbox" data-toggle="${key}"> <span class="sr-only">Change </span></label>
    <div class="field" data-change="${key}" aria-disabled="true"><label>${label}</label>${control}</div>`;
}

function renderModify() {
  const root = mount(html`<div class="stack">${selectionCard("m")}
    <div class="card pad stack"><h2 class="small" style="margin:0"><span class="step-num">2</span>Changes to make</h2>
      <p class="small muted" style="margin:0">Tick each change you want. Fields you leave unticked are not touched.</p>
      <div class="change-toggle" id="changes">
        ${changeRow("branch_id", "Home branch", html`<select data-v="branch_id" aria-label="New home branch" disabled>${opts(lk.branches)}</select>`)}
        ${changeRow("item_type_id", "Item type", html`<select data-v="item_type_id" aria-label="New item type" disabled>${opts(lk.item_types)}</select>`)}
        ${changeRow("shelf_location", "Shelf location (leave empty to clear)", html`<input data-v="shelf_location" aria-label="New shelf location" list="locations" maxlength="64" disabled>`)}
        ${changeRow("status", "Status", html`<select data-v="status" aria-label="New status" disabled>${statusOpts(EDITABLE)}</select><span class="hint">Items on loan, in transit or on the hold shelf are skipped.</span>`)}
        ${changeRow("notes", "Notes", html`<div class="row tight"><select data-v="notes_mode" aria-label="How to change notes" style="width:auto" disabled><option value="replace">Replace with</option><option value="append">Append</option><option value="clear">Clear</option></select>
          <input data-v="notes" class="grow" aria-label="Note text" maxlength="2000" disabled></div>`)}
        ${changeRow("call_number_prefix", "Call number prefix", html`<div class="row tight"><select data-v="call_number_prefix_mode" aria-label="Add or remove prefix" style="width:auto" disabled><option value="add">Add</option><option value="remove">Remove</option></select>
          <input data-v="call_number_prefix" class="mono" aria-label="Prefix, e.g. REF" maxlength="16" placeholder="e.g. REF" disabled></div>`)}
      </div>
      <div class="row end"><button type="button" class="btn primary" id="m-preview">${icon("search")}Preview changes</button></div></div>
    <div id="m-results"></div></div><datalist id="locations"></datalist>`);
  wireSelection(root, "m");
  loadLocations();
  $("#changes").addEventListener("change", (e) => {
    const key = e.target.dataset.toggle;
    if (!key) return;
    const box = $(`[data-change="${key}"]`);
    box.setAttribute("aria-disabled", !e.target.checked);
    $$("[data-v]", box).forEach((el) => { el.disabled = !e.target.checked; });
    if (e.target.checked) $("[data-v]", box)?.focus();
  });
  $("#m-preview").addEventListener("click", (e) => runModify(e.currentTarget, true).catch(() => {}));
}

function readChanges() {
  const out = {};
  $$("[data-toggle]:checked").forEach((t) => {
    const box = $(`[data-change="${t.dataset.toggle}"]`);
    $$("[data-v]", box).forEach((el) => {
      const k = el.dataset.v;
      out[k] = ["branch_id", "item_type_id"].includes(k) ? +el.value : el.value.trim();
    });
  });
  if (!Object.keys(out).length) throw new Error("Tick at least one change");
  if ("call_number_prefix" in out && !out.call_number_prefix) throw new Error("Enter the call number prefix");
  return out;
}

async function runModify(btn, dryRun) {
  let body;
  try { body = { selection: readSelection(panel(), "m"), changes: readChanges(), dry_run: dryRun }; } catch (e) { toast(e.message, "error"); throw e; }
  const r = await withBusy(btn, () => api("/batch/items/modify", { method: "POST", body }));
  const pending = r.results.filter((x) => x.result === "change").length;
  $("#m-results").innerHTML = html`<div class="card"><div class="card-head"><h3>${dryRun ? "Preview" : "Results"}</h3>
      ${dryRun && pending ? html`<button type="button" class="btn primary" id="m-apply">${icon("check")}Apply to ${num(pending)} item${pending === 1 ? "" : "s"}</button>` : ""}</div>
    <div class="card-body stack">${summaryBadges(r.summary, r.unknown)}${resultsTable(r.results, true)}</div></div>`;
  $("#m-apply")?.addEventListener("click", async (e) => {
    if (!(await confirmDialog("Apply changes?", `${pending} item(s) will be updated. Items whose state changed since the preview are re-checked.`, "Apply", false))) return;
    const out = await runModify(e.currentTarget, false).catch(() => null);
    if (out) toast(`${num(out.summary.changed || 0)} item(s) updated`, "success");
  });
  $("#m-results").scrollIntoView({ behavior: "smooth", block: "start" });
  return r;
}

// ------------------------------------------------------------------ withdraw / delete

function renderDelete() {
  const root = mount(html`<div class="stack">${selectionCard("d")}
    <div class="card pad stack"><h2 class="small" style="margin:0"><span class="step-num">2</span>Action</h2>
      <div class="row tight" role="radiogroup" aria-label="Action">
        <label class="checkbox chip"><input type="radio" name="d-action" value="withdraw" checked> Withdraw (keep for history)</label>
        <label class="checkbox chip"><input type="radio" name="d-action" value="delete"> Delete</label></div>
      <label class="checkbox small" id="d-empty-wrap" hidden><input type="checkbox" id="d-empty"> Also delete records left with no items (only if nobody is waiting for them)</label>
      <p class="small muted" style="margin:0">Items on loan, in transit or waiting on the hold shelf are always protected.</p>
      <div class="row end"><button type="button" class="btn primary" id="d-preview">${icon("search")}Preview</button></div></div>
    <div id="d-results"></div></div><datalist id="locations"></datalist>`);
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
  $("#d-results").innerHTML = html`<div class="card"><div class="card-head"><h3>${dryRun ? "Preview" : "Results"}</h3>
      ${dryRun && pending ? html`<button type="button" class="btn danger" id="d-apply">${icon(action === "delete" ? "trash" : "check")}${action === "delete" ? "Delete" : "Withdraw"} ${num(pending)} item${pending === 1 ? "" : "s"}</button>` : ""}</div>
    <div class="card-body stack">${summaryBadges(r.summary, r.unknown)}
      ${r.biblios_deleted.length ? html`<div class="alert info">${icon("info")}<div>${r.biblios_deleted.length} record(s) without items were deleted: ${r.biblios_deleted.map((b) => b.title).join("; ")}</div></div>` : ""}
      ${resultsTable(r.results, false)}</div></div>`;
  $("#d-apply")?.addEventListener("click", async (e) => {
    const verb = action === "delete" ? "deleted" : "withdrawn";
    if (!(await confirmDialog(`${action === "delete" ? "Delete" : "Withdraw"} ${pending} item(s)?`, `The items will be ${verb}. This is recorded in the audit log.`, action === "delete" ? "Delete" : "Withdraw"))) return;
    const out = await runDelete(e.currentTarget, false).catch(() => null);
    if (out) toast(`${num(out.summary[verb] || 0)} item(s) ${verb}`, "success");
  });
  return r;
}

async function loadLocations(branchId) {
  const r = await api(`/inventory/locations${branchId ? `?branch_id=${branchId}` : ""}`).catch(() => ({ results: [] }));
  const dl = $("#locations");
  if (dl) dl.innerHTML = r.results.filter((x) => x.value !== "(none)").map((x) => `<option value="${x.value.replace(/"/g, "&quot;")}"></option>`).join("");
  return r.results;
}

// ------------------------------------------------------------------ inventory

const inv = { scans: [] };
const saveScans = () => { try { sessionStorage.setItem(SCANS_KEY, JSON.stringify(inv.scans)); } catch { /* storage unavailable */ } };

function renderInventory() {
  try { inv.scans = JSON.parse(sessionStorage.getItem(SCANS_KEY) || "[]"); } catch { inv.scans = []; }
  mount(html`<div class="grid split">
    <div class="stack">
      <div class="card pad stack"><h2 class="small" style="margin:0"><span class="step-num">1</span>Shelf to check</h2>
        <div class="grid cols-2">
          <div class="field"><label for="i-branch">Branch</label><select id="i-branch" required>${opts(lk.branches, BOOT.user?.home_branch_id)}</select></div>
          <div class="field"><label for="i-loc">Shelf location</label><select id="i-loc"><option value="">Any location</option></select></div>
          <div class="field"><label for="i-from">Call numbers from</label><input id="i-from" class="mono" placeholder="e.g. 800"></div>
          <div class="field"><label for="i-to">to</label><input id="i-to" class="mono" placeholder="e.g. 899"></div>
          <div class="field"><label for="i-type">Item type</label><select id="i-type">${opts(lk.item_types, "", "Any")}</select></div>
          <div class="field"><label>&nbsp;</label><label class="checkbox small"><input type="checkbox" id="i-seen" checked> Record items as seen today</label></div>
        </div></div>
      <div class="card pad stack"><h2 class="small" style="margin:0"><span class="step-num">2</span>Scan the shelf</h2>
        <form id="i-scan-form" class="input-group" autocomplete="off"><label for="i-scan" class="sr-only">Scan a barcode</label>
          <input id="i-scan" class="big mono" placeholder="Scan barcodes here…" autocomplete="off" spellcheck="false">
          <button class="btn">${icon("plus")}Add</button></form>
        <div class="row between"><strong aria-live="polite" id="i-count"></strong>
          <span class="row tight"><input type="file" id="i-file" accept=".txt,.csv,text/plain" hidden>
            <button type="button" class="btn sm" id="i-load">${icon("upload")}Upload list</button>
            <button type="button" class="btn sm ghost danger" id="i-clear">${icon("trash")}Clear</button></span></div>
        <ul class="scan-feed" id="i-feed" aria-label="Scanned barcodes, newest first"></ul>
        <div class="row end"><button type="button" class="btn primary" id="i-run">${icon("check")}Compare with catalogue</button></div></div>
    </div>
    <aside class="stack" id="i-report"><div class="card pad small muted">Scan every item on the shelf (or upload a scanner file), then compare. You'll see what is missing, what belongs elsewhere, and items whose status is wrong — for example, on loan but actually on the shelf.</div></aside>
  </div>`);
  const branch = $("#i-branch");
  const refreshLocs = async () => {
    const locs = await loadLocations(branch.value);
    $("#i-loc").innerHTML = html`<option value="">Any location</option>${locs.map((l) => html`<option value="${l.value}">${l.label} (${num(l.items)})</option>`)}`;
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
    if (!inv.scans.length || !(await confirmDialog("Clear scans?", `${inv.scans.length} scanned barcode(s) will be discarded.`, "Clear"))) return;
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
  });
  $("#i-run").addEventListener("click", (e) => runInventory(e.currentTarget).catch(() => {}));
  $("#i-report").addEventListener("click", onReportClick);
  $("#i-scan").focus();
}

function renderFeed() {
  const n = inv.scans.length;
  $("#i-count").textContent = `${num(n)} scan${n === 1 ? "" : "s"}${n ? ` · ${num(new Set(inv.scans).size)} unique` : ""}`;
  const recent = inv.scans.map((c, i) => [c, i]).slice(-50).reverse();
  $("#i-feed").innerHTML = html`${recent.map(([c, i]) => html`<li><span>${c}</span><button type="button" class="btn ghost sm" data-unscan="${i}" aria-label="Remove scan ${c}">${icon("x")}</button></li>`)}`;
}

function inventoryBody(markSeen) {
  const loc = $("#i-loc").value;
  return {
    branch_id: +$("#i-branch").value, shelf_location: loc || null, call_number_from: $("#i-from").value.trim() || null,
    call_number_to: $("#i-to").value.trim() || null, item_type_id: $("#i-type").value ? +$("#i-type").value : null,
    barcodes: inv.scans, mark_seen: markSeen,
  };
}

const stat = (label, value, cls = "") => html`<div class="card stat ${cls}"><span class="label">${label}</span><span class="value">${num(value)}</span></div>`;

function invTable(rows, { action = false } = {}) {
  return html`<div class="table-wrap" style="max-height:24rem;overflow:auto"><table class="table"><thead><tr><th>Barcode</th><th>Title</th><th>Problem</th><th>Last seen</th>${action ? raw("<th><span class=\"sr-only\">Action</span></th>") : ""}</tr></thead><tbody>
    ${rows.map((r) => html`<tr data-row="${r.barcode}"><td class="mono small"><a href="/staff/catalog/${r.biblio_id}" target="_blank">${r.barcode}</a></td>
      <td class="small">${r.title}<div class="tiny muted">${r.call_number || ""} ${badge(r.status)}</div></td>
      <td class="small">${r.problems.map((p) => html`<div>${p.message}</div>`)}</td>
      <td class="small muted nowrap">${r.last_seen_at ? relative(r.last_seen_at) : "never"}</td>
      ${action ? html`<td class="right">${r.action === "checkin" ? html`<button type="button" class="btn sm" data-checkin="${r.barcode}">${icon("arrow-down")}Check in</button>` : ""}</td>` : ""}</tr>`)}
  </tbody></table></div>`;
}

async function runInventory(btn) {
  if (!inv.scans.length) { toast("Scan or upload some barcodes first", "error"); throw new Error("no scans"); }
  const body = inventoryBody($("#i-seen").checked);
  const r = await withBusy(btn, () => api("/inventory", { method: "POST", body }));
  inv.report = r;
  inv.branchId = body.branch_id;
  const problems = r.scanned.filter((x) => x.result !== "ok");
  const ok = r.scanned.filter((x) => x.result === "ok");
  $("#i-report").innerHTML = html`<div class="grid cols-3">${stat("Scanned", r.summary.unique)}${stat("On shelf, OK", r.summary.ok)}
      ${stat("Missing", r.summary.missing, r.summary.missing ? "alert" : "")}${stat("Out of place", r.summary.out_of_place, r.summary.out_of_place ? "alert" : "")}
      ${stat("Wrong status", r.summary.wrong_status, r.summary.wrong_status ? "alert" : "")}${stat("Unknown", r.summary.unknown, r.summary.unknown ? "alert" : "")}</div>
    <div class="row between"><span class="small muted">${r.branch.name}${r.shelf_location ? ` · ${r.shelf_location}` : ""} · ${date(r.run_at)}${r.summary.marked_seen ? ` · ${num(r.summary.marked_seen)} marked as seen` : ""}${r.summary.duplicates ? ` · ${num(r.summary.duplicates)} scanned twice` : ""}</span>
      <button type="button" class="btn sm" id="i-csv">${icon("download")}CSV</button></div>
    ${problems.length ? html`<div class="card"><div class="card-head"><h3>Needs attention (${problems.length})</h3></div><div class="card-body">${invTable(problems, { action: true })}</div></div>` : ""}
    ${r.missing.length ? html`<div class="card"><div class="card-head"><h3>Missing (${r.missing.length})</h3></div><div class="card-body">${invTable(r.missing)}</div></div>` : ""}
    ${r.unknown.length ? html`<div class="card"><div class="card-head"><h3>Unknown barcodes (${r.unknown.length})</h3></div><div class="card-body mono small">${r.unknown.join(", ")}</div></div>` : ""}
    ${ok.length ? html`<details class="card"><summary class="card-head" style="cursor:pointer"><h3>On the shelf, OK (${ok.length})</h3></summary><div class="card-body">${invTable(ok)}</div></details>` : ""}`;
  return r;
}

async function onReportClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.id === "i-csv") {
      const text = await withBusy(b, () => api("/inventory?format=csv", { method: "POST", body: { ...inventoryBody(false), barcodes: inv.scans } }));
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: `inventory-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } else if (b.dataset.checkin) {
      const r = await withBusy(b, () => api("/circulation/checkin", { method: "POST", body: { barcode: b.dataset.checkin, branch_id: inv.branchId } }));
      toast(r.messages?.length ? r.messages.join(" · ") : `${b.dataset.checkin} checked in`, "success", 6000);
      b.replaceWith(Object.assign(document.createElement("span"), { className: "badge ok", textContent: "Checked in" }));
    }
  } catch (err) { if (!err.toasted) toast(err.message, "error"); }
}

// ------------------------------------------------------------------ init

export default async function init() {
  lk = await api("/lookups");
  const select = setupTabs($("#batch-tabs"), (tab) => {
    history.replaceState(null, "", `#${tab}`);
    ({ modify: renderModify, delete: renderDelete, inventory: renderInventory })[tab]();
  });
  select(["modify", "delete", "inventory"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "modify");
}
