// Account security panel shared by the staff "My account / Security" page and the OPAC account settings tab:
// two-factor authentication, active sessions, sign-in history, linked SSO accounts and personal API tokens.
import { $, $$, api, badge, confirmDialog, datetime, empty, html, icon, modal, raw, relative, skeleton, toast, withBusy } from "/static/js/core.js";

const SSO_ERRORS = {
  already_linked: "That external account is already linked to another library account.",
  domain: "Your e-mail domain is not allowed for this provider.",
  link_session: "Linking must be finished in the same browser session. Please try again.",
  state: "The linking attempt expired. Please try again.",
  denied: "Linking was cancelled at the identity provider.",
};

/** Short, human description of a user-agent string. */
export function device(ua) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|python|httpx|okhttp|java/i.test(ua) ? "API client" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const methodLabel = (m) => (m || "").replace(/^password\+totp$/, "Password + authenticator").replace(/^password\+recovery$/, "Password + recovery code")
  .replace(/^password$/, "Password").replace(/^password_reset$/, "Password reset").replace(/^password_change$/, "Password change")
  .replace(/^2fa$/, "Second factor").replace(/^sso:(.+?)(\+.*)?$/, (_, p, rest) => `Single sign-on (${p})${rest ? " + 2FA" : ""}`);

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

const pwField = (needed) => (needed ? html`<div class="field"><label for="sec-pw">Current password</label>
  <input id="sec-pw" name="password" type="password" autocomplete="current-password" required></div>` : "");
const codeField = html`<div class="field"><label for="sec-code">Authentication or recovery code</label>
  <input id="sec-code" name="code" autocomplete="one-time-code" inputmode="numeric" minlength="6" maxlength="11" required spellcheck="false">
  <span class="hint">6-digit code from your authenticator app, or one of your recovery codes.</span></div>`;

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied to clipboard", "success"); }
  catch { toast("Copy failed — select the text and copy it manually", "error"); }
}

function showRecoveryCodes(codes) {
  const text = codes.join("\n");
  const body = html`<div class="stack">
    <div class="alert warn">${icon("alert")}<div>Save these codes somewhere safe — each one signs you in once if you lose your
      authenticator. <strong>They won't be shown again.</strong></div></div>
    <ul class="recovery-codes mono" aria-label="Recovery codes">${codes.map((c) => html`<li>${c}</li>`)}</ul>
    <div class="row tight"><button type="button" class="btn sm" data-copy-codes>${icon("copy")}Copy</button>
      <button type="button" class="btn sm" data-download-codes>${icon("download")}Download</button></div></div>`;
  const p = modal({ title: "Your recovery codes", body, submit: "I've saved them" });
  const dlg = $$("dialog").at(-1);
  $("[data-copy-codes]", dlg).addEventListener("click", () => copy(text));
  $("[data-download-codes]", dlg).addEventListener("click", () => download("librowise-recovery-codes.txt", text));
  return p;
}

