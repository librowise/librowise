// Staff: Roles & permissions — custom roles, staff role assignment, per-user access controls, single sign-on.
import { $, $$, api, badge, confirmDialog, datetime, debounce, empty, html, icon, modal, raw, relative, skeleton, toast, withBusy } from "/static/js/core.js";
import { device } from "/static/js/security-panel.js";

const state = { tab: "roles", me: null, catalogue: null, roles: [], userId: null };
const panel = () => $("#roles-panel");
const can = (perm) => !!state.me && (state.me.permissions.includes("*") || state.me.permissions.includes(perm));

function setupTabs(root, onSelect) {
  const tabs = $$('[role="tab"]', root);
  const select = (tab, focus = false) => {
    tabs.forEach((t) => { const on = t === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
    panel().setAttribute("aria-labelledby", tab.id);
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
  return (key) => { const t = tabs.find((x) => x.dataset.tab === key); if (t) select(t); };
}

/** Modal form that stays open until `action(FormData)` succeeds. */
function formModal(opts, action) {
  let result = null;
  const done = modal(opts);
  const dlg = $$("dialog").at(-1);
  const form = $("form", dlg), ok = $('button[value="ok"]', dlg);
  form.addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter !== ok) return;
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    try { result = await withBusy(ok, () => action(new FormData(form), dlg)); dlg.close("ok"); } catch { /* toasted */ }
  });
  return { dlg, done: done.then(() => result) };
}

const notAllowed = (perm) => html`<div class="alert warn" role="alert">${icon("shield")}<div>You need the <span class="mono">${perm}</span> permission for this section.</div></div>`;
const sourceBadge = (s) => badge(s.startsWith("custom:") ? "ai" : "info", s.replace(/^role:/, "Built-in: ").replace(/^custom:/, "Role: "));

// ------------------------------------------------------------------ roles

function permissionChecklist(selected = []) {
  const sel = new Set(selected);
  const mine = new Set(state.me.permissions);
  const all = mine.has("*");
  return html`<div class="perm-groups">${state.catalogue.groups.map((g) => html`<fieldset class="perm-group">
    <legend>${g.group} <button type="button" class="btn sm ghost" data-toggle-group>All / none</button></legend>
    ${g.permissions.map((p) => {
      const grantable = all || mine.has(p.code);
      return html`<label class="checkbox perm-item${grantable ? "" : " disabled"}"><input type="checkbox" name="perm" value="${p.code}"${sel.has(p.code) ? raw(" checked") : ""}${grantable ? "" : raw(" disabled")}>
        <span><span class="mono">${p.code}</span><span class="tiny muted perm-desc">${p.description}${grantable ? "" : " — you can't grant this"}</span></span></label>`;
    })}</fieldset>`)}</div>`;
}

async function roleDialog(role) {
  const { dlg, done } = formModal({
    title: role ? `Edit role “${role.name}”` : "New staff role", submit: role ? "Save role" : "Create role", wide: true,
    body: html`<div class="stack">
      <div class="grid cols-2">
        <div class="field"><label for="role-name">Name</label><input id="role-name" name="name" required minlength="2" maxlength="80" value="${role?.name || ""}"></div>
        <div class="field"><label for="role-desc">Description</label><input id="role-desc" name="description" maxlength="255" value="${role?.description || ""}"></div>
      </div>
      <p class="small muted">Permissions are <strong>added</strong> to the account's built-in role (patron, librarian or administrator).
        Assigning a role to a patron account turns it into a staff account with exactly these extra permissions.</p>
      ${permissionChecklist(role?.permissions || [])}</div>`,
  }, (fd) => {
    const body = { name: String(fd.get("name") || "").trim(), description: String(fd.get("description") || "").trim() || null,
      permissions: [...$$('input[name="perm"]:checked', dlg)].map((i) => i.value) };
    return role ? api(`/admin/roles/${role.id}`, { method: "PUT", body }) : api("/admin/roles", { method: "POST", body });
  });
  dlg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-toggle-group]");
    if (!b) return;
    const boxes = $$('input[name="perm"]:not(:disabled)', b.closest("fieldset"));
    const on = boxes.some((x) => !x.checked);
    boxes.forEach((x) => { x.checked = on; });
  });
  return done;
}

