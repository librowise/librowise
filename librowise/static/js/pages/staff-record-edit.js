// Staff › Catalogue › New / Edit record — FORM PAGE on the design system.
// Sections (identifier · title & responsibility · publication · content · cover) with inline validation and a
// sticky save bar that guards unsaved changes; authors and subjects are chip fields with authority typeahead.
// The assistant panel (aside) offers ISBN metadata, AI suggestions and a live duplicate check — every
// suggestion is accepted or dismissed individually and nothing changes until the record is saved.
import { $, api, debounce, html, icon, qs, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { enhanceForm, field, formSection, setFieldError } from "/static/js/ui/form.js";
import { chipField, wireChipField } from "/static/js/pages/lib/chip-input.js";
import { alertBox, audienceLabel, fmtLabel, langName, languageOptions, recNo } from "/static/js/pages/lib/collection.js";

const S = { id: null, b: null, lk: null, chips: {}, form: null, f: null, next: "record", lookup: null, ai: null, dupes: [] };
const AUDIENCES = ["children", "young_adult", "adult"];

// ------------------------------------------------------------------ ISBN

const digits = (v) => String(v || "").replace(/[\s-]/g, "").toUpperCase();
/** True when an ISBN-10/13 has a valid check digit (blank counts as valid). */
export function isbnValid(v) {
  const s = digits(v);
  if (!s) return true;
  if (/^\d{9}[\dX]$/.test(s)) return [...s].reduce((a, c, i) => a + (c === "X" ? 10 : +c) * (10 - i), 0) % 11 === 0;
  if (/^\d{13}$/.test(s)) return [...s].reduce((a, c, i) => a + +c * (i % 2 ? 3 : 1), 0) % 10 === 0;
  return false;
}

// ------------------------------------------------------------------ form

function formHtml(b = {}, controlled = []) {
  const val = (k) => (b[k] === null || b[k] === undefined ? "" : b[k]);
  return html`<form id="rec-form" class="card pad edit-form" novalidate>
    ${formSection({ title: t("coll.edit.sec_identify"), description: t("coll.edit.sec_identify_desc"), body: html`<div class="form-grid">
      <div class="field span-2" data-field="isbn"><label for="f-isbn">${t("coll.field.isbn")}</label>
        <div class="input-group"><input id="f-isbn" name="isbn" class="mono" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="20" value="${val("isbn")}" placeholder="978…"
          aria-describedby="f-isbn-help f-isbn-err">
          <button type="button" class="btn" id="isbn-lookup">${icon("search")}<span>${t("coll.edit.lookup")}</span></button></div>
        <div class="field-help" id="f-isbn-help">${t("coll.edit.isbn_help")}</div><div class="field-error" id="f-isbn-err" hidden></div></div>
      ${field({ name: "issn", label: t("coll.field.issn"), value: val("issn"), optional: true, attrs: 'class="mono" maxlength="20" autocomplete="off"' })}
    </div>` })}
    ${formSection({ title: t("coll.edit.sec_title"), description: t("coll.edit.sec_title_desc"), body: html`<div class="form-grid">
      ${field({ name: "title", label: t("coll.field.title"), value: val("title"), required: true, span: 2, attrs: 'maxlength="500" autocomplete="off"' })}
      ${field({ name: "subtitle", label: t("coll.field.subtitle"), value: val("subtitle"), optional: true, span: 2, attrs: 'maxlength="500" autocomplete="off"' })}
      ${chipField({ name: "authors", label: t("coll.field.authors"), values: b.authors || [], controlled, help: t("coll.edit.authors_help"), placeholder: t("coll.edit.authors_placeholder") })}
    </div>` })}
    ${formSection({ title: t("coll.edit.sec_pub"), description: t("coll.edit.sec_pub_desc"), body: html`<div class="form-grid">
      ${field({ name: "publisher", label: t("coll.field.publisher"), value: val("publisher"), optional: true, attrs: 'maxlength="255"' })}
      ${field({ name: "pub_year", label: t("coll.field.year"), type: "number", value: val("pub_year"), optional: true, attrs: 'min="0" max="2100" inputmode="numeric"' })}
      ${field({ name: "edition", label: t("coll.field.edition"), value: val("edition"), optional: true, attrs: 'maxlength="80"', placeholder: t("coll.edit.edition_placeholder") })}
      ${field({ name: "pages", label: t("coll.field.pages"), type: "number", value: val("pages"), optional: true, attrs: 'min="0" max="100000" inputmode="numeric"' })}
      ${field({ name: "series", label: t("coll.field.series"), value: val("series"), optional: true, span: 2, attrs: 'maxlength="255"' })}
    </div>` })}
    ${formSection({ title: t("coll.edit.sec_content"), description: t("coll.edit.sec_content_desc"), body: html`<div class="form-grid">
      ${field({ name: "material_type", label: t("coll.field.format"), as: "select", value: b.material_type || "book", options: S.lk.material_types.map((m) => [m, fmtLabel(m)]) })}
      ${field({ name: "language", label: t("coll.field.language"), as: "select", value: b.language || "en", options: languageOptions(b.language) })}
      ${field({ name: "audience", label: t("coll.field.audience"), as: "select", value: b.audience || "", options: [["", t("coll.edit.audience_any")], ...AUDIENCES.map((a) => [a, audienceLabel(a)])] })}
      ${field({ name: "classification", label: t("coll.field.classification"), value: val("classification"), optional: true, help: t("coll.edit.class_help"), attrs: 'class="mono" maxlength="40" autocomplete="off"' })}
      ${chipField({ name: "subjects", label: t("coll.field.subjects"), values: b.subjects || [], controlled, help: t("coll.edit.subjects_help"), placeholder: t("coll.edit.subjects_placeholder") })}
      ${field({ name: "description", label: t("coll.field.description"), as: "textarea", value: val("description"), optional: true, span: 2, attrs: 'maxlength="20000" rows="5"' })}
    </div>` })}
    ${formSection({ title: t("coll.edit.sec_cover"), description: t("coll.edit.sec_cover_desc"), body: html`<div class="form-grid">
      ${field({ name: "cover_url", label: t("coll.field.cover_url"), type: "url", value: val("cover_url"), optional: true, span: 2, help: t("coll.edit.cover_help"), attrs: 'maxlength="500" inputmode="url"' })}
    </div>` })}
    <div class="save-bar" data-save-bar>
      <span class="save-status" data-save-status aria-live="polite">${t("ui.form.no_changes")}</span>
      <a class="btn" href="${S.id ? `/staff/catalog/${S.id}` : "/staff/catalog"}">${t("common.cancel")}</a>
      ${S.id ? "" : html`<button type="submit" class="btn" data-next="items">${icon("plus")}${t("coll.edit.save_add_items")}</button>`}
      <button type="submit" class="btn primary" data-next="record" aria-keyshortcuts="Control+S">${icon("check")}${t("coll.edit.save")}</button>
    </div>
  </form>`;
}

function payload(form) {
  S.chips.authors.flush();
  S.chips.subjects.flush();
  const fd = new FormData(form);
  const s = (k) => String(fd.get(k) || "").trim();
  const n = (k) => (s(k) === "" ? null : Number(s(k)));
  return {
    title: s("title"), subtitle: s("subtitle") || null, authors: fd.getAll("authors"), isbn: digits(s("isbn")) || null, issn: s("issn") || null,
    publisher: s("publisher") || null, pub_year: n("pub_year"), edition: s("edition") || null, pages: n("pages"),
    material_type: s("material_type") || "book", language: s("language") || "en", audience: s("audience") || null,
    classification: s("classification") || null, series: s("series") || null, cover_url: s("cover_url") || null,
    subjects: fd.getAll("subjects"), description: s("description") || null,
  };
}

/** Set a form value as if the cataloguer typed it (dirty tracking and validation follow). */
function setValue(name, value) {
  const el = S.form.elements[name];
  if (!el) return;
  el.value = value ?? "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.classList.add("just-filled");
  setTimeout(() => el.classList.remove("just-filled"), 1600);
}

// ------------------------------------------------------------------ assistant panel

function assistantHtml() {
  return html`<section class="card assist-card" aria-labelledby="as-dupes-h">
      <div class="card-head"><h2 id="as-dupes-h">${icon("layers")} ${t("coll.assist.dupes_title")}</h2></div>
      <div class="card-body" id="as-dupes" aria-live="polite"><p class="small muted">${t("coll.assist.dupes_idle")}</p></div></section>
    <section class="card assist-card" aria-labelledby="as-isbn-h">
      <div class="card-head"><h2 id="as-isbn-h">${icon("search")} ${t("coll.assist.isbn_title")}</h2></div>
      <div class="card-body" id="as-isbn" aria-live="polite"><p class="small muted">${t("coll.assist.isbn_idle")}</p></div></section>
    <section class="card panel-ai assist-card" aria-labelledby="as-ai-h">
      <div class="card-head"><h2 id="as-ai-h">${icon("sparkle")} ${t("coll.ai.title")}</h2><span class="badge ai" id="ai-engine">…</span></div>
      <div class="card-body stack" id="as-ai"><p class="small muted">${t("coll.assist.ai_idle")}</p>
        <div><button type="button" class="btn ai" id="ai-suggest">${icon("sparkle")}${t("coll.ai.suggest")}</button></div>
        <div id="ai-list" aria-live="polite"></div></div></section>
    <p class="small muted assist-keys">${t("coll.edit.keys_hint")}</p>`;
}

function suggestionRow(s, i, kind) {
  return html`<li class="suggest" data-kind="${kind}" data-i="${i}">
    <div class="sug-body"><span class="sug-label">${s.label}</span><span class="sug-value">${s.shown}</span>
      ${s.current ? html`<span class="sug-current">${t("coll.ai.replaces", { value: s.current })}</span>` : ""}</div>
    <div class="sug-actions"><button type="button" class="btn sm" data-accept aria-label="${t("coll.ai.accept_named", { value: `${s.label}: ${s.shown}` })}">${icon("check")}<span>${t("coll.ai.accept")}</span></button>
      <button type="button" class="btn sm ghost icon-only" data-dismiss aria-label="${t("coll.ai.dismiss_named", { value: `${s.label}: ${s.shown}` })}" data-tip="${t("coll.ai.dismiss")}">${icon("x")}</button></div></li>`;
}

const FIELD_LABEL = { title: "title", subtitle: "subtitle", authors: "authors", publisher: "publisher", pub_year: "year", edition: "edition",
  pages: "pages", language: "language", material_type: "format", subjects: "subjects", description: "description", classification: "classification",
  series: "series", cover_url: "cover_url", isbn: "isbn", audience: "audience" };
const shown = (k, v) => (Array.isArray(v) ? v.join("; ") : k === "language" ? langName(v) : k === "material_type" ? fmtLabel(v) : k === "audience" ? audienceLabel(v) : String(v));

async function lookupIsbn(btn) {
  const input = S.form.elements.isbn;
  const isbn = digits(input.value);
  if (!isbn) { setFieldError(input, t("coll.edit.isbn_first")); input.focus(); return; }
  if (!isbnValid(isbn)) { setFieldError(input, t("coll.edit.isbn_invalid")); input.focus(); return; }
  setFieldError(input, "");
  const box = $("#as-isbn");
  box.innerHTML = html`<div class="skeleton sk-line w-70"></div><div class="skeleton sk-line w-50"></div>`;
  let r;
  try { r = await withBusy(btn, () => api(`/cataloging/isbn/${encodeURIComponent(isbn)}`)); } catch (e) { box.innerHTML = alertBox(e.message); return; }
  if (r.isbn !== input.value) setValue("isbn", r.isbn);
  const existing = r.existing_biblio_id && r.existing_biblio_id !== S.id
    ? alertBox(html`${t("coll.assist.isbn_exists")} <a href="/staff/catalog/${r.existing_biblio_id}">${t("coll.assist.open_record", { no: recNo(r.existing_biblio_id) })}</a>`, "warn") : "";
  const copycat = html`<a class="btn sm" href="/staff/copycat?${qs({ kind: "isbn", q: r.isbn })}">${icon("download")}${t("coll.assist.try_copycat")}</a>`;
  if (!r.found) { box.innerHTML = html`${existing}<p class="small">${t("coll.assist.isbn_not_found")}</p>${copycat}`; return; }
  const cur = payload(S.form);
  const rows = Object.entries(r.record).filter(([k, v]) => FIELD_LABEL[k] && k !== "isbn" && v !== null && v !== "" && !(Array.isArray(v) && !v.length))
    .filter(([k, v]) => shown(k, v) !== shown(k, cur[k] ?? ""))
    .map(([k, v]) => ({ field: k, value: v, label: t(`coll.field.${FIELD_LABEL[k]}`), shown: shown(k, v), current: cur[k] && !(Array.isArray(cur[k]) && !cur[k].length) ? shown(k, cur[k]) : "" }));
  S.lookup = rows;
  box.innerHTML = html`${existing}<p class="small">${icon("check-circle")} ${t("coll.assist.isbn_found", { source: !r.record.source || r.record.source === "openlibrary" ? "Open Library" : r.record.source })}</p>
    ${rows.length ? html`<ul class="suggest-list" role="list">${rows.map((s, i) => suggestionRow(s, i, "lookup"))}</ul>
      <div class="row between assist-foot">${copycat}<button type="button" class="btn sm" data-accept-empty>${icon("check")}${t("coll.assist.fill_empty")}</button></div>`
      : html`<p class="small muted">${t("coll.assist.isbn_same")}</p>${copycat}`}`;
}

async function aiSuggest(btn) {
  const p = payload(S.form);
  if (!p.title) { setFieldError(S.form.elements.title, t("coll.edit.title_first")); S.form.elements.title.focus(); return; }
  const list = $("#ai-list");
  let s;
  try {
    s = await withBusy(btn, () => api("/ai/catalog-assist", { method: "POST", body: {
      id: S.id, title: p.title, subtitle: p.subtitle, authors: p.authors, description: p.description, subjects: p.subjects,
      publisher: p.publisher, pub_year: p.pub_year, isbn: p.isbn } }));
  } catch { return; }
  const have = p.subjects.map((x) => x.toLowerCase());
  const rows = [
    ...(s.subjects || []).filter((x) => !have.includes(x.toLowerCase())).map((x) => ({ field: "subjects", value: x, label: t("coll.field.subject"), shown: x })),
    s.classification && s.classification !== p.classification ? { field: "classification", value: s.classification, label: t("coll.field.classification"),
      shown: `${s.classification}${s.classification_label ? ` · ${s.classification_label}` : ""}`, current: p.classification || "" } : null,
    s.audience && s.audience !== p.audience ? { field: "audience", value: s.audience, label: t("coll.field.audience"), shown: audienceLabel(s.audience), current: p.audience ? audienceLabel(p.audience) : "" } : null,
    s.summary && s.summary !== p.description ? { field: "description", value: s.summary, label: t("coll.field.description"), shown: s.summary, current: p.description ? t("coll.assist.current_description") : "" } : null,
  ].filter(Boolean);
  S.ai = rows;
  list.innerHTML = rows.length ? html`<ul class="suggest-list" role="list">${rows.map((r, i) => suggestionRow(r, i, "ai"))}</ul>
      <p class="tiny muted">${t("coll.ai.engine", { engine: s.engine === "claude" ? "Claude" : t("coll.ai.local_engine") })}</p>`
    : html`<p class="small muted">${t("coll.ai.nothing")}</p>`;
}

function accept(kind, i) {
  const s = (kind === "ai" ? S.ai : S.lookup)[i];
  if (!s || s.done) return;
  if (s.field === "authors" || s.field === "subjects") {
    const vals = Array.isArray(s.value) ? s.value : [s.value];
    vals.forEach((v) => S.chips[s.field].add(v));
  } else setValue(s.field, s.value);
  if (kind === "ai") S.form.dataset.aiUsed = "1";
  s.done = true;
  const li = $(`.suggest[data-kind="${kind}"][data-i="${i}"]`);
  if (li) { li.classList.add("accepted"); $(".sug-actions", li).innerHTML = html`<span class="badge pill success">${icon("check")}${t("coll.ai.applied")}</span>`; }
}

// --- live duplicate check
const checkDupes = debounce(async () => {
  const p = payload(S.form);
  const box = $("#as-dupes");
  if ((p.title || "").length < 3 && !p.isbn) { box.innerHTML = html`<p class="small muted">${t("coll.assist.dupes_idle")}</p>`; return; }
  try {
    const r = await api("/cataloging/duplicates", { method: "POST", body: { title: p.title || null, isbn: p.isbn, authors: p.authors, exclude_id: S.id } });
    S.dupes = r.results;
    box.innerHTML = r.results.length ? html`${alertBox(t("coll.assist.dupes_found", { count: r.results.length }), "warn")}
      <ul class="dupe-mini" role="list">${r.results.slice(0, 4).map((d) => html`<li><a href="/staff/catalog/${d.id}" target="_blank" rel="noopener">${d.title}</a>
        <span class="small muted">${[d.authors[0], d.pub_year, recNo(d.id)].filter(Boolean).join(" · ")}</span>
        <span class="dupe-reasons">${d.reasons.map((x) => html`<span class="badge pill ${x === "isbn" ? "warning" : "info"}">${t(`coll.dupes.reason_${x}`)}</span>`)}</span></li>`)}</ul>
      <p class="tiny muted">${t("coll.assist.dupes_hint")}</p>`
      : html`<p class="small">${icon("check-circle")} ${t("coll.assist.dupes_none")}</p>`;
  } catch { /* the check is advisory */ }
}, 600);

// ------------------------------------------------------------------ init

export default async function init() {
  const page = $(".coll-edit");
  S.id = page.dataset.editing ? +page.dataset.editing : null;
  let controlled = [];
  try {
    const jobs = [api("/lookups"), S.id ? api(`/biblios/${S.id}`) : null, S.id ? api(`/biblios/${S.id}/authorities`).catch(() => ({ results: [] })) : null];
    const [lk, b, links] = await Promise.all(jobs);
    S.lk = lk; S.b = b || {};
    controlled = (links?.results || []).map((l) => l.heading);
  } catch (e) {
    $("#edit-form-slot").innerHTML = alertBox(e.message);
    $("#assistant").innerHTML = "";
    return;
  }
  if (S.id) {
    $("#edit-sub").textContent = t("coll.edit.editing", { title: S.b.title, no: recNo(S.id) });
    const cr = $("#crumb-record");
    if (cr) cr.textContent = S.b.title;
    document.title = `${t("nav.detail.record_edit")} · ${S.b.title}`;
  } else {
    const isbn = new URLSearchParams(location.search).get("isbn");
    if (isbn) S.b.isbn = isbn;
  }
  $("#edit-form-slot").innerHTML = formHtml(S.b, controlled);
  $("#assistant").innerHTML = assistantHtml();
  S.form = $("#rec-form");
  S.chips.authors = wireChipField($('[data-chip-field="authors"]', S.form), { group: "authors", onChange: checkDupes });
  S.chips.subjects = wireChipField($('[data-chip-field="subjects"]', S.form), { group: "subjects" });
  api("/ai/status").then((s) => { $("#ai-engine").textContent = s.claude ? "Claude" : t("coll.ai.local_short"); }).catch(() => { $("#ai-engine").textContent = "—"; });

  S.form.addEventListener("click", (e) => { const b = e.target.closest("[data-next]"); if (b) S.next = b.dataset.next; });
  S.f = enhanceForm(S.form, {
    validate: {
      isbn: (v) => isbnValid(v) || t("coll.edit.isbn_invalid"),
      pub_year: (v) => !v || (+v >= 0 && +v <= new Date().getFullYear() + 2) || t("coll.edit.year_invalid"),
      cover_url: (v) => !v || /^https?:\/\//i.test(v) || t("coll.edit.cover_invalid"),
    },
    onSubmit: async () => {
      const body = payload(S.form);
      if (S.form.dataset.aiUsed && S.id) body.ai_enriched = true;
      const saved = S.id ? await api(`/biblios/${S.id}`, { method: "PATCH", body }) : await api("/biblios", { method: "POST", body });
      S.f.markClean();
      toast(t(S.id ? "coll.edit.saved" : "coll.edit.created"), "success");
      location.href = S.next === "items" ? `/staff/catalog/${saved.id}?add=1#items` : `/staff/catalog/${saved.id}`;
    },
  });
  // Barcode scanners send Enter after the ISBN: look it up instead of submitting the form.
  S.form.elements.isbn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#isbn-lookup").click(); } });
  $("#isbn-lookup").addEventListener("click", (e) => lookupIsbn(e.currentTarget));
  S.form.addEventListener("input", (e) => { if (["title", "isbn"].includes(e.target.name)) checkDupes(); });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !document.querySelector("dialog[open]")) {
      e.preventDefault();
      S.next = "record";
      S.form.requestSubmit($('[data-next="record"]', S.form));
    }
  });
  const assist = $("#assistant");
  assist.addEventListener("click", (e) => {
    if (e.target.closest("#ai-suggest")) { aiSuggest(e.target.closest("#ai-suggest")); return; }
    const li = e.target.closest(".suggest");
    if (li && e.target.closest("[data-accept]")) { accept(li.dataset.kind, +li.dataset.i); return; }
    if (li && e.target.closest("[data-dismiss]")) {
      const next = li.nextElementSibling || li.previousElementSibling;
      li.remove();
      ($("[data-accept]", next || assist) || $("#ai-suggest"))?.focus();
      return;
    }
    if (e.target.closest("[data-accept-empty]")) {
      (S.lookup || []).forEach((s, i) => { if (!s.current) accept("lookup", i); });
      toast(t("coll.assist.filled"), "success");
    }
  });
  if (S.b.isbn && !S.id) $("#isbn-lookup").click();
  if (S.id) checkDupes();
  (S.id ? S.form.elements.title : S.form.elements.isbn).focus();
}
