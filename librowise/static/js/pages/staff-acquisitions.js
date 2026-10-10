// Staff › Acquisitions › Orders & budgets.
// KPI tiles → budget cards (stacked meter: received · ordered · draft, remaining) → orders (status views, filters,
// data table with bulk "place" / "cancel", side panel per order with the draft → ordered → received lifecycle)
// → AI demand signals (titles whose hold queues outstrip copies). Drafts come from "Save as draft" or from
// accepted patron purchase suggestions; they reserve budget but are only sent to the vendor when placed.
import { $, BOOT, api, confirmDialog, date, datetime, html, icon, money, num, qs, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { activeFilters, savedViews, searchField, selectChip, urlState, wireFilterBar } from "/static/js/ui/filters.js";
import { sidePanel } from "/static/js/ui/panel.js";
import { statTile } from "/static/js/ui/stat.js";
import { statusPill } from "/static/js/ui/status.js";
import { actionMenu, alertBox, facts, formModal, meter, paise, recNo, str, wireMenus } from "/static/js/pages/lib/collection.js";

const S = { budgets: [], orders: [], counts: {}, vendors: [], suggestions: [], lk: { branches: [], item_types: [] }, can: {}, table: null, patronPending: 0 };
const FILTERS = ["status", "q", "vendor", "budget"];
const state = urlState({ status: "", q: "", vendor: "", budget: "", page: 1, per_page: 25 });
const STATUSES = ["draft", "ordered", "received", "cancelled"];
const body = () => $("#acq-body");

// ------------------------------------------------------------------ KPIs & budgets

function kpis() {
  const sum = (k) => S.budgets.reduce((a, b) => a + Number(b[k] || 0), 0);
  const allocated = sum("allocated"), remaining = sum("remaining");
  const open = S.orders.filter((o) => o.status === "ordered");
  const drafts = S.orders.filter((o) => o.status === "draft");
  return html`<section class="kpi-row" aria-label="${t("coll.acq.summary")}">
    ${statTile({ label: t("coll.acq.kpi_allocated"), value: money(allocated), icon: "wallet", foot: t("coll.acq.kpi_budgets", { count: S.budgets.length, n: num(S.budgets.length) }) })}
    ${statTile({ label: t("coll.acq.kpi_remaining"), value: money(remaining), icon: "check-circle", tone: remaining < 0 ? "danger" : "",
      foot: allocated ? t("coll.acq.kpi_used", { pct: num(Math.round((100 * (allocated - remaining)) / allocated)) }) : "" })}
    ${statTile({ label: t("coll.acq.kpi_open"), value: num(open.length), icon: "truck", foot: t("coll.acq.kpi_awaiting", { amount: money(open.reduce((a, o) => a + o.total, 0)) }) })}
    ${statTile({ label: t("coll.acq.kpi_drafts"), value: num(drafts.length), icon: "edit", tone: drafts.length ? "warning" : "",
      foot: drafts.length ? t("coll.acq.kpi_drafts_foot", { amount: money(drafts.reduce((a, o) => a + o.total, 0)) }) : t("coll.acq.kpi_no_drafts") })}
  </section>`;
}

function budgetCard(b) {
  const segs = [
    { value: b.received, tone: "success", label: t("coll.acq.seg_received") },
    { value: b.ordered, tone: "info", label: t("coll.acq.seg_ordered") },
    { value: b.draft, tone: "neutral", label: t("coll.acq.seg_draft") },
  ];
  const over = b.remaining < 0;
  const branch = S.lk.branches.find((x) => x.id === b.branch_id)?.name || t("common.all_branches");
  return html`<article class="card budget-card ${over ? "over" : ""}" aria-labelledby="bud-${b.id}">
    <div class="budget-top"><div class="budget-name"><h3 id="bud-${b.id}">${b.name}</h3><span class="small muted">${t("coll.acq.fy", { year: String(b.fiscal_year) })} · ${branch}</span></div>
      ${S.can.write ? html`<button type="button" class="btn sm ghost icon-only" data-edit-budget="${b.id}" aria-label="${t("coll.acq.edit_budget_named", { name: b.name })}" data-tip="${t("coll.acq.edit_budget")}">${icon("edit")}</button>` : ""}</div>
    <div class="budget-remaining"><span class="amount ${over ? "neg" : ""}">${money(b.remaining)}</span><span class="small muted">${t("coll.acq.left_of", { total: money(b.allocated) })}</span></div>
    ${meter({ segments: segs, max: b.allocated, label: t("coll.acq.meter_label", { name: b.name }), valueText: t("coll.acq.meter_text", { pct: num(b.used_pct), remaining: money(b.remaining) }) })}
    <dl class="budget-legend">
      <div><dt><span class="key tone-success" aria-hidden="true"></span>${t("coll.acq.seg_received")}</dt><dd>${money(b.received)}</dd></div>
      <div><dt><span class="key tone-info" aria-hidden="true"></span>${t("coll.acq.seg_ordered")}</dt><dd>${money(b.ordered)}</dd></div>
      <div><dt><span class="key tone-neutral" aria-hidden="true"></span>${t("coll.acq.seg_draft")}</dt><dd>${money(b.draft)}</dd></div>
    </dl>
    ${over ? html`<p class="budget-warn">${icon("alert")}${t("coll.acq.overspent")}</p>` : b.used_pct >= 90 ? html`<p class="budget-warn soft">${icon("alert")}${t("coll.acq.nearly_spent", { pct: num(b.used_pct) })}</p>` : ""}
  </article>`;
}

function budgetsSection() {
  return html`<section class="acq-section" aria-labelledby="budgets-h">
    <div class="section-head"><h2 id="budgets-h">${t("coll.acq.budgets")}</h2></div>
    ${S.budgets.length ? html`<div class="budget-grid">${S.budgets.map(budgetCard)}</div>`
      : html`<div class="card">${emptyState({ art: "inbox", compact: true, title: t("coll.acq.no_budgets_title"), body: t("coll.acq.no_budgets_body"),
        actions: S.can.write ? html`<button type="button" class="btn primary" data-new-budget>${icon("wallet")}${t("coll.acq.new_budget")}</button>` : "" })}</div>`}
  </section>`;
}

// ------------------------------------------------------------------ orders

function orderColumns() {
  return [
    { key: "id", label: t("coll.acq.col_no"), align: "num", width: "4.5rem", cardHidden: true, csv: (o) => o.id, render: (o) => html`<span class="mono small">${o.id}</span>` },
    { key: "title", label: t("coll.acq.col_title"), primary: true, hideable: false, csv: (o) => o.title,
      render: (o) => html`<div class="dt-cell-stack"><button type="button" class="link-cell" data-open-order="${o.id}">${o.title}</button>
        <span class="sub">${[o.isbn ? `ISBN ${o.isbn}` : "", o.suggestion_id ? t("coll.acq.from_suggestion") : ""].filter(Boolean).join(" · ")}</span></div>` },
    { key: "vendor", label: t("coll.acq.col_vendor"), csv: (o) => o.vendor, render: (o) => o.vendor },
    { key: "budget", label: t("coll.acq.col_budget"), cardHidden: true, csv: (o) => o.budget, render: (o) => html`<div class="dt-cell-stack"><span>${o.budget}</span><span class="sub">${t("coll.acq.fy", { year: String(o.fiscal_year) })}</span></div>` },
    { key: "qty", label: t("coll.acq.col_qty"), align: "num", cardHidden: true, csv: (o) => o.quantity, render: (o) => num(o.quantity) },
    { key: "unit", label: t("coll.acq.col_unit"), align: "num", hidden: true, csv: (o) => o.unit_price, render: (o) => money(o.unit_price) },
    { key: "total", label: t("coll.acq.col_total"), align: "num", csv: (o) => o.total, render: (o) => html`<strong>${money(o.total)}</strong>` },
    { key: "status", label: t("coll.acq.col_status"), csv: (o) => o.status, render: (o) => statusPill("order", o.status) },
    { key: "date", label: t("coll.acq.col_date"), cardHidden: true, csv: (o) => o.received_at || o.created_at,
      cellClass: "nowrap", render: (o) => html`<div class="dt-cell-stack"><span title="${datetime(o.created_at)}">${date(o.created_at)}</span>${o.received_at ? html`<span class="sub">${t("coll.acq.received_on", { date: date(o.received_at) })}</span>` : ""}</div>` },
    { key: "actions", label: t("coll.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions", render: (o) => rowActions(o) },
  ];
}

function rowActions(o) {
  if (!S.can.write) return html`<button type="button" class="btn sm ghost" data-open-order="${o.id}">${t("coll.acq.view")}</button>`;
  const primary = o.status === "draft" ? html`<button type="button" class="btn sm" data-place="${o.id}">${icon("send")}<span>${t("coll.acq.place")}</span></button>`
    : o.status === "ordered" ? html`<button type="button" class="btn sm" data-receive="${o.id}">${icon("download")}<span>${t("coll.acq.receive")}</span></button>` : "";
  const items = [
    { id: "open", label: t("coll.acq.details"), icon: "info" },
    o.status === "draft" ? { id: "edit", label: t("coll.acq.edit_draft"), icon: "edit" } : null,
    o.status === "ordered" ? { id: "notes", label: t("coll.acq.edit_notes"), icon: "edit" } : null,
    o.biblio_id ? { href: `/staff/catalog/${o.biblio_id}`, label: t("coll.acq.open_record"), icon: "book" } : null,
    ["draft", "ordered"].includes(o.status) ? { separator: true } : null,
    ["draft", "ordered"].includes(o.status) ? { id: "cancel", label: t("coll.acq.cancel_order"), icon: "x", danger: true } : null,
  ];
  return html`<div class="row-actions">${primary}${actionMenu({ label: t("coll.acq.actions_named", { no: String(o.id) }), size: "sm", data: String(o.id), items })}</div>`;
}

function filtered() {
  const s = state.get();
  const q = s.q.toLowerCase();
  return S.orders.filter((o) => (!s.status || o.status === s.status) && (!s.vendor || String(o.vendor_id) === s.vendor)
    && (!s.budget || String(o.budget_id) === s.budget) && (!q || `${o.title} ${o.isbn || ""} ${o.id} ${o.notes || ""}`.toLowerCase().includes(q)));
}

function ordersSection() {
  return html`<section class="acq-section" aria-labelledby="orders-h">
    <div class="section-head"><h2 id="orders-h">${t("coll.acq.orders")}<span class="ph-count" id="orders-count" aria-live="polite"></span></h2></div>
    <div class="filter-bar" id="o-filters" role="region" aria-label="${t("ui.filters.label")}">
      <div id="o-views"></div><div class="filter-row" id="o-filter-row"></div><div id="o-chips"></div></div>
    <div id="o-table"></div></section>`;
}

function wireOrders() {
  const s0 = state.get();
  const vendorOpts = [["", t("coll.acq.any_vendor")], ...S.vendors.map((v) => [String(v.id), v.name])];
  const budgetOpts = [["", t("coll.acq.any_budget")], ...S.budgets.map((b) => [String(b.id), `${b.name} · ${t("coll.acq.fy", { year: String(b.fiscal_year) })}`])];
  const statusOpts = [["", t("coll.acq.any_status")], ...STATUSES.map((x) => [x, t(`ui.status.${x}`, {}, t(`status.${x}`))])];
  const labels = { status: t("coll.acq.col_status"), q: t("common.search"), vendor: t("coll.acq.col_vendor"), budget: t("coll.acq.col_budget") };
  const optMap = { status: statusOpts, vendor: vendorOpts, budget: budgetOpts };
  $("#o-filter-row").innerHTML = html`${searchField({ name: "q", label: t("coll.acq.search_label"), value: s0.q, placeholder: t("coll.acq.search_placeholder") })}
    ${selectChip({ name: "vendor", label: labels.vendor, value: s0.vendor, options: vendorOpts })}
    ${selectChip({ name: "budget", label: labels.budget, value: s0.budget, options: budgetOpts })}`;
  const c = S.counts;
  const views = savedViews($("#o-views"), {
    id: "acq-orders", keys: FILTERS, current: () => state.get(),
    presets: [
      { id: "all", label: t("coll.acq.view_all"), params: {} },
      { id: "draft", label: `${t("coll.acq.view_drafts")} · ${num(c.draft || 0)}`, params: { status: "draft" } },
      { id: "ordered", label: `${t("coll.acq.view_ordered")} · ${num(c.ordered || 0)}`, params: { status: "ordered" } },
      { id: "received", label: t("coll.acq.view_received"), params: { status: "received" } },
      { id: "cancelled", label: t("coll.acq.view_cancelled"), params: { status: "cancelled" } },
    ],
    onSelect: (p) => apply(p, true),
  });
  const chips = () => {
    const s = state.get();
    $("#o-chips").innerHTML = activeFilters(["q", "vendor", "budget"].filter((k) => s[k]).map((k) => ({ key: k, label: labels[k],
      value: k === "q" ? `“${s.q}”` : (optMap[k].find(([v]) => v === s[k])?.[1] || s[k]) })));
  };
  S.table = dataTable($("#o-table"), {
    id: "acq-orders", caption: t("coll.acq.orders"), columns: orderColumns(), selectable: S.can.write, rowLabel: (o) => `${o.id} ${o.title}`,
    exportName: "purchase-orders", perPage: s0.per_page,
    onPage: ({ page, perPage }) => apply({ page, per_page: perPage }),
    empty: { art: "inbox", title: t("coll.acq.no_orders_title"), body: t("coll.acq.no_orders_body"),
      actions: S.can.write ? html`<button type="button" class="btn primary" data-new-order>${icon("cart")}${t("coll.acq.new_order")}</button>` : "" },
    bulkActions: S.can.write ? [
      { id: "place", label: t("coll.acq.bulk_place"), icon: "send", run: (rows, ctx) => bulk("place", rows, ctx) },
      { id: "cancel", label: t("coll.acq.bulk_cancel"), icon: "x", danger: true, run: (rows, ctx) => bulk("cancel", rows, ctx) },
    ] : [],
  });
  function paint() {
    const s = state.get();
    const rows = filtered();
    const start = (s.page - 1) * s.per_page;
    S.table.setRows(rows.slice(start, start + s.per_page), { total: rows.length, page: s.page, perPage: s.per_page });
    $("#orders-count").textContent = num(rows.length);
    wireMenus($("#o-table"), onMenu);
  }
  function apply(changes, sync = false) {
    const reset = Object.keys(changes).some((k) => FILTERS.includes(k));
    state.set({ ...changes, ...(reset && !("page" in changes) ? { page: 1 } : {}) });
    const s = state.get();
    if (sync) {
      for (const k of ["q", "vendor", "budget"]) {
        const el = $(`#o-filter-row [name="${k}"]`);
        if (el) { el.value = s[k]; el.closest(".select-chip")?.classList.toggle("active", !!s[k]); }
      }
    }
    chips(); views.render(); paint();
  }
  wireFilterBar($("#o-filters"), (ch) => apply(ch, true), { keys: FILTERS });
  S.paint = paint;
  chips();
  paint();
}

async function bulk(kind, rows, { clear }) {
  const eligible = rows.filter((o) => (kind === "place" ? o.status === "draft" : ["draft", "ordered"].includes(o.status)));
  if (!eligible.length) { toast(t(kind === "place" ? "coll.acq.bulk_place_none" : "coll.acq.bulk_cancel_none"), "warn"); return; }
  if (kind === "cancel" && !(await confirmDialog(t("coll.acq.bulk_cancel_title", { count: eligible.length }), t("coll.acq.bulk_cancel_text"), t("coll.acq.cancel_orders")))) return;
  let ok = 0;
  const failed = [];
  for (const o of eligible) {
    try { await api(`/acquisitions/orders/${o.id}/${kind}`, { method: "POST" }); ok++; } catch (e) { failed.push(`#${o.id}: ${e.message}`); }
  }
  toast(t(kind === "place" ? "coll.acq.placed_n" : "coll.acq.cancelled_n", { count: ok }) + (failed.length ? ` · ${failed.join("; ")}` : ""), failed.length ? "warn" : "success", failed.length ? 9000 : 4200);
  clear();
  await refresh();
}

// ------------------------------------------------------------------ order side panel

function lifecycle(o) {
  const steps = ["draft", "ordered", "received"];
  const at = o.status === "cancelled" ? -1 : steps.indexOf(o.status);
  return html`<ol class="lifecycle ${o.status === "cancelled" ? "cancelled" : ""}" aria-label="${t("coll.acq.lifecycle")}">
    ${steps.map((s, i) => html`<li class="${i < at ? "done" : i === at ? "current" : ""}" ${i === at ? html`aria-current="step"` : ""}>
      <span class="lc-dot" aria-hidden="true">${i < at ? icon("check") : num(i + 1)}</span><span class="lc-label">${t(`ui.status.${s}`)}</span></li>`)}
    ${o.status === "cancelled" ? html`<li class="current cancelled" aria-current="step"><span class="lc-dot" aria-hidden="true">${icon("x")}</span><span class="lc-label">${t("status.cancelled")}</span></li>` : ""}</ol>`;
}

function orderPanel(o) {
  const vendor = S.vendors.find((v) => v.id === o.vendor_id);
  const body = html`<div class="stack">${lifecycle(o)}
    ${o.status === "draft" ? alertBox(t(o.suggestion_id ? "coll.acq.draft_from_suggestion" : "coll.acq.draft_hint"), "info") : ""}
    ${facts([
      [t("coll.acq.col_vendor"), html`${o.vendor}${vendor?.discount_pct ? html` <span class="muted small">${t("coll.acq.discount", { pct: num(vendor.discount_pct) })}</span>` : ""}`],
      [t("coll.acq.col_budget"), `${o.budget} · ${t("coll.acq.fy", { year: String(o.fiscal_year) })}`],
      [t("coll.field.isbn"), o.isbn ? html`<span class="mono">${o.isbn}</span>` : ""],
      [t("coll.acq.col_qty"), num(o.quantity)],
      [t("coll.acq.col_unit"), money(o.unit_price)],
      [t("coll.acq.col_total"), html`<strong>${money(o.total)}</strong>`],
      [t("coll.acq.created"), datetime(o.created_at)],
      [t("coll.acq.received"), o.received_at ? datetime(o.received_at) : ""],
      [t("coll.items.notes"), o.notes],
      [t("coll.acq.record"), o.biblio_id ? html`<a href="/staff/catalog/${o.biblio_id}">${recNo(o.biblio_id)}</a>` : ""],
      [t("coll.acq.suggestion"), o.suggestion_id ? html`<a href="/staff/requests#suggestions">${t("coll.acq.suggestion_no", { no: String(o.suggestion_id) })}</a>` : ""],
    ])}</div>`;
  const w = S.can.write;
  const footer = o.status === "draft" && w ? html`<button type="button" class="btn ghost danger" data-p-cancel>${icon("x")}${t("coll.acq.cancel_order")}</button><span class="spacer"></span>
      <button type="button" class="btn" data-p-edit>${icon("edit")}${t("coll.acq.edit_draft")}</button><button type="button" class="btn primary" data-p-place>${icon("send")}${t("coll.acq.place")}</button>`
    : o.status === "ordered" && w ? html`<button type="button" class="btn ghost danger" data-p-cancel>${icon("x")}${t("coll.acq.cancel_order")}</button><span class="spacer"></span>
      <button type="button" class="btn" data-p-notes>${icon("edit")}${t("coll.acq.edit_notes")}</button><button type="button" class="btn primary" data-p-receive>${icon("download")}${t("coll.acq.receive")}</button>`
    : o.biblio_id ? html`<a class="btn primary" href="/staff/catalog/${o.biblio_id}">${icon("book")}${t("coll.acq.open_record")}</a>` : html`<button type="button" class="btn" data-close>${t("common.close")}</button>`;
  const p = sidePanel({ title: o.title, subtitle: html`${t("coll.acq.order_no", { no: String(o.id) })} · ${statusPill("order", o.status)}`, body, footer });
  p.el.classList.add("acq-panel");
  p.el.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const act = b.matches("[data-p-cancel]") ? "cancel" : b.matches("[data-p-edit]") ? "edit" : b.matches("[data-p-place]") ? "place" : b.matches("[data-p-notes]") ? "notes" : b.matches("[data-p-receive]") ? "receive" : null;
    if (!act) return;
    p.close();
    await p.closed;
    await orderAction(act, o, b);
  });
}

