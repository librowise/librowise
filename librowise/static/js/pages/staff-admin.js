// Staff › Administration › Settings — a settings layout (section navigation + one section at a time):
// library profile, branches, item types, patron categories, circulation rules (matrix editor + explain),
// policies, notice delivery, integrations, audit log and data & maintenance.
// Sections live in the URL hash; legacy hashes (#settings → #profile, #system → #maintenance) keep working.
import { $, $$, BOOT, api, datetime, html, icon, num, qs, relative, toast, withBusy } from "/static/js/core.js";
import { locale, t } from "/static/js/i18n.js";
import { avatar } from "/static/js/ui/avatar.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { confirmDestructive, confirmDialog } from "/static/js/ui/dialog.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { activeFilters, searchField, selectChip, wireFilterBar } from "/static/js/ui/filters.js";
import { enhanceForm, field, saveBar } from "/static/js/ui/form.js";
import { sidePanel } from "/static/js/ui/panel.js";
import { segmented, wireSegmented } from "/static/js/ui/tabs.js";
import { copyButton, dl, jobDescription, jobLabel, pill, rowMenu, wireKit } from "/static/js/pages/lib/admin-kit.js";
import { anyDirty, editDialog, guardUnsaved, humanize, numField, paise, rupees, switchField, toggleSwitch, wireValidation } from "/static/js/pages/lib/settings-ui.js";

const SECTIONS = ["profile", "branches", "item-types", "categories", "rules", "policies", "notices", "integrations", "audit", "maintenance"];
const LEGACY = { settings: "profile", system: "maintenance" };
const SETTING_SECTIONS = ["profile", "policies", "notices", "integrations"];
const GROUPS = {
  profile: ["identity", "opac"],
  policies: ["circulation", "opac", "privacy", "security", "cataloguing", "other"],
  notices: ["delivery", "other"],
  integrations: ["ai", "other"],
};

const state = { lookups: { branches: [], item_types: [], categories: [] }, settings: null, env: {}, rows: {}, cleanup: [], rulesView: "matrix", matrixBranch: "" };
const panel = () => $("#as-panel");
const CURRENCY = (() => {
  try { return new Intl.NumberFormat(locale, { style: "currency", currency: BOOT.currency || "INR" }).formatToParts(0).find((p) => p.type === "currency")?.value || "₹"; } catch { return "₹"; }
})();
const unitText = (unit, n) => t(`admin.common.unit.${unit}`, { count: Number(n) });
const unitWord = (unit) => t(`admin.common.unit_word.${unit}`);
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

// ------------------------------------------------------------------ layout helpers

function sectionHead(key, { actions = "", sub } = {}) {
  const k = key.replace(/-/g, "_");
  return html`<header class="as-section-head"><div class="as-section-titles">
      <h2 id="as-section-title" tabindex="-1">${t(`admin.settings.nav.${k}`)}</h2>
      <p>${sub ?? t(`admin.settings.sub.${k}`)}</p></div>
    ${actions ? html`<div class="as-section-actions">${actions}</div>` : ""}</header>`;
}

const sectionError = (key, err, retry = true) => html`${sectionHead(key)}<div class="card">${err?.status === 403
  ? emptyState({ art: "error", title: t("admin.settings.denied.title"), body: t("admin.settings.denied.section") })
  : errorState(err, { retry })}</div>`;

// ------------------------------------------------------------------ routing

function currentSection() {
  const h = decodeURIComponent(location.hash.slice(1));
  return LEGACY[h] || (SECTIONS.includes(h) ? h : "profile");
}

