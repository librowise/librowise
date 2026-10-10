// OPAC: alphabetical browse of authorised headings with see / see-also references. The index, start
// point and paging live in the URL (links, so every view is shareable and the back button works).
import { $, api, html, icon, qs } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";

const INDEXES = ["authors", "subjects", "titles"];
const REL = { broader: "opac.browse.rel_broader", narrower: "opac.browse.rel_narrower", earlier: "opac.browse.rel_earlier", later: "opac.browse.rel_later" };

function state() {
  const p = new URLSearchParams(location.search);
  const index = INDEXES.includes(p.get("index")) ? p.get("index") : "authors";
  return { index, start: p.get("start") || "", after: p.get("after"), before: p.get("before") };
}

/** A search filtered by the heading — by author or subject depending on how records use it. */
function searchLink(index, heading, roles = []) {
  if (index === "authors" && (roles.includes("author") || !roles.length)) return `/search?${qs({ author: heading })}`;
  if (index !== "titles" || roles.includes("subject")) return `/search?${qs({ subject: heading })}`;
  return `/search?${qs({ q: heading })}`;
}
const browseLink = (index, heading) => `/browse?${qs({ index, start: heading })}`;
const records = (n) => html`<span class="badge neutral">${t("opac.browse.records", { count: n })}</span>`;

function entry(e, s, exact) {
  if (e.kind === "see") {
    return html`<li><span class="see-ref">${e.heading}</span><span class="see">${icon("arrow-right")}${t("opac.browse.see")}
      <a href="${searchLink(s.index, e.see.heading, e.see.roles)}">${e.see.heading}</a></span>${e.see.count ? records(e.see.count) : ""}</li>`;
  }
  const hit = exact && exact.kind === "heading" && exact.id === e.id;
  return html`<li class="${hit ? "highlight" : ""}">
    <a class="heading" href="${searchLink(s.index, e.heading, e.roles)}">${e.heading}</a>${e.count ? records(e.count) : html`<span class="small muted">${t("opac.browse.no_records")}</span>`}
    ${e.see_also.length ? html`<span class="refs">${t("opac.browse.see_also")} ${e.see_also.map((r, i) => html`${i ? " · " : ""}<a href="${browseLink(s.index, r.heading)}">${r.heading}</a>${REL[r.relationship] ? html` <span class="tiny">(${t(REL[r.relationship])})</span>` : ""}`)}</span>` : ""}
  </li>`;
}

export default async function init() {
  const s = state();
  const list = $("#browse-list"), panel = $("#browse-panel");
  let data;
  try {
    data = await api(`/browse?${qs({ index: s.index, start: s.start, after: s.after, before: s.before, limit: 40 })}`);
  } catch (e) {
    list.innerHTML = errorState(e);
    list.addEventListener("click", (ev) => { if (ev.target.closest("[data-retry]")) location.reload(); });
    panel.removeAttribute("aria-busy");
    return;
  }
  if (data.exact?.kind === "see") {
    $("#browse-notice").innerHTML = html`<div class="alert info" style="margin-bottom:1rem">${icon("info")}<div class="ol-text">
      ${t("opac.browse.not_used", { heading: data.exact.heading })} <a href="${searchLink(s.index, data.exact.see.heading)}"><strong>${data.exact.see.heading}</strong></a></div></div>`;
  }
  list.innerHTML = data.entries.length
    ? html`<ul class="browse-list">${data.entries.map((e) => entry(e, s, data.exact))}</ul>`
    : emptyState({ art: "search", title: s.start ? t("opac.browse.nothing_from", { start: s.start }) : t("opac.browse.empty"),
      actions: s.start ? html`<a class="btn" href="/browse?${qs({ index: s.index })}">${t("opac.browse.from_start")}</a>` : "" });
  panel.removeAttribute("aria-busy");
  const prev = data.prev ? html`<a class="btn" href="/browse?${qs({ index: s.index, before: data.prev })}">${icon("chevron-left")}${t("opac.search.previous")}</a>` : html`<span></span>`;
  const next = data.next ? html`<a class="btn" href="/browse?${qs({ index: s.index, after: data.next })}">${t("opac.search.next")}${icon("chevron")}</a>` : "";
  $("#browse-pager").innerHTML = html`${prev}${next}`;
  if (!data.prev && !data.next) $("#browse-pager").hidden = true;
}
