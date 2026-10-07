// Staff: authority control — search/browse, editor with variant & see-also chips, merge with preview,
// unlinked-headings report, and MARC import / catalogue bootstrap tools.
import {
  $, $$, api, badge, confirmDialog, debounce, empty, esc, html, icon, modal, num, qs, raw, relative, skeleton, toast, withBusy,
} from "/static/js/core.js";

const state = { tab: "list", q: "", type: "", used: "", sort: "heading", page: 1, per: 25, role: "", uq: "" };
let TYPES = [];
let RELS = [];
const panel = () => $("#auth-panel");
const typeLabel = (v) => TYPES.find((t) => t.value === v)?.label || v;
const SOURCES = ["local", "lcsh", "lcnaf", "mesh", "fast", "sears", "aat", "rvm"];
const ROLE_LABEL = { author: "Author", subject: "Subject", series: "Series" };

// ------------------------------------------------------------------ shared helpers

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
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
  return (key) => { const t = tabs.find((x) => x.dataset.tab === key); if (t) select(t); };
}

/** Modal that stays open until `action(FormData, dialog)` resolves; errors are toasted. */
function formModal(opts, action, setup) {
  let result = null;
  const done = modal(opts);
  const dlg = $$("dialog").at(-1);
  const form = $("form", dlg);
  const ok = $('button[value="ok"]', dlg);
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT" && !("noSubmit" in e.target.dataset) && e.target.type !== "file") {
      e.preventDefault();
      form.requestSubmit(ok);
    }
  });
  form.addEventListener("submit", async (e) => {
    if (e.submitter !== ok) return;
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    try {
      result = await withBusy(ok, () => action(new FormData(form), dlg));
      dlg.close("ok");
    } catch { /* toasted */ }
  });
  setup?.(dlg);
  return done.then(() => result);
}

const pager = (total, page, per, attr) => {
  const pages = Math.max(1, Math.ceil(total / per));
  if (pages <= 1) return "";
  return html`<div class="pager"><button class="btn sm" ${attr}="${page - 1}" ${page <= 1 ? "disabled" : ""}>Previous</button>
    <span class="small muted">Page ${page} of ${num(pages)}</span>
    <button class="btn sm" ${attr}="${page + 1}" ${page >= pages ? "disabled" : ""}>Next ${icon("chevron")}</button></div>`;
};

function relinkNote(stats) {
  if (!stats || !stats.records) return "";
  return ` · ${stats.records} record(s) linked${stats.rewritten ? `, ${stats.rewritten} heading(s) rewritten` : ""}`;
}

// ------------------------------------------------------------------ chips (variants / see-also)

const variantChip = (v) => html`<span class="chip removable" data-chip><input type="hidden" name="variant" value="${v}">${v}
  <button type="button" data-chip-remove aria-label="Remove ${v}">${icon("x")}</button></span>`;
const seeAlsoChip = (r) => html`<span class="chip removable" data-chip><input type="hidden" name="sa_heading" value="${r.heading}">
  <input type="hidden" name="sa_rel" value="${r.relationship || "related"}"><span class="rel">${r.relationship || "related"}</span>${r.heading}
  <button type="button" data-chip-remove aria-label="Remove ${r.heading}">${icon("x")}</button></span>`;

function wireChips(dlg) {
  const add = (box) => {
    const input = $("[data-chip-input]", box);
    const value = input.value.trim();
    if (!value) return;
    const list = $(".chip-list", box);
    const dupe = $$('input[type="hidden"][name="variant"], input[type="hidden"][name="sa_heading"]', list)
      .some((h) => h.value.toLowerCase() === value.toLowerCase());
    if (dupe) { toast("Already in the list", "info"); input.select(); return; }
    list.insertAdjacentHTML("beforeend", box.dataset.chips === "see"
      ? seeAlsoChip({ heading: value, relationship: $("[data-chip-rel]", box).value }) : variantChip(value));
    input.value = "";
    input.focus();
  };
  dlg.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-chip-remove]");
    if (rm) { const box = rm.closest("[data-chips]"); rm.closest("[data-chip]").remove(); $("[data-chip-input]", box)?.focus(); }
    const ad = e.target.closest("[data-chip-add]");
    if (ad) add(ad.closest("[data-chips]"));
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-chip-input]")) { e.preventDefault(); e.stopPropagation(); add(e.target.closest("[data-chips]")); }
  }, true);
}

