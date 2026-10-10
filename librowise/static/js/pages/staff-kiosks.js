// Staff › Kiosks: provision and look after self-checkout stations. Each device is a card with its status
// (online now / idle / never used / deactivated), branch and last contact, plus one actions menu. Tokens are
// shown once, with copy and "set up this device" shortcuts.
import { $, api, datetime, html, icon, modal, num, parseDate, relative, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { confirmDialog } from "/static/js/ui/dialog.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { statusPill } from "/static/js/ui/status.js";
import { menuTrigger, rowMenu } from "/static/js/pages/lib/desk-ui.js";

const TOKEN_KEY = "sw-kiosk-token";
const ONLINE_MS = 5 * 60_000;
let branches = [];
let devices = [];

function presence(d) {
  if (!d.active) return statusPill("job", "cancelled", t("desk.kiosks.st_off"));
  if (!d.last_seen_at) return statusPill("order", "draft", t("desk.kiosks.st_never"));
  return Date.now() - parseDate(d.last_seen_at) < ONLINE_MS ? statusPill("patron", "active", t("desk.kiosks.st_online")) : statusPill("issue", "expected", t("desk.kiosks.st_idle"));
}

function card(d) {
  return html`<article class="card kiosk-device ${d.active ? "" : "is-off"}" aria-labelledby="kd-${d.id}">
    <div class="kd-head"><span class="kd-icon" aria-hidden="true">${icon("monitor")}</span>
      <div class="grow"><h3 id="kd-${d.id}">${d.name}</h3><div class="small muted">${icon("map")} ${d.branch.name}</div></div>
      ${menuTrigger(html`data-device="${d.id}"`, t("desk.kiosks.actions_for", { name: d.name }))}</div>
    <div class="kd-status">${presence(d)}</div>
    <dl class="kd-facts">
      <div><dt>${t("desk.kiosks.last_seen")}</dt><dd>${d.last_seen_at ? html`<time datetime="${d.last_seen_at}" title="${datetime(d.last_seen_at)}">${relative(d.last_seen_at)}</time>` : "—"}</dd></div>
      <div><dt>${t("desk.kiosks.address")}</dt><dd class="mono">${d.last_ip || "—"}</dd></div>
      <div><dt>${t("desk.kiosks.token")}</dt><dd class="mono">${d.token_hint}…</dd></div>
    </dl></article>`;
}

async function load() {
  const box = $("#kiosk-list");
  try {
    devices = (await api("/kiosk/devices")).results;
    $("#kiosk-count").textContent = devices.length ? num(devices.length) : "";
    box.innerHTML = devices.length ? html`${devices.map(card)}`
      : html`<div class="card kiosk-empty">${emptyState({ art: "inbox", title: t("desk.kiosks.empty_title"), body: t("desk.kiosks.empty_body"),
        actions: html`<button type="button" class="btn primary" data-new>${icon("plus")}${t("desk.kiosks.new")}</button>` })}</div>`;
  } catch (e) {
    box.innerHTML = html`<div class="card kiosk-empty">${errorState(e)}</div>`;
  }
  box.removeAttribute("aria-busy");
}

async function showToken(device, title) {
  const pending = modal({ title, submit: t("desk.kiosks.done"), cancel: false, body: html`<div class="stack">
    <div class="alert warn">${icon("key")}<div>${t("desk.kiosks.token_once", { branch: device.branch.name })}</div></div>
    <div class="field"><label for="kiosk-token-out">${t("desk.kiosks.token")}</label>
      <div class="input-group"><input id="kiosk-token-out" class="mono" readonly value="${device.token}"><button type="button" class="btn" data-copy>${icon("copy")}${t("desk.kiosks.copy")}</button></div></div>
    <div class="kiosk-setup-here stack tight"><strong>${t("desk.kiosks.here_title")}</strong>
      <span class="small muted">${t("desk.kiosks.here_body")}</span>
      <button type="button" class="btn" data-setup>${icon("monitor")}${t("desk.kiosks.here_btn", { name: device.name })}</button></div></div>` });
  const dlg = [...document.querySelectorAll("dialog")].at(-1);
  dlg.addEventListener("click", async (e) => {
    if (e.target.closest("[data-copy]")) {
      const input = $("#kiosk-token-out", dlg);
      input.select();
      try { await navigator.clipboard.writeText(input.value); toast(t("desk.kiosks.copied"), "success"); } catch { document.execCommand?.("copy"); }
    }
    if (e.target.closest("[data-setup]")) {
      try { localStorage.setItem(TOKEN_KEY, device.token); } catch { toast(t("desk.kiosks.storage_blocked"), "error"); return; }
      await api("/auth/logout", { method: "POST" }).catch(() => {});
      location.href = "/kiosk";
    }
  });
  await pending;
}

async function create() {
  const fd = await modal({ title: t("desk.kiosks.new"), submit: t("desk.kiosks.create"), body: html`<div class="stack">
    <div class="field"><label for="k-name">${t("desk.kiosks.name")}</label><input id="k-name" name="name" required maxlength="120" placeholder="${t("desk.kiosks.name_placeholder")}"></div>
    <div class="field"><label for="k-branch">${t("common.branch")}</label><select id="k-branch" name="branch_id" required>
      ${branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}</select>
      <span class="hint">${t("desk.kiosks.branch_hint")}</span></div></div>` });
  if (!fd) return;
  try {
    const d = await api("/kiosk/devices", { method: "POST", body: { name: String(fd.get("name")).trim(), branch_id: Number(fd.get("branch_id")) } });
    await load();
    await showToken(d, t("desk.kiosks.created"));
  } catch (e) { toast(e.message, "error"); }
}

function openMenu(btn) {
  const d = devices.find((x) => String(x.id) === btn.dataset.device);
  if (!d) return;
  rowMenu(btn, [
    { label: t("desk.kiosks.rotate"), icon: "key", run: async () => {
      if (!(await confirmDialog(t("desk.kiosks.rotate_title"), t("desk.kiosks.rotate_body", { name: d.name }), t("desk.kiosks.rotate"), false))) return;
      try { const r = await api(`/kiosk/devices/${d.id}/rotate`, { method: "POST" }); await load(); await showToken(r, t("desk.kiosks.new_token")); }
      catch (e) { toast(e.message, "error"); }
    } },
    { label: d.active ? t("desk.kiosks.deactivate") : t("desk.kiosks.activate"), icon: d.active ? "x-circle" : "check-circle", run: async () => {
      try {
        await api(`/kiosk/devices/${d.id}`, { method: "PATCH", body: { active: !d.active } });
        toast(d.active ? t("desk.kiosks.deactivated", { name: d.name }) : t("desk.kiosks.activated", { name: d.name }), "success");
        await load();
      } catch (e) { toast(e.message, "error"); }
    } },
    { label: t("desk.kiosks.delete"), icon: "trash", danger: true, run: async () => {
      if (!(await confirmDialog(t("desk.kiosks.delete_title", { name: d.name }), t("desk.kiosks.delete_body"), t("desk.kiosks.delete")))) return;
      try { await api(`/kiosk/devices/${d.id}`, { method: "DELETE" }); toast(t("desk.kiosks.deleted", { name: d.name }), "success"); await load(); }
      catch (e) { toast(e.message, "error"); }
    } },
  ]);
}

export default async function init() {
  try { branches = (await api("/lookups")).branches; } catch { /* the create dialog shows no branches */ }
  $("#kiosk-new").addEventListener("click", create);
  $("#kiosk-list").addEventListener("click", (e) => {
    const m = e.target.closest("[data-device]");
    if (m) openMenu(m);
    else if (e.target.closest("[data-new]")) create();
    else if (e.target.closest("[data-retry]")) load();
  });
  await load();
  setInterval(() => { if (!document.hidden) load(); }, 60_000);
}
