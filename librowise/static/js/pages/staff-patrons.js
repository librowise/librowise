// Staff › Patrons — reference implementation of a LIST PAGE on the design system
// (page header, saved views, URL-backed filter bar, data table with sorting, selection, bulk actions,
// pagination, CSV export, empty/error states). Copy this structure when migrating other list pages.
import { $, BOOT, api, date, esc, html, icon, modal, money, num, parseDate, qs, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { avatar } from "/static/js/ui/avatar.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { activeFilters, savedViews, searchField, selectChip, urlState, wireFilterBar } from "/static/js/ui/filters.js";
import { field } from "/static/js/ui/form.js";
import { setCount } from "/static/js/ui/page-header.js";
import { statusPill } from "/static/js/ui/status.js";

// ---- forms shared with the patron detail page (staff-patron.js imports these)

/** Register / edit patron form body (for modal()). `lk` = /lookups, `p` = an existing patron (edit) or {} (new). */
export function patronForm(lk, p = {}) {
  const opts = (list) => list.map((x) => [x.id, x.name]);
  const isAdmin = BOOT.user?.role === "admin";
  const roles = ["patron", "librarian", "admin"].map((r) => [r, t(`ui.role.${r}`)]);
  const section = (title, body) => html`<fieldset class="pf-section"><legend>${title}</legend><div class="form-grid">${body}</div></fieldset>`;
  return html`<div class="pf-form">
    ${section(t("people.list.form.section_person"), html`
      ${field({ name: "first_name", id: "pf-fn", label: t("people.field.first_name"), value: p.first_name || "", required: true, attrs: 'autocomplete="off" maxlength="80"' })}
      ${field({ name: "last_name", id: "pf-ln", label: t("people.field.last_name"), value: p.last_name || "", required: true, attrs: 'autocomplete="off" maxlength="80"' })}
      ${field({ name: "email", id: "pf-em", label: t("people.field.email"), type: "email", value: p.email || "", optional: true, help: t("people.list.form.email_help") })}
      ${field({ name: "phone", id: "pf-ph", label: t("people.field.phone"), type: "tel", value: p.phone || "", optional: true, attrs: 'dir="ltr"' })}
      ${field({ name: "address", id: "pf-ad", label: t("people.field.address"), value: p.address || "", optional: true, span: 2 })}
      ${p.id ? "" : field({ name: "date_of_birth", id: "pf-dob", label: t("people.field.date_of_birth"), type: "date", optional: true })}`)}
    ${section(t("people.list.form.section_membership"), html`
      ${field({ name: "category_id", id: "pf-cat", label: t("people.field.category"), as: "select", required: true, options: opts(lk.categories || []), value: p.category?.id ?? "" })}
      ${field({ name: "home_branch_id", id: "pf-br", label: t("people.field.home_branch"), as: "select", required: true, options: opts(lk.branches || []), value: p.home_branch?.id ?? BOOT.user?.home_branch_id ?? "" })}
      ${p.id ? "" : field({ name: "card_number", id: "pf-card", label: t("people.field.card_number"), optional: true, placeholder: t("people.list.form.card_placeholder"),
        help: t("people.list.form.card_help"), attrs: `pattern="[A-Za-z0-9-]*" maxlength="32" dir="ltr" title="${esc(t("people.list.form.card_pattern"))}"` })}
      ${field({ name: "expires_on", id: "pf-exp", label: t("people.field.expires_on"), type: "date", value: p.expires_on || "", optional: true, help: t("people.list.form.expires_help") })}`)}
    ${section(t("people.list.form.section_account"), html`
      ${isAdmin ? field({ name: "role", id: "pf-role", label: t("people.field.role"), as: "select", options: roles, value: p.role || "patron", help: t("people.list.form.role_help") }) : ""}
      ${field({ name: "password", id: "pf-pw", label: p.id ? t("people.list.form.reset_password") : t("people.field.password"), type: "password", optional: true,
        help: t("people.list.form.password_help"), attrs: 'autocomplete="new-password" minlength="10"' })}
      ${field({ name: "notes", id: "pf-no", label: t("people.list.form.notes"), value: p.notes || "", optional: true, span: 2, help: t("people.list.form.notes_help") })}`)}
  </div>`;
}

export function patronPayload(fd, isNew) {
  const d = Object.fromEntries([...fd].map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === "" && !isNew && ["email", "phone", "address", "notes", "expires_on"].includes(k)) out[k] = null;
    else if (v !== "") out[k] = ["category_id", "home_branch_id"].includes(k) ? +v : v;
  }
  return out;
}

