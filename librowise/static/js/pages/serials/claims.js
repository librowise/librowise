// Staff: printable claim letters for one claim batch (one letter per vendor).
import { $, BOOT, api, date, empty, html, icon } from "/static/js/core.js";
import { errorBox, plural } from "/static/js/pages/lib/sc-ui.js";

function mailto(data, letter) {
  const lines = letter.claims.map((c) => `- ${c.subscription.title}${c.subscription.issn ? ` (ISSN ${c.subscription.issn})` : ""}: ${c.issue.enumeration}`
    + `${c.issue.chronology ? `, ${c.issue.chronology}` : ""} — expected ${c.issue.expected_on}${c.subscription.vendor_reference ? `, our ref. ${c.subscription.vendor_reference}` : ""}`
    + `${c.issue.claim_count > 1 ? ` (claim #${c.issue.claim_count})` : ""}`);
  const body = [`Dear ${letter.vendor.name},`, "", "The following issues on our subscriptions have not been received. Please supply them or let us know when they will be dispatched:",
    "", ...lines, "", ...(data.note ? [data.note, ""] : []), "With thanks,", data.by || "", data.library_name, letter.branch.name].join("\n");
  const subject = `Claim for missing issues — ${data.library_name}`;
  return `mailto:${encodeURIComponent(letter.vendor.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function letterHtml(data, letter) {
  const b = letter.branch;
  return html`<article class="card pad sc-letter" aria-label="Claim letter to ${letter.vendor.name}">
    <header class="row between" style="align-items:flex-start">
      <div><strong>${data.library_name}</strong><div class="small">${b.name}</div>
        ${b.address ? html`<div class="small">${b.address}</div>` : ""}
        <div class="small muted">${[b.email, b.phone].filter(Boolean).join(" · ")}</div></div>
      <div class="small right">${date(data.claimed_at, { day: "numeric", month: "long", year: "numeric" })}<div class="tiny muted mono">Ref. ${data.batch.slice(0, 8).toUpperCase()}</div></div>
    </header>
    <div class="sc-letter-to"><div class="tiny muted">To</div><strong>${letter.vendor.name}</strong>
      ${letter.vendor.email ? html`<div class="small">${letter.vendor.email}</div>` : ""}${letter.vendor.phone ? html`<div class="small">${letter.vendor.phone}</div>` : ""}</div>
    <h2 class="sc-letter-subject">Claim for ${plural(letter.claims.length, "missing issue")}</h2>
    <p>Dear ${letter.vendor.name},</p>
    <p>The following issues on our subscriptions with you have not been received. Please supply them or let us know when they will be dispatched.</p>
    <div class="table-wrap"><table class="table"><caption class="sr-only">Claimed issues</caption>
      <thead><tr><th scope="col">Title</th><th scope="col">ISSN</th><th scope="col">Our reference</th><th scope="col">Issue</th><th scope="col">Expected</th><th scope="col" class="num">Claim #</th></tr></thead>
      <tbody>${letter.claims.map((c) => html`<tr><td>${c.subscription.title}</td><td class="mono small">${c.subscription.issn || "—"}</td>
        <td class="small">${c.subscription.vendor_reference || "—"}</td><td>${c.issue.enumeration}${c.issue.chronology ? html`<div class="tiny muted">${c.issue.chronology}</div>` : ""}</td>
        <td class="nowrap">${date(c.issue.expected_on)}</td><td class="num">${c.issue.claim_count}</td></tr>`)}</tbody></table></div>
    ${data.note ? html`<p style="white-space:pre-line">${data.note}</p>` : ""}
    <p>With thanks,</p>
    <p><strong>${data.by || "Serials team"}</strong><br>${data.library_name}</p>
    <div class="row tight sc-letter-actions">${letter.vendor.email ? html`<a class="btn sm" href="${mailto(data, letter)}">${icon("send")}Email ${letter.vendor.name}</a>`
      : html`<span class="small muted">${icon("info")} No email address on file for this vendor — print and post this letter.</span>`}</div>
  </article>`;
}

export default async function init() {
  const box = $("#claim-letters");
  $("#print-letters").addEventListener("click", () => window.print());
  try {
    const data = await api(`/serials/claims/batches/${encodeURIComponent(BOOT.path_params.batch)}`);
    box.innerHTML = data.letters.length ? html`${data.letters.map((l) => letterHtml(data, l))}` : empty("No claims in this batch.");
  } catch (e) {
    box.innerHTML = e.status === 404 ? empty("This claim batch does not exist.", "alert") : errorBox(e.message);
  }
}
