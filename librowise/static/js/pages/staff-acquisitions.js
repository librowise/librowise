// Staff: acquisitions — budgets, vendors, purchase orders and AI purchase suggestions.
import {
  $, $$, BOOT, api, badge, confirmDialog, date, datetime, empty, html, icon, modal, money, num, qs, skeleton, toast, withBusy,
} from "/static/js/core.js";

const state = { budgets: [], orders: [], openOrders: [], vendors: [], suggestions: [], lookups: { branches: [], item_types: [] }, status: "" };

// ------------------------------------------------------------------ small helpers

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

const errorBox = (msg) => html`<div class="alert bad" role="alert">${icon("alert")}<div>${msg}</div></div>`;
const str = (fd, k) => String(fd.get(k) ?? "").trim();
const paise = (rupees) => Math.round(Number(rupees || 0) * 100);
const ORDER_BADGE = { draft: ["", "Draft"], ordered: ["info", "Ordered"], received: ["ok", "Received"], cancelled: ["bad", "Cancelled"] };
const orderBadge = (s) => badge(...(ORDER_BADGE[s] || ["", s]));
const meterClass = (pct) => (pct > 90 ? "bad" : pct > 75 ? "warn" : "");

// ------------------------------------------------------------------ renderers

function renderStats() {
  const sum = (k) => state.budgets.reduce((a, b) => a + Number(b[k] || 0), 0);
  const allocated = sum("allocated"), committed = sum("committed"), remaining = sum("remaining");
  const pct = allocated ? (100 * committed) / allocated : 0;
  const open = state.openOrders;
  $("#acq-stats").innerHTML = html`
    <div class="card stat"><span class="label">Allocated</span><span class="value">${money(allocated)}</span>
      <span class="delta">${state.budgets.length} budget${state.budgets.length === 1 ? "" : "s"}</span></div>
    <div class="card stat"><span class="label">Committed</span><span class="value">${money(committed)}</span>
      <span class="delta">${pct.toFixed(1)}% of allocation</span></div>
    <div class="card stat ${remaining < 0 ? "alert" : ""}"><span class="label">Remaining</span><span class="value">${money(remaining)}</span>
      <span class="delta">Available to commit</span></div>
    <div class="card stat"><span class="label">Open orders</span><span class="value">${num(open.length)}</span>
      <span class="delta">${money(open.reduce((a, o) => a + Number(o.total || 0), 0))} awaiting delivery</span></div>`;
}

function renderBudgets() {
  const box = $("#acq-budgets");
  if (!state.budgets.length) {
    box.innerHTML = html`<div class="card">${empty("No budgets yet. Create one to start ordering.", "wallet")}</div>`;
    return;
  }
  box.innerHTML = html`${state.budgets.map((b) => {
    const pct = Math.min(100, Math.max(0, Number(b.used_pct || 0)));
    return html`<article class="card pad stack tight">
      <div class="row between"><h3 style="margin:0">${b.name}</h3><span class="badge">FY ${b.fiscal_year}</span></div>
      <div class="meter ${meterClass(b.used_pct)}" role="progressbar" aria-label="${b.name}: budget used"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="${b.used_pct}"><div style="width:${pct}%"></div></div>
      <div class="small muted">${b.used_pct}% committed</div>
      <div>
        <div class="kv"><span class="muted">Allocated</span><span class="num">${money(b.allocated)}</span></div>
        <div class="kv"><span class="muted">Committed</span><span class="num">${money(b.committed)}</span></div>
        <div class="kv"><strong>Remaining</strong><strong class="num">${money(b.remaining)}</strong></div>
      </div></article>`;
  })}`;
}

