import { $, withBusy } from "/static/js/core.js";

// The reset token travels in the URL fragment, so it never reaches server logs or Referer headers.
export default function init() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  const err = $("#reset-error");
  if (!token) {
    $("#reset-form").classList.add("hidden");
    $("#reset-missing").classList.remove("hidden");
    return;
  }
  $("#new-password").focus();
  $("#reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    err.classList.add("hidden");
    const pw = $("#new-password").value, again = $("#confirm-password").value;
    const fail = (msg) => { err.textContent = msg; err.classList.remove("hidden"); };
    if (pw.length < 10) return fail("The new password must be at least 10 characters.");
    if (pw !== again) return fail("The two passwords don't match.");
    try {
      await withBusy($("button[type=submit]", e.target), async () => {
        const res = await fetch("/api/v1/auth/password-reset/confirm", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ token, new_password: pw }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
      });
      $("#reset-form").classList.add("hidden");
      $("#reset-done").classList.remove("hidden");
    } catch (ex) { fail(ex.message); }
  });
}
