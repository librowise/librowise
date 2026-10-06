// Staff: holds queue, pull list and pickup shelf.
import {
  $, $$, BOOT, api, authors, availabilityBadge, badge, confirmDialog, date, datetime, debounce, empty, html, icon,
  modal, qs, relative, skeleton, toast, withBusy, parseDate } from "/static/js/core.js";

const state = { tab: "queue", branch: "", branches: [] };
const panel = () => $("#holds-panel");

// ------------------------------------------------------------------ small helpers

/** Wire a `.tabs` tablist: click + arrow-key navigation. Returns a function that selects a tab by key. */
function setupTabs(root, onSelect) {
  const tabs = $$('[role="tab"]', root);
  const select = (tab, focus = false) => {
    tabs.forEach((t) => { const on = t === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
    $(`#${tab.getAttribute("aria-controls")}`)?.setAttribute("aria-labelledby", tab.id);
    if (focus) tab.focus();
    onSelect(tab.dataset.tab);
  };
  root.addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t) select(t); });
  root.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
  return (key) => { const t = tabs.find((x) => x.dataset.tab === key); if (t) select(t); return !!t; };
}

/** Modal form that stays open until `action(FormData)` succeeds (errors are toasted). Resolves to the result or null. */
function formModal(opts, action, setup) {
  let result = null;
  const done = modal(opts);
  const dlg = $$("dialog").at(-1);
  const form = $("form", dlg);
  const ok = $('button[value="ok"]', dlg);
  // Enter in a text field should submit, not trigger the dialog's first (close) button.
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT" && !("noSubmit" in e.target.dataset)) {
      e.preventDefault();
      form.requestSubmit(ok);
    }
  });
  form.addEventListener("submit", async (e) => {
    if (e.submitter !== ok) return;
    e.preventDefault();
    if (!form.checkValidity()) return;
    try {
      result = await withBusy(ok, () => action(new FormData(form), dlg));
      dlg.close("ok");
    } catch { /* toast already shown by withBusy */ }
  });
  setup?.(dlg);
  return done.then(() => result);
}

const errorBox = (msg) => html`<div class="card-body"><div class="alert bad" role="alert">${icon("alert")}<div>${msg}</div></div></div>`;

// ------------------------------------------------------------------ renderers

const titleCell = (b) => html`<a href="/staff/catalog/${b.id}">${b.title}</a>
  ${b.authors?.length ? html`<div class="tiny muted">${authors(b.authors)}</div>` : ""}`;
const patronCell = (p) => html`<a href="/staff/patrons/${p.id}">${p.full_name}</a><div class="tiny muted mono">${p.card_number}</div>`;
const cancelBtn = (h) => html`<button class="btn sm danger" data-cancel="${h.id}" data-title="${h.biblio.title}"
  aria-label="Cancel hold on ${h.biblio.title} for ${h.patron.full_name}">${icon("x")}Cancel</button>`;

// ---- circulation services: suspension, item-level holds, "not needed after"
const dayStr = (s) => { const [y, m, d] = s.split("-").map(Number); return date(new Date(y, m - 1, d)); };

function holdStatusCell(h) {
  return html`${h.suspended ? badge("warn", h.suspended_until ? `Suspended until ${dayStr(h.suspended_until)}` : "Suspended") : badge(h.status)}
    ${h.item ? html`<div class="tiny muted mono">${h.item.barcode}</div>` : ""}
    ${h.item_level && h.requested_item ? html`<div class="tiny"><span class="badge info">Copy ${h.requested_item.barcode} only</span></div>` : ""}
    ${h.not_needed_after ? html`<div class="tiny muted">Not needed after ${dayStr(h.not_needed_after)}</div>` : ""}`;
}

function holdActions(h) {
  if (h.status !== "queued") return "";
  const label = `${h.biblio.title} for ${h.patron.full_name}`;
  return html`${h.item ? "" : h.suspended
    ? html`<button class="btn sm" data-resume="${h.id}" aria-label="Resume hold on ${label}">${icon("refresh")}Resume</button> `
    : html`<button class="btn sm" data-suspend="${h.id}" aria-label="Suspend hold on ${label}">${icon("clock")}Suspend</button> `}
    <button class="btn sm ghost" data-edit="${h.id}" aria-label="Edit hold on ${label}">${icon("edit")}</button> `;
}

