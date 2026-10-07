// OPAC search results — migrated to the design system. Keeps every discovery feature: keyword and AI
// ("smart") modes, search-as-you-type suggestions, facets (collapsible groups with "show more"),
// did-you-mean, the AI interpretation banner, availability filter and sorting; adds removable filter
// chips, list/grid views (remembered), real covers via the cover service, skeleton loading, rich empty
// and error states and accessible pagination.
import { $, $$, api, authors, availabilityBadge, cover, html, icon, num, qs, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { wireSearchMode } from "/static/js/pages/opac-home.js";
import { attachSuggest, didYouMean } from "/static/js/suggest.js";
import { emptyState, errorState, skeletonList } from "/static/js/ui/empty.js";
import { activeFilters } from "/static/js/ui/filters.js";
import { pagination } from "/static/js/ui/pagination.js";
import { segmented, wireSegmented } from "/static/js/ui/tabs.js";

const FACETS = ["material_type", "language", "subject", "author", "decade"];
const LANGS = ["en", "hi", "bn", "fr", "es", "de", "ta", "ur"];
const FORMATS = ["book", "ebook", "audiobook", "dvd", "serial", "comic"];
const FILTER_KEYS = ["material_type", "language", "subject", "author", "audience", "year_from", "year_to", "available_only"];
const PER_PAGE = 20, SHOWN = 6;
const VIEW_KEY = "sw-opac-view";

const langName = (v) => (LANGS.includes(v) ? t(`lang.${v}`) : v);
const formatName = (v) => (FORMATS.includes(v) ? t(`format.${v}`) : v);
const label = (facet, v) => (facet === "language" ? langName(v) : facet === "material_type" ? formatName(v) : v);
const facetTitle = (key) => (FACETS.includes(key) ? t(`opac.search.facet_${key}`) : key);

function state() {
  const p = new URLSearchParams(location.search);
  const s = { q: p.get("q") || "", mode: p.get("mode") || "keyword", page: +(p.get("page") || 1), sort: p.get("sort") || "relevance" };
  for (const k of FILTER_KEYS) if (p.get(k)) s[k] = p.get(k);
  return s;
}
const go = (s) => { location.search = qs({ ...s, page: s.page > 1 ? s.page : undefined, sort: s.sort !== "relevance" ? s.sort : undefined }); };

function resultCard(b) {
  const meta = [authors(b.authors) || t("opac.search.unknown_author"), b.pub_year, formatName(b.material_type),
    b.language !== "en" ? langName(b.language) : null].filter(Boolean).join(" · ");
  return html`<article class="os-card" aria-labelledby="r-${b.id}">
    <a href="/record/${b.id}" tabindex="-1" aria-hidden="true">${cover(b)}</a>
    <div class="stack tight" style="min-width:0">
      <h3 id="r-${b.id}"><a href="/record/${b.id}">${b.title}</a>${b.subtitle ? html`<span class="os-sub">: ${b.subtitle}</span>` : ""}</h3>
      <div class="os-meta">${meta}</div>
      <div class="os-tags">${availabilityBadge(b.availability)}${b.classification ? html`<span class="badge outline mono">${b.classification}</span>` : ""}</div>
      ${(b.subjects || []).length ? html`<div class="os-tags os-subjects">${b.subjects.slice(0, 3).map((s) => html`<a class="chip small" href="/search?${qs({ subject: s })}">${s.split(" -- ")[0]}</a>`)}</div>` : ""}
    </div></article>`;
}

function facetsPanel(facets, s) {
  const groups = Object.entries(facets || {}).filter(([, v]) => v.length);
  if (!groups.length) return "";
  return html`<h2 class="sr-only">${t("opac.search.refine")}</h2>${groups.map(([key, values], gi) => {
    const fkey = key === "decade" ? "year_from" : key;
    const title = facetTitle(key);
    const active = values.some(([v]) => s[fkey] === (key === "decade" ? String(parseInt(v, 10)) : v));
    const button = ([v, n]) => {
      const val = key === "decade" ? String(parseInt(v, 10)) : v;
      return html`<button type="button" data-facet="${fkey}" data-value="${val}" data-decade="${key === "decade" ? "1" : ""}" aria-pressed="${s[fkey] === val}">
        <span class="lbl">${label(key, v)}</span><span class="n"><span class="sr-only">(</span>${num(n)}<span class="sr-only">)</span></span></button>`;
    };
    return html`<details class="facet" ${gi < 3 || active ? "open" : ""}>
      <summary>${title}${icon("chevron-down")}</summary>
      <div role="group" aria-label="${title}">${values.slice(0, SHOWN).map(button)}
        ${values.length > SHOWN ? html`<div class="more-values" hidden>${values.slice(SHOWN).map(button)}</div>
          <button type="button" class="link-btn more" data-more aria-expanded="false">${t("ui.search.show_more", { count: values.length - SHOWN })}</button>` : ""}</div>
    </details>`;
  })}`;
}

function filterChips(s) {
  const out = [];
  for (const k of FILTER_KEYS) {
    if (!s[k] || k === "year_to") continue;
    if (k === "year_from") out.push({ key: "year_from", label: t("opac.search.facet_decade"), value: s.year_to ? `${s.year_from}–${s.year_to}` : `${s.year_from}+` });
    else if (k === "available_only") out.push({ key: k, label: t("ui.search.availability"), value: t("opac.search.available_now") });
    else out.push({ key: k, label: FACETS.includes(k) ? facetTitle(k) : t(`ui.search.filter_${k}`, {}, k), value: label(k, s[k]) });
  }
  return activeFilters(out);
}

async function suggestSpelling(s, total) {
  if (!s.q || s.mode !== "keyword" || total > 3) return;
  try {
    const r = await api(`/search/did-you-mean?${qs({ q: s.q })}`);
    if (r.suggestion) $("#didyoumean").innerHTML = didYouMean(r.suggestion, r.total);
  } catch { /* optional */ }
}

function setView(view) {
  $("#results").classList.toggle("grid-view", view === "grid");
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ }
}

