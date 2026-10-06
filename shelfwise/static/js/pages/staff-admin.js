// Staff: administration — lookup tables, circulation rules, settings, audit log and system jobs.
import {
  $, $$, BOOT, api, badge, confirmDialog, datetime, empty, esc, html, icon, modal, money, num, qs, raw, skeleton, toast, withBusy,
} from "/static/js/core.js";

const state = { tab: "branches", rows: {}, lookups: { branches: [], item_types: [], categories: [] }, audit: { page: 1, action: "", entity: "" } };
const panel = () => $("#admin-panel");

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

const errorBox = (msg) => html`<div class="alert bad" role="alert">${icon("alert")}<div>${msg}</div></div>`;
const deniedBox = () => html`<div class="alert warn" role="alert">${icon("shield")}<div><strong>Administrator access required.</strong>
  Your account can't change system configuration. Ask a library administrator if you need something changed.</div></div>`;
const rupees = (paise) => money(Number(paise || 0) / 100);
const attr = (name, v) => (v === undefined || v === null || v === false ? "" : v === true ? raw(` ${name}`) : raw(` ${name}="${esc(v)}"`));
const anyCell = (label) => (label === "Any" ? html`<span class="muted">Any</span>` : label);

// ------------------------------------------------------------------ entity definitions

const lookup = (k) => () => state.lookups[k] || [];
const ENTITIES = {
  branches: {
    path: "/admin/branches", title: "Branches", noun: "branch",
    sub: "Library locations. Items, patrons, budgets and pickups are tied to a branch.",
    label: (r) => r.name,
    columns: [
      ["Code", (r) => html`<span class="mono">${r.code}</span>`],
      ["Name", (r) => html`<strong>${r.name}</strong>`],
      ["Address", (r) => r.address || "—"],
      ["Email", (r) => (r.email ? html`<a href="mailto:${r.email}">${r.email}</a>` : "—")],
      ["Phone", (r) => r.phone || "—"],
    ],
    fields: [
      { name: "code", label: "Code", type: "code" },
      { name: "name", label: "Name", required: true, max: 120 },
      { name: "address", label: "Address", wide: true },
      { name: "email", label: "Email", type: "email" },
      { name: "phone", label: "Phone", type: "tel" },
    ],
  },
  "item-types": {
    path: "/admin/item-types", title: "Item types", noun: "item type",
    sub: "Physical formats. Holdability and the default replacement cost charged for lost items.",
    label: (r) => r.name,
    columns: [
      ["Code", (r) => html`<span class="mono">${r.code}</span>`],
      ["Name", (r) => html`<strong>${r.name}</strong>`],
      ["Holdable", (r) => (r.holdable ? badge("ok", "Yes") : badge("", "No"))],
      ["Replacement cost", (r) => rupees(r.replacement_cost), "num"],
    ],
    fields: [
      { name: "code", label: "Code", type: "code" },
      { name: "name", label: "Name", required: true, max: 80 },
      { name: "replacement_cost", label: "Replacement cost (₹)", type: "money", default: 50000, hint: "Charged when an item of this type is declared lost." },
      { name: "holdable", label: "Patrons may place holds on this type", type: "bool", default: true },
    ],
  },
  categories: {
    path: "/admin/categories", title: "Patron categories", noun: "patron category",
    sub: "Borrower types with their own loan and hold limits, membership period and fine block.",
    label: (r) => r.name,
    columns: [
      ["Code", (r) => html`<span class="mono">${r.code}</span>`],
      ["Name", (r) => html`<strong>${r.name}</strong>`],
      ["Max loans", (r) => num(r.max_loans), "num"],
      ["Max holds", (r) => num(r.max_holds), "num"],
      ["Membership", (r) => `${num(r.enrollment_months)} months`, "num"],
      ["Block at fines of", (r) => rupees(r.block_fine_threshold), "num"],
    ],
    fields: [
      { name: "code", label: "Code", type: "code" },
      { name: "name", label: "Name", required: true, max: 80 },
      { name: "max_loans", label: "Maximum loans", type: "int", min: 0, max: 500, default: 10 },
      { name: "max_holds", label: "Maximum holds", type: "int", min: 0, max: 500, default: 5 },
      { name: "enrollment_months", label: "Membership period (months)", type: "int", min: 1, max: 1200, default: 12 },
      { name: "block_fine_threshold", label: "Block borrowing at fines of (₹)", type: "money", default: 50000 },
    ],
  },
  rules: {
    path: "/admin/rules", title: "Circulation rules", noun: "circulation rule",
    sub: "The most specific matching rule wins: item type beats patron category, which beats branch. “Any” matches everything.",
    label: (r) => `${r.branch} / ${r.category} / ${r.item_type}`,
    columns: [
      ["#", (r) => html`<span class="tiny muted mono">${r.id}</span>`],
      ["Branch", (r) => anyCell(r.branch)],
      ["Category", (r) => anyCell(r.category)],
      ["Item type", (r) => anyCell(r.item_type)],
      ["Loan days", (r) => num(r.loan_days), "num"],
      ["Renewals", (r) => num(r.max_renewals), "num"],
      ["Fine / day", (r) => rupees(r.fine_per_day), "num"],
      ["Fine cap", (r) => rupees(r.fine_cap), "num"],
      ["Grace days", (r) => num(r.grace_days), "num"],
      ["Pickup days", (r) => num(r.hold_pickup_days), "num"],
    ],
    fields: [
      { name: "branch_id", label: "Branch", type: "select", options: lookup("branches") },
      { name: "category_id", label: "Patron category", type: "select", options: lookup("categories") },
      { name: "item_type_id", label: "Item type", type: "select", options: lookup("item_types") },
      { name: "loan_days", label: "Loan period (days)", type: "int", min: 0, max: 3650, default: 14 },
      { name: "max_renewals", label: "Maximum renewals", type: "int", min: 0, max: 100, default: 2 },
      { name: "grace_days", label: "Grace period (days)", type: "int", min: 0, max: 365, default: 0 },
      { name: "fine_per_day", label: "Fine per day (₹)", type: "money", default: 200 },
      { name: "fine_cap", label: "Fine cap per loan (₹)", type: "money", default: 10000 },
      { name: "hold_pickup_days", label: "Hold pickup window (days)", type: "int", min: 1, max: 365, default: 7 },
    ],
  },
};