// ------------------------------------------------------------------ editor

function editorBody(a = {}, records = []) {
  const existing = !!a.id;
  return html`<div class="stack">
    <div class="grid cols-2">
      <div class="field"><label for="a-type">Type</label><select id="a-type" name="auth_type" required>
        ${TYPES.map((t) => html`<option value="${t.value}" ${t.value === (a.auth_type || "topical_subject") ? "selected" : ""}>${t.label} (${t.marc_tag})</option>`)}</select>
        <span class="hint">Names control authors and subjects; topical/geographic/genre control subjects; uniform titles control series.</span></div>
      <div class="field"><label for="a-source">Source / thesaurus</label><input id="a-source" name="source" list="a-sources" value="${a.source || "local"}" maxlength="32">
        <datalist id="a-sources">${SOURCES.map((s) => html`<option value="${s}">`)}</datalist></div>
    </div>
    <div class="field"><label for="a-heading">Authorised heading *</label><input id="a-heading" name="heading" required maxlength="500" value="${a.heading || ""}" autocomplete="off">
      <span class="hint">Use “ -- ” between subdivisions, e.g. World War, 1939-1945 -- Fiction.</span></div>
    ${existing ? html`<label class="checkbox small"><input type="checkbox" name="keep_variant" checked> If I change the heading, keep the current form as a see-from variant</label>` : ""}
    <div class="field" data-chips="variant"><label for="a-variant">See from (variant forms, 4XX)</label>
      <div class="chip-list" aria-live="polite">${(a.variants || []).map(variantChip)}</div>
      <div class="input-group"><input id="a-variant" data-chip-input data-no-submit placeholder="Add a variant form and press Enter" maxlength="500" autocomplete="off">
        <button type="button" class="btn" data-chip-add>${icon("plus")}Add</button></div>
      <span class="hint">Records using a variant are rewritten to the authorised heading.</span></div>
    <div class="field" data-chips="see"><label for="a-see">See also (related headings, 5XX)</label>
      <div class="chip-list" aria-live="polite">${(a.see_also || []).map(seeAlsoChip)}</div>
      <div class="input-group"><label class="sr-only" for="a-rel">Relationship</label><select id="a-rel" data-chip-rel style="width:auto">
        ${RELS.map((r) => html`<option value="${r}">${r}</option>`)}</select>
        <input id="a-see" data-chip-input data-no-submit placeholder="Related heading" maxlength="500" autocomplete="off">
        <button type="button" class="btn" data-chip-add>${icon("plus")}Add</button></div></div>
    <div class="field"><label for="a-notes">Notes (staff only)</label><textarea id="a-notes" name="notes" rows="2" maxlength="10000">${a.notes || ""}</textarea></div>
    ${existing ? html`<div class="field"><label>Linked records (${num(a.usage || 0)})</label>
      ${records.length ? html`<div class="table-wrap" style="max-height:14rem;overflow:auto"><table class="table"><thead><tr><th>Title</th><th>As</th><th>Heading in record</th></tr></thead><tbody>
        ${records.map((r) => html`<tr><td><a href="/staff/catalog/${r.biblio_id}" target="_blank">${r.title}</a>${r.pub_year ? html` <span class="muted small">(${r.pub_year})</span>` : ""}</td>
          <td>${ROLE_LABEL[r.role] || r.role}</td><td class="small">${r.heading}</td></tr>`)}</tbody></table></div>`
        : html`<p class="small muted">No records use this heading yet.</p>`}</div>` : ""}
  </div>`;
}