async function renderRoles() {
  const { results } = await api("/admin/roles");
  state.roles = results;
  const builtin = state.catalogue.builtin_roles;
  return html`<div class="row between" style="margin-bottom:.75rem"><p class="muted small" style="margin:0">Custom roles grant extra permissions on top of the built-in role.</p>
    <button class="btn primary" data-new-role>${icon("plus")}New role</button></div>
    ${results.length ? html`<div class="card flush"><div class="table-wrap"><table class="table"><thead><tr><th>Role</th><th>Permissions</th><th class="num">Members</th><th>Updated</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${results.map((r) => html`<tr><td><strong>${r.name}</strong><div class="tiny muted">${r.description || ""}</div></td>
        <td><div class="row tight">${r.permissions.length ? r.permissions.map((p) => html`<span class="badge info mono">${p}</span>`) : html`<span class="muted small">None</span>`}</div></td>
        <td class="num">${r.members}</td><td>${datetime(r.updated_at)}</td>
        <td class="right nowrap"><button class="btn sm ghost" data-edit-role="${r.id}" aria-label="Edit ${r.name}">${icon("edit")}</button>
          <button class="btn sm ghost danger" data-delete-role="${r.id}" aria-label="Delete ${r.name}">${icon("trash")}</button></td></tr>`)}
    </tbody></table></div></div>` : empty("No custom roles yet. Create one to delegate specific duties (e.g. a circulation desk role).", "shield")}
    <details class="card pad" style="margin-top:1rem"><summary><strong>Built-in roles</strong></summary>
      <div class="stack" style="margin-top:.75rem">${Object.entries(builtin).map(([k, perms]) => html`<div><div class="small" style="font-weight:600;text-transform:capitalize">${k}</div>
        <div class="row tight">${perms.map((p) => html`<span class="badge mono">${p === "*" ? "* (everything)" : p}</span>`)}</div></div>`)}</div></details>`;
}

// ------------------------------------------------------------------ staff accounts

async function renderStaff() {
  const [{ results }, roles] = await Promise.all([api("/admin/staff"), api("/admin/roles")]);
  state.roles = roles.results;
  return html`<div class="card flush"><div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Card</th><th>Built-in role</th><th>Custom role</th><th>2FA</th><th>Last sign-in</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
    ${results.map((p) => html`<tr><td><strong>${p.full_name}</strong>${p.locked ? html` ${badge("bad", "Locked")}` : ""}${p.is_active ? "" : html` ${badge("withdrawn", "Inactive")}`}</td>
      <td class="mono small">${p.card_number}</td><td>${badge(p.role === "admin" ? "ai" : p.role === "librarian" ? "info" : "", p.role)}</td>
      <td><label class="sr-only" for="sr-${p.id}">Custom role for ${p.full_name}</label>
        <select id="sr-${p.id}" data-assign="${p.id}"><option value="">— none —</option>${state.roles.map((r) => html`<option value="${r.id}"${p.staff_role?.id === r.id ? raw(" selected") : ""}>${r.name}</option>`)}</select></td>
      <td>${p.mfa_enabled ? badge("ok", "On") : badge("warn", "Off")}</td><td>${p.last_login_at ? relative(p.last_login_at) : "Never"}</td>
      <td class="right"><button class="btn sm" data-open-user="${p.id}">Access</button></td></tr>`)}
  </tbody></table></div></div>
  <p class="small muted" style="margin-top:.75rem">To give a patron account staff duties, find them under <strong>User access</strong> and assign a custom role.
    Built-in roles are changed from the patron record.</p>`;
}

// ------------------------------------------------------------------ user access