// ------------------------------------------------------------------ generic form fields

function fieldHtml(f, value) {
  const id = `f-${f.name}`;
  const v = value === undefined ? f.default : value;
  const hint = f.hint ? html`<span class="hint">${f.hint}</span>` : "";
  if (f.type === "bool") {
    return html`<div class="field" style="grid-column:1/-1"><label class="checkbox"><input type="checkbox" name="${f.name}"${attr("checked", !!v)}> ${f.label}</label>${hint}</div>`;
  }
  if (f.type === "select") {
    return html`<div class="field"><label for="${id}">${f.label}</label><select id="${id}" name="${f.name}">
      <option value="">Any</option>${f.options().map((o) => html`<option value="${o.id}"${attr("selected", o.id === v)}>${o.name}</option>`)}</select>${hint}</div>`;
  }
  const common = {
    code: html` type="text" class="mono" required maxlength="16" pattern="[A-Z0-9_]+" autocapitalize="characters" spellcheck="false" title="Uppercase letters, digits and underscores"`,
    int: html` type="number" step="1" required${attr("min", f.min)}${attr("max", f.max)}`,
    money: html` type="number" step="0.01" min="0" required inputmode="decimal"`,
    email: html` type="email"`,
    tel: html` type="tel"`,
  }[f.type] || html` type="text"${attr("required", !!f.required)}${attr("maxlength", f.max)}`;
  const shown = f.type === "money" ? (v === undefined || v === null ? "" : Number(v) / 100) : (v ?? "");
  const codeHint = f.type === "code" ? html`<span class="hint">A–Z, 0–9 and _ only (max 16).</span>` : "";
  return html`<div class="field"${f.wide ? raw(' style="grid-column:1/-1"') : ""}><label for="${id}">${f.label}</label>
    <input id="${id}" name="${f.name}"${common} autocomplete="off" value="${shown}">${hint}${codeHint}</div>`;
}