function editorPayload(fd, existing) {
  const sa = fd.getAll("sa_heading").map((h, i) => ({ heading: h, relationship: fd.getAll("sa_rel")[i] || "related" }));
  const out = {
    auth_type: fd.get("auth_type"), heading: fd.get("heading").trim(), variants: fd.getAll("variant"),
    see_also: sa, source: (fd.get("source") || "local").trim() || "local", notes: fd.get("notes").trim() || null,
  };
  if (existing) out.keep_variant = fd.get("keep_variant") === "on";
  return out;
}

async function openEditor(id, prefill = {}) {
  const a = id ? await api(`/authorities/${id}`) : prefill;
  const saved = await formModal({ title: id ? `Authority #${id}` : "New authority", body: editorBody(a, a.records || []), submit: id ? "Save changes" : "Create", wide: true },
    async (fd, dlg) => {
      // a variant typed but not yet added would silently be lost — add it for the cataloguer
      $$("[data-chips]", dlg).forEach((box) => { if ($("[data-chip-input]", box).value.trim()) $("[data-chip-add]", box).click(); });
      const body = editorPayload(new FormData($("form", dlg)), !!id);
      return id ? api(`/authorities/${id}`, { method: "PATCH", body }) : api("/authorities", { method: "POST", body });
    }, wireChips);
  if (!saved) return;
  const renamed = saved.renamed ? ` · renamed in ${saved.renamed.records} record(s)` : "";
  toast(`Saved “${saved.heading}”${renamed}${relinkNote(saved.relink)}`, "success", 6000);
  await render();
}

// ------------------------------------------------------------------ merge

function mergePreview(p) {
  return html`<div class="stack">
    <div class="alert info">${icon("info")}<div><strong>${p.source.heading}</strong> (${num(p.source.usage)} record(s)) will be merged into
      <strong>${p.target.heading}</strong> (${num(p.target.usage)}). The merged heading is deleted; its forms are kept as see-from variants so future records match.</div></div>
    ${p.variants_added.length ? html`<div><strong class="small">Variants added to the kept authority</strong><div class="chip-list">${p.variants_added.map((v) => html`<span class="chip">${v}</span>`)}</div></div>` : ""}
    <div><strong class="small">Records to update (${num(p.records)})</strong>
    ${p.changes.length ? html`<div class="table-wrap" style="max-height:18rem;overflow:auto"><table class="table"><thead><tr><th>Record</th><th>Change</th></tr></thead><tbody>
      ${p.changes.map((r) => html`<tr><td><a href="/staff/catalog/${r.biblio_id}" target="_blank">${r.title}</a></td>
        <td class="small">${r.changes.map((c) => html`<div><span class="muted">${c.field}:</span> <span class="change-before">${c.before}</span> → <span class="change-after">${c.after}</span></div>`)}</td></tr>`)}
      </tbody></table></div>` : html`<p class="small muted">No record text changes (links are moved).</p>`}</div></div>`;
}

