// Staff › Catalogue › Authorities — two-pane browse / edit.
// Left: search, type and usage filters, keyboard list (↑/↓ move, Enter opens). Right: the authority editor
// (heading, type, source, see-from variants as chips, see-also references, notes, linked records) with Save,
// Merge and Delete (in the ⋯ menu). Tab 2: headings in records that no authority controls, with one-click
// "create authority" or "add as variant of the closest match". State lives in the URL (?q=&type=&id=).
import { $, $$, api, confirmDialog, html, icon, modal, num, qs, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { combobox } from "/static/js/ui/combobox.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { searchField, selectChip, urlState, wireFilterBar } from "/static/js/ui/filters.js";
import { setCount } from "/static/js/ui/page-header.js";
import { chipField, wireChipField } from "/static/js/pages/lib/chip-input.js";
import { actionMenu, alertBox, formModal, recNo, wireMenus } from "/static/js/pages/lib/collection.js";

const state = urlState({ q: "", type: "", used: "", sort: "heading", id: 0, role: "" });
const S = { types: [], rels: [], rows: [], total: 0, page: 1, per: 40, current: null, snapshot: "", can: false, unlinked: [], chips: null };
const SOURCES = ["local", "lcsh", "lcnaf", "mesh", "fast", "sears", "aat", "rvm"];
const panel = () => $("#auth-panel");
const typeLabel = (v) => t(`coll.auth.type_${v}`, {}, S.types.find((x) => x.value === v)?.label || v);
const relLabel = (r) => t(`coll.auth.rel_${r}`, {}, r);
const sourceLabel = (s) => t(`coll.auth.source_${s}`, {}, (s || "").toUpperCase());

// ------------------------------------------------------------------ helpers

function relinkNote(stats) {
  if (!stats || !stats.records) return "";
  return ` · ${t("coll.auth.relinked", { count: stats.records, n: num(stats.records) })}${stats.rewritten ? ` · ${t("coll.auth.rewritten", { count: stats.rewritten, n: num(stats.rewritten) })}` : ""}`;
}
const snapshot = () => { const f = $("#auth-form"); return f ? JSON.stringify([...new FormData(f)]) : ""; };
const dirty = () => !!$("#auth-form") && snapshot() !== S.snapshot;
async function confirmLeave() {
  if (!dirty()) return true;
  return confirmDialog(t("coll.auth.discard_title"), t("coll.auth.discard_text"), t("coll.auth.discard"));
}

// ------------------------------------------------------------------ list pane

function browseHtml() {
  const s = state.get();
  const typeOpts = [["", t("coll.auth.any_type")], ...S.types.map((x) => [x.value, typeLabel(x.value)])];
  return html`<div class="auth-panes ${s.id ? "show-detail" : ""}">
    <section class="auth-browse card" aria-labelledby="browse-h">
      <h2 class="sr-only" id="browse-h">${t("coll.auth.browse")}</h2>
      <div class="auth-filters" id="auth-filters">
        ${searchField({ name: "q", label: t("coll.auth.search_label"), value: s.q, placeholder: t("coll.auth.search_placeholder") })}
        <div class="filter-row">${selectChip({ name: "type", label: t("coll.auth.type"), value: s.type, options: typeOpts })}
          ${selectChip({ name: "used", label: t("coll.auth.usage"), value: s.used, options: [["", t("coll.auth.any_usage")], ["used", t("coll.auth.in_use")], ["unused", t("coll.auth.unused")]] })}
          ${selectChip({ name: "sort", label: t("coll.auth.sort"), value: s.sort === "heading" ? "" : s.sort, options: [["", t("coll.auth.sort_az")], ["usage", t("coll.auth.sort_usage")], ["updated", t("coll.auth.sort_updated")], ["created", t("coll.auth.sort_created")]] })}</div>
      </div>
      <div class="auth-summary small muted" id="auth-summary" aria-live="polite"></div>
      <div id="auth-list-state"></div>
      <ul class="auth-list" id="auth-list" role="listbox" aria-label="${t("coll.auth.results")}" tabindex="0" hidden></ul>
      <div class="auth-more" id="auth-more"></div>
    </section>
    <section class="auth-detail card" id="auth-detail" aria-live="polite" aria-labelledby="detail-h"><h2 class="sr-only" id="detail-h">${t("coll.auth.editor")}</h2></section>
  </div>`;
}

function listItem(a) {
  const s = state.get();
  return html`<li role="option" id="au-${a.id}" data-id="${a.id}" aria-selected="${a.id === s.id}">
    <span class="au-heading">${a.heading}</span>
    <span class="au-meta"><span>${typeLabel(a.auth_type)}</span>${a.variants.length ? html`<span>${t("coll.auth.n_variants", { count: a.variants.length, n: num(a.variants.length) })}</span>` : ""}</span>
    <span class="au-usage ${a.usage ? "" : "zero"}" aria-label="${t("coll.auth.used_in", { count: a.usage || 0, n: num(a.usage || 0) })}">${num(a.usage || 0)}</span></li>`;
}

async function loadList({ append = false } = {}) {
  const s = state.get();
  const list = $("#auth-list"), box = $("#auth-list-state");
  if (!append) { S.page = 1; list.hidden = true; box.innerHTML = html`<div aria-hidden="true">${Array.from({ length: 8 }, () => html`<div class="au-sk"><div class="skeleton sk-line w-70"></div></div>`)}</div>`; }
  try {
    const r = await api(`/authorities?${qs({ q: s.q, type: s.type, used: s.used, sort: s.sort, page: S.page, per_page: S.per })}`);
    S.rows = append ? [...S.rows, ...r.results] : r.results;
    S.total = r.total;
    list.innerHTML = html`${S.rows.map(listItem)}`;
    list.hidden = !S.rows.length;
    box.innerHTML = S.rows.length ? "" : emptyState({ art: s.q || s.type || s.used ? "filter" : "books", compact: true,
      title: t(s.q || s.type || s.used ? "coll.auth.no_match_title" : "coll.auth.empty_title"), body: t(s.q || s.type || s.used ? "coll.auth.no_match_body" : "coll.auth.empty_body") });
    $("#auth-summary").textContent = t("coll.auth.summary", { count: r.total, n: num(r.total) });
    setCount(r.total);
    $("#auth-more").innerHTML = S.rows.length < r.total ? html`<button type="button" class="btn sm" data-more>${t("coll.auth.load_more", { n: num(r.total - S.rows.length) })}</button>` : "";
    const sel = $(`#au-${s.id}`);
    if (sel) list.setAttribute("aria-activedescendant", sel.id); else list.removeAttribute("aria-activedescendant");
  } catch (e) {
    list.hidden = true;
    box.innerHTML = errorState(e, { retry: false });
  }
}

// ------------------------------------------------------------------ editor pane

const seeAlsoRow = (r) => html`<li class="sa-row" data-sa>
  <label class="sr-only">${t("coll.auth.relationship")}<select name="sa_rel">${S.rels.map((x) => html`<option value="${x}" ${x === (r.relationship || "related") ? "selected" : ""}>${relLabel(x)}</option>`)}</select></label>
  <span class="sa-heading">${r.authority_id ? html`<a href="?${qs({ id: r.authority_id })}" data-goto="${r.authority_id}">${r.heading}</a>` : r.heading}</span>
  <input type="hidden" name="sa_heading" value="${r.heading}">
  <button type="button" class="btn sm ghost icon-only" data-sa-rm aria-label="${t("coll.chips.remove", { value: r.heading })}">${icon("x")}</button></li>`;

function editorHtml(a = {}) {
  const existing = !!a.id;
  const records = a.records || [];
  const menu = existing && S.can ? actionMenu({ label: t("coll.auth.more_named", { heading: a.heading }), items: [
    { id: "merge", label: t("coll.auth.merge"), icon: "layers" },
    { href: `/api/v1/authorities/export?fmt=xml&ids=${a.id}`, label: t("coll.auth.export_one"), icon: "download", download: true },
    { separator: true },
    { id: "delete", label: t("coll.auth.delete"), icon: "trash", danger: true, disabled: !!a.usage },
  ] }) : "";
  return html`<form id="auth-form" novalidate class="auth-form">
    <header class="auth-head">
      <button type="button" class="btn sm ghost back-to-list" data-back>${icon("chevron-left", "flip-rtl")}${t("coll.auth.back")}</button>
      <div class="auth-head-main">
        <div class="dh-eyebrow"><span>${existing ? typeLabel(a.auth_type) : t("coll.auth.new")}</span>${existing ? html`<span class="mono">${recNo(a.id)}</span><span>${sourceLabel(a.source)}</span>` : ""}</div>
        <h2 class="auth-title">${existing ? a.heading : t("coll.auth.new_title")}</h2>
        ${existing ? html`<p class="small muted">${t("coll.auth.used_in", { count: a.usage || 0, n: num(a.usage || 0) })} · ${t("coll.auth.changed", { when: relative(a.updated_at) })}</p>` : ""}
      </div>${menu}
    </header>
    ${S.can ? "" : alertBox(t("coll.auth.read_only"), "info")}
    <div class="form-grid">
      <div class="field span-2"><label for="a-heading">${t("coll.auth.heading")}<span class="req" aria-hidden="true">*</span></label>
        <input id="a-heading" name="heading" required maxlength="500" value="${a.heading || ""}" autocomplete="off" aria-describedby="a-heading-h a-heading-err">
        <div class="field-help" id="a-heading-h">${t("coll.auth.heading_help")}</div><div class="field-error" id="a-heading-err" hidden></div></div>
      ${existing ? html`<label class="checkbox small span-2 keep-variant"><input type="checkbox" name="keep_variant" checked> ${t("coll.auth.keep_variant")}</label>` : ""}
      <div class="field"><label for="a-type">${t("coll.auth.type")}</label><select id="a-type" name="auth_type" required>
        ${S.types.map((x) => html`<option value="${x.value}" ${x.value === (a.auth_type || "topical_subject") ? "selected" : ""}>${typeLabel(x.value)} (${x.marc_tag})</option>`)}</select></div>
      <div class="field"><label for="a-source">${t("coll.auth.source")}</label><input id="a-source" name="source" list="a-sources" maxlength="32" value="${a.source || "local"}" autocomplete="off">
        <datalist id="a-sources">${SOURCES.map((x) => html`<option value="${x}">${sourceLabel(x)}</option>`)}</datalist></div>
      ${chipField({ name: "variant", label: t("coll.auth.variants"), values: a.variants || [], help: t("coll.auth.variants_help"), placeholder: t("coll.auth.variants_placeholder") })}
      <div class="field span-2"><span class="label-like" id="sa-label">${t("coll.auth.see_also")}</span>
        <ul class="sa-list" role="list" aria-labelledby="sa-label">${(a.see_also || []).map(seeAlsoRow)}</ul>
        <div class="sa-add"><label class="sr-only" for="sa-rel-new">${t("coll.auth.relationship")}</label>
          <select id="sa-rel-new">${S.rels.map((x) => html`<option value="${x}">${relLabel(x)}</option>`)}</select>
          <label class="sr-only" for="sa-new">${t("coll.auth.see_also_add")}</label><input id="sa-new" placeholder="${t("coll.auth.see_also_placeholder")}" autocomplete="off" data-no-submit>
          <button type="button" class="btn" data-sa-add>${icon("plus")}<span>${t("coll.auth.add")}</span></button></div>
        <div class="field-help">${t("coll.auth.see_also_help")}</div></div>
      <div class="field span-2"><label for="a-notes">${t("coll.auth.notes")}<span class="optional">${t("ui.form.optional")}</span></label><textarea id="a-notes" name="notes" rows="2" maxlength="10000">${a.notes || ""}</textarea></div>
    </div>
    ${existing ? html`<section class="linked" aria-labelledby="linked-h"><h3 id="linked-h" class="coll-label">${t("coll.auth.linked", { count: a.usage || 0, n: num(a.usage || 0) })}</h3>
      ${records.length ? html`<div class="table-wrap linked-wrap" tabindex="0" role="region" aria-labelledby="linked-h"><table class="table compact"><caption class="sr-only">${t("coll.auth.linked_caption")}</caption>
        <thead><tr><th scope="col">${t("coll.field.title")}</th><th scope="col">${t("coll.auth.as")}</th><th scope="col">${t("coll.auth.heading_in_record")}</th></tr></thead><tbody>
        ${records.map((r) => html`<tr><td><a href="/staff/catalog/${r.biblio_id}">${r.title}</a>${r.pub_year ? html` <span class="muted small">(${r.pub_year})</span>` : ""}</td>
          <td>${t(`coll.role.${r.role}`, {}, r.role)}</td><td class="small">${r.heading}</td></tr>`)}</tbody></table></div>`
        : html`<p class="small muted">${t("coll.auth.no_linked")}</p>`}</section>` : ""}
    ${S.can ? html`<div class="auth-savebar"><span class="save-status small muted" id="auth-status" aria-live="polite">${t("ui.form.no_changes")}</span>
      ${existing ? "" : html`<button type="button" class="btn" data-cancel-new>${t("common.cancel")}</button>`}
      <button type="submit" class="btn primary" aria-keyshortcuts="Control+S">${icon("check")}${existing ? t("coll.auth.save") : t("coll.auth.create")}</button></div>` : ""}
  </form>`;
}

function emptyDetail() {
  return html`<div class="auth-placeholder">${emptyState({ art: "search", title: t("coll.auth.pick_title"), body: t("coll.auth.pick_body"),
    actions: S.can ? html`<button type="button" class="btn primary" data-new-authority>${icon("plus")}${t("coll.auth.new")}</button>` : "" })}</div>`;
}

function wireEditor() {
  const form = $("#auth-form");
  if (!form) return;
  S.chips = wireChipField($('[data-chip-field="variant"]', form));
  if (!S.can) $$("input,select,textarea,button[type=submit]", form).forEach((el) => { if (!el.closest(".back-to-list")) el.disabled = true; });
  const seeInput = $("#sa-new", form);
  combobox(seeInput, {
    minChars: 2,
    source: async (q, signal) => (await api(`/authorities?${qs({ q, per_page: 8 })}`, { signal })).results.filter((x) => x.id !== S.current?.id),
    render: (x, q) => html`<span class="combo-main">${x.heading}<span class="sub">${typeLabel(x.auth_type)}</span></span>`,
    value: (x) => x.heading,
  });
  const addSeeAlso = () => {
    const v = seeInput.value.trim();
    if (!v) return;
    if ($$('input[name="sa_heading"]', form).some((i) => i.value.toLowerCase() === v.toLowerCase())) { toast(t("coll.chips.duplicate", { value: v }), "info"); return; }
    $(".sa-list", form).insertAdjacentHTML("beforeend", seeAlsoRow({ heading: v, relationship: $("#sa-rel-new", form).value }));
    seeInput.value = "";
    seeInput.focus();
    refreshStatus();
  };
  seeInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && seeInput.getAttribute("aria-expanded") !== "true") { e.preventDefault(); addSeeAlso(); } });
  form.addEventListener("click", (e) => {
    if (e.target.closest("[data-sa-add]")) addSeeAlso();
    const rm = e.target.closest("[data-sa-rm]");
    if (rm) { rm.closest("[data-sa]").remove(); seeInput.focus(); refreshStatus(); }
  });
  const refreshStatus = () => {
    const st = $("#auth-status");
    if (!st) return;
    const d = dirty();
    st.innerHTML = d ? html`<span class="dot" aria-hidden="true"></span>${t("ui.form.unsaved")}` : t("ui.form.no_changes");
    st.classList.toggle("is-dirty", d);
  };
  form.addEventListener("input", refreshStatus);
  form.addEventListener("change", refreshStatus);
  form.addEventListener("submit", (e) => { e.preventDefault(); save(form); });
  wireMenus(form, (act) => (act === "merge" ? mergeFlow(S.current) : act === "delete" ? remove(S.current) : null));
  S.snapshot = snapshot();
}