function parseFields(fields, fd) {
  const out = {};
  for (const f of fields) {
    const v = fd.get(f.name);
    const s = String(v ?? "").trim();
    if (f.type === "bool") out[f.name] = fd.has(f.name);
    else if (f.type === "int") out[f.name] = Number(s);
    else if (f.type === "money") out[f.name] = Math.round(Number(s) * 100);
    else if (f.type === "select") out[f.name] = s ? Number(s) : null;
    else if (f.type === "code") out[f.name] = s.toUpperCase();
    else out[f.name] = s || (f.required ? s : null);
  }
  return out;
}

/** Uppercase code fields as the user types (validation still enforces the pattern). */
function codeUppercaser(dlg) {
  dlg.addEventListener("input", (e) => {
    const el = e.target;
    if (el.matches?.('input[pattern="[A-Z0-9_]+"]')) {
      const pos = el.selectionStart;
      el.value = el.value.toUpperCase().replace(/[\s-]/g, "_");
      el.setSelectionRange(pos, pos);
    }
  });
}

// ------------------------------------------------------------------ entity tabs (branches, item types, categories, rules)

function entityTable(key, rows) {
  const cfg = ENTITIES[key];
  if (!rows.length) return empty(`No ${cfg.title.toLowerCase()} yet.`, "inbox");
  return html`<div class="table-wrap"><table class="table">
    <caption class="sr-only">${cfg.title}</caption>
    <thead><tr>${cfg.columns.map(([label, , cls]) => html`<th scope="col" class="${cls || ""}">${label}</th>`)}<th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map((r) => html`<tr>${cfg.columns.map(([, cell, cls]) => html`<td class="${cls || ""}">${cell(r)}</td>`)}
      <td class="right nowrap">
        <button class="btn sm ghost" data-edit="${key}" data-id="${r.id}" aria-label="Edit ${cfg.label(r)}">${icon("edit")}Edit</button>
        <button class="btn sm ghost danger" data-delete="${key}" data-id="${r.id}" aria-label="Delete ${cfg.label(r)}">${icon("trash")}</button>
      </td></tr>`)}</tbody></table></div>`;
}

async function entityTab(key) {
  const cfg = ENTITIES[key];
  const { results } = await api(cfg.path);
  state.rows[key] = results;
  return html`<div class="card flush">
    <div class="card-head" style="padding-bottom:var(--pad);flex-wrap:wrap">
      <div><h2>${cfg.title}</h2><div class="small muted">${cfg.sub}</div></div>
      <button class="btn primary" data-add="${key}">${icon("plus")}Add ${cfg.noun}</button>
    </div>${entityTable(key, results)}</div>`;
}

async function editEntity(key, id) {
  const cfg = ENTITIES[key];
  const row = id ? state.rows[key]?.find((r) => String(r.id) === String(id)) : null;
  if (id && !row) return;
  const body = html`<div class="grid cols-2">${cfg.fields.map((f) => fieldHtml(f, row ? row[f.name] : undefined))}</div>`;
  const saved = await formModal({ title: row ? `Edit ${cfg.noun}` : `Add ${cfg.noun}`, body, submit: row ? "Save changes" : `Add ${cfg.noun}`, wide: key === "rules" },
    (fd) => api(row ? `${cfg.path}/${row.id}` : cfg.path, { method: row ? "PUT" : "POST", body: parseFields(cfg.fields, fd) }),
    codeUppercaser);
  if (!saved) return;
  toast(row ? "Changes saved" : `${cfg.noun[0].toUpperCase()}${cfg.noun.slice(1)} added`, "success");
  if (key !== "rules") refreshLookups();
  show(state.tab);
}

