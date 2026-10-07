// OPAC "My account" — circulation services: holds (pause/resume, edit, cancel), purchase suggestions and
// messaging preferences. Rendered into the account panel; events are delegated from opac-account.js.
import { $, api, confirmDialog, cover, date, html, icon, modal, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { emptyState } from "/static/js/ui/empty.js";
import { statusPill } from "/static/js/ui/status.js";

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
const day = (s) => { const [y, m, d] = s.split("-").map(Number); return date(new Date(y, m - 1, d)); };
const FORMATS = ["book", "ebook", "audiobook", "dvd", "serial", "comic", "other"];
// Notice types a reader can choose a channel for (services/notices.py CODES) → translated name / _desc.
const NOTICES = { HOLD_READY: "opac.acct.n_hold_ready", DUE_SOON: "opac.acct.n_due_soon", OVERDUE: "opac.acct.n_overdue",
  PURCHASE_SUGGESTION_UPDATE: "opac.acct.n_suggestion" };

let holdsCache = [];

// ------------------------------------------------------------------ holds

function holdRow(h) {
  const queued = h.status === "queued";
  const ready = h.status === "ready";
  const b = h.biblio;
  const meta = [t("opac.account.pickup_at", { branch: h.pickup_branch.name }), t("opac.account.placed", { when: relative(h.created_at) }),
    h.item_level && h.requested_item ? t("opac.acct.copy_only", { barcode: h.requested_item.barcode }) : ""].filter(Boolean).join(" · ");
  let state;
  if (ready) state = html`${statusPill("hold", "ready")}<span>${t("opac.acct.collect_by", { date: date(h.expires_at) })}</span>`;
  else if (h.suspended) state = html`${statusPill("hold", "suspended", h.suspended_until ? t("opac.acct.paused_until", { date: day(h.suspended_until) }) : t("opac.acct.paused"))}`;
  else state = html`${statusPill("hold", h.status)}${queued ? html`<span>${t("opac.acct.queue_pos", { n: h.queue_position || 1 })}</span>` : ""}`;
  return html`<li class="item-row ${ready ? "is-ready" : ""}">
    <a href="/record/${b.id}" tabindex="-1" aria-hidden="true">${cover(b)}</a>
    <div style="min-width:0"><h3><a href="/record/${b.id}">${b.title}</a></h3>
      <div class="ir-meta">${meta}</div>
      <div class="ir-tags">${state}${h.not_needed_after ? html`<span class="muted">${t("opac.acct.not_needed_after", { date: day(h.not_needed_after) })}</span>` : ""}</div>
      ${h.notes ? html`<div class="small muted" style="margin-top:.3rem">${icon("edit")} ${h.notes}</div>` : ""}</div>
    <div class="ir-actions">
      ${queued && !h.item ? (h.suspended
        ? html`<button type="button" class="btn sm" data-resume-hold="${h.id}" aria-label="${t("opac.acct.resume_title", { title: b.title })}">${icon("refresh")}${t("opac.acct.resume")}</button>`
        : html`<button type="button" class="btn sm" data-suspend-hold="${h.id}" aria-label="${t("opac.acct.pause_title", { title: b.title })}">${icon("clock")}${t("opac.acct.pause")}</button>`) : ""}
      ${queued ? html`<button type="button" class="btn sm ghost" data-edit-hold="${h.id}" aria-label="${t("opac.acct.edit_title", { title: b.title })}">${icon("edit")}${t("opac.acct.edit")}</button>` : ""}
      <span class="sep" aria-hidden="true"></span>
      <button type="button" class="btn sm ghost danger" data-cancel-hold="${h.id}" aria-label="${t("opac.account.cancel_hold_title", { title: b.title })}">${icon("x")}${t("opac.acct.cancel")}</button></div></li>`;
}

export function holdsPanel(summary) {
  holdsCache = summary.holds;
  const head = html`<div class="panel-head"><div><h2>${t("opac.acct.tab_holds")}</h2><p class="sub">${t("opac.acct.holds_sub", { count: summary.holds.length })}</p></div>
    <a class="btn" href="/search">${icon("search")}${t("opac.acct.find_more")}</a></div>`;
  if (!summary.holds.length) return html`${head}${emptyState({ art: "inbox", title: t("opac.acct.no_holds_title"), body: t("opac.account.no_holds") })}`;
  const ready = summary.holds.filter((h) => h.status === "ready");
  const waiting = summary.holds.filter((h) => h.status !== "ready");
  return html`${head}
    ${ready.length ? html`<h3 class="group-title">${icon("check-circle")}${t("opac.acct.group_ready")} <span class="badge info">${ready.length}</span></h3><ul class="item-list">${ready.map(holdRow)}</ul>` : ""}
    ${waiting.length ? html`<h3 class="group-title">${t("opac.acct.group_waiting")} <span class="badge neutral">${waiting.length}</span></h3>
      <p class="tip">${icon("info")}<span>${t("opac.acct.pause_tip")}</span></p><ul class="item-list">${waiting.map(holdRow)}</ul>` : ""}`;
}

async function suspendHold(id, ctx) {
  const h = holdsCache.find((x) => x.id === id);
  const fd = await modal({ title: t("opac.acct.pause_q"), submit: t("opac.acct.pause_hold"), body: html`<div class="stack">
    <p style="margin:0">${t("opac.acct.pause_intro", { title: h.biblio.title })}</p>
    <div class="field"><label for="sus-until">${t("opac.acct.resume_on")}</label>
      <input id="sus-until" name="until" type="date" min="${plusDays(1)}" aria-describedby="sus-hint"><span class="hint" id="sus-hint">${t("opac.acct.resume_on_hint")}</span></div></div>` });
  if (!fd) return;
  await api(`/opac/me/holds/${id}/suspend`, { method: "POST", body: { until: fd.get("until") || null } });
  toast(t("opac.acct.hold_paused"), "success");
  await ctx.refresh(); await ctx.show("holds");
}

async function editHold(id, ctx) {
  const h = holdsCache.find((x) => x.id === id);
  const { branches } = await api("/lookups");
  const fd = await modal({ title: t("opac.acct.edit_hold"), submit: t("common.save"), body: html`<div class="stack">
    <p style="margin:0"><strong>${h.biblio.title}</strong></p>
    ${h.item ? "" : html`<div class="field"><label for="eh-branch">${t("opac.record.pickup")}</label><select id="eh-branch" name="pickup_branch_id">
      ${branches.map((b) => html`<option value="${b.id}" ${b.id === h.pickup_branch.id ? "selected" : ""}>${b.name}</option>`)}</select></div>`}
    <div class="field"><label for="eh-nna">${t("opac.rec.hold_nna")}</label><input id="eh-nna" name="not_needed_after" type="date" min="${plusDays(0)}" value="${h.not_needed_after || ""}" aria-describedby="eh-nna-hint">
      <span class="hint" id="eh-nna-hint">${t("opac.rec.hold_nna_hint")}</span></div>
    <div class="field"><label for="eh-notes">${t("opac.record.hold_note")}</label><input id="eh-notes" name="notes" maxlength="255" value="${h.notes || ""}"></div></div>` });
  if (!fd) return;
  const body = { notes: fd.get("notes") || null, not_needed_after: fd.get("not_needed_after") || null };
  if (fd.get("pickup_branch_id")) body.pickup_branch_id = Number(fd.get("pickup_branch_id"));
  await api(`/opac/me/holds/${id}`, { method: "PATCH", body });
  toast(t("opac.acct.hold_updated"), "success");
  await ctx.refresh(); await ctx.show("holds");
}

async function cancelHold(id, ctx) {
  const h = holdsCache.find((x) => x.id === id);
  const text = h?.status === "ready" ? t("opac.acct.cancel_ready_text") : t("opac.account.cancel_hold_text");
  if (!(await confirmDialog(t("opac.account.cancel_hold_q"), `${h ? `“${h.biblio.title}” — ` : ""}${text}`, t("opac.account.cancel_hold")))) return;
  await api(`/opac/me/holds/${id}`, { method: "DELETE" });
  toast(t("opac.account.hold_cancelled"), "success");
  await ctx.refresh(); await ctx.show("holds");
}

// ------------------------------------------------------------------ purchase suggestions

export async function suggestionsPanel() {
  const { results } = await api("/opac/me/suggestions");
  return html`<div class="panel-head"><div><h2>${t("opac.acct.tab_suggestions")}</h2><p class="sub">${t("opac.acct.suggest_sub")}</p></div></div>
  <div class="grid split" style="align-items:start">
    <section aria-labelledby="sg-yours"><h3 class="group-title" id="sg-yours">${t("opac.acct.your_suggestions")}</h3>
      ${results.length ? html`<ul class="item-list">${results.map((s) => html`<li class="item-row no-cover">
        <div style="min-width:0"><h3>${s.title}</h3>
          <div class="ir-meta">${[s.author, s.isbn, s.format ? t(`format.${s.format}`, {}, s.format) : ""].filter(Boolean).join(" · ")} · ${t("opac.acct.suggested", { when: relative(s.created_at) })}</div>
          <div class="ir-tags">${statusPill("suggestion", s.status)}${s.decision_note ? html`<span class="small">${s.decision_note}</span>` : ""}</div></div>
        ${s.status === "pending" ? html`<div class="ir-actions"><button type="button" class="btn sm ghost danger" data-withdraw-suggestion="${s.id}" aria-label="${t("opac.acct.withdraw_title", { title: s.title })}">${t("opac.acct.withdraw")}</button></div>` : ""}</li>`)}</ul>`
        : emptyState({ art: "inbox", compact: true, title: t("opac.acct.no_suggestions") })}</section>
    <form class="card pad stack" id="suggest-form" novalidate aria-labelledby="sg-new">
      <h3 id="sg-new" style="margin:0">${t("opac.acct.suggest_title")}</h3>
      <p class="small muted" style="margin:0">${t("opac.acct.suggest_intro")}</p>
      <div class="field"><label for="sg-title">${t("opac.acct.sg_title")}<span class="req" aria-hidden="true">*</span></label><input id="sg-title" name="title" required maxlength="500" aria-describedby="sg-title-err"><div class="field-error" id="sg-title-err" hidden></div></div>
      <div class="field"><label for="sg-author">${t("opac.acct.sg_author")}</label><input id="sg-author" name="author" maxlength="255"></div>
      <div class="grid cols-2">
        <div class="field"><label for="sg-isbn">ISBN</label><input id="sg-isbn" name="isbn" maxlength="20" pattern="[0-9Xx\\- ]*" inputmode="numeric"></div>
        <div class="field"><label for="sg-format">${t("opac.acct.sg_format")}</label><select id="sg-format" name="format">
          ${FORMATS.map((v) => html`<option value="${v}">${v === "other" ? t("opac.acct.sg_other") : t(`format.${v}`)}</option>`)}</select></div></div>
      <div class="field"><label for="sg-reason">${t("opac.acct.sg_reason")}</label><textarea id="sg-reason" name="reason" maxlength="2000" rows="3"></textarea></div>
      <div><button class="btn primary" type="submit">${icon("send")}${t("opac.acct.sg_send")}</button></div></form></div>`;
}

// ------------------------------------------------------------------ messaging preferences

/** Notification preferences (rendered inside the Settings "Notifications" section). */
export async function messagingSection() {
  const r = await api("/opac/me/messaging");
  const missing = [r.email ? "" : t("opac.acct.add_email"), r.phone ? "" : t("opac.acct.add_phone")].filter(Boolean).join(" ");
  return html`<form id="messaging-form" class="stack">
    ${missing ? html`<p class="tip" style="margin:0">${icon("info")}<span>${missing}</span></p>` : ""}
    <div class="pref-table">${r.results.map((p) => html`<div class="pref-row"><label for="mp-${p.code}">${NOTICES[p.code] ? t(`${NOTICES[p.code]}`) : p.name}<span class="tiny">${NOTICES[p.code] ? t(`${NOTICES[p.code]}_desc`) : p.description}</span></label>
      <select id="mp-${p.code}" name="${p.code}" data-pref>
        <option value="email" ${p.channel === "email" ? "selected" : ""} ${r.email ? "" : "disabled"}>${t("opac.acct.by_email")}</option>
        <option value="sms" ${p.channel === "sms" ? "selected" : ""} ${r.phone ? "" : "disabled"}>${t("opac.acct.by_sms")}</option>
        <option value="none" ${p.channel === "none" ? "selected" : ""}>${t("opac.acct.by_none")}</option></select></div>`)}</div>
    <p class="tiny muted" style="margin:0">${t("opac.acct.always_sent")}</p></form>`;
}
/** @deprecated kept for compatibility: the messaging card as a standalone card. */
export async function messagingCard() {
  return html`<section class="card pad stack" style="margin-top:var(--gap)"><h3 style="margin:0">${t("opac.acct.set_notify")}</h3>${await messagingSection()}</section>`;
}

// ------------------------------------------------------------------ events (wired by opac-account.js)

/** Handles this module's buttons inside the account panel. Returns true when the click was ours. */
export async function onPanelClick(e, ctx) {
  const b = e.target.closest("button");
  if (!b) return false;
  try {
    if (b.dataset.suspendHold) await suspendHold(Number(b.dataset.suspendHold), ctx);
    else if (b.dataset.resumeHold) {
      await withBusy(b, () => api(`/opac/me/holds/${b.dataset.resumeHold}/resume`, { method: "POST" }));
      toast(t("opac.acct.hold_resumed"), "success");
      await ctx.refresh(); await ctx.show("holds");
    } else if (b.dataset.editHold) await editHold(Number(b.dataset.editHold), ctx);
    else if (b.dataset.cancelHold) await cancelHold(Number(b.dataset.cancelHold), ctx);
    else if (b.dataset.withdrawSuggestion) {
      if (!(await confirmDialog(t("opac.acct.withdraw_q"), t("opac.acct.withdraw_text"), t("opac.acct.withdraw")))) return true;
      await withBusy(b, () => api(`/opac/me/suggestions/${b.dataset.withdrawSuggestion}`, { method: "DELETE" }));
      toast(t("opac.acct.suggestion_withdrawn"), "success");
      await ctx.show("suggestions");
    } else return false;
  } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  return true;
}

export async function onPanelSubmit(e, ctx) {
  if (e.target.id !== "suggest-form") return;
  e.preventDefault();
  const f = e.target;
  const title = $("#sg-title", f), err = $("#sg-title-err", f);
  if (!title.value.trim()) {
    title.setAttribute("aria-invalid", "true");
    err.hidden = false;
    err.innerHTML = html`${icon("alert")}<span>${t("opac.acct.sg_title_needed")}</span>`;
    title.focus();
    return;
  }
  title.removeAttribute("aria-invalid");
  err.hidden = true;
  if (!f.checkValidity()) { f.reportValidity(); return; }
  const d = Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, String(v).trim()]));
  try {
    await withBusy($("button[type=submit]", f), () => api("/opac/me/suggestions", { method: "POST", body: {
      title: d.title, author: d.author || null, isbn: d.isbn || null, format: d.format, reason: d.reason || null } }));
    toast(t("opac.acct.suggestion_thanks"), "success");
    await ctx.show("suggestions");
  } catch { /* toasted */ }
}

export async function onPanelChange(e) {
  if (!e.target.matches("[data-pref]")) return;
  const sel = e.target;
  try {
    await api("/opac/me/messaging", { method: "PUT", body: { preferences: { [sel.name]: sel.value } } });
    toast(t("opac.acct.pref_saved"), "success");
  } catch (err) { toast(err.message, "error"); }
}