async function suspendHold(id) {
  const fd = await modal({ title: "Suspend hold", submit: "Suspend", body: html`<div class="stack">
    <p class="small muted">The hold keeps its queue position but is skipped when copies are returned.</p>
    <div class="field"><label for="sh-until">Resume automatically on (optional)</label><input id="sh-until" name="until" type="date">
      <span class="hint">Leave empty to suspend until resumed manually.</span></div></div>` });
  if (!fd) return;
  try {
    await api(`/holds/${id}/suspend`, { method: "POST", body: { until: fd.get("until") || null } });
    toast("Hold suspended", "success");
    load();
  } catch (e) { toast(e.message, "error"); }
}

async function editHold(id) {
  const { results } = await fetchers.queue();
  const h = results.find((x) => x.id === id);
  if (!h) return;
  const fd = await modal({ title: "Edit hold", submit: "Save", body: html`<div class="stack">
    <p><strong>${h.biblio.title}</strong> · ${h.patron.full_name}</p>
    ${h.item ? "" : html`<div class="field"><label for="eh-br">Pickup branch</label><select id="eh-br" name="pickup_branch_id">${state.branches.map((b) =>
      html`<option value="${b.id}" ${b.id === h.pickup_branch.id ? "selected" : ""}>${b.name}</option>`)}</select></div>`}
    <div class="field"><label for="eh-nna">Not needed after</label><input id="eh-nna" name="not_needed_after" type="date" value="${h.not_needed_after || ""}"></div>
    <div class="field"><label for="eh-notes">Note</label><input id="eh-notes" name="notes" maxlength="255" value="${h.notes || ""}"></div></div>` });
  if (!fd) return;
  const body = { notes: fd.get("notes") || null, not_needed_after: fd.get("not_needed_after") || null };
  if (fd.get("pickup_branch_id")) body.pickup_branch_id = Number(fd.get("pickup_branch_id"));
  try {
    await api(`/holds/${id}`, { method: "PATCH", body });
    toast("Hold updated", "success");
    load();
  } catch (e) { toast(e.message, "error"); }
}

function expiryCell(h) {
  if (!h.expires_at) return html`<span class="muted">—</span>`;
  const hours = (parseDate(h.expires_at) - Date.now()) / 3600000;
  if (hours < 0) return badge("bad", `Expired ${relative(h.expires_at)}`);
  if (hours < 48) return badge("warn", `Expires ${relative(h.expires_at)}`);
  return html`<span title="${datetime(h.expires_at)}">${date(h.expires_at)}</span>`;
}

function renderQueue(rows) {
  if (!rows.length) return html`<div class="card">${empty("No active holds for this selection.", "bookmark")}</div>`;
  return html`<div class="card flush"><div class="table-wrap"><table class="table">
    <caption class="sr-only">Active holds</caption>
    <thead><tr><th scope="col">Title</th><th scope="col">Patron</th><th scope="col">Pickup</th><th scope="col">Status</th>
      <th scope="col" class="num">Queue</th><th scope="col">Placed</th><th scope="col">Expires</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map((h) => html`<tr>
      <td>${titleCell(h.biblio)}${h.notes ? html`<div class="tiny muted">${icon("edit")} ${h.notes}</div>` : ""}</td>
      <td>${patronCell(h.patron)}</td>
      <td>${h.pickup_branch.name}</td>
      <td>${holdStatusCell(h)}</td>
      <td class="num">${h.queue_position ?? "—"}</td>
      <td class="nowrap" title="${datetime(h.created_at)}">${relative(h.created_at)}</td>
      <td class="nowrap">${expiryCell(h)}</td>
      <td class="right nowrap">${holdActions(h)}${cancelBtn(h)}</td></tr>`)}</tbody></table></div></div>`;
}

function renderReady(rows) {
  if (!rows.length) return html`<div class="card">${empty("Nothing is waiting on the hold shelf.", "inbox")}</div>`;
  return html`<div class="card flush"><div class="table-wrap"><table class="table">
    <caption class="sr-only">Holds ready for pickup</caption>
    <thead><tr><th scope="col">Title</th><th scope="col">Patron</th><th scope="col">Pickup</th><th scope="col">Item</th>
      <th scope="col">On shelf since</th><th scope="col">Collect by</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map((h) => html`<tr>
      <td>${titleCell(h.biblio)}</td>
      <td>${patronCell(h.patron)}</td>
      <td>${h.pickup_branch.name}</td>
      <td class="mono small">${h.item?.barcode || "—"}</td>
      <td class="nowrap" title="${datetime(h.ready_at)}">${relative(h.ready_at)}</td>
      <td class="nowrap">${expiryCell(h)}</td>
      <td class="right">${cancelBtn(h)}</td></tr>`)}</tbody></table></div></div>`;
}