export async function mountSecurity(root, { enroll = false, password = false } = {}) {
  let me = null, mfa = null;
  root.innerHTML = html`<div class="stack security-panel">
    <div data-enroll></div>
    ${password ? html`<section class="card pad stack" aria-labelledby="sec-pw-h"><h3 id="sec-pw-h">Password</h3>
      <form class="stack" data-password-form>
        <div class="grid cols-2">
          <div class="field"><label for="sec-cur">Current password</label><input id="sec-cur" name="current_password" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="sec-new">New password</label><input id="sec-new" name="new_password" type="password" autocomplete="new-password" minlength="10" required>
            <span class="hint">At least 10 characters, mixing three of: lowercase, uppercase, digits, symbols.</span></div>
        </div>
        <div><button class="btn primary">Change password</button></div></form></section>` : ""}
    <section class="card pad stack" aria-labelledby="sec-mfa-h"><h3 id="sec-mfa-h">${icon("shield")} Two-factor authentication</h3><div data-mfa>${raw(skeleton(2))}</div></section>
    <section class="card pad stack" aria-labelledby="sec-sess-h">
      <div class="row between"><h3 id="sec-sess-h">Active sessions</h3>
        <div class="row tight"><button class="btn sm" data-revoke-others>${icon("logout")}Sign out other sessions</button>
          <button class="btn sm danger" data-revoke-everything>Sign out everywhere</button></div></div>
      <div data-sessions>${raw(skeleton(2))}</div></section>
    <section class="card pad stack hidden" aria-labelledby="sec-id-h" data-identities-card><h3 id="sec-id-h">Linked sign-in accounts</h3><div data-identities></div></section>
    <section class="card pad stack" aria-labelledby="sec-tok-h">
      <div class="row between"><h3 id="sec-tok-h">Personal API tokens</h3><button class="btn sm" data-new-token>${icon("plus")}New token</button></div>
      <p class="small muted">Tokens let scripts and integrations call the Librowise API as you, limited to the scopes you choose. Treat them like passwords.</p>
      <div data-tokens>${raw(skeleton(2))}</div></section>
    <section class="card pad stack" aria-labelledby="sec-log-h"><h3 id="sec-log-h">Recent sign-in activity</h3><div data-logins>${raw(skeleton(3))}</div></section>
  </div>`;
  const part = (name) => $(`[data-${name}]`, root);

  async function loadMfa() {
    [me, mfa] = await Promise.all([api("/auth/me"), api("/auth/mfa")]);
    part("enroll").innerHTML = (enroll || me.mfa_enrollment_required) && !mfa.enabled
      ? html`<div class="alert warn" role="alert">${icon("shield")}<div><strong>Two-factor authentication is required.</strong>
          Your library requires staff accounts to use an authenticator app. Set it up below to continue to the staff interface.</div></div>` : "";
    part("mfa").innerHTML = mfa.enabled
      ? html`<div class="row between"><div class="stack tight"><div>${badge("ok", "On")} Authenticator app · enabled ${datetime(mfa.enabled_at)}</div>
          <div class="small muted">${mfa.recovery_codes_remaining} unused recovery code${mfa.recovery_codes_remaining === 1 ? "" : "s"} left.</div></div>
          <div class="row tight"><button class="btn sm" data-mfa-codes>New recovery codes</button>
          ${mfa.required ? html`<span class="small muted">Required by library policy</span>` : html`<button class="btn sm danger" data-mfa-disable>Turn off</button>`}</div></div>`
      : html`<div class="row between"><div class="stack tight"><div>${badge(mfa.required ? "bad" : "warn", "Off")} Protect your account with a 6-digit code from an authenticator app
          (Google Authenticator, Microsoft Authenticator, 1Password, Aegis…).</div></div>
          <button class="btn primary sm" data-mfa-enable>${icon("shield")}Set up</button></div>`;
  }

  async function loadSessions() {
    const { results } = await api("/auth/sessions");
    part("sessions").innerHTML = results.length ? html`<div class="table-wrap"><table class="table"><thead><tr>
      <th>Device</th><th>IP address</th><th>Signed in</th><th>Last active</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${results.map((s) => html`<tr><td><strong>${device(s.user_agent)}</strong>${s.current ? html` ${badge("info", "This browser")}` : ""}
        <div class="tiny muted">${methodLabel(s.method)}</div></td><td class="mono small">${s.ip || "—"}</td>
        <td>${datetime(s.created_at)}</td><td>${relative(s.last_seen_at)}</td>
        <td class="right"><button class="btn sm ghost danger" data-revoke-session="${s.id}" data-current="${s.current ? 1 : 0}">Sign out</button></td></tr>`)}
      </tbody></table></div>` : empty("No active sessions.", "clock");
  }

  async function loadLogins() {
    const { results } = await api("/auth/logins?limit=20");
    part("logins").innerHTML = results.length ? html`<div class="table-wrap"><table class="table"><thead><tr>
      <th>When</th><th>Result</th><th>Method</th><th>IP address</th><th>Device</th></tr></thead><tbody>
      ${results.map((e) => html`<tr><td>${datetime(e.at)}</td><td>${e.success ? badge("ok", "Success") : badge("bad", e.reason === "locked" ? "Blocked (locked)" : "Failed")}</td>
        <td>${methodLabel(e.method)}</td><td class="mono small">${e.ip || "—"}</td><td>${device(e.user_agent)}</td></tr>`)}
      </tbody></table></div>` : empty("No sign-in activity recorded yet.", "clock");
  }

  async function loadTokens() {
    const { results } = await api("/auth/tokens");
    part("tokens").innerHTML = results.length ? html`<div class="table-wrap"><table class="table"><thead><tr>
      <th>Name</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Expires</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${results.map((t) => html`<tr><td><strong>${t.name}</strong><div class="tiny muted mono">${t.prefix}…</div></td>
        <td><div class="row tight">${t.scopes.map((s) => badge("info", s))}</div></td><td>${datetime(t.created_at)}</td>
        <td>${t.last_used_at ? html`${relative(t.last_used_at)}<div class="tiny muted mono">${t.last_used_ip || ""}</div>` : "Never"}</td>
        <td>${t.expires_at ? datetime(t.expires_at) : "Never"}</td>
        <td class="right"><button class="btn sm ghost danger" data-revoke-token="${t.id}">Revoke</button></td></tr>`)}
      </tbody></table></div>` : empty("No API tokens.", "code");
  }

  async function loadIdentities() {
    const r = await api("/auth/identities");
    const linked = new Set(r.results.map((i) => i.provider));
    const card = part("identities-card");
    card.classList.toggle("hidden", !r.results.length && !r.providers.length);
    part("identities").innerHTML = html`${r.results.length ? html`<div class="stack tight">${r.results.map((i) => html`<div class="row between kv">
        <span><strong>${i.label}</strong> <span class="muted small">${i.email || ""}</span>
        <span class="tiny muted">· linked ${datetime(i.created_at)}${i.last_login_at ? html` · last used ${relative(i.last_login_at)}` : ""}</span></span>
        <button class="btn sm ghost danger" data-unlink="${i.id}">Unlink</button></div>`)}</div>` : html`<p class="small muted">No external accounts linked.</p>`}
      <div class="row tight">${r.providers.filter((p) => !linked.has(p.id)).map((p) => html`<button class="btn sm" data-link="${p.id}">${icon("plus")}Link ${p.label}</button>`)}</div>`;
  }

  const safe = (fn) => fn().catch((e) => { if (!e.toasted) toast(e.message, "error"); });
  await Promise.all([loadMfa, loadSessions, loadLogins, loadTokens, loadIdentities].map(safe));

  const params = new URLSearchParams(location.search);
  if (params.get("sso_error")) toast(SSO_ERRORS[params.get("sso_error")] || "Linking the account failed.", "error", 7000);

  async function enableMfa() {
    const step1 = formModal({ title: "Set up two-factor authentication", submit: "Continue",
      body: html`<p>Confirm it's you to start.</p>${pwField(me?.has_password !== false)}` }, (fd) => api("/auth/mfa/setup", { method: "POST", body: { password: fd.get("password") || "" } }));
    const setup = await step1.done;
    if (!setup) return;
    const grouped = setup.secret.replace(/(.{4})/g, "$1 ").trim();
    const step2 = formModal({
      title: "Scan with your authenticator app", submit: "Verify & turn on", wide: true,
      body: html`<div class="mfa-setup">
        <img class="qr" src="${setup.qr_svg}" alt="QR code for adding this account to an authenticator app" width="200" height="200">
        <div class="stack">
          <ol class="small"><li>Open your authenticator app and add an account.</li><li>Scan the QR code — or enter this key manually:</li></ol>
          <div class="row tight"><code class="mono secret-key" aria-label="Setup key">${grouped}</code>
            <button type="button" class="btn sm ghost" data-copy-secret aria-label="Copy setup key">${icon("copy")}</button></div>
          <div class="field"><label for="mfa-activate-code">Enter the 6-digit code it shows</label>
            <input id="mfa-activate-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
        </div></div>`,
    }, (fd) => api("/auth/mfa/activate", { method: "POST", body: { code: String(fd.get("code") || "").trim() } }));
    $("[data-copy-secret]", step2.dlg).addEventListener("click", () => copy(setup.secret));
    const res = await step2.done;
    if (!res) return;
    await showRecoveryCodes(res.recovery_codes);
    toast("Two-factor authentication is on", "success");
    if (enroll || me?.mfa_enrollment_required) { location.href = "/staff"; return; }
    await safe(loadMfa);
  }

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t || !root.contains(t)) return;
    try {
      if (t.hasAttribute("data-mfa-enable")) await enableMfa();
      else if (t.hasAttribute("data-mfa-disable")) {
        const r = await formModal({ title: "Turn off two-factor authentication", submit: "Turn off", danger: true,
          body: html`<p>Your account will be protected by your password only.</p>${pwField(me?.has_password !== false)}${codeField}` },
        (fd) => api("/auth/mfa/disable", { method: "POST", body: { password: fd.get("password") || "", code: String(fd.get("code") || "").trim() } })).done;
        if (r) { toast("Two-factor authentication turned off", "success"); await safe(loadMfa); }
      } else if (t.hasAttribute("data-mfa-codes")) {
        const r = await formModal({ title: "Generate new recovery codes", submit: "Generate",
          body: html`<p>Your existing recovery codes will stop working.</p>${pwField(me?.has_password !== false)}${codeField}` },
        (fd) => api("/auth/mfa/recovery-codes", { method: "POST", body: { password: fd.get("password") || "", code: String(fd.get("code") || "").trim() } })).done;
        if (r) { await showRecoveryCodes(r.recovery_codes); await safe(loadMfa); }
      } else if (t.dataset.revokeSession) {
        const current = t.dataset.current === "1";
        if (current && !(await confirmDialog("Sign out this browser?", "You'll need to sign in again here.", "Sign out"))) return;
        await withBusy(t, () => api(`/auth/sessions/${t.dataset.revokeSession}`, { method: "DELETE" }));
        if (current) { location.href = "/login"; return; }
        toast("Session signed out", "success"); await safe(loadSessions);
      } else if (t.hasAttribute("data-revoke-others")) {
        if (!(await confirmDialog("Sign out other sessions?", "Every other browser and device signed in to your account will be signed out.", "Sign out others"))) return;
        const r = await withBusy(t, () => api("/auth/sessions/revoke-all", { method: "POST", body: { include_current: false } }));
        toast(`${r.revoked} session(s) signed out`, "success"); await safe(loadSessions);
      } else if (t.hasAttribute("data-revoke-everything")) {
        if (!(await confirmDialog("Sign out everywhere?", "All sessions, including this one, will be signed out.", "Sign out everywhere"))) return;
        await withBusy(t, () => api("/auth/sessions/revoke-all", { method: "POST", body: { include_current: true } }));
        location.href = "/login";
      } else if (t.dataset.revokeToken) {
        if (!(await confirmDialog("Revoke token?", "Integrations using it will stop working immediately.", "Revoke"))) return;
        await withBusy(t, () => api(`/auth/tokens/${t.dataset.revokeToken}`, { method: "DELETE" }));
        toast("Token revoked", "success"); await safe(loadTokens);
      } else if (t.hasAttribute("data-new-token")) {
        const { results: scopes } = await api("/auth/scopes");
        const r = await formModal({ title: "New personal API token", submit: "Create token", wide: true,
          body: html`<div class="stack"><div class="grid cols-2">
            <div class="field"><label for="tok-name">Name</label><input id="tok-name" name="name" maxlength="80" required placeholder="e.g. Discovery layer sync"></div>
            <div class="field"><label for="tok-exp">Expires</label><select id="tok-exp" name="expires_days">
              <option value="30">In 30 days</option><option value="90" selected>In 90 days</option><option value="365">In 1 year</option><option value="">Never</option></select></div></div>
            <fieldset class="scope-list"><legend>Scopes <span class="hint">(choose the least access the integration needs)</span></legend>
              ${scopes.map((s) => html`<label class="checkbox"><input type="checkbox" name="scope" value="${s.code}"> <span><span class="mono">${s.code}</span>
                <span class="tiny muted">${s.description}</span></span></label>`)}</fieldset></div>` },
        (fd) => {
          const chosen = fd.getAll("scope");
          if (!chosen.length) throw new Error("Choose at least one scope");
          const days = fd.get("expires_days");
          return api("/auth/tokens", { method: "POST", body: { name: String(fd.get("name") || "").trim(), scopes: chosen, expires_days: days ? Number(days) : null } });
        }).done;
        if (!r) return;
        const p = modal({ title: "Copy your new token", submit: "Done", body: html`<div class="stack">
          <div class="alert warn">${icon("alert")}<div>This is the only time the token is shown. Store it in your integration's secret store.</div></div>
          <code class="mono secret-key" style="word-break:break-all">${r.token}</code>
          <div><button type="button" class="btn sm" data-copy-token>${icon("copy")}Copy token</button></div>
          <p class="tiny muted">Use it as <span class="mono">Authorization: Bearer ${r.prefix}…</span></p></div>` });
        $("[data-copy-token]", $$("dialog").at(-1)).addEventListener("click", () => copy(r.token));
        await p;
        await safe(loadTokens);
      } else if (t.dataset.link) {
        const r = await withBusy(t, () => api(`/auth/sso/${encodeURIComponent(t.dataset.link)}/link`, { method: "POST" }));
        location.href = r.redirect;
      } else if (t.dataset.unlink) {
        if (!(await confirmDialog("Unlink account?", "You won't be able to sign in with it any more.", "Unlink"))) return;
        await withBusy(t, () => api(`/auth/identities/${t.dataset.unlink}`, { method: "DELETE" }));
        toast("Account unlinked", "success"); await safe(loadIdentities);
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });

  part("password-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await withBusy($("button", f), () => api("/auth/password", { method: "POST", body: { current_password: f.current_password.value, new_password: f.new_password.value } }));
      f.reset();
      toast("Password changed. Other sessions have been signed out.", "success");
      await safe(loadSessions);
    } catch { /* already reported */ }
  });
}