function renderOrders() {
  const box = $("#acq-orders");
  const rows = state.orders;
  if (!rows.length) {
    box.innerHTML = empty(state.status ? "No orders with this status." : "No purchase orders yet.", "cart");
    return;
  }
  box.innerHTML = html`<div class="table-wrap"><table class="table">
    <caption class="sr-only">Purchase orders</caption>
    <thead><tr><th scope="col">#</th><th scope="col">Title</th><th scope="col">Vendor</th><th scope="col">Budget</th>
      <th scope="col" class="num">Qty</th><th scope="col" class="num">Unit price</th><th scope="col" class="num">Total</th>
      <th scope="col">Status</th><th scope="col">Ordered</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map((o) => html`<tr>
      <td class="muted tiny mono">${o.id}</td>
      <td>${o.biblio_id ? html`<a href="/staff/catalog/${o.biblio_id}">${o.title}</a>` : o.title}
        ${o.isbn ? html`<div class="tiny muted mono">ISBN ${o.isbn}</div>` : ""}</td>
      <td>${o.vendor}</td>
      <td>${o.budget}</td>
      <td class="num">${num(o.quantity)}</td>
      <td class="num">${money(o.unit_price)}</td>
      <td class="num"><strong>${money(o.total)}</strong></td>
      <td>${orderBadge(o.status)}${o.received_at ? html`<div class="tiny muted">${date(o.received_at)}</div>` : ""}</td>
      <td class="nowrap" title="${datetime(o.created_at)}">${date(o.created_at)}</td>
      <td class="right nowrap">${o.status === "ordered" ? html`<button class="btn sm" data-receive="${o.id}">${icon("download")}Receive</button>` : ""}
        ${o.status === "ordered" || o.status === "draft" ? html`<button class="btn sm danger" data-cancel="${o.id}" aria-label="Cancel order ${o.id}">${icon("x")}Cancel</button>` : ""}</td>
    </tr>`)}</tbody></table></div>`;
}

function renderSuggestions() {
  const box = $("#acq-suggest");
  const rows = state.suggestions;
  if (!rows.length) {
    box.innerHTML = empty("Hold queues are in balance with copies — no purchases suggested right now.", "check");
    return;
  }
  box.innerHTML = html`<div class="table-wrap"><table class="table">
    <caption class="sr-only">AI purchase suggestions</caption>
    <thead><tr><th scope="col">Title</th><th scope="col" class="num">Holds</th><th scope="col" class="num">Copies</th>
      <th scope="col" class="num">Holds per copy</th><th scope="col" class="num">Suggested</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map((s, i) => html`<tr>
      <td><a href="/staff/catalog/${s.biblio_id}">${s.title}</a></td>
      <td class="num">${num(s.holds)}</td>
      <td class="num">${s.copies ? num(s.copies) : badge("bad", "None")}</td>
      <td class="num">${badge(s.ratio >= 4 ? "bad" : "warn", `${s.ratio}×`)}</td>
      <td class="num"><strong>+${num(s.suggested_copies)}</strong></td>
      <td class="right"><button class="btn sm ai" data-suggest-order="${i}">${icon("cart")}Order</button></td></tr>`)}</tbody></table></div>
    <p class="tiny muted" style="margin:.75rem 0 0">Suggests enough copies to bring the queue to about two holds per copy.</p>`;
}

// ------------------------------------------------------------------ data

async function loadBudgets() {
  state.budgets = (await api("/acquisitions/budgets")).results;
  renderBudgets();
}

async function loadOrders() {
  state.orders = (await api(`/acquisitions/orders?${qs({ status: state.status })}`)).results;
  if (!state.status || state.status === "ordered") state.openOrders = state.orders.filter((o) => o.status === "ordered");
  renderOrders();
}

