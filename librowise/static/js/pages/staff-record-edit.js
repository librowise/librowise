import { $, BOOT, api, debounce, html, icon, toast, withBusy } from "/static/js/core.js";

const FORMAT = { book: "Book", ebook: "E-book", audiobook: "Audiobook", dvd: "DVD", serial: "Magazine", comic: "Graphic novel" };
const split = (s) => (s || "").split(";").map((x) => x.trim()).filter(Boolean);
const editingId = () => (BOOT.path_params.biblio_id ? +BOOT.path_params.biblio_id : null);

function fill(form, data) {
  for (const [k, v] of Object.entries(data)) {
    const el = form.elements[k];
    if (!el || v === null || v === undefined) continue;
    el.value = Array.isArray(v) ? v.join("; ") : v;
  }
}

function payload(form) {
  const f = form.elements;
  const num = (v) => (v === "" ? null : Number(v));
  const out = {
    title: f.title.value.trim(), subtitle: f.subtitle.value.trim() || null, authors: split(f.authors.value),
    isbn: f.isbn.value.trim() || null, publisher: f.publisher.value.trim() || null, pub_year: num(f.pub_year.value),
    edition: f.edition.value.trim() || null, pages: num(f.pages.value), material_type: f.material_type.value,
    language: f.language.value.trim() || "en", audience: f.audience.value || null,
    classification: f.classification.value.trim() || null, series: f.series.value.trim() || null,
    cover_url: f.cover_url.value.trim() || null, subjects: split(f.subjects.value), description: f.description.value.trim() || null,
  };
  return out;
}

async function checkDuplicates(form) {
  const title = form.elements.title.value.trim();
  if (title.length < 4) { $("#dupes").innerHTML = ""; return; }
  const r = await api(`/search?q=${encodeURIComponent(title)}&per_page=3`).catch(() => null);
  const hits = (r?.results || []).filter((b) => b.id !== editingId());
  $("#dupes").innerHTML = hits.length ? html`<div class="alert warn">${icon("alert")}<div><strong>Possible duplicates:</strong>
    ${hits.map((b, i) => html`${i ? ", " : " "}<a href="/staff/catalog/${b.id}" target="_blank">${b.title}${b.pub_year ? ` (${b.pub_year})` : ""}</a>`)}.
    Consider adding an item to the existing record instead.</div></div>` : "";
}

export default async function init() {
  const form = $("#rec-form");
  const lk = await api("/lookups");
  form.elements.material_type.innerHTML = html`${lk.material_types.map((m) => html`<option value="${m}">${FORMAT[m] || m}</option>`)}`;
  api("/ai/status").then((s) => { $("#ai-engine").textContent = s.claude ? "Claude" : "Local AI"; }).catch(() => {});

  const id = editingId();
  if (id) {
    const b = await api(`/biblios/${id}`);
    fill(form, b);
    $("#heading").textContent = "Edit record";
    $("#crumb").innerHTML = html`<a href="/staff/catalog/${id}">${b.title}</a> / Edit`;
    $("#cancel").href = `/staff/catalog/${id}`;
  }

  form.elements.title.addEventListener("input", debounce(() => checkDuplicates(form), 500));

  // Barcode scanners send Enter after the ISBN: fetch metadata instead of submitting the whole form.
  form.elements.isbn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#isbn-lookup").click(); }
  });
  $("#isbn-lookup").addEventListener("click", async (e) => {
    const isbn = form.elements.isbn.value.trim();
    if (!isbn) { toast("Enter an ISBN first", "error"); return; }
    try {
      const r = await withBusy(e.currentTarget, () => api(`/cataloging/isbn/${encodeURIComponent(isbn)}`));
      form.elements.isbn.value = r.isbn;
      if (r.existing_biblio_id && r.existing_biblio_id !== id) {
        $("#isbn-hint").innerHTML = html`<span style="color:var(--warning)">Already in the catalogue: <a href="/staff/catalog/${r.existing_biblio_id}">open record #${r.existing_biblio_id}</a></span>`;
      }
      if (!r.found) { toast("No metadata found online — please catalogue manually.", "info"); return; }
      const rec = { ...r.record };
      for (const k of Object.keys(rec)) if (form.elements[k]?.value && k !== "isbn") delete rec[k]; // never overwrite typed data
      fill(form, rec);
      toast("Metadata imported from Open Library", "success");
      checkDuplicates(form);
    } catch { /* toasted */ }
  });

  $("#suggest").addEventListener("click", async (e) => {
    const p = payload(form);
    if (!p.title) { toast("Add a title first", "error"); return; }
    try {
      const s = await withBusy(e.currentTarget, () => api("/ai/catalog-assist", { method: "POST", body: {
        id, title: p.title, subtitle: p.subtitle, authors: p.authors, description: p.description, subjects: p.subjects,
        publisher: p.publisher, pub_year: p.pub_year, isbn: p.isbn } }));
      const current = split(form.elements.subjects.value).map((x) => x.toLowerCase());
      const subj = (s.subjects || []).filter((x) => !current.includes(x.toLowerCase()));
      $("#suggestions").innerHTML = html`<div class="stack tight">
        ${subj.length ? html`<div><strong class="small">Subjects</strong> <span class="tiny muted">(click to add)</span><div class="row tight">${subj.map((x) => html`<button type="button" class="chip" data-add-subject="${x}">+ ${x}</button>`)}</div></div>` : ""}
        ${s.classification ? html`<div class="kv"><span>Dewey <span class="mono">${s.classification}</span> ${s.classification_label || ""}</span><button type="button" class="btn sm" data-set="classification" data-value="${s.classification}">Use</button></div>` : ""}
        ${s.audience ? html`<div class="kv"><span>Audience: ${s.audience.replace("_", " ")}</span><button type="button" class="btn sm" data-set="audience" data-value="${s.audience}">Use</button></div>` : ""}
        ${s.summary ? html`<div class="kv" style="flex-direction:column;gap:.3rem"><span class="small">${s.summary}</span><button type="button" class="btn sm" data-set="description" data-value="${s.summary}">Use as description</button></div>` : ""}
        <span class="tiny muted">Engine: ${s.engine === "claude" ? "Claude" : "Local AI (nearest-neighbour subjects + rules)"}</span></div>`;
    } catch { /* toasted */ }
  });
  $("#suggestions").addEventListener("click", (e) => {
    const add = e.target.closest("[data-add-subject]");
    if (add) {
      const cur = split(form.elements.subjects.value);
      form.elements.subjects.value = [...cur, add.dataset.addSubject].join("; ");
      add.remove();
      form.dataset.aiUsed = "1";
    }
    const set = e.target.closest("[data-set]");
    if (set) { form.elements[set.dataset.set].value = set.dataset.value; set.textContent = "Applied"; set.disabled = true; form.dataset.aiUsed = "1"; }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = payload(form);
    if (!body.title) { form.elements.title.focus(); toast("Title is required", "error"); return; }
    if (form.dataset.aiUsed) body.ai_enriched = true;
    try {
      const saved = await withBusy($("#save"), () => id
        ? api(`/biblios/${id}`, { method: "PATCH", body })
        : api("/biblios", { method: "POST", body: Object.fromEntries(Object.entries(body).filter(([k]) => k !== "ai_enriched")) }));
      toast("Record saved", "success");
      location.href = `/staff/catalog/${saved.id}`;
    } catch { /* toasted */ }
  });
}