function renderAccess(a, logins) {
  const groups = state.catalogue.groups;
  const byCode = Object.fromEntries(a.effective_permissions.map((p) => [p.code, p.sources]));
  const isAll = "*" in byCode;
  const locked = a.locked_until;
  return html`<div class="grid cols-2 access-grid">
    <div class="card pad stack">
      <div class="row between"><div><h2 style="margin:0">${a.full_name}</h2><div class="small muted">${a.card_number}${a.email ? ` · ${a.email}` : ""}</div></div>
        <div class="row tight">${badge(a.role === "admin" ? "ai" : "info", a.role)}${a.staff_role ? badge("ai", a.staff_role.name) : ""}${a.is_staff ? "" : badge("", "Patron")}</div></div>
      <div class="kv"><span>Two-factor authentication</span><span>${a.mfa.enabled ? badge("ok", `On · ${a.mfa.recovery_codes_remaining} recovery codes`) : badge("warn", "Off")}</span></div>
      <div class="kv"><span>Active sessions</span><span>${a.active_sessions}</span></div>
      <div class="kv"><span>Personal API tokens</span><span>${a.api_tokens}</span></div>
      <div class="kv"><span>Linked sign-in accounts</span><span>${a.identities.length ? a.identities.map((i) => `${i.provider}${i.email ? ` (${i.email})` : ""}`).join(", ") : "None"}</span></div>
      <div class="kv"><span>Last sign-in</span><span>${a.last_login_at ? datetime(a.last_login_at) : "Never"}</span></div>
      <div class="kv"><span>Lockout</span><span>${locked ? badge("bad", `Locked until ${datetime(locked)}`) : `${a.failed_logins} recent failed attempt(s)`}</span></div>
      <div class="row tight" style="margin-top:.5rem">
        ${can("patrons:manage_staff") ? html`<label class="sr-only" for="ua-role">Custom role</label><select id="ua-role" data-assign="${a.id}"><option value="">No custom role</option>
          ${state.roles.map((r) => html`<option value="${r.id}"${a.staff_role?.id === r.id ? raw(" selected") : ""}>${r.name}</option>`)}</select>` : ""}
        ${a.mfa.enabled ? html`<button class="btn sm" data-user-action="mfa/reset" data-confirm="Reset two-factor authentication? The user must enrol again and all their sessions end.">Reset 2FA</button>` : ""}
        <button class="btn sm" data-user-action="sessions/revoke" data-confirm="Sign this user out of every session?">Sign out everywhere</button>
        ${a.api_tokens ? html`<button class="btn sm" data-user-action="api-tokens/revoke" data-confirm="Revoke all of this user's API tokens?">Revoke API tokens</button>` : ""}
        ${locked ? html`<button class="btn sm" data-user-action="unlock">Unlock</button>` : ""}
      </div>
    </div>
    <div class="card pad stack"><h3 style="margin:0">Effective permissions</h3>
      ${isAll ? html`<div class="alert info">${icon("shield")}<div>Administrator: every permission (<span class="mono">*</span>), including those added by future modules.</div></div>` : ""}
      <div class="stack tight">${groups.map((g) => html`<div><div class="tiny muted" style="font-weight:650;text-transform:uppercase;letter-spacing:.04em">${g.group}</div>
        ${g.permissions.map((p) => {
          const src = isAll ? ["*"] : byCode[p.code];
          return html`<div class="kv perm-row"><span>${src ? icon("check", "ok-icon") : icon("x", "muted")} <span class="mono">${p.code}</span></span>
            <span class="row tight">${src ? (isAll ? badge("ai", "Administrator") : src.map(sourceBadge)) : html`<span class="tiny muted">—</span>`}</span></div>`;
        })}</div>`)}</div></div>
  </div>
  <div class="card pad stack" style="margin-top:1rem"><h3 style="margin:0">Sign-in history</h3>
    ${logins.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Result</th><th>Method</th><th>IP</th><th>Device</th></tr></thead><tbody>
      ${logins.map((e) => html`<tr><td>${datetime(e.at)}</td><td>${e.success ? badge("ok", "Success") : badge("bad", e.reason || "Failed")}</td><td>${e.method}</td>
        <td class="mono small">${e.ip || "—"}</td><td>${device(e.user_agent)}</td></tr>`)}</tbody></table></div>` : empty("No sign-in activity.", "clock")}</div>`;
}

async function loadUser(id) {
  state.userId = id;
  const box = $("#user-access");
  box.innerHTML = skeleton(5);
  try {
    if (!state.roles.length && can("patrons:manage_staff")) state.roles = (await api("/admin/roles")).results;
    const [a, logins] = await Promise.all([api(`/admin/users/${id}/access`), api(`/admin/users/${id}/logins`)]);
    box.innerHTML = renderAccess(a, logins.results);
  } catch (e) { box.innerHTML = empty(e.message, "alert"); }
}

async function renderUser() {
  return html`<div class="card pad stack" style="margin-bottom:1rem">
    <div class="field"><label for="user-q">Find an account by card number, name or e-mail</label>
      <input id="user-q" type="search" autocomplete="off" placeholder="e.g. 1000000001 or Iyer" data-search-focus></div>
    <div id="user-results"></div></div><div id="user-access">${state.userId ? "" : empty("Choose an account to see its effective permissions and security status.", "users")}</div>`;
}

// ------------------------------------------------------------------ single sign-on

const ssoFields = (p = {}) => html`<div class="grid cols-2">
  <div class="field"><label for="sso-id">Provider id</label><input id="sso-id" name="id" required pattern="[a-z0-9][a-z0-9_-]{1,39}" value="${p.id || ""}"${p.id ? raw(" readonly") : ""}>
    <span class="hint">Lowercase, used in the callback URL.</span></div>
  <div class="field"><label for="sso-label">Button label</label><input id="sso-label" name="label" required maxlength="60" value="${p.label || ""}" placeholder="e.g. University account"></div>
  <div class="field" style="grid-column:1/-1"><label for="sso-issuer">Issuer URL</label><input id="sso-issuer" name="issuer" type="url" required value="${p.issuer || ""}" placeholder="https://login.example.org/realms/library">
    <span class="hint">The discovery document is read from <span class="mono">&lt;issuer&gt;/.well-known/openid-configuration</span>.</span></div>
  <div class="field"><label for="sso-client">Client id</label><input id="sso-client" name="client_id" required value="${p.client_id || ""}"></div>
  <div class="field"><label for="sso-secret">Client secret</label><input id="sso-secret" name="client_secret" type="password" autocomplete="new-password" placeholder="${p.client_secret_set ? "•••••• (unchanged)" : ""}">
    <span class="hint">Stored encrypted. Leave blank to keep the current secret.</span></div>
  <div class="field"><label for="sso-scopes">Scopes</label><input id="sso-scopes" name="scopes" value="${p.scopes || "openid email profile"}"></div>
  <div class="field"><label for="sso-domains">Allowed e-mail domains</label><input id="sso-domains" name="allowed_domains" value="${(p.allowed_domains || []).join(", ")}" placeholder="library.example.org, uni.example.edu">
    <span class="hint">Comma-separated. Empty = any verified e-mail.</span></div>
  <div class="field"><label for="sso-cat">Default category code (new patrons)</label><input id="sso-cat" name="default_category" maxlength="16" value="${p.default_category || ""}"></div>
  <div class="field"><label for="sso-branch">Default branch code (new patrons)</label><input id="sso-branch" name="default_branch" maxlength="16" value="${p.default_branch || ""}"></div>
  <div class="field" style="grid-column:1/-1"><div class="row">
    <label class="checkbox"><input type="checkbox" name="enabled"${p.enabled === false ? "" : raw(" checked")}> Enabled</label>
    <label class="checkbox"><input type="checkbox" name="allow_staff"${p.allow_staff === false ? "" : raw(" checked")}> Staff may use it</label>
    <label class="checkbox"><input type="checkbox" name="allow_patrons"${p.allow_patrons === false ? "" : raw(" checked")}> Patrons may use it</label>
    <label class="checkbox"><input type="checkbox" name="auto_create"${p.auto_create ? raw(" checked") : ""}> Create patron accounts automatically</label></div></div>