async function orderAction(act, o, btn) {
  try {
    if (act === "open") orderPanel(o);
    else if (act === "edit") await orderForm({ order: o });
    else if (act === "notes") await notesForm(o);
    else if (act === "place") {
      const r = await withBusy(btn?.isConnected ? btn : null, () => api(`/acquisitions/orders/${o.id}/place`, { method: "POST" }));
      toast(t("coll.acq.placed", { no: String(r.id) }), "success");
      await refresh();
    } else if (act === "receive") await receiveOrder(o);
    else if (act === "cancel") {
      if (!(await confirmDialog(t("coll.acq.cancel_title", { no: String(o.id) }), t("coll.acq.cancel_text", { title: o.title, amount: money(o.total), budget: o.budget }), t("coll.acq.cancel_order")))) return;
      await api(`/acquisitions/orders/${o.id}/cancel`, { method: "POST" });
      toast(t("coll.acq.cancelled", { no: String(o.id) }), "success");
      await refresh();
    }
  } catch (e) { if (!e.toasted) toast(e.message, "error"); }
}

const onMenu = (action, btn, forKey) => {
  const o = S.orders.find((x) => String(x.id) === forKey);
  if (o) orderAction(action, o, btn);
};

// ------------------------------------------------------------------ forms

function orderFields(o = {}, prefill = {}) {
  const v = { ...prefill, ...o };
  const budgetOpt = (b) => html`<option value="${b.id}" data-remaining="${b.remaining + (o.id && o.budget_id === b.id && o.status !== "cancelled" ? o.total : 0)}" ${b.id === v.budget_id ? "selected" : ""}>${b.name} · ${t("coll.acq.fy", { year: String(b.fiscal_year) })} · ${t("coll.acq.left", { amount: money(b.remaining) })}</option>`;
  return html`<div class="stack">
    <div class="form-grid">
      <div class="field"><label for="of-vendor">${t("coll.acq.col_vendor")}</label><select id="of-vendor" name="vendor_id" required>${S.vendors.map((x) => html`<option value="${x.id}" ${x.id === v.vendor_id ? "selected" : ""}>${x.name}${x.discount_pct ? ` (${t("coll.acq.discount", { pct: num(x.discount_pct) })})` : ""}</option>`)}</select></div>
      <div class="field"><label for="of-budget">${t("coll.acq.col_budget")}</label><select id="of-budget" name="budget_id" required>${S.budgets.map(budgetOpt)}</select></div>
      <div class="field span-2"><label for="of-title">${t("coll.field.title")}<span class="req" aria-hidden="true">*</span></label><input id="of-title" name="title" required maxlength="500" value="${v.title || ""}" autocomplete="off"></div>
      <div class="field"><label for="of-isbn">${t("coll.field.isbn")}<span class="optional">${t("ui.form.optional")}</span></label><input id="of-isbn" name="isbn" class="mono" maxlength="20" value="${v.isbn || ""}" autocomplete="off"></div>
      <div class="field"><label for="of-qty">${t("coll.acq.col_qty")}</label><input id="of-qty" name="quantity" type="number" min="1" max="1000" step="1" required value="${v.quantity || 1}"></div>
      <div class="field"><label for="of-price">${t("coll.acq.unit_price_field")}</label><input id="of-price" name="unit_price" type="number" min="0" step="0.01" required inputmode="decimal" value="${v.unit_price ?? ""}"></div>
      <div class="field"><label for="of-notes">${t("coll.items.notes")}<span class="optional">${t("ui.form.optional")}</span></label><input id="of-notes" name="notes" maxlength="255" value="${v.notes || ""}" autocomplete="off"></div>
    </div>
    ${v.biblio_id ? html`<input type="hidden" name="biblio_id" value="${v.biblio_id}"><p class="small muted">${icon("info")} ${t("coll.acq.adds_to_record", { no: recNo(v.biblio_id) })}</p>` : ""}
    <input type="hidden" name="status" value="ordered">
    <div class="order-total" id="of-total" aria-live="polite"></div>
    ${o.id ? "" : html`<p class="small muted">${t("coll.acq.draft_explain")}</p>`}</div>`;
}