async function deleteEntity(key, id, btn) {
  const cfg = ENTITIES[key];
  const row = state.rows[key]?.find((r) => String(r.id) === String(id));
  if (!row) return;
  const ok = await confirmDialog(`Delete ${cfg.noun}?`, `“${cfg.label(row)}” will be permanently removed. Records that are still in use can't be deleted.`, "Delete");
  if (!ok) return;
  try {
    await withBusy(btn, () => api(`${cfg.path}/${row.id}`, { method: "DELETE" }));
    toast(`Deleted “${cfg.label(row)}”`, "success");
    if (key !== "rules") refreshLookups();
    show(state.tab);
  } catch { /* toasted */ }
}

// ------------------------------------------------------------------ rules: explain tool

function explainCard() {
  const sel = (name, label, list) => html`<div class="field"><label for="ex-${name}">${label}</label>
    <select id="ex-${name}" name="${name}" required>${list.map((o) => html`<option value="${o.id}">${o.name}</option>`)}</select></div>`;
  const { branches, categories, item_types: types } = state.lookups;
  return html`<section class="card" style="margin-top:var(--gap)" aria-labelledby="explain-h">
    <div class="card-head"><div><h2 id="explain-h">Explain rule</h2>
      <div class="small muted">Pick a combination to see exactly which rule applies — and the values a loan would get.</div></div></div>
    <div class="card-body stack">
      <form id="explain-form" class="grid cols-4" style="align-items:end">
        ${sel("branch_id", "Branch", branches)}${sel("category_id", "Patron category", categories)}${sel("item_type_id", "Item type", types)}
        <div class="field"><button class="btn primary" type="submit">${icon("info")}Explain</button></div>
      </form>
      <div id="explain-result" aria-live="polite"></div>
    </div></section>`;
}

function renderExplain(r) {
  const e = r.effective;
  const kv = (k, v) => html`<div class="kv"><span class="muted">${k}</span><strong>${v}</strong></div>`;
  return html`<div class="grid cols-2">
    <div>${kv("Loan period", `${num(e.loan_days)} days`)}${kv("Maximum renewals", num(e.max_renewals))}${kv("Grace period", `${num(e.grace_days)} days`)}</div>
    <div>${kv("Fine per day", money(r.fine_per_day))}${kv("Fine cap per loan", money(r.fine_cap))}${kv("Hold pickup window", `${num(e.hold_pickup_days)} days`)}</div>
  </div>
  <div class="alert ${e.source_rule_id ? "ok" : "warn"}" style="margin-top:.75rem">${icon(e.source_rule_id ? "check" : "info")}<div>${r.explanation}${e.source_rule_id ? (() => {
    const rule = state.rows.rules?.find((x) => x.id === e.source_rule_id);
    return rule ? html` — <strong>${rule.branch} / ${rule.category} / ${rule.item_type}</strong>` : "";
  })() : ""}</div></div>`;
}

async function explain(form) {
  const fd = new FormData(form);
  const out = $("#explain-result");
  try {
    const r = await withBusy($('button[type="submit"]', form), () => api(`/admin/rules/explain?${qs(Object.fromEntries(fd))}`));
    out.innerHTML = renderExplain(r);
  } catch (e) { out.innerHTML = errorBox(e.message); }
}

// ------------------------------------------------------------------ settings

const settingType = (d) => (typeof d === "boolean" ? "bool" : Number.isInteger(d) ? "int" : typeof d === "number" ? "float" : "str");
const fmtDefault = (d) => (typeof d === "boolean" ? (d ? "On" : "Off") : d === "" ? "(empty)" : String(d));
const modifiedBadge = (r) => (JSON.stringify(r.value) !== JSON.stringify(r.default) ? badge("info", "Modified") : "");

