// Staff › Administration › Roles & permissions — custom staff roles (cards + grouped permission editor),
// staff accounts, per-user access (effective permissions, security actions, sign-in history) and single sign-on.
// Hashes: #roles #staff #user #user-<id> #sso.
import { $, $$, api, datetime, html, icon, num, relative, toast, withBusy } from "/static/js/core.js";
import { locale, t } from "/static/js/i18n.js";
import { device } from "/static/js/security-panel.js";
import { avatar } from "/static/js/ui/avatar.js";
import { combobox, highlight } from "/static/js/ui/combobox.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { confirmDestructive, confirmDialog } from "/static/js/ui/dialog.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { field } from "/static/js/ui/form.js";
import { sidePanel } from "/static/js/ui/panel.js";
import { wireTabsPanel } from "/static/js/ui/tabs.js";
import { copyButton, dl, pill, rowMenu, wireKit } from "/static/js/pages/lib/admin-kit.js";
import { editDialog, switchField } from "/static/js/pages/lib/settings-ui.js";

const state = { me: null, catalogue: null, roles: [], staff: [], sso: [], userId: null, tab: "roles" };
const can = (perm) => !!state.me && (state.me.permissions.includes("*") || state.me.permissions.includes(perm));

// ------------------------------------------------------------------ vocabulary

const permKey = (code) => code.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
const permLabel = (p) => t(`admin.roles.perm.${permKey(p.code)}`, {}, p.description);
const groupKey = (g) => g.toLowerCase().replace(/[^a-z]+/g, "_");
const groupLabel = (g) => t(`admin.roles.group.${groupKey(g)}`, {}, g);
const roleLabel = (r) => t(`ui.role.${r}`, {}, r);
const rolePill = (r) => pill(r === "admin" ? "ai" : r === "librarian" ? "info" : "neutral", roleLabel(r));
function sourcePill(s) {
  if (s.startsWith("custom:")) return pill("ai", t("admin.roles.source_custom", { name: s.slice(7) }));
  return pill("info", t("admin.roles.source_builtin", { role: roleLabel(s.replace(/^role:/, "")) }));
}
const allPerms = () => state.catalogue.groups.flatMap((g) => g.permissions);

function denied(perm) {
  return emptyState({ art: "error", title: t("admin.roles.no_permission_title"), body: t("admin.roles.no_permission", { permission: perm }) });
}

// ------------------------------------------------------------------ roles

function permissionPicker(selected = []) {
  const sel = new Set(selected);
  const mine = new Set(state.me.permissions);
  const everything = mine.has("*");
  return html`<div class="as-perm-picker">
    <div class="as-perm-tools">
      <div class="search-field"><label class="sr-only" for="perm-filter">${t("admin.roles.filter_permissions")}</label>${icon("search")}
        <input id="perm-filter" type="search" placeholder="${t("admin.roles.filter_permissions")}" autocomplete="off" data-perm-filter></div>
      <span class="small muted" data-perm-count aria-live="polite"></span>
    </div>
    <div class="as-perm-groups">${state.catalogue.groups.map((g) => html`<fieldset class="as-perm-group" data-group>
      <legend><label class="checkbox"><input type="checkbox" data-group-toggle aria-describedby="pg-${groupKey(g.group)}-n"> ${groupLabel(g.group)}</label>
        <span class="small muted" id="pg-${groupKey(g.group)}-n" data-group-count></span></legend>
      <div class="as-perm-list">${g.permissions.map((p) => {
        const grantable = everything || mine.has(p.code);
        return html`<label class="as-perm ${grantable ? "" : "is-locked"}" data-search="${`${p.code} ${permLabel(p)} ${p.description}`.toLowerCase()}">
          <input type="checkbox" name="perm" value="${p.code}" ${sel.has(p.code) ? "checked" : ""} ${grantable ? "" : "disabled"}>
          <span><span class="as-perm-name">${permLabel(p)}</span><code class="as-key">${p.code}</code>${grantable ? "" : html`<span class="as-perm-note">${t("admin.roles.cannot_grant")}</span>`}</span></label>`;
      })}</div></fieldset>`)}</div></div>`;
}