function wireTotal(dlg) {
  const update = () => {
    const qty = Number($("#of-qty", dlg).value || 0), price = Number($("#of-price", dlg).value || 0);
    const remaining = Number($("#of-budget", dlg).selectedOptions[0]?.dataset.remaining || 0), total = qty * price;
    const over = total > remaining;
    $("#of-total", dlg).innerHTML = alertBox(html`${t("coll.acq.total_line", { total: money(total) })} · ${over ? html`<strong>${t("coll.acq.total_over", { remaining: money(remaining) })}</strong>`
      : t("coll.acq.total_left", { left: money(remaining - total) })}`, over ? "bad" : "info");
  };
  dlg.addEventListener("input", update);
  dlg.addEventListener("change", update);
  update();
}

async function orderForm({ order = null, prefill = {} } = {}) {
  if (!S.vendors.length || !S.budgets.length) { toast(t(!S.vendors.length ? "coll.acq.need_vendor" : "coll.acq.need_budget"), "warn"); return; }
  const editing = !!order;
  const r = await formModal({ title: editing ? t("coll.acq.edit_draft_title", { no: String(order.id) }) : t("coll.acq.new_order_title"), size: "lg",
    submit: editing ? t("common.save") : t("coll.acq.place_order"), body: orderFields(order || {}, prefill) },
  (fd) => {
    const data = { vendor_id: +fd.get("vendor_id"), budget_id: +fd.get("budget_id"), title: str(fd, "title"), isbn: str(fd, "isbn") || null,
      quantity: +fd.get("quantity"), unit_price: paise(fd.get("unit_price")), notes: str(fd, "notes") || null };
    if (editing) return api(`/acquisitions/orders/${order.id}`, { method: "PATCH", body: data });
    return api("/acquisitions/orders", { method: "POST", body: { ...data, biblio_id: fd.get("biblio_id") ? +fd.get("biblio_id") : null, status: fd.get("status") } });
  },
  (dlg) => {
    wireTotal(dlg);
    if (!editing) {
      const foot = $(".dialog-foot", dlg);
      foot.insertAdjacentHTML("afterbegin", html`<button type="button" class="btn" data-as-draft>${icon("edit")}${t("coll.acq.save_draft")}</button>`);
      $("[data-as-draft]", dlg).addEventListener("click", () => {
        $('input[name="status"]', dlg).value = "draft";
        $("form", dlg).requestSubmit($('button[value="ok"]', dlg));
      });
    }
  });
  if (!r) return;
  toast(editing ? t("coll.acq.draft_saved", { no: String(r.id) }) : t(r.status === "draft" ? "coll.acq.draft_created" : "coll.acq.order_created", { no: String(r.id), total: money(r.total) }), "success", 6000);
  await refresh();
}

