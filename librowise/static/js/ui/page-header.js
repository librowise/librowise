// Page header: title (+ optional count), subtitle, eyebrow and actions. Breadcrumbs and the hub's tab bar
// are rendered by the staff shell (staff_base.html), so pages only describe themselves.
//
//   $("#head").innerHTML = pageHeader({
//     title: t("…"), count: 1204, subtitle: t("…"),
//     actions: html`<button class="btn primary" id="new">${icon("plus")}New</button>`,
//   });
//   setCrumb("Asha Rao");   // replace the last breadcrumb on a detail page
import { $, html, num } from "/static/js/core.js";

export function pageHeader({ title, subtitle = "", count = null, eyebrow = "", actions = "", id = "page-title" }) {
  return html`<header class="page-header">
    <div class="ph-main">${eyebrow ? html`<div class="ph-eyebrow">${eyebrow}</div>` : ""}
      <h1 id="${id}">${title}${count !== null && count !== undefined ? html`<span class="ph-count">${num(count)}</span>` : ""}</h1>
      ${subtitle ? html`<p class="ph-sub">${subtitle}</p>` : ""}</div>
    ${actions ? html`<div class="ph-actions">${actions}</div>` : ""}
  </header>`;
}

/** Update the current (last) breadcrumb, e.g. with a record's title once it has loaded. */
export function setCrumb(text) {
  const el = $("#crumb") || $(".crumbs [aria-current]");
  if (el) el.textContent = text;
}

/** Update the count badge next to the page title. */
export function setCount(n) {
  const h = $(".page-header h1");
  if (!h) return;
  let c = $(".ph-count", h);
  if (!c) { c = document.createElement("span"); c.className = "ph-count"; h.append(c); }
  c.textContent = n === null || n === undefined ? "" : num(n);
}