let routeSeq = 0;
async function route({ focus = false } = {}) {
  const key = currentSection();
  const h = location.hash.slice(1);
  if (key !== "audit" && location.search) history.replaceState(null, "", `${location.pathname}#${key}`);
  else if (h !== key) history.replaceState(null, "", `${location.pathname}${location.search}#${key}`);
  $$("#as-nav a[data-section]").forEach((a) => (a.dataset.section === key ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  $("#as-jump").value = key;
  state.cleanup.splice(0).forEach((f) => f());
  const mine = ++routeSeq;
  // A fresh panel element per section drops the previous section's listeners (content stays until replaced).
  const old = panel();
  const p = old.cloneNode(true);
  old.replaceWith(p);
  p.dataset.section = key;
  p.setAttribute("aria-busy", "true");
  try {
    await RENDER[key](p, () => mine === routeSeq);
  } catch (err) {
    if (mine === routeSeq) p.innerHTML = sectionError(key, err);
  } finally {
    if (mine === routeSeq) p.removeAttribute("aria-busy");
  }
  if (focus && mine === routeSeq) $("#as-section-title", p)?.focus({ preventScroll: false });
}

function navigate(key) {
  if (anyDirty() && key !== currentSection() && !window.confirm(t("ui.form.leave_confirm"))) { $("#as-jump").value = currentSection(); return false; }
  if (location.hash.slice(1) === key) route({ focus: true }); else location.hash = key;
  return true;
}

// ------------------------------------------------------------------ data

async function loadLookups() {
  const r = await api("/lookups");
  state.lookups = { branches: r.branches || [], item_types: r.item_types || [], categories: r.categories || [] };
}

async function loadSettings(force = false) {
  if (state.settings && !force) return state.settings;
  const r = await api("/admin/settings");
  state.settings = r.results;
  state.env = r.environment || {};
  return state.settings;
}

// ================================================================== settings sections

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const settingLabel = (r) => t(`admin.settings.field.${r.key}.label`, {}, r.label || humanize(r.key));
const settingHelp = (r) => t(`admin.settings.field.${r.key}.help`, {}, r.description || "");

function formatSetting(r, v) {
  if (r.type === "bool") return v ? t("admin.common.on") : t("admin.common.off");
  if (r.unit && v !== "" && v !== null && v !== undefined) return unitText(r.unit, v);
  if (r.type === "select" && r.options === "categories") {
    const c = state.lookups.categories.find((x) => x.code === v);
    return c ? c.name : String(v);
  }
  return v === "" || v === null || v === undefined ? t("admin.common.empty_value") : String(v);
}

function settingControl(r, id, describedBy) {
  const v = r.value;
  if (r.type === "bool") return toggleSwitch({ id, name: r.key, checked: !!v, describedBy });
  if (r.type === "int" || r.type === "float") {
    return html`<div class="as-input-unit"><input type="number" id="${id}" name="${r.key}" value="${v}" required inputmode="numeric"
      step="${r.type === "int" ? 1 : "any"}" ${r.min !== null && r.min !== undefined ? html`min="${r.min}"` : ""} ${r.max !== null && r.max !== undefined ? html`max="${r.max}"` : ""}
      aria-describedby="${describedBy}">${r.unit ? html`<span class="as-unit" aria-hidden="true">${unitWord(r.unit)}</span>` : ""}</div>`;
  }
  if (r.type === "select" && r.options === "categories") {
    const opts = state.lookups.categories.map((c) => [c.code, `${c.name} (${c.code})`]);
    if (v && !opts.some(([c]) => c === v)) opts.unshift([v, t("admin.settings.unknown_code", { code: v })]);
    return html`<select id="${id}" name="${r.key}" aria-describedby="${describedBy}">${opts.map(([c, l]) => html`<option value="${c}" ${c === v ? "selected" : ""}>${l}</option>`)}</select>`;
  }
  if (r.type === "text") {
    return html`<textarea id="${id}" name="${r.key}" rows="3" maxlength="${r.max_length || 500}" aria-describedby="${describedBy}" placeholder="${t("admin.settings.announcement_placeholder")}">${v ?? ""}</textarea>`;
  }
  return html`<input type="text" id="${id}" name="${r.key}" value="${v ?? ""}" ${r.required ? "required" : ""} maxlength="${r.max_length || 500}" autocomplete="off" aria-describedby="${describedBy}">`;
}

function settingRow(r) {
  const id = `set-${r.key}`;
  const describedBy = `${id}-help ${id}-err ${id}-mod`;
  const wide = r.type === "text" || r.type === "str" || r.type === "select";
  return html`<div class="as-row ${r.type === "bool" ? "is-switch" : ""} ${wide ? "is-wide" : ""}" data-setting="${r.key}">
    <div class="as-row-text">
      <label class="as-row-label" for="${id}">${settingLabel(r)}${r.required ? html`<span class="req" aria-hidden="true">*</span>` : ""}</label>
      <p class="as-row-help" id="${id}-help">${settingHelp(r)}</p>
      <div class="as-row-meta" id="${id}-mod">
        <span class="as-modified" data-modified hidden>${pill("info", t("admin.settings.modified"))}<span class="muted">${t("admin.settings.default_is", { value: formatSetting(r, r.default) })}</span>
          <button type="button" class="link-btn" data-reset="${r.key}" aria-label="${t("admin.settings.reset_named", { name: settingLabel(r), value: formatSetting(r, r.default) })}">${t("admin.settings.reset")}</button></span>
        <code class="as-key" title="${t("admin.settings.key_hint")}">${r.key}</code>
      </div>
    </div>
    <div class="as-row-control">${settingControl(r, id, describedBy)}<div class="field-error" id="${id}-err" hidden></div></div>
  </div>`;
}

function readSetting(form, r) {
  const el = form.elements[r.key];
  if (!el) return r.value;
  if (r.type === "bool") return el.checked;
  if (r.type === "int") return el.value === "" ? null : parseInt(el.value, 10);
  if (r.type === "float") return el.value === "" ? null : Number(el.value);
  return el.value;
}

function syncModified(form, rows) {
  for (const r of rows) {
    const box = $(`[data-setting="${CSS.escape(r.key)}"] [data-modified]`, form);
    if (box) box.hidden = sameValue(readSetting(form, r), r.default);
  }
}

function commitDefaults(form) {
  for (const el of $$("input,textarea,select", form)) {
    if (el.type === "checkbox") el.defaultChecked = el.checked;
    else if (el.tagName === "SELECT") $$("option", el).forEach((o) => { o.defaultSelected = o.selected; });
    else el.defaultValue = el.value;
  }
}

function setDefaultValue(el, r) {
  if (r.type === "bool") el.checked = !!r.default;
  else el.value = r.default ?? "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.focus();
}

function channelCard() {
  const e = state.env;
  const email = e.email_backend === "smtp"
    ? pill("success", t("admin.settings.channels.smtp", { host: e.smtp_host || "" }))
    : pill("warning", t("admin.settings.channels.console"));
  const sms = e.sms_backend === "webhook"
    ? (e.sms_webhook_configured ? pill("success", t("admin.settings.channels.webhook")) : pill("danger", t("admin.settings.channels.webhook_missing")))
    : pill("warning", t("admin.settings.channels.console"));
  return html`<section class="card as-group" aria-labelledby="as-g-channels">
    <header class="as-group-head"><h3 id="as-g-channels">${t("admin.settings.group.channels.title")}</h3><p>${t("admin.settings.group.channels.desc")}</p></header>
    <div class="as-group-body">${dl([
      [t("admin.settings.channels.email"), email],
      [t("admin.settings.channels.sender"), e.smtp_from ? html`<span class="mono small">${e.smtp_from}</span>` : null],
      [t("admin.settings.channels.sms"), sms],
    ])}
    <p class="small muted as-note">${icon("info")}<span>${t("admin.settings.channels.note")}</span></p>
    <div class="as-links"><a class="btn sm" href="/staff/notices">${icon("send")}${t("admin.settings.channels.open_notices")}</a>
      <a class="btn sm ghost" href="/staff/notices#outbox">${icon("inbox")}${t("admin.settings.channels.open_outbox")}</a></div></div></section>`;
}

function integrationsCard() {
  const e = state.env;
  const ai = !e.ai_enabled ? pill("neutral", t("admin.settings.integrations.ai_off"))
    : e.ai_claude ? pill("ai", t("admin.settings.integrations.ai_claude")) : pill("info", t("admin.settings.integrations.ai_local"));
  const link = (href, ic, title, desc) => html`<li><a class="as-link-card" href="${href}">${icon(ic)}<span><strong>${title}</strong><span class="small muted">${desc}</span></span>${icon("arrow-right", "as-chev")}</a></li>`;
  return html`<section class="card as-group" aria-labelledby="as-g-engine">
      <header class="as-group-head"><h3 id="as-g-engine">${t("admin.settings.group.engine.title")}</h3><p>${t("admin.settings.group.engine.desc")}</p></header>
      <div class="as-group-body">${dl([[t("admin.settings.integrations.ai_engine"), ai], [t("admin.settings.integrations.public_url"), e.public_url ? html`<span class="mono small">${e.public_url}</span>` : t("admin.settings.integrations.public_url_unset")]])}</div></section>
    <section class="card as-group" aria-labelledby="as-g-connected">
      <header class="as-group-head"><h3 id="as-g-connected">${t("admin.settings.group.connected.title")}</h3><p>${t("admin.settings.group.connected.desc")}</p></header>
      <ul class="as-link-list">
        ${link("/staff/roles#sso", "key", t("admin.settings.integrations.sso"), t("admin.settings.integrations.sso_desc"))}
        ${link("/staff/interop#sip", "monitor", t("admin.settings.integrations.sip"), t("admin.settings.integrations.sip_desc"))}
        ${link("/staff/interop#targets", "download", t("admin.settings.integrations.copycat"), t("admin.settings.integrations.copycat_desc"))}
        ${link("/staff/interop#endpoints", "globe", t("admin.settings.integrations.endpoints"), t("admin.settings.integrations.endpoints_desc"))}
      </ul></section>`;
}

async function renderSettings(key, p, alive) {
  const all = await loadSettings();
  if (!alive()) return;
  const rows = all.filter((r) => (SETTING_SECTIONS.includes(r.section) ? r.section : "policies") === key);
  const groups = GROUPS[key].map((g) => [g, rows.filter((r) => (GROUPS[key].includes(r.group) ? r.group : "other") === g)]).filter(([, list]) => list.length);
  p.innerHTML = html`${sectionHead(key)}
    ${key === "notices" ? channelCard() : ""}
    <form class="as-form" id="as-form" novalidate aria-labelledby="as-section-title">
      ${groups.map(([g, list]) => html`<section class="card as-group" aria-labelledby="as-g-${g}">
        <header class="as-group-head"><h3 id="as-g-${g}">${t(`admin.settings.group.${g}.title`)}</h3><p>${t(`admin.settings.group.${g}.desc`)}</p></header>
        <div class="as-rows">${list.map(settingRow)}</div></section>`)}
      ${saveBar({ submit: t("admin.settings.save_changes"), cancel: t("admin.settings.discard") })}
    </form>
    ${key === "integrations" ? integrationsCard() : ""}`;
  const form = $("#as-form", p);
  syncModified(form, rows);
  const f = enhanceForm(form, {
    guard: false,
    validate: Object.fromEntries(rows.filter((r) => r.type === "int").map((r) => [r.key, (v) => (/^-?\d+$/.test(String(v).trim()) ? true : t("admin.common.whole_number"))])),
    onSubmit: async () => {
      const changed = rows.filter((r) => !sameValue(readSetting(form, r), r.value));
      if (!changed.length) { toast(t("admin.settings.nothing_changed"), "info"); return; }
      for (const r of changed) {
        const res = await api(`/admin/settings/${encodeURIComponent(r.key)}`, { method: "PUT", body: { value: readSetting(form, r) } });
        r.value = res.value;
      }
      commitDefaults(form);
      syncModified(form, rows);
      toast(t("admin.settings.saved", { count: changed.length }), "success");
    },
  });
  state.cleanup.push(guardUnsaved(f.isDirty));
  form.addEventListener("input", () => syncModified(form, rows));
  form.addEventListener("change", () => syncModified(form, rows));
  form.addEventListener("reset", () => setTimeout(() => syncModified(form, rows)));
  form.addEventListener("click", (e) => {
    const b = e.target.closest("[data-reset]");
    if (!b) return;
    const r = rows.find((x) => x.key === b.dataset.reset);
    const el = form.elements[r.key];
    if (r && el) setDefaultValue(el, r);
  });
}

// ================================================================== lookup tables (branches, item types, categories)

const codeField = (value) => field({ name: "code", label: t("admin.settings.f.code"), value: value || "", required: true,
  help: t("admin.settings.f.code_help"),
  attrs: `class="mono" maxlength="16" pattern="[A-Z0-9_]+" autocapitalize="characters" spellcheck="false" autocomplete="off" title="${t("admin.settings.f.code_pattern").replace(/"/g, "&quot;")}"` });

const ENTITIES = {
  branches: {
    path: "/admin/branches", i18n: "branches", icon: "map",
    columns: () => [
      { key: "name", label: t("admin.settings.col.name"), primary: true, sortable: true, hideable: false, csv: (r) => r.name,
        render: (r) => html`<div class="dt-cell-stack"><button type="button" class="link-btn as-row-title" data-edit>${r.name}</button><span class="sub mono">${r.code}</span></div>` },
      { key: "address", label: t("admin.settings.col.address"), render: (r) => r.address || html`<span class="muted">—</span>` },
      { key: "email", label: t("admin.settings.col.email"), render: (r) => (r.email ? html`<a href="mailto:${r.email}">${r.email}</a>` : html`<span class="muted">—</span>`) },
      { key: "phone", label: t("admin.settings.col.phone"), render: (r) => r.phone || html`<span class="muted">—</span>` },
    ],
    form: (r = {}) => html`<div class="form-grid">${codeField(r.code)}
      ${field({ name: "name", label: t("admin.settings.col.name"), value: r.name || "", required: true, attrs: 'maxlength="120" autocomplete="off"' })}
      ${field({ name: "address", label: t("admin.settings.col.address"), value: r.address || "", optional: true, span: 2, attrs: 'maxlength="255"' })}
      ${field({ name: "email", label: t("admin.settings.col.email"), type: "email", value: r.email || "", optional: true, attrs: 'autocomplete="off"' })}
      ${field({ name: "phone", label: t("admin.settings.col.phone"), type: "tel", value: r.phone || "", optional: true, attrs: 'autocomplete="off"' })}</div>`,
    payload: (d) => ({ code: d.code.trim().toUpperCase(), name: d.name.trim(), address: d.address.trim() || null, email: d.email.trim() || null, phone: d.phone.trim() || null }),
  },
  "item-types": {
    path: "/admin/item-types", i18n: "item_types", icon: "book",
    columns: () => [
      { key: "name", label: t("admin.settings.col.name"), primary: true, sortable: true, hideable: false, csv: (r) => r.name,
        render: (r) => html`<div class="dt-cell-stack"><button type="button" class="link-btn as-row-title" data-edit>${r.name}</button><span class="sub mono">${r.code}</span></div>` },
      { key: "holdable", label: t("admin.settings.col.holds"), sortable: true, csv: (r) => (r.holdable ? t("admin.common.yes") : t("admin.common.no")),
        render: (r) => (r.holdable ? pill("success", t("admin.settings.item_types.holdable")) : pill("neutral", t("admin.settings.item_types.not_holdable"))) },
      { key: "replacement_cost", label: t("admin.settings.col.replacement_cost"), align: "num", sortable: true, csv: (r) => r.replacement_cost / 100, render: (r) => rupees(r.replacement_cost) },
    ],
    form: (r = {}) => html`<div class="form-grid">${codeField(r.code)}
      ${field({ name: "name", label: t("admin.settings.col.name"), value: r.name || "", required: true, attrs: 'maxlength="80" autocomplete="off"' })}
      ${numField({ name: "replacement_cost", label: t("admin.settings.col.replacement_cost"), unit: CURRENCY, prefix: true, step: 0.01, min: 0, max: 10000000,
        value: r.replacement_cost === undefined ? 500 : r.replacement_cost / 100, help: t("admin.settings.item_types.cost_help") })}
      ${switchField({ name: "holdable", label: t("admin.settings.item_types.holdable_label"), checked: r.holdable ?? true, help: t("admin.settings.item_types.holdable_help") })}</div>`,
    payload: (d) => ({ code: d.code.trim().toUpperCase(), name: d.name.trim(), replacement_cost: paise(d.replacement_cost), holdable: d.holdable === "on" }),
  },
  categories: {
    path: "/admin/categories", i18n: "categories", icon: "users",
    columns: () => [
      { key: "name", label: t("admin.settings.col.name"), primary: true, sortable: true, hideable: false, csv: (r) => r.name,
        render: (r) => html`<div class="dt-cell-stack"><button type="button" class="link-btn as-row-title" data-edit>${r.name}</button><span class="sub mono">${r.code}</span></div>` },
      { key: "max_loans", label: t("admin.settings.col.max_loans"), align: "num", sortable: true, csv: (r) => r.max_loans, render: (r) => num(r.max_loans) },
      { key: "max_holds", label: t("admin.settings.col.max_holds"), align: "num", sortable: true, csv: (r) => r.max_holds, render: (r) => num(r.max_holds) },
      { key: "enrollment_months", label: t("admin.settings.col.membership"), align: "num", sortable: true, csv: (r) => r.enrollment_months, render: (r) => unitText("months", r.enrollment_months) },
      { key: "block_fine_threshold", label: t("admin.settings.col.block_at"), align: "num", sortable: true, csv: (r) => r.block_fine_threshold / 100, render: (r) => rupees(r.block_fine_threshold) },
    ],
    form: (r = {}) => html`<div class="form-grid">${codeField(r.code)}
      ${field({ name: "name", label: t("admin.settings.col.name"), value: r.name || "", required: true, attrs: 'maxlength="80" autocomplete="off"' })}
      ${numField({ name: "max_loans", label: t("admin.settings.col.max_loans"), unit: unitWord("items"), min: 0, max: 500, value: r.max_loans ?? 10 })}
      ${numField({ name: "max_holds", label: t("admin.settings.col.max_holds"), unit: unitWord("holds"), min: 0, max: 500, value: r.max_holds ?? 5 })}
      ${numField({ name: "enrollment_months", label: t("admin.settings.categories.membership_label"), unit: unitWord("months"), min: 1, max: 1200, value: r.enrollment_months ?? 12,
        help: t("admin.settings.categories.membership_help") })}
      ${numField({ name: "block_fine_threshold", label: t("admin.settings.col.block_at"), unit: CURRENCY, prefix: true, step: 0.01, min: 0, max: 10000000,
        value: r.block_fine_threshold === undefined ? 500 : r.block_fine_threshold / 100, help: t("admin.settings.categories.block_help") })}</div>`,
    payload: (d) => ({ code: d.code.trim().toUpperCase(), name: d.name.trim(), max_loans: Number(d.max_loans), max_holds: Number(d.max_holds),
      enrollment_months: Number(d.enrollment_months), block_fine_threshold: paise(d.block_fine_threshold) }),
  },
};

function sortRows(rows, sort) {
  if (!sort) return rows;
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[sort.key], y = b[sort.key];
    if (typeof x === "number" || typeof x === "boolean") return (Number(x) - Number(y)) * dir;
    return String(x ?? "").localeCompare(String(y ?? ""), locale, { sensitivity: "base" }) * dir;
  });
}

