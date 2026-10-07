// OPAC: alphabetical browse of authorised headings with see / see-also references.
import { $, $$, api, empty, html, icon, num, qs, skeleton } from "/static/js/core.js";

const INDEXES = ["authors", "subjects", "titles"];
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function state() {
  const p = new URLSearchParams(location.search);
  const index = INDEXES.includes(p.get("index")) ? p.get("index") : "authors";
  return { index, start: p.get("start") || "", after: p.get("after"), before: p.get("before") };
}
const go = (s) => { location.search = qs({ index: s.index, start: s.start, after: s.after, before: s.before }); };

/** A search filtered by the heading — by author or subject depending on how records use it. */
function searchLink(index, heading, roles = []) {
  if (index === "authors" && (roles.includes("author") || !roles.length)) return `/search?${qs({ author: heading })}`;
  if (index !== "titles" || roles.includes("subject")) return `/search?${qs({ subject: heading })}`;
  return `/search?${qs({ q: heading })}`;
}
const browseLink = (index, heading) => `/browse?${qs({ index, start: heading })}`;
const records = (n) => html`<span class="badge">${num(n)} record${n === 1 ? "" : "s"}</span>`;

function entry(e, s, exact) {
  if (e.kind === "see") {
    return html`<li><span class="see-ref">${e.heading}</span><span class="small">${icon("arrow-right")} see
      <a href="${searchLink(s.index, e.see.heading, e.see.roles)}">${e.see.heading}</a></span>${e.see.count ? records(e.see.count) : ""}</li>`;
  }
  const hit = exact && exact.kind === "heading" && exact.id === e.id;
  return html`<li class="${hit ? "highlight" : ""}">
    <a class="heading" href="${searchLink(s.index, e.heading, e.roles)}">${e.heading}</a>${e.count ? records(e.count) : html`<span class="small muted">no records</span>`}
    ${e.see_also.length ? html`<span class="refs">See also: ${e.see_also.map((r, i) => html`${i ? " · " : ""}<a href="${browseLink(s.index, r.heading)}">${r.heading}</a>${r.relationship !== "related" ? html` <span class="tiny">(${r.relationship} term)</span>` : ""}`)}</span>` : ""}
  </li>`;
}

export default async function init() {
  const s = state();
  const tabs = $$('[role="tab"]', $("#browse-tabs"));
  tabs.forEach((t) => { const on = t.dataset.index === s.index; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
  $("#browse-panel").setAttribute("aria-labelledby", `tab-${s.index}`);
  $("#browse-tabs").addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t) go({ index: t.dataset.index }); });
  $("#browse-tabs").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    tabs[(next + tabs.length) % tabs.length].focus();
  });
  $("#browse-start").value = s.start;
  $("#browse-form").addEventListener("submit", (e) => { e.preventDefault(); go({ index: s.index, start: $("#browse-start").value.trim() }); });
  $("#browse-alpha").innerHTML = html`${LETTERS.map((l) => html`<button type="button" class="chip" data-letter="${l}" aria-pressed="${s.start.toUpperCase() === l}">${l}</button>`)}`;
  $("#browse-alpha").addEventListener("click", (e) => { const b = e.target.closest("[data-letter]"); if (b) go({ index: s.index, start: b.dataset.letter }); });

  $("#browse-list").innerHTML = `<div style="padding:1rem">${skeleton(8)}</div>`;
  let data;
  try {
    data = await api(`/browse?${qs({ index: s.index, start: s.start, after: s.after, before: s.before, limit: 40 })}`);
  } catch (e) {
    $("#browse-list").innerHTML = empty(e.message, "alert");
    return;
  }
  if (data.exact?.kind === "see") {
    $("#browse-notice").innerHTML = html`<div class="alert info" style="margin-bottom:1rem">${icon("info")}<div>
      “${data.exact.heading}” is not the form used in this catalogue. See <a href="${searchLink(s.index, data.exact.see.heading)}"><strong>${data.exact.see.heading}</strong></a>.</div></div>`;
  }
  $("#browse-list").innerHTML = data.entries.length
    ? html`<ul class="browse-list">${data.entries.map((e) => entry(e, s, data.exact))}</ul>`
    : empty(s.start ? `Nothing in this index from “${s.start}” onwards.` : "This index is empty.");
  $("#browse-pager").innerHTML = html`${data.prev ? html`<a class="btn" href="/browse?${qs({ index: s.index, before: data.prev })}">Previous</a>` : ""}
    ${data.next ? html`<a class="btn" href="/browse?${qs({ index: s.index, after: data.next })}">Next</a>` : ""}`;
}
