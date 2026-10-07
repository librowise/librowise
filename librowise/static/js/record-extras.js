// Record page extras: citation generator (APA, MLA, Chicago, BibTeX, RIS) and a virtual shelf browser
// showing the titles shelved either side by call number. Called once from opac-record.js.
import { $, $$, api, authors, cover, html, icon, raw, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

const STYLES = ["apa", "mla", "chicago", "bibtex", "ris"];

async function openCitations(b, opener) {
  const d = document.createElement("dialog");
  d.className = "wide cite-dialog";
  d.setAttribute("aria-labelledby", "cite-title");
  d.innerHTML = html`<div class="dialog-head"><h2 id="cite-title">${t("discovery.cite_title")}</h2>
      <button type="button" class="btn ghost icon-only" data-close aria-label="${t("common.close")}">${icon("x")}</button></div>
    <div class="dialog-body stack">
      <div class="tabs" role="tablist" aria-label="${t("discovery.cite_styles")}">${STYLES.map((s, i) => html`<button type="button" role="tab" id="cite-tab-${s}"
        aria-controls="cite-panel" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-style="${s}">${t(`discovery.style_${s}`)}</button>`)}</div>
      <div id="cite-panel" role="tabpanel" aria-labelledby="cite-tab-apa" tabindex="0" class="cite-panel" aria-live="polite"><div class="skeleton" style="height:3rem"></div></div>
      <div class="row tight">
        <button type="button" class="btn primary" data-copy>${icon("copy")}${t("discovery.copy")}</button>
        <a class="btn" href="/api/v1/biblios/${b.id}/cite?style=ris&download=true" download>${icon("download")}${t("discovery.download_ris")}</a>
        <a class="btn" href="/api/v1/biblios/${b.id}/cite?style=bibtex&download=true" download>${icon("download")}${t("discovery.download_bibtex")}</a>
      </div>
      <p class="tiny muted">${t("discovery.cite_note")}</p>
    </div>`;
  document.body.append(d);
  d.showModal();
  const close = () => d.close();
  d.addEventListener("close", () => { d.remove(); opener?.focus(); });
  d.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === d) close(); });

  let data = null, current = "apa";
  const panel = $("#cite-panel", d);
  const show = (style) => {
    current = style;
    $$("[role=tab]", d).forEach((tab) => {
      const on = tab.dataset.style === style;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", `cite-tab-${style}`);
    const c = data?.citations.find((x) => x.style === style);
    if (!c) return;
    // c.html is produced server-side with every value escaped; only <i> tags are markup.
    panel.innerHTML = ["bibtex", "ris"].includes(style) ? html`<pre class="cite-code">${c.text}</pre>` : html`<p class="cite-text">${raw(c.html)}</p>`;
  };
  $(".tabs", d).addEventListener("click", (e) => { const tab = e.target.closest("[data-style]"); if (tab) show(tab.dataset.style); });
  $(".tabs", d).addEventListener("keydown", (e) => {
    const i = STYLES.indexOf(current);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: STYLES.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const style = STYLES[(next + STYLES.length) % STYLES.length];
    show(style);
    $(`#cite-tab-${style}`, d).focus();
  });
  $("[data-copy]", d).addEventListener("click", async () => {
    const c = data?.citations.find((x) => x.style === current);
    if (!c) return;
    try { await navigator.clipboard.writeText(c.text); toast(t("discovery.copied"), "success"); }
    catch { toast(c.text); }
  });
  $("[role=tab][aria-selected=true]", d).focus();
  try {
    data = await api(`/biblios/${b.id}/cite`);
    show(current);
  } catch (e) {
    panel.innerHTML = html`<div class="alert bad" role="alert">${icon("alert")}<div>${e.message}</div></div>`;
  }
}

function shelfCard(x, current = false) {
  return html`<li class="vshelf-item ${current ? "current" : ""}">
    ${current ? html`<div aria-current="true">${cover(x)}<span class="t">${x.title}</span><span class="cn mono">${x.call_number || ""}</span>
      <span class="badge info">${t("discovery.shelf_this")}</span></div>`
      : html`<a href="/record/${x.id}">${cover(x)}<span class="t">${x.title}</span><span class="a">${authors(x.authors)}</span><span class="cn mono">${x.call_number}</span></a>`}
  </li>`;
}

async function shelfBrowser(b) {
  let data;
  try { data = await api(`/biblios/${b.id}/shelf?n=6`); } catch { return; }
  if (!data.anchor || (!data.before.length && !data.after.length)) return;
  const section = document.createElement("section");
  section.className = "shelf vshelf";
  section.setAttribute("aria-labelledby", "vshelf-title");
  section.innerHTML = html`<div class="shelf-head"><h2 id="vshelf-title">${icon("shelf")} ${t("discovery.shelf_title")}</h2>
      <span class="muted small">${t("discovery.shelf_sub", { cn: data.anchor })}</span></div>
    <ol class="vshelf-row" tabindex="0" aria-label="${t("discovery.shelf_region", { cn: data.anchor })}">
      ${data.before.map((x) => shelfCard(x))}${shelfCard({ ...b, call_number: data.anchor }, true)}${data.after.map((x) => shelfCard(x))}</ol>`;
  const related = $("#related-section");
  related ? related.before(section) : $("#record").after(section);
  const row = $(".vshelf-row", section);
  const cur = $(".current", row);
  // Centre the current title without moving page focus or scrolling the window.
  if (cur) row.scrollLeft = cur.offsetLeft - row.clientWidth / 2 + cur.clientWidth / 2;
}

/** Enhance a rendered record page. `b` is the biblio returned by /api/v1/biblios/{id}. */
export function enhanceRecord(b) {
  const share = $("#share");
  if (share && !$("#cite")) {
    share.insertAdjacentHTML("beforebegin", html`<button class="btn ghost sm" id="cite" type="button" aria-haspopup="dialog">${icon("quote")}${t("discovery.cite")}</button>`);
    $("#cite").addEventListener("click", (e) => openCitations(b, e.currentTarget));
  }
  shelfBrowser(b);
}