const actionsColumn = (label) => ({ key: "actions", label: t("admin.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "as-cell-actions", headClass: "as-cell-actions",
  render: (r) => rowMenu({ label: label(r), items: [
    { id: "edit", label: t("admin.common.edit"), icon: "edit" },
    { id: "delete", label: t("admin.common.delete"), icon: "trash", danger: true },
  ] }) });

async function renderEntity(key, p, alive) {
  const cfg = ENTITIES[key];
  const k = cfg.i18n;
  p.innerHTML = html`${sectionHead(key, { actions: html`<button type="button" class="btn" data-add>${icon("plus")}${t(`admin.settings.${k}.add`)}</button>` })}<div id="as-table"></div>`;
  let sort = { key: "name", dir: "asc" };
  const table = dataTable($("#as-table", p), {
    id: `admin-${key}`, caption: t(`admin.settings.nav.${key.replace(/-/g, "_")}`), rowKey: (r) => r.id, rowLabel: (r) => r.name,
    columns: [...cfg.columns(), actionsColumn((r) => r.name)], sort,
    onSort: (s) => { sort = s; table.setRows(sortRows(state.rows[key], sort)); },
    exportName: `librowise-${key}`,
    empty: { art: key === "categories" ? "people" : key === "branches" ? "inbox" : "books", title: t(`admin.settings.${k}.empty_title`), body: t(`admin.settings.${k}.empty_body`),
      actions: html`<button type="button" class="btn" data-add>${icon("plus")}${t(`admin.settings.${k}.add`)}</button>` },
  });
  table.setLoading();
  const load = async () => {
    try {
      const { results } = await api(cfg.path);
      if (!alive()) return;
      state.rows[key] = results;
      table.setRows(sortRows(results, sort));
    } catch (err) { if (alive()) table.setError(err, load); }
  };
  await load();
  const find = (id) => state.rows[key]?.find((r) => String(r.id) === String(id));
  p.onclick = (e) => {
    if (e.target.closest("[data-add]")) editEntity(key, null, load);
    const ed = e.target.closest("[data-edit]");
    if (ed) editEntity(key, find(ed.closest("tr[data-key]")?.dataset.key), load);
  };
  p.addEventListener("rowmenu", (e) => {
    const row = find(e.target.closest("tr[data-key]")?.dataset.key);
    if (!row) return;
    if (e.detail.action === "edit") editEntity(key, row, load);
    else if (e.detail.action === "delete") deleteEntity(key, row, load);
  });
}

function wireCodeInput(dlg) {
  dlg.addEventListener("input", (e) => {
    const el = e.target;
    if (el.name !== "code") return;
    const pos = el.selectionStart;
    el.value = el.value.toUpperCase().replace(/[\s-]/g, "_");
    el.setSelectionRange(pos, pos);
  });
}

async function editEntity(key, row, reload) {
  const cfg = ENTITIES[key];
  const k = cfg.i18n;
  const others = (state.rows[key] || []).filter((r) => r.id !== row?.id);
  const saved = await editDialog({
    title: row ? t(`admin.settings.${k}.edit_title`, { name: row.name }) : t(`admin.settings.${k}.add_title`),
    submit: row ? t("admin.common.save_changes") : t(`admin.settings.${k}.add`),
    body: cfg.form(row || {}), size: "md", onOpen: wireCodeInput,
    validate: {
      code: (v) => (others.some((r) => r.code === v.trim().toUpperCase()) ? t("admin.settings.f.code_taken") : true),
      name: (v) => (v.trim() ? true : t("ui.form.required")),
    },
    onSubmit: (d) => api(row ? `${cfg.path}/${row.id}` : cfg.path, { method: row ? "PUT" : "POST", body: cfg.payload(d) }),
  });
  if (!saved) return;
  toast(row ? t("admin.common.saved_named", { name: saved.name }) : t("admin.common.added_named", { name: saved.name }), "success");
  await Promise.all([reload(), loadLookups().catch(() => {})]);
}

async function deleteEntity(key, row, reload) {
  const k = ENTITIES[key].i18n;
  const ok = await confirmDestructive({ title: t(`admin.settings.${k}.delete_title`, { name: row.name }), text: t(`admin.settings.${k}.delete_text`, { name: row.name }),
    word: row.code, submit: t("admin.common.delete") });
  if (!ok) return;
  try {
    await api(`${ENTITIES[key].path}/${row.id}`, { method: "DELETE" });
    toast(t("admin.common.deleted_named", { name: row.name }), "success");
    await Promise.all([reload(), loadLookups().catch(() => {})]);
  } catch (err) {
    toast(err.status === 409 ? t("admin.settings.in_use", { name: row.name }) : err.message, "error");
  }
}

// ================================================================== circulation rules

const anyLabel = (kind) => t(`admin.rules.any.${kind}`);
const nameOf = (list, id, kind) => (id === null || id === undefined ? anyLabel(kind) : list.find((x) => x.id === id)?.name || `#${id}`);
const ruleScope = (r) => [nameOf(state.lookups.branches, r.branch_id, "branch"), nameOf(state.lookups.categories, r.category_id, "category"), nameOf(state.lookups.item_types, r.item_type_id, "item_type")].join(" · ");
const renewalsText = (n) => t("admin.rules.renewals_n", { count: Number(n) });
const finePerDay = (p) => t("admin.rules.per_day", { amount: rupees(p) });

const RULE_FIELDS = [
  ["loan_days", "days", 0, 3650, 1], ["max_renewals", "renewals", 0, 100, 1], ["grace_days", "days", 0, 365, 1],
  ["fine_per_day", "money", 0, 1000000, 0.01], ["fine_cap", "money", 0, 10000000, 0.01], ["hold_pickup_days", "days", 1, 365, 1],
];

function ruleFields(values) {
  return html`<div class="form-grid">${RULE_FIELDS.map(([name, unit, min, max, step]) => numField({
    name, label: t(`admin.rules.f.${name}`), help: t(`admin.rules.f.${name}_help`), min, max, step,
    unit: unit === "money" ? CURRENCY : unitWord(unit), prefix: unit === "money",
    value: unit === "money" ? Number(values[name] ?? 0) / 100 : values[name] ?? "" }))}</div>`;
}

const rulePayload = (d) => Object.fromEntries(RULE_FIELDS.map(([name, unit]) => [name, unit === "money" ? paise(d[name]) : Number(d[name])]));

async function loadRules() {
  const [{ results }, matrix] = await Promise.all([api("/admin/rules"), api(`/admin/rules/matrix?${qs({ branch_id: state.matrixBranch })}`)]);
  state.rows.rules = results;
  state.matrix = matrix;
}

function cellOf(catId, typeId) {
  return state.matrix?.cells.find((c) => c.category_id === catId && c.item_type_id === typeId);
}

function cellSource(c) {
  if (c.explicit_rule_id) return { kind: "explicit", text: t("admin.rules.source.explicit") };
  if (c.effective.source_rule_id) {
    const r = state.rows.rules.find((x) => x.id === c.effective.source_rule_id);
    return { kind: "inherited", text: t("admin.rules.source.inherited", { rule: r ? ruleScope(r) : `#${c.effective.source_rule_id}` }) };
  }
  return { kind: "default", text: t("admin.rules.source.default") };
}

function matrixHtml() {
  const m = state.matrix;
  const cats = [{ id: null, name: anyLabel("category") }, ...m.categories];
  const types = [{ id: null, name: anyLabel("item_type") }, ...m.item_types];
  let first = true;
  const cell = (cat, typ) => {
    const c = cellOf(cat.id, typ.id);
    const src = cellSource(c);
    const e = c.effective;
    const tab = first ? "0" : "-1";
    first = false;
    // The accessible name is the visible text plus screen-reader-only context (axe label-content-name-mismatch).
    return html`<td><button type="button" class="as-cell is-${src.kind}" tabindex="${tab}" data-cat="${cat.id ?? ""}" data-type="${typ.id ?? ""}">
      <span class="sr-only">${t("admin.rules.cell_context", { category: cat.name, item_type: typ.name })}</span>
      <span class="as-cell-main"><span class="num">${num(e.loan_days)}</span> <span class="as-cell-unit">${unitWord("days")}</span></span>
      <span class="as-cell-sub">${renewalsText(e.max_renewals)}</span><span class="as-cell-sub">${finePerDay(e.fine_per_day)}</span>
      <span class="sr-only">${src.text}</span>
      ${src.kind === "explicit" ? html`<span class="as-cell-flag" aria-hidden="true">${icon("check")}</span>` : ""}</button></td>`;
  };
  return html`<div class="as-legend" aria-hidden="true">
      <span><span class="as-swatch is-explicit"></span>${t("admin.rules.legend.explicit")}</span>
      <span><span class="as-swatch is-inherited"></span>${t("admin.rules.legend.inherited")}</span>
      <span><span class="as-swatch is-default"></span>${t("admin.rules.legend.default")}</span></div>
    <div class="as-matrix-scroll" role="region" aria-label="${t("admin.rules.matrix_region")}" tabindex="0">
    <table class="as-matrix" aria-describedby="as-matrix-help">
      <caption class="sr-only">${t("admin.rules.matrix_caption", { branch: nameOf(state.lookups.branches, m.branch_id, "branch") })}</caption>
      <thead><tr><th scope="col" class="as-corner"><span>${t("admin.rules.rows_cols")}</span></th>${types.map((ty) => html`<th scope="col" class="${ty.id === null ? "is-any" : ""}">${ty.name}</th>`)}</tr></thead>
      <tbody>${cats.map((cat) => html`<tr><th scope="row" class="${cat.id === null ? "is-any" : ""}">${cat.name}</th>${types.map((ty) => cell(cat, ty))}</tr>`)}</tbody>
    </table></div>
    <p class="small muted as-matrix-help" id="as-matrix-help">${icon("keyboard")}<span>${t("admin.rules.matrix_help")}</span></p>`;
}

function rulesTable(el) {
  const table = dataTable(el, {
    id: "admin-rules", caption: t("admin.rules.list_caption"), rowKey: (r) => r.id, rowLabel: ruleScope,
    columns: [
      { key: "scope", label: t("admin.rules.col.applies_to"), primary: true, hideable: false, csv: ruleScope,
        render: (r) => html`<div class="dt-cell-stack"><button type="button" class="link-btn as-row-title" data-edit-rule>${ruleScope(r)}</button><span class="sub">${t("admin.rules.rule_n", { id: r.id })}</span></div>` },
      { key: "loan_days", label: t("admin.rules.f.loan_days"), align: "num", csv: (r) => r.loan_days, render: (r) => unitText("days", r.loan_days) },
      { key: "max_renewals", label: t("admin.rules.f.max_renewals"), align: "num", csv: (r) => r.max_renewals, render: (r) => num(r.max_renewals) },
      { key: "grace_days", label: t("admin.rules.f.grace_days"), align: "num", csv: (r) => r.grace_days, render: (r) => unitText("days", r.grace_days) },
      { key: "fine_per_day", label: t("admin.rules.f.fine_per_day"), align: "num", csv: (r) => r.fine_per_day / 100, render: (r) => rupees(r.fine_per_day) },
      { key: "fine_cap", label: t("admin.rules.f.fine_cap"), align: "num", csv: (r) => r.fine_cap / 100, render: (r) => rupees(r.fine_cap) },
      { key: "hold_pickup_days", label: t("admin.rules.f.hold_pickup_days"), align: "num", hidden: true, csv: (r) => r.hold_pickup_days, render: (r) => unitText("days", r.hold_pickup_days) },
      { key: "actions", label: t("admin.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "as-cell-actions", headClass: "as-cell-actions",
        render: (r) => rowMenu({ label: ruleScope(r), items: [{ id: "edit", label: t("admin.common.edit"), icon: "edit" }, { id: "delete", label: t("admin.common.delete"), icon: "trash", danger: true }] }) },
    ],
    exportName: "librowise-circulation-rules",
    empty: { art: "inbox", title: t("admin.rules.empty_title"), body: t("admin.rules.empty_body") },
  });
  table.setRows(state.rows.rules);
  return table;
}

function wireMatrixKeys(root) {
  root.addEventListener("keydown", (e) => {
    const btn = e.target.closest(".as-cell");
    if (!btn) return;
    const rows = $$("tbody tr", root).map((tr) => $$(".as-cell", tr));
    const r = rows.findIndex((list) => list.includes(btn));
    const c = rows[r].indexOf(btn);
    const rtl = getComputedStyle(root).direction === "rtl";
    let nr = r, nc = c;
    if (e.key === "ArrowDown") nr++;
    else if (e.key === "ArrowUp") nr--;
    else if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) nc++;
    else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) nc--;
    else if (e.key === "Home") { nc = 0; if (e.ctrlKey) nr = 0; }
    else if (e.key === "End") { nc = rows[r].length - 1; if (e.ctrlKey) nr = rows.length - 1; }
    else return;
    e.preventDefault();
    nr = Math.max(0, Math.min(rows.length - 1, nr));
    nc = Math.max(0, Math.min(rows[nr].length - 1, nc));
    focusCell(root, rows[nr][nc]);
  });
}