async function loadAll() {
  $("#acq-stats").innerHTML = Array.from({ length: 4 }, () => `<div class="card pad">${skeleton(2)}</div>`).join("");
  $("#acq-budgets").innerHTML = `<div class="card pad">${skeleton(3)}</div>`;
  $("#acq-orders").innerHTML = skeleton(6);
  $("#acq-suggest").innerHTML = skeleton(3);
  const jobs = [
    loadBudgets().catch((e) => { $("#acq-budgets").innerHTML = errorBox(e.message); throw e; }),
    loadOrders().catch((e) => { $("#acq-orders").innerHTML = errorBox(e.message); throw e; }),
    api("/acquisitions/suggestions").then((r) => { state.suggestions = r.results; renderSuggestions(); })
      .catch((e) => { $("#acq-suggest").innerHTML = errorBox(e.message); throw e; }),
    api("/acquisitions/vendors").then((r) => { state.vendors = r.results; }),
    api("/lookups").then((r) => { state.lookups = { branches: r.branches || [], item_types: r.item_types || [] }; }),
  ];
  const results = await Promise.allSettled(jobs);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) toast(failed.reason.message, "error");
  renderStats();
}

async function refreshAfterChange() {
  await Promise.allSettled([loadBudgets(), loadOrders()]);
  renderStats();
}

// ------------------------------------------------------------------ dialogs

async function newOrder(prefill = {}) {
  if (!state.vendors.length || !state.budgets.length) {
    toast(!state.vendors.length ? "Add a vendor before placing orders." : "Create a budget before placing orders.", "error");
    return;
  }
  const body = html`<div class="stack">
    <div class="grid cols-2">
      <div class="field"><label for="no-vendor">Vendor</label>
        <select id="no-vendor" name="vendor_id" required>${state.vendors.map((v) =>
          html`<option value="${v.id}">${v.name}${v.discount_pct ? ` (${v.discount_pct}% discount)` : ""}</option>`)}</select></div>
      <div class="field"><label for="no-budget">Budget</label>
        <select id="no-budget" name="budget_id" required>${state.budgets.map((b) =>
          html`<option value="${b.id}" data-remaining="${b.remaining}">${b.name} · FY ${b.fiscal_year} · ${money(b.remaining)} left</option>`)}</select></div>
    </div>
    <div class="field"><label for="no-title">Title</label>
      <input id="no-title" name="title" required maxlength="500" value="${prefill.title || ""}" autocomplete="off"></div>
    <div class="grid cols-3">
      <div class="field"><label for="no-isbn">ISBN <span class="muted">(optional)</span></label>
        <input id="no-isbn" name="isbn" maxlength="20" class="mono" value="${prefill.isbn || ""}" autocomplete="off"></div>
      <div class="field"><label for="no-qty">Quantity</label>
        <input id="no-qty" name="quantity" type="number" min="1" max="1000" step="1" required value="${prefill.quantity || 1}"></div>
      <div class="field"><label for="no-price">Unit price (₹)</label>
        <input id="no-price" name="unit_price" type="number" min="0" step="0.01" required inputmode="decimal" value="${prefill.unit_price ?? ""}"></div>
    </div>
    <div class="field"><label for="no-notes">Notes <span class="muted">(optional)</span></label>
      <input id="no-notes" name="notes" maxlength="500" autocomplete="off"></div>
    ${prefill.biblio_id ? html`<input type="hidden" name="biblio_id" value="${prefill.biblio_id}">
      <p class="small muted" style="margin:0">${icon("info")} Copies will be added to existing record #${prefill.biblio_id} on receipt.</p>` : ""}
    <div class="alert info" id="no-total" aria-live="polite"></div>
  </div>`;
  const setup = (dlg) => {
    const update = () => {
      const qty = Number($("#no-qty", dlg).value || 0), price = Number($("#no-price", dlg).value || 0);
      const opt = $("#no-budget", dlg).selectedOptions[0];
      const remaining = Number(opt?.dataset.remaining || 0), total = qty * price;
      const over = total > remaining;
      const box = $("#no-total", dlg);
      box.className = `alert ${over ? "bad" : "info"}`;
      box.innerHTML = html`${icon(over ? "alert" : "wallet")}<div>Order total <strong>${money(total)}</strong> ·
        ${over ? html`<strong>exceeds</strong> the ${money(remaining)} remaining in this budget` : html`${money(remaining - total)} will remain in this budget`}</div>`;
    };
    dlg.addEventListener("input", update);
    dlg.addEventListener("change", update);
    update();
  };
  const order = await formModal({ title: prefill.title ? "Order more copies" : "New purchase order", body, submit: "Place order", wide: true },
    (fd) => api("/acquisitions/orders", {
      method: "POST",
      body: {
        vendor_id: Number(fd.get("vendor_id")),
        budget_id: Number(fd.get("budget_id")),
        title: str(fd, "title"),
        isbn: str(fd, "isbn") || null,
        biblio_id: fd.get("biblio_id") ? Number(fd.get("biblio_id")) : null,
        quantity: Number(fd.get("quantity")),
        unit_price: paise(fd.get("unit_price")),
        notes: str(fd, "notes") || null,
      },
    }), setup);
  if (!order) return;
  toast(`Order #${order.id} placed: ${order.quantity} × “${order.title}” (${money(order.total)})`, "success", 6000);
  if (state.status && state.status !== "ordered") { state.status = ""; $("#orders-status").value = ""; }
  refreshAfterChange();
}

