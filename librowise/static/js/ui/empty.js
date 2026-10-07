// Empty, error and loading states.
//
//   emptyState({ art: "search", title: t("…"), body: t("…"), actions: html`<button class="btn primary">…</button>` })
//   errorState(err, { retry: true })          → pair with a [data-retry] click handler
//   skeletonRows(5, 4)                         → <tr> placeholders for a table body
//   skeletonList(3)                            → card/list placeholders
//
// Illustrations are tiny inline SVGs drawn with currentColor and theme tokens (fill-soft / stroke-muted
// classes), so they work in every theme including high contrast and need no network requests.
import { html, raw } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

const ART = {
  search: `<circle cx="52" cy="50" r="26" class="fill-soft"/><circle cx="52" cy="50" r="26" class="stroke" fill="none" stroke-width="4"/>
    <path d="M71 69l20 20" class="stroke" stroke-width="7" stroke-linecap="round"/><path d="M41 45h22M41 55h14" class="stroke-muted" stroke-width="4" stroke-linecap="round"/>`,
  books: `<rect x="18" y="86" width="84" height="6" rx="3" class="fill-soft"/><rect x="26" y="34" width="14" height="52" rx="3" class="fill-soft stroke" stroke-width="3"/>
    <rect x="44" y="26" width="14" height="60" rx="3" class="fill-surface stroke" stroke-width="3"/><rect x="0" y="-50" width="14" height="50" rx="3" transform="translate(70 86) rotate(-16)" class="fill-soft stroke" stroke-width="3"/>
    <path d="M30 44h6M48 36h6" class="stroke" stroke-width="3" stroke-linecap="round"/>`,
  people: `<circle cx="46" cy="44" r="15" class="fill-soft stroke" stroke-width="3"/><path d="M20 90c2-15 13-24 26-24s24 9 26 24" class="fill-soft stroke" stroke-width="3"/>
    <circle cx="80" cy="50" r="11" class="fill-surface stroke-muted" stroke-width="3"/><path d="M68 90c1-11 6-18 13-19 9 0 17 7 19 19" class="fill-surface stroke-muted" stroke-width="3"/>`,
  inbox: `<path d="M22 60l12-30h52l12 30v26a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4z" class="fill-soft stroke" stroke-width="3"/>
    <path d="M22 60h22l6 10h20l6-10h22" class="fill-surface stroke" stroke-width="3" stroke-linejoin="round"/><path d="M48 42h24M52 50h16" class="stroke-muted" stroke-width="3" stroke-linecap="round"/>`,
  done: `<circle cx="60" cy="56" r="32" class="fill-soft"/><circle cx="60" cy="56" r="32" class="stroke" fill="none" stroke-width="4"/>
    <path d="M45 57l10 10 21-23" class="stroke" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`,
  error: `<path d="M60 22l40 68H20z" class="fill-soft stroke" stroke-width="4" stroke-linejoin="round"/><path d="M60 46v20" class="stroke" stroke-width="6" stroke-linecap="round"/>
    <circle cx="60" cy="78" r="3.5" fill="currentColor"/>`,
  filter: `<path d="M22 26h76L70 58v26l-20 10V58z" class="fill-soft stroke" stroke-width="4" stroke-linejoin="round"/><path d="M84 76l16 16M100 76 84 92" class="stroke-muted" stroke-width="5" stroke-linecap="round"/>`,
};

export const illustration = (name = "inbox") =>
  raw(`<svg class="empty-art" viewBox="0 0 120 110" aria-hidden="true" focusable="false">${ART[name] || ART.inbox}</svg>`);

export function emptyState({ art = "inbox", title, body = "", actions = "", compact = false, tone = "" } = {}) {
  return html`<div class="empty-state${compact ? " compact" : ""}${tone ? ` tone-${tone}` : ""}">${illustration(art)}
    ${title ? html`<h3>${title}</h3>` : ""}${body ? html`<p>${body}</p>` : ""}
    ${actions ? html`<div class="empty-actions">${actions}</div>` : ""}</div>`;
}

export function errorState(err, { retry = true, title } = {}) {
  return emptyState({ art: "error", tone: "danger", title: title || t("ui.state.error_title"), body: err?.message || String(err || ""),
    actions: retry ? html`<button type="button" class="btn" data-retry>${t("ui.state.retry")}</button>` : "" });
}

const bar = (w) => raw(`<div class="skeleton sk-line" style="width:${w}%"></div>`);
export function skeletonRows(rows = 6, cols = 4) {
  const widths = [72, 46, 58, 34, 64, 40];
  return html`${Array.from({ length: rows }, (_, r) => html`<tr class="dt-loading" aria-hidden="true">${Array.from({ length: cols },
    (_, c) => html`<td>${bar(widths[(r + c) % widths.length])}</td>`)}</tr>`)}`;
}
export function skeletonList(n = 3) {
  return html`${Array.from({ length: n }, () => html`<div class="row" style="padding:1rem;align-items:flex-start" aria-hidden="true">
    <div class="skeleton sk-cover"></div><div class="grow stack tight">${bar(60)}${bar(40)}${bar(80)}</div></div>`)}`;
}
