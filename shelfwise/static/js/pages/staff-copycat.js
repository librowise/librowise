// Staff: copy cataloguing — search remote SRU catalogues (Library of Congress…) and import MARC records.
import { $, api, badge, confirmDialog, empty, html, icon, num, qs, skeleton, toast, withBusy } from "/static/js/core.js";

const PLACEHOLDERS = {
  title: "e.g. The Hobbit",
  isbn: "e.g. 9780261103344",
  author: "e.g. Tolkien, J. R. R.",
  cql: 'e.g. dc.title="hobbit" and dc.creator=tolkien',
};
const state = { results: [], targetId: null, start: 1 };

const authorsText = (list) => (list || []).join("; ");

function marcView(fields) {
  return html`<pre class="cc-marc">${fields.map((f) => html`<span class="cc-tag">${f.tag}</span> ${f.ind ? html`<span class="cc-ind">${f.ind}</span> ` : ""}${f.value}
`)}</pre>`;
}

function resultCard(r, i) {
  const meta = [r.publisher, r.pub_year, r.edition].filter(Boolean).join(" · ");
  const ids = [r.isbn && `ISBN ${r.isbn}`, r.lccn && `LCCN ${r.lccn}`, r.classification && `DDC ${r.classification}`].filter(Boolean);
  return html`<article class="card pad cc-result" aria-labelledby="cc-t-${i}">
    <div class="row between" style="align-items:flex-start">
      <div class="grow stack tight">
        <h2 class="cc-title" id="cc-t-${i}">${r.title}${r.subtitle ? html`<span class="muted">: ${r.subtitle}</span>` : ""}</h2>
        ${r.authors.length ? html`<div class="small">${authorsText(r.authors)}</div>` : ""}
        ${meta ? html`<div class="small muted">${meta}${r.pages ? ` · ${r.pages} pages` : ""}</div>` : ""}
        ${ids.length ? html`<div class="tiny muted mono">${ids.join(" · ")}</div>` : ""}
        ${r.subjects.length ? html`<div class="row tight">${r.subjects.slice(0, 4).map((s) => html`<span class="badge">${s}</span>`)}</div>` : ""}
      </div>
      <div class="row tight cc-actions" data-actions="${i}">
        ${r.existing_biblio_id ? html`<a class="btn sm" href="/staff/catalog/${r.existing_biblio_id}">${badge("ok", "Already catalogued")}<span>Open</span></a>` : ""}
        <button class="btn sm ${r.existing_biblio_id ? "" : "primary"}" data-import="${i}">${icon("download")}${r.existing_biblio_id ? "Import copy" : "Import"}</button>
      </div>
    </div>
    <details class="cc-details"><summary>MARC record · ${num(r.fields.length)} fields</summary>${marcView(r.fields)}</details>
  </article>`;
}

function renderPager(total, start, per) {
  const pager = $("#cc-pager");
  pager.innerHTML = "";
  if (total <= per) return;
  const page = Math.floor((start - 1) / per) + 1;
  const pages = Math.ceil(Math.min(total, 1000) / per);
  pager.innerHTML = html`<button class="btn sm" data-page="${start - per}" ${start <= 1 ? "disabled" : ""}>Previous</button>
    <span class="muted small">Page ${page} of ${num(pages)}</span>
    <button class="btn sm" data-page="${start + per}" ${page >= pages ? "disabled" : ""}>Next</button>`;
}

