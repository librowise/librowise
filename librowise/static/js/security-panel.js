// Account security panel shared by the staff "My account / Security" page and the OPAC account settings tab:
// two-factor authentication, active sessions, sign-in history, linked SSO accounts and personal API tokens.
// Every string is translated (keys opac.sec.* in i18n/opac/<lang>.json).
import { $, $$, api, badge, confirmDialog, datetime, empty, html, icon, modal, raw, relative, skeleton, t, toast, withBusy } from "/static/js/core.js";

const SSO_ERRORS = ["already_linked", "domain", "link_session", "state", "denied"];

/** Short, human description of a user-agent string. */
export function device(ua) {
  if (!ua) return t("opac.sec.unknown_device");
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|python|httpx|okhttp|java/i.test(ua) ? t("opac.sec.api_client") : t("opac.sec.browser");
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? t("opac.sec.browser_on", { browser, os }) : browser;
}

const METHODS = { password: "opac.sec.m_password", "password+totp": "opac.sec.m_password_totp", "password+recovery": "opac.sec.m_password_recovery",
  password_reset: "opac.sec.m_password_reset", password_change: "opac.sec.m_password_change", "2fa": "opac.sec.m_2fa" };
function methodLabel(m) {
  if (!m) return "";
  if (METHODS[m]) return t(METHODS[m]);
  const sso = m.match(/^sso:(.+?)(\+.*)?$/);
  if (sso) return sso[2] ? t("opac.sec.m_sso_2fa", { provider: sso[1] }) : t("opac.sec.m_sso", { provider: sso[1] });
  return m;
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

const pwField = (needed) => (needed ? html`<div class="field"><label for="sec-pw">${t("opac.account.current_password")}</label>
  <input id="sec-pw" name="password" type="password" autocomplete="current-password" required></div>` : "");
const codeField = () => html`<div class="field"><label for="sec-code">${t("opac.sec.code_label")}</label>
  <input id="sec-code" name="code" autocomplete="one-time-code" inputmode="numeric" minlength="6" maxlength="11" required spellcheck="false" aria-describedby="sec-code-hint">
  <span class="hint" id="sec-code-hint">${t("opac.sec.code_hint")}</span></div>`;

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t("opac.sec.copied"), "success"); }
  catch { toast(t("opac.sec.copy_failed"), "error"); }
}

function showRecoveryCodes(codes) {
  const text = codes.join("\n");
  const body = html`<div class="stack">
    <div class="alert warn">${icon("alert")}<div>${t("opac.sec.codes_intro")} <strong>${t("opac.sec.codes_once")}</strong></div></div>
    <ul class="recovery-codes mono" aria-label="${t("opac.sec.codes_title")}">${codes.map((c) => html`<li>${c}</li>`)}</ul>
    <div class="row tight"><button type="button" class="btn sm" data-copy-codes>${icon("copy")}${t("opac.sec.copy")}</button>
      <button type="button" class="btn sm" data-download-codes>${icon("download")}${t("opac.sec.download")}</button></div></div>`;
  const p = modal({ title: t("opac.sec.codes_title"), body, submit: t("opac.sec.codes_saved") });
  const dlg = $$("dialog").at(-1);
  $("[data-copy-codes]", dlg).addEventListener("click", () => copy(text));
  $("[data-download-codes]", dlg).addEventListener("click", () => download("librowise-recovery-codes.txt", text));
  return p;
}

const th = (key) => html`<th scope="col">${t(key)}</th>`;