</div>`;

async function ssoDialog(p) {
  const { done } = formModal({ title: p ? `Edit ${p.label}` : "Add OpenID Connect provider", submit: "Save provider", wide: true, body: ssoFields(p || {}) }, (fd) => {
    const id = String(fd.get("id") || "").trim();
    const body = {
      label: String(fd.get("label") || "").trim(), issuer: String(fd.get("issuer") || "").trim(), client_id: String(fd.get("client_id") || "").trim(),
      client_secret: String(fd.get("client_secret") || "") || null, scopes: String(fd.get("scopes") || "").trim() || "openid email profile",
      allowed_domains: String(fd.get("allowed_domains") || "").split(",").map((d) => d.trim()).filter(Boolean),
      default_category: String(fd.get("default_category") || "").trim().toUpperCase() || null,
      default_branch: String(fd.get("default_branch") || "").trim().toUpperCase() || null,
      enabled: fd.has("enabled"), allow_staff: fd.has("allow_staff"), allow_patrons: fd.has("allow_patrons"), auto_create: fd.has("auto_create"),
    };
    return api(`/admin/sso/providers/${encodeURIComponent(id)}`, { method: "PUT", body });
  });
  return done;
}

async function renderSso() {
  if (!can("settings:manage")) return notAllowed("settings:manage");
  const { results } = await api("/admin/sso/providers");
  state.sso = results;
  return html`<div class="row between" style="margin-bottom:.75rem"><p class="muted small" style="margin:0">Let staff and patrons sign in with an OpenID Connect identity provider
    (authorization code + PKCE). Accounts are matched by linked identity, then by verified e-mail.</p>
    <button class="btn primary" data-new-sso>${icon("plus")}Add provider</button></div>
    ${results.length ? html`<div class="card flush"><div class="table-wrap"><table class="table"><thead><tr><th>Provider</th><th>Issuer</th><th>Callback URL to register</th><th>Access</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${results.map((p) => html`<tr><td><strong>${p.label}</strong> ${p.enabled === false ? badge("withdrawn", "Disabled") : badge("ok", "Enabled")}<div class="tiny muted mono">${p.id}</div></td>
        <td class="small mono">${p.issuer}</td><td class="small mono">${location.origin}/api/v1/auth/sso/${p.id}/callback</td>
        <td class="small">${[p.allow_staff === false ? "" : "Staff", p.allow_patrons === false ? "" : "Patrons"].filter(Boolean).join(" & ") || "Nobody"}
          ${p.auto_create ? html`<div class="tiny muted">Auto-creates patrons</div>` : ""}${p.allowed_domains?.length ? html`<div class="tiny muted">${p.allowed_domains.join(", ")}</div>` : ""}
          ${p.client_secret_set ? "" : html`<div>${badge("warn", "No client secret")}</div>`}</td>
        <td class="right nowrap"><button class="btn sm ghost" data-edit-sso="${p.id}" aria-label="Edit ${p.label}">${icon("edit")}</button>
          <button class="btn sm ghost danger" data-delete-sso="${p.id}" aria-label="Delete ${p.label}">${icon("trash")}</button></td></tr>`)}
    </tbody></table></div></div>` : empty("No single sign-on providers configured.", "globe")}`;
}

// ------------------------------------------------------------------ wiring

const RENDER = { roles: renderRoles, staff: renderStaff, user: renderUser, sso: renderSso };

async function show(tab) {
  state.tab = tab;
  panel().innerHTML = skeleton(5);
  try { panel().innerHTML = await RENDER[tab](); } catch (e) { panel().innerHTML = empty(e.message, "alert"); }
  history.replaceState(null, "", `#${tab}${tab === "user" && state.userId ? `-${state.userId}` : ""}`);
  if (tab === "user") {
    $("#user-q").addEventListener("input", debounce(searchUsers, 250));
    if (state.userId) loadUser(state.userId);
  }
}