async function search(start = 1) {
  const form = $("#cc-form");
  const q = $("#cc-q").value.trim();
  if (!q) { $("#cc-q").focus(); toast("Enter something to search for", "error"); return; }
  const params = { target_id: $("#cc-target").value, kind: $("#cc-kind").value, q, max: $("#cc-max").value };
  history.replaceState(null, "", `?${qs({ ...params, start: start > 1 ? start : undefined })}`);
  state.targetId = Number(params.target_id);
  state.start = start;
  const results = $("#cc-results");
  results.setAttribute("aria-busy", "true");
  results.innerHTML = `<div class="card pad">${skeleton(6)}</div>`;
  $("#cc-summary").textContent = "Searching…";
  try {
    const r = await withBusy($("#cc-go", form), () => api(`/copycat/search?${qs({ ...params, start })}`));
    state.results = r.results;
    const shown = r.results.length ? `${num(start)}–${num(start + r.results.length - 1)} of ` : "";
    $("#cc-summary").textContent = `${shown}${num(r.total)} records at ${r.target.name} · query: ${r.query}`;
    results.innerHTML = r.results.length ? html`${r.results.map(resultCard)}`
      : empty("No records found. Try fewer words, the ISBN, or another catalogue.", "search");
    renderPager(r.total, start, Number(params.max));
  } catch (e) {
    state.results = [];
    $("#cc-summary").textContent = "";
    results.innerHTML = empty(e.message, "alert");
    $("#cc-pager").innerHTML = "";
  } finally {
    results.removeAttribute("aria-busy");
  }
}

async function importRecord(i, btn) {
  const r = state.results[i];
  if (!r) return;
  let allowDuplicate = false;
  if (r.existing_biblio_id) {
    if (!(await confirmDialog("Import a duplicate?", "A record with this ISBN is already in the catalogue. Import another bibliographic record anyway?", "Import anyway", false))) return;
    allowDuplicate = true;
  }
  try {
    const b = await withBusy(btn, () => api("/copycat/import", {
      method: "POST", body: { marcxml: r.marcxml, target_id: state.targetId, allow_duplicate: allowDuplicate },
    }));
    r.existing_biblio_id = b.id;
    $(`[data-actions="${i}"]`).innerHTML = html`${badge("ok", "Imported")}
      <a class="btn sm primary" href="/staff/catalog/${b.id}">${icon("arrow-right")}Open record &amp; add items</a>`;
    toast(`Imported “${b.title}”`, "success");
  } catch (e) {
    if (e.data?.existing_biblio_id) {
      $(`[data-actions="${i}"]`).insertAdjacentHTML("afterbegin",
        html`<a class="btn sm" href="/staff/catalog/${e.data.existing_biblio_id}">${badge("ok", "Already catalogued")}<span>Open</span></a>`);
    }
  }
}

export default async function init() {
  const form = $("#cc-form");
  let targets = [];
  try {
    targets = (await api("/copycat/targets")).results.filter((t) => t.enabled);
  } catch (e) {
    $("#cc-results").innerHTML = empty(e.status === 403 ? "Copy cataloguing needs cataloguing permission." : e.message, "alert");
    form.querySelectorAll("input,select,button").forEach((el) => { el.disabled = true; });
    return;
  }
  if (!targets.length) {
    $("#cc-results").innerHTML = empty("No copy-cataloguing targets are enabled. An administrator can add one under Interoperability → Copy-cataloguing targets.", "globe");
    form.querySelectorAll("input,select,button").forEach((el) => { el.disabled = true; });
    return;
  }
  $("#cc-target").innerHTML = html`${targets.map((t) => html`<option value="${t.id}">${t.name}</option>`)}`;

  const params = new URLSearchParams(location.search);
  for (const k of ["target_id", "kind", "q", "max"]) {
    const el = form.elements[k];
    if (el && params.has(k) && [...(el.options || [{ value: params.get(k) }])].some((o) => o.value === params.get(k))) el.value = params.get(k);
  }
  const kind = $("#cc-kind");
  const syncPlaceholder = () => { $("#cc-q").placeholder = PLACEHOLDERS[kind.value] || ""; $("#cc-q").inputMode = kind.value === "isbn" ? "numeric" : "text"; };
  kind.addEventListener("change", syncPlaceholder);
  syncPlaceholder();

  form.addEventListener("submit", (e) => { e.preventDefault(); search(1); });
  $("#cc-pager").addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]");
    if (b && !b.disabled) { search(Math.max(1, Number(b.dataset.page))); $("#cc-summary").scrollIntoView({ block: "start" }); }
  });
  $("#cc-results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-import]");
    if (b) importRecord(Number(b.dataset.import), b);
  });
  if (params.get("q")) search(Math.max(1, Number(params.get("start")) || 1));
  else $("#cc-results").innerHTML = empty("Search by title, ISBN or author to find a record to copy.", "search");
}