async function newVendor() {
  const body = html`<div class="stack">
    <div class="field"><label for="nv-name">Vendor name</label><input id="nv-name" name="name" required maxlength="160" autocomplete="off"></div>
    <div class="grid cols-2">
      <div class="field"><label for="nv-email">Email</label><input id="nv-email" name="email" type="email" autocomplete="off"></div>
      <div class="field"><label for="nv-phone">Phone</label><input id="nv-phone" name="phone" type="tel" autocomplete="off"></div>
    </div>
    <div class="field"><label for="nv-discount">Discount (%)</label>
      <input id="nv-discount" name="discount_pct" type="number" min="0" max="100" step="0.1" value="0">
      <span class="hint">Your negotiated discount off list price.</span></div>
  </div>`;
  const v = await formModal({ title: "New vendor", body, submit: "Add vendor" }, (fd) => api("/acquisitions/vendors", {
    method: "POST",
    body: { name: str(fd, "name"), email: str(fd, "email") || null, phone: str(fd, "phone") || null, discount_pct: Number(fd.get("discount_pct") || 0) },
  }));
  if (!v) return;
  toast(`Vendor “${v.name}” added`, "success");
  state.vendors = (await api("/acquisitions/vendors").catch(() => ({ results: state.vendors }))).results;
}

async function newBudget() {
  const year = new Date().getFullYear();
  const body = html`<div class="stack">
    <div class="field"><label for="nb-name">Budget name</label><input id="nb-name" name="name" required maxlength="120" placeholder="e.g. Young adult fiction" autocomplete="off"></div>
    <div class="grid cols-2">
      <div class="field"><label for="nb-year">Fiscal year</label><input id="nb-year" name="fiscal_year" type="number" min="2000" max="2100" step="1" required value="${year}"></div>
      <div class="field"><label for="nb-alloc">Allocation (₹)</label><input id="nb-alloc" name="allocated" type="number" min="0" step="0.01" required inputmode="decimal"></div>
    </div>
    <div class="field"><label for="nb-branch">Branch</label>
      <select id="nb-branch" name="branch_id"><option value="">All branches</option>${state.lookups.branches.map((b) =>
        html`<option value="${b.id}">${b.name}</option>`)}</select></div>
  </div>`;
  const b = await formModal({ title: "New budget", body, submit: "Create budget" }, (fd) => api("/acquisitions/budgets", {
    method: "POST",
    body: {
      name: str(fd, "name"), fiscal_year: Number(fd.get("fiscal_year")), allocated: paise(fd.get("allocated")),
      branch_id: fd.get("branch_id") ? Number(fd.get("branch_id")) : null,
    },
  }));
  if (!b) return;
  toast("Budget created", "success");
  await loadBudgets().catch((e) => toast(e.message, "error"));
  renderStats();
}

