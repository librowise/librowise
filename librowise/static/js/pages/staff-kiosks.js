// Staff: provision and manage self-checkout kiosk devices.
import { $, api, badge, confirmDialog, datetime, empty, html, icon, modal, relative, skeleton, toast, withBusy } from "/static/js/core.js";

const TOKEN_KEY = "sw-kiosk-token";
let branches = [];

function row(d) {
  const seen = d.last_seen_at ? html`<span title="${datetime(d.last_seen_at)}">${relative(d.last_seen_at)}</span>` : html`<span class="muted">never</span>`;
  return html`<tr>
    <th scope="row"><strong>${d.name}</strong><div class="tiny muted mono">${d.token_hint}…</div></th>
    <td>${d.branch.name}</td>
    <td>${d.active ? badge("ok", "Active") : badge("withdrawn", "Deactivated")}</td>
    <td class="small">${seen}${d.last_ip ? html`<div class="tiny muted mono">${d.last_ip}</div>` : ""}</td>
    <td class="right"><div class="row tight end">
      <button class="btn sm" data-act="rotate" data-id="${d.id}" aria-label="Rotate token for ${d.name}">${icon("key")}Rotate</button>
      <button class="btn sm" data-act="toggle" data-id="${d.id}" data-active="${d.active}" aria-label="${d.active ? "Deactivate" : "Activate"} ${d.name}">${d.active ? "Deactivate" : "Activate"}</button>
      <button class="btn sm danger" data-act="delete" data-id="${d.id}" aria-label="Delete ${d.name}">${icon("trash")}</button>
    </div></td></tr>`;
}

async function load() {
  const box = $("#kiosk-list");
  box.innerHTML = `<div class="card-body">${skeleton(3)}</div>`;
  try {
    const { results } = await api("/kiosk/devices");
    $("#kiosk-count").textContent = `${results.length} kiosk${results.length === 1 ? "" : "s"}`;
    box.innerHTML = results.length ? html`<div class="table-wrap"><table class="table">
      <caption class="sr-only">Self-checkout kiosks</caption>
      <thead><tr><th scope="col">Kiosk</th><th scope="col">Branch</th><th scope="col">Status</th><th scope="col">Last seen</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${results.map(row)}</tbody></table></div>` : empty("No kiosks yet. Create one to start self-service borrowing.", "monitor");
  } catch (e) {
    box.innerHTML = html`<div class="card-body"><div class="alert bad" role="alert">${icon("alert")}<div>${e.message}</div></div></div>`;
  }
}

async function showToken(device, title) {
  const p = modal({ title, submit: "Done", body: html`<div class="stack">
    <div class="alert warn">${icon("key")}<div>Copy this token now — for security it is shown only once. Anyone with it can run a kiosk for <strong>${device.branch.name}</strong>.</div></div>
    <div class="field"><label for="kiosk-token-out">Kiosk token</label>
      <div class="input-group"><input id="kiosk-token-out" class="mono" readonly value="${device.token}"><button type="button" class="btn" data-copy>${icon("copy")}Copy</button></div></div>
    <div class="card pad stack tight"><strong>Working on the kiosk station right now?</strong>
      <span class="small muted">Store the token in this browser, sign out of your staff account and open the kiosk screen.</span>
      <button type="button" class="btn primary" data-setup>${icon("monitor")}Set up this device as “${device.name}”</button></div></div>` });
  const dlg = document.querySelector("dialog:last-of-type");
  dlg.addEventListener("click", async (e) => {
    if (e.target.closest("[data-copy]")) {
      const input = $("#kiosk-token-out", dlg);
      input.select();
      try { await navigator.clipboard.writeText(input.value); toast("Token copied", "success"); } catch { document.execCommand?.("copy"); }
    }
    if (e.target.closest("[data-setup]")) {
      try { localStorage.setItem(TOKEN_KEY, device.token); } catch { toast("This browser blocks local storage; paste the token on the kiosk screen instead.", "error"); return; }
      await api("/auth/logout", { method: "POST" }).catch(() => {});
      location.href = "/kiosk";
    }
  });
  $("#kiosk-token-out", dlg).select();
  await p;
}

async function create() {
  const fd = await modal({ title: "New kiosk", submit: "Create kiosk", body: html`<div class="stack">
    <div class="field"><label for="k-name">Name</label><input id="k-name" name="name" required maxlength="120" placeholder="e.g. Ground floor, by the entrance"></div>
    <div class="field"><label for="k-branch">Branch</label><select id="k-branch" name="branch_id" required>
      ${branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}</select>
      <span class="hint">Loans made at this kiosk are recorded against this branch and use its circulation rules.</span></div></div>` });
  if (!fd) return;
  try {
    const d = await api("/kiosk/devices", { method: "POST", body: { name: fd.get("name"), branch_id: Number(fd.get("branch_id")) } });
    await load();
    await showToken(d, "Kiosk created");
  } catch (e) { toast(e.message, "error"); }
}

export default async function init() {
  try { branches = (await api("/lookups")).branches; } catch (e) { toast(e.message, "error"); }
  $("#kiosk-new").addEventListener("click", create);
  $("#kiosk-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    try {
      if (b.dataset.act === "rotate") {
        if (!(await confirmDialog("Rotate token?", "The kiosk stops working until you enter the new token on it. Any patron signed in there is signed out.", "Rotate token"))) return;
        const d = await withBusy(b, () => api(`/kiosk/devices/${id}/rotate`, { method: "POST" }));
        await load();
        await showToken(d, "New token");
      } else if (b.dataset.act === "toggle") {
        const active = b.dataset.active !== "true";
        await withBusy(b, () => api(`/kiosk/devices/${id}`, { method: "PATCH", body: { active } }));
        toast(active ? "Kiosk activated" : "Kiosk deactivated", "success");
        await load();
      } else if (b.dataset.act === "delete") {
        if (!(await confirmDialog("Delete kiosk?", "The device is removed and its token stops working immediately. Loans made there are kept.", "Delete"))) return;
        await withBusy(b, () => api(`/kiosk/devices/${id}`, { method: "DELETE" }));
        toast("Kiosk deleted", "success");
        await load();
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
  await load();
}