async function notesForm(o) {
  const r = await formModal({ title: t("coll.acq.edit_notes_title", { no: String(o.id) }), size: "sm", submit: t("common.save"),
    body: html`<div class="field"><label for="on-notes">${t("coll.items.notes")}</label><input id="on-notes" name="notes" maxlength="255" value="${o.notes || ""}"></div>` },
  (fd) => api(`/acquisitions/orders/${o.id}`, { method: "PATCH", body: { notes: str(fd, "notes") || null } }));
  if (r) { toast(t("coll.acq.notes_saved"), "success"); await refresh(); }
}

async function receiveOrder(o) {
  const home = BOOT.user?.home_branch_id;
  const r = await formModal({ title: t("coll.acq.receive_title", { no: String(o.id) }), submit: t("coll.acq.receive"), body: html`<div class="stack">
    <p>${t(o.biblio_id ? "coll.acq.receive_text_record" : "coll.acq.receive_text", { count: o.quantity, title: o.title, vendor: o.vendor })}</p>
    <div class="form-grid">
      <div class="field"><label for="ro-branch">${t("coll.acq.receiving_branch")}</label><select id="ro-branch" name="branch_id" required>${S.lk.branches.map((b) => html`<option value="${b.id}" ${b.id === home ? "selected" : ""}>${b.name}</option>`)}</select></div>
      <div class="field"><label for="ro-type">${t("coll.items.type")}</label><select id="ro-type" name="item_type_id" required>${S.lk.item_types.map((x) => html`<option value="${x.id}" ${x.code === "BOOK" ? "selected" : ""}>${x.name}</option>`)}</select></div>
    </div></div>` },
  (fd) => api(`/acquisitions/orders/${o.id}/receive`, { method: "POST", body: { branch_id: +fd.get("branch_id"), item_type_id: +fd.get("item_type_id") } }));
  if (!r) return;
  toast(t("coll.acq.received_toast", { count: r.barcodes.length, title: r.order.title, barcodes: r.barcodes.join(", ") }), "success", {
    duration: 12000, action: { label: t("coll.acq.print_labels"), run: () => { location.href = `/staff/labels?${qs({ kind: "spine", source: "barcodes", barcodes: r.barcodes.join("\n") })}`; } } });
  await refresh();
}