function wirePicker(root) {
  const sync = () => {
    for (const fs of $$("[data-group]", root)) {
      const boxes = $$('input[name="perm"]', fs);
      const on = boxes.filter((b) => b.checked).length;
      const toggle = $("[data-group-toggle]", fs);
      toggle.checked = on === boxes.length;
      toggle.indeterminate = on > 0 && on < boxes.length;
      toggle.disabled = boxes.every((b) => b.disabled);
      $("[data-group-count]", fs).textContent = t("admin.roles.n_of_m", { n: num(on), m: num(boxes.length) });
    }
    $("[data-perm-count]", root).textContent = t("admin.roles.selected_n", { count: $$('input[name="perm"]:checked', root).length });
  };
  root.addEventListener("change", (e) => {
    if (e.target.matches("[data-group-toggle]")) {
      const fs = e.target.closest("[data-group]");
      const boxes = $$('input[name="perm"]:not(:disabled)', fs).filter((b) => !b.closest("label").hidden);
      const on = e.target.checked;
      boxes.forEach((b) => { b.checked = on; });
    }
    sync();
  });
  $("[data-perm-filter]", root).addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const fs of $$("[data-group]", root)) {
      let any = false;
      for (const l of $$("label.as-perm", fs)) { l.hidden = !!q && !l.dataset.search.includes(q); any ||= !l.hidden; }
      fs.hidden = !any;
    }
  });
  // Enter in the filter must not submit the dialog.
  $("[data-perm-filter]", root).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); } });
  sync();
}

async function roleEditor(role) {
  return editDialog({
    title: role ? t("admin.roles.edit_title", { name: role.name }) : t("admin.roles.new_title"),
    submit: role ? t("admin.common.save_changes") : t("admin.roles.create"), size: "lg",
    body: html`<div class="stack"><div class="form-grid">
        ${field({ name: "name", label: t("admin.roles.f.name"), value: role?.name || "", required: true, attrs: 'minlength="2" maxlength="80" autocomplete="off"', help: t("admin.roles.f.name_help") })}
        ${field({ name: "description", label: t("admin.roles.f.description"), value: role?.description || "", optional: true, attrs: 'maxlength="255" autocomplete="off"' })}</div>
      <p class="small muted as-note">${icon("info")}<span>${t("admin.roles.additive_note")}</span></p>
      ${permissionPicker(role?.permissions || [])}</div>`,
    onOpen: (dlg) => wirePicker($(".as-perm-picker", dlg)),
    onSubmit: (d, form) => {
      const body = { name: d.name.trim(), description: d.description.trim() || null, permissions: $$('input[name="perm"]:checked', form).map((i) => i.value) };
      return role ? api(`/admin/roles/${role.id}`, { method: "PUT", body }) : api("/admin/roles", { method: "POST", body });
    },
  });
}

function showBuiltin(key) {
  const perms = state.catalogue.builtin_roles[key] || [];
  const all = perms.includes("*");
  const set = new Set(perms);
  sidePanel({
    title: roleLabel(key), subtitle: t("admin.roles.builtin"),
    body: all ? html`<div class="alert info">${icon("shield")}<div>${t("admin.roles.everything")}</div></div>`
      : html`<div class="stack">${state.catalogue.groups.filter((g) => g.permissions.some((p) => set.has(p.code))).map((g) => html`<section class="as-detail-block">
          <h3>${groupLabel(g.group)}</h3><ul class="as-perm-readonly">${g.permissions.filter((p) => set.has(p.code)).map((p) => html`<li>${icon("check", "as-ok")}<span>${permLabel(p)}</span></li>`)}</ul></section>`)}</div>`,
  });
}

function roleCard(r) {
  const n = r.permissions.length;
  const groups = state.catalogue.groups.filter((g) => g.permissions.some((p) => r.permissions.includes(p.code))).map((g) => groupLabel(g.group));
  return html`<article class="card as-role-card" data-role="${r.id}">
    <header><div class="as-role-title"><h3>${r.name}</h3>${rowMenu({ label: r.name, items: [
      { id: "edit", label: t("admin.common.edit"), icon: "edit" }, { id: "delete", label: t("admin.common.delete"), icon: "trash", danger: true }] })}</div>
      <p class="small muted">${r.description || t("admin.roles.no_description")}</p></header>
    <div class="as-role-stats">${pill("ai", t("admin.roles.n_permissions", { count: n }), { dot: false })}${pill("neutral", t("admin.roles.n_members", { count: r.members || 0 }), { dot: false })}</div>
    <p class="small as-role-groups">${groups.length ? groups.join(" · ") : html`<span class="muted">${t("admin.roles.no_permissions")}</span>`}</p>
    <footer class="small muted">${t("admin.roles.updated", { when: relative(r.updated_at) })}
      <button type="button" class="btn sm" data-edit-role>${icon("edit")}${t("admin.roles.edit_permissions")}</button></footer></article>`;
}