function focusCell(root, btn) {
  if (!btn) return;
  $$(".as-cell", root).forEach((b) => { b.tabIndex = b === btn ? 0 : -1; });
  btn.focus();
  btn.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const idOrNull = (v) => (v === "" || v === undefined || v === null ? null : Number(v));

async function openRulePanel({ branchId, catId, typeId, ruleId = null, create = false }, refresh) {
  const rules = state.rows.rules;
  let rule = ruleId ? rules.find((r) => r.id === ruleId) : rules.find((r) => r.branch_id === branchId && r.category_id === catId && r.item_type_id === typeId);
  if (rule) ({ branch_id: branchId, category_id: catId, item_type_id: typeId } = rule);
  if (create) rule = null;
  const cell = !create && !rule && branchId === idOrNull(state.matrixBranch) ? cellOf(catId, typeId) : null;
  const values = rule || cell?.effective || { loan_days: 14, max_renewals: 2, grace_days: 0, fine_per_day: 200, fine_cap: 10000, hold_pickup_days: 7 };
  const { branches, categories, item_types: types } = state.lookups;
  const sel = (name, kind, list, value) => html`<div class="field"><label for="rp-${name}">${t(`admin.rules.col.${kind}`)}</label>
    <select id="rp-${name}" name="${name}"><option value="">${anyLabel(kind)}</option>${list.map((x) => html`<option value="${x.id}" ${x.id === value ? "selected" : ""}>${x.name}</option>`)}</select></div>`;
  const scope = create
    ? html`<fieldset class="as-fieldset"><legend>${t("admin.rules.applies_to")}</legend><div class="form-grid">
        ${sel("branch_id", "branch", branches, branchId)}${sel("category_id", "category", categories, catId)}${sel("item_type_id", "item_type", types, typeId)}</div></fieldset>`
    : dl([[t("admin.rules.col.branch"), nameOf(branches, branchId, "branch")], [t("admin.rules.col.category"), nameOf(categories, catId, "category")], [t("admin.rules.col.item_type"), nameOf(types, typeId, "item_type")]], { className: "as-scope" });
  let status = "";
  if (!create) {
    if (rule) status = html`<div class="alert info">${icon("check-circle")}<div>${t("admin.rules.panel.explicit", { id: rule.id })}</div></div>`;
    else if (cell?.effective.source_rule_id) {
      const src = rules.find((r) => r.id === cell.effective.source_rule_id);
      status = html`<div class="alert warn">${icon("info")}<div>${t("admin.rules.panel.inherited", { rule: src ? ruleScope(src) : "" })}
        <div><button type="button" class="link-btn" data-open-source="${cell.effective.source_rule_id}">${t("admin.rules.panel.edit_source")}</button></div></div></div>`;
    } else status = html`<div class="alert">${icon("info")}<div>${t("admin.rules.panel.default")}</div></div>`;
  }
  const formId = `rule-form-${Date.now()}`;
  const sp = sidePanel({
    title: create ? t("admin.rules.panel.new_title") : t("admin.rules.panel.title", { category: nameOf(categories, catId, "category"), item_type: nameOf(types, typeId, "item_type") }),
    subtitle: create ? t("admin.rules.panel.new_sub") : nameOf(branches, branchId, "branch"),
    body: html`<form id="${formId}" class="stack" novalidate>${status}${scope}${ruleFields(values)}</form>`,
    footer: html`${rule ? html`<button type="button" class="btn danger" data-delete-rule>${icon("trash")}${t("admin.rules.panel.delete")}</button>` : ""}<span class="spacer grow"></span>
      <button type="button" class="btn" data-close>${t("common.cancel")}</button>
      <button type="submit" class="btn primary" form="${formId}">${icon("check")}${rule ? t("admin.common.save_changes") : t("admin.rules.panel.create")}</button>`,
  });
  const form = $(`#${formId}`, sp.el);
  const v = wireValidation(form, {
    validate: create ? { item_type_id: (_v, d) => {
      const b = idOrNull(d.branch_id), c = idOrNull(d.category_id), ty = idOrNull(d.item_type_id);
      return rules.some((r) => r.branch_id === b && r.category_id === c && r.item_type_id === ty) ? t("admin.rules.panel.exists") : true;
    } } : {},
    onSubmit: async (d) => {
      const body = { ...rulePayload(d), branch_id: create ? idOrNull(d.branch_id) : branchId, category_id: create ? idOrNull(d.category_id) : catId, item_type_id: create ? idOrNull(d.item_type_id) : typeId };
      const saved = await api(rule ? `/admin/rules/${rule.id}` : "/admin/rules", { method: rule ? "PUT" : "POST", body });
      toast(rule ? t("admin.rules.saved") : t("admin.rules.created"), "success");
      sp.close();
      await refresh({ focus: { catId: saved.category_id, typeId: saved.item_type_id } });
    },
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); v.submit($(`button[form="${formId}"]`, sp.el)); });
  sp.el.addEventListener("click", async (e) => {
    const src = e.target.closest("[data-open-source]");
    if (src) { sp.close(); await sp.closed; openRulePanel({ ruleId: Number(src.dataset.openSource) }, refresh); return; }
    if (e.target.closest("[data-delete-rule]")) {
      if (!(await confirmDialog(t("admin.rules.delete_title"), t("admin.rules.delete_text", { rule: ruleScope(rule) }), t("admin.common.delete")))) return;
      try {
        await api(`/admin/rules/${rule.id}`, { method: "DELETE" });
        toast(t("admin.rules.deleted"), "success");
        sp.close();
        await refresh({ focus: { catId, typeId } });
      } catch (err) { toast(err.message, "error"); }
    }
  });
}

