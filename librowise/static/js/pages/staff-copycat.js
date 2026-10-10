// Staff › Catalogue › Copy cataloguing — search remote SRU catalogues (Library of Congress…), check the MARC record
// and import it in one step. Records already in the catalogue (same ISBN) are flagged before importing.
import { $, $$, api, confirmDialog, html, icon, num, qs, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { pagination, wirePagination } from "/static/js/ui/pagination.js";
import { recNo } from "/static/js/pages/lib/collection.js";

const PLACEHOLDER = { title: "coll.cc.ph_title", isbn: "coll.cc.ph_isbn", author: "coll.cc.ph_author", cql: "coll.cc.ph_cql" };
const state = { results: [], targetId: null, start: 1, per: 10, total: 0 };
const form = () => $("#cc-form");
const kind = () => form().elements.kind.value;

const marcView = (fields) => html`<pre class="cc-marc" tabindex="0">${fields.map((f) => html`<span class="cc-tag">${f.tag}</span> ${f.ind ? html`<span class="cc-ind">${f.ind}</span> ` : ""}${f.value}
`)}</pre>`;

function actionsHtml(r, i) {
  if (r.imported) return html`<span class="badge pill success"><span class="dot" aria-hidden="true"></span>${t("coll.cc.imported")}</span>
    <a class="btn sm primary" href="/staff/catalog/${r.imported}?add=1#items">${icon("plus")}${t("coll.cc.open_add_items")}</a>`;
  return html`${r.existing_biblio_id ? html`<a class="btn sm" href="/staff/catalog/${r.existing_biblio_id}">${icon("book")}${t("coll.cc.open_existing", { no: recNo(r.existing_biblio_id) })}</a>` : ""}
    <button type="button" class="btn sm ${r.existing_biblio_id ? "" : "primary"}" data-import="${i}">${icon("download")}${r.existing_biblio_id ? t("coll.cc.import_anyway") : t("coll.cc.import")}</button>`;
}

function resultCard(r, i) {
  const meta = [r.publisher, r.pub_year, r.edition, r.pages ? t("coll.cc.pages", { n: num(r.pages) }) : ""].filter(Boolean).join(" · ");
  const ids = [r.isbn && `ISBN ${r.isbn}`, r.lccn && `LCCN ${r.lccn}`, r.classification && `DDC ${r.classification}`].filter(Boolean);
  return html`<article class="card cc-result" aria-labelledby="cc-t-${i}">
    <div class="cc-main">
      <h2 class="cc-title" id="cc-t-${i}">${r.title}${r.subtitle ? html`<span class="cc-sub">: ${r.subtitle}</span>` : ""}</h2>
      ${r.authors.length ? html`<p class="cc-authors">${r.authors.join("; ")}</p>` : ""}
      ${meta ? html`<p class="small muted">${meta}</p>` : ""}
      ${ids.length ? html`<p class="small mono cc-ids">${ids.join(" · ")}</p>` : ""}
      ${r.subjects.length ? html`<ul class="tag-list" role="list">${r.subjects.slice(0, 5).map((s) => html`<li><span class="tag static">${s}</span></li>`)}</ul>` : ""}
      ${r.existing_biblio_id && !r.imported ? html`<p class="cc-dupe">${icon("alert")}${t("coll.cc.already")}</p>` : ""}
    </div>
    <div class="cc-actions" data-actions="${i}">${actionsHtml(r, i)}</div>
    <details class="cc-details"><summary>${t("coll.cc.marc_preview", { count: r.fields.length, n: num(r.fields.length) })}</summary>${marcView(r.fields)}</details>
  </article>`;
}

async function search(start = 1) {
  const q = $("#cc-q").value.trim();
  if (!q) { $("#cc-q").focus(); $("#cc-summary").textContent = t("coll.cc.need_terms"); return; }
  const params = { target_id: $("#cc-target").value, kind: kind(), q, max: $("#cc-max").value };
  history.replaceState(null, "", `?${qs({ ...params, start: start > 1 ? start : undefined })}`);
  state.targetId = Number(params.target_id);
  state.start = start;
  state.per = Number(params.max);
  const box = $("#cc-results");
  box.setAttribute("aria-busy", "true");
  box.innerHTML = html`${Array.from({ length: 3 }, () => html`<div class="card cc-result cc-sk" aria-hidden="true"><div class="skeleton sk-line w-70"></div><div class="skeleton sk-line w-50"></div><div class="skeleton sk-line w-30"></div></div>`)}`;
  $("#cc-summary").textContent = t("coll.cc.searching");
  try {
    const r = await withBusy($("#cc-go"), () => api(`/copycat/search?${qs({ ...params, start })}`));
    state.results = r.results;
    state.total = r.total;
    $("#cc-summary").textContent = r.results.length
      ? t("coll.cc.summary", { from: num(start), to: num(start + r.results.length - 1), total: num(r.total), target: r.target.name })
      : t("coll.cc.summary_none", { target: r.target.name });
    box.innerHTML = r.results.length ? html`${r.results.map(resultCard)}`
      : emptyState({ art: "search", title: t("coll.cc.none_title"), body: t("coll.cc.none_body"), actions: html`<a class="btn" href="/staff/catalog/new">${icon("plus")}${t("ui.catalog.new")}</a>` });
    const page = Math.floor((start - 1) / state.per) + 1;
    $("#cc-pager").innerHTML = r.total > state.per ? pagination({ page, perPage: state.per, total: Math.min(r.total, 1000) }) : "";
  } catch (e) {
    state.results = [];
    $("#cc-summary").textContent = "";
    box.innerHTML = errorState(e, { retry: true });
    $("#cc-pager").innerHTML = "";
  } finally {
    box.removeAttribute("aria-busy");
  }
}

async function importRecord(i, btn) {
  const r = state.results[i];
  if (!r) return;
  let allowDuplicate = false;
  if (r.existing_biblio_id) {
    if (!(await confirmDialog(t("coll.cc.dup_title"), t("coll.cc.dup_text", { no: recNo(r.existing_biblio_id) }), t("coll.cc.import_anyway"), false))) return;
    allowDuplicate = true;
  }
  try {
    const b = await withBusy(btn, () => api("/copycat/import", { method: "POST", body: { marcxml: r.marcxml, target_id: state.targetId, allow_duplicate: allowDuplicate } }));
    r.imported = b.id;
    $(`[data-actions="${i}"]`).innerHTML = actionsHtml(r, i);
    $(`[data-actions="${i}"] a`)?.focus();
    toast(t("coll.cc.imported_toast", { title: b.title }), "success");
  } catch (e) {
    if (e.data?.existing_biblio_id) { r.existing_biblio_id = e.data.existing_biblio_id; $(`[data-actions="${i}"]`).innerHTML = actionsHtml(r, i); }
  }
}

export default async function init() {
  let targets = [];
  const disable = () => $$("input,select,button", form()).forEach((el) => { el.disabled = true; });
  try {
    targets = (await api("/copycat/targets")).results.filter((x) => x.enabled);
  } catch (e) {
    $("#cc-results").innerHTML = e.status === 403 ? emptyState({ art: "error", title: t("coll.cc.no_permission") }) : errorState(e, { retry: false });
    disable();
    return;
  }
  if (!targets.length) {
    $("#cc-results").innerHTML = emptyState({ art: "inbox", title: t("coll.cc.no_targets_title"), body: t("coll.cc.no_targets_body"),
      actions: html`<a class="btn primary" href="/staff/interop#targets">${icon("settings")}${t("coll.cc.targets")}</a>` });
    disable();
    return;
  }
  const sel = $("#cc-target");
  sel.innerHTML = html`${targets.map((x) => html`<option value="${x.id}">${x.name}</option>`)}`;
  sel.disabled = false;
  const params = new URLSearchParams(location.search);
  if (params.get("target_id") && targets.some((x) => String(x.id) === params.get("target_id"))) sel.value = params.get("target_id");
  if (params.get("kind")) { const radio = $(`input[name=kind][value="${CSS.escape(params.get("kind"))}"]`, form()); if (radio) radio.checked = true; }
  if (["10", "20", "50"].includes(params.get("max"))) $("#cc-max").value = params.get("max");
  if (params.get("q")) $("#cc-q").value = params.get("q");
  const sync = () => { $("#cc-q").placeholder = t(PLACEHOLDER[kind()]); $("#cc-q").inputMode = kind() === "isbn" ? "numeric" : "text"; };
  form().addEventListener("change", (e) => { if (e.target.name === "kind") { sync(); $("#cc-q").focus(); } });
  sync();
  form().addEventListener("submit", (e) => { e.preventDefault(); search(1); });
  wirePagination($("#cc-pager"), ({ page }) => { search((page - 1) * state.per + 1); $("#cc-summary").scrollIntoView({ block: "start" }); },
    () => ({ page: Math.floor((state.start - 1) / state.per) + 1, perPage: state.per, total: state.total }));
  $("#cc-results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-import]");
    if (b) importRecord(Number(b.dataset.import), b);
    if (e.target.closest("[data-retry]")) search(state.start);
  });
  if (params.get("q")) search(Math.max(1, Number(params.get("start")) || 1));
  else $("#cc-results").innerHTML = emptyState({ art: "search", title: t("coll.cc.start_title"), body: t("coll.cc.start_body") });
}
