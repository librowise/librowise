// OPAC: self-registration (staff approve new accounts). Inline validation on blur and submit (errors are
// linked to their fields and the first one is focused), password strength meter, show/hide toggles.
import { $, $$, api, html, icon, t } from "/static/js/core.js";
import { setFieldError } from "/static/js/ui/form.js";
import { busy, passwordMeter, pwToggle, wirePasswordMeter, wirePasswordToggles } from "/static/js/pages/opac/common.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function init() {
  const form = $("#register-form");
  if (!form) return;
  const err = $("#register-error");
  $$("[data-pw-toggle-slot]").forEach((slot) => { slot.outerHTML = pwToggle(slot.dataset.pwToggleSlot); });
  $("[data-pw-meter]").outerHTML = passwordMeter("rg-pw");
  wirePasswordToggles(form);
  const personal = () => [form.first_name.value, form.last_name.value, form.email.value.split("@")[0]];
  const strength = wirePasswordMeter($("#rg-pw"), { personal });

  try {
    const { branches } = await api("/lookups");
    $("#rg-br").insertAdjacentHTML("beforeend", html`${branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}`);
    if (branches.length === 1) $("#rg-br").value = String(branches[0].id);
  } catch (e) { err.textContent = e.message; err.classList.remove("hidden"); }

  const RULES = {
    first_name: (v) => (v.trim() ? "" : t("opac.reg.err_first")),
    last_name: (v) => (v.trim() ? "" : t("opac.reg.err_last")),
    email: (v) => (!v.trim() ? t("opac.reg.err_email_missing") : EMAIL.test(v.trim()) ? "" : t("opac.reg.err_email")),
    date_of_birth: (v) => (v && new Date(v) > new Date() ? t("opac.reg.err_dob") : ""),
    home_branch_id: (v) => (v ? "" : t("opac.reg.err_branch")),
    password: () => (strength().ok && strength().rules.personal ? "" : t("opac.reg.err_password")),
    password2: (v) => (!v ? t("opac.reg.err_password2_missing") : v === $("#rg-pw").value ? "" : t("opac.reg.err_password2")),
  };
  const touched = new Set();
  const check = (input) => {
    const rule = RULES[input.name];
    if (!rule) return true;
    const msg = rule(input.value);
    setFieldError(input, msg);
    return !msg;
  };
  form.addEventListener("focusout", (e) => { if (RULES[e.target.name] && e.target.value) { touched.add(e.target.name); check(e.target); } });
  form.addEventListener("input", (e) => {
    if (touched.has(e.target.name)) check(e.target);
    if (e.target.name === "password" && touched.has("password2")) check(form.password2);
    err.classList.add("hidden");
  });
  form.addEventListener("change", (e) => { if (e.target.tagName === "SELECT") { touched.add(e.target.name); check(e.target); } });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.classList.add("hidden");
    const fields = Object.keys(RULES).map((n) => form.elements[n]);
    const bad = fields.filter((i) => !check(i));
    fields.forEach((i) => touched.add(i.name));
    if (bad.length) {
      err.textContent = t("opac.reg.fix_n", { count: bad.length });
      err.classList.remove("hidden");
      bad[0].focus();
      return;
    }
    const d = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
    const body = {
      first_name: d.first_name, last_name: d.last_name, email: d.email, phone: d.phone || null, address: d.address || null,
      date_of_birth: d.date_of_birth || null, home_branch_id: Number(d.home_branch_id), password: $("#rg-pw").value,
      website: d.website || null,
    };
    try {
      await busy($("button[type=submit]", form), () => api("/opac/register", { method: "POST", body }));
      const card = $("#register-card");
      card.innerHTML = html`<div class="reg-done" role="status">
        <span class="done-ic" aria-hidden="true">${icon("check")}</span>
        <h1>${t("opac.reg.done_title")}</h1>
        <p class="lead" style="margin:0">${t("opac.reg.done_body", { email: d.email })}</p>
        <p class="small muted" style="margin:0">${t("opac.reg.done_next")}</p>
        <div class="row tight" style="justify-content:center"><a class="btn primary" href="/search">${icon("search")}${t("opac.reg.done_browse")}</a><a class="btn" href="/">${t("opac.reg.done_home")}</a></div></div>`;
      card.focus();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
      err.scrollIntoView({ block: "nearest" });
    }
  });
}