function explainCard() {
  const { branches, categories, item_types: types } = state.lookups;
  const sel = (name, kind, list) => html`<div class="field"><label for="ex-${name}">${t(`admin.rules.col.${kind}`)}</label>
    <select id="ex-${name}" name="${name}" required>${list.map((o) => html`<option value="${o.id}">${o.name}</option>`)}</select></div>`;
  return html`<section class="card as-explain" aria-labelledby="as-explain-h">
    <header class="as-group-head"><h3 id="as-explain-h">${icon("help")}${t("admin.rules.explain.title")}</h3><p>${t("admin.rules.explain.desc")}</p></header>
    <div class="as-group-body stack">
      <form id="as-explain-form" class="as-explain-form" novalidate>${sel("branch_id", "branch", branches)}${sel("category_id", "category", categories)}${sel("item_type_id", "item_type", types)}
        <div class="field as-explain-go"><button class="btn primary" type="submit">${icon("info")}${t("admin.rules.explain.run")}</button></div></form>
      <div id="as-explain-result" aria-live="polite"></div></div></section>`;
}

async function runExplain(form) {
  const d = Object.fromEntries(new FormData(form));
  const out = $("#as-explain-result");
  try {
    const r = await withBusy($('button[type="submit"]', form), () => api(`/admin/rules/explain?${qs(d)}`));
    const e = r.effective;
    const { branches, categories, item_types: types } = state.lookups;
    const names = { branch: nameOf(branches, Number(d.branch_id), "branch"), category: nameOf(categories, Number(d.category_id), "category"), item_type: nameOf(types, Number(d.item_type_id), "item_type") };
    const src = e.source_rule_id ? state.rows.rules.find((x) => x.id === e.source_rule_id) : null;
    out.innerHTML = html`<div class="as-explain-out">
      <p class="as-explain-summary">${t("admin.rules.explain.summary", { ...names, days: unitText("days", e.loan_days), renewals: renewalsText(e.max_renewals), fine: rupees(e.fine_per_day), cap: rupees(e.fine_cap) })}</p>
      ${dl([[t("admin.rules.f.loan_days"), unitText("days", e.loan_days)], [t("admin.rules.f.max_renewals"), renewalsText(e.max_renewals)],
        [t("admin.rules.f.grace_days"), unitText("days", e.grace_days)], [t("admin.rules.f.fine_per_day"), rupees(e.fine_per_day)],
        [t("admin.rules.f.fine_cap"), rupees(e.fine_cap)], [t("admin.rules.f.hold_pickup_days"), unitText("days", e.hold_pickup_days)]], { cols: 2 })}
      <div class="alert ${src ? "ok" : "warn"}">${icon(src ? "check-circle" : "info")}<div>
        ${src ? html`${t("admin.rules.explain.matched", { rule: ruleScope(src) })} <span class="muted">${t("admin.rules.explain.why")}</span>` : t("admin.rules.explain.none")}
        <div class="as-explain-actions"><button type="button" class="btn sm" data-show-cell data-branch="${d.branch_id}">${icon("grid")}${t("admin.rules.explain.show")}</button>
          ${src ? html`<button type="button" class="btn sm ghost" data-open-source="${src.id}">${icon("edit")}${t("admin.rules.explain.edit_rule")}</button>` : ""}</div></div></div></div>`;
    out.dataset.cat = d.category_id;
    out.dataset.type = d.item_type_id;
  } catch (err) {
    out.innerHTML = html`<div class="alert bad" role="alert">${icon("alert")}<div>${err.message}</div></div>`;
  }
}