async function budgetForm(b = null) {
  const year = new Date().getFullYear();
  const r = await formModal({ title: b ? t("coll.acq.edit_budget_title", { name: b.name }) : t("coll.acq.new_budget"), submit: b ? t("common.save") : t("coll.acq.create_budget"), body: html`<div class="form-grid">
    <div class="field span-2"><label for="bf-name">${t("coll.acq.budget_name")}</label><input id="bf-name" name="name" required maxlength="120" value="${b?.name || ""}" placeholder="${t("coll.acq.budget_name_placeholder")}" autocomplete="off"></div>
    <div class="field"><label for="bf-year">${t("coll.acq.fiscal_year")}</label><input id="bf-year" name="fiscal_year" type="number" min="2000" max="2100" required value="${b?.fiscal_year || year}"></div>
    <div class="field"><label for="bf-alloc">${t("coll.acq.allocation")}</label><input id="bf-alloc" name="allocated" type="number" min="0" step="0.01" required inputmode="decimal" value="${b?.allocated ?? ""}">
      ${b ? html`<div class="field-help">${t("coll.acq.allocation_hint", { amount: money(b.committed) })}</div>` : ""}</div>
    <div class="field span-2"><label for="bf-branch">${t("common.branch")}</label><select id="bf-branch" name="branch_id"><option value="">${t("common.all_branches")}</option>
      ${S.lk.branches.map((x) => html`<option value="${x.id}" ${x.id === b?.branch_id ? "selected" : ""}>${x.name}</option>`)}</select></div></div>` },
  (fd) => {
    const data = { name: str(fd, "name"), fiscal_year: +fd.get("fiscal_year"), allocated: paise(fd.get("allocated")), branch_id: fd.get("branch_id") ? +fd.get("branch_id") : null };
    return b ? api(`/acquisitions/budgets/${b.id}`, { method: "PATCH", body: data }) : api("/acquisitions/budgets", { method: "POST", body: data });
  });
  if (r) { toast(t(b ? "coll.acq.budget_saved" : "coll.acq.budget_created"), "success"); await refresh(); }
}

