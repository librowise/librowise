// Account security panel shared by the staff "My account / Security" page and the OPAC account settings tab:
// two-factor authentication, active sessions, sign-in history, linked SSO accounts and personal API tokens.
//
//   mountSecurity(el, { enroll, password, t, headingLevel })
//     t            optional translator `(key, params, englishFallback) => string` (i18n.js `t`). Without it every
//                  string is the built-in English (unchanged behaviour for callers that don't pass one).
//     headingLevel "h2" | "h3" (default) | "h4" — section heading level, to fit the host page's outline.
import { $, $$, api, badge, confirmDialog, datetime, empty, html, icon, modal, raw, relative, skeleton, toast, withBusy } from "/static/js/core.js";

const fill = (s, p = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));
const EN = (_key, en, params) => fill(en, params);

const SSO_ERRORS = {
  already_linked: ["people.security.panel.sso_error.already_linked", "That external account is already linked to another library account."],
  domain: ["people.security.panel.sso_error.domain", "Your e-mail domain is not allowed for this provider."],
  link_session: ["people.security.panel.sso_error.link_session", "Linking must be finished in the same browser session. Please try again."],
  state: ["people.security.panel.sso_error.state", "The linking attempt expired. Please try again."],
  denied: ["people.security.panel.sso_error.denied", "Linking was cancelled at the identity provider."],
};

/** Short, human description of a user-agent string. `L` is an optional translator (see mountSecurity). */
export function device(ua, L = EN) {
  if (!ua) return L("people.security.panel.device.unknown", "Unknown device");
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari"
      : /curl|python|httpx|okhttp|java/i.test(ua) ? L("people.security.panel.device.api_client", "API client") : L("people.security.panel.device.browser", "Browser");
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? L("people.security.panel.device.on", "{browser} on {os}", { browser, os }) : browser;
}

function methodLabel(m, L = EN) {
  const v = m || "";
  const sso = v.match(/^sso:(.+?)(\+.*)?$/);
  if (sso) return sso[2] ? L("people.security.panel.method.sso_2fa", "Single sign-on ({provider}) + 2FA", { provider: sso[1] })
    : L("people.security.panel.method.sso", "Single sign-on ({provider})", { provider: sso[1] });
  return {
    "password+totp": L("people.security.panel.method.password_totp", "Password + authenticator"),
    "password+recovery": L("people.security.panel.method.password_recovery", "Password + recovery code"),
    password: L("people.security.panel.method.password", "Password"),
    password_reset: L("people.security.panel.method.password_reset", "Password reset"),
    password_change: L("people.security.panel.method.password_change", "Password change"),
    "2fa": L("people.security.panel.method.second_factor", "Second factor"),
  }[v] ?? v;
}

