// OPAC: self-registration form (staff approve new accounts).
import { $, api, html, icon, withBusy } from "/static/js/core.js";

export default async function init() {
  const form = $("#register-form");
  if (!form) return;
  const err = $("#register-error");
  try {
    const { branches } = await api("/lookups");
    $("#rg-br").innerHTML = html`<option value="">Choose a branch…</option>${branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}`;
  } catch (e) { err.textContent = e.message; err.classList.remove("hidden"); }

  const pw2 = $("#rg-pw2");
  const checkMatch = () => pw2.setCustomValidity(pw2.value && pw2.value !== $("#rg-pw").value ? "Passwords do not match" : "");
  pw2.addEventListener("input", checkMatch);
  $("#rg-pw").addEventListener("input", checkMatch);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.classList.add("hidden");
    checkMatch();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const d = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
    const body = {
      first_name: d.first_name, last_name: d.last_name, email: d.email, phone: d.phone || null, address: d.address || null,
      date_of_birth: d.date_of_birth || null, home_branch_id: Number(d.home_branch_id), password: $("#rg-pw").value,
      website: d.website || null,
    };
    try {
      const r = await withBusy($("button[type=submit]", form), () => api("/opac/register", { method: "POST", body }));
      $("#register-card").innerHTML = html`<div class="stack" role="status">
        <div class="alert ok">${icon("check")}<div><strong>Registration received.</strong> ${r.message}</div></div>
        <p class="muted">You can browse the catalogue in the meantime.</p>
        <div class="row tight"><a class="btn primary" href="/search">Browse the catalogue</a><a class="btn" href="/">Home</a></div></div>`;
      $("#register-card").focus?.();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
      err.scrollIntoView({ block: "nearest" });
    }
  });
}