async function openAuthority(id, { focus = false } = {}) {
  if (!(await confirmLeave())) return false;
  state.set({ id }, { push: false });
  $$("#auth-list [role=option]").forEach((li) => li.setAttribute("aria-selected", String(+li.dataset.id === id)));
  $("#auth-list")?.setAttribute("aria-activedescendant", `au-${id}`);
  $(".auth-panes")?.classList.add("show-detail");
  const box = $("#auth-detail");
  box.innerHTML = html`<div class="skeleton" style="height:26rem;margin:1rem;border-radius:8px" aria-hidden="true"></div>`;
  try {
    S.current = await api(`/authorities/${id}`);
    box.innerHTML = editorHtml(S.current);
    wireEditor();
    if (focus) $("#a-heading")?.focus();
  } catch (e) {
    box.innerHTML = e.status === 404 ? emptyDetail() : errorState(e, { retry: false });
  }
  return true;
}

async function newAuthority(prefill = {}) {
  if (!(await confirmLeave())) return;
  if ($("#auth-tab-unlinked")?.getAttribute("aria-selected") === "true") await selectTab("list");
  state.set({ id: 0 });
  S.current = null;
  $$("#auth-list [role=option]").forEach((li) => li.setAttribute("aria-selected", "false"));
  $(".auth-panes")?.classList.add("show-detail");
  $("#auth-detail").innerHTML = editorHtml({ source: "local", ...prefill });
  wireEditor();
  if (prefill.heading) S.snapshot = ""; // a prefilled heading counts as an unsaved change
  $("#a-heading").focus();
}