export async function mountSecurity(root, { enroll = false, password = false } = {}) {
  let me = null, mfa = null;
  root.innerHTML = html`<div class="stack security-panel">
    <div data-enroll></div>
    ${password ? html`<section class="card pad stack" aria-labelledby="sec-pw-h"><h3 id="sec-pw-h">${t("login.password")}</h3>
      <form class="stack" data-password-form>
        <div class="grid cols-2">
          <div class="field"><label for="sec-cur">${t("opac.account.current_password")}</label><input id="sec-cur" name="current_password" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="sec-new">${t("opac.account.new_password")}</label><input id="sec-new" name="new_password" type="password" autocomplete="new-password" minlength="10" required aria-describedby="sec-new-hint">
            <span class="hint" id="sec-new-hint">${t("opac.account.password_hint")}</span></div>
        </div>
        <div><button class="btn primary">${t("opac.account.change_password")}</button></div></form></section>` : ""}
    <section class="card pad stack" aria-labelledby="sec-mfa-h"><h3 id="sec-mfa-h">${icon("shield")} ${t("opac.sec.mfa_title")}</h3><div data-mfa>${raw(skeleton(2))}</div></section>
    <section class="card pad stack" aria-labelledby="sec-sess-h">
      <div class="row between"><h3 id="sec-sess-h">${t("opac.sec.sessions")}</h3>
        <div class="row tight"><button class="btn sm" data-revoke-others>${icon("logout")}${t("opac.sec.revoke_others")}</button>
          <button class="btn sm danger" data-revoke-everything>${t("opac.sec.revoke_all")}</button></div></div>
      <div data-sessions>${raw(skeleton(2))}</div></section>
    <section class="card pad stack hidden" aria-labelledby="sec-id-h" data-identities-card><h3 id="sec-id-h">${t("opac.sec.identities")}</h3><div data-identities></div></section>
    <section class="card pad stack" aria-labelledby="sec-tok-h">
      <div class="row between"><h3 id="sec-tok-h">${t("opac.sec.tokens")}</h3><button class="btn sm" data-new-token>${icon("plus")}${t("opac.sec.new_token")}</button></div>
      <p class="small muted">${t("opac.sec.tokens_intro")}</p>
      <div data-tokens>${raw(skeleton(2))}</div></section>
    <section class="card pad stack" aria-labelledby="sec-log-h"><h3 id="sec-log-h">${t("opac.sec.logins")}</h3><div data-logins>${raw(skeleton(3))}</div></section>
  </div>`;
  const part = (name) => $(`[data-${name}]`, root);

  async function loadMfa() {
    [me, mfa] = await Promise.all([api("/auth/me"), api("/auth/mfa")]);
    part("enroll").innerHTML = (enroll || me.mfa_enrollment_required) && !mfa.enabled
      ? html`<div class="alert warn" role="alert">${icon("shield")}<div><strong>${t("opac.sec.required_title")}</strong>
          ${t("opac.sec.required_body")}</div></div>` : "";
    part("mfa").innerHTML = mfa.enabled
      ? html`<div class="row between"><div class="stack tight"><div>${badge("ok", t("opac.sec.on"))} ${t("opac.sec.enabled_at", { date: datetime(mfa.enabled_at) })}</div>
          <div class="small muted">${t("opac.sec.codes_left", { count: mfa.recovery_codes_remaining })}</div></div>
          <div class="row tight"><button class="btn sm" data-mfa-codes>${t("opac.sec.new_codes")}</button>
          ${mfa.required ? html`<span class="small muted">${t("opac.sec.required_policy")}</span>` : html`<button class="btn sm danger" data-mfa-disable>${t("opac.sec.turn_off")}</button>`}</div></div>`
      : html`<div class="row between"><div class="stack tight"><div>${badge(mfa.required ? "bad" : "warn", t("opac.sec.off"))} ${t("opac.sec.off_body")}</div></div>
          <button class="btn primary sm" data-mfa-enable>${icon("shield")}${t("opac.sec.set_up")}</button></div>`;
  }

  async function loadSessions() {
    const { results } = await api("/auth/sessions");
    part("sessions").innerHTML = results.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-labelledby="sec-sess-h"><table class="table"><thead><tr>
      ${th("opac.sec.col_device")}${th("opac.sec.col_ip")}${th("opac.sec.col_signed_in")}${th("opac.sec.col_last_active")}<th scope="col"><span class="sr-only">${t("opac.sec.col_actions")}</span></th></tr></thead><tbody>
      ${results.map((s) => html`<tr><td><strong>${device(s.user_agent)}</strong>${s.current ? html` ${badge("info", t("opac.sec.this_browser"))}` : ""}
        <div class="tiny muted">${methodLabel(s.method)}</div></td><td class="mono small">${s.ip || "—"}</td>
        <td>${datetime(s.created_at)}</td><td>${relative(s.last_seen_at)}</td>
        <td class="right"><button class="btn sm ghost danger" data-revoke-session="${s.id}" data-current="${s.current ? 1 : 0}" aria-label="${t("opac.sec.sign_out_device", { device: device(s.user_agent) })}">${t("common.sign_out")}</button></td></tr>`)}
      </tbody></table></div>` : empty(t("opac.sec.no_sessions"), "clock");
  }

  async function loadLogins() {
    const { results } = await api("/auth/logins?limit=20");
    part("logins").innerHTML = results.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-labelledby="sec-log-h"><table class="table"><thead><tr>
      ${th("opac.sec.col_when")}${th("opac.sec.col_result")}${th("opac.sec.col_method")}${th("opac.sec.col_ip")}${th("opac.sec.col_device")}</tr></thead><tbody>
      ${results.map((e) => html`<tr><td>${datetime(e.at)}</td><td>${e.success ? badge("ok", t("opac.sec.success")) : badge("bad", e.reason === "locked" ? t("opac.sec.blocked") : t("opac.sec.failed"))}</td>
        <td>${methodLabel(e.method)}</td><td class="mono small">${e.ip || "—"}</td><td>${device(e.user_agent)}</td></tr>`)}
      </tbody></table></div>` : empty(t("opac.sec.no_logins"), "clock");
  }

  async function loadTokens() {
    const { results } = await api("/auth/tokens");
    part("tokens").innerHTML = results.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-labelledby="sec-tok-h"><table class="table"><thead><tr>
      ${th("opac.sec.col_name")}${th("opac.sec.col_scopes")}${th("opac.sec.col_created")}${th("opac.sec.col_last_used")}${th("opac.sec.col_expires")}<th scope="col"><span class="sr-only">${t("opac.sec.col_actions")}</span></th></tr></thead><tbody>
      ${results.map((x) => html`<tr><td><strong>${x.name}</strong><div class="tiny muted mono">${x.prefix}…</div></td>
        <td><div class="row tight">${x.scopes.map((s) => badge("info", s))}</div></td><td>${datetime(x.created_at)}</td>
        <td>${x.last_used_at ? html`${relative(x.last_used_at)}<div class="tiny muted mono">${x.last_used_ip || ""}</div>` : t("opac.sec.never")}</td>
        <td>${x.expires_at ? datetime(x.expires_at) : t("opac.sec.never")}</td>
        <td class="right"><button class="btn sm ghost danger" data-revoke-token="${x.id}" aria-label="${t("opac.sec.revoke_token", { name: x.name })}">${t("opac.sec.revoke")}</button></td></tr>`)}
      </tbody></table></div>` : empty(t("opac.sec.no_tokens"), "code");
  }

  async function loadIdentities() {
    const r = await api("/auth/identities");
    const linked = new Set(r.results.map((i) => i.provider));
    const card = part("identities-card");
    card.classList.toggle("hidden", !r.results.length && !r.providers.length);
    part("identities").innerHTML = html`${r.results.length ? html`<div class="stack tight">${r.results.map((i) => html`<div class="row between kv">
        <span><strong>${i.label}</strong> <span class="muted small">${i.email || ""}</span>
        <span class="tiny muted">· ${t("opac.sec.linked_at", { date: datetime(i.created_at) })}${i.last_login_at ? html` · ${t("opac.sec.last_used", { when: relative(i.last_login_at) })}` : ""}</span></span>
        <button class="btn sm ghost danger" data-unlink="${i.id}">${t("opac.sec.unlink")}</button></div>`)}</div>` : html`<p class="small muted">${t("opac.sec.no_identities")}</p>`}
      <div class="row tight">${r.providers.filter((p) => !linked.has(p.id)).map((p) => html`<button class="btn sm" data-link="${p.id}">${icon("plus")}${t("opac.sec.link", { provider: p.label })}</button>`)}</div>`;
  }

  const safe = (fn) => fn().catch((e) => { if (!e.toasted) toast(e.message, "error"); });
  await Promise.all([loadMfa, loadSessions, loadLogins, loadTokens, loadIdentities].map(safe));

  const params = new URLSearchParams(location.search);
  const ssoError = params.get("sso_error");
  if (ssoError) toast(SSO_ERRORS.includes(ssoError) ? t(`opac.sec.sso_${ssoError}`) : t("opac.sec.link_failed"), "error", 7000);

  async function enableMfa() {
    const step1 = formModal({ title: t("opac.sec.setup_title"), submit: t("opac.sec.continue"),
      body: html`<p>${t("opac.sec.confirm_you")}</p>${pwField(me?.has_password !== false)}` }, (fd) => api("/auth/mfa/setup", { method: "POST", body: { password: fd.get("password") || "" } }));
    const setup = await step1.done;
    if (!setup) return;
    const grouped = setup.secret.replace(/(.{4})/g, "$1 ").trim();
    const step2 = formModal({
      title: t("opac.sec.scan_title"), submit: t("opac.sec.verify_on"), wide: true,
      body: html`<div class="mfa-setup">
        <img class="qr" src="${setup.qr_svg}" alt="${t("opac.sec.qr_alt")}" width="200" height="200">
        <div class="stack">
          <ol class="small"><li>${t("opac.sec.step_open")}</li><li>${t("opac.sec.step_scan")}</li></ol>
          <div class="row tight"><code class="mono secret-key" aria-label="${t("opac.sec.setup_key")}">${grouped}</code>
            <button type="button" class="btn sm ghost" data-copy-secret aria-label="${t("opac.sec.copy_key")}">${icon("copy")}</button></div>
          <div class="field"><label for="mfa-activate-code">${t("opac.sec.enter_code")}</label>
            <input id="mfa-activate-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
        </div></div>`,
    }, (fd) => api("/auth/mfa/activate", { method: "POST", body: { code: String(fd.get("code") || "").trim() } }));
    $("[data-copy-secret]", step2.dlg).addEventListener("click", () => copy(setup.secret));
    const res = await step2.done;
    if (!res) return;
    await showRecoveryCodes(res.recovery_codes);
    toast(t("opac.sec.now_on"), "success");
    if (enroll || me?.mfa_enrollment_required) { location.href = "/staff"; return; }
    await safe(loadMfa);
  }

  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b || !root.contains(b)) return;
    try {
      if (b.hasAttribute("data-mfa-enable")) await enableMfa();
      else if (b.hasAttribute("data-mfa-disable")) {
        const r = await formModal({ title: t("opac.sec.off_title"), submit: t("opac.sec.turn_off"), danger: true,
          body: html`<p>${t("opac.sec.off_text")}</p>${pwField(me?.has_password !== false)}${codeField()}` },
        (fd) => api("/auth/mfa/disable", { method: "POST", body: { password: fd.get("password") || "", code: String(fd.get("code") || "").trim() } })).done;
        if (r) { toast(t("opac.sec.now_off"), "success"); await safe(loadMfa); }
      } else if (b.hasAttribute("data-mfa-codes")) {
        const r = await formModal({ title: t("opac.sec.codes_new_title"), submit: t("opac.sec.generate"),
          body: html`<p>${t("opac.sec.codes_new_text")}</p>${pwField(me?.has_password !== false)}${codeField()}` },
        (fd) => api("/auth/mfa/recovery-codes", { method: "POST", body: { password: fd.get("password") || "", code: String(fd.get("code") || "").trim() } })).done;
        if (r) { await showRecoveryCodes(r.recovery_codes); await safe(loadMfa); }
      } else if (b.dataset.revokeSession) {
        const current = b.dataset.current === "1";
        if (current && !(await confirmDialog(t("opac.sec.this_q"), t("opac.sec.this_text"), t("common.sign_out")))) return;
        await withBusy(b, () => api(`/auth/sessions/${b.dataset.revokeSession}`, { method: "DELETE" }));
        if (current) { location.href = "/login"; return; }
        toast(t("opac.sec.session_out"), "success"); await safe(loadSessions);
      } else if (b.hasAttribute("data-revoke-others")) {
        if (!(await confirmDialog(t("opac.sec.others_q"), t("opac.sec.others_text"), t("opac.sec.others_confirm")))) return;
        const r = await withBusy(b, () => api("/auth/sessions/revoke-all", { method: "POST", body: { include_current: false } }));
        toast(t("opac.sec.n_signed_out", { count: r.revoked }), "success"); await safe(loadSessions);
      } else if (b.hasAttribute("data-revoke-everything")) {
        if (!(await confirmDialog(t("opac.sec.all_q"), t("opac.sec.all_text"), t("opac.sec.revoke_all")))) return;
        await withBusy(b, () => api("/auth/sessions/revoke-all", { method: "POST", body: { include_current: true } }));
        location.href = "/login";
      } else if (b.dataset.revokeToken) {
        if (!(await confirmDialog(t("opac.sec.token_q"), t("opac.sec.token_text"), t("opac.sec.revoke")))) return;
        await withBusy(b, () => api(`/auth/tokens/${b.dataset.revokeToken}`, { method: "DELETE" }));
        toast(t("opac.sec.token_revoked"), "success"); await safe(loadTokens);
      } else if (b.hasAttribute("data-new-token")) {
        const { results: scopes } = await api("/auth/scopes");
        const r = await formModal({ title: t("opac.sec.token_title"), submit: t("opac.sec.token_create"), wide: true,
          body: html`<div class="stack"><div class="grid cols-2">
            <div class="field"><label for="tok-name">${t("opac.sec.col_name")}</label><input id="tok-name" name="name" maxlength="80" required placeholder="${t("opac.sec.token_name_ph")}"></div>
            <div class="field"><label for="tok-exp">${t("opac.sec.col_expires")}</label><select id="tok-exp" name="expires_days">
              <option value="30">${t("opac.sec.in_30")}</option><option value="90" selected>${t("opac.sec.in_90")}</option><option value="365">${t("opac.sec.in_365")}</option><option value="">${t("opac.sec.never")}</option></select></div></div>
            <fieldset class="scope-list"><legend>${t("opac.sec.col_scopes")} <span class="hint">${t("opac.sec.scopes_hint")}</span></legend>
              ${scopes.map((s) => html`<label class="checkbox"><input type="checkbox" name="scope" value="${s.code}"> <span><span class="mono">${s.code}</span>
                <span class="tiny muted">${s.description}</span></span></label>`)}</fieldset></div>` },
        (fd) => {
          const chosen = fd.getAll("scope");
          if (!chosen.length) throw new Error(t("opac.sec.choose_scope"));
          const days = fd.get("expires_days");
          return api("/auth/tokens", { method: "POST", body: { name: String(fd.get("name") || "").trim(), scopes: chosen, expires_days: days ? Number(days) : null } });
        }).done;
        if (!r) return;
        const p = modal({ title: t("opac.sec.token_copy_title"), submit: t("opac.sec.done"), body: html`<div class="stack">
          <div class="alert warn">${icon("alert")}<div>${t("opac.sec.token_once")}</div></div>
          <code class="mono secret-key" style="word-break:break-all">${r.token}</code>
          <div><button type="button" class="btn sm" data-copy-token>${icon("copy")}${t("opac.sec.copy_token")}</button></div>
          <p class="tiny muted">${t("opac.sec.use_as")} <span class="mono">Authorization: Bearer ${r.prefix}…</span></p></div>` });
        $("[data-copy-token]", $$("dialog").at(-1)).addEventListener("click", () => copy(r.token));
        await p;
        await safe(loadTokens);
      } else if (b.dataset.link) {
        const r = await withBusy(b, () => api(`/auth/sso/${encodeURIComponent(b.dataset.link)}/link`, { method: "POST" }));
        location.href = r.redirect;
      } else if (b.dataset.unlink) {
        if (!(await confirmDialog(t("opac.sec.unlink_q"), t("opac.sec.unlink_text"), t("opac.sec.unlink")))) return;
        await withBusy(b, () => api(`/auth/identities/${b.dataset.unlink}`, { method: "DELETE" }));
        toast(t("opac.sec.unlinked"), "success"); await safe(loadIdentities);
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });

  part("password-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await withBusy($("button", f), () => api("/auth/password", { method: "POST", body: { current_password: f.current_password.value, new_password: f.new_password.value } }));
      f.reset();
      toast(t("opac.account.password_updated"), "success");
      await safe(loadSessions);
    } catch { /* already reported */ }
  });
}
