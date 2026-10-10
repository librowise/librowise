// Staff › Holds: four work lists on one page.
//   Queue      every active hold — search, filter, bulk suspend / resume / cancel
//   To pull    copies to fetch from the shelves, grouped by branch and sorted by call number; printable pull list
//   Hold shelf items waiting for pickup, expiring-soon first; hold slips; clear expired holds
//   In transit copies travelling to their pickup branch; transit slips
// Filters (search, pickup branch, status) live in the URL; the tab lives in the hash (#queue, #pull, #ready,
// #transit), so the Home page can deep-link into "hold shelf, expiring soon" and friends.
import { $, $$, BOOT, api, authors, availabilityBadge, date, datetime, debounce, html, icon, modal, num, parseDate, qs, relative, toast } from "/static/js/core.js";
import { formatList, t } from "/static/js/i18n.js";
import { wireTabs } from "/static/js/a11y.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { confirmDestructive } from "/static/js/ui/dialog.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { activeFilters, urlState, wireFilterBar } from "/static/js/ui/filters.js";
import { statusPill } from "/static/js/ui/status.js";
import { holdSlip, maskCard, printSlip, transitSlip } from "/static/js/pages/lib/desk-print.js";
import { menuTrigger, rowMenu } from "/static/js/pages/lib/desk-ui.js";

const TABS = ["queue", "pull", "ready", "transit"];
const HOUR = 3_600_000, DAY = 24 * HOUR;
const FILTERS = ["q", "branch", "status", "expiring"];
const state = urlState({ q: "", branch: "", status: "", expiring: "" });
const S = { tab: "queue", branches: [], data: {}, table: null, sort: {}, loadSeq: 0 };
const library = () => $("#holds").dataset.library || "";
const PULLED_KEY = `sw-pulled:${new Date().toISOString().slice(0, 10)}`;
const pulled = new Set((() => { try { return JSON.parse(sessionStorage.getItem(PULLED_KEY) || "[]"); } catch { return []; } })());
const savePulled = () => { try { sessionStorage.setItem(PULLED_KEY, JSON.stringify([...pulled])); } catch { /* ignore */ } };

// ------------------------------------------------------------------ cells

const dayStr = (s) => { const [y, m, d] = s.split("-").map(Number); return date(new Date(y, m - 1, d)); };
const titleCell = (b) => html`<div class="dt-cell-stack"><a href="/staff/catalog/${b.id}">${b.title}</a>
  ${b.authors?.length ? html`<span class="sub">${authors(b.authors)}</span>` : ""}</div>`;
const patronCell = (p) => html`<div class="dt-cell-stack"><a href="/staff/patrons/${p.id}">${p.full_name}</a><span class="sub mono">${p.card_number}</span></div>`;

function statusCell(h) {
  const extra = [];
  if (h.item_level && h.requested_item) extra.push(html`<span class="sub">${t("desk.holds.copy_only", { barcode: h.requested_item.barcode })}</span>`);
  if (h.not_needed_after) extra.push(html`<span class="sub">${t("desk.holds.not_after", { date: dayStr(h.not_needed_after) })}</span>`);
  if (h.notes) extra.push(html`<span class="sub">${icon("edit")} ${h.notes}</span>`);
  const pill = h.suspended
    ? statusPill("hold", "suspended", h.suspended_until ? t("desk.holds.suspended_until", { date: dayStr(h.suspended_until) }) : t("desk.holds.st_suspended"))
    : h.status === "queued" && h.item ? statusPill("item", "in_transit") : statusPill("hold", h.status);
  return html`<div class="dt-cell-stack holds-status">${pill}${extra}</div>`;
}

function expiryCell(h) {
  if (!h.expires_at) return html`<span class="muted">—</span>`;
  const ms = parseDate(h.expires_at) - Date.now();
  if (ms < 0) return statusPill("loan", "overdue", t("desk.holds.expired_ago", { when: relative(h.expires_at) }));
  if (ms < DAY) return statusPill("loan", "due_soon", t("desk.holds.expires_today"));
  if (ms < 2 * DAY) return statusPill("loan", "due_soon", t("desk.holds.expires_when", { when: relative(h.expires_at) }));
  return html`<span title="${datetime(h.expires_at)}">${date(h.expires_at, { weekday: "short", day: "numeric", month: "short" })}</span>`;
}