export default async function init() {
  const s = state();
  const form = $("#search-form");
  wireSearchMode(form);
  attachSuggest($("#q"));
  $$("[data-mode]", form).forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === s.mode));
  $("[name=mode]", form).value = s.mode;
  $("#sort").value = s.sort;
  $("#available-only").checked = s.available_only === "true";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    go({ q: $("#q").value.trim(), mode: $("[name=mode]", form).value, sort: s.sort });
  });
  $("#sort").addEventListener("change", (e) => go({ ...s, sort: e.target.value, page: 1 }));
  $("#available-only").addEventListener("change", (e) => go({ ...s, available_only: e.target.checked ? "true" : undefined, page: 1 }));

  let view = "list";
  try { view = localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list"; } catch { /* ignore */ }
  $("#view-toggle").innerHTML = segmented({ name: "view", label: t("ui.search.view"), value: view,
    options: [["list", t("ui.search.view_list"), "rows"], ["grid", t("ui.search.view_grid"), "grid"]] });
  wireSegmented($("#view-toggle"), setView);
  setView(view);

  const facetsBox = $("#facets"), toggle = $(".os-facets-toggle");
  toggle.addEventListener("click", () => {
    const open = !facetsBox.classList.contains("open");
    facetsBox.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });

  const results = $("#results");
  results.setAttribute("aria-busy", "true");
  results.innerHTML = skeletonList(4);
  $("#active-filters").innerHTML = filterChips(s);
  try {
    let data;
    if (s.mode === "smart" && s.q) {
      data = await api(`/search/smart?${qs({ q: s.q, page: s.page })}`);
      const p = data.parsed;
      $("#interpretation").innerHTML = html`<div class="interpretation">${icon("sparkle")}
        <strong>${p.engine === "claude" ? t("opac.search.claude_understood") : t("opac.search.ai_understood")}</strong>
        ${p.keywords ? html`<span class="badge ai">${t("opac.search.topic", { topic: p.keywords })}</span>` : ""}
        ${(p.interpretation || []).map((i) => html`<span class="badge ai">${i}</span>`)}
        <a class="small" style="margin-inline-start:auto" href="/search?${qs({ q: s.q })}">${t("opac.search.use_keyword")}</a></div>`;
      // Facets in AI mode switch to keyword search carrying the understood filters
      facetsBox.dataset.base = JSON.stringify({ q: p.keywords, material_type: p.material_type, language: p.language,
        audience: p.audience, year_from: p.year_from, year_to: p.year_to, author: p.author, available_only: p.available_only || undefined });
    } else {
      const params = { q: s.q, page: s.page, per_page: PER_PAGE, sort: s.q ? s.sort : (s.sort === "relevance" ? "newest" : s.sort) };
      for (const k of FILTER_KEYS) if (s[k]) params[k] = s[k];
      data = await api(`/search?${qs(params)}`);
    }
    const summary = s.q ? t("opac.search.results_for", { count: data.total, q: s.q }) : t("opac.search.results", { count: data.total });
    $("#summary").textContent = `${summary}${data.took_ms !== undefined ? ` · ${t("opac.search.took", { ms: data.took_ms })}` : ""}`;
    if (s.q) document.title = `${s.q} · ${document.title.replace(/^.*? · /, "")}`;
    const filtered = FILTER_KEYS.some((k) => s[k]);
    results.innerHTML = data.results.length ? html`${data.results.map(resultCard)}`
      : emptyState({ art: "search", title: t("ui.search.empty_title"),
        body: s.mode === "smart" ? t("opac.search.empty_smart") : t("opac.search.empty_keyword"),
        actions: html`${filtered ? html`<button type="button" class="btn" data-clear-filters>${t("ui.filters.clear_all")}</button>` : ""}
          ${s.q && s.mode !== "smart" ? html`<a class="btn ai" href="/search?${qs({ q: s.q, mode: "smart" })}">${icon("sparkle")}${t("ui.search.try_ai")}</a>` : ""}` });
    facetsBox.innerHTML = facetsPanel(data.facets, s);
    const pages = Math.ceil(data.total / PER_PAGE);
    $("#pager").innerHTML = pages > 1 ? pagination({ page: s.page, perPage: PER_PAGE, total: data.total }) : "";
    suggestSpelling(s, data.total);
  } catch (e) {
    results.innerHTML = errorState(e);
    toast(e.message, "error");
  } finally {
    results.removeAttribute("aria-busy");
  }

  facetsBox.addEventListener("click", (e) => {
    const more = e.target.closest("[data-more]");
    if (more) {
      const box = more.previousElementSibling;
      box.hidden = !box.hidden;
      more.setAttribute("aria-expanded", String(!box.hidden));
      more.textContent = box.hidden ? t("ui.search.show_more", { count: box.children.length }) : t("ui.search.show_less");
      return;
    }
    const b = e.target.closest("[data-facet]");
    if (!b) return;
    const base = facetsBox.dataset.base ? JSON.parse(facetsBox.dataset.base) : { ...s };
    const next = { ...base, mode: "keyword", page: 1, sort: s.sort };
    const pressed = b.getAttribute("aria-pressed") === "true";
    next[b.dataset.facet] = pressed ? undefined : b.dataset.value;
    if (b.dataset.decade) next.year_to = pressed ? undefined : String(+b.dataset.value + 9);
    go(next);
  });
  document.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove-filter]");
    if (rm) {
      const next = { ...s, page: 1, [rm.dataset.removeFilter]: undefined };
      if (rm.dataset.removeFilter === "year_from") next.year_to = undefined;
      go(next);
    } else if (e.target.closest("[data-clear-filters]")) {
      go({ q: s.q, mode: s.mode, sort: s.sort });
    }
  });
  $("#pager").addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]");
    if (b && !b.disabled) go({ ...s, page: +b.dataset.page });
  });
}
