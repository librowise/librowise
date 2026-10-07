// OPAC "My account" — circulation services: hold suspension/editing, purchase suggestions, messaging preferences.
import { $, api, badge, date, empty, html, icon, modal, relative, toast, withBusy } from "/static/js/core.js";

const SUG_BADGE = { pending: "warn", accepted: "ok", ordered: "info", rejected: "bad", withdrawn: "" };
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
const day = (s) => { const [y, m, d] = s.split("-").map(Number); return date(new Date(y, m - 1, d)); };

let holdsCache = [];

// ------------------------------------------------------------------ holds

function holdRow(h) {
  const editable = h.status === "queued";
  return html`<div class="result">
    <div class="grow stack tight"><h3><a href="/record/${h.biblio.id}">${h.biblio.title}</a></h3>
      <div class="meta">Pickup at ${h.pickup_branch.name} · placed ${relative(h.created_at)}${h.item_level && h.requested_item ? ` · copy ${h.requested_item.barcode} only` : ""}</div>
      <div class="row tight">${h.suspended ? badge("warn", h.suspended_until ? `Paused until ${day(h.suspended_until)}` : "Paused") : badge(h.status)}
        ${h.status === "queued" ? html`<span class="small muted">Position ${h.queue_position} in queue</span>` : ""}
        ${h.status === "ready" ? html`<span class="small">Collect by <strong>${date(h.expires_at)}</strong></span>` : ""}
        ${h.not_needed_after ? html`<span class="small muted">Not needed after ${day(h.not_needed_after)}</span>` : ""}</div>
      ${h.notes ? html`<div class="small muted">${icon("edit")} ${h.notes}</div>` : ""}</div>
    <div class="row tight" style="align-self:center">
      ${editable && !h.item ? (h.suspended
        ? html`<button class="btn sm" data-resume-hold="${h.id}">${icon("refresh")}Resume</button>`
        : html`<button class="btn sm" data-suspend-hold="${h.id}" aria-label="Pause hold on ${h.biblio.title}">${icon("clock")}Pause</button>`) : ""}
      ${editable ? html`<button class="btn sm ghost" data-edit-hold="${h.id}" aria-label="Edit hold on ${h.biblio.title}">${icon("edit")}Edit</button>` : ""}
      <button class="btn sm danger" data-cancel-hold="${h.id}">Cancel</button></div></div>`;
}

export function holdsPanel(summary) {
  holdsCache = summary.holds;
  if (!summary.holds.length) return empty("No active holds. Place a hold from any title's page.", "bookmark");
  return html`<p class="small muted">Going away? <strong>Pause</strong> a hold to keep your place in the queue without it being filled — it resumes automatically on the date you choose.</p>
    <div class="card flush"><div class="card-body">${summary.holds.map(holdRow)}</div></div>`;
}

async function suspendHold(id, ctx) {
  const h = holdsCache.find((x) => x.id === id);
  const fd = await modal({ title: "Pause this hold", submit: "Pause hold", body: html`<div class="stack">
    <p>You keep your place in the queue for <strong>${h.biblio.title}</strong>, but it won't be filled while paused.</p>
    <div class="field"><label for="sus-until">Resume automatically on (optional)</label>
      <input id="sus-until" name="until" type="date" min="${plusDays(1)}"><span class="hint">Leave empty to pause until you resume it yourself.</span></div></div>` });
  if (!fd) return;
  await api(`/opac/me/holds/${id}/suspend`, { method: "POST", body: { until: fd.get("until") || null } });
  toast("Hold paused", "success");
  await ctx.refresh(); ctx.show("holds");
}

async function editHold(id, ctx) {
  const h = holdsCache.find((x) => x.id === id);
  const { branches } = await api("/lookups");
  const fd = await modal({ title: "Edit hold", submit: "Save", body: html`<div class="stack">
    <p><strong>${h.biblio.title}</strong></p>
    ${h.item ? "" : html`<div class="field"><label for="eh-branch">Pickup location</label><select id="eh-branch" name="pickup_branch_id">
      ${branches.map((b) => html`<option value="${b.id}" ${b.id === h.pickup_branch.id ? "selected" : ""}>${b.name}</option>`)}</select></div>`}
    <div class="field"><label for="eh-nna">Not needed after</label><input id="eh-nna" name="not_needed_after" type="date" min="${plusDays(0)}" value="${h.not_needed_after || ""}">
      <span class="hint">The hold is cancelled automatically if it isn't filled by then.</span></div>
    <div class="field"><label for="eh-notes">Note to staff</label><input id="eh-notes" name="notes" maxlength="255" value="${h.notes || ""}"></div></div>` });
  if (!fd) return;
  const body = { notes: fd.get("notes") || null, not_needed_after: fd.get("not_needed_after") || null };
  if (fd.get("pickup_branch_id")) body.pickup_branch_id = Number(fd.get("pickup_branch_id"));
  await api(`/opac/me/holds/${id}`, { method: "PATCH", body });
  toast("Hold updated", "success");
  await ctx.refresh(); ctx.show("holds");
}

// ------------------------------------------------------------------ purchase suggestions