const since = (v) => (v ? html`<span title="${datetime(v)}" class="nowrap">${relative(v)}</span>` : html`<span class="muted">—</span>`);
const menuCell = (h, kind) => menuTrigger(html`data-row-menu="${kind}" data-id="${h.id}"`, t("desk.holds.actions_for", { title: h.biblio.title, name: h.patron.full_name }));

// ------------------------------------------------------------------ data

const branchParam = () => state.get().branch || undefined;
const FETCH = {
  queue: () => api(`/holds?${qs({ branch_id: branchParam() })}`),
  pull: () => api(`/holds/to-pull?${qs({ branch_id: branchParam() })}`),
  ready: () => api(`/holds?${qs({ status: "ready", branch_id: branchParam() })}`),
  transit: () => api(`/holds?${qs({ transit: true, branch_id: branchParam() })}`),
};

function matches(h, q, item) {
  if (!q) return true;
  const hay = [h.biblio.title, ...(h.biblio.authors || []), h.patron.full_name, h.patron.card_number, h.item?.barcode, item?.barcode, item?.call_number]
    .filter(Boolean).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function filtered(tab) {
  const s = state.get();
  const rows = S.data[tab] || [];
  if (tab === "pull") return rows.filter((r) => matches(r.hold, s.q, r.item));
  return rows.filter((h) => {
    if (!matches(h, s.q)) return false;
    if (tab === "queue" && s.status) {
      if (s.status === "suspended") return h.suspended;
      if (s.status === "queued") return h.status === "queued" && !h.suspended;
      return h.status === s.status;
    }
    if (tab === "ready" && s.expiring) return h.expires_at && parseDate(h.expires_at) - Date.now() < 2 * DAY;
    return true;
  });
}

const SORTERS = {
  title: (h) => h.biblio.title.toLowerCase(), patron: (h) => h.patron.full_name.toLowerCase(), pickup: (h) => h.pickup_branch.name,
  position: (h) => h.queue_position ?? 9999, placed: (h) => h.created_at, expires: (h) => h.expires_at || "9999", ready_at: (h) => h.ready_at || "",
  status: (h) => (h.suspended ? "z" : h.status),
};
function sorted(rows, sort) {
  if (!sort?.key || !SORTERS[sort.key]) return rows;
  const f = SORTERS[sort.key], dir = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => (f(a) < f(b) ? -dir : f(a) > f(b) ? dir : 0));
}

async function refreshCounts() {
  try {
    const c = await api(`/holds/counts?${qs({ branch_id: branchParam() })}`);
    for (const k of TABS) $(`#count-${k}`).textContent = num(c[k]);
    const exp = $("#count-expiring");
    exp.hidden = !c.expiring;
    exp.textContent = c.expiring ? t("desk.holds.n_expiring", { count: c.expiring }) : "";
  } catch { /* counts are a convenience */ }
}

// ------------------------------------------------------------------ tables

