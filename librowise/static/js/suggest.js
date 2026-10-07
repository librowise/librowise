// Search-as-you-type: an ARIA 1.2 combobox (list autocomplete) over /api/v1/search/suggest.
// Keyboard: ↓/↑ move, Enter opens the highlighted suggestion (or submits the search), Esc closes.
import { esc, html, icon } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

const KIND_ICON = { title: "book", author: "user", subject: "list" };
let seq = 0;

function highlight(label, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  // Escape first, then wrap word-prefix matches; matching on escaped text keeps markup safe.
  let out = esc(label);
  for (const w of words) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu");
    out = out.replace(re, "$1<mark>$2</mark>");
  }
  return out;
}

export function attachSuggest(input) {
  if (!input || input.dataset.suggestWired) return;
  input.dataset.suggestWired = "1";
  const form = input.form;
  const id = `${input.id || "q"}-suggest-${++seq}`;
  const list = document.createElement("ul");
  list.id = id;
  list.className = "suggest-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("discovery.suggestions"));
  list.hidden = true;
  const live = document.createElement("span");
  live.className = "sr-only";
  live.setAttribute("role", "status");
  form.classList.add("has-suggest");
  form.append(list, live);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", id);

  let items = [], active = -1, timer = 0, ctrl = null, lastQ = "";

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const setActive = (i) => {
    active = items.length ? (i + items.length) % items.length : -1;
    [...list.querySelectorAll("[role=option]")].forEach((li, n) => li.setAttribute("aria-selected", String(n === active)));
    if (active >= 0) {
      const el = list.querySelector(`#${id}-${active}`);
      input.setAttribute("aria-activedescendant", el.id);
      el.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const go = (item) => { close(); location.href = item.href; };

  const render = (q) => {
    if (!items.length) { close(); live.textContent = q.length >= 2 ? t("discovery.no_suggestions") : ""; return; }
    let last = "";
    list.innerHTML = items.map((s, i) => {
      const head = s.kind !== last ? `<li class="suggest-group" role="presentation">${esc(t(`discovery.kind_${s.kind}`))}</li>` : "";
      last = s.kind;
      const detail = [s.detail, s.year].filter(Boolean).join(" · ");
      return `${head}<li role="option" id="${id}-${i}" data-i="${i}" aria-selected="false">${icon(KIND_ICON[s.kind] || "search").__raw}
        <span class="grow">${highlight(s.label, q)}${detail ? `<span class="tiny muted"> · ${esc(detail)}</span>` : ""}</span></li>`;
    }).join("");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    active = -1;
    live.textContent = t("discovery.suggestions_count", { count: items.length });
  };

  const fetchSuggestions = async () => {
    const q = input.value.trim();
    if (q === lastQ) return;
    lastQ = q;
    if (q.length < 2) { items = []; close(); return; }
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      const res = await fetch(`/api/v1/search/suggest?q=${encodeURIComponent(q)}`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = await res.json();
      if (input.value.trim() !== q) return;
      items = data.suggestions || [];
      render(q);
    } catch { /* aborted or offline */ }
  };

  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(fetchSuggestions, 160); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (list.hidden && items.length) { list.hidden = false; input.setAttribute("aria-expanded", "true"); }
      setActive(active + 1);
    } else if (e.key === "ArrowUp" && !list.hidden) {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === "Enter" && !list.hidden && active >= 0) {
      e.preventDefault();
      go(items[active]);
    } else if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("focus", () => { if (items.length && input.value.trim() === lastQ) render(lastQ); });
  list.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the input
  list.addEventListener("click", (e) => { const li = e.target.closest("[data-i]"); if (li) go(items[+li.dataset.i]); });
  form.addEventListener("submit", close);
}

export const didYouMean = (suggestion, total) => html`<p class="didyoumean">${icon("search")}
  <span>${t("discovery.did_you_mean")} <a href="/search?q=${encodeURIComponent(suggestion)}" data-dym><strong>${suggestion}</strong></a>
  <span class="muted small">${t("discovery.did_you_mean_count", { count: total })}</span></span></p>`;