function settingInput(r, id) {
  const t = settingType(r.default);
  if (t === "bool") return html`<input type="checkbox" id="${id}" aria-describedby="${id}-d" style="width:1.15rem;height:1.15rem;accent-color:var(--primary)"${attr("checked", !!r.value)}>`;
  if (t === "int" || t === "float") return html`<input type="number" id="${id}" step="${t === "int" ? 1 : "any"}" value="${r.value}" style="max-width:10rem">`;
  return html`<input type="text" id="${id}" value="${r.value ?? ""}" maxlength="500">`;
}

async function settingsTab() {
  const { results } = await api("/admin/settings");
  state.rows.settings = results;
  return html`<div class="card flush">
    <div class="card-head" style="padding-bottom:var(--pad)"><div><h2>Settings</h2>
      <div class="small muted">System preferences. Each row is saved individually and recorded in the audit log.</div></div></div>
    <div class="table-wrap"><table class="table">
      <caption class="sr-only">System settings</caption>
      <thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Default</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${results.map((r) => {
        const id = `set-${r.key}`;
        return html`<tr data-setting="${r.key}">
          <td style="min-width:16rem"><label for="${id}" style="margin:0"><code>${r.key}</code></label><div class="small muted" id="${id}-d">${r.description}</div></td>
          <td style="min-width:12rem">${settingInput(r, id)}</td>
          <td class="small muted">${fmtDefault(r.default)}</td>
          <td class="right nowrap"><span id="${id}-m">${modifiedBadge(r)}</span>
            <button class="btn sm" data-save-setting="${r.key}">${icon("check")}Save</button></td></tr>`;
      })}</tbody></table></div></div>`;
}

