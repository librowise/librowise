// Sign-in page: password step, two-step verification (authenticator or recovery code), "forgot password"
// and single sign-on. Views are translated, errors are announced (role=alert) and focus moves to the
// first field of each step. #forgot opens the reset form directly (footer link).
import { $, $$, ApiError, api, html, icon, t } from "/static/js/core.js";
import { busy, wirePasswordToggles } from "/static/js/pages/opac/common.js";

const SSO_ERRORS = ["state", "denied", "provider", "provider_unreachable", "provider_error", "token_exchange", "signature", "audience",
  "issuer", "expired", "nonce", "invalid_token", "domain", "email_unverified", "no_account", "inactive", "not_allowed", "locked", "already_linked"];

const safeNext = (n) => (n && n.startsWith("/") && !n.startsWith("//") && !n.includes("\\") ? n : null);

/** POST without core.api's automatic redirect on 401 (wrong codes are expected here). */
async function post(path, body) {
  const res = await fetch(`/api/v1${path}`, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Plain-language message for a failed sign-in (never raw validation text). */
function loginMessage(ex) {
  if (ex.status === 401) return t("login.invalid");
  if (ex.status === 422) return t("login.missing");
  if (ex.status === 429) return t("opac.auth.too_many");
  return ex.message;
}

export default function init() {
  const params = new URLSearchParams(location.search);
  const next = safeNext(params.get("next"));
  const err = $("#login-error"), info = $("#login-info");
  let mfaToken = null, mfaNext = null, recovery = false;

  const showError = (msg) => { err.textContent = msg; err.classList.toggle("hidden", !msg); };
  const showInfo = (msg) => { info.textContent = msg; info.classList.toggle("hidden", !msg); };
  const VIEWS = {
    login: { title: t("login.heading"), sub: t("login.lead"), focus: "#username" },
    mfa: { title: t("opac.auth.mfa_title"), sub: t("opac.auth.mfa_lead"), focus: "#mfa-code" },
    forgot: { title: t("opac.auth.forgot_title"), sub: t("opac.auth.forgot_lead"), focus: "#identifier" },
  };
  const view = (name, { focus = true } = {}) => {
    for (const [id, v] of [["#login-form", "login"], ["#mfa-form", "mfa"], ["#forgot-form", "forgot"]]) $(id).classList.toggle("hidden", v !== name);
    $("#sso").classList.toggle("hidden", name !== "login" || !$("#sso-buttons").children.length);
    $("#demo-accounts")?.classList.toggle("hidden", name !== "login"); // not rendered in production
    $("#register-hint").classList.toggle("hidden", name === "mfa");
    $("#login-title").textContent = VIEWS[name].title;
    $("#login-sub").textContent = VIEWS[name].sub;
    document.title = `${VIEWS[name].title} · ${document.title.split(" · ").slice(1).join(" · ")}`;
    showError("");
    if (name !== "forgot") showInfo("");
    if (focus) $(VIEWS[name].focus)?.focus();
  };
  const finish = (r) => {
    const target = safeNext(r.next) || next;
    if (r.mfa_enrollment_required) location.href = "/staff/security?enroll=1";
    else location.href = target || (r.user.is_staff ? "/staff" : "/account");
  };
  const setRecovery = (on) => {
    recovery = on;
    const input = $("#mfa-code");
    input.value = "";
    input.inputMode = on ? "text" : "numeric";
    input.autocomplete = on ? "off" : "one-time-code";
    input.classList.toggle("recovery", on);
    $("#mfa-label").textContent = on ? t("opac.auth.recovery_code") : t("opac.auth.mfa_code");
    $("#mfa-hint").textContent = on ? t("opac.auth.recovery_hint") : t("opac.auth.mfa_hint");
    $("#mfa-toggle").textContent = on ? t("opac.auth.use_app") : t("opac.auth.use_recovery");
  };
  const startMfa = (token, nextUrl = null) => {
    mfaToken = token; mfaNext = nextUrl;
    setRecovery(false);
    view("mfa");
  };

  wirePasswordToggles();
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-demo]");
    if (b) {
      view("login", { focus: false });
      // Demo credentials are rendered by the server, and only outside production (web._show_demo_logins).
      [$("#username").value, $("#password").value] = [b.dataset.username, b.dataset.password];
      $("#login-form").requestSubmit();
    }
    const v = e.target.closest("[data-view]");
    if (v) {
      if (v.dataset.view === "forgot" && $("#username").value.trim()) $("#identifier").value = $("#username").value.trim();
      view(v.dataset.view);
    }
  });
  $("#mfa-toggle").addEventListener("click", () => { setRecovery(!recovery); $("#mfa-code").focus(); });

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    // Check locally: an empty field would otherwise surface the API's raw validation text.
    const blank = [$("#username"), $("#password")].find((i) => !i.value.trim());
    [$("#username"), $("#password")].forEach((i) => i.toggleAttribute("aria-invalid", i === blank));
    if (blank) { showError(t("login.missing")); blank.focus(); return; }
    const btn = $("button[type=submit]", e.target);
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    try {
      const r = await api("/auth/login", { method: "POST", body: { username: $("#username").value.trim(), password: $("#password").value } });
      if (r.mfa_required) { $("#password").value = ""; startMfa(r.mfa_token, next); return; }
      finish(r);
    } catch (ex) {
      showError(loginMessage(ex));
      $("#password").select();
      $("#password").focus();
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  });

  $("#mfa-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    const code = $("#mfa-code").value.trim().replace(/\s+/g, "");
    if (!code) { showError(t("opac.auth.enter_code")); $("#mfa-code").focus(); return; }
    try {
      const r = await busy($("button[type=submit]", e.target), () => post("/auth/mfa", { mfa_token: mfaToken, code }));
      finish({ ...r, next: safeNext(r.next) || mfaNext });
    } catch (ex) {
      $("#mfa-code").value = "";
      if (ex.status === 401 && /expired/i.test(ex.message)) { view("login"); showError(t("opac.auth.mfa_expired")); }
      else { showError(ex.status === 401 ? t("opac.auth.code_wrong") : ex.message); $("#mfa-code").focus(); }
    }
  });

  $("#forgot-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const identifier = $("#identifier").value.trim();
    if (!identifier) { showError(t("opac.auth.enter_identifier")); $("#identifier").focus(); return; }
    try {
      await busy($("button[type=submit]", e.target), () => post("/auth/password-reset", { identifier }));
      showError("");
      showInfo(t("opac.auth.link_sent"));
    } catch (ex) { showError(ex.message); }
  });

  // Single sign-on buttons
  api("/auth/sso/providers").then(({ results }) => {
    if (!results.length) return;
    const q = next ? `?next=${encodeURIComponent(next)}` : "";
    $("#sso-buttons").innerHTML = html`${results.map((p) => html`<a class="btn lg" href="/api/v1/auth/sso/${encodeURIComponent(p.id)}/login${q}">${icon("shield")}${t("opac.auth.continue_with", { provider: p.label })}</a>`)}`;
    if (!$("#login-form").classList.contains("hidden")) $("#sso").classList.remove("hidden");
  }).catch(() => {});

  // Returning from SSO: an error code, or a pending second factor (token in the fragment, never sent to servers).
  const ssoError = params.get("sso_error");
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("mfa")) {
    const token = hash.get("mfa");
    history.replaceState(null, "", location.pathname + location.search);
    startMfa(token, next);
  } else if (location.hash === "#forgot") {
    view("forgot");
  }
  if (ssoError) showError(SSO_ERRORS.includes(ssoError) ? t(`opac.auth.sso_${ssoError}`) : t("opac.auth.sso_failed"));
  $$("input").forEach((i) => i.addEventListener("input", () => { showError(""); i.removeAttribute("aria-invalid"); }));
}