function tableFor(tab) {
  const common = { caption: t(`desk.holds.tab.${tab}`), rowKey: (h) => h.id, selectable: true,
    rowLabel: (h) => `${h.biblio.title} · ${h.patron.full_name}`, exportName: `holds-${tab}`, onRetry: () => load(),
    onSort: (sort) => { S.sort[tab] = sort; paint(); } };
  if (tab === "queue") {
    return { ...common, id: "holds-queue", sort: S.sort.queue || { key: "placed", dir: "asc" },
      empty: { art: "inbox", title: t("desk.holds.empty.queue_title"), body: t("desk.holds.empty.queue_body"),
        actions: html`<button type="button" class="btn primary" data-place-hold>${icon("bookmark-plus")}${t("desk.holds.place")}</button>` },
      columns: [
        { key: "title", label: t("desk.holds.col.title"), sortable: true, primary: true, hideable: false, render: (h) => titleCell(h.biblio), csv: (h) => h.biblio.title },
        { key: "patron", label: t("desk.holds.col.patron"), sortable: true, render: (h) => patronCell(h.patron), csv: (h) => h.patron.full_name },
        { key: "pickup", label: t("desk.holds.col.pickup"), sortable: true, render: (h) => h.pickup_branch.name, csv: (h) => h.pickup_branch.name },
        { key: "status", label: t("desk.holds.col.status"), sortable: true, render: statusCell, csv: (h) => (h.suspended ? "suspended" : h.status) },
        { key: "position", label: t("desk.holds.col.position"), align: "num", sortable: true, render: (h) => (h.queue_position ? num(h.queue_position) : "—"), csv: (h) => h.queue_position ?? "" },
        { key: "placed", label: t("desk.holds.col.placed"), sortable: true, render: (h) => since(h.created_at), csv: (h) => h.created_at },
        { key: "menu", label: t("desk.holds.col.actions"), labelHidden: true, hideable: false, csv: false, render: (h) => menuCell(h, "queue") },
      ],
      bulkActions: [
        { id: "suspend", label: t("desk.holds.bulk.suspend"), icon: "clock", run: (rows, ctx) => bulkSuspend(rows, ctx) },
        { id: "resume", label: t("desk.holds.bulk.resume"), icon: "refresh", run: (rows, ctx) => bulk(rows, ctx, "resume") },
        { id: "cancel", label: t("desk.holds.bulk.cancel"), icon: "x", danger: true, run: (rows, ctx) => bulkCancel(rows, ctx) },
      ] };
  }
  if (tab === "ready") {
    return { ...common, id: "holds-ready", sort: S.sort.ready || { key: "expires", dir: "asc" },
      empty: { art: "done", title: t("desk.holds.empty.ready_title"), body: t("desk.holds.empty.ready_body") },
      columns: [
        { key: "title", label: t("desk.holds.col.title"), sortable: true, primary: true, hideable: false, render: (h) => titleCell(h.biblio), csv: (h) => h.biblio.title },
        { key: "patron", label: t("desk.holds.col.patron"), sortable: true, render: (h) => patronCell(h.patron), csv: (h) => h.patron.full_name },
        { key: "item", label: t("desk.holds.col.item"), render: (h) => html`<span class="mono small">${h.item?.barcode || "—"}</span>`, csv: (h) => h.item?.barcode || "" },
        { key: "pickup", label: t("desk.holds.col.pickup"), sortable: true, render: (h) => h.pickup_branch.name, csv: (h) => h.pickup_branch.name },
        { key: "ready_at", label: t("desk.holds.col.on_shelf"), sortable: true, render: (h) => since(h.ready_at), csv: (h) => h.ready_at || "" },
        { key: "expires", label: t("desk.holds.col.collect_by"), sortable: true, render: expiryCell, csv: (h) => h.expires_at || "" },
        { key: "menu", label: t("desk.holds.col.actions"), labelHidden: true, hideable: false, csv: false, render: (h) => menuCell(h, "ready") },
      ],
      bulkActions: [
        { id: "slips", label: t("desk.holds.bulk.print_hold_slips"), icon: "printer", run: (rows) => printHoldSlips(rows) },
        { id: "cancel", label: t("desk.holds.bulk.clear_shelf"), icon: "x", danger: true, run: (rows, ctx) => bulkCancel(rows, ctx, true) },
      ] };
  }
  return { ...common, id: "holds-transit", sort: S.sort.transit || { key: "placed", dir: "asc" },
    empty: { art: "done", title: t("desk.holds.empty.transit_title"), body: t("desk.holds.empty.transit_body") },
    columns: [
      { key: "title", label: t("desk.holds.col.title"), sortable: true, primary: true, hideable: false, render: (h) => titleCell(h.biblio), csv: (h) => h.biblio.title },
      { key: "item", label: t("desk.holds.col.item"), render: (h) => html`<span class="mono small">${h.item?.barcode || "—"}</span>`, csv: (h) => h.item?.barcode || "" },
      { key: "owner", label: t("desk.holds.col.owner"), render: (h) => h.item?.branch?.name || "—", csv: (h) => h.item?.branch?.name || "" },
      { key: "pickup", label: t("desk.holds.col.to"), sortable: true, render: (h) => html`<strong>${h.pickup_branch.name}</strong>`, csv: (h) => h.pickup_branch.name },
      { key: "patron", label: t("desk.holds.col.for"), sortable: true, render: (h) => patronCell(h.patron), csv: (h) => h.patron.full_name },
      { key: "placed", label: t("desk.holds.col.sent"), render: (h) => since(h.item?.last_seen_at), csv: (h) => h.item?.last_seen_at || "" },
      { key: "menu", label: t("desk.holds.col.actions"), labelHidden: true, hideable: false, csv: false, render: (h) => menuCell(h, "transit") },
    ],
    bulkActions: [{ id: "slips", label: t("desk.holds.bulk.print_transit_slips"), icon: "printer", run: (rows) => printTransitSlips(rows) }] };
}