async function mergeFlow(source) {
  let picked = null;
  const preview = await formModal({
    title: `Merge “${source.heading}”`, submit: "Preview merge", wide: true,
    body: html`<div class="stack"><p class="small muted">Choose the authority to <strong>keep</strong>. Only ${typeLabel(source.auth_type).toLowerCase()} authorities can be chosen.</p>
      <div class="field"><label for="m-q">Find authority</label><input id="m-q" type="search" data-no-submit autocomplete="off" placeholder="Type part of the heading"></div>
      <fieldset class="stack tight" id="m-results" style="border:0;padding:0;margin:0"><legend class="sr-only">Matching authorities</legend></fieldset></div>`,
  }, async () => {
    if (!picked) throw new Error("Choose the authority to keep");
    return api("/authorities/merge", { method: "POST", body: { source_id: source.id, target_id: picked, dry_run: true } });
  }, (dlg) => {
    const box = $("#m-results", dlg);
    const search = debounce(async (q) => {
      const r = await api(`/authorities?${qs({ q, type: source.auth_type, per_page: 12, sort: "usage" })}`).catch(() => ({ results: [] }));
      const rows = r.results.filter((x) => x.id !== source.id);
      box.innerHTML = rows.length ? html`<legend class="sr-only">Matching authorities</legend>${rows.map((x) => html`<label class="checkbox"><input type="radio" name="target" value="${x.id}" ${picked === x.id ? "checked" : ""}>
        <span>${x.heading} <span class="muted small">· ${num(x.usage)} record(s)${x.variants.length ? ` · ${x.variants.length} variant(s)` : ""}</span></span></label>`)}`
        : empty(q ? "No other authority of this type matches" : "Start typing to search");
    }, 200);
    box.addEventListener("change", (e) => { if (e.target.name === "target") picked = +e.target.value; });
    $("#m-q", dlg).addEventListener("input", (e) => search(e.target.value.trim()));
    search("");
  });
  if (!preview) return;
  const ok = await modal({ title: "Review merge", body: mergePreview(preview), wide: true, danger: true,
    submit: `Merge${preview.records ? ` and update ${preview.records} record(s)` : ""}` });
  if (!ok) return;
  try {
    const res = await api("/authorities/merge", { method: "POST", body: { source_id: source.id, target_id: preview.target.id, dry_run: false } });
    toast(`Merged into “${res.target.heading}” · ${res.records} record(s) updated`, "success", 6000);
    await render();
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ list view

async function renderList() {
  panel().innerHTML = html`<form class="card pad row" id="auth-filter" role="search">
      <div class="field grow" style="min-width:220px"><label for="f-q">Heading or variant</label><input id="f-q" name="q" type="search" value="${state.q}" data-search-focus autocomplete="off"></div>
      <div class="field"><label for="f-type">Type</label><select id="f-type" name="type"><option value="">Any type</option>
        ${TYPES.map((t) => html`<option value="${t.value}" ${t.value === state.type ? "selected" : ""}>${t.label}</option>`)}</select></div>
      <div class="field"><label for="f-used">Usage</label><select id="f-used" name="used">
        ${[["", "Any"], ["used", "In use"], ["unused", "Unused"]].map(([v, l]) => html`<option value="${v}" ${v === state.used ? "selected" : ""}>${l}</option>`)}</select></div>
      <div class="field"><label for="f-sort">Sort</label><select id="f-sort" name="sort">
        ${[["heading", "A–Z"], ["usage", "Most used"], ["updated", "Recently changed"], ["created", "Newest"]].map(([v, l]) => html`<option value="${v}" ${v === state.sort ? "selected" : ""}>${l}</option>`)}</select></div>
      <div class="field"><label>&nbsp;</label><button class="btn primary">Search</button></div></form>
    <div class="row between" style="margin:1rem 0 .5rem"><span id="auth-summary" class="muted small"></span></div>
    <div class="card flush"><div class="table-wrap" id="auth-results">${raw(skeleton(6))}</div></div><div id="auth-pager"></div>`;
  $("#auth-filter").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    Object.assign(state, { q: fd.get("q").trim(), type: fd.get("type"), used: fd.get("used"), sort: fd.get("sort"), page: 1 });
    loadList();
  });
  $("#auth-filter").addEventListener("change", (e) => { if (e.target.tagName === "SELECT") e.currentTarget.requestSubmit(); });
  await loadList();
}

