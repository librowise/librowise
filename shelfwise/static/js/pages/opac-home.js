import { $, $$, api, authors, cover, empty, html, toast } from "/static/js/core.js";

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

export default async function init() {
  const form = $("#hero-search");
  wireSearchMode(form);
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-q]");
    if (chip) location.href = `/search?mode=smart&q=${encodeURIComponent(chip.dataset.q)}`;
  });
  try {
    const { shelves } = await api("/opac/home");
    $("#shelves").innerHTML = shelves.length ? html`${shelves.map((s) => html`<section class="shelf" aria-labelledby="shelf-${s.key}">
      <div class="shelf-head"><h2 id="shelf-${s.key}">${s.title}</h2><a href="/search?sort=${s.key === "new" ? "newest" : "relevance"}" class="small">Browse all</a></div>
      <div class="shelf-row">${s.results.map(bookCard)}</div></section>`)}` : empty("The catalogue is empty.");
    const lists = await api("/opac/lists/public");
    if (lists.results.length) {
      $("#public-lists").innerHTML = html`${lists.results.filter((l) => l.count).map((l) => html`<section class="shelf">
        <div class="shelf-head"><h2>${l.name}</h2><span class="muted small">Reading list · ${l.count} titles</span></div>
        <div class="shelf-row">${l.results.map(bookCard)}</div></section>`)}`;
    }
  } catch (e) {
    toast(e.message, "error");
  }
}