async function renderRoles(panel) {
  const { results } = await api("/admin/roles");
  state.roles = results;
  const builtin = Object.keys(state.catalogue.builtin_roles);
  panel.innerHTML = html`<div class="as-tab-head"><p class="muted">${t("admin.roles.roles_intro")}</p>
      <button type="button" class="btn primary" data-new-role>${icon("plus")}${t("admin.roles.new_role")}</button></div>
    <h2 class="as-subhead">${t("admin.roles.custom_heading")}</h2>
    ${results.length ? html`<div class="as-role-grid">${results.map(roleCard)}</div>`
      : html`<div class="card">${emptyState({ art: "people", title: t("admin.roles.empty_title"), body: t("admin.roles.empty_body"),
          actions: html`<button type="button" class="btn" data-new-role>${icon("plus")}${t("admin.roles.new_role")}</button>` })}</div>`}
    <h2 class="as-subhead">${t("admin.roles.builtin_heading")}</h2>
    <div class="as-role-grid">${builtin.map((k) => {
      const perms = state.catalogue.builtin_roles[k];
      return html`<article class="card as-role-card is-builtin"><header><div class="as-role-title"><h3>${roleLabel(k)}</h3>${pill("neutral", t("admin.roles.builtin"), { dot: false })}</div>
        <p class="small muted">${t(`admin.roles.builtin_desc.${k}`, {}, "")}</p></header>
        <div class="as-role-stats">${perms.includes("*") ? pill("ai", t("admin.roles.all_permissions"), { dot: false }) : pill("info", t("admin.roles.n_permissions", { count: perms.length }), { dot: false })}</div>
        <footer><button type="button" class="btn sm ghost" data-builtin="${k}">${icon("list")}${t("admin.roles.view_permissions")}</button></footer></article>`;
    })}</div>`;
}

async function onRolesAction(e) {
  if (e.target.closest("[data-new-role]")) {
    const r = await roleEditor(null);
    if (r) { toast(t("admin.roles.created", { name: r.name }), "success"); await show("roles"); }
    return;
  }
  const b = e.target.closest("[data-builtin]");
  if (b) { showBuiltin(b.dataset.builtin); return; }
  const ed = e.target.closest("[data-edit-role]");
  if (ed) await editRole(Number(ed.closest("[data-role]").dataset.role));
}

async function editRole(id) {
  const role = state.roles.find((r) => r.id === id);
  if (!role) return;
  const r = await roleEditor(role);
  if (r) { toast(t("admin.common.saved_named", { name: r.name }), "success"); await show("roles"); }
}

async function deleteRole(id) {
  const role = state.roles.find((r) => r.id === id);
  if (!role) return;
  const ok = await confirmDestructive({ title: t("admin.roles.delete_title", { name: role.name }),
    text: t("admin.roles.delete_text", { count: role.members || 0, name: role.name }), word: role.name, submit: t("admin.roles.delete") });
  if (!ok) return;
  try {
    await api(`/admin/roles/${role.id}`, { method: "DELETE" });
    toast(t("admin.common.deleted_named", { name: role.name }), "success");
    await show("roles");
  } catch (err) { toast(err.message, "error"); }
}

// ------------------------------------------------------------------ staff accounts

function roleSelect(p, id) {
  return html`<label class="sr-only" for="${id}">${t("admin.roles.custom_role_for", { name: p.full_name })}</label>
    <select id="${id}" class="as-compact-select" data-assign="${p.id}"><option value="">${t("admin.roles.no_custom_role")}</option>
      ${state.roles.map((r) => html`<option value="${r.id}" ${p.staff_role?.id === r.id ? "selected" : ""}>${r.name}</option>`)}</select>`;
}