async function loadList() {
  const r = await api(`/authorities?${qs({ q: state.q, type: state.type, used: state.used, sort: state.sort, page: state.page, per_page: state.per })}`);
  $("#auth-summary").textContent = `${num(r.total)} authorit${r.total === 1 ? "y" : "ies"}`;
  $("#auth-results").innerHTML = r.results.length ? html`<table class="table"><thead><tr><th>Heading</th><th>Type</th><th>Source</th><th class="num">Records</th><th>Updated</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
    ${r.results.map((a) => html`<tr>
      <td><button class="btn ghost sm" style="text-align:left;font-weight:600" data-edit="${a.id}">${a.heading}</button>
        ${a.variants.length ? html`<div class="tiny muted" style="padding-left:.6rem">see from: ${a.variants.slice(0, 3).join(" · ")}${a.variants.length > 3 ? ` +${a.variants.length - 3}` : ""}</div>` : ""}
        ${a.see_also.length ? html`<div class="tiny muted" style="padding-left:.6rem">see also: ${a.see_also.slice(0, 3).map((s) => s.heading).join(" · ")}</div>` : ""}</td>
      <td class="small">${a.type_label}</td><td><span class="badge">${a.source}</span></td>
      <td class="num">${a.usage ? num(a.usage) : html`<span class="muted">0</span>`}</td>
      <td class="small muted nowrap">${relative(a.updated_at)}</td>
      <td class="right nowrap"><button class="btn sm ghost" data-edit="${a.id}" aria-label="Edit ${a.heading}">${icon("edit")}</button>
        <button class="btn sm ghost" data-merge="${a.id}" aria-label="Merge ${a.heading} into another authority" title="Merge">${icon("arrow-right")}</button>
        <button class="btn sm ghost danger" data-delete="${a.id}" aria-label="Delete ${a.heading}" ${a.usage ? raw('disabled title="In use — merge it instead"') : ""}>${icon("trash")}</button></td></tr>`)}
    </tbody></table>` : empty(state.q || state.type || state.used ? "No authorities match" : "No authorities yet — create one, import MARC authority records, or generate them from your catalogue's headings.");
  $("#auth-pager").innerHTML = pager(r.total, state.page, state.per, "data-page");
  state.rows = r.results;
}

// ------------------------------------------------------------------ unlinked headings report

async function renderUnlinked() {
  panel().innerHTML = html`<form class="card pad row" id="un-filter" role="search">
      <div class="field"><label for="u-role">Used as</label><select id="u-role" name="role"><option value="">Any</option>
        ${Object.entries(ROLE_LABEL).map(([v, l]) => html`<option value="${v.toLowerCase()}" ${v === state.role ? "selected" : ""}>${l}</option>`)}</select></div>
      <div class="field grow"><label for="u-q">Contains</label><input id="u-q" name="q" type="search" value="${state.uq}" autocomplete="off"></div>
      <div class="field"><label>&nbsp;</label><button class="btn primary">Refresh</button></div></form>
    <p class="small muted" style="margin:.75rem 0">Headings in your records that no authority controls, most used first. Create an authority, or add the heading as a variant of a close match so records are corrected automatically.</p>
    <div class="card flush"><div class="table-wrap" id="un-results">${raw(skeleton(6))}</div></div>`;
  $("#un-filter").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.role = fd.get("role");
    state.uq = fd.get("q").trim();
    loadUnlinked();
  });
  await loadUnlinked();
}

async function loadUnlinked() {
  const r = await api(`/authorities/unlinked?${qs({ role: state.role, q: state.uq, limit: 300 })}`);
  state.unlinked = r.results;
  $("#un-results").innerHTML = r.results.length ? html`<table class="table"><caption class="sr-only">Unlinked headings</caption>
    <thead><tr><th>Heading</th><th>Used as</th><th class="num">Records</th><th>Closest authority</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
    ${r.results.map((u, i) => html`<tr><td><strong>${u.heading}</strong></td><td>${ROLE_LABEL[u.role]}</td>
      <td class="num">${num(u.count)} <span class="tiny">${u.biblio_ids.slice(0, 3).map((id) => html` <a href="/staff/catalog/${id}" target="_blank" aria-label="Record ${id}">#${id}</a>`)}</span></td>
      <td class="small">${u.suggestion ? html`${u.suggestion.heading} <span class="muted">(${u.suggestion.score}%)</span>
        <button class="btn sm" data-add-variant="${i}">${icon("plus")}Add as variant</button>` : html`<span class="muted">—</span>`}</td>
      <td class="right"><button class="btn sm primary" data-create="${i}">${icon("plus")}Create authority</button></td></tr>`)}
    </tbody></table>${r.total > r.results.length ? html`<p class="small muted" style="padding:.75rem 1rem">Showing ${r.results.length} of ${num(r.total)}.</p>` : ""}`
    : empty("Every heading in the catalogue is under authority control.", "check");
}