function vendorsPanel() {
  const list = () => (S.vendors.length ? html`<ul class="vendor-list" role="list">${S.vendors.map((v) => html`<li>
      <div class="v-main"><strong>${v.name}</strong><span class="small muted">${[v.email, v.phone].filter(Boolean).join(" · ") || t("coll.acq.no_contact")}</span>
        <span class="small">${v.discount_pct ? t("coll.acq.discount", { pct: num(v.discount_pct) }) : t("coll.acq.no_discount")} · ${t("coll.acq.orders_n", { count: v.orders || 0, n: num(v.orders || 0) })}</span></div>
      ${S.can.write ? html`<button type="button" class="btn sm" data-edit-vendor="${v.id}" aria-label="${t("coll.acq.edit_vendor_named", { name: v.name })}">${icon("edit")}<span>${t("coll.common.edit")}</span></button>` : ""}</li>`)}</ul>`
    : emptyState({ art: "inbox", compact: true, title: t("coll.acq.no_vendors_title"), body: t("coll.acq.no_vendors_body") }));
  const p = sidePanel({ title: t("coll.acq.vendors"), subtitle: t("coll.acq.vendors_sub"), body: list(),
    footer: S.can.write ? html`<button type="button" class="btn primary" data-new-vendor>${icon("plus")}${t("coll.acq.new_vendor")}</button>` : "" });
  p.el.addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-edit-vendor]"), nv = e.target.closest("[data-new-vendor]");
    if (!ed && !nv) return;
    const v = ed ? S.vendors.find((x) => x.id === +ed.dataset.editVendor) : null;
    const saved = await vendorForm(v);
    if (saved) { S.vendors = (await api("/acquisitions/vendors")).results; p.setBody(list()); }
  });
}