// ------------------------------------------------------------------ pull list

function pullGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.item.branch.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.item.call_number || "~").localeCompare(b.item.call_number || "~", undefined, { numeric: true }));
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function pullView(rows) {
  if (!rows.length) {
    return html`<div class="card">${emptyState({ art: "done", title: t("desk.holds.empty.pull_title"), body: t("desk.holds.empty.pull_body") })}</div>`;
  }
  const done = rows.filter((r) => pulled.has(r.hold.id)).length;
  return html`<div class="pull-toolbar card">
      <div class="pull-progress"><strong>${t("desk.holds.pull_progress", { done, count: rows.length })}</strong>
        <div class="progress" role="progressbar" aria-label="${t("desk.holds.pull_progress_label")}" aria-valuemin="0" aria-valuemax="${rows.length}" aria-valuenow="${done}"><span class="bar" style="--value:${(100 * done) / rows.length}%"></span></div></div>
      <div class="row tight"><button type="button" class="btn" id="pull-print">${icon("printer")}${t("desk.holds.print_pull")}</button>
        <a class="btn primary" href="/staff/circulation#checkin">${icon("arrow-down")}${t("desk.holds.go_checkin")}</a></div>
    </div>
    <p class="small muted pull-how">${t("desk.holds.pull_how")}</p>
    ${pullGroups(rows).map(([branch, list]) => html`<section class="card pull-group" aria-labelledby="pg-${list[0].hold.id}">
      <div class="card-head"><h2 id="pg-${list[0].hold.id}">${icon("map")} ${branch}</h2><span class="small muted">${t("desk.holds.n_items", { count: list.length })}</span></div>
      <ul class="pull-list" role="list">${list.map(({ hold: h, item: i }) => html`<li class="${pulled.has(h.id) ? "is-pulled" : ""}">
        <label class="pull-check"><input type="checkbox" data-pulled="${h.id}" ${pulled.has(h.id) ? "checked" : ""}>
          <span class="sr-only">${t("desk.holds.mark_pulled", { title: h.biblio.title })}</span></label>
        <span class="pull-call mono">${i.call_number || "—"}</span>
        <span class="pull-main"><strong>${h.biblio.title}</strong><span class="small muted">${authors(h.biblio.authors)}${i.shelf_location ? html` · ${i.shelf_location}` : ""}</span></span>
        <span class="pull-barcode mono small">${i.barcode}</span>
        <span class="pull-for small"><span class="muted">${t("desk.holds.for")}</span> ${h.patron.full_name}
          ${i.branch.id !== h.pickup_branch.id ? html`<span class="badge pill info"><span class="dot" aria-hidden="true"></span>${t("desk.holds.to_branch", { branch: h.pickup_branch.name })}</span>` : ""}</span>
        <span class="pull-since small muted">${relative(h.created_at)}</span></li>`)}</ul></section>`)}`;
}

function pullSheet(rows) {
  return html`<article class="pull-sheet"><h1>${t("desk.holds.pull_sheet_title")}</h1>
    <p>${library()} · ${datetime(new Date().toISOString().slice(0, 19))} · ${t("desk.holds.n_items", { count: rows.length })}</p>
    ${pullGroups(rows).map(([branch, list]) => html`<h2>${branch}</h2><table><thead><tr><th>✓</th><th>${t("desk.holds.col.call")}</th><th>${t("desk.holds.col.title")}</th>
      <th>${t("desk.holds.col.item")}</th><th>${t("desk.holds.col.for")}</th><th>${t("desk.holds.col.pickup")}</th></tr></thead>
      <tbody>${list.map(({ hold: h, item: i }) => html`<tr><td class="box"></td><td class="call">${i.call_number || "—"}</td><td>${h.biblio.title}${i.shelf_location ? html`<br><small>${i.shelf_location}</small>` : ""}</td>
        <td class="bc">${i.barcode}</td><td>${h.patron.full_name} (${maskCard(h.patron.card_number)})</td><td>${h.pickup_branch.name}</td></tr>`)}</tbody></table>`)}</article>`;
}