async function renderStaff(panel) {
  const [{ results }, roles] = await Promise.all([api("/admin/staff"), api("/admin/roles")]);
  state.staff = results;
  state.roles = roles.results;
  panel.innerHTML = html`<div class="as-tab-head"><p class="muted">${t("admin.roles.staff_intro")}</p></div><div id="as-staff-table"></div>`;
  const table = dataTable($("#as-staff-table", panel), {
    id: "admin-staff", caption: t("admin.roles.tab.staff"), rowKey: (p) => p.id, rowLabel: (p) => p.full_name,
    columns: [
      { key: "name", label: t("admin.roles.col.name"), primary: true, hideable: false, sortable: true, csv: (p) => p.full_name,
        render: (p) => html`<div class="dt-person">${avatar(p.full_name, { size: "sm" })}<div class="dt-cell-stack"><button type="button" class="link-btn as-row-title" data-open-user>${p.full_name}</button>
          <span class="sub mono">${p.card_number}</span></div></div>` },
      { key: "role", label: t("admin.roles.col.builtin"), sortable: true, csv: (p) => roleLabel(p.role), render: (p) => rolePill(p.role) },
      { key: "staff_role", label: t("admin.roles.col.custom"), csv: (p) => p.staff_role?.name || "", render: (p) => roleSelect(p, `sr-${p.id}`) },
      { key: "mfa", label: t("admin.roles.col.mfa"), csv: (p) => (p.mfa_enabled ? t("admin.common.on") : t("admin.common.off")),
        render: (p) => (p.mfa_enabled ? pill("success", t("admin.roles.mfa_on")) : pill("warning", t("admin.roles.mfa_off"))) },
      { key: "status", label: t("admin.roles.col.status"), csv: (p) => (p.locked ? "locked" : p.is_active ? "active" : "inactive"),
        render: (p) => (p.locked ? pill("danger", t("admin.roles.locked")) : p.is_active ? pill("success", t("admin.roles.active")) : pill("neutral", t("admin.roles.inactive"))) },
      { key: "last_login_at", label: t("admin.roles.col.last_sign_in"), sortable: true, sortDir: "desc", csv: (p) => p.last_login_at || "",
        render: (p) => (p.last_login_at ? html`<span title="${datetime(p.last_login_at)}">${relative(p.last_login_at)}</span>` : html`<span class="muted">${t("admin.common.never")}</span>`) },
      { key: "actions", label: t("admin.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "as-cell-actions", headClass: "as-cell-actions",
        render: (p) => rowMenu({ label: p.full_name, items: [
          { id: "access", label: t("admin.roles.open_access"), icon: "shield" },
          { id: "patron", label: t("admin.roles.open_patron"), icon: "user", href: `/staff/patrons/${p.id}` }] }) },
    ],
    sort: { key: "name", dir: "asc" }, exportName: "librowise-staff",
    onSort: (s) => {
      const dir = s.dir === "desc" ? -1 : 1;
      const val = (p) => (s.key === "name" ? p.full_name : s.key === "role" ? roleLabel(p.role) : p.last_login_at || "");
      table.setRows([...state.staff].sort((a, b) => String(val(a)).localeCompare(String(val(b)), locale) * dir));
    },
    empty: { art: "people", title: t("admin.roles.staff_empty"), body: t("admin.roles.staff_intro") },
  });
  table.setRows(results);
}

// ------------------------------------------------------------------ user access

function renderUserShell(panel) {
  panel.innerHTML = html`<div class="card as-user-pick">
      <div class="field"><label for="ua-search">${t("admin.roles.find_account")}</label>
        <input id="ua-search" type="search" placeholder="${t("admin.roles.find_placeholder")}" autocomplete="off" aria-describedby="ua-search-help">
        <div class="field-help" id="ua-search-help">${t("admin.roles.find_help")}</div></div></div>
    <div id="ua-body" aria-live="polite">${state.userId ? html`<div class="card as-sk-card" aria-hidden="true">${Array.from({ length: 6 }, () => html`<div class="skeleton sk-line"></div>`)}</div>`
      : html`<div class="card">${emptyState({ art: "search", title: t("admin.roles.pick_title"), body: t("admin.roles.pick_body"),
          actions: html`<button type="button" class="btn" data-goto-staff>${icon("users")}${t("admin.roles.browse_staff")}</button>` })}</div>`}</div>`;
  combobox($("#ua-search", panel), {
    minChars: 2,
    source: async (q) => (await api(`/patrons?${new URLSearchParams({ q, per_page: 8 })}`)).results,
    render: (p, q) => html`${avatar(p.full_name, { size: "xs" })}<span class="grow">${highlight(p.full_name, q)} <span class="sub mono">${p.card_number}</span></span>${p.role !== "patron" ? rolePill(p.role) : ""}`,
    value: (p) => p.full_name,
    onSelect: (p) => { state.userId = p.id; history.replaceState(null, "", `#user-${p.id}`); loadUser(p.id); },
  });
  if (state.userId) loadUser(state.userId);
}

function securityActions(a) {
  const btn = (action, ic, label, tone = "") => html`<button type="button" class="btn sm ${tone}" data-user-action="${action}">${icon(ic)}${label}</button>`;
  return html`<div class="as-sec-actions">
    ${a.mfa.enabled ? btn("mfa/reset", "key", t("admin.roles.act.reset_mfa")) : ""}
    ${btn("sessions/revoke", "logout", t("admin.roles.act.sign_out"))}
    ${a.api_tokens ? btn("api-tokens/revoke", "x-circle", t("admin.roles.act.revoke_tokens")) : ""}
    ${a.locked_until ? btn("unlock", "check-circle", t("admin.roles.act.unlock")) : ""}</div>`;
}

function renderAccess(a, logins) {
  const byCode = Object.fromEntries(a.effective_permissions.map((p) => [p.code, p.sources]));
  const everything = "*" in byCode;
  const granted = everything ? allPerms().length : a.effective_permissions.length;
  const ids = a.identities.length ? a.identities.map((i) => `${i.provider}${i.email ? ` (${i.email})` : ""}`).join(", ") : null;
  return html`<div class="as-access-grid">
    <section class="card as-group" aria-labelledby="ua-h">
      <div class="as-person">${avatar(a.full_name, { size: "lg" })}<div class="grow"><h2 id="ua-h">${a.full_name}</h2>
        <p class="small muted"><span class="mono">${a.card_number}</span>${a.email ? ` · ${a.email}` : ""}</p>
        <div class="as-pills">${rolePill(a.role)}${a.staff_role ? pill("ai", a.staff_role.name) : ""}${a.is_active ? "" : pill("neutral", t("admin.roles.inactive"))}</div></div>
        <a class="btn sm ghost" href="/staff/patrons/${a.id}">${icon("user")}${t("admin.roles.open_patron")}</a></div>
      <div class="as-group-body">
        ${can("patrons:manage_staff") ? html`<div class="field as-inline-field"><label for="ua-role">${t("admin.roles.col.custom")}</label>${roleSelectFor(a)}</div>` : ""}
        ${dl([
          [t("admin.roles.mfa"), a.mfa.enabled ? pill("success", t("admin.roles.mfa_on_codes", { count: a.mfa.recovery_codes_remaining })) : pill("warning", t("admin.roles.mfa_off"))],
          [t("admin.roles.sessions"), num(a.active_sessions)],
          [t("admin.roles.api_tokens"), num(a.api_tokens)],
          [t("admin.roles.linked"), ids],
          [t("admin.roles.col.last_sign_in"), a.last_login_at ? html`${relative(a.last_login_at)} <span class="muted">(${datetime(a.last_login_at)})</span>` : t("admin.common.never")],
          [t("admin.roles.lockout"), a.locked_until ? pill("danger", t("admin.roles.locked_until", { when: datetime(a.locked_until) })) : t("admin.roles.failed_attempts", { count: a.failed_logins })],
        ])}
        <h3 class="as-mini-head">${t("admin.roles.security_actions")}</h3>${securityActions(a)}</div></section>
    <section class="card as-group" aria-labelledby="ua-perm-h">
      <header class="as-group-head"><h3 id="ua-perm-h">${t("admin.roles.effective")}</h3><p>${everything ? t("admin.roles.everything") : t("admin.roles.effective_n", { count: granted })}</p></header>
      <div class="as-group-body as-eff">${state.catalogue.groups.map((g) => {
        const rows = g.permissions.map((p) => ({ p, src: everything ? ["*"] : byCode[p.code] }));
        const on = rows.filter((r) => r.src).length;
        return html`<details class="as-eff-group" ${on ? "open" : ""}><summary><span>${groupLabel(g.group)}</span><span class="small muted">${t("admin.roles.n_of_m", { n: num(on), m: num(rows.length) })}</span></summary>
          <ul>${rows.map(({ p, src }) => html`<li class="${src ? "is-on" : "is-off"}">${icon(src ? "check" : "x", src ? "as-ok" : "as-off")}<span class="grow">${permLabel(p)}
            <span class="sr-only">${src ? t("admin.roles.granted") : t("admin.roles.not_granted")}</span></span>
            ${src ? html`<span class="as-pills">${everything ? pill("ai", roleLabel("admin"), { dot: false }) : src.map(sourcePill)}</span>` : ""}</li>`)}</ul></details>`;
      })}</div></section>
  </div>
  <section class="card as-group" aria-labelledby="ua-log-h"><header class="as-group-head"><h3 id="ua-log-h">${t("admin.roles.history")}</h3><p>${t("admin.roles.history_desc")}</p></header>
    <div id="ua-logins" class="as-group-body"></div></section>`;
}

function roleSelectFor(a) {
  return html`<select id="ua-role" class="as-compact-select" data-assign="${a.id}"><option value="">${t("admin.roles.no_custom_role")}</option>
    ${state.roles.map((r) => html`<option value="${r.id}" ${a.staff_role?.id === r.id ? "selected" : ""}>${r.name}</option>`)}</select>`;
}

const methodText = (m) => {
  const map = { password: "password", "password+totp": "totp", "password+recovery": "recovery", password_reset: "reset", password_change: "change", "2fa": "second" };
  if (map[m]) return t(`admin.roles.method.${map[m]}`);
  const sso = /^sso:([^+]+)/.exec(m || "");
  return sso ? t("admin.roles.method.sso", { provider: sso[1] }) : m || "—";
};

async function loadUser(id) {
  const box = $("#ua-body");
  if (!box) return;
  box.innerHTML = html`<div class="card as-sk-card" aria-hidden="true">${Array.from({ length: 6 }, () => html`<div class="skeleton sk-line"></div>`)}</div>`;
  try {
    if (!state.roles.length && can("patrons:manage_staff")) state.roles = (await api("/admin/roles")).results;
    const [a, logins] = await Promise.all([api(`/admin/users/${id}/access`), api(`/admin/users/${id}/logins`)]);
    state.access = a;
    box.innerHTML = renderAccess(a, logins.results);
    const table = dataTable($("#ua-logins", box), {
      id: "admin-user-logins", caption: t("admin.roles.history"), rowKey: (e) => e.id,
      columns: [
        { key: "at", label: t("admin.roles.col.when"), primary: true, csv: (e) => e.at, render: (e) => html`<span title="${datetime(e.at)}">${datetime(e.at)}</span>` },
        { key: "result", label: t("admin.roles.col.result"), csv: (e) => (e.success ? "success" : e.reason || "failed"),
          render: (e) => (e.success ? pill("success", t("admin.roles.signin_ok")) : pill("danger", e.reason ? t("admin.roles.signin_failed_reason", { reason: e.reason.replace(/_/g, " ") }) : t("admin.roles.signin_failed"))) },
        { key: "method", label: t("admin.roles.col.method"), csv: (e) => e.method, render: (e) => methodText(e.method) },
        { key: "ip", label: t("admin.roles.col.ip"), csv: (e) => e.ip || "", render: (e) => (e.ip ? html`<span class="mono small">${e.ip}</span>` : "—") },
        { key: "device", label: t("admin.roles.col.device"), csv: (e) => device(e.user_agent), render: (e) => device(e.user_agent) },
      ],
      exportName: "librowise-sign-ins", empty: { art: "inbox", title: t("admin.roles.no_history"), body: "" },
    });
    table.setRows(logins.results);
  } catch (e) {
    box.innerHTML = html`<div class="card">${e.status === 403 ? denied("patrons:manage_staff") : errorState(e, { retry: false })}</div>`;
  }
}

const USER_ACTIONS = {
  "mfa/reset": { title: "admin.roles.confirm.mfa_title", text: "admin.roles.confirm.mfa_text", done: "admin.roles.done.mfa", danger: true },
  "sessions/revoke": { title: "admin.roles.confirm.sessions_title", text: "admin.roles.confirm.sessions_text", done: "admin.roles.done.sessions", danger: true },
  "api-tokens/revoke": { title: "admin.roles.confirm.tokens_title", text: "admin.roles.confirm.tokens_text", done: "admin.roles.done.tokens", danger: true },
  unlock: { title: "admin.roles.confirm.unlock_title", text: "admin.roles.confirm.unlock_text", done: "admin.roles.done.unlock", danger: false },
};

async function userAction(btn) {
  const key = btn.dataset.userAction;
  const cfg = USER_ACTIONS[key];
  const name = state.access?.full_name || "";
  if (!(await confirmDialog(t(cfg.title, { name }), t(cfg.text, { name }), btn.textContent.trim(), cfg.danger))) return;
  try {
    await withBusy(btn, () => api(`/admin/users/${state.userId}/${key}`, { method: "POST" }));
    toast(t(cfg.done, { name }), "success");
    loadUser(state.userId);
  } catch { /* toasted */ }
}

// ------------------------------------------------------------------ single sign-on

const callbackUrl = (id) => `${location.origin}/api/v1/auth/sso/${id}/callback`;

function ssoForm(p = {}) {
  return html`<div class="stack"><div class="form-grid">
    ${field({ name: "id", label: t("admin.roles.sso.f.id"), value: p.id || "", required: true, help: t("admin.roles.sso.f.id_help"),
      attrs: `class="mono" pattern="[a-z0-9][a-z0-9_\\-]{1,39}" maxlength="40" autocomplete="off" spellcheck="false" title="${t("admin.roles.sso.f.id_help")}" ${p.id ? "readonly" : ""}` })}
    ${field({ name: "label", label: t("admin.roles.sso.f.label"), value: p.label || "", required: true, placeholder: t("admin.roles.sso.f.label_ph"), attrs: 'maxlength="60" autocomplete="off"' })}
    ${field({ name: "issuer", label: t("admin.roles.sso.f.issuer"), type: "url", value: p.issuer || "", required: true, span: 2, placeholder: "https://login.example.org/realms/library",
      help: t("admin.roles.sso.f.issuer_help"), attrs: 'autocomplete="off" spellcheck="false"' })}
    ${field({ name: "client_id", label: t("admin.roles.sso.f.client_id"), value: p.client_id || "", required: true, attrs: 'autocomplete="off" spellcheck="false"' })}
    ${field({ name: "client_secret", label: t("admin.roles.sso.f.client_secret"), type: "password", optional: !!p.client_secret_set,
      help: p.client_secret_set ? t("admin.roles.sso.f.secret_keep") : t("admin.roles.sso.f.secret_help"), placeholder: p.client_secret_set ? "••••••••" : "", attrs: 'autocomplete="new-password"' })}
    ${field({ name: "scopes", label: t("admin.roles.sso.f.scopes"), value: p.scopes || "openid email profile", attrs: 'class="mono" autocomplete="off"' })}
    ${field({ name: "allowed_domains", label: t("admin.roles.sso.f.domains"), value: (p.allowed_domains || []).join(", "), optional: true, help: t("admin.roles.sso.f.domains_help"), placeholder: "library.example.org, uni.example.edu" })}
    ${field({ name: "default_category", label: t("admin.roles.sso.f.category"), value: p.default_category || "", optional: true, attrs: 'class="mono" maxlength="16"' })}
    ${field({ name: "default_branch", label: t("admin.roles.sso.f.branch"), value: p.default_branch || "", optional: true, attrs: 'class="mono" maxlength="16"' })}</div>
    <div class="form-grid">
      ${switchField({ name: "enabled", label: t("admin.roles.sso.f.enabled"), checked: p.enabled !== false, span: 1 })}
      ${switchField({ name: "auto_create", label: t("admin.roles.sso.f.auto_create"), checked: !!p.auto_create, help: t("admin.roles.sso.f.auto_create_help"), span: 1 })}
      ${switchField({ name: "allow_staff", label: t("admin.roles.sso.f.allow_staff"), checked: p.allow_staff !== false, span: 1 })}
      ${switchField({ name: "allow_patrons", label: t("admin.roles.sso.f.allow_patrons"), checked: p.allow_patrons !== false, span: 1 })}</div></div>`;
}

async function ssoEditor(p) {
  return editDialog({
    title: p ? t("admin.roles.sso.edit_title", { name: p.label }) : t("admin.roles.sso.add_title"), submit: t("admin.roles.sso.save"), size: "lg", body: ssoForm(p || {}),
    validate: { id: (v) => (!p && state.sso.some((x) => x.id === v.trim()) ? t("admin.roles.sso.id_taken") : true),
      client_secret: (v) => (p?.client_secret_set || v ? true : t("ui.form.required")) },
    onSubmit: (d) => api(`/admin/sso/providers/${encodeURIComponent(d.id.trim())}`, { method: "PUT", body: {
      label: d.label.trim(), issuer: d.issuer.trim(), client_id: d.client_id.trim(), client_secret: d.client_secret || null,
      scopes: d.scopes.trim() || "openid email profile", allowed_domains: d.allowed_domains.split(",").map((x) => x.trim()).filter(Boolean),
      default_category: d.default_category.trim().toUpperCase() || null, default_branch: d.default_branch.trim().toUpperCase() || null,
      enabled: d.enabled === "on", allow_staff: d.allow_staff === "on", allow_patrons: d.allow_patrons === "on", auto_create: d.auto_create === "on" } }),
  });
}

async function renderSso(panel) {
  if (!can("settings:manage")) { panel.innerHTML = html`<div class="card">${denied("settings:manage")}</div>`; return; }
  const { results } = await api("/admin/sso/providers");
  state.sso = results;
  panel.innerHTML = html`<div class="as-tab-head"><p class="muted">${t("admin.roles.sso.intro")}</p>
    <button type="button" class="btn primary" data-new-sso>${icon("plus")}${t("admin.roles.sso.add")}</button></div><div id="as-sso-table"></div>`;
  const table = dataTable($("#as-sso-table", panel), {
    id: "admin-sso", caption: t("admin.roles.tab.sso"), rowKey: (p) => p.id, rowLabel: (p) => p.label,
    columns: [
      { key: "label", label: t("admin.roles.sso.col.provider"), primary: true, hideable: false, csv: (p) => p.label,
        render: (p) => html`<div class="dt-cell-stack"><button type="button" class="link-btn as-row-title" data-edit-sso>${p.label}</button><span class="sub mono">${p.issuer}</span></div>` },
      { key: "enabled", label: t("admin.roles.col.status"), csv: (p) => (p.enabled === false ? "disabled" : "enabled"),
        render: (p) => html`${p.enabled === false ? pill("neutral", t("admin.roles.sso.disabled")) : pill("success", t("admin.roles.sso.enabled"))}${p.client_secret_set ? "" : html` ${pill("warning", t("admin.roles.sso.no_secret"))}`}` },
      { key: "callback", label: t("admin.roles.sso.col.callback"), csv: (p) => callbackUrl(p.id),
        render: (p) => html`<span class="as-copyline"><code class="as-url">${callbackUrl(p.id)}</code>${copyButton(callbackUrl(p.id), { label: t("admin.roles.sso.copy_callback") })}</span>` },
      { key: "access", label: t("admin.roles.sso.col.access"), csv: (p) => [p.allow_staff !== false && "staff", p.allow_patrons !== false && "patrons"].filter(Boolean).join(" "),
        render: (p) => html`<div class="as-pills">${p.allow_staff !== false ? pill("info", t("admin.roles.sso.staff"), { dot: false }) : ""}${p.allow_patrons !== false ? pill("info", t("admin.roles.sso.patrons"), { dot: false }) : ""}
          ${p.auto_create ? pill("ai", t("admin.roles.sso.auto_creates"), { dot: false }) : ""}</div>${p.allowed_domains?.length ? html`<span class="sub small muted">${p.allowed_domains.join(", ")}</span>` : ""}` },
      { key: "actions", label: t("admin.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "as-cell-actions", headClass: "as-cell-actions",
        render: (p) => rowMenu({ label: p.label, items: [{ id: "edit", label: t("admin.common.edit"), icon: "edit" }, { id: "delete", label: t("admin.common.delete"), icon: "trash", danger: true }] }) },
    ],
    exportName: "librowise-sso",
    empty: { art: "inbox", title: t("admin.roles.sso.empty_title"), body: t("admin.roles.sso.empty_body"),
      actions: html`<button type="button" class="btn" data-new-sso>${icon("plus")}${t("admin.roles.sso.add")}</button>` },
  });
  table.setRows(results);
}

async function deleteSso(p) {
  const ok = await confirmDestructive({ title: t("admin.roles.sso.delete_title", { name: p.label }), text: t("admin.roles.sso.delete_text"), word: p.id, submit: t("admin.common.delete") });
  if (!ok) return;
  try {
    await api(`/admin/sso/providers/${encodeURIComponent(p.id)}`, { method: "DELETE" });
    toast(t("admin.common.deleted_named", { name: p.label }), "success");
    await show("sso");
  } catch (err) { toast(err.message, "error"); }
}

// ------------------------------------------------------------------ wiring

const RENDER = { roles: renderRoles, staff: renderStaff, user: async (p) => renderUserShell(p), sso: renderSso };
let tabsApi = null;
let seq = 0;

async function show(tab) {
  state.tab = tab;
  const panel = $("#roles-panel");
  const mine = ++seq;
  panel.setAttribute("aria-busy", "true");
  try {
    await RENDER[tab](panel);
  } catch (e) {
    if (mine === seq) panel.innerHTML = html`<div class="card">${e.status === 403 ? denied("patrons:manage_staff") : errorState(e)}</div>`;
  } finally { panel.removeAttribute("aria-busy"); }
  if (tab === "user" && state.userId) history.replaceState(null, "", `#user-${state.userId}`);
}

export default async function init() {
  const root = $("#roles-tabs");
  if (!root) return; // access denied state is rendered by the server
  wireKit();
  const m = /^#user-(\d+)$/.exec(location.hash);
  if (m) {
    state.userId = Number(m[1]);
    $$('[role="tab"]', root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === "user")));
  }
  try {
    [state.me, state.catalogue] = await Promise.all([api("/auth/me"), api("/admin/permissions")]);
  } catch (e) {
    $("#roles-panel").innerHTML = html`<div class="card">${errorState(e, { retry: false })}</div>`;
    return;
  }
  const panel = $("#roles-panel");
  panel.addEventListener("click", async (e) => {
    if (e.target.closest("[data-retry]") && !e.target.closest(".dt")) { show(state.tab); return; }
    if (state.tab === "roles") { await onRolesAction(e); return; }
    if (e.target.closest("[data-goto-staff]")) { tabsApi.select("staff"); return; }
    const ou = e.target.closest("[data-open-user]");
    if (ou) { state.userId = Number(ou.closest("tr[data-key]").dataset.key); tabsApi.select("user"); return; }
    const ua = e.target.closest("[data-user-action]");
    if (ua) { userAction(ua); return; }
    if (e.target.closest("[data-new-sso]")) { const r = await ssoEditor(null); if (r) { toast(t("admin.roles.sso.saved", { name: r.label }), "success"); show("sso"); } return; }
    const es = e.target.closest("[data-edit-sso]");
    if (es) { const p = state.sso.find((x) => x.id === es.closest("tr[data-key]").dataset.key); const r = p && await ssoEditor(p); if (r) { toast(t("admin.roles.sso.saved", { name: r.label }), "success"); show("sso"); } }
  });
  panel.addEventListener("rowmenu", async (e) => {
    const action = e.detail.action;
    if (state.tab === "roles") {
      const id = Number(e.target.closest("[data-role]")?.dataset.role);
      if (action === "edit") editRole(id); else if (action === "delete") deleteRole(id);
    } else if (state.tab === "staff" && action === "access") {
      state.userId = Number(e.target.closest("tr[data-key]").dataset.key);
      tabsApi.select("user");
    } else if (state.tab === "sso") {
      const p = state.sso.find((x) => x.id === e.target.closest("tr[data-key]")?.dataset.key);
      if (!p) return;
      if (action === "edit") { const r = await ssoEditor(p); if (r) { toast(t("admin.roles.sso.saved", { name: r.label }), "success"); show("sso"); } }
      else if (action === "delete") deleteSso(p);
    }
  });
  panel.addEventListener("change", async (e) => {
    const s = e.target.closest("[data-assign]");
    if (!s) return;
    const label = s.selectedOptions[0]?.textContent || "";
    try {
      await api(`/admin/users/${s.dataset.assign}/staff-role`, { method: "PUT", body: { staff_role_id: s.value ? Number(s.value) : null } });
      toast(s.value ? t("admin.roles.role_assigned", { role: label }) : t("admin.roles.role_removed"), "success");
      if (state.tab === "user") loadUser(state.userId);
    } catch (err) { toast(err.message, "error"); show(state.tab); }
  });
  tabsApi = wireTabsPanel(root, (tab) => show(tab), { hash: true });
}
