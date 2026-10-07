import { $, $$, api, authors, cover, empty, html, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { attachSuggest } from "/static/js/suggest.js";

export const bookCard = (b) => html`<a class="book-card" href="/record/${b.id}">
  ${cover(b)}<span class="t">${b.title}</span><span class="a">${authors(b.authors)}</span></a>`;

export function wireSearchMode(form) {
  const hidden = $("[name=mode]", form);
  $$("[data-mode]", form).forEach((btn) => btn.addEventListener("click", () => {
    $$("[data-mode]", form).forEach((b) => b.setAttribute("aria-pressed", b === btn));
    hidden.value = btn.dataset.mode;
    $("[name=q]", form).focus();
  }));
}

const SHELF_TITLES = { trending: "opac.home.shelf_trending", new: "opac.home.shelf_new", for_you: "opac.home.shelf_for_you" };

export default async function init() {
  const form = $("#hero-search");
  wireSearchMode(form);
  attachSuggest($("#hero-q"));
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-q]");
    if (chip) location.href = `/search?mode=smart&q=${encodeURIComponent(chip.dataset.q)}`;
  });
  const shelvesBox = $("#shelves");
  try {
    const { shelves } = await api("/opac/home");
    shelvesBox.innerHTML = shelves.length ? html`${shelves.map((s) => html`<section class="shelf" aria-labelledby="shelf-${s.key}">
      <div class="shelf-head"><h2 id="shelf-${s.key}">${SHELF_TITLES[s.key] ? t(SHELF_TITLES[s.key]) : s.title}</h2>
        <a href="/search?sort=${s.key === "new" ? "newest" : "relevance"}" class="small">${t("opac.home.browse_all")}<span class="sr-only">: ${SHELF_TITLES[s.key] ? t(SHELF_TITLES[s.key]) : s.title}</span></a></div>
      <div class="shelf-row">${s.results.map(bookCard)}</div></section>`)}` : empty(t("opac.home.empty"));
    const lists = await api("/opac/lists/public");
    if (lists.results.length) {
      $("#public-lists").innerHTML = html`${lists.results.filter((l) => l.count).map((l, i) => html`<section class="shelf" aria-labelledby="list-${i}">
        <div class="shelf-head"><h2 id="list-${i}">${l.name}</h2><span class="muted small">${t("opac.home.reading_list", { count: l.count })}</span></div>
        <div class="shelf-row">${l.results.map(bookCard)}</div></section>`)}`;
    }
  } catch (e) {
    toast(e.message, "error");
    shelvesBox.innerHTML = empty(e.message, "alert");
  } finally {
    shelvesBox.removeAttribute("aria-busy");
  }
}
