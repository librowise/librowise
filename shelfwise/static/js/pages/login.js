import { $, $$, ApiError, api, html, icon, withBusy } from "/static/js/core.js";

// Demo accounts exist only in databases created with `python -m shelfwise seed`.
const DEMO = {
  admin: ["admin", "Shelfwise#Admin2026"],
  librarian: ["librarian", "Shelfwise#Staff2026"],
  patron: ["1000000001", "Reader#Demo2026"],
};

const SSO_ERRORS = {
  state: "The sign-in attempt expired or was started in another window. Please try again.",
  denied: "Sign-in was cancelled at the identity provider.",
  provider: "That sign-in provider is not available.",
  provider_unreachable: "The identity provider could not be reached. Please try again later.",
  provider_error: "The identity provider returned an unexpected response.",
  token_exchange: "The identity provider rejected the sign-in. Please try again.",
  signature: "The identity provider's response could not be verified.",
  audience: "The identity provider's response was not meant for this library.",
  issuer: "The identity provider's response came from an unexpected issuer.",
  expired: "The identity provider's response has expired. Please try again.",
  nonce: "The sign-in response did not match this attempt. Please try again.",
  invalid_token: "The identity provider's response was invalid.",
  domain: "Your e-mail domain is not allowed to sign in with this provider.",
  email_unverified: "Your identity provider did not confirm your e-mail address.",
  no_account: "No library account matches your e-mail address. Please contact the library.",
  inactive: "This library account is not active.",
  not_allowed: "Your account type cannot sign in with this provider.",
  locked: "This account is temporarily locked. Try again later or reset your password.",
  already_linked: "That external account is already linked to another library account.",
};

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

export default function init() {
  const params = new URLSearchParams(location.search);
  const next = safeNext(params.get("next"));
  const err = $("#login-error"), info = $("#login-info");
  let mfaToken = null, mfaNext = null, recovery = false;

  const showError = (msg) => { err.textContent = msg; err.classList.toggle("hidden", !msg); };
  const showInfo = (msg) => { info.textContent = msg; info.classList.toggle("hidden", !msg); };
  const view = (name) => {
    for (const [id, v] of [["#login-form", "login"], ["#mfa-form", "mfa"], ["#forgot-form", "forgot"]]) $(id).classList.toggle("hidden", v !== name);
    $("#sso").classList.toggle("hidden", name !== "login" || !$("#sso-buttons").children.length);
    $("#demo-accounts").classList.toggle("hidden", name !== "login");
    $("#login-title").textContent = { login: "Welcome back", mfa: "Two-step verification", forgot: "Reset your password" }[name];
    $("#login-sub").textContent = {
      login: "Sign in with your library card number or email.",
      mfa: "Your account is protected with two-factor authentication.",
      forgot: "Enter your card number or the e-mail address on your account.",
    }[name];
    showError("");
    if (name !== "forgot") showInfo("");
    $({ login: "#username", mfa: "#mfa-code", forgot: "#identifier" }[name])?.focus();
  };
  const finish = (r) => {
    const target = safeNext(r.next) || next;
    if (r.mfa_enrollment_required) location.href = "/staff/security?enroll=1";
    else location.href = target || (r.user.is_staff ? "/staff" : "/account");
  };
  const startMfa = (token, nextUrl = null) => {
    mfaToken = token; mfaNext = nextUrl; recovery = false;
    setRecovery(false);
    view("mfa");
  };
  const setRecovery = (on) => {
    recovery = on;
    const input = $("#mfa-code");
    input.value = "";
    input.inputMode = on ? "text" : "numeric";
    input.autocomplete = on ? "off" : "one-time-code";
    $("#mfa-label").textContent = on ? "Recovery code" : "Authentication code";
    $("#mfa-hint").textContent = on ? "Enter one of your saved recovery codes (e.g. 1a2b3-c4d5e). Each code works once."
      : "Enter the 6-digit code from your authenticator app.";
    $("#mfa-toggle").textContent = on ? "Use my authenticator app instead" : "Use a recovery code instead";
  };

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-demo]");
    if (b) {
      view("login");
      [$("#username").value, $("#password").value] = DEMO[b.dataset.demo];
      $("#login-form").requestSubmit();
    }
    const v = e.target.closest("[data-view]");
    if (v) view(v.dataset.view);
  });
  $("#mfa-toggle").addEventListener("click", () => { setRecovery(!recovery); $("#mfa-code").focus(); });

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    try {
      const r = await withBusy($("button[type=submit]", e.target), () => api("/auth/login", {
        method: "POST", body: { username: $("#username").value.trim(), password: $("#password").value },
      }));
      if (r.mfa_required) { $("#password").value = ""; startMfa(r.mfa_token, next); return; }
      finish(r);
    } catch (ex) { showError(ex.message); }
  });

  $("#mfa-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    const code = $("#mfa-code").value.trim();
    if (!code) { showError("Enter your code."); return; }
    try {
      const r = await withBusy($("button[type=submit]", e.target), () => post("/auth/mfa", { mfa_token: mfaToken, code }));
      finish({ ...r, next: safeNext(r.next) || mfaNext });
    } catch (ex) {
      $("#mfa-code").value = "";
      if (ex.status === 401 && /expired/i.test(ex.message)) { view("login"); showError(ex.message); } else showError(ex.message);
    }
  });

  $("#forgot-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const identifier = $("#identifier").value.trim();
    if (!identifier) { showError("Enter your card number or e-mail address."); return; }
    try {
      const r = await withBusy($("button[type=submit]", e.target), () => post("/auth/password-reset", { identifier }));
      showError("");
      showInfo(r.message);
    } catch (ex) { showError(ex.message); }
  });

  // Single sign-on buttons
  api("/auth/sso/providers").then(({ results }) => {
    if (!results.length) return;
    const q = next ? `?next=${encodeURIComponent(next)}` : "";
    $("#sso-buttons").innerHTML = html`${results.map((p) => html`<a class="btn lg" href="/api/v1/auth/sso/${encodeURIComponent(p.id)}/login${q}">${icon("shield")}Continue with ${p.label}</a>`)}`;
    if (!$("#login-form").classList.contains("hidden")) $("#sso").classList.remove("hidden");
  }).catch(() => {});

  // Returning from SSO: an error code, or a pending second factor (token in the fragment, never sent to servers).
  const ssoError = params.get("sso_error");
  if (ssoError) showError(SSO_ERRORS[ssoError] || "Single sign-on failed. Please try again.");
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("mfa")) {
    const token = hash.get("mfa");
    history.replaceState(null, "", location.pathname + location.search);
    startMfa(token, next);
  }
  $$("input").forEach((i) => i.addEventListener("input", () => showError("")));
}