async function renderRules(p, alive) {
  state.rulesView = store.get("sw-admin:rules-view", "matrix") === "list" ? "list" : "matrix";
  await loadRules();
  if (!alive()) return;
  const branchOpts = [["", t("admin.rules.all_branches")], ...state.lookups.branches.map((b) => [String(b.id), b.name])];
  p.innerHTML = html`${sectionHead("rules", { actions: html`<button type="button" class="btn" data-add-rule>${icon("plus")}${t("admin.rules.add")}</button>` })}
    <div class="card as-rules">
      <div class="as-rules-toolbar">
        ${segmented({ name: "rules-view", label: t("admin.rules.view_label"), value: state.rulesView, options: [["matrix", t("admin.rules.view_matrix"), "grid"], ["list", t("admin.rules.view_list"), "rows"]] })}
        <div class="field as-inline-field" data-matrix-only><label for="as-rule-branch">${t("admin.rules.col.branch")}</label>
          <select id="as-rule-branch">${branchOpts.map(([v, l]) => html`<option value="${v}" ${v === String(state.matrixBranch) ? "selected" : ""}>${l}</option>`)}</select></div>
        <p class="small muted as-rules-hint">${t("admin.rules.precedence")}</p>
      </div>
      <div id="as-rules-body" class="as-rules-body"></div>
    </div>
    ${explainCard()}`;
  const body = $("#as-rules-body", p);
  const paint = () => {
    $$("[data-matrix-only]", p).forEach((x) => { x.hidden = state.rulesView !== "matrix"; });
    if (state.rulesView === "matrix") body.innerHTML = matrixHtml();
    else { body.innerHTML = '<div id="as-rules-table"></div>'; rulesTable($("#as-rules-table", body)); }
  };
  const refresh = async ({ focus } = {}) => {
    await loadRules();
    if (!alive()) return;
    paint();
    if (focus && state.rulesView === "matrix") {
      const btn = $(`.as-cell[data-cat="${focus.catId ?? ""}"][data-type="${focus.typeId ?? ""}"]`, body);
      if (btn) { focusCell(body, btn); btn.classList.add("is-flash"); }
    }
  };
  paint();
  wireMatrixKeys(body);
  wireSegmented($("[data-segmented]", p), (v) => { state.rulesView = v; store.set("sw-admin:rules-view", v); paint(); });
  $("#as-rule-branch", p).addEventListener("change", async (e) => {
    state.matrixBranch = e.target.value;
    body.setAttribute("aria-busy", "true");
    try { await refresh(); } catch (err) { toast(err.message, "error"); } finally { body.removeAttribute("aria-busy"); }
  });
  p.onclick = async (e) => {
    const cellBtn = e.target.closest(".as-cell");
    if (cellBtn) {
      openRulePanel({ branchId: idOrNull(state.matrixBranch), catId: idOrNull(cellBtn.dataset.cat), typeId: idOrNull(cellBtn.dataset.type) }, refresh);
      return;
    }
    if (e.target.closest("[data-add-rule]")) { openRulePanel({ branchId: idOrNull(state.matrixBranch), catId: null, typeId: null, create: true }, refresh); return; }
    const ed = e.target.closest("[data-edit-rule]");
    if (ed) { openRulePanel({ ruleId: Number(ed.closest("tr[data-key]").dataset.key) }, refresh); return; }
    const src = e.target.closest("[data-open-source]");
    if (src && !src.closest("dialog")) { openRulePanel({ ruleId: Number(src.dataset.openSource) }, refresh); return; }
    const show = e.target.closest("[data-show-cell]");
    if (show) {
      const out = $("#as-explain-result", p);
      if (state.rulesView !== "matrix") { state.rulesView = "matrix"; store.set("sw-admin:rules-view", "matrix"); $$('[data-segmented] [role="radio"]', p).forEach((b) => { const on = b.dataset.value === "matrix"; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; }); }
      state.matrixBranch = show.dataset.branch;
      $("#as-rule-branch", p).value = state.matrixBranch;
      await refresh();
      $$(".as-cell.is-explained", body).forEach((b) => b.classList.remove("is-explained"));
      const btn = $(`.as-cell[data-cat="${out.dataset.cat}"][data-type="${out.dataset.type}"]`, body);
      if (btn) { btn.classList.add("is-explained"); focusCell(body, btn); }
    }
  };
  p.addEventListener("rowmenu", async (e) => {
    const rule = state.rows.rules.find((r) => String(r.id) === e.target.closest("tr[data-key]")?.dataset.key);
    if (!rule) return;
    if (e.detail.action === "edit") openRulePanel({ ruleId: rule.id }, refresh);
    else if (e.detail.action === "delete") {
      if (!(await confirmDialog(t("admin.rules.delete_title"), t("admin.rules.delete_text", { rule: ruleScope(rule) }), t("admin.common.delete")))) return;
      try { await api(`/admin/rules/${rule.id}`, { method: "DELETE" }); toast(t("admin.rules.deleted"), "success"); await refresh(); } catch (err) { toast(err.message, "error"); }
    }
  });
  $("#as-explain-form", p).addEventListener("submit", (e) => { e.preventDefault(); runExplain(e.target); });
}

// ================================================================== audit log

const AUDIT_KEYS = ["action", "entity", "actor", "from", "to"];
const AUDIT_ACTIONS = ["create", "update", "delete", "setting", "login", "logout", "login_failed", "login_locked", "checkout", "checkin", "renew",
  "place_hold", "payment", "waive", "charge", "import", "marc_import", "nightly_job", "job_enqueue", "job_retry", "job_cancel", "mfa_enabled",
  "mfa_disabled", "mfa_reset", "password_changed", "password_reset", "staff_role_assigned", "sessions_revoked_all", "api_tokens_revoked_all",
  "unlock", "erase", "self_register", "registration_approved", "registration_rejected", "sso_provider_saved", "sso_provider_deleted", "copycat_import", "cancel", "receive"];
const AUDIT_ENTITIES = ["branches", "item-types", "categories", "rules", "settings", "patron", "item", "loan", "biblio", "hold", "authority", "order",
  "vendor", "budget", "subscription", "course", "job", "system", "staff_role", "sip_account", "copycat_target", "notification", "notice_template",
  "suggestion", "kiosk", "calendar_closure", "branch", "label_layout"];
const actionLabel = (a) => (AUDIT_ACTIONS.includes(a) ? t(`admin.audit.action.${a}`) : humanize(a));
const entityLabel = (e) => (AUDIT_ENTITIES.includes(e) ? t(`admin.audit.entity.${e.replace(/-/g, "_")}`) : humanize(e));
function actionTone(a) {
  if (/delete|erase|cancel|revoked|remove|lost/.test(a)) return "danger";
  if (/failed|locked|reject/.test(a)) return "warning";
  if (/^create|added|approved|enabled|self_register|^add_/.test(a)) return "success";
  if (/import|job|nightly|generate|batch/.test(a)) return "ai";
  if (/^log(in|out)|session|kiosk_log/.test(a)) return "neutral";
  return "info";
}
const ENTITY_LINK = { patron: (id) => `/staff/patrons/${id}`, biblio: (id) => `/staff/catalog/${id}` };

const auditQuery = () => {
  const p = new URLSearchParams(location.search);
  return { ...Object.fromEntries(AUDIT_KEYS.map((k) => [k, p.get(k) || ""])), page: Number(p.get("page")) || 1, per_page: Number(p.get("per_page")) || 25 };
};
function setAuditQuery(changes) {
  const next = { ...auditQuery(), ...changes };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v !== "" && v !== null && !(k === "page" && v === 1) && !(k === "per_page" && v === 25)) p.set(k, v);
  const q = p.toString();
  history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}#audit`);
  return next;
}

function fmtDetailValue(v) {
  if (v === null || v === undefined || v === "") return html`<span class="muted">—</span>`;
  if (typeof v === "boolean") return v ? t("admin.common.yes") : t("admin.common.no");
  if (typeof v === "number") return num(v);
  if (Array.isArray(v)) return v.length ? html`<span class="as-chips">${v.map((x) => html`<span class="as-chip">${typeof x === "object" ? JSON.stringify(x) : humanizeValue(x)}</span>`)}</span>` : html`<span class="muted">${t("admin.audit.none")}</span>`;
  if (typeof v === "object") return dl(Object.entries(v).map(([k, x]) => [detailKey(k), fmtDetailValue(x)]), { className: "as-nested" });
  return humanizeValue(v);
}
const humanizeValue = (x) => (typeof x === "string" && /^[a-z]+(_[a-z]+)+$/.test(x) ? humanize(x) : String(x));
const DETAIL_KEYS = ["key", "value", "before", "after", "added", "removed", "fields", "count", "name", "login", "type", "url", "title", "created", "skipped", "sessions_revoked", "reason", "method", "permissions", "unassigned", "source", "password_changed", "item", "patron", "override", "provider", "issuer", "amount", "barcode", "status", "email"];
const detailKey = (k) => (DETAIL_KEYS.includes(k) ? t(`admin.audit.key.${k}`) : humanize(k));

function auditDetails(ev) {
  const d = { ...(ev.details || {}) };
  const blocks = [];
  if (ev.action === "setting" && d.key) {
    const meta = state.settings?.find((s) => s.key === d.key);
    blocks.push(dl([[t("admin.audit.key.setting"), meta ? settingLabel(meta) : humanize(d.key)], [t("admin.audit.key.new_value"), meta ? formatSetting(meta, d.value) : fmtDetailValue(d.value)]]));
    delete d.key; delete d.value;
  }
  if ("before" in d || "after" in d) {
    blocks.push(html`<div class="as-diff"><span class="as-diff-old">${fmtDetailValue(d.before)}</span>${icon("arrow-right", "as-diff-arrow")}<span class="as-diff-new">${fmtDetailValue(d.after)}</span></div>`);
    delete d.before; delete d.after;
  }
  if (Array.isArray(d.added) || Array.isArray(d.removed)) {
    blocks.push(html`<ul class="as-difflist">${(d.added || []).map((x) => html`<li class="is-add"><span aria-hidden="true">+</span><span class="sr-only">${t("admin.audit.added")}</span> <span class="mono">${x}</span></li>`)}${(d.removed || []).map((x) => html`<li class="is-del"><span aria-hidden="true">−</span><span class="sr-only">${t("admin.audit.removed")}</span> <span class="mono">${x}</span></li>`)}</ul>`);
    delete d.added; delete d.removed;
  }
  if (Array.isArray(d.fields)) {
    blocks.push(dl([[t("admin.audit.key.fields"), html`<span class="as-chips">${d.fields.map((f) => html`<span class="as-chip">${humanize(f)}</span>`)}</span>`]]));
    delete d.fields;
  }
  const rest = Object.entries(d);
  if (rest.length) blocks.push(dl(rest.map(([k, v]) => [detailKey(k), fmtDetailValue(v)])));
  return blocks.length ? html`${blocks}` : html`<p class="muted">${t("admin.audit.no_details")}</p>`;
}