function renderPull(rows) {
  const branch = state.branches.find((b) => String(b.id) === state.branch);
  const hint = html`<div class="alert info" style="margin-bottom:1rem">${icon("info")}<div>
    Pull these copies and <strong>check them in at the circulation desk</strong> — Shelfwise routes each one automatically:
    to the hold shelf if it's already at the pickup branch, otherwise into transit.
    ${branch ? html`Showing copies shelved at <strong>${branch.name}</strong>.` : ""}
    <a href="/staff/circulation#checkin">Open check-in ${icon("arrow-right")}</a></div></div>`;
  if (!rows.length) return html`${hint}<div class="card">${empty("No holds can be filled from the shelves right now.", "check")}</div>`;
  return html`${hint}<div class="card flush"><div class="table-wrap"><table class="table">
    <caption class="sr-only">Copies to pull for holds</caption>
    <thead><tr><th scope="col">Barcode</th><th scope="col">Call number</th><th scope="col">Shelved at</th><th scope="col">Title</th>
      <th scope="col">For patron</th><th scope="col">Pickup at</th><th scope="col">Waiting</th></tr></thead>
    <tbody>${rows.map(({ hold: h, item: i }) => html`<tr>
      <td class="mono">${i.barcode}</td>
      <td class="mono small">${i.call_number || "—"}${i.shelf_location ? html`<div class="tiny muted">${i.shelf_location}</div>` : ""}</td>
      <td>${i.branch.name}${i.branch.id !== h.pickup_branch.id ? html` <span class="badge in_transit">Transfer</span>` : ""}</td>
      <td>${titleCell(h.biblio)}</td>
      <td>${patronCell(h.patron)}</td>
      <td>${h.pickup_branch.name}</td>
      <td class="nowrap" title="${datetime(h.created_at)}">${relative(h.created_at)}</td></tr>`)}</tbody></table></div></div>`;
}

// ------------------------------------------------------------------ data

const branchParam = () => (state.branch ? Number(state.branch) : undefined);
const fetchers = {
  queue: () => api(`/holds?${qs({ branch_id: branchParam() })}`),
  pull: () => api(`/holds/to-pull?${qs({ branch_id: branchParam() })}`),
  ready: () => api(`/holds?${qs({ status: "ready", branch_id: branchParam() })}`),
};
const renderers = { queue: renderQueue, pull: renderPull, ready: renderReady };

function setCount(key, n) {
  const el = $(`#count-${key}`);
  if (!el) return;
  el.textContent = n ?? "";
  el.className = `badge ${key === "ready" && n ? "ready" : ""} ${n === null || n === undefined ? "hidden" : ""}`;
}

async function refreshCounts() {
  await Promise.all(Object.keys(fetchers).map(async (k) => {
    try { setCount(k, (await fetchers[k]()).results.length); } catch { setCount(k, null); }
  }));
}

async function load() {
  const tab = state.tab;
  panel().innerHTML = `<div class="card pad">${skeleton(6)}</div>`;
  try {
    const { results } = await fetchers[tab]();
    if (tab !== state.tab) return; // user switched tabs meanwhile
    setCount(tab, results.length);
    panel().innerHTML = renderers[tab](results);
  } catch (e) {
    panel().innerHTML = html`<div class="card">${errorBox(e.message)}</div>`;
    toast(e.message, "error");
  }
}

// ------------------------------------------------------------------ actions

async function cancelHold(btn) {
  const ok = await confirmDialog("Cancel this hold?", `The hold on “${btn.dataset.title}” will be cancelled and the patron loses their place in the queue.`, "Cancel hold");
  if (!ok) return;
  try {
    await withBusy(btn, () => api(`/holds/${btn.dataset.cancel}`, { method: "DELETE" }));
    toast("Hold cancelled", "success");
    load();
    refreshCounts();
  } catch { /* toasted */ }
}

function wireTitleSearch(dlg) {
  const input = $("#ph-q", dlg), out = $("#ph-results", dlg), idField = $("#ph-biblio", dlg);
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { out.innerHTML = ""; return; }
    out.innerHTML = skeleton(2);
    try {
      const r = await api(`/search?${qs({ q, per_page: 6 })}`);
      out.innerHTML = r.results.length ? html`<div class="stack tight" role="list">${r.results.map((b) => html`
        <button type="button" class="btn ghost sm" role="listitem" data-pick="${b.id}" style="justify-content:space-between;text-align:left;white-space:normal">
          <span><strong>${b.title}</strong> <span class="muted">${authors(b.authors)}${b.pub_year ? ` · ${b.pub_year}` : ""} · #${b.id}</span></span>
          ${availabilityBadge(b.availability)}</button>`)}</div>`
        : html`<p class="small muted">No titles match “${q}”.</p>`;
    } catch (e) { out.innerHTML = html`<p class="small muted">${e.message}</p>`; }
  }, 300);
  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  out.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    idField.value = b.dataset.pick;
    $$("[data-pick]", out).forEach((x) => x.setAttribute("aria-pressed", x === b));
    $$("[data-pick]", out).forEach((x) => x.classList.toggle("primary", x === b));
    $("#ph-branch", dlg).focus();
  });
}

