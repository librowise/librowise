// Side panel (drawer) for details and quick edits, built on a modal <dialog> so it gets the top layer,
// an inert background and Esc for free. Focus is trapped and returned to the opener on close.
//
//   const p = sidePanel({ title: "Asha Rao", subtitle: "Card 0012…", body: html`…`, footer: html`<a class="btn" href="…">Open</a>`, wide: false });
//   p.setBody(html`…`);  p.close();  await p.closed;
import { $, html, icon, raw, trapFocus } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

let seq = 0;

export function sidePanel({ title, subtitle = "", body = "", footer = "", wide = false, onClose } = {}) {
  const opener = document.activeElement;
  const d = document.createElement("dialog");
  d.className = `side-panel${wide ? " wide" : ""}`;
  const id = `panel-${++seq}`;
  d.setAttribute("aria-labelledby", `${id}-title`);
  d.innerHTML = html`<div class="dialog-head"><div class="grow"><h2 id="${id}-title">${title}</h2>${subtitle ? html`<div class="small muted">${subtitle}</div>` : ""}</div>
    <button type="button" class="btn ghost icon-only" data-close aria-label="${t("common.close")}">${icon("x")}</button></div>
    <div class="dialog-body" data-body>${raw(body)}</div>${footer ? html`<div class="dialog-foot" data-foot>${raw(footer)}</div>` : ""}`;
  document.body.append(d);
  const release = trapFocus(d);
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  d.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) d.close();
    else if (e.target === d) d.close(); // backdrop click
  });
  d.addEventListener("close", () => {
    release();
    d.remove();
    onClose?.();
    resolveClosed();
    if (opener?.isConnected) opener.focus?.();
  });
  d.showModal();
  $("[data-close]", d).focus();
  return {
    el: d,
    closed,
    close: () => d.close(),
    setBody(content) { $("[data-body]", d).innerHTML = content; },
    setTitle(text) { $(`#${id}-title`, d).textContent = text; },
  };
}