/** Modal form that stays open until `action(FormData)` succeeds (errors are toasted by withBusy). */
function formModal(opts, action) {
  let result = null;
  const done = modal(opts);
  const dlg = $$("dialog").at(-1);
  const form = $("form", dlg), ok = $('button[value="ok"]', dlg);
  form.addEventListener("submit", async (e) => {
    if (e.submitter !== ok && e.submitter) return;
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    try {
      result = await withBusy(ok, () => action(new FormData(form), dlg));
      dlg.close("ok");
    } catch { /* toast already shown */ }
  });
  return { dlg, done: done.then(() => result) };
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function mountSecurity(root, { enroll = false, password = false, t: translate = null, headingLevel = "h3" } = {}) {
  const L = translate ? (key, en, params = {}) => translate(key, params, fill(en, params)) : EN;
  const H = ["h2", "h3", "h4"].includes(headingLevel) ? headingLevel : "h3";
  const heading = (id, content) => html`${raw(`<${H} id="${id}">`)}${content}${raw(`</${H}>`)}`;
  // Scrollable tables are keyboard-focusable named regions (WCAG 2.1.1 / axe scrollable-region-focusable).
  const tableWrap = (label, table) => html`<div class="table-wrap" tabindex="0" role="region" aria-label="${label}">${table}</div>`;
  let me = null, mfa = null;

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast(L("people.security.panel.copied", "Copied to clipboard"), "success"); }
    catch { toast(L("people.security.panel.copy_failed", "Copy failed — select the text and copy it manually"), "error"); }
  };
  const pwField = (needed) => (needed ? html`<div class="field"><label for="sec-pw">${L("people.security.panel.current_password", "Current password")}</label>
    <input id="sec-pw" name="password" type="password" autocomplete="current-password" required></div>` : "");
  const codeField = () => html`<div class="field"><label for="sec-code">${L("people.security.panel.code_label", "Authentication or recovery code")}</label>
    <input id="sec-code" name="code" autocomplete="one-time-code" inputmode="numeric" minlength="6" maxlength="11" required spellcheck="false">
    <span class="hint">${L("people.security.panel.code_hint", "6-digit code from your authenticator app, or one of your recovery codes.")}</span></div>`;

  function showRecoveryCodes(codes) {
    const text = codes.join("\n");
    const body = html`<div class="stack">
      <div class="alert warn">${icon("alert")}<div>${L("people.security.panel.codes_warning", "Save these codes somewhere safe — each one signs you in once if you lose your authenticator.")}
        <strong>${L("people.security.panel.codes_once", "They won't be shown again.")}</strong></div></div>
      <ul class="recovery-codes mono" aria-label="${L("people.security.panel.codes_label", "Recovery codes")}">${codes.map((c) => html`<li>${c}</li>`)}</ul>
      <div class="row tight"><button type="button" class="btn sm" data-copy-codes>${icon("copy")}${L("people.security.panel.copy", "Copy")}</button>
        <button type="button" class="btn sm" data-download-codes>${icon("download")}${L("people.security.panel.download", "Download")}</button></div></div>`;
    const p = modal({ title: L("people.security.panel.codes_title", "Your recovery codes"), body, submit: L("people.security.panel.codes_saved", "I've saved them") });
    const dlg = $$("dialog").at(-1);
    $("[data-copy-codes]", dlg).addEventListener("click", () => copy(text));
    $("[data-download-codes]", dlg).addEventListener("click", () => download("librowise-recovery-codes.txt", text));
    return p;
  }

  root.innerHTML = html`<div class="stack security-panel">
    <div data-enroll></div>
    ${password ? html`<section class="card pad stack" aria-labelledby="sec-pw-h" data-section="password">${heading("sec-pw-h", html`${L("people.security.panel.password", "Password")}`)}
      <form class="stack" data-password-form>
        <div class="grid cols-2">
          <div class="field"><label for="sec-cur">${L("people.security.panel.current_password", "Current password")}</label><input id="sec-cur" name="current_password" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="sec-new">${L("people.security.panel.new_password", "New password")}</label><input id="sec-new" name="new_password" type="password" autocomplete="new-password" minlength="10" required aria-describedby="sec-new-hint">
            <span class="hint" id="sec-new-hint">${L("people.security.panel.password_rule", "At least 10 characters, mixing three of: lowercase, uppercase, digits, symbols.")}</span></div>
        </div>
        <div><button class="btn primary">${L("people.security.panel.change_password", "Change password")}</button></div></form></section>` : ""}
    <section class="card pad stack" aria-labelledby="sec-mfa-h" data-section="mfa">${heading("sec-mfa-h", html`${icon("shield")} ${L("people.security.panel.mfa", "Two-factor authentication")}`)}<div data-mfa>${raw(skeleton(2))}</div></section>
    <section class="card pad stack" aria-labelledby="sec-sess-h" data-section="sessions">
      <div class="row between">${heading("sec-sess-h", html`${L("people.security.panel.sessions", "Active sessions")}`)}
        <div class="row tight"><button class="btn sm" data-revoke-others>${icon("logout")}${L("people.security.panel.sign_out_others", "Sign out other sessions")}</button>
          <button class="btn sm danger" data-revoke-everything>${L("people.security.panel.sign_out_everywhere", "Sign out everywhere")}</button></div></div>
      <div data-sessions>${raw(skeleton(2))}</div></section>
    <section class="card pad stack hidden" aria-labelledby="sec-id-h" data-identities-card data-section="linked">${heading("sec-id-h", html`${L("people.security.panel.linked", "Linked sign-in accounts")}`)}<div data-identities></div></section>
    <section class="card pad stack" aria-labelledby="sec-tok-h" data-section="tokens">
      <div class="row between">${heading("sec-tok-h", html`${L("people.security.panel.tokens", "Personal API tokens")}`)}<button class="btn sm" data-new-token>${icon("plus")}${L("people.security.panel.new_token", "New token")}</button></div>
      <p class="small muted">${L("people.security.panel.tokens_intro", "Tokens let scripts and integrations call the Librowise API as you, limited to the scopes you choose. Treat them like passwords.")}</p>
      <div data-tokens>${raw(skeleton(2))}</div></section>
    <section class="card pad stack" aria-labelledby="sec-log-h" data-section="history">${heading("sec-log-h", html`${L("people.security.panel.history", "Recent sign-in activity")}`)}<div data-logins>${raw(skeleton(3))}</div></section>
  </div>`;
  const part = (name) => $(`[data-${name}]`, root);

  async function loadMfa() {
    [me, mfa] = await Promise.all([api("/auth/me"), api("/auth/mfa")]);
    part("enroll").innerHTML = (enroll || me.mfa_enrollment_required) && !mfa.enabled
      ? html`<div class="alert warn" role="alert">${icon("shield")}<div><strong>${L("people.security.panel.enroll_title", "Two-factor authentication is required.")}</strong>
          ${L("people.security.panel.enroll_body", "Your library requires staff accounts to use an authenticator app. Set it up below to continue to the staff interface.")}</div></div>` : "";
    const left = mfa.recovery_codes_remaining;
    part("mfa").innerHTML = mfa.enabled
      ? html`<div class="row between"><div class="stack tight"><div>${badge("ok", L("people.security.panel.on", "On"))} ${L("people.security.panel.mfa_enabled_on", "Authenticator app · enabled {date}", { date: datetime(mfa.enabled_at) })}</div>
          <div class="small muted">${translate ? translate("people.security.panel.codes_left", { count: left }, `${left} unused recovery codes left.`)
            : (left === 1 ? "1 unused recovery code left." : `${left} unused recovery codes left.`)}</div></div>
          <div class="row tight"><button class="btn sm" data-mfa-codes>${L("people.security.panel.new_codes", "New recovery codes")}</button>
          ${mfa.required ? html`<span class="small muted">${L("people.security.panel.required_by_policy", "Required by library policy")}</span>` : html`<button class="btn sm danger" data-mfa-disable>${L("people.security.panel.turn_off", "Turn off")}</button>`}</div></div>`
      : html`<div class="row between"><div class="stack tight"><div>${badge(mfa.required ? "bad" : "warn", L("people.security.panel.off", "Off"))} ${L("people.security.panel.mfa_pitch", "Protect your account with a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis…).")}</div></div>
          <button class="btn primary sm" data-mfa-enable>${icon("shield")}${L("people.security.panel.set_up", "Set up")}</button></div>`;
  }

  async function loadSessions() {
    const { results } = await api("/auth/sessions");
    part("sessions").innerHTML = results.length ? tableWrap(L("people.security.panel.sessions", "Active sessions"), html`<table class="table"><thead><tr>
      <th scope="col">${L("people.security.panel.col.device", "Device")}</th><th scope="col">${L("people.security.panel.col.ip", "IP address")}</th><th scope="col">${L("people.security.panel.col.signed_in", "Signed in")}</th>
      <th scope="col">${L("people.security.panel.col.last_active", "Last active")}</th><th scope="col"><span class="sr-only">${L("people.security.panel.col.actions", "Actions")}</span></th></tr></thead><tbody>
      ${results.map((s) => html`<tr><td><strong>${device(s.user_agent, L)}</strong>${s.current ? html` ${badge("info", L("people.security.panel.this_browser", "This browser"))}` : ""}
        <div class="tiny muted">${methodLabel(s.method, L)}</div></td><td class="mono small">${s.ip || "—"}</td>
        <td>${datetime(s.created_at)}</td><td>${relative(s.last_seen_at)}</td>
        <td class="right"><button class="btn sm ghost danger" data-revoke-session="${s.id}" data-current="${s.current ? 1 : 0}">${L("people.security.panel.sign_out", "Sign out")}</button></td></tr>`)}
      </tbody></table>`) : empty(L("people.security.panel.no_sessions", "No active sessions."), "clock");
  }

  async function loadLogins() {
    const { results } = await api("/auth/logins?limit=20");
    part("logins").innerHTML = results.length ? tableWrap(L("people.security.panel.history", "Recent sign-in activity"), html`<table class="table"><thead><tr>
      <th scope="col">${L("people.security.panel.col.when", "When")}</th><th scope="col">${L("people.security.panel.col.result", "Result")}</th><th scope="col">${L("people.security.panel.col.method", "Method")}</th>
      <th scope="col">${L("people.security.panel.col.ip", "IP address")}</th><th scope="col">${L("people.security.panel.col.device", "Device")}</th></tr></thead><tbody>
      ${results.map((e) => html`<tr><td>${datetime(e.at)}</td><td>${e.success ? badge("ok", L("people.security.panel.success", "Success"))
        : badge("bad", e.reason === "locked" ? L("people.security.panel.blocked_locked", "Blocked (locked)") : L("people.security.panel.failed", "Failed"))}</td>
        <td>${methodLabel(e.method, L)}</td><td class="mono small">${e.ip || "—"}</td><td>${device(e.user_agent, L)}</td></tr>`)}
      </tbody></table>`) : empty(L("people.security.panel.no_logins", "No sign-in activity recorded yet."), "clock");
  }

  async function loadTokens() {
    const { results } = await api("/auth/tokens");
    part("tokens").innerHTML = results.length ? tableWrap(L("people.security.panel.tokens", "Personal API tokens"), html`<table class="table"><thead><tr>
      <th scope="col">${L("people.security.panel.col.name", "Name")}</th><th scope="col">${L("people.security.panel.col.scopes", "Scopes")}</th><th scope="col">${L("people.security.panel.col.created", "Created")}</th>
      <th scope="col">${L("people.security.panel.col.last_used", "Last used")}</th><th scope="col">${L("people.security.panel.col.expires", "Expires")}</th><th scope="col"><span class="sr-only">${L("people.security.panel.col.actions", "Actions")}</span></th></tr></thead><tbody>
      ${results.map((tk) => html`<tr><td><strong>${tk.name}</strong><div class="tiny muted mono">${tk.prefix}…</div></td>
        <td><div class="row tight">${tk.scopes.map((s) => badge("info", s))}</div></td><td>${datetime(tk.created_at)}</td>
        <td>${tk.last_used_at ? html`${relative(tk.last_used_at)}<div class="tiny muted mono">${tk.last_used_ip || ""}</div>` : L("people.security.panel.never", "Never")}</td>
        <td>${tk.expires_at ? datetime(tk.expires_at) : L("people.security.panel.never", "Never")}</td>
        <td class="right"><button class="btn sm ghost danger" data-revoke-token="${tk.id}">${L("people.security.panel.revoke", "Revoke")}</button></td></tr>`)}
      </tbody></table>`) : empty(L("people.security.panel.no_tokens", "No API tokens."), "code");
  }

  async function loadIdentities() {
    const r = await api("/auth/identities");
    const linked = new Set(r.results.map((i) => i.provider));
    const card = part("identities-card");
    card.classList.toggle("hidden", !r.results.length && !r.providers.length);
    part("identities").innerHTML = html`${r.results.length ? html`<div class="stack tight">${r.results.map((i) => html`<div class="row between kv">
        <span><strong>${i.label}</strong> <span class="muted small">${i.email || ""}</span>
        <span class="tiny muted">· ${L("people.security.panel.linked_on", "linked {date}", { date: datetime(i.created_at) })}${i.last_login_at ? html` · ${L("people.security.panel.last_used", "last used {when}", { when: relative(i.last_login_at) })}` : ""}</span></span>
        <button class="btn sm ghost danger" data-unlink="${i.id}">${L("people.security.panel.unlink", "Unlink")}</button></div>`)}</div>` : html`<p class="small muted">${L("people.security.panel.no_linked", "No external accounts linked.")}</p>`}
      <div class="row tight">${r.providers.filter((p) => !linked.has(p.id)).map((p) => html`<button class="btn sm" data-link="${p.id}">${icon("plus")}${L("people.security.panel.link", "Link {provider}", { provider: p.label })}</button>`)}</div>`;
  }

  const safe = (fn) => fn().catch((e) => { if (!e.toasted) toast(e.message, "error"); });
  await Promise.all([loadMfa, loadSessions, loadLogins, loadTokens, loadIdentities].map(safe));

  const params = new URLSearchParams(location.search);
  if (params.get("sso_error")) {
    const [key, en] = SSO_ERRORS[params.get("sso_error")] || ["people.security.panel.sso_error.generic", "Linking the account failed."];
    toast(L(key, en), "error", 7000);
  }

  async function enableMfa() {
    const step1 = formModal({ title: L("people.security.panel.setup_title", "Set up two-factor authentication"), submit: L("people.security.panel.continue", "Continue"),
      body: html`<p>${L("people.security.panel.confirm_its_you", "Confirm it's you to start.")}</p>${pwField(me?.has_password !== false)}` }, (fd) => api("/auth/mfa/setup", { method: "POST", body: { password: fd.get("password") || "" } }));
    const setup = await step1.done;
    if (!setup) return;
    const grouped = setup.secret.replace(/(.{4})/g, "$1 ").trim();
    const step2 = formModal({
      title: L("people.security.panel.scan_title", "Scan with your authenticator app"), submit: L("people.security.panel.verify", "Verify & turn on"), wide: true,
      body: html`<div class="mfa-setup">
        <img class="qr" src="${setup.qr_svg}" alt="${L("people.security.panel.qr_alt", "QR code for adding this account to an authenticator app")}" width="200" height="200">
        <div class="stack">
          <ol class="small"><li>${L("people.security.panel.step_add", "Open your authenticator app and add an account.")}</li><li>${L("people.security.panel.step_scan", "Scan the QR code — or enter this key manually:")}</li></ol>
          <div class="row tight"><code class="mono secret-key" aria-label="${L("people.security.panel.setup_key", "Setup key")}">${grouped}</code>
            <button type="button" class="btn sm ghost" data-copy-secret aria-label="${L("people.security.panel.copy_key", "Copy setup key")}">${icon("copy")}</button></div>
          <div class="field"><label for="mfa-activate-code">${L("people.security.panel.enter_code", "Enter the 6-digit code it shows")}</label>
            <input id="mfa-activate-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
        </div></div>`,
    }, (fd) => api("/auth/mfa/activate", { method: "POST", body: { code: String(fd.get("code") || "").trim() } }));
    $("[data-copy-secret]", step2.dlg).addEventListener("click", () => copy(setup.secret));
    const res = await step2.done;
    if (!res) return;
    await showRecoveryCodes(res.recovery_codes);
    toast(L("people.security.panel.mfa_on_toast", "Two-factor authentication is on"), "success");
    if (enroll || me?.mfa_enrollment_required) { location.href = "/staff"; return; }
    await safe(loadMfa);
  }

  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b || !root.contains(b)) return;
    try {
      if (b.hasAttribute("data-mfa-enable")) await enableMfa();
      else if (b.hasAttribute("data-mfa-disable")) {
        const r = await formModal({ title: L("people.security.panel.disable_title", "Turn off two-factor authentication"), submit: L("people.security.panel.turn_off", "Turn off"), danger: true,
          body: html`<p>${L("people.security.panel.disable_body", "Your account will be protected by your password only.")}</p>${pwField(me?.has_password !== false)}${codeField()}` },
        (fd) => api("/auth/mfa/disable", { method: "POST", body: { password: fd.get("password") || "", code: String(fd.get("code") || "").trim() } })).done;
        if (r) { toast(L("people.security.panel.mfa_off_toast", "Two-factor authentication turned off"), "success"); await safe(loadMfa); }
      } else if (b.hasAttribute("data-mfa-codes")) {
        const r = await formModal({ title: L("people.security.panel.regen_title", "Generate new recovery codes"), submit: L("people.security.panel.generate", "Generate"),
          body: html`<p>${L("people.security.panel.regen_body", "Your existing recovery codes will stop working.")}</p>${pwField(me?.has_password !== false)}${codeField()}` },
        (fd) => api("/auth/mfa/recovery-codes", { method: "POST", body: { password: fd.get("password") || "", code: String(fd.get("code") || "").trim() } })).done;
        if (r) { await showRecoveryCodes(r.recovery_codes); await safe(loadMfa); }
      } else if (b.dataset.revokeSession) {
        const current = b.dataset.current === "1";
        if (current && !(await confirmDialog(L("people.security.panel.sign_out_this_title", "Sign out this browser?"), L("people.security.panel.sign_out_this_body", "You'll need to sign in again here."), L("people.security.panel.sign_out", "Sign out")))) return;
        await withBusy(b, () => api(`/auth/sessions/${b.dataset.revokeSession}`, { method: "DELETE" }));
        if (current) { location.href = "/login"; return; }
        toast(L("people.security.panel.session_signed_out", "Session signed out"), "success"); await safe(loadSessions);
      } else if (b.hasAttribute("data-revoke-others")) {
        if (!(await confirmDialog(L("people.security.panel.others_title", "Sign out other sessions?"), L("people.security.panel.others_body", "Every other browser and device signed in to your account will be signed out."), L("people.security.panel.others_submit", "Sign out others")))) return;
        const r = await withBusy(b, () => api("/auth/sessions/revoke-all", { method: "POST", body: { include_current: false } }));
        toast(translate ? translate("people.security.panel.sessions_signed_out", { count: r.revoked }, `${r.revoked} session(s) signed out`) : `${r.revoked} session(s) signed out`, "success");
        await safe(loadSessions);
      } else if (b.hasAttribute("data-revoke-everything")) {
        if (!(await confirmDialog(L("people.security.panel.everywhere_title", "Sign out everywhere?"), L("people.security.panel.everywhere_body", "All sessions, including this one, will be signed out."), L("people.security.panel.sign_out_everywhere", "Sign out everywhere")))) return;
        await withBusy(b, () => api("/auth/sessions/revoke-all", { method: "POST", body: { include_current: true } }));
        location.href = "/login";
      } else if (b.dataset.revokeToken) {
        if (!(await confirmDialog(L("people.security.panel.revoke_title", "Revoke token?"), L("people.security.panel.revoke_body", "Integrations using it will stop working immediately."), L("people.security.panel.revoke", "Revoke")))) return;
        await withBusy(b, () => api(`/auth/tokens/${b.dataset.revokeToken}`, { method: "DELETE" }));
        toast(L("people.security.panel.token_revoked", "Token revoked"), "success"); await safe(loadTokens);
      } else if (b.hasAttribute("data-new-token")) {
        const { results: scopes } = await api("/auth/scopes");
        const r = await formModal({ title: L("people.security.panel.new_token_title", "New personal API token"), submit: L("people.security.panel.create_token", "Create token"), wide: true,
          body: html`<div class="stack"><div class="grid cols-2">
            <div class="field"><label for="tok-name">${L("people.security.panel.col.name", "Name")}</label><input id="tok-name" name="name" maxlength="80" required placeholder="${L("people.security.panel.token_name_hint", "e.g. Discovery layer sync")}"></div>
            <div class="field"><label for="tok-exp">${L("people.security.panel.col.expires", "Expires")}</label><select id="tok-exp" name="expires_days">
              <option value="30">${L("people.security.panel.in_30_days", "In 30 days")}</option><option value="90" selected>${L("people.security.panel.in_90_days", "In 90 days")}</option>
              <option value="365">${L("people.security.panel.in_1_year", "In 1 year")}</option><option value="">${L("people.security.panel.never", "Never")}</option></select></div></div>
            <fieldset class="scope-list"><legend>${L("people.security.panel.col.scopes", "Scopes")} <span class="hint">${L("people.security.panel.scopes_hint", "(choose the least access the integration needs)")}</span></legend>
              ${scopes.map((s) => html`<label class="checkbox"><input type="checkbox" name="scope" value="${s.code}"> <span><span class="mono">${s.code}</span>
                <span class="tiny muted">${s.description}</span></span></label>`)}</fieldset></div>` },
        (fd) => {
          const chosen = fd.getAll("scope");
          if (!chosen.length) throw new Error(L("people.security.panel.choose_scope", "Choose at least one scope"));
          const days = fd.get("expires_days");
          return api("/auth/tokens", { method: "POST", body: { name: String(fd.get("name") || "").trim(), scopes: chosen, expires_days: days ? Number(days) : null } });
        }).done;
        if (!r) return;
        const p = modal({ title: L("people.security.panel.copy_token_title", "Copy your new token"), submit: L("people.security.panel.done", "Done"), body: html`<div class="stack">
          <div class="alert warn">${icon("alert")}<div>${L("people.security.panel.token_once", "This is the only time the token is shown. Store it in your integration's secret store.")}</div></div>
          <code class="mono secret-key" style="word-break:break-all">${r.token}</code>
          <div><button type="button" class="btn sm" data-copy-token>${icon("copy")}${L("people.security.panel.copy_token", "Copy token")}</button></div>
          <p class="tiny muted">${L("people.security.panel.token_usage", "Use it as")} <span class="mono">Authorization: Bearer ${r.prefix}…</span></p></div>` });
        $("[data-copy-token]", $$("dialog").at(-1)).addEventListener("click", () => copy(r.token));
        await p;
        await safe(loadTokens);
      } else if (b.dataset.link) {
        const r = await withBusy(b, () => api(`/auth/sso/${encodeURIComponent(b.dataset.link)}/link`, { method: "POST" }));
        location.href = r.redirect;
      } else if (b.dataset.unlink) {
        if (!(await confirmDialog(L("people.security.panel.unlink_title", "Unlink account?"), L("people.security.panel.unlink_body", "You won't be able to sign in with it any more."), L("people.security.panel.unlink", "Unlink")))) return;
        await withBusy(b, () => api(`/auth/identities/${b.dataset.unlink}`, { method: "DELETE" }));
        toast(L("people.security.panel.unlinked", "Account unlinked"), "success"); await safe(loadIdentities);
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });

  part("password-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await withBusy($("button", f), () => api("/auth/password", { method: "POST", body: { current_password: f.current_password.value, new_password: f.new_password.value } }));
      f.reset();
      toast(L("people.security.panel.password_changed", "Password changed. Other sessions have been signed out."), "success");
      await safe(loadSessions);
    } catch { /* already reported */ }
  });
}