export async function suggestionsPanel() {
  const { results } = await api("/opac/me/suggestions");
  return html`<div class="grid split">
    <div class="card flush"><div class="card-head"><h3>Your suggestions</h3></div><div class="card-body">
      ${results.length ? results.map((s) => html`<div class="result">
        <div class="grow stack tight"><h3>${s.title}</h3>
          <div class="meta">${[s.author, s.isbn, s.format].filter(Boolean).join(" · ")} · suggested ${relative(s.created_at)}</div>
          <div class="row tight">${badge(SUG_BADGE[s.status] ?? "", s.status_label)}${s.decision_note ? html`<span class="small">${s.decision_note}</span>` : ""}</div></div>
        ${s.status === "pending" ? html`<div><button class="btn sm ghost danger" data-withdraw-suggestion="${s.id}" aria-label="Withdraw suggestion ${s.title}">Withdraw</button></div>` : ""}</div>`)
        : html`<div style="padding:1rem">${empty("You haven't suggested anything yet.", "cart")}</div>`}</div></div>
    <form class="card pad stack" id="suggest-form" novalidate>
      <h3 style="margin:0">Suggest a purchase</h3>
      <p class="small muted" style="margin:0">Can't find something in the catalogue? Tell us and we'll consider buying it. We'll let you know what we decide.</p>
      <div class="field"><label for="sg-title">Title *</label><input id="sg-title" name="title" required maxlength="500"></div>
      <div class="field"><label for="sg-author">Author</label><input id="sg-author" name="author" maxlength="255"></div>
      <div class="grid cols-2">
        <div class="field"><label for="sg-isbn">ISBN</label><input id="sg-isbn" name="isbn" maxlength="20" pattern="[0-9Xx\\- ]*" inputmode="numeric"></div>
        <div class="field"><label for="sg-format">Format</label><select id="sg-format" name="format">
          ${[["book", "Book"], ["ebook", "eBook"], ["audiobook", "Audiobook"], ["dvd", "DVD"], ["serial", "Magazine / journal"], ["comic", "Comic / graphic novel"], ["other", "Other"]]
            .map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div></div>
      <div class="field"><label for="sg-reason">Why should we buy it?</label><textarea id="sg-reason" name="reason" maxlength="2000" rows="3"></textarea></div>
      <button class="btn primary">${icon("send")}Send suggestion</button></form></div>`;
}

// ------------------------------------------------------------------ messaging preferences

export async function messagingCard() {
  const r = await api("/opac/me/messaging");
  return html`<form class="card pad stack" id="messaging-form" style="margin-top:var(--gap)">
    <h3 style="margin:0">Notifications</h3>
    <p class="small muted" style="margin:0">Choose how we contact you. ${r.email ? "" : "Add an email address at the desk to receive email. "}${r.phone ? "" : "Add a mobile number at the desk to receive SMS."}</p>
    <div class="table-wrap"><table class="table"><thead><tr><th scope="col">Notice</th><th scope="col">Send by</th></tr></thead><tbody>
      ${r.results.map((p) => html`<tr><td><label for="mp-${p.code}" style="margin:0">${p.name}</label><div class="tiny muted">${p.description}</div></td>
        <td><select id="mp-${p.code}" name="${p.code}" data-pref style="width:auto">
          <option value="email" ${p.channel === "email" ? "selected" : ""} ${r.email ? "" : "disabled"}>Email</option>
          <option value="sms" ${p.channel === "sms" ? "selected" : ""} ${r.phone ? "" : "disabled"}>SMS</option>
          <option value="none" ${p.channel === "none" ? "selected" : ""}>Don't notify me</option></select></td></tr>`)}</tbody></table></div>
    <p class="tiny muted" style="margin:0">Account messages (such as registration and welcome emails) are always sent.</p></form>`;
}

// ------------------------------------------------------------------ events (wired by opac-account.js)

/** Handles this module's buttons inside the account panel. Returns true when the click was ours. */
export async function onPanelClick(e, ctx) {
  const t = e.target.closest("button");
  if (!t) return false;
  try {
    if (t.dataset.suspendHold) await suspendHold(Number(t.dataset.suspendHold), ctx);
    else if (t.dataset.resumeHold) {
      await withBusy(t, () => api(`/opac/me/holds/${t.dataset.resumeHold}/resume`, { method: "POST" }));
      toast("Hold resumed", "success");
      await ctx.refresh(); ctx.show("holds");
    } else if (t.dataset.editHold) await editHold(Number(t.dataset.editHold), ctx);
    else if (t.dataset.withdrawSuggestion) {
      await withBusy(t, () => api(`/opac/me/suggestions/${t.dataset.withdrawSuggestion}`, { method: "DELETE" }));
      toast("Suggestion withdrawn", "success");
      ctx.show("suggestions");
    } else return false;
  } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  return true;
}

export async function onPanelSubmit(e, ctx) {
  if (e.target.id !== "suggest-form") return;
  e.preventDefault();
  const f = e.target;
  if (!f.checkValidity()) { f.reportValidity(); return; }
  const d = Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, String(v).trim()]));
  try {
    await withBusy($("button", f), () => api("/opac/me/suggestions", { method: "POST", body: {
      title: d.title, author: d.author || null, isbn: d.isbn || null, format: d.format, reason: d.reason || null } }));
    toast("Thank you! We'll review your suggestion.", "success");
    ctx.show("suggestions");
  } catch { /* toasted */ }
}

export async function onPanelChange(e) {
  if (!e.target.matches("[data-pref]")) return;
  const sel = e.target;
  try {
    await api("/opac/me/messaging", { method: "PUT", body: { preferences: { [sel.name]: sel.value } } });
    toast("Notification preference saved", "success");
  } catch (err) { toast(err.message, "error"); }
}