function vendorForm(v = null) {
  return formModal({ title: v ? t("coll.acq.edit_vendor_named", { name: v.name }) : t("coll.acq.new_vendor"), submit: v ? t("common.save") : t("coll.acq.add_vendor"), body: html`<div class="form-grid">
    <div class="field span-2"><label for="vf-name">${t("coll.acq.vendor_name")}</label><input id="vf-name" name="name" required maxlength="160" value="${v?.name || ""}" autocomplete="off"></div>
    <div class="field"><label for="vf-email">${t("coll.acq.email")}</label><input id="vf-email" name="email" type="email" value="${v?.email || ""}" autocomplete="off"></div>
    <div class="field"><label for="vf-phone">${t("coll.acq.phone")}</label><input id="vf-phone" name="phone" type="tel" value="${v?.phone || ""}" autocomplete="off"></div>
    <div class="field"><label for="vf-disc">${t("coll.acq.discount_field")}</label><input id="vf-disc" name="discount_pct" type="number" min="0" max="100" step="0.1" value="${v?.discount_pct ?? 0}"></div></div>` },
  (fd) => {
    const data = { name: str(fd, "name"), email: str(fd, "email") || null, phone: str(fd, "phone") || null, discount_pct: Number(fd.get("discount_pct") || 0) };
    return v ? api(`/acquisitions/vendors/${v.id}`, { method: "PATCH", body: data }) : api("/acquisitions/vendors", { method: "POST", body: data });
  }).then((r) => { if (r) toast(t(v ? "coll.acq.vendor_saved" : "coll.acq.vendor_created"), "success"); return r; });
}

// ------------------------------------------------------------------ AI demand signals

