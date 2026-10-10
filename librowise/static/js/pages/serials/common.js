// Serials: shared status pills, humanised labels and dialogs (claims, renewals).
import { api, date, html, num, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { statusPill } from "/static/js/ui/status.js";
import { formModal, isoDay, str } from "/static/js/pages/lib/sc-ui.js";

export const issueBadge = (s) => statusPill("issue", s);
const SUB_TONE = { active: "success", expired: "warning", cancelled: "neutral" };
export const subBadge = (s) => html`<span class="badge pill ${SUB_TONE[s] || "neutral"}"><span class="dot" aria-hidden="true"></span>${t(`coll.ser.sub_${s}`, {}, s)}</span>`;
/** "Monthly", "Every 3 weeks"… from the frequency key and interval. */
export const freqLabel = (s) => t(`coll.freq.${s.frequency}`, { n: num(s.frequency_interval || 1) }, s.frequency_label || s.frequency);

/** "Ends in 12 days" style pill with urgency colour. */
export function endsBadge(sub) {
  if (!sub.end_date) return html`<span class="muted small">${t("coll.ser.open_ended")}</span>`;
  const d = sub.days_to_end;
  if (d < 0) return statusPill("loan", "overdue", t("coll.ser.ended_on", { date: date(sub.end_date) }));
  if (d === 0) return statusPill("loan", "due_soon", t("coll.ser.ends_today"));
  if (d <= 30) return statusPill("loan", "due_soon", t("coll.ser.ends_in", { count: d, n: num(d) }));
  if (d <= 60) return statusPill("hold", "ready", t("coll.ser.ends_on", { date: date(sub.end_date) }));
  return html`<span class="small">${date(sub.end_date)}</span>`;
}

/** Confirm and record claims for the given issues. Navigates to the claim letter when asked. */
export async function claimDialog(issues) {
  const vendors = [...new Set(issues.map((i) => i.vendorName || t("coll.ser.no_vendor")))];
  const body = html`<div class="stack">
    <p>${t("coll.ser.claim_intro", { count: issues.length, n: num(issues.length), vendors: vendors.join(", ") })}</p>
    <ul class="small sc-claim-list">${issues.slice(0, 8).map((i) => html`<li>${i.title ? html`${i.title} — ` : ""}<strong>${i.enumeration}</strong>
      <span class="muted">(${t("coll.ser.expected_on", { date: date(i.expected_on) })}${i.claim_count ? ` · ${t("coll.ser.claimed_times", { count: i.claim_count, n: num(i.claim_count) })}` : ""})</span></li>`)}
      ${issues.length > 8 ? html`<li class="muted">${t("coll.ser.and_more", { n: num(issues.length - 8) })}</li>` : ""}</ul>
    <div class="field"><label for="cl-note">${t("coll.ser.vendor_note")}<span class="optional">${t("ui.form.optional")}</span></label>
      <textarea id="cl-note" name="note" maxlength="500" placeholder="${t("coll.ser.vendor_note_ph")}"></textarea></div>
    <label class="checkbox"><input type="checkbox" name="open_letter" checked> ${t("coll.ser.open_letters", { count: vendors.length })}</label>
  </div>`;
  let openLetter = true;
  const r = await formModal({ title: t("coll.ser.claim_title"), body, submit: t("coll.ser.record_claims") }, (fd) => {
    openLetter = !!fd.get("open_letter");
    return api("/serials/claims", { method: "POST", body: { issue_ids: issues.map((i) => i.id), note: str(fd, "note") || null } });
  });
  if (!r) return null;
  toast(t("coll.ser.claims_recorded", { count: r.claimed, n: num(r.claimed), vendors: num(r.vendors) }), "success");
  if (openLetter) location.href = r.letter_url;
  return r;
}

/** Renew a subscription to a new end date (defaults to one year after the current end). */
export async function renewDialog(sub) {
  const base = sub.end_date ? new Date(`${sub.end_date}T00:00:00`) : new Date();
  if (base < new Date()) base.setTime(Date.now());
  base.setFullYear(base.getFullYear() + 1);
  const body = html`<div class="stack">
    <p>${t("coll.ser.renew_intro", { title: sub.biblio.title })} ${sub.vendor ? t("coll.ser.renew_with", { vendor: sub.vendor.name }) : ""}
      ${sub.end_date ? t("coll.ser.currently_ends", { date: date(sub.end_date) }) : ""} ${t("coll.ser.renew_predict")}</p>
    <div class="field"><label for="rn-end">${t("coll.ser.new_end")}</label><input id="rn-end" name="end_date" type="date" required value="${isoDay(base)}"></div>
  </div>`;
  const r = await formModal({ title: t("coll.ser.renew_title"), body, submit: t("coll.ser.renew"), size: "sm" },
    (fd) => api(`/serials/subscriptions/${sub.id}/renew`, { method: "POST", body: { end_date: fd.get("end_date") } }));
  if (r) toast(t("coll.ser.renewed", { date: date(r.end_date), count: r.created, n: num(r.created) }), "success");
  return r;
}