// ------------------------------------------------------------------ rendering

function paint() {
  const tab = S.tab;
  const body = $("#holds-body");
  if (!S.data[tab]) return;
  if (tab === "pull") {
    S.table = null;
    body.innerHTML = pullView(filtered("pull"));
    return;
  }
  if (!S.table || S.table.tab !== tab) {
    body.innerHTML = `<div id="holds-table"></div>`;
    S.table = dataTable($("#holds-table"), tableFor(tab));
    S.table.tab = tab;
  }
  const rows = sorted(filtered(tab), S.sort[tab] || tableFor(tab).sort);
  S.table.setRows(rows, { total: rows.length, page: 1, perPage: Math.max(rows.length, 1) });
}

function syncFilters() {
  const s = state.get();
  $("#holds-q").value = s.q;
  $('[data-clear="q"]').hidden = !s.q;
  $("#holds-branch").value = s.branch;
  $("#holds-status").value = s.status;
  $("#holds-expiring").checked = !!s.expiring;
  $("#status-chip").hidden = S.tab !== "queue";
  $("#expiring-chip").hidden = S.tab !== "ready";
  $$(".holds-filters .select-chip").forEach((c) => c.classList.toggle("active", !!$("select", c).value));
  $("#holds-branch").closest(".select-chip").title = S.tab === "pull" ? t("desk.holds.branch_pull_hint") : "";
  const branchName = S.branches.find((b) => String(b.id) === s.branch)?.name;
  const statusName = $("#holds-status").selectedOptions[0]?.textContent;
  const list = [];
  if (s.q) list.push({ key: "q", label: t("common.search"), value: `“${s.q}”` });
  if (s.branch) list.push({ key: "branch", label: S.tab === "pull" ? t("desk.holds.shelved_at") : t("desk.holds.col.pickup"), value: branchName || s.branch });
  if (s.status && S.tab === "queue") list.push({ key: "status", label: t("desk.holds.col.status"), value: statusName });
  if (s.expiring && S.tab === "ready") list.push({ key: "expiring", label: t("desk.holds.col.collect_by"), value: t("desk.holds.only_expiring") });
  $("#holds-chips").innerHTML = activeFilters(list);
}

async function load({ quiet = false } = {}) {
  const tab = S.tab, seq = ++S.loadSeq;
  if (!quiet) {
    if (S.table && S.table.tab === tab) S.table.setLoading();
    else if (tab !== "pull" || !S.data.pull) S.table = null;
  }
  try {
    const { results } = await FETCH[tab]();
    if (seq !== S.loadSeq) return;
    S.data[tab] = results;
    paint();
  } catch (e) {
    if (seq !== S.loadSeq) return;
    if (S.table?.tab === tab) S.table.setError(e, () => load());
    else $("#holds-body").innerHTML = html`<div class="card">${errorState(e)}</div>`;
  }
}

