// Serials: shared badges and dialogs (claims, renewals).
import { api, badge, date, html, toast } from "/static/js/core.js";
import { formModal, isoDay, plural, str } from "/static/js/pages/lib/sc-ui.js";

export const ISSUE_STATUS = {
  expected: ["info", "Expected"], arrived: ["ok", "Arrived"], late: ["warn", "Late"], claimed: ["ai", "Claimed"],
  missing: ["bad", "Missing"], not_published: ["", "Not published"],
};
export const issueBadge = (s) => badge(...(ISSUE_STATUS[s] || ["", s]));
const SUB_STATUS = { active: ["ok", "Active"], expired: ["warn", "Expired"], cancelled: ["bad", "Cancelled"] };
export const subBadge = (s) => badge(...(SUB_STATUS[s] || ["", s]));

/** "ends in 12 days" style label with a badge colour for renewal urgency. */
export function endsBadge(sub) {
  if (!sub.end_date) return html`<span class="muted small">Open-ended</span>`;
  const d = sub.days_to_end;
  if (d < 0) return badge("bad", `Ended ${date(sub.end_date)}`);
  if (d <= 30) return badge("warn", `Ends in ${plural(d, "day")}`);
  if (d <= 60) return badge("info", `Ends ${date(sub.end_date)}`);
  return html`<span class="small">${date(sub.end_date)}</span>`;
}

/** Confirm and record claims for the given issue ids. Navigates to the claim letter when asked. */
export async function claimDialog(issues) {
  const vendors = [...new Set(issues.map((i) => i.vendorName || "No vendor"))];
  const body = html`<div class="stack">
    <p style="margin:0">Claim <strong>${plural(issues.length, "issue")}</strong> from ${vendors.join(", ")}.
      Each claim is recorded with today's date and the issue is marked <em>claimed</em>.</p>
    <ul class="small sc-claim-list">${issues.slice(0, 8).map((i) => html`<li>${i.title ? html`${i.title} — ` : ""}<strong>${i.enumeration}</strong>
      <span class="muted">(expected ${date(i.expected_on)}${i.claim_count ? `, claimed ${i.claim_count}×` : ""})</span></li>`)}
      ${issues.length > 8 ? html`<li class="muted">…and ${issues.length - 8} more</li>` : ""}</ul>
    <div class="field"><label for="cl-note">Note for the vendor <span class="muted">(optional)</span></label>
      <textarea id="cl-note" name="note" maxlength="500" placeholder="e.g. Please send replacement copies to the Central Library."></textarea></div>
    <label class="checkbox"><input type="checkbox" name="open_letter" checked> Open the printable claim letter${vendors.length > 1 ? "s" : ""} afterwards</label>
  </div>`;
  let openLetter = true;
  const r = await formModal({ title: "Claim issues from vendor", body, submit: "Record claims" }, (fd) => {
    openLetter = !!fd.get("open_letter");
    return api("/serials/claims", { method: "POST", body: { issue_ids: issues.map((i) => i.id), note: str(fd, "note") || null } });
  });
  if (!r) return null;
  toast(`Recorded ${plural(r.claimed, "claim")} for ${plural(r.vendors, "vendor")}`, "success");
  if (openLetter) location.href = r.letter_url;
  return r;
}

/** Renew a subscription to a new end date (defaults to one year after the current end). */
export async function renewDialog(sub) {
  const base = sub.end_date ? new Date(`${sub.end_date}T00:00:00`) : new Date();
  if (base < new Date()) base.setTime(Date.now());
  base.setFullYear(base.getFullYear() + 1);
  const body = html`<div class="stack">
    <p style="margin:0">Renew <strong>${sub.biblio.title}</strong>${sub.vendor ? html` with ${sub.vendor.name}` : ""}.
      ${sub.end_date ? html`Currently ends ${date(sub.end_date)}.` : ""} Issues are predicted up to the new end date.</p>
    <div class="field"><label for="rn-end">New end date</label><input id="rn-end" name="end_date" type="date" required value="${isoDay(base)}"></div>
  </div>`;
  const r = await formModal({ title: "Renew subscription", body, submit: "Renew" },
    (fd) => api(`/serials/subscriptions/${sub.id}/renew`, { method: "POST", body: { end_date: fd.get("end_date") } }));
  if (r) toast(`Renewed until ${date(r.end_date)} · ${plural(r.created, "new issue")} predicted`, "success");
  return r;
}
