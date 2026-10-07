// One status → tone mapping for the whole product. Always render statuses through statusPill() so an
// item "on loan" looks the same on the desk, the record page, the OPAC and in reports.
//
//   statusPill("item", "on_loan")       → amber "On loan"
//   statusPill("hold", "ready")         → blue "Ready for pickup"
//   statusPill("loan", "overdue")       → red "Overdue"
//   statusPill("job", "dead", "Gave up") → custom label, standard tone
//
// Tones: success · warning · danger · info · neutral · ai. Every pill carries text (never colour alone) and
// a dot; the CSS lives in app.css (.badge) and ui.css (.pill).
import { html, statusLabel } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

export const STATUS = {
  item: { available: "success", on_loan: "warning", on_hold_shelf: "info", in_transit: "info", processing: "info",
    lost: "danger", damaged: "danger", withdrawn: "neutral", missing: "danger" },
  hold: { queued: "warning", ready: "info", fulfilled: "success", cancelled: "neutral", expired: "neutral", suspended: "neutral" },
  loan: { active: "info", due_soon: "warning", overdue: "danger", returned: "success", lost: "danger" },
  order: { draft: "neutral", ordered: "info", partial: "warning", received: "success", cancelled: "neutral" },
  suggestion: { pending: "warning", accepted: "info", ordered: "info", rejected: "neutral", withdrawn: "neutral" },
  notice: { pending: "warning", sent: "success", failed: "danger" },
  job: { queued: "neutral", running: "info", succeeded: "success", failed: "warning", dead: "danger", cancelled: "neutral" },
  patron: { active: "success", expiring: "warning", expired: "danger", inactive: "neutral", owing: "warning", staff: "info" },
  issue: { expected: "neutral", arrived: "success", late: "warning", missing: "danger", claimed: "info", not_published: "neutral" },
  registration: { pending: "warning", approved: "success", rejected: "neutral" },
};

const LABELS = {
  active: "Active", due_soon: "Due soon", overdue: "Overdue", returned: "Returned", draft: "Draft", ordered: "Ordered",
  partial: "Partly received", received: "Received", pending: "Pending", accepted: "Accepted", rejected: "Rejected",
  sent: "Sent", failed: "Failed", running: "Running", succeeded: "Succeeded", dead: "Gave up", expiring: "Expiring soon",
  inactive: "Inactive", owing: "Owes money", staff: "Staff", suspended: "Suspended", expected: "Expected", arrived: "Arrived",
  late: "Late", missing: "Missing", claimed: "Claimed", not_published: "Not published", approved: "Approved",
};

export const toneOf = (kind, value) => STATUS[kind]?.[value] || "neutral";

/** Translated label: status.<value> (shared catalog) → ui.status.<value> → English fallback. */
export function statusText(value) {
  const shared = statusLabel(value);
  if (shared !== value) return shared;
  return t(`ui.status.${value}`, {}, LABELS[value] || String(value).replace(/_/g, " "));
}

export function statusPill(kind, value, label) {
  const tone = toneOf(kind, value);
  return html`<span class="badge pill ${tone}" data-status="${kind}:${value}"><span class="dot" aria-hidden="true"></span>${label || statusText(value)}</span>`;
}