// ---- list page

const FILTERS = ["q", "status", "category_id", "branch_id", "role"];
const state = urlState({ q: "", status: "", category_id: "", branch_id: "", role: "", sort: "name", page: 1, per_page: 25 });
const DAY = 86400000;

function membership(p) {
  if (!p.expires_on) return "—";
  const days = (parseDate(p.expires_on) - Date.now()) / DAY;
  if (days < 0) return statusPill("patron", "expired", t("ui.patrons.expired_on", { date: date(p.expires_on) }));
  if (days <= 30) return statusPill("patron", "expiring", t("ui.patrons.expires_on", { date: date(p.expires_on) }));
  return html`<span class="num">${date(p.expires_on)}</span>`;
}

function columns() {
  return [
    { key: "name", label: t("ui.patrons.col_name"), sortable: true, primary: true, hideable: false, csv: (p) => p.full_name,
      render: (p) => html`<div class="dt-person">${avatar(p.full_name)}<div class="dt-cell-stack">
        <a href="/staff/patrons/${p.id}">${p.full_name}</a><span class="sub">${p.email || p.phone || ""}</span></div>
        ${p.role !== "patron" ? statusPill("patron", "staff", t(`ui.role.${p.role}`)) : ""}${p.is_active ? "" : statusPill("patron", "inactive")}</div>` },
    { key: "card", label: t("ui.patrons.col_card"), sortable: true, csv: (p) => p.card_number, render: (p) => html`<span class="mono small">${p.card_number}</span>` },
    { key: "category", label: t("ui.patrons.col_category"), csv: (p) => p.category.name, render: (p) => p.category.name },
    { key: "branch", label: t("ui.patrons.col_branch"), csv: (p) => p.home_branch.name, render: (p) => p.home_branch.name },
    { key: "loans", label: t("ui.patrons.col_loans"), align: "num", csv: (p) => p.open_loans,
      render: (p) => (p.overdue_loans ? html`<span class="pl-loans">${num(p.open_loans)} ${statusPill("loan", "overdue", t("people.list.overdue_count", { count: p.overdue_loans }))}</span>` : num(p.open_loans)) },
    { key: "balance", label: t("ui.patrons.col_balance"), align: "num", csv: (p) => p.balance,
      render: (p) => (p.balance > 0 ? html`<span class="pl-owing">${money(p.balance)}</span>` : html`<span class="muted">${money(0)}</span>`) },
    { key: "expires", label: t("ui.patrons.col_expires"), sortable: true, csv: (p) => p.expires_on || "", render: membership },
    { key: "email", label: t("ui.patrons.col_email"), hidden: true, csv: (p) => p.email || "", render: (p) => p.email || "—" },
    { key: "phone", label: t("ui.patrons.col_phone"), hidden: true, csv: (p) => p.phone || "", render: (p) => p.phone || "—" },
    { key: "created", label: t("ui.patrons.col_created"), hidden: true, sortable: true, sortDir: "desc", csv: (p) => p.created_at || "",
      render: (p) => (p.created_at ? date(p.created_at) : "—") },
  ];
}

function params(s) {
  return { q: s.q, status: s.status, category_id: s.category_id, branch_id: s.branch_id, role: s.role, sort: s.sort, page: s.page, per_page: s.per_page };
}