function selectTab(tab, { focus = false } = {}) {
  if (!TABS.includes(tab)) tab = "queue";
  S.tab = tab;
  $$("#holds-tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $("#holds-panel").setAttribute("aria-labelledby", `tab-${tab}`);
  $("#holds-intro").textContent = t(`desk.holds.intro.${tab}`);
  $("#holds-panel-h").textContent = t(`desk.holds.tab.${tab}`);
  history.replaceState(null, "", `${location.pathname}${location.search}#${tab}`);
  if (focus) $(`#tab-${tab}`).focus();
  syncFilters();
  if (S.data[tab]) paint(); else $("#holds-body").innerHTML = html`<div class="dt"><div class="dt-toolbar"></div>${[...Array(6)].map(() => html`<div class="skeleton" style="height:2.6rem;margin:.6rem 1rem"></div>`)}</div>`;
  load({ quiet: !!S.data[tab] });
}

// ------------------------------------------------------------------ actions

async function run(list, fn, okKey, { clear } = {}) {
  let ok = 0;
  const failures = [];
  for (const h of list) {
    try { await fn(h); ok++; } catch (e) { failures.push(`${h.biblio.title}: ${e.message}`); }
  }
  if (ok) toast(t(okKey, { count: ok }), "success");
  if (failures.length) toast(t("desk.holds.some_failed", { count: failures.length, list: formatList(failures.slice(0, 3)) }), "error", 9000);
  clear?.();
  S.data = {};
  load({ quiet: true });
  refreshCounts();
}

async function suspendDialog(count) {
  return modal({ title: t("desk.holds.suspend_title", { count }), submit: t("desk.holds.suspend_submit"), size: "sm",
    body: html`<div class="stack"><p class="small muted">${t("desk.holds.suspend_body")}</p>
      <div class="field"><label for="sh-until">${t("desk.holds.suspend_until")} <span class="muted">${t("desk.optional")}</span></label>
        <input id="sh-until" name="until" type="date" min="${new Date().toISOString().slice(0, 10)}"><span class="hint">${t("desk.holds.suspend_hint")}</span></div></div>` });
}

async function bulkSuspend(rows, { clear }) {
  const list = rows.filter((h) => h.status === "queued" && !h.suspended && !h.item);
  if (!list.length) { toast(t("desk.holds.none_to_suspend"), "info"); return; }
  const fd = await suspendDialog(list.length);
  if (!fd) return;
  await run(list, (h) => api(`/holds/${h.id}/suspend`, { method: "POST", body: { until: fd.get("until") || null } }), "desk.holds.done_suspended", { clear });
}

async function bulk(rows, { clear }, action) {
  const list = rows.filter((h) => h.suspended);
  if (!list.length) { toast(t("desk.holds.none_to_resume"), "info"); return; }
  await run(list, (h) => api(`/holds/${h.id}/${action}`, { method: "POST" }), "desk.holds.done_resumed", { clear });
}

async function bulkCancel(rows, { clear } = {}, shelf = false) {
  const text = shelf ? t("desk.holds.clear_body", { count: rows.length }) : t("desk.holds.cancel_body", { count: rows.length });
  const title = shelf ? t("desk.holds.clear_title", { count: rows.length }) : t("desk.holds.cancel_title", { count: rows.length });
  const ok = rows.length >= 5
    ? await confirmDestructive({ title, text, word: String(rows.length), submit: t("desk.holds.cancel_submit", { count: rows.length }) })
    : !!(await modal({ title, danger: true, size: "sm", submit: t("desk.holds.cancel_submit", { count: rows.length }),
      body: html`<p>${text}</p><ul class="small">${rows.slice(0, 4).map((h) => html`<li>${h.biblio.title} · ${h.patron.full_name}</li>`)}</ul>` }));
  if (!ok) return;
  await run(rows, (h) => api(`/holds/${h.id}`, { method: "DELETE" }), "desk.holds.done_cancelled", { clear });
}

const holdSlipFor = (h) => holdSlip({ hold: h, item: { barcode: h.item?.barcode || "", call_number: h.item?.call_number }, title: h.biblio.title,
  library: library(), branch: h.pickup_branch.name });
const transitSlipFor = (h) => transitSlip({ to: h.pickup_branch.name, from: h.item?.branch?.name || "", item: { barcode: h.item?.barcode || "", call_number: h.item?.call_number },
  title: h.biblio.title, hold: h, library: library() });
const printHoldSlips = (rows) => printSlip(html`${rows.map(holdSlipFor)}`);
const printTransitSlips = (rows) => printSlip(html`${rows.map(transitSlipFor)}`);

async function editHold(h) {
  const fd = await modal({ title: t("desk.holds.edit_title"), submit: t("common.save"), body: html`<div class="stack">
    <p><strong>${h.biblio.title}</strong> · ${h.patron.full_name}</p>
    ${h.item ? "" : html`<div class="field"><label for="eh-br">${t("desk.holds.col.pickup")}</label><select id="eh-br" name="pickup_branch_id">${S.branches.map((b) =>
      html`<option value="${b.id}" ${b.id === h.pickup_branch.id ? "selected" : ""}>${b.name}</option>`)}</select></div>`}
    <div class="field"><label for="eh-nna">${t("desk.holds.not_needed_after")} <span class="muted">${t("desk.optional")}</span></label><input id="eh-nna" name="not_needed_after" type="date" value="${h.not_needed_after || ""}"></div>
    <div class="field"><label for="eh-notes">${t("desk.holds.note")} <span class="muted">${t("desk.optional")}</span></label><input id="eh-notes" name="notes" maxlength="255" value="${h.notes || ""}"></div></div>` });
  if (!fd) return;
  const body = { notes: fd.get("notes") || null, not_needed_after: fd.get("not_needed_after") || null };
  if (fd.get("pickup_branch_id")) body.pickup_branch_id = Number(fd.get("pickup_branch_id"));
  await run([h], () => api(`/holds/${h.id}`, { method: "PATCH", body }), "desk.holds.done_updated");
}

function openMenu(btn) {
  const kind = btn.dataset.rowMenu, id = Number(btn.dataset.id);
  const h = (S.data[kind === "queue" ? "queue" : kind] || []).find((x) => x.id === id);
  if (!h) return;
  const items = [];
  if (h.status === "ready") items.push({ label: t("desk.holds.act.print_hold_slip"), icon: "printer", run: () => printHoldSlips([h]) });
  if (kind === "transit" || (h.status === "queued" && h.item)) items.push({ label: t("desk.holds.act.print_transit_slip"), icon: "printer", run: () => printTransitSlips([h]) });
  if (h.status === "queued" && !h.item) {
    items.push(h.suspended
      ? { label: t("desk.holds.act.resume"), icon: "refresh", run: () => run([h], () => api(`/holds/${h.id}/resume`, { method: "POST" }), "desk.holds.done_resumed") }
      : { label: t("desk.holds.act.suspend"), icon: "clock", run: async () => {
        const fd = await suspendDialog(1);
        if (fd) await run([h], () => api(`/holds/${h.id}/suspend`, { method: "POST", body: { until: fd.get("until") || null } }), "desk.holds.done_suspended");
      } });
  }
  if (h.status === "queued") items.push({ label: t("desk.holds.act.edit"), icon: "edit", run: () => editHold(h) });
  items.push({ label: t("desk.holds.act.open_patron"), icon: "user", run: () => { location.href = `/staff/patrons/${h.patron.id}`; } });
  items.push({ label: h.status === "ready" ? t("desk.holds.act.clear") : t("desk.holds.act.cancel"), icon: "x", danger: true, run: () => bulkCancel([h], {}, h.status === "ready") });
  rowMenu(btn, items);
}

// ------------------------------------------------------------------ place a hold

function wireTitleSearch(dlg) {
  const input = $("#ph-q", dlg), out = $("#ph-results", dlg), idField = $("#ph-biblio", dlg);
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { out.innerHTML = ""; return; }
    out.innerHTML = html`<p class="small muted">${t("common.loading")}</p>`;
    try {
      const r = await api(`/search?${qs({ q, per_page: 6 })}`);
      out.innerHTML = r.results.length ? html`<ul class="ph-list" role="list" aria-label="${t("desk.holds.ph_results")}">${r.results.map((b) => html`<li>
        <button type="button" class="ph-pick" data-pick="${b.id}" aria-pressed="false"><span class="grow"><strong>${b.title}</strong>
          <span class="small muted">${authors(b.authors)}${b.pub_year ? ` · ${b.pub_year}` : ""} · #${b.id}</span></span>${availabilityBadge(b.availability)}</button></li>`)}</ul>`
        : html`<p class="small muted">${t("desk.holds.ph_none", { q })}</p>`;
    } catch (e) { out.innerHTML = html`<p class="small" role="alert">${e.message}</p>`; }
  }, 300);
  input.addEventListener("input", search);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); search(); } }, true);
  out.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    idField.value = b.dataset.pick;
    $$("[data-pick]", out).forEach((x) => { x.setAttribute("aria-pressed", String(x === b)); x.classList.toggle("is-picked", x === b); });
    $("#ph-branch", dlg).focus();
  });
}