async function receiveOrder(btn) {
  const o = state.orders.find((x) => String(x.id) === btn.dataset.receive);
  if (!o) return;
  const { branches, item_types: types } = state.lookups;
  const home = BOOT.user?.home_branch_id;
  const body = html`<div class="stack">
    <p style="margin:0">Receive <strong>${o.quantity} × ${o.title}</strong> from ${o.vendor}. One item record with a new barcode is created per copy${o.biblio_id ? "" : ", and a bibliographic record is created (or matched by ISBN)"}.</p>
    <div class="grid cols-2">
      <div class="field"><label for="ro-branch">Receiving branch</label>
        <select id="ro-branch" name="branch_id" required>${branches.map((b) => html`<option value="${b.id}" ${b.id === home ? "selected" : ""}>${b.name}</option>`)}</select></div>
      <div class="field"><label for="ro-type">Item type</label>
        <select id="ro-type" name="item_type_id" required>${types.map((t) => html`<option value="${t.id}" ${t.code === "BOOK" ? "selected" : ""}>${t.name}</option>`)}</select></div>
    </div>
  </div>`;
  const r = await formModal({ title: `Receive order #${o.id}`, body, submit: "Receive" }, (fd) => api(`/acquisitions/orders/${o.id}/receive`, {
    method: "POST", body: { branch_id: Number(fd.get("branch_id")), item_type_id: Number(fd.get("item_type_id")) },
  }));
  if (!r) return;
  toast(`Received ${r.barcodes.length} cop${r.barcodes.length === 1 ? "y" : "ies"} of “${r.order.title}”. Barcodes: ${r.barcodes.join(", ")}`, "success", 10000);
  refreshAfterChange();
}

async function cancelOrder(btn) {
  const o = state.orders.find((x) => String(x.id) === btn.dataset.cancel);
  if (!o) return;
  if (!(await confirmDialog(`Cancel order #${o.id}?`, `“${o.title}” (${money(o.total)}) will be cancelled and the amount released back to the ${o.budget} budget.`, "Cancel order"))) return;
  try {
    await withBusy(btn, () => api(`/acquisitions/orders/${o.id}/cancel`, { method: "POST" }));
    toast(`Order #${o.id} cancelled`, "success");
    refreshAfterChange();
  } catch { /* toasted */ }
}

async function orderFromSuggestion(btn) {
  const s = state.suggestions[Number(btn.dataset.suggestOrder)];
  if (!s) return;
  let isbn = "";
  try { isbn = (await withBusy(btn, () => api(`/biblios/${s.biblio_id}`))).isbn || ""; } catch { /* prefill without ISBN */ }
  newOrder({ title: s.title, isbn, quantity: s.suggested_copies, biblio_id: s.biblio_id });
}

// ------------------------------------------------------------------ init

export default async function init() {
  $("#new-order").addEventListener("click", () => newOrder());
  $("#new-vendor").addEventListener("click", newVendor);
  $("#new-budget").addEventListener("click", newBudget);
  $("#orders-status").addEventListener("change", (e) => {
    state.status = e.target.value;
    $("#acq-orders").innerHTML = skeleton(6);
    loadOrders().catch((err) => { $("#acq-orders").innerHTML = errorBox(err.message); toast(err.message, "error"); });
  });
  $("#acq-orders").addEventListener("click", (e) => {
    const r = e.target.closest("[data-receive]"), c = e.target.closest("[data-cancel]");
    if (r) receiveOrder(r);
    else if (c) cancelOrder(c);
  });
  $("#acq-suggest").addEventListener("click", (e) => { const b = e.target.closest("[data-suggest-order]"); if (b) orderFromSuggestion(b); });
  await loadAll();
}
