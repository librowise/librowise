import { $, api, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

// Demo accounts exist only in databases created with `python -m shelfwise seed`.
const DEMO = {
  admin: ["admin", "Shelfwise#Admin2026"],
  librarian: ["librarian", "Shelfwise#Staff2026"],
  patron: ["1000000001", "Reader#Demo2026"],
};

export default function init() {
  const form = $("#login-form");
  const err = $("#login-error");
  const next = new URLSearchParams(location.search).get("next");
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-demo]");
    if (!b) return;
    [$("#username").value, $("#password").value] = DEMO[b.dataset.demo];
    form.requestSubmit();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.classList.add("hidden");
    const username = $("#username").value.trim(), password = $("#password").value;
    if (!username || !password) {
      err.textContent = t("login.missing");
      err.classList.remove("hidden");
      (username ? $("#password") : $("#username")).focus();
      return;
    }
    const btn = $("button[type=submit]", form);
    try {
      const r = await withBusy(btn, () => api("/auth/login", {
        method: "POST", body: { username, password },
      }));
      const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
      location.href = safeNext || (r.user.is_staff ? "/staff" : "/account");
    } catch (ex) {
      err.textContent = ex.status === 401 ? t("login.invalid") : ex.message;
      err.classList.remove("hidden");
      $("#password").select();
    }
  });
}