async function placeHold() {
  const home = Number(state.get().branch) || BOOT.user?.home_branch_id;
  const body = html`<div class="stack">
    <div class="field"><label for="ph-card">${t("desk.holds.ph_card")}</label>
      <input id="ph-card" name="patron_card" required maxlength="32" autocomplete="off" class="mono" placeholder="${t("desk.holds.ph_card_placeholder")}"></div>
    <div class="field"><label for="ph-q">${t("desk.holds.ph_find")}</label>
      <input id="ph-q" type="search" autocomplete="off" placeholder="${t("desk.holds.ph_find_placeholder")}" aria-describedby="ph-q-hint">
      <span class="hint" id="ph-q-hint">${t("desk.holds.ph_find_hint")}</span></div>
    <div id="ph-results" aria-live="polite"></div>
    <div class="grid cols-2">
      <div class="field"><label for="ph-biblio">${t("desk.holds.ph_record")}</label><input id="ph-biblio" name="biblio_id" type="number" min="1" step="1" required></div>
      <div class="field"><label for="ph-branch">${t("desk.holds.col.pickup")}</label>
        <select id="ph-branch" name="pickup_branch_id" required>${S.branches.map((b) => html`<option value="${b.id}" ${b.id === home ? "selected" : ""}>${b.name}</option>`)}</select></div></div>
    <div class="grid cols-2">
      <div class="field"><label for="ph-notes">${t("desk.holds.note")} <span class="muted">${t("desk.optional")}</span></label><input id="ph-notes" name="notes" maxlength="255" autocomplete="off"></div>
      <div class="field"><label for="ph-nna">${t("desk.holds.not_needed_after")} <span class="muted">${t("desk.optional")}</span></label><input id="ph-nna" name="not_needed_after" type="date"></div></div>
    <label class="checkbox"><input type="checkbox" name="override" value="1"> ${t("desk.holds.ph_override")}</label></div>`;
  const pending = modal({ title: t("desk.holds.place"), body, submit: t("desk.holds.place") });
  const dlg = $$("dialog").at(-1);
  wireTitleSearch(dlg);
  const fd = await pending;
  if (!fd) return;
  try {
    const hold = await api("/holds", { method: "POST", body: {
      patron_card: String(fd.get("patron_card")).trim(), biblio_id: Number(fd.get("biblio_id")), pickup_branch_id: Number(fd.get("pickup_branch_id")),
      notes: String(fd.get("notes") || "").trim() || null, not_needed_after: fd.get("not_needed_after") || null, override: fd.has("override") } });
    toast(hold.queue_position ? t("desk.holds.placed_pos", { name: hold.patron.full_name, title: hold.biblio.title, n: hold.queue_position })
      : t("desk.holds.placed", { name: hold.patron.full_name, title: hold.biblio.title }), "success", 6000);
    S.data = {};
    load({ quiet: true });
    refreshCounts();
  } catch (e) {
    const reasons = e.data?.reasons?.length ? formatList(e.data.reasons) : e.message;
    toast(t("desk.holds.place_failed", { reason: reasons }), "error", 9000);
  }
}