function suggestionsSection() {
  const rows = S.suggestions;
  return html`<section class="card panel-ai acq-section" aria-labelledby="suggest-h">
    <div class="card-head"><h2 id="suggest-h">${icon("sparkle")} ${t("coll.acq.ai_title")}</h2><span class="small muted">${t("coll.acq.ai_sub")}</span></div>
    <div class="card-body">${rows.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-labelledby="suggest-h"><table class="table">
      <caption class="sr-only">${t("coll.acq.ai_title")}</caption>
      <thead><tr><th scope="col">${t("coll.acq.col_title")}</th><th scope="col" class="num">${t("coll.acq.ai_holds")}</th><th scope="col" class="num">${t("coll.acq.ai_copies")}</th>
        <th scope="col" class="num">${t("coll.acq.ai_ratio")}</th><th scope="col" class="num">${t("coll.acq.ai_suggested")}</th><th scope="col"><span class="sr-only">${t("coll.common.actions")}</span></th></tr></thead>
      <tbody>${rows.map((s, i) => html`<tr><td><a href="/staff/catalog/${s.biblio_id}">${s.title}</a></td><td class="num">${num(s.holds)}</td>
        <td class="num">${s.copies ? num(s.copies) : statusPill("item", "missing", t("coll.acq.ai_none"))}</td>
        <td class="num">${statusPill("loan", s.ratio >= 4 ? "overdue" : "due_soon", t("coll.acq.ai_ratio_value", { ratio: num(s.ratio) }))}</td>
        <td class="num"><strong>+${num(s.suggested_copies)}</strong></td>
        <td class="right">${S.can.write ? html`<button type="button" class="btn sm" data-suggest-order="${i}">${icon("cart")}${t("coll.acq.ai_order")}</button>` : ""}</td></tr>`)}</tbody></table></div>
      <p class="tiny muted ai-note">${t("coll.acq.ai_note")}</p>`
      : emptyState({ art: "done", compact: true, title: t("coll.acq.ai_none_title"), body: t("coll.acq.ai_none_body") })}</div></section>`;
}

// ------------------------------------------------------------------ data

async function load() {
  const [budgets, orders, vendors, lookups, suggestions, patronSugg] = await Promise.all([
    api("/acquisitions/budgets"), api("/acquisitions/orders"), api("/acquisitions/vendors"), api("/lookups"),
    api("/acquisitions/suggestions").catch(() => ({ results: [] })),
    S.can.suggestions ? api("/suggestions?status=pending").catch(() => null) : null,
  ]);
  S.budgets = budgets.results; S.orders = orders.results; S.counts = orders.counts || {}; S.vendors = vendors.results;
  S.lk = { branches: lookups.branches || [], item_types: lookups.item_types || [] };
  S.suggestions = suggestions.results;
  S.patronPending = patronSugg?.counts?.pending || 0;
}

function render() {
  const el = body();
  el.removeAttribute("aria-busy");
  const notice = S.patronPending ? alertBox(html`${t("coll.acq.patron_pending", { count: S.patronPending })} <a href="/staff/requests#suggestions">${t("coll.acq.review_suggestions")}</a>`, "info") : "";
  el.innerHTML = html`${kpis()}${notice ? html`<div class="acq-notice">${notice}</div>` : ""}${budgetsSection()}${ordersSection()}${suggestionsSection()}`;
  wireOrders();
}

async function refresh() {
  await load();
  const scroll = window.scrollY;
  const sel = S.table?.state;
  render();
  if (sel) window.scrollTo(0, scroll);
}

export default async function init() {
  const root = $("#acq");
  S.can = { write: root.dataset.canWrite === "1", suggestions: root.dataset.canSuggestions === "1" };
  try { await load(); } catch (e) {
    body().removeAttribute("aria-busy");
    body().innerHTML = errorState(e, { retry: true });
    $("[data-retry]", body())?.addEventListener("click", () => location.reload());
    return;
  }
  render();
  $("#vendors-btn").addEventListener("click", vendorsPanel);
  $("#new-budget")?.addEventListener("click", () => budgetForm());
  $("#new-order")?.addEventListener("click", () => orderForm());
  root.addEventListener("click", (e) => {
    const find = (attr) => { const b = e.target.closest(`[${attr}]`); return b ? [b, S.orders.find((o) => String(o.id) === b.getAttribute(attr))] : [null, null]; };
    let [b, o] = find("data-open-order");
    if (o) { orderPanel(o); return; }
    [b, o] = find("data-place");
    if (o) { orderAction("place", o, b); return; }
    [b, o] = find("data-receive");
    if (o) { orderAction("receive", o, b); return; }
    const eb = e.target.closest("[data-edit-budget]");
    if (eb) { budgetForm(S.budgets.find((x) => x.id === +eb.dataset.editBudget)); return; }
    if (e.target.closest("[data-new-budget]")) { budgetForm(); return; }
    if (e.target.closest("[data-new-order]")) { orderForm(); return; }
    const so = e.target.closest("[data-suggest-order]");
    if (so) {
      const s = S.suggestions[+so.dataset.suggestOrder];
      withBusy(so, () => api(`/biblios/${s.biblio_id}`)).catch(() => ({})).then((bib) => orderForm({ prefill: { title: s.title, isbn: bib?.isbn || "", quantity: s.suggested_copies, biblio_id: s.biblio_id } }));
    }
  });
}