function auditSummary(ev) {
  const d = ev.details || {};
  if (ev.action === "setting" && d.key) {
    const meta = state.settings?.find((s) => s.key === d.key);
    return `${meta ? settingLabel(meta) : humanize(d.key)} → ${meta ? formatSetting(meta, d.value) : String(d.value)}`;
  }
  if ("before" in d || "after" in d) return `${d.before ?? "—"} → ${d.after ?? "—"}`;
  if (d.name || d.login || d.title) return String(d.name || d.login || d.title);
  if (Array.isArray(d.fields)) return t("admin.audit.fields_changed", { count: d.fields.length });
  const simple = Object.entries(d).filter(([, v]) => v !== null && typeof v !== "object").slice(0, 2);
  if (simple.length) return simple.map(([k, v]) => `${detailKey(k)}: ${typeof v === "boolean" ? (v ? t("admin.common.yes") : t("admin.common.no")) : humanizeValue(v)}`).join(" · ");
  const n = Object.keys(d).length;
  return n ? t("admin.audit.n_details", { count: n }) : "";
}

function openAuditEvent(ev) {
  const link = ev.entity_id && ENTITY_LINK[ev.entity]?.(ev.entity_id);
  sidePanel({
    title: actionLabel(ev.action), subtitle: datetime(ev.at),
    body: html`<div class="stack">${dl([
      [t("admin.audit.col.when"), html`${datetime(ev.at)} <span class="muted">(${relative(ev.at)})</span>`],
      [t("admin.audit.col.actor"), ev.actor || html`<span class="muted">${t("admin.audit.system")}</span>`],
      [t("admin.audit.col.action"), pill(actionTone(ev.action), actionLabel(ev.action))],
      [t("admin.audit.col.entity"), html`${entityLabel(ev.entity)}${ev.entity_id ? html` <span class="mono muted">#${ev.entity_id}</span>` : ""}${link ? html` · <a href="${link}">${t("admin.audit.open_record")}</a>` : ""}`],
      [t("admin.audit.col.ip"), ev.ip ? html`<span class="mono">${ev.ip}</span>` : null],
      [t("admin.audit.event_id"), html`<span class="mono">${ev.id}</span>`],
    ])}
    <section class="as-detail-block" aria-labelledby="as-ev-h"><h3 id="as-ev-h">${t("admin.audit.details")}</h3>${auditDetails(ev)}</section>
    ${ev.details && Object.keys(ev.details).length ? html`<details class="as-raw"><summary>${t("admin.audit.raw")}</summary><pre tabindex="0" class="as-code">${JSON.stringify(ev.details, null, 2)}</pre></details>` : ""}</div>`,
  });
}

async function renderAudit(p, alive) {
  const q = auditQuery();
  let facets = { actions: [], entities: [] };
  try { facets = await api("/admin/audit/facets"); } catch { /* filters fall back to free values */ }
  if (!alive()) return;
  loadSettings().catch(() => {});
  const actionOpts = [["", t("admin.audit.any_action")], ...facets.actions.map((a) => [a, actionLabel(a)]).sort((a, b) => a[1].localeCompare(b[1], locale))];
  const entityOpts = [["", t("admin.audit.any_entity")], ...facets.entities.map((e) => [e, entityLabel(e)]).sort((a, b) => a[1].localeCompare(b[1], locale))];
  p.innerHTML = html`${sectionHead("audit")}
    <div class="filter-bar as-audit-filters" role="region" aria-label="${t("ui.filters.label")}">
      <div class="filter-row">
        ${searchField({ name: "actor", label: t("admin.audit.actor_search"), value: q.actor, shortcut: "/" })}
        ${selectChip({ name: "action", label: t("admin.audit.col.action"), value: q.action, options: actionOpts })}
        ${selectChip({ name: "entity", label: t("admin.audit.col.entity"), value: q.entity, options: entityOpts })}
        <span class="as-dates" role="group" aria-label="${t("admin.audit.date_range")}">
          <label class="sr-only" for="au-from">${t("admin.audit.from")}</label><input type="date" id="au-from" name="from" value="${q.from}" data-date="from" title="${t("admin.audit.from")}">
          <span aria-hidden="true">–</span>
          <label class="sr-only" for="au-to">${t("admin.audit.to")}</label><input type="date" id="au-to" name="to" value="${q.to}" data-date="to" title="${t("admin.audit.to")}"></span>
      </div>
      <div id="as-audit-chips"></div>
    </div>
    <div id="as-audit-table"></div>`;
  const chips = () => {
    const c = auditQuery();
    const list = [];
    if (c.actor) list.push({ key: "actor", label: t("admin.audit.col.actor"), value: c.actor });
    if (c.action) list.push({ key: "action", label: t("admin.audit.col.action"), value: actionLabel(c.action) });
    if (c.entity) list.push({ key: "entity", label: t("admin.audit.col.entity"), value: entityLabel(c.entity) });
    if (c.from) list.push({ key: "from", label: t("admin.audit.from"), value: c.from });
    if (c.to) list.push({ key: "to", label: t("admin.audit.to"), value: c.to });
    $("#as-audit-chips", p).innerHTML = activeFilters(list);
  };
  const table = dataTable($("#as-audit-table", p), {
    id: "admin-audit", caption: t("admin.audit.caption"), rowKey: (r) => r.id, rowLabel: (r) => `${actionLabel(r.action)} ${r.id}`,
    perPageOptions: [25, 50, 100], perPage: q.per_page,
    columns: [
      { key: "at", label: t("admin.audit.col.when"), csv: (r) => r.at, render: (r) => html`<span class="nowrap" title="${datetime(r.at)}">${relative(r.at)}</span><span class="sub as-sub-time">${datetime(r.at)}</span>` },
      { key: "actor", label: t("admin.audit.col.actor"), primary: true, csv: (r) => r.actor || t("admin.audit.system"),
        render: (r) => (r.actor ? html`<span class="dt-person">${avatar(r.actor, { size: "xs" })}<span>${r.actor}</span></span>` : html`<span class="muted">${t("admin.audit.system")}</span>`) },
      { key: "action", label: t("admin.audit.col.action"), csv: (r) => actionLabel(r.action), render: (r) => pill(actionTone(r.action), actionLabel(r.action)) },
      { key: "entity", label: t("admin.audit.col.entity"), csv: (r) => `${entityLabel(r.entity)}${r.entity_id ? ` #${r.entity_id}` : ""}`,
        render: (r) => html`${entityLabel(r.entity)}${r.entity_id ? html` <span class="mono muted small">#${r.entity_id}</span>` : ""}` },
      { key: "summary", label: t("admin.audit.col.summary"), cardHidden: true, csv: auditSummary, render: (r) => html`<span class="as-summary">${auditSummary(r)}</span>` },
      { key: "ip", label: t("admin.audit.col.ip"), hidden: true, csv: (r) => r.ip || "", render: (r) => (r.ip ? html`<span class="mono small">${r.ip}</span>` : html`<span class="muted">—</span>`) },
      { key: "open", label: t("admin.audit.details"), labelHidden: true, hideable: false, csv: false, cellClass: "as-cell-actions", headClass: "as-cell-actions",
        render: (r) => html`<button type="button" class="btn sm ghost icon-only" data-open-event aria-label="${t("admin.audit.view_event", { id: r.id })}" data-tip="${t("admin.audit.details")}">${icon("chevron")}</button>` },
    ],
    onPage: ({ page, perPage }) => { setAuditQuery({ page, per_page: perPage }); load(); },
    exportName: "librowise-audit-log",
    empty: { art: "filter", title: t("admin.audit.empty_title"), body: t("admin.audit.empty_body") },
  });
  let rows = [];
  const load = async () => {
    const c = auditQuery();
    table.setLoading();
    try {
      const r = await api(`/admin/audit?${qs({ action: c.action, entity: c.entity, actor: c.actor, date_from: c.from, date_to: c.to, page: c.page, per_page: c.per_page })}`);
      if (!alive()) return;
      rows = r.results;
      table.setRows(rows, { total: r.total, page: c.page, perPage: c.per_page });
    } catch (err) { if (alive()) table.setError(err, load); }
  };
  const apply = (changes) => {
    setAuditQuery({ ...changes, page: 1 });
    const c = auditQuery();
    for (const k of ["action", "entity"]) { const s = $(`[data-filter="${k}"]`, p); if (s) { s.value = c[k]; s.closest(".select-chip")?.classList.toggle("active", !!c[k]); } }
    const a = $('input[name="actor"]', p); if (a && a.value.trim() !== c.actor) a.value = c.actor;
    $("#au-from", p).value = c.from; $("#au-to", p).value = c.to;
    chips();
    load();
  };
  wireFilterBar($(".as-audit-filters", p), apply, { keys: AUDIT_KEYS });
  $$("[data-date]", p).forEach((inp) => inp.addEventListener("change", () => apply({ [inp.dataset.date]: inp.value })));
  chips();
  await load();
  const open = (tr) => { const ev = rows.find((r) => String(r.id) === tr?.dataset.key); if (ev) openAuditEvent(ev); };
  $("#as-audit-table", p).addEventListener("click", (e) => {
    const tr = e.target.closest("tbody tr[data-key]");
    if (!tr) return;
    if (e.target.closest("[data-open-event]") || !e.target.closest("a,button,input,label,select,textarea,summary")) open(tr);
  });
  $("#as-audit-table", p).addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("tbody tr[data-key]")) { e.preventDefault(); open(e.target); } });
}