// ------------------------------------------------------------------ init

export default async function init() {
  wireTabs($("#holds-tabs"), $("#holds-panel"));
  $("#holds-tabs").addEventListener("click", (e) => { const b = e.target.closest("[role=tab]"); if (b && b.dataset.tab !== S.tab) selectTab(b.dataset.tab); });

  try {
    S.branches = (await api("/lookups")).branches || [];
    $("#holds-branch").insertAdjacentHTML("beforeend", html`${S.branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}`);
  } catch { /* "All branches" still works */ }

  wireFilterBar($("#holds-filters"), (changes) => {
    state.set(changes);
    syncFilters();
    if ("branch" in changes) { S.data = {}; refreshCounts(); load(); } else paint();
  }, { keys: FILTERS });
  $("#holds-expiring").addEventListener("change", (e) => { state.set({ expiring: e.target.checked ? "1" : "" }); syncFilters(); paint(); });

  $("#place-hold").addEventListener("click", placeHold);
  $("#holds-refresh").addEventListener("click", () => { S.data = {}; refreshCounts(); load(); });
  $("#holds-body").addEventListener("click", async (e) => {
    const m = e.target.closest("[data-row-menu]");
    if (m) { openMenu(m); return; }
    if (e.target.closest("[data-place-hold]")) { placeHold(); return; }
    if (e.target.closest("#pull-print")) { await printSlip(pullSheet(filtered("pull"))); }
  });
  $("#holds-body").addEventListener("change", (e) => {
    const c = e.target.closest("[data-pulled]");
    if (!c) return;
    const id = Number(c.dataset.pulled);
    if (c.checked) pulled.add(id); else pulled.delete(id);
    savePulled();
    const scroll = window.scrollY;
    paint();
    window.scrollTo(0, scroll);
    $(`[data-pulled="${id}"]`)?.focus();
  });

  window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (TABS.includes(h) && h !== S.tab) selectTab(h); });
  refreshCounts();
  selectTab(location.hash.slice(1) === "new" ? "queue" : location.hash.slice(1));
  if (location.hash === "#new") placeHold();
}