export default async function init() {
  const lk = await api("/lookups");
  const s0 = state.get();
  const statusOpts = [["", t("ui.patrons.any_status")], ["active", t("ui.status.active")], ["overdue", t("people.list.status_overdue")],
    ["expiring", t("ui.status.expiring")], ["expired", t("status.expired")], ["owing", t("ui.status.owing")], ["inactive", t("ui.status.inactive")]];
  const roleOpts = [["", t("ui.patrons.any_role")], ["patron", t("ui.role.patron")], ["staff", t("ui.patrons.staff_only")],
    ["librarian", t("ui.role.librarian")], ["admin", t("ui.role.admin")]];
  const catOpts = [["", t("ui.patrons.any_category")], ...lk.categories.map((c) => [String(c.id), c.name])];
  const brOpts = [["", t("common.all_branches")], ...lk.branches.map((b) => [String(b.id), b.name])];
  const label = { status: t("ui.patrons.col_status"), role: t("ui.patrons.col_role"), category_id: t("ui.patrons.col_category"),
    branch_id: t("ui.patrons.col_branch"), q: t("common.search") };
  const optLabel = { status: statusOpts, role: roleOpts, category_id: catOpts, branch_id: brOpts };

  $("#p-filter-row").innerHTML = html`
    ${searchField({ name: "q", label: t("ui.patrons.search_label"), value: s0.q, placeholder: t("ui.patrons.search_placeholder") })}
    ${selectChip({ name: "status", label: label.status, value: s0.status, options: statusOpts })}
    ${selectChip({ name: "category_id", label: label.category_id, value: s0.category_id, options: catOpts })}
    ${selectChip({ name: "branch_id", label: label.branch_id, value: s0.branch_id, options: brOpts })}
    ${selectChip({ name: "role", label: label.role, value: s0.role, options: roleOpts })}`;

  const views = savedViews($("#p-views"), {
    id: "patrons", keys: FILTERS, current: () => state.get(),
    presets: [
      { id: "all", label: t("ui.patrons.view_all"), params: {} },
      { id: "overdue", label: t("people.list.view_overdue"), params: { status: "overdue" } },
      { id: "expiring", label: t("ui.patrons.view_expiring"), params: { status: "expiring" } },
      { id: "expired", label: t("ui.patrons.view_expired"), params: { status: "expired" } },
      { id: "owing", label: t("ui.patrons.view_owing"), params: { status: "owing" } },
      { id: "staff", label: t("ui.patrons.view_staff"), params: { role: "staff" } },
    ],
    onSelect: (p) => apply(p, true),
  });

  const chips = () => {
    const s = state.get();
    const list = FILTERS.filter((k) => s[k]).map((k) => ({ key: k, label: label[k],
      value: k === "q" ? `“${s.q}”` : (optLabel[k].find(([v]) => v === String(s[k]))?.[1] || s[k]) }));
    $("#p-chips").innerHTML = activeFilters(list);
  };

  const table = dataTable($("#p-table"), {
    id: "patrons", caption: t("ui.patrons.title"), columns: columns(), selectable: true,
    rowHref: (p) => `/staff/patrons/${p.id}`, rowLabel: (p) => p.full_name,
    sort: { key: s0.sort.replace(/^-/, ""), dir: s0.sort.startsWith("-") ? "desc" : "asc" },
    perPage: s0.per_page, perPageOptions: [25, 50, 100],
    onSort: (srt) => apply({ sort: srt.dir === "desc" ? `-${srt.key}` : srt.key, page: 1 }),
    onPage: ({ page, perPage }) => apply({ page, per_page: perPage }),
    exportName: "patrons",
    exportAll: async () => {
      const s = state.get(), out = [];
      for (let page = 1; page <= 20; page++) {
        const r = await api(`/patrons?${qs({ ...params(s), page, per_page: 200 })}`);
        out.push(...r.results);
        if (out.length >= r.total) break;
      }
      return out;
    },
    empty: {
      art: "people", title: t("ui.patrons.empty_title"), body: t("ui.patrons.empty_body"),
      actions: html`<button type="button" class="btn" data-clear-filters>${t("ui.filters.clear_all")}</button>
        <button type="button" class="btn primary" data-register>${icon("user-plus")}${t("ui.patrons.register")}</button>`,
    },
    bulkActions: [
      { id: "renew", label: t("ui.patrons.bulk_renew"), icon: "refresh", run: renew },
      { id: "cards", label: t("ui.patrons.bulk_cards"), icon: "printer", run: (rows) => {
        window.open(`/staff/labels/print?${qs({ kind: "patron", patron_ids: rows.map((p) => p.id).join(",") })}`, "_blank", "noopener");
      } },
      { id: "export", label: t("ui.patrons.bulk_export"), icon: "download", run: () => $("[data-export]", table.el).click() },
    ],
  });

  async function renew(rows, ctx) {
    const fd = await modal({ title: t("ui.patrons.renew_title", { count: rows.length }), submit: t("ui.patrons.bulk_renew"), size: "sm",
      body: html`<p>${t("ui.patrons.renew_body")}</p>` });
    if (!fd) return;
    await withBusy(ctx.button, async () => {
      const before = new Map(rows.map((p) => [p.id, p.expires_on]));
      const r = await api("/patrons/renew", { method: "POST", body: { ids: rows.map((p) => p.id) } });
      const updated = new Map(r.renewed.map((x) => [x.id, x.expires_on]));
      table.updateRows((p) => (updated.has(p.id) ? { ...p, expires_on: updated.get(p.id) } : p));
      ctx.clear();
      const msg = r.skipped.length ? t("ui.patrons.renewed_some", { count: r.renewed.length, skipped: r.skipped.length })
        : t("ui.patrons.renewed", { count: r.renewed.length });
      // Undo restores each patron's previous expiry date.
      toast(msg, "success", { action: { label: t("ui.undo"), run: async () => {
        await Promise.all(r.renewed.map((x) => api(`/patrons/${x.id}`, { method: "PATCH", body: { expires_on: before.get(x.id) || null } })));
        table.updateRows((p) => (before.has(p.id) && updated.has(p.id) ? { ...p, expires_on: before.get(p.id) } : p));
        toast(t("ui.patrons.renew_undone"), "info");
      } } });
    });
  }

  let firstLoad = true;
  async function load() {
    const s = state.get();
    table.setLoading();
    try {
      const r = await api(`/patrons?${qs(params(s))}`);
      // Scanning a card (or arriving from global search) with exactly one match opens the patron directly.
      if (firstLoad && r.total === 1 && s.q && !FILTERS.slice(1).some((k) => s[k])) { location.replace(`/staff/patrons/${r.results[0].id}`); return; }
      table.setRows(r.results, { total: r.total, page: s.page, perPage: s.per_page });
      setCount(r.total);
    } catch (e) {
      table.setError(e, load);
    } finally {
      firstLoad = false;
    }
  }

  function apply(changes, syncInputs = false) {
    const resetPage = Object.keys(changes).some((k) => FILTERS.includes(k));
    state.set({ ...changes, ...(resetPage ? { page: 1 } : {}) });
    if (syncInputs) {
      const s = state.get();
      for (const k of FILTERS) {
        const el = $(`#p-filter-row [name="${k}"]`);
        if (el) { el.value = s[k]; el.closest(".select-chip")?.classList.toggle("active", !!s[k]); }
      }
      const clear = $("#p-filter-row [data-clear]");
      if (clear) clear.hidden = !s.q;
    }
    chips();
    views.render();
    load();
  }

  wireFilterBar($("#p-filters"), (c) => apply(c, true), { keys: FILTERS });
  $("#p-table").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-filters]")) apply(Object.fromEntries(FILTERS.map((k) => [k, ""])), true);
    if (e.target.closest("[data-register]")) register();
  });

  const register = async () => {
    const fd = await modal({ title: t("ui.patrons.register"), body: patronForm(lk), submit: t("ui.patrons.register_submit"), size: "lg" });
    if (!fd) return;
    try {
      const p = await api("/patrons", { method: "POST", body: patronPayload(fd, true) });
      toast(t("ui.patrons.registered", { name: p.full_name, card: p.card_number }), "success", 7000);
      location.href = `/staff/patrons/${p.id}`;
    } catch (e) { toast(e.message, "error"); }
  };
  $("#new-patron").addEventListener("click", register);
  if (location.hash === "#new") register();

  chips();
  load();
}

