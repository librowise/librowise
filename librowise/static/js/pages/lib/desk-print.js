// Printable slips for the front desk: hold slips, transit slips and transaction receipts.
// Slips are rendered into one hidden container and printed with the page's own print stylesheet
// (static/css/pages/desk.css → `html.desk-printing`), so there is no pop-up window to block and the slip
// uses the same fonts and translations as the screen. Sized for 80 mm receipt printers; fine on A4 too.
//
//   printSlip(holdSlip({ hold, item, title, branch, library }))
import { date, datetime, html } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

function container() {
  let el = document.getElementById("desk-print");
  if (!el) {
    el = document.createElement("div");
    el.id = "desk-print";
    el.className = "desk-print";
    el.setAttribute("aria-hidden", "true");
    document.body.append(el);
  }
  return el;
}

/** Print `markup` (html``) as a slip; resolves after the print dialog closes. */
export function printSlip(markup) {
  const el = container();
  el.innerHTML = markup;
  const root = document.documentElement;
  root.classList.add("desk-printing");
  return new Promise((resolve) => {
    const done = () => {
      root.classList.remove("desk-printing");
      window.removeEventListener("afterprint", done);
      resolve();
    };
    window.addEventListener("afterprint", done);
    try { window.print(); } catch { /* printing unavailable */ }
    setTimeout(() => { if (root.classList.contains("desk-printing")) done(); }, 1500);
  });
}

/** Card numbers on slips left on a shelf are partly masked (privacy): ••••0001. */
export const maskCard = (card) => (card && card.length > 4 ? `••••${card.slice(-4)}` : card || "");

const head = (kind, library, branch) => html`<div class="slip-head"><div class="slip-kind">${kind}</div>
  <div class="slip-lib">${library}${branch ? html` · ${branch}` : ""}</div></div>`;

const itemBlock = (item, title) => html`<div class="slip-item"><div class="slip-title">${title}</div>
  ${item.call_number ? html`<div class="slip-call">${item.call_number}</div>` : ""}
  <div class="slip-barcode">${item.barcode}</div></div>`;

/** Hold slip: goes on the item while it waits on the hold shelf. */
export function holdSlip({ hold, item, title, library, branch }) {
  const until = hold.expires_at ? date(hold.expires_at, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "";
  return html`<article class="slip">${head(t("desk.slip.hold"), library, branch)}
    <div class="slip-big">${hold.patron.full_name}</div>
    <div class="slip-sub">${t("desk.slip.card")}: ${maskCard(hold.patron.card_number)}</div>
    <dl class="slip-dl">
      <dt>${t("desk.slip.pickup_at")}</dt><dd>${hold.pickup_branch.name}</dd>
      ${until ? html`<dt>${t("desk.slip.hold_until")}</dt><dd>${until}</dd>` : ""}
    </dl>
    ${itemBlock(item, title)}
    <div class="slip-foot">${t("desk.slip.printed", { when: datetime(new Date().toISOString().slice(0, 19)) })}</div></article>`;
}

/** Transit slip: travels with the item to another branch (for a hold, or back to its home branch). */
export function transitSlip({ to, from, item, title, hold, library }) {
  return html`<article class="slip">${head(t("desk.slip.transit"), library, from)}
    <div class="slip-label">${t("desk.slip.send_to")}</div>
    <div class="slip-big">${to}</div>
    <dl class="slip-dl">
      <dt>${t("desk.slip.from")}</dt><dd>${from}</dd>
      ${hold ? html`<dt>${t("desk.slip.hold_for")}</dt><dd>${hold.patron.full_name} (${maskCard(hold.patron.card_number)})</dd>` : ""}
    </dl>
    ${itemBlock(item, title)}
    <div class="slip-foot">${t("desk.slip.printed", { when: datetime(new Date().toISOString().slice(0, 19)) })}</div></article>`;
}

/** Transaction receipt for one patron's visit: loans and renewals with due dates. */
export function receiptDoc({ patron, lines, library, branch }) {
  const out = lines.filter((l) => l.kind === "checkout"), ren = lines.filter((l) => l.kind === "renew");
  const list = (rows) => html`<ol class="slip-lines">${rows.map((l) => html`<li><strong>${l.title}</strong>
    <span>${l.barcode}</span><span>${t("desk.slip.due", { date: date(l.due_at, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) })}</span></li>`)}</ol>`;
  return html`<article class="slip">${head(t("desk.slip.receipt"), library, branch)}
    <div class="slip-sub">${patron.full_name} · ${t("desk.slip.card")}: ${maskCard(patron.card_number)}</div>
    <div class="slip-sub">${datetime(new Date().toISOString().slice(0, 19))}</div>
    ${out.length ? html`<h2>${t("desk.slip.borrowed", { count: out.length })}</h2>${list(out)}` : ""}
    ${ren.length ? html`<h2>${t("desk.slip.renewed", { count: ren.length })}</h2>${list(ren)}` : ""}
    <div class="slip-foot">${t("desk.slip.thanks")}</div></article>`;
}
