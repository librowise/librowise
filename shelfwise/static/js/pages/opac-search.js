import { $, $$, api, authors, availabilityBadge, cover, empty, html, icon, num, qs, skeleton, toast } from "/static/js/core.js";
import { wireSearchMode } from "/static/js/pages/opac-home.js";

const FACET_LABELS = { material_type: "Format", language: "Language", subject: "Subject", author: "Author", decade: "Decade" };
const LANG = { en: "English", hi: "Hindi", bn: "Bengali", fr: "French", es: "Spanish", de: "German", ta: "Tamil", ur: "Urdu" };
const FORMAT = { book: "Book", ebook: "E-book", audiobook: "Audiobook", dvd: "DVD", serial: "Magazine", comic: "Graphic novel" };
const FILTER_KEYS = ["material_type", "language", "subject", "author", "audience", "year_from", "year_to", "available_only"];

const label = (facet, v) => facet === "language" ? (LANG[v] || v) : facet === "material_type" ? (FORMAT[v] || v) : v;

function state() {
  const p = new URLSearchParams(location.search);
  const s = { q: p.get("q") || "", mode: p.get("mode") || "keyword", page: +(p.get("page") || 1), sort: p.get("sort") || "relevance" };
  for (const k of FILTER_KEYS) if (p.get(k)) s[k] = p.get(k);
  return s;
}
const go = (s) => { location.search = qs({ ...s, page: s.page > 1 ? s.page : undefined }); };

function resultRow(b) {
  return html`<article class="result">
    <a href="/record/${b.id}" tabindex="-1" aria-hidden="true">${cover(b)}</a>
    <div class="grow stack tight">
      <h3><a href="/record/${b.id}">${b.title}</a>${b.subtitle ? html`<span class="muted" style="font-weight:400">: ${b.subtitle}</span>` : ""}</h3>
      <div class="meta">${authors(b.authors) || "Unknown author"}${b.pub_year ? ` · ${b.pub_year}` : ""} · ${FORMAT[b.material_type] || b.material_type}${b.language !== "en" ? ` · ${LANG[b.language] || b.language}` : ""}</div>
      <div class="row tight">${(b.subjects || []).slice(0, 3).map((s) => html`<a class="chip small" href="/search?${qs({ subject: s })}">${s.split(" -- ")[0]}</a>`)}</div>
      <div class="row tight">${availabilityBadge(b.availability)}${b.classification ? html`<span class="badge mono">${b.classification}</span>` : ""}</div>
    </div></article>`;
}

function facetsPanel(facets, s) {
  return html`${Object.entries(facets || {}).filter(([, v]) => v.length).map(([key, values]) => {
    const fkey = key === "decade" ? "year_from" : key;
    return html`<div class="facet"><h4>${FACET_LABELS[key] || key}</h4>${values.slice(0, 8).map(([v, n]) => {
      const val = key === "decade" ? String(parseInt(v, 10)) : v;
      const pressed = s[fkey] === val;
      return html`<button data-facet="${fkey}" data-value="${val}" data-decade="${key === "decade" ? "1" : ""}" aria-pressed="${pressed}">
        <span>${label(key, v)}</span><span class="n">${num(n)}</span></button>`;
    })}</div>`;
  })}`;
}

export default async function init() {
  const s = state();
  const form = $("#search-form");
  wireSearchMode(form);
  $$("[data-mode]", form).forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === s.mode));
  $("[name=mode]", form).value = s.mode;
  $("#sort").value = s.sort;
  $("#available-only").checked = s.available_only === "true";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    go({ q: $("#q").value.trim(), mode: $("[name=mode]", form).value, sort: s.sort !== "relevance" ? s.sort : undefined });
  });
  $("#sort").addEventListener("change", (e) => go({ ...s, sort: e.target.value, page: 1 }));
  $("#available-only").addEventListener("change", (e) => go({ ...s, available_only: e.target.checked ? "true" : undefined, page: 1 }));

  $("#results").innerHTML = `<div style="padding:1rem">${skeleton(6)}</div>`;
  try {
    let data;
    if (s.mode === "smart" && s.q) {
      data = await api(`/search/smart?${qs({ q: s.q, page: s.page })}`);
      const p = data.parsed;
      $("#interpretation").innerHTML = html`<div class="interpretation">${icon("sparkle")}
        <strong>${p.engine === "claude" ? "Claude" : "AI"} understood:</strong>
        ${p.keywords ? html`<span class="badge ai">topic: ${p.keywords}</span>` : ""}
        ${(p.interpretation || []).map((i) => html`<span class="badge ai">${i}</span>`)}
        <a class="small" style="margin-left:auto" href="/search?${qs({ q: s.q })}">Use keyword search instead</a></div>`;
      // Facets in AI mode switch to keyword search carrying the understood filters
      $("#facets").dataset.base = JSON.stringify({ q: p.keywords, material_type: p.material_type, language: p.language,
        audience: p.audience, year_from: p.year_from, year_to: p.year_to, author: p.author, available_only: p.available_only || undefined });
    } else {
      const params = { q: s.q, page: s.page, sort: s.q ? s.sort : (s.sort === "relevance" ? "newest" : s.sort) };
      for (const k of FILTER_KEYS) if (s[k]) params[k] = s[k];
      data = await api(`/search?${qs(params)}`);
    }
    const pages = Math.ceil(data.total / 20);
    $("#summary").textContent = `${num(data.total)} result${data.total === 1 ? "" : "s"}${s.q ? ` for “${s.q}”` : ""}${data.took_ms !== undefined ? ` · ${data.took_ms} ms` : ""}`;
    $("#results").innerHTML = data.results.length ? html`${data.results.map(resultRow)}`
      : empty(s.mode === "smart" ? "Nothing matched that description. Try fewer constraints or keyword search." : "No results. Check the spelling or try AI search.", "search");
    $("#facets").innerHTML = facetsPanel(data.facets, s);
    $("#pager").innerHTML = pages > 1 ? html`
      <button class="btn sm" data-page="${s.page - 1}" ${s.page <= 1 ? "disabled" : ""}>Previous</button>
      <span class="muted small">Page ${s.page} of ${pages}</span>
      <button class="btn sm" data-page="${s.page + 1}" ${s.page >= pages ? "disabled" : ""}>Next</button>` : "";
  } catch (e) {
    $("#results").innerHTML = empty(e.message, "alert");
    toast(e.message, "error");
  }

  $("#facets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-facet]");
    if (!b) return;
    const base = $("#facets").dataset.base ? JSON.parse($("#facets").dataset.base) : { ...s };
    const next = { ...base, mode: "keyword", page: 1, sort: s.sort };
    const pressed = b.getAttribute("aria-pressed") === "true";
    next[b.dataset.facet] = pressed ? undefined : b.dataset.value;
    if (b.dataset.decade) next.year_to = pressed ? undefined : String(+b.dataset.value + 9);
    go(next);
  });
  $("#pager").addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]");
    if (b && !b.disabled) go({ ...s, page: +b.dataset.page });
  });
}
