// Pagination: "1–25 of 1,204" + previous/next + page size.
//   footer.innerHTML = pagination({ page, perPage, total, perPageOptions: [25, 50, 100] });
//   wirePagination(footer, ({ page, perPage }) => load(page, perPage));
import { html, icon, num } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

export function pageRange({ page, perPage, total }) {
  if (!total) return t("ui.table.no_results");
  const from = (page - 1) * perPage + 1, to = Math.min(total, page * perPage);
  return t("ui.table.range", { from: num(from), to: num(to), total: num(total) });
}

export function pagination({ page, perPage, total, perPageOptions = [] }) {
  const pages = Math.max(1, Math.ceil((total || 0) / perPage));
  return html`<nav class="pagination" aria-label="${t("ui.table.pagination")}">
    <span class="page-info" aria-live="polite">${pageRange({ page, perPage, total })}</span>
    ${perPageOptions.length ? html`<label class="sr-only" for="pp-${perPage}-${pages}">${t("ui.table.per_page")}</label>
      <select id="pp-${perPage}-${pages}" data-per-page>${perPageOptions.map((n) => html`<option value="${n}" ${n === perPage ? "selected" : ""}>${t("ui.table.per_page_n", { count: n })}</option>`)}</select>` : ""}
    <button type="button" class="btn sm" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""} aria-label="${t("ui.table.previous")}">${icon("chevron-left", "icon-prev")}<span>${t("ui.table.previous")}</span></button>
    <span class="page-info" aria-current="page">${t("ui.table.page_of", { page: num(page), pages: num(pages) })}</span>
    <button type="button" class="btn sm" data-page="${page + 1}" ${page >= pages ? "disabled" : ""} aria-label="${t("ui.table.next")}"><span>${t("ui.table.next")}</span>${icon("chevron", "icon-next")}</button>
  </nav>`;
}

export function wirePagination(container, onChange, getState) {
  container.addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]");
    if (b && !b.disabled) onChange({ ...getState(), page: +b.dataset.page });
  });
  container.addEventListener("change", (e) => {
    if (e.target.matches("[data-per-page]")) onChange({ ...getState(), page: 1, perPage: +e.target.value });
  });
}