async function saveSetting(btn) {
  const key = btn.dataset.saveSetting;
  const r = state.rows.settings?.find((x) => x.key === key);
  const input = $(`#set-${CSS.escape(key)}`);
  if (!r || !input) return;
  const t = settingType(r.default);
  let value;
  if (t === "bool") value = input.checked;
  else if (t === "int" || t === "float") {
    if (input.value.trim() === "" || !input.checkValidity()) { input.reportValidity(); toast("Enter a valid number", "error"); return; }
    value = t === "int" ? parseInt(input.value, 10) : Number(input.value);
  } else value = input.value;
  try {
    const res = await withBusy(btn, () => api(`/admin/settings/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }));
    r.value = res.value;
    $(`#set-${CSS.escape(key)}-m`).innerHTML = modifiedBadge(r);
    toast(`Saved ${key}`, "success");
  } catch { /* toasted */ }
}

// ------------------------------------------------------------------ audit log

const ACTION_BADGE = { create: "ok", update: "info", setting: "info", delete: "bad", cancel: "bad", login: "", import: "ai", marc_import: "ai", nightly_job: "ai" };

function auditDetails(d) {
  if (!d || (typeof d === "object" && !Object.keys(d).length)) return html`<span class="muted">—</span>`;
  const s = JSON.stringify(d);
  return html`<span class="tiny mono muted" title="${s}">${s.length > 90 ? `${s.slice(0, 90)}…` : s}</span>`;
}

async function auditTab() {
  const a = state.audit;
  const r = await api(`/admin/audit?${qs({ page: a.page, action: a.action, entity: a.entity })}`);
  const pages = Math.max(1, Math.ceil(r.total / 50));
  return html`<div class="card flush">
    <div class="card-head" style="padding-bottom:var(--pad);flex-wrap:wrap">
      <div><h2>Audit log</h2><div class="small muted">${num(r.total)} event${r.total === 1 ? "" : "s"}${a.action || a.entity ? " matching filters" : ""}. Every change and sign-in is recorded.</div></div>
      <form id="audit-filter" class="row tight" style="align-items:end">
        <div class="field"><label for="au-action">Action</label><input id="au-action" name="action" value="${a.action}" placeholder="e.g. update" style="width:9rem" autocomplete="off"></div>
        <div class="field"><label for="au-entity">Entity</label><input id="au-entity" name="entity" value="${a.entity}" placeholder="e.g. patron" style="width:9rem" autocomplete="off"></div>
        <button class="btn" type="submit">${icon("filter")}Filter</button>
        ${a.action || a.entity ? html`<button class="btn ghost" type="button" data-audit-clear>Clear</button>` : ""}
      </form>
    </div>
    ${r.results.length ? html`<div class="table-wrap"><table class="table">
      <caption class="sr-only">Audit events, newest first</caption>
      <thead><tr><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Entity</th><th scope="col">IP</th><th scope="col">Details</th></tr></thead>
      <tbody>${r.results.map((e) => html`<tr>
        <td class="nowrap">${datetime(e.at)}</td>
        <td>${e.actor || html`<span class="muted">System</span>`}</td>
        <td>${badge(ACTION_BADGE[e.action] ?? "", e.action.replace(/_/g, " "))}</td>
        <td class="nowrap">${e.entity}${e.entity_id ? html`<span class="muted">#${e.entity_id}</span>` : ""}</td>
        <td class="mono tiny">${e.ip || "—"}</td>
        <td style="max-width:28rem">${auditDetails(e.details)}</td></tr>`)}</tbody></table></div>
      <nav class="pager" aria-label="Audit log pages">
        <button class="btn sm" data-audit-page="${a.page - 1}"${attr("disabled", a.page <= 1)}>${raw("&larr;")} Newer</button>
        <span class="small muted">Page ${num(a.page)} of ${num(pages)}</span>
        <button class="btn sm" data-audit-page="${a.page + 1}"${attr("disabled", a.page >= pages)}>Older ${raw("&rarr;")}</button>
      </nav>` : empty("No audit events match these filters.", "list")}</div>`;
}

// ------------------------------------------------------------------ system

function systemTab() {
  const { branches, item_types: types } = state.lookups;
  const home = BOOT.user?.home_branch_id;
  return html`<div class="grid cols-2">
    <section class="card" aria-labelledby="jobs-h">
      <div class="card-head"><h2 id="jobs-h">Maintenance jobs</h2></div>
      <div class="card-body stack">
        <p class="small muted" style="margin:0">The nightly job sends courtesy and overdue notices, expires uncollected holds, auto-renews (if enabled) and anonymises old loan history. It normally runs on a schedule.</p>
        <div class="row tight">
          <button class="btn primary" data-job="nightly">${icon("clock")}Run nightly jobs</button>
          <button class="btn" data-job="reindex">${icon("refresh")}Rebuild search index</button>
        </div>
        <div id="job-result" aria-live="polite"></div>
      </div>
    </section>
    <section class="card" aria-labelledby="export-h">
      <div class="card-head"><h2 id="export-h">Export catalogue</h2></div>
      <div class="card-body stack">
        <p class="small muted" style="margin:0">Download every bibliographic record with holdings, for backup or migration to another ILS (Koha, Evergreen, FOLIO…).</p>
        <div class="row tight">
          <a class="btn" href="/api/v1/cataloging/export?fmt=xml" download>${icon("download")}MARCXML</a>
          <a class="btn" href="/api/v1/cataloging/export?fmt=mrc" download>${icon("download")}MARC21 (binary)</a>
        </div>
      </div>
    </section>
    <section class="card" aria-labelledby="marc-h">
      <div class="card-head"><h2 id="marc-h">Import MARC records</h2></div>
      <form class="card-body stack" id="marc-form">
        <div class="field"><label for="marc-file">MARC file (.mrc or MARCXML, up to 50 MB)</label>
          <input id="marc-file" name="file" type="file" accept=".mrc,.marc,.xml,application/marc,application/xml" required></div>
        <div class="grid cols-2">
          <div class="field"><label for="marc-branch">Default branch for items</label>
            <select id="marc-branch" name="branch_id" required>${branches.map((b) => html`<option value="${b.id}"${attr("selected", b.id === home)}>${b.name}</option>`)}</select></div>
          <div class="field"><label for="marc-type">Default item type</label>
            <select id="marc-type" name="item_type_id" required>${types.map((t) => html`<option value="${t.id}"${attr("selected", t.code === "BOOK")}>${t.name}</option>`)}</select></div>
        </div>
        <p class="tiny muted" style="margin:0">Records already in the catalogue (matched by ISBN) are skipped. Holdings in 952 fields become items.</p>
        <div><button class="btn primary" type="submit">${icon("upload")}Import records</button></div>
        <div id="marc-result" aria-live="polite"></div>
      </form>
    </section>
    <section class="card" aria-labelledby="pimp-h">
      <div class="card-head"><h2 id="pimp-h">Import patrons</h2></div>
      <form class="card-body stack" id="patrons-form">
        <div class="field"><label for="patrons-file">CSV file</label>
          <input id="patrons-file" name="file" type="file" accept=".csv,text/csv" required></div>
        <p class="tiny muted" style="margin:0">Accepts Koha borrower export columns: <code>cardnumber, surname, firstname, email, phone, address, categorycode, branchcode, dateexpiry</code>. Existing card numbers are skipped; unknown category/branch codes fall back to the first one defined.</p>
        <div><button class="btn primary" type="submit">${icon("user-plus")}Import patrons</button></div>
        <div id="patrons-result" aria-live="polite"></div>
      </form>
    </section>
  </div>`;
}

const statsList = (pairs) => html`<div>${pairs.map(([k, v]) => html`<div class="kv"><span class="muted">${k}</span><strong>${v}</strong></div>`)}</div>`;
const errorsList = (errs) => (errs?.length ? html`<details class="small" style="margin-top:.5rem"><summary>${num(errs.length)} problem${errs.length === 1 ? "" : "s"}</summary>
  <ul class="tiny" style="margin:.4rem 0 0;padding-left:1.2rem">${errs.slice(0, 50).map((e) => html`<li>${e}</li>`)}</ul></details>` : "");

async function runJob(btn) {
  const out = $("#job-result");
  try {
    if (btn.dataset.job === "nightly") {
      const s = await withBusy(btn, () => api("/admin/jobs/nightly", { method: "POST" }));
      out.innerHTML = html`<div class="alert ok">${icon("check")}<div class="grow"><strong>Nightly jobs finished</strong>${statsList([
        ["Courtesy notices", num(s.courtesy)], ["Overdue notices", num(s.overdue)], ["Holds expired", num(s.holds_expired)],
        ["Loans auto-renewed", num(s.auto_renewed)], ["Loan histories anonymised", num(s.anonymized)]])}</div></div>`;
    } else {
      const s = await withBusy(btn, () => api("/admin/jobs/reindex", { method: "POST" }));
      out.innerHTML = html`<div class="alert ok">${icon("check")}<div>Search index rebuilt — <strong>${num(s.indexed)}</strong> records indexed.</div></div>`;
    }
  } catch { /* toasted */ }
}

async function upload(form) {
  const btn = $('button[type="submit"]', form);
  const file = $('input[type="file"]', form).files[0];
  if (!file) { form.reportValidity(); return; }
  const fd = new FormData();
  fd.append("file", file);
  try {
    if (form.id === "marc-form") {
      const q = qs({ branch_id: $("#marc-branch", form).value, item_type_id: $("#marc-type", form).value });
      const s = await withBusy(btn, () => api(`/cataloging/import?${q}`, { method: "POST", form: fd }));
      $("#marc-result").innerHTML = html`<div class="alert ${s.errors?.length ? "warn" : "ok"}">${icon(s.errors?.length ? "alert" : "check")}<div class="grow">
        <strong>Imported ${file.name}</strong>${statsList([["Records read", num(s.records)], ["Titles created", num(s.created)],
          ["Duplicates skipped", num(s.skipped_duplicates)], ["Items created", num(s.items)]])}${errorsList(s.errors)}</div></div>`;
      toast(`${num(s.created)} titles imported`, "success");
    } else {
      const s = await withBusy(btn, () => api("/admin/import/patrons", { method: "POST", form: fd }));
      $("#patrons-result").innerHTML = html`<div class="alert ${s.errors?.length ? "warn" : "ok"}">${icon(s.errors?.length ? "alert" : "check")}<div class="grow">
        <strong>Imported ${file.name}</strong>${statsList([["Patrons created", num(s.created)], ["Rows skipped", num(s.skipped)]])}${errorsList(s.errors)}</div></div>`;
      toast(`${num(s.created)} patrons imported`, "success");
    }
    $('input[type="file"]', form).value = "";
  } catch { /* toasted */ }
}

// ------------------------------------------------------------------ tab routing

const TABS = {
  branches: () => entityTab("branches"),
  "item-types": () => entityTab("item-types"),
  categories: () => entityTab("categories"),
  rules: async () => html`${await entityTab("rules")}${explainCard()}`,
  settings: settingsTab,
  audit: auditTab,
  system: async () => systemTab(),
};

let seq = 0;
async function show(tab) {
  state.tab = tab;
  history.replaceState(null, "", `#${tab}`);
  const mine = ++seq;
  panel().innerHTML = `<div class="card pad">${skeleton(6)}</div>`;
  try {
    const out = await TABS[tab]();
    if (mine === seq) panel().innerHTML = out;
  } catch (e) {
    if (mine !== seq) return;
    panel().innerHTML = e.status === 403 ? deniedBox() : errorBox(e.message);
    if (e.status !== 403) toast(e.message, "error");
  }
}

async function refreshLookups() {
  try {
    const r = await api("/lookups");
    state.lookups = { branches: r.branches || [], item_types: r.item_types || [], categories: r.categories || [] };
  } catch (e) { toast(e.message, "error"); }
}

function wirePanel() {
  const p = panel();
  p.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.add) editEntity(t.dataset.add);
    else if (t.dataset.edit) editEntity(t.dataset.edit, t.dataset.id);
    else if (t.dataset.delete) deleteEntity(t.dataset.delete, t.dataset.id, t);
    else if (t.dataset.saveSetting) saveSetting(t);
    else if (t.dataset.job) runJob(t);
    else if (t.dataset.auditPage) { state.audit.page = Math.max(1, Number(t.dataset.auditPage)); show("audit"); }
    else if ("auditClear" in t.dataset) { state.audit = { page: 1, action: "", entity: "" }; show("audit"); }
  });
  p.addEventListener("submit", (e) => {
    const f = e.target;
    e.preventDefault();
    if (f.id === "explain-form") explain(f);
    else if (f.id === "audit-filter") {
      state.audit = { page: 1, action: $("#au-action", f).value.trim(), entity: $("#au-entity", f).value.trim() };
      show("audit");
    } else if (f.id === "marc-form" || f.id === "patrons-form") upload(f);
  });
  // Enter in a setting's input saves that row.
  p.addEventListener("keydown", (e) => {
    const row = e.target.closest?.("[data-setting]");
    if (row && e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); $("[data-save-setting]", row).click(); }
  });
}

// ------------------------------------------------------------------ init

export default async function init() {
  if (BOOT.user?.role !== "admin") {
    $("#admin-denied").innerHTML = deniedBox();
    $("#admin-tabs").classList.add("hidden");
    panel().classList.add("hidden");
    return;
  }
  wirePanel();
  const selectTab = setupTabs($("#admin-tabs"), show);
  panel().innerHTML = `<div class="card pad">${skeleton(6)}</div>`;
  await refreshLookups();
  if (!selectTab(location.hash.slice(1))) selectTab("branches");
}