function payload(form, existing) {
  S.chips?.flush();
  const fd = new FormData(form);
  const out = {
    auth_type: fd.get("auth_type"), heading: String(fd.get("heading")).trim(), variants: fd.getAll("variant"),
    see_also: fd.getAll("sa_heading").map((h, i) => ({ heading: h, relationship: fd.getAll("sa_rel")[i] || "related" })),
    source: String(fd.get("source") || "local").trim() || "local", notes: String(fd.get("notes") || "").trim() || null,
  };
  if (existing) out.keep_variant = fd.get("keep_variant") === "on";
  return out;
}

async function save(form) {
  const heading = $("#a-heading", form);
  if (!heading.value.trim()) {
    heading.setAttribute("aria-invalid", "true");
    const err = $("#a-heading-err");
    err.hidden = false;
    err.innerHTML = html`${icon("alert")}<span>${t("ui.form.required")}</span>`;
    heading.focus();
    return;
  }
  const existing = !!S.current?.id;
  const btn = $('button[type="submit"]', form);
  try {
    const saved = await withBusy(btn, () => (existing ? api(`/authorities/${S.current.id}`, { method: "PATCH", body: payload(form, true) })
      : api("/authorities", { method: "POST", body: payload(form, false) })));
    const renamed = saved.renamed ? ` · ${t("coll.auth.renamed_in", { count: saved.renamed.records, n: num(saved.renamed.records) })}` : "";
    toast(`${t("coll.auth.saved", { heading: saved.heading })}${renamed}${relinkNote(saved.relink)}`, "success", 6000);
    S.snapshot = snapshot();
    await loadList();
    await openAuthority(saved.id);
  } catch { /* toasted */ }
}