async function searchUsers(e) {
  const q = e.target.value.trim();
  const box = $("#user-results");
  if (q.length < 2) { box.innerHTML = ""; return; }
  try {
    const r = await api(`/patrons?${new URLSearchParams({ q, per_page: 8 })}`);
    box.innerHTML = r.results.length ? html`<div class="stack tight" role="list">${r.results.map((p) => html`<button type="button" class="btn ghost user-pick" role="listitem" data-open-user="${p.id}">
      <strong>${p.full_name}</strong> <span class="mono small muted">${p.card_number}</span> ${p.role !== "patron" ? badge("info", p.role) : ""}</button>`)}</div>` : html`<p class="small muted">No matches.</p>`;
  } catch (err) { box.innerHTML = html`<p class="small muted">${err.message}</p>`; }
}

export default async function init() {
  state.me = await api("/auth/me");
  if (!can("patrons:manage_staff")) {
    $("#roles-denied").innerHTML = notAllowed("patrons:manage_staff");
    $("#roles-tabs").classList.add("hidden");
    return;
  }
  state.catalogue = await api("/admin/permissions");
  const select = setupTabs($("#roles-tabs"), show);
  const [tab, uid] = location.hash.slice(1).split("-");
  if (uid) state.userId = Number(uid);
  select(RENDER[tab] ? tab : "roles");

  panel().addEventListener("change", async (e) => {
    const s = e.target.closest("[data-assign]");
    if (!s) return;
    try {
      await api(`/admin/users/${s.dataset.assign}/staff-role`, { method: "PUT", body: { staff_role_id: s.value ? Number(s.value) : null } });
      toast("Role updated", "success");
      if (state.tab === "user") loadUser(state.userId);
    } catch (err) { toast(err.message, "error"); show(state.tab); }
  });

  panel().addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    try {
      if (t.hasAttribute("data-new-role")) { if (await roleDialog(null)) { toast("Role created", "success"); show("roles"); } }
      else if (t.dataset.editRole) {
        const role = state.roles.find((r) => r.id === Number(t.dataset.editRole));
        if (await roleDialog(role)) { toast("Role saved", "success"); show("roles"); }
      } else if (t.dataset.deleteRole) {
        const role = state.roles.find((r) => r.id === Number(t.dataset.deleteRole));
        if (!(await confirmDialog(`Delete role “${role.name}”?`, `${role.members} account(s) will lose the permissions it grants.`, "Delete role"))) return;
        await withBusy(t, () => api(`/admin/roles/${role.id}`, { method: "DELETE" }));
        toast("Role deleted", "success"); show("roles");
      } else if (t.dataset.openUser) {
        state.userId = Number(t.dataset.openUser);
        if (state.tab !== "user") select("user"); else { history.replaceState(null, "", `#user-${state.userId}`); loadUser(state.userId); }
      } else if (t.dataset.userAction) {
        if (t.dataset.confirm && !(await confirmDialog("Are you sure?", t.dataset.confirm, "Confirm"))) return;
        await withBusy(t, () => api(`/admin/users/${state.userId}/${t.dataset.userAction}`, { method: "POST" }));
        toast("Done", "success"); loadUser(state.userId);
      } else if (t.hasAttribute("data-new-sso")) { if (await ssoDialog(null)) { toast("Provider saved", "success"); show("sso"); } }
      else if (t.dataset.editSso) {
        if (await ssoDialog(state.sso.find((p) => p.id === t.dataset.editSso))) { toast("Provider saved", "success"); show("sso"); }
      } else if (t.dataset.deleteSso) {
        if (!(await confirmDialog("Delete provider?", "Linked accounts will no longer be able to sign in with it.", "Delete"))) return;
        await withBusy(t, () => api(`/admin/sso/providers/${encodeURIComponent(t.dataset.deleteSso)}`, { method: "DELETE" }));
        toast("Provider deleted", "success"); show("sso");
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
}