// ================================================================== data & maintenance

const resultBox = (tone, title, pairs, errors = []) => html`<div class="alert ${tone}" role="status">${icon(tone === "ok" ? "check-circle" : "alert")}<div class="grow">
  <strong>${title}</strong>${dl(pairs)}${errors?.length ? html`<details class="as-errors"><summary>${t("admin.maint.problems", { count: errors.length })}</summary>
    <ul>${errors.slice(0, 50).map((x) => html`<li>${x}</li>`)}</ul></details>` : ""}</div></div>`;

function renderMaintenance(p) {
  const { branches, item_types: types } = state.lookups;
  const home = BOOT.user?.home_branch_id;
  p.innerHTML = html`${sectionHead("maintenance")}
    <div class="as-callout card">${icon("activity")}<div><strong>${t("admin.maint.system_title")}</strong><p class="small muted">${t("admin.maint.system_body")}</p></div>
      <a class="btn" href="/staff/system">${t("admin.maint.open_system")}${icon("arrow-right", "as-chev")}</a></div>
    <div class="as-maint-grid">
      <section class="card as-group" aria-labelledby="mj-nightly"><header class="as-group-head"><h3 id="mj-nightly">${icon("clock")}${jobLabel("nightly")}</h3><p>${jobDescription("nightly")}</p></header>
        <div class="as-group-body stack"><div><button type="button" class="btn primary" data-job="nightly">${icon("refresh")}${t("admin.maint.run_now")}</button></div><div id="mj-nightly-out" aria-live="polite"></div></div></section>
      <section class="card as-group" aria-labelledby="mj-reindex"><header class="as-group-head"><h3 id="mj-reindex">${icon("search")}${jobLabel("reindex")}</h3><p>${jobDescription("reindex")}</p></header>
        <div class="as-group-body stack"><div><button type="button" class="btn" data-job="reindex">${icon("refresh")}${t("admin.maint.rebuild")}</button></div><div id="mj-reindex-out" aria-live="polite"></div></div></section>
      <section class="card as-group" aria-labelledby="mj-marc"><header class="as-group-head"><h3 id="mj-marc">${icon("upload")}${t("admin.maint.marc_title")}</h3><p>${t("admin.maint.marc_desc")}</p></header>
        <form class="as-group-body stack" id="marc-form" novalidate>
          ${field({ name: "file", label: t("admin.maint.marc_file"), type: "file", required: true, help: t("admin.maint.marc_help"), attrs: 'accept=".mrc,.marc,.xml,application/marc,application/xml"' })}
          <div class="form-grid">${field({ name: "branch_id", label: t("admin.maint.default_branch"), as: "select", value: home, options: branches.map((b) => [b.id, b.name]) })}
            ${field({ name: "item_type_id", label: t("admin.maint.default_type"), as: "select", value: types.find((x) => x.code === "BOOK")?.id, options: types.map((x) => [x.id, x.name]) })}</div>
          <div><button class="btn primary" type="submit">${icon("upload")}${t("admin.maint.import_records")}</button></div><div id="marc-result" aria-live="polite"></div></form></section>
      <section class="card as-group" aria-labelledby="mj-patrons"><header class="as-group-head"><h3 id="mj-patrons">${icon("user-plus")}${t("admin.maint.patrons_title")}</h3><p>${t("admin.maint.patrons_desc")}</p></header>
        <form class="as-group-body stack" id="patrons-form" novalidate>
          ${field({ name: "file", label: t("admin.maint.csv_file"), type: "file", required: true, help: t("admin.maint.patrons_help"), attrs: 'accept=".csv,text/csv"' })}
          <p class="small muted">${t("admin.maint.columns")} <code class="as-wrap-code">cardnumber, surname, firstname, email, phone, address, categorycode, branchcode, dateexpiry</code></p>
          <div><button class="btn primary" type="submit">${icon("user-plus")}${t("admin.maint.import_patrons")}</button></div><div id="patrons-result" aria-live="polite"></div></form></section>
      <section class="card as-group" aria-labelledby="mj-export"><header class="as-group-head"><h3 id="mj-export">${icon("download")}${t("admin.maint.export_title")}</h3><p>${t("admin.maint.export_desc")}</p></header>
        <div class="as-group-body as-links"><a class="btn" href="/api/v1/cataloging/export?fmt=xml" download>${icon("download")}${t("admin.maint.marcxml")}</a>
          <a class="btn" href="/api/v1/cataloging/export?fmt=mrc" download>${icon("download")}${t("admin.maint.marc21")}</a></div></section>
    </div>`;
  p.onclick = async (e) => {
    const b = e.target.closest("[data-job]");
    if (!b) return;
    const job = b.dataset.job;
    if (job === "nightly" && !(await confirmDialog(jobLabel("nightly"), t("admin.maint.nightly_confirm"), t("admin.maint.run_now"), false))) return;
    try {
      if (job === "nightly") {
        const s = await withBusy(b, () => api("/admin/jobs/nightly", { method: "POST" }));
        $("#mj-nightly-out", p).innerHTML = resultBox("ok", t("admin.maint.nightly_done"), [[t("admin.maint.courtesy"), num(s.courtesy)], [t("admin.maint.overdue"), num(s.overdue)],
          [t("admin.maint.holds_expired"), num(s.holds_expired)], [t("admin.maint.auto_renewed"), num(s.auto_renewed)], [t("admin.maint.anonymised"), num(s.anonymized)]]);
      } else {
        const s = await withBusy(b, () => api("/admin/jobs/reindex", { method: "POST" }));
        $("#mj-reindex-out", p).innerHTML = resultBox("ok", t("admin.maint.reindex_done"), [[t("admin.maint.indexed"), num(s.indexed)]]);
      }
    } catch { /* toasted */ }
  };
  for (const form of $$("#marc-form, #patrons-form", p)) {
    const v = wireValidation(form, { onSubmit: async () => {
      const file = $('input[type="file"]', form).files[0];
      const fd = new FormData();
      fd.append("file", file);
      if (form.id === "marc-form") {
        const s = await api(`/cataloging/import?${qs({ branch_id: form.elements.branch_id.value, item_type_id: form.elements.item_type_id.value })}`, { method: "POST", form: fd });
        $("#marc-result", p).innerHTML = resultBox(s.errors?.length ? "warn" : "ok", t("admin.maint.imported_file", { name: file.name }), [[t("admin.maint.records_read"), num(s.records)],
          [t("admin.maint.titles_created"), num(s.created)], [t("admin.maint.duplicates"), num(s.skipped_duplicates)], [t("admin.maint.items_created"), num(s.items)]], s.errors);
        toast(t("admin.maint.titles_imported", { count: s.created }), "success");
      } else {
        const s = await api("/admin/import/patrons", { method: "POST", form: fd });
        $("#patrons-result", p).innerHTML = resultBox(s.errors?.length ? "warn" : "ok", t("admin.maint.imported_file", { name: file.name }), [[t("admin.maint.patrons_created"), num(s.created)], [t("admin.maint.rows_skipped"), num(s.skipped)]], s.errors);
        toast(t("admin.maint.patrons_imported", { count: s.created }), "success");
      }
      $('input[type="file"]', form).value = "";
    } });
    form.addEventListener("submit", (e) => { e.preventDefault(); v.submit($('button[type="submit"]', form)); });
  }
}

// ================================================================== wiring

const RENDER = {
  profile: (p, alive) => renderSettings("profile", p, alive),
  policies: (p, alive) => renderSettings("policies", p, alive),
  notices: (p, alive) => renderSettings("notices", p, alive),
  integrations: (p, alive) => renderSettings("integrations", p, alive),
  branches: (p, alive) => renderEntity("branches", p, alive),
  "item-types": (p, alive) => renderEntity("item-types", p, alive),
  categories: (p, alive) => renderEntity("categories", p, alive),
  rules: renderRules,
  audit: renderAudit,
  maintenance: async (p) => renderMaintenance(p),
};

export default async function init() {
  if (!panel()) return; // access denied state is rendered by the server
  wireKit();
  $("#as-nav").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-section]");
    if (!a) return;
    e.preventDefault();
    navigate(a.dataset.section);
  });
  $("#as-jump").addEventListener("change", (e) => navigate(e.target.value));
  window.addEventListener("hashchange", () => route({ focus: true }));
  // Retry buttons in section error states (tables handle their own).
  document.addEventListener("click", (e) => { if (e.target.closest("#as-panel [data-retry]") && !e.target.closest(".dt")) route(); });
  try { await loadLookups(); } catch (err) { toast(err.message, "error"); }
  await route();
}
