// Staff › Serials › Claim letters — one printable letter per vendor in a claim batch (print or e-mail).
// Letters are written in the staff member's UI language.
import { $, BOOT, api, date, html, icon, num } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";

function lines(data, letter) {
  return letter.claims.map((c) => `- ${c.subscription.title}${c.subscription.issn ? ` (ISSN ${c.subscription.issn})` : ""}: ${c.issue.enumeration}`
    + `${c.issue.chronology ? `, ${c.issue.chronology}` : ""} — ${t("coll.ser.expected_on", { date: c.issue.expected_on })}`
    + `${c.subscription.vendor_reference ? `, ${t("coll.claims.our_ref", { ref: c.subscription.vendor_reference })}` : ""}${c.issue.claim_count > 1 ? ` (${t("coll.claims.claim_no", { n: c.issue.claim_count })})` : ""}`);
}

function mailto(data, letter) {
  const body = [t("coll.claims.dear", { vendor: letter.vendor.name }), "", t("coll.claims.body"), "", ...lines(data, letter), "",
    ...(data.note ? [data.note, ""] : []), t("coll.claims.thanks"), data.by || "", data.library_name, letter.branch.name].join("\n");
  const subject = t("coll.claims.subject", { library: data.library_name });
  return `mailto:${encodeURIComponent(letter.vendor.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function letterHtml(data, letter, i) {
  const b = letter.branch;
  return html`<article class="card pad sc-letter" aria-labelledby="letter-${i}">
    <header class="letter-head">
      <div><strong>${data.library_name}</strong><div class="small">${b.name}</div>
        ${b.address ? html`<div class="small">${b.address}</div>` : ""}
        <div class="small muted">${[b.email, b.phone].filter(Boolean).join(" · ")}</div></div>
      <div class="small letter-date">${date(data.claimed_at, { day: "numeric", month: "long", year: "numeric" })}<div class="small muted mono">${t("coll.claims.ref", { ref: data.batch.slice(0, 8).toUpperCase() })}</div></div>
    </header>
    <div class="sc-letter-to"><div class="small muted">${t("coll.claims.to")}</div><strong>${letter.vendor.name}</strong>
      ${letter.vendor.email ? html`<div class="small">${letter.vendor.email}</div>` : ""}${letter.vendor.phone ? html`<div class="small">${letter.vendor.phone}</div>` : ""}</div>
    <h2 class="sc-letter-subject" id="letter-${i}">${t("coll.claims.heading", { count: letter.claims.length, n: num(letter.claims.length) })}</h2>
    <p>${t("coll.claims.dear", { vendor: letter.vendor.name })}</p>
    <p>${t("coll.claims.body")}</p>
    <div class="table-wrap" tabindex="0" role="region" aria-labelledby="letter-${i}"><table class="table"><caption class="sr-only">${t("coll.claims.claimed_issues")}</caption>
      <thead><tr><th scope="col">${t("coll.field.title")}</th><th scope="col">ISSN</th><th scope="col">${t("coll.claims.our_reference")}</th><th scope="col">${t("coll.ser.issue")}</th><th scope="col">${t("coll.ser.expected")}</th><th scope="col" class="num">${t("coll.ser.claim_no")}</th></tr></thead>
      <tbody>${letter.claims.map((c) => html`<tr><td>${c.subscription.title}</td><td class="mono small">${c.subscription.issn || "—"}</td>
        <td class="small">${c.subscription.vendor_reference || "—"}</td><td>${c.issue.enumeration}${c.issue.chronology ? html`<div class="small muted">${c.issue.chronology}</div>` : ""}</td>
        <td class="nowrap">${date(c.issue.expected_on)}</td><td class="num">${num(c.issue.claim_count)}</td></tr>`)}</tbody></table></div>
    ${data.note ? html`<p class="letter-note">${data.note}</p>` : ""}
    <p>${t("coll.claims.thanks")}</p>
    <p><strong>${data.by || t("coll.claims.team")}</strong><br>${data.library_name}</p>
    <div class="row tight sc-letter-actions">${letter.vendor.email ? html`<a class="btn sm" href="${mailto(data, letter)}">${icon("send")}${t("coll.claims.email", { vendor: letter.vendor.name })}</a>`
      : html`<span class="small muted">${icon("info")} ${t("coll.claims.no_email")}</span>`}</div>
  </article>`;
}

export default async function init() {
  const box = $("#claim-letters");
  $("#print-letters").addEventListener("click", () => window.print());
  try {
    const data = await api(`/serials/claims/batches/${encodeURIComponent(BOOT.path_params.batch)}`);
    box.innerHTML = data.letters.length ? html`${data.letters.map((l, i) => letterHtml(data, l, i))}` : emptyState({ title: t("coll.claims.empty") });
  } catch (e) {
    box.innerHTML = e.status === 404 ? emptyState({ art: "search", title: t("coll.claims.not_found") }) : errorState(e, { retry: false });
  }
}