async function addAsVariant(u) {
  const a = await api(`/authorities/${u.suggestion.authority_id}`);
  if (!(await confirmDialog("Add variant?", `“${u.heading}” becomes a see-from variant of “${a.heading}”. ${u.count} record(s) will be rewritten to the authorised form.`, "Add variant", false))) return;
  const res = await api(`/authorities/${a.id}`, { method: "PATCH", body: { variants: [...a.variants, u.heading] } });
  toast(`“${u.heading}” now points to “${res.heading}”${relinkNote(res.relink)}`, "success", 6000);
  await loadUnlinked();
}

// ------------------------------------------------------------------ tools

async function generateTool(btn) {
  let roles = [];
  let minCount = 1;
  const preview = await formModal({ title: "Generate authorities from the catalogue", submit: "Preview",
    body: html`<div class="stack"><p class="small muted">Creates a local authority for every heading in your records that is not yet controlled. Useful once, when you start using authority control. Nothing is created until you confirm.</p>
      <fieldset class="stack tight" style="border:0;padding:0;margin:0"><legend class="small" style="font-weight:600">Headings</legend>
        ${Object.entries(ROLE_LABEL).map(([v, l]) => html`<label class="checkbox"><input type="checkbox" name="roles" value="${v}" checked> ${l}s</label>`)}</fieldset>
      <div class="field"><label for="g-min">Only headings used in at least</label><div class="input-group"><input id="g-min" name="min_count" type="number" min="1" value="1" style="max-width:7rem"><span class="small muted" style="align-self:center;padding:0 .5rem">record(s)</span></div></div></div>` },
  (fd) => {
    roles = fd.getAll("roles");
    if (!roles.length) throw new Error("Choose at least one kind of heading");
    minCount = +fd.get("min_count") || 1;
    return api("/authorities/generate", { method: "POST", body: { roles, min_count: minCount, dry_run: true } });
  });
  if (!preview) return;
  if (!preview.would_create) { toast("Every heading is already controlled — nothing to create", "info"); return; }
  const ok = await modal({ title: `Create ${num(preview.would_create)} authorities?`, wide: true, submit: `Create ${num(preview.would_create)}`,
    body: html`<div class="stack"><div class="row tight">${Object.entries(preview.by_type).map(([t, n]) => html`<span class="badge info">${typeLabel(t)}: ${num(n)}</span>`)}</div>
      <div class="table-wrap" style="max-height:18rem;overflow:auto"><table class="table"><thead><tr><th>Heading</th><th>Type</th><th class="num">Uses</th></tr></thead><tbody>
      ${preview.sample.map((s) => html`<tr><td>${s.heading}</td><td class="small">${typeLabel(s.auth_type)}</td><td class="num">${s.count}</td></tr>`)}</tbody></table></div>
      <p class="small muted">Showing the ${preview.sample.length} most used. Types are guessed (e.g. organisations become corporate names); review them afterwards.</p></div>` });
  if (!ok) return;
  const res = await withBusy(btn, () => api("/authorities/generate", { method: "POST", body: { roles, min_count: minCount, dry_run: false } }));
  toast(`Created ${num(res.created)} authorities${relinkNote(res.relink)}`, "success", 6000);
  await render();
}