async function remove(a) {
  if (!a || a.usage) { toast(t("coll.auth.in_use_merge"), "warn"); return; }
  if (!(await confirmDialog(t("coll.auth.delete_title"), t("coll.auth.delete_text", { heading: a.heading, count: a.variants.length, n: num(a.variants.length) }), t("coll.auth.delete_confirm")))) return;
  try {
    await api(`/authorities/${a.id}`, { method: "DELETE" });
    toast(t("coll.auth.deleted"), "success");
    S.snapshot = snapshot();
    state.set({ id: 0 });
    S.current = null;
    $("#auth-detail").innerHTML = emptyDetail();
    $(".auth-panes")?.classList.remove("show-detail");
    await loadList();
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ merge

async function mergeFlow(source) {
  if (!source) return;
  let target = null;
  const preview = await formModal({ title: t("coll.auth.merge_title", { heading: source.heading }), submit: t("coll.auth.preview_merge"), size: "md",
    body: html`<div class="stack"><p>${t("coll.auth.merge_intro", { type: typeLabel(source.auth_type) })}</p>
      <div class="field"><label for="m-q">${t("coll.auth.merge_keep")}</label><input id="m-q" required autocomplete="off" placeholder="${t("coll.auth.search_placeholder")}" aria-describedby="m-q-h">
        <div class="field-help" id="m-q-h">${t("coll.auth.merge_keep_help")}</div></div>
      <div id="m-chosen" aria-live="polite"></div></div>` },
  async () => {
    if (!target) throw Object.assign(new Error(t("coll.auth.merge_choose")), { toasted: false });
    return api("/authorities/merge", { method: "POST", body: { source_id: source.id, target_id: target.id, dry_run: true } });
  },
  (dlg) => {
    const input = $("#m-q", dlg);
    combobox(input, {
      minChars: 1,
      source: async (q, signal) => (await api(`/authorities?${qs({ q, type: source.auth_type, per_page: 10, sort: "usage" })}`, { signal })).results.filter((x) => x.id !== source.id),
      render: (x) => html`<span class="combo-main">${x.heading}<span class="sub">${t("coll.auth.used_in", { count: x.usage || 0, n: num(x.usage || 0) })}</span></span>`,
      value: (x) => x.heading,
      onSelect: (x) => { target = x; $("#m-chosen", dlg).innerHTML = alertBox(t("coll.auth.merge_chosen", { heading: x.heading }), "info"); },
    });
    input.addEventListener("input", () => { target = null; $("#m-chosen", dlg).innerHTML = ""; });
  });
  if (!preview) return;
  const p = preview;
  const ok = await modal({ title: t("coll.auth.merge_review"), size: "lg", danger: true,
    submit: p.records ? t("coll.auth.merge_and_update", { count: p.records, n: num(p.records) }) : t("coll.auth.merge"),
    body: html`<div class="stack">${alertBox(t("coll.auth.merge_summary", { from: p.source.heading, from_n: num(p.source.usage), to: p.target.heading, to_n: num(p.target.usage) }), "info")}
      ${p.variants_added.length ? html`<div><h3 class="coll-label">${t("coll.auth.variants_added")}</h3><ul class="tag-list" role="list">${p.variants_added.map((v) => html`<li><span class="tag">${v}</span></li>`)}</ul></div>` : ""}
      <div><h3 class="coll-label">${t("coll.auth.records_to_update", { n: num(p.records) })}</h3>
      ${p.changes.length ? html`<div class="table-wrap scroll-18" tabindex="0" role="region" aria-label="${t("coll.auth.records_to_update", { n: num(p.records) })}"><table class="table compact"><caption class="sr-only">${t("coll.auth.records_to_update", { n: num(p.records) })}</caption>
        <thead><tr><th scope="col">${t("coll.field.title")}</th><th scope="col">${t("coll.auth.change")}</th></tr></thead><tbody>
        ${p.changes.map((r) => html`<tr><td><a href="/staff/catalog/${r.biblio_id}" target="_blank" rel="noopener">${r.title}</a></td>
          <td class="small">${r.changes.map((c) => html`<div><span class="muted">${t(`coll.field.${c.field}`, {}, c.field)}:</span> <del class="change-before">${c.before}</del> → <ins class="change-after">${c.after}</ins></div>`)}</td></tr>`)}</tbody></table></div>`
        : html`<p class="small muted">${t("coll.auth.no_text_changes")}</p>`}</div></div>` });
  if (!ok) return;
  try {
    const res = await api("/authorities/merge", { method: "POST", body: { source_id: source.id, target_id: p.target.id, dry_run: false } });
    toast(t("coll.auth.merged", { heading: res.target.heading, count: res.records, n: num(res.records) }), "success", 6000);
    S.snapshot = snapshot();
    await loadList();
    await openAuthority(res.target.id);
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ unlinked headings

function unlinkedHtml() {
  const s = state.get();
  return html`<p class="small muted unlinked-intro">${t("coll.auth.unlinked_intro")}</p>
    <div class="filter-bar" id="un-filters"><div class="filter-row">
      ${searchField({ name: "uq", label: t("coll.auth.unlinked_search"), value: "", placeholder: t("coll.auth.unlinked_search"), shortcut: "/" })}
      ${selectChip({ name: "role", label: t("coll.auth.used_as"), value: s.role, options: [["", t("coll.auth.any_role")], ["author", t("coll.role.author")], ["subject", t("coll.role.subject")], ["series", t("coll.role.series")]] })}</div></div>
    <div id="un-table"></div>`;
}

let unTable = null;
async function showUnlinked(q = "") {
  const s = state.get();
  unTable.setLoading();
  try {
    const r = await api(`/authorities/unlinked?${qs({ role: s.role, q, limit: 300 })}`);
    S.unlinked = r.results.map((u, i) => ({ ...u, _i: i }));
    unTable.setRows(S.unlinked);
  } catch (e) { unTable.setError(e, () => showUnlinked(q)); }
}

function mountUnlinked() {
  panel().innerHTML = unlinkedHtml();
  unTable = dataTable($("#un-table"), {
    id: "auth-unlinked", caption: t("coll.auth.tab_unlinked"), rowKey: (u) => u._i, exportName: "unlinked-headings",
    columns: [
      { key: "heading", label: t("coll.auth.heading_col"), primary: true, hideable: false, csv: (u) => u.heading, render: (u) => html`<strong>${u.heading}</strong>` },
      { key: "role", label: t("coll.auth.used_as"), csv: (u) => u.role, render: (u) => t(`coll.role.${u.role}`, {}, u.role) },
      { key: "count", label: t("coll.auth.records"), align: "num", csv: (u) => u.count,
        render: (u) => html`<div class="dt-cell-stack"><span>${num(u.count)}</span><span class="sub">${u.biblio_ids.slice(0, 3).map((id, i) => html`${i ? " " : ""}<a href="/staff/catalog/${id}">${recNo(id)}</a>`)}</span></div>` },
      { key: "closest", label: t("coll.auth.closest"), csv: (u) => u.suggestion?.heading || "",
        render: (u) => (u.suggestion ? html`<div class="dt-cell-stack"><a href="?${qs({ id: u.suggestion.authority_id })}" data-goto="${u.suggestion.authority_id}">${u.suggestion.heading}</a>
          <span class="sub">${t("coll.auth.similarity", { pct: num(u.suggestion.score) })}</span></div>` : html`<span class="muted">—</span>`) },
      { key: "actions", label: t("coll.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions",
        render: (u) => (S.can ? html`<div class="row-actions">${u.suggestion ? html`<button type="button" class="btn sm" data-add-variant="${u._i}">${icon("plus")}<span>${t("coll.auth.add_variant")}</span></button>` : ""}
          <button type="button" class="btn sm primary" data-create="${u._i}">${icon("plus")}<span>${t("coll.auth.create_authority")}</span></button></div>` : "") },
    ],
    empty: { art: "done", title: t("coll.auth.all_controlled_title"), body: t("coll.auth.all_controlled_body") },
  });
  let q = "";
  wireFilterBar($("#un-filters"), (ch) => {
    if ("uq" in ch) q = ch.uq;
    if ("role" in ch) state.set({ role: ch.role });
    showUnlinked(q);
  });
  showUnlinked();
}

async function addAsVariant(u) {
  const a = await api(`/authorities/${u.suggestion.authority_id}`);
  if (!(await confirmDialog(t("coll.auth.add_variant_title"), t("coll.auth.add_variant_text", { heading: u.heading, target: a.heading, count: u.count, n: num(u.count) }), t("coll.auth.add_variant"), false))) return;
  const res = await api(`/authorities/${a.id}`, { method: "PATCH", body: { variants: [...a.variants, u.heading] } });
  toast(`${t("coll.auth.variant_added", { heading: u.heading, target: res.heading })}${relinkNote(res.relink)}`, "success", 6000);
  showUnlinked();
}

// ------------------------------------------------------------------ tools

async function generateTool() {
  let roles = [], minCount = 1;
  const preview = await formModal({ title: t("coll.auth.gen_title"), submit: t("coll.auth.preview"),
    body: html`<div class="stack"><p>${t("coll.auth.gen_intro")}</p>
      <fieldset class="plain-fieldset"><legend class="label-like">${t("coll.auth.gen_headings")}</legend>
        <div class="row tight">${["author", "subject", "series"].map((v) => html`<label class="checkbox"><input type="checkbox" name="roles" value="${v}" checked> ${t(`coll.auth.gen_${v}`)}</label>`)}</div></fieldset>
      <div class="field"><label for="g-min">${t("coll.auth.gen_min")}</label><input id="g-min" name="min_count" type="number" min="1" value="1" class="num-input"></div></div>` },
  (fd) => {
    roles = fd.getAll("roles");
    if (!roles.length) { const e = new Error(t("coll.auth.gen_need_role")); throw e; }
    minCount = +fd.get("min_count") || 1;
    return api("/authorities/generate", { method: "POST", body: { roles, min_count: minCount, dry_run: true } });
  });
  if (!preview) return;
  if (!preview.would_create) { toast(t("coll.auth.gen_nothing"), "info"); return; }
  const ok = await modal({ title: t("coll.auth.gen_confirm_title", { n: num(preview.would_create) }), size: "lg", submit: t("coll.auth.gen_create", { n: num(preview.would_create) }),
    body: html`<div class="stack"><ul class="tag-list" role="list">${Object.entries(preview.by_type).map(([k, n]) => html`<li><span class="badge pill info">${typeLabel(k)} · ${num(n)}</span></li>`)}</ul>
      <div class="table-wrap scroll-18" tabindex="0" role="region" aria-label="${t("coll.auth.gen_sample")}"><table class="table compact"><caption class="sr-only">${t("coll.auth.gen_sample")}</caption>
        <thead><tr><th scope="col">${t("coll.auth.heading_col")}</th><th scope="col">${t("coll.auth.type")}</th><th scope="col" class="num">${t("coll.auth.records")}</th></tr></thead><tbody>
        ${preview.sample.map((x) => html`<tr><td>${x.heading}</td><td class="small">${typeLabel(x.auth_type)}</td><td class="num">${num(x.count)}</td></tr>`)}</tbody></table></div>
      <p class="small muted">${t("coll.auth.gen_note", { n: num(preview.sample.length) })}</p></div>` });
  if (!ok) return;
  const res = await api("/authorities/generate", { method: "POST", body: { roles, min_count: minCount, dry_run: false } });
  toast(`${t("coll.auth.gen_done", { count: res.created, n: num(res.created) })}${relinkNote(res.relink)}`, "success", 6000);
  await loadList();
}

async function importTool() {
  const res = await formModal({ title: t("coll.auth.import_title"), submit: t("coll.auth.import"),
    body: html`<div class="stack"><p>${t("coll.auth.import_intro")}</p>
      <div class="field"><label for="i-file">${t("coll.auth.file")}</label><input id="i-file" name="file" type="file" accept=".xml,.mrc,.marc,.marcxml,application/xml" required></div></div>` },
  (fd) => api("/authorities/import", { method: "POST", form: fd }));
  if (!res) return;
  const msgs = [...res.errors, ...res.warnings];
  await modal({ title: t("coll.auth.import_done"), submit: t("common.close"), cancel: false, body: html`<div class="stack">
    <ul class="tag-list" role="list"><li>${statusTag("success", t("coll.auth.n_created", { n: num(res.created) }))}</li><li>${statusTag("info", t("coll.auth.n_updated", { n: num(res.updated) }))}</li>
      ${res.skipped ? html`<li>${statusTag("warning", t("coll.auth.n_skipped", { n: num(res.skipped) }))}</li>` : ""}${res.errors.length ? html`<li>${statusTag("danger", t("coll.auth.n_errors", { n: num(res.errors.length) }))}</li>` : ""}</ul>
    <p>${t("coll.auth.n_read", { count: res.records, n: num(res.records) })}${relinkNote(res.relink)}</p>
    ${msgs.length ? html`<ul class="small scroll-12" tabindex="0" role="region" aria-label="${t("coll.auth.messages")}">${msgs.slice(0, 100).map((m) => html`<li>${m}</li>`)}</ul>` : ""}</div>` });
  await loadList();
}
const statusTag = (tone, text) => html`<span class="badge pill ${tone}"><span class="dot" aria-hidden="true"></span>${text}</span>`;

async function relinkTool() {
  if (!(await confirmDialog(t("coll.auth.relink_title"), t("coll.auth.relink_text"), t("coll.auth.relink"), false))) return;
  const res = await api("/authorities/relink", { method: "POST" });
  toast(t("coll.auth.relink_done", { records: num(res.records), links: num(res.links), rewritten: num(res.rewritten) }), "success", 6000);
  await loadList();
}

// ------------------------------------------------------------------ wiring

let selectTab = () => {};

async function showList() {
  panel().innerHTML = browseHtml();
  const s = state.get();
  $("#auth-detail").insertAdjacentHTML("beforeend", s.id ? "" : emptyDetail());
  wireFilterBar($("#auth-filters"), async (ch) => {
    if (!(await confirmLeave())) return;
    state.set({ ...ch });
    loadList();
  });
  await loadList();
  if (s.id) await openAuthority(s.id);
}

export default async function init() {
  const root = $("#auth");
  S.can = root.dataset.canWrite === "1";
  try {
    const meta = await api("/authorities/types");
    S.types = meta.types;
    S.rels = meta.relationships;
  } catch (e) { panel().innerHTML = errorState(e, { retry: false }); return; }

  $("#tools-slot").innerHTML = actionMenu({ label: t("coll.auth.tools"), text: t("coll.auth.tools"), align: "end", items: [
    S.can ? { id: "generate", label: t("coll.auth.tool_generate"), icon: "sparkle" } : null,
    S.can ? { id: "import", label: t("coll.auth.tool_import"), icon: "upload" } : null,
    { href: "/api/v1/authorities/export?fmt=xml", label: t("coll.auth.tool_export_xml"), icon: "download", download: true },
    { href: "/api/v1/authorities/export?fmt=mrc", label: t("coll.auth.tool_export_mrc"), icon: "download", download: true },
    S.can ? { separator: true } : null,
    S.can ? { id: "relink", label: t("coll.auth.tool_relink"), icon: "refresh" } : null,
  ] });
  wireMenus($("#tools-slot"), (act) => {
    const run = { generate: generateTool, import: importTool, relink: relinkTool }[act];
    run?.().catch((e) => { if (!e.toasted) toast(e.message, "error"); });
  });
  $("#new-authority")?.addEventListener("click", () => newAuthority());

  const tablist = $("#auth-tabs");
  const tabsEls = $$('[role="tab"]', tablist);
  selectTab = async (key, focus = false) => {
    if (!(await confirmLeave())) return;
    tabsEls.forEach((b) => { const on = b.dataset.tab === key; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    panel().setAttribute("aria-labelledby", `auth-tab-${key}`);
    history.replaceState(null, "", `${location.pathname}${location.search}${key === "unlinked" ? "#unlinked" : ""}`);
    S.snapshot = "";
    if (key === "unlinked") mountUnlinked(); else await showList();
  };
  tablist.addEventListener("click", (e) => { const b = e.target.closest('[role="tab"]'); if (b) selectTab(b.dataset.tab); });
  tablist.addEventListener("keydown", (e) => {
    const i = tabsEls.indexOf(document.activeElement);
    if (i < 0) return;
    const rtl = getComputedStyle(tablist).direction === "rtl";
    const next = { [rtl ? "ArrowLeft" : "ArrowRight"]: i + 1, [rtl ? "ArrowRight" : "ArrowLeft"]: i - 1, Home: 0, End: tabsEls.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectTab(tabsEls[(next + tabsEls.length) % tabsEls.length].dataset.tab, true);
  });

  panel().addEventListener("click", async (e) => {
    const opt = e.target.closest("#auth-list [role=option][data-id]");
    if (opt) { openAuthority(+opt.dataset.id); return; }
    const go = e.target.closest("[data-goto]");
    if (go) {
      e.preventDefault();
      if ($("#auth-tab-unlinked").getAttribute("aria-selected") === "true") { state.set({ id: +go.dataset.goto }); await selectTab("list"); }
      else openAuthority(+go.dataset.goto);
      return;
    }
    if (e.target.closest("[data-more]")) { S.page++; loadList({ append: true }); return; }
    if (e.target.closest("[data-back]")) {
      if (!(await confirmLeave())) return;
      S.snapshot = snapshot();
      $(".auth-panes")?.classList.remove("show-detail");
      $(`#au-${state.get().id}`)?.focus();
      return;
    }
    if (e.target.closest("[data-new-authority]")) { newAuthority(); return; }
    if (e.target.closest("[data-cancel-new]")) { S.snapshot = snapshot(); $("#auth-detail").innerHTML = emptyDetail(); $(".auth-panes")?.classList.remove("show-detail"); return; }
    const cr = e.target.closest("[data-create]");
    if (cr) { const u = S.unlinked[+cr.dataset.create]; await selectTab("list"); newAuthority({ heading: u.heading, auth_type: u.suggested_type }); return; }
    const av = e.target.closest("[data-add-variant]");
    if (av) addAsVariant(S.unlinked[+av.dataset.addVariant]).catch((err) => toast(err.message, "error"));
  });
  // keyboard list: ↑/↓/Home/End move the selection, Enter opens and focuses the heading field
  panel().addEventListener("keydown", (e) => {
    if (e.target.id !== "auth-list") return;
    const items = $$("#auth-list [role=option][data-id]");
    if (!items.length) return;
    const cur = items.findIndex((li) => li.getAttribute("aria-selected") === "true");
    const to = { ArrowDown: cur + 1, ArrowUp: cur - 1, Home: 0, End: items.length - 1, j: cur + 1, k: cur - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      const li = items[Math.max(0, Math.min(items.length - 1, to))];
      li.scrollIntoView({ block: "nearest" });
      openAuthority(+li.dataset.id);
    } else if (e.key === "Enter" && cur >= 0) { e.preventDefault(); $("#a-heading")?.focus(); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && $("#auth-form") && !document.querySelector("dialog[open]")) { e.preventDefault(); $("#auth-form").requestSubmit(); }
  });
  window.addEventListener("beforeunload", (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });
  window.addEventListener("popstate", () => { const id = state.get().id; if (id) openAuthority(id); });
  const params = new URLSearchParams(location.search);
  if (params.get("q") && !state.get().q) state.set({ q: params.get("q") });
  await selectTab(location.hash === "#unlinked" ? "unlinked" : "list");
}
