// Choose a new password. The reset token travels in the URL fragment, so it never reaches server logs or
// Referer headers.
import { $, $$, t } from "/static/js/core.js";
import { busy, passwordMeter, pwToggle, wirePasswordMeter, wirePasswordToggles } from "/static/js/pages/opac/common.js";

export default function init() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  const err = $("#reset-error");
  if (!token) {
    $("#reset-form").classList.add("hidden");
    $("#reset-missing").classList.remove("hidden");
    return;
  }
  $$("[data-pw-toggle-slot]").forEach((slot) => { slot.outerHTML = pwToggle(slot.dataset.pwToggleSlot); });
  $("[data-pw-meter]").outerHTML = passwordMeter("new-password");
  wirePasswordToggles();
  const strength = wirePasswordMeter($("#new-password"));
  $("#new-password").focus();
  const fail = (msg, field) => { err.textContent = msg; err.classList.remove("hidden"); field?.setAttribute("aria-invalid", "true"); field?.focus(); };
  $$("#reset-form input").forEach((i) => i.addEventListener("input", () => { err.classList.add("hidden"); i.removeAttribute("aria-invalid"); }));
  $("#reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    err.classList.add("hidden");
    const pw = $("#new-password").value, again = $("#confirm-password").value;
    if (!strength().ok) return fail(t("opac.reg.err_password"), $("#new-password"));
    if (pw !== again) return fail(t("opac.reg.err_password2"), $("#confirm-password"));
    try {
      await busy($("button[type=submit]", e.target), async () => {
        const res = await fetch("/api/v1/auth/password-reset/confirm", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ token, new_password: pw }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? t("opac.reset.expired") : data.detail || t("opac.reset.failed"));
      });
      $("#reset-form").classList.add("hidden");
      $("#reset-done").classList.remove("hidden");
      $("#reset-done a").focus();
    } catch (ex) { fail(ex.message); }
  });
}