async function importTool() {
  const res = await formModal({ title: "Import MARC authority records", submit: "Import",
    body: html`<div class="stack"><p class="small muted">MARC21 authority records in MARCXML or ISO 2709 (.mrc). Headings 100/110/111/130/150/151/155 become authorities; 4XX become see-from variants and 5XX see-also references. Existing headings are updated, not duplicated.</p>
      <div class="field"><label for="i-file">File</label><input id="i-file" name="file" type="file" accept=".xml,.mrc,.marc,.marcxml,application/xml" required></div></div>` },
  (fd) => api("/authorities/import", { method: "POST", form: fd }));
  if (!res) return;
  await modal({ title: "Import finished", submit: "Close", body: html`<div class="stack">
    <div class="row tight"><span class="badge ok">${num(res.created)} created</span><span class="badge info">${num(res.updated)} updated</span>
      ${res.skipped ? html`<span class="badge warn">${num(res.skipped)} skipped</span>` : ""}${res.errors.length ? html`<span class="badge bad">${num(res.errors.length)} errors</span>` : ""}</div>
    <p class="small">${num(res.records)} record(s) read${relinkNote(res.relink)}.</p>
    ${[...res.errors, ...res.warnings].length ? html`<ul class="small" style="max-height:12rem;overflow:auto">${[...res.errors, ...res.warnings].slice(0, 100).map((m) => html`<li>${m}</li>`)}</ul>` : ""}</div>` });
  await render();
}

async function relinkTool(btn) {
  if (!(await confirmDialog("Relink all records?", "Every record's headings are matched against the authorities again, and see-from variants are rewritten to the authorised form. This is safe to repeat.", "Relink", false))) return;
  const res = await withBusy(btn, () => api("/authorities/relink", { method: "POST" }));
  toast(`Checked ${num(res.records)} records · ${num(res.links)} links · ${num(res.rewritten)} rewritten`, "success", 6000);
  await render();
}

// ------------------------------------------------------------------ wiring

async function render() {
  try {
    if (state.tab === "unlinked") await renderUnlinked();
    else await renderList();
  } catch (e) {
    panel().innerHTML = html`<div class="alert bad" role="alert">${icon("alert")}<div>${e.message}</div></div>`;
  }
}

export default async function init() {
  const meta = await api("/authorities/types");
  TYPES = meta.types;
  RELS = meta.relationships;
  const params = new URLSearchParams(location.search);
  state.q = params.get("q") || "";
  const select = setupTabs($("#auth-tabs"), (tab) => {
    state.tab = tab;
    history.replaceState(null, "", tab === "unlinked" ? "#unlinked" : location.pathname + location.search);
    render();
  });
  select(location.hash === "#unlinked" ? "unlinked" : "list");

  $("#new-authority").addEventListener("click", () => openEditor(null, { source: "local" }).catch((e) => toast(e.message, "error")));
  $("#tool-generate").addEventListener("click", (e) => generateTool(e.currentTarget).catch((err) => { if (!err.toasted) toast(err.message, "error"); }));
  $("#tool-import").addEventListener("click", () => importTool().catch((e) => toast(e.message, "error")));
  $("#tool-relink").addEventListener("click", (e) => relinkTool(e.currentTarget).catch((err) => { if (!err.toasted) toast(err.message, "error"); }));

  panel().addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.edit) await openEditor(+b.dataset.edit);
      else if (b.dataset.merge) await mergeFlow(state.rows.find((a) => a.id === +b.dataset.merge));
      else if (b.dataset.delete) {
        const a = state.rows.find((x) => x.id === +b.dataset.delete);
        if (!(await confirmDialog("Delete authority?", `“${a.heading}” and its ${a.variants.length} variant(s) will be removed.`, "Delete"))) return;
        await api(`/authorities/${a.id}`, { method: "DELETE" });
        toast("Authority deleted", "success");
        await loadList();
      } else if (b.dataset.page) { state.page = +b.dataset.page; await loadList(); }
      else if (b.dataset.create) {
        const u = state.unlinked[+b.dataset.create];
        await openEditor(null, { heading: u.heading, auth_type: u.suggested_type, source: "local" });
        await loadUnlinked();
      } else if (b.dataset.addVariant) await addAsVariant(state.unlinked[+b.dataset.addVariant]);
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
}