async function placeHold() {
  const home = state.branch ? Number(state.branch) : BOOT.user?.home_branch_id;
  const body = html`<div class="stack">
    <div class="field"><label for="ph-card">Patron card number</label>
      <input id="ph-card" name="patron_card" required maxlength="32" autocomplete="off" class="mono" placeholder="Scan or type the card"></div>
    <div class="field"><label for="ph-q">Find a title</label>
      <input id="ph-q" type="search" data-no-submit autocomplete="off" placeholder="Search by title, author or ISBN…">
      <span class="hint">Choose a result to fill in the record number, or type the number directly.</span></div>
    <div id="ph-results" aria-live="polite"></div>
    <div class="grid cols-2">
      <div class="field"><label for="ph-biblio">Record number</label>
        <input id="ph-biblio" name="biblio_id" type="number" min="1" step="1" required></div>
      <div class="field"><label for="ph-branch">Pickup branch</label>
        <select id="ph-branch" name="pickup_branch_id" required>${state.branches.map((b) =>
          html`<option value="${b.id}" ${b.id === home ? "selected" : ""}>${b.name}</option>`)}</select></div>
    </div>
    <div class="grid cols-2">
      <div class="field"><label for="ph-notes">Note <span class="muted">(optional)</span></label>
        <input id="ph-notes" name="notes" maxlength="255" autocomplete="off"></div>
      <div class="field"><label for="ph-nna">Not needed after <span class="muted">(optional)</span></label>
        <input id="ph-nna" name="not_needed_after" type="date"></div>
    </div>
    <label class="checkbox"><input type="checkbox" name="override" value="1"> Override borrowing blocks and hold limits</label>
  </div>`;
  const hold = await formModal({ title: "Place a hold", body, submit: "Place hold" }, (fd) => api("/holds", {
    method: "POST",
    body: {
      patron_card: String(fd.get("patron_card")).trim(),
      biblio_id: Number(fd.get("biblio_id")),
      pickup_branch_id: Number(fd.get("pickup_branch_id")),
      notes: String(fd.get("notes") || "").trim() || null,
      not_needed_after: fd.get("not_needed_after") || null,
      override: fd.has("override"),
    },
  }), wireTitleSearch);
  if (!hold) return;
  toast(`Hold placed for ${hold.patron.full_name} on “${hold.biblio.title}”${hold.queue_position ? ` — position ${hold.queue_position} in queue` : ""}`, "success", 6000);
  load();
  refreshCounts();
}

// ------------------------------------------------------------------ init

export default async function init() {
  const selectTab = setupTabs($("#holds-tabs"), (key) => {
    state.tab = key;
    history.replaceState(null, "", `#${key}`);
    load();
  });
  $("#place-hold").addEventListener("click", placeHold);
  $("#holds-refresh").addEventListener("click", (e) => withBusy(e.currentTarget, async () => { await load(); await refreshCounts(); }).catch(() => {}));
  $("#holds-branch").addEventListener("change", (e) => { state.branch = e.target.value; load(); refreshCounts(); });
  panel().addEventListener("click", (e) => { const b = e.target.closest("[data-cancel]"); if (b) cancelHold(b); });
  panel().addEventListener("click", async (e) => {
    const b = e.target.closest("[data-suspend],[data-resume],[data-edit]");
    if (!b) return;
    if (b.dataset.suspend) suspendHold(Number(b.dataset.suspend));
    else if (b.dataset.edit) editHold(Number(b.dataset.edit));
    else {
      try {
        await withBusy(b, () => api(`/holds/${b.dataset.resume}/resume`, { method: "POST" }));
        toast("Hold resumed", "success");
        load();
      } catch { /* toasted */ }
    }
  });

  try {
    state.branches = (await api("/lookups")).branches || [];
    $("#holds-branch").insertAdjacentHTML("beforeend", html`${state.branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}`);
  } catch (e) { toast(e.message, "error"); }

  if (!selectTab(location.hash.slice(1))) load();
  refreshCounts();
  if (location.hash === "#new") placeHold();
}
