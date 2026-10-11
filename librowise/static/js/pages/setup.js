// First-launch setup wizard (/setup): welcome (+ one-time setup code) · library · administrator (only while the
// server has none) · branches · lending rules · how to start the catalogue · review. Nothing is written until
// "Finish setup", which sends everything to POST /api/v1/setup/complete in one request (one transaction).
// Progress survives a reload or a language switch (sessionStorage, never the password or the setup code).
import { $, $$, ApiError, BOOT, api, html, icon, raw, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { passwordCheck, passwordMeter, pwToggle, wirePasswordMeter, wirePasswordToggles } from "/static/js/pages/opac/common.js";

const STORE = "librowise.setup.v1";
const KINDS = { public: "users", academic: "graduation", school: "book", special: "layers" };
const START_ICONS = { empty: "plus", sample: "sparkle", import: "upload" };
const CURRENCY = BOOT.currency || "INR";
const LOCALE = document.documentElement.lang || "en";

let root, steps = [], at = 0, info = null, presets = {};
let S = null;            // wizard answers
let secret = { code: "", password: "", confirm: "" };  // kept in memory only
let codeOk = false;
let resumeAt = 0;     // step to return to after re-entering the setup code (it is never stored)

// ------------------------------------------------------------------ helpers

/** Busy button without core's error toast: the wizard shows errors next to the fields instead. */
async function busy(btn, fn) {
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.insertAdjacentHTML("afterbegin", `<span class="spinner" aria-hidden="true"></span>`);
  try { return await fn(); } finally {
    btn.querySelector(":scope > .spinner")?.remove();
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

const minorDigits = (() => { try { return new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY }).resolvedOptions().maximumFractionDigits; } catch { return 2; } })();
const toMinor = (v) => Math.round(Number(String(v).replace(",", ".")) * 10 ** minorDigits);
const toMajor = (m) => (Number(m || 0) / 10 ** minorDigits).toFixed(minorDigits);
const money = (m) => { try { return new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY }).format(Number(m || 0) / 10 ** minorDigits); } catch { return toMajor(m); } };
const currencySymbol = (() => { try { return new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY }).formatToParts(0).find((p) => p.type === "currency")?.value || CURRENCY; } catch { return CURRENCY; } })();
const num = (v) => new Intl.NumberFormat(LOCALE).format(Number(v || 0));
const codeFrom = (name) => (name || "").normalize("NFKD").replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/)
  .map((w) => w.slice(0, 4)).join("").toUpperCase().slice(0, 8);

function save() {
  try { sessionStorage.setItem(STORE, JSON.stringify({ S, at: steps[at]?.key })); } catch { /* private mode: fine */ }
}
function load() {
  try { return JSON.parse(sessionStorage.getItem(STORE) || "null"); } catch { return null; }
}
function forget() {
  try { sessionStorage.removeItem(STORE); } catch { /* ignore */ }
}

function defaultsFor(kind) {
  const p = presets[kind] || presets.public;
  return { loan_days: p.loan_days, max_renewals: p.max_renewals, max_loans: p.max_loans, hold_pickup_days: p.hold_pickup_days,
    fine_per_day: p.fine_per_day, fine_cap: p.fine_cap };
}

function initialState(snap) {
  const rule = snap.default_rule;
  const branches = snap.branches.length
    ? snap.branches.map((b) => ({ ...b, autoCode: false }))
    : [{ id: null, code: "", name: "", address: "", email: "", phone: "", autoCode: true }];
  const s = {
    library: { name: snap.library_name || "", kind: "public" },
    admin: { first_name: "", last_name: "", username: "admin", email: "" },
    branches,
    loans: rule ? { ...defaultsFor("public"), ...rule } : defaultsFor("public"),
    loansTouched: !!rule,
    start: "empty",
  };
  // A server-created placeholder branch ("Main Library") gets the library's name once one is typed.
  s.branchPlaceholder = snap.branches.length === 1 && /^Main Library$/i.test(snap.branches[0].name);
  return s;
}

// ------------------------------------------------------------------ field errors

function setError(input, message) {
  if (!input) return;
  const id = `${input.id}-err`;
  let box = document.getElementById(id);
  if (!box) {
    box = document.createElement("div");
    box.className = "field-error";
    box.id = id;
    (input.closest(".pw-wrap") || input).after(box);
  }
  box.innerHTML = html`${icon("alert")}<span>${message}</span>`;
  box.hidden = false;
  input.setAttribute("aria-invalid", "true");
  const ids = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  ids.add(id);
  input.setAttribute("aria-describedby", [...ids].join(" "));
}
function clearErrors(scope) {
  $$("[aria-invalid]", scope).forEach((el) => el.removeAttribute("aria-invalid"));
  $$(".field-error", scope).forEach((el) => { el.hidden = true; });
  const summary = $("#step-alert", scope);
  if (summary) { summary.hidden = true; summary.textContent = ""; }
}
function failStep(scope, problems) {
  // problems: [[input, message]]; announce a summary once, then focus the first field.
  problems.forEach(([el, msg]) => setError(el, msg));
  const summary = $("#step-alert", scope);
  if (summary) {
    summary.innerHTML = html`${icon("alert")}<div>${problems.length === 1 ? t("setup.fix_one") : t("setup.fix_many", { count: problems.length })}</div>`;
    summary.hidden = false;
  }
  problems[0]?.[0]?.focus();
  return false;
}

// ------------------------------------------------------------------ steps

const field = (id, label, control, hint = "") => html`<div class="field">
  <label for="${id}">${label}</label>${control}${hint ? html`<span class="hint" id="${id}-hint">${hint}</span>` : ""}</div>`;

const STEP_DEFS = {
  welcome: {
    render() {
      const bootstrap = info.needs_admin;
      return html`<p class="setup-eyebrow">${t("setup.welcome.eyebrow")}</p>
        <h1 tabindex="-1">${t("setup.welcome.title")}</h1>
        <p class="lead">${bootstrap ? t("setup.welcome.lead_bootstrap") : t("setup.welcome.lead_admin")}</p>
        <ul class="setup-checklist">
          ${["library", ...(bootstrap ? ["admin"] : []), "branches", "lending", "start"].map((k) => html`<li>${icon("check-circle")}<span>${t(`setup.welcome.item_${k}`)}</span></li>`)}
        </ul>
        <p class="setup-time">${icon("clock")}${t("setup.welcome.time")}</p>
        ${bootstrap ? html`<div class="setup-code-box">
          ${field("setup-code", t("setup.welcome.code_label"),
            html`<input id="setup-code" name="code" class="setup-code-input" autocomplete="one-time-code" autocapitalize="characters"
              spellcheck="false" inputmode="text" maxlength="12" placeholder="XXXX-XXXX" required value="${secret.code}" aria-describedby="setup-code-hint">`,
            t("setup.welcome.code_hint"))}
          <details class="setup-help"><summary>${t("setup.welcome.code_where")}</summary>
            <p>${t("setup.welcome.code_where_log")}</p>
            <pre class="mono" tabindex="0">librowise setup-code</pre>
            <p>${t("setup.welcome.code_where_docker")}</p>
            <pre class="mono" tabindex="0">docker compose exec app python -m librowise setup-code</pre>
          </details></div>` : ""}`;
    },
    async validate(scope) {
      if (!info.needs_admin) return true;
      const input = $("#setup-code", scope);
      secret.code = input.value.trim();
      if (!/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(secret.code.replace(/\s/g, ""))) return failStep(scope, [[input, t("setup.err.code_format")]]);
      if (codeOk) return true;
      try {
        await api("/setup/verify", { method: "POST", body: { code: secret.code } });
        codeOk = true;
        return true;
      } catch (e) {
        return failStep(scope, [[input, e.status === 429 ? t("setup.err.code_rate") : t("setup.err.code_wrong")]]);
      }
    },
  },

  library: {
    render() {
      const kinds = Object.keys(KINDS);
      return html`<p class="setup-eyebrow">${t("setup.library.eyebrow")}</p>
        <h1 tabindex="-1">${t("setup.library.title")}</h1>
        <p class="lead">${t("setup.library.lead")}</p>
        ${field("lib-name", t("setup.library.name"),
          html`<input id="lib-name" name="name" required maxlength="120" autocomplete="organization" value="${S.library.name}" aria-describedby="lib-name-hint">`,
          t("setup.library.name_hint"))}
        <fieldset class="setup-choices">
          <legend>${t("setup.library.kind")}</legend>
          <p class="hint">${t("setup.library.kind_hint")}</p>
          <div class="setup-choice-grid">
            ${kinds.map((k) => html`<label class="setup-choice">
              <input type="radio" name="kind" value="${k}" ${S.library.kind === k ? raw("checked") : ""}>
              <span class="setup-choice-icon">${icon(KINDS[k])}</span>
              <span class="setup-choice-text"><strong>${t(`setup.kind.${k}`)}</strong><span>${t(`setup.kind.${k}_desc`)}</span></span>
            </label>`)}
          </div>
        </fieldset>`;
    },
    validate(scope) {
      const name = $("#lib-name", scope);
      const value = name.value.replace(/\s+/g, " ").trim();
      const kind = $("input[name=kind]:checked", scope)?.value || "public";
      if (!value) return failStep(scope, [[name, t("setup.err.library_name")]]);
      if (kind !== S.library.kind && !S.loansTouched) S.loans = defaultsFor(kind);
      S.library = { name: value, kind };
      if (S.branchPlaceholder && S.branches.length === 1) {
        S.branches[0].name = value;
        S.branchPlaceholder = false;
      } else if (S.branches.length === 1 && !S.branches[0].name && !S.branches[0].id) {
        S.branches[0].name = value;
        S.branches[0].code = codeFrom(value) || "MAIN";
      }
      return true;
    },
  },

  admin: {
    render() {
      const a = S.admin;
      return html`<p class="setup-eyebrow">${t("setup.admin.eyebrow")}</p>
        <h1 tabindex="-1">${t("setup.admin.title")}</h1>
        <p class="lead">${t("setup.admin.lead")}</p>
        <div class="setup-grid-2">
          ${field("adm-first", t("setup.admin.first_name"), html`<input id="adm-first" required maxlength="80" autocomplete="given-name" value="${a.first_name}">`)}
          ${field("adm-last", t("setup.admin.last_name"), html`<input id="adm-last" maxlength="80" autocomplete="family-name" value="${a.last_name}">`)}
        </div>
        <div class="setup-grid-2">
          ${field("adm-user", t("setup.admin.username"), html`<input id="adm-user" required maxlength="64" autocomplete="username" spellcheck="false" autocapitalize="none" value="${a.username}" aria-describedby="adm-user-hint">`, t("setup.admin.username_hint"))}
          ${field("adm-email", t("setup.admin.email"), html`<input id="adm-email" type="email" required maxlength="120" autocomplete="email" value="${a.email}" aria-describedby="adm-email-hint">`, t("setup.admin.email_hint"))}
        </div>
        <div class="field">
          <label for="adm-pw">${t("setup.admin.password")}</label>
          <div class="pw-wrap"><input id="adm-pw" type="password" required autocomplete="new-password" maxlength="256" value="${secret.password}" aria-describedby="adm-pw-rules">${pwToggle("adm-pw")}</div>
          ${passwordMeter("adm-pw")}
        </div>
        ${field("adm-pw2", t("setup.admin.confirm"), html`<div class="pw-wrap"><input id="adm-pw2" type="password" required autocomplete="new-password" maxlength="256" value="${secret.confirm}">${pwToggle("adm-pw2")}</div>`)}
        <div class="alert info setup-note">${icon("shield")}<div>${t("setup.admin.note_2fa")}</div></div>`;
    },
    mount(scope) {
      wirePasswordToggles(scope);
      wirePasswordMeter($("#adm-pw", scope), { personal: () => [$("#adm-user", scope).value, $("#adm-first", scope).value, ($("#adm-email", scope).value || "").split("@")[0]] });
    },
    validate(scope) {
      const get = (id) => $(id, scope);
      S.admin = { first_name: get("#adm-first").value.trim(), last_name: get("#adm-last").value.trim(),
        username: get("#adm-user").value.trim(), email: get("#adm-email").value.trim() };
      secret.password = get("#adm-pw").value;
      secret.confirm = get("#adm-pw2").value;
      const problems = [];
      if (!S.admin.first_name) problems.push([get("#adm-first"), t("setup.err.required")]);
      if (!/^[A-Za-z0-9._@-]{3,64}$/.test(S.admin.username)) problems.push([get("#adm-user"), t("setup.err.username")]);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(S.admin.email)) problems.push([get("#adm-email"), t("setup.err.email")]);
      const pw = passwordCheck(secret.password, [S.admin.username, S.admin.first_name, S.admin.email.split("@")[0]]);
      if (!pw.ok || !pw.rules.personal) problems.push([get("#adm-pw"), t("setup.err.password")]);
      else if (secret.password !== secret.confirm) problems.push([get("#adm-pw2"), t("setup.err.confirm")]);
      return problems.length ? failStep(scope, problems) : true;
    },
  },

  branches: {
    render() {
      return html`<p class="setup-eyebrow">${t("setup.branches.eyebrow")}</p>
        <h1 tabindex="-1">${t("setup.branches.title")}</h1>
        <p class="lead">${t("setup.branches.lead")}</p>
        <ol class="setup-branches" id="branch-list">${S.branches.map((b, i) => branchCard(b, i))}</ol>
        <button type="button" class="btn" id="branch-add">${icon("plus")}${t("setup.branches.add")}</button>
        <p class="hint">${t("setup.branches.later")}</p>`;
    },
    mount(scope) {
      $("#branch-add", scope).addEventListener("click", () => {
        readBranches(scope);
        S.branches.push({ id: null, code: "", name: "", address: "", email: "", phone: "", autoCode: true });
        rerender(() => $(`#br-name-${S.branches.length - 1}`)?.focus());
      });
      scope.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-remove-branch]");
        if (!btn) return;
        readBranches(scope);
        const i = Number(btn.dataset.removeBranch);
        const name = S.branches[i].name || t("setup.branches.untitled");
        S.branches.splice(i, 1);
        rerender(() => ($(`#br-name-${Math.max(0, i - 1)}`) || $("#branch-add"))?.focus());
        toast(t("setup.branches.removed", { name }), "info");
      });
      scope.addEventListener("input", (e) => {
        const m = e.target.id.match(/^br-(name|code)-(\d+)$/);
        if (!m) return;
        const i = Number(m[2]);
        if (m[1] === "code") S.branches[i].autoCode = false;
        else if (S.branches[i].autoCode) $(`#br-code-${i}`, scope).value = codeFrom(e.target.value);
      });
    },
    validate(scope) {
      readBranches(scope);
      const problems = [], seen = new Set();
      S.branches.forEach((b, i) => {
        if (!b.name) problems.push([$(`#br-name-${i}`, scope), t("setup.err.branch_name")]);
        if (!/^[A-Z0-9_-]{1,16}$/.test(b.code)) problems.push([$(`#br-code-${i}`, scope), t("setup.err.branch_code")]);
        else if (seen.has(b.code)) problems.push([$(`#br-code-${i}`, scope), t("setup.err.branch_code_dup")]);
        seen.add(b.code);
        if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) problems.push([$(`#br-email-${i}`, scope), t("setup.err.email")]);
      });
      return problems.length ? failStep(scope, problems) : true;
    },
  },

  lending: {
    render() {
      const L = S.loans, p = presets[S.library.kind] || presets.public;
      const numField = (key, unit, min, max, step = 1) => field(`ln-${key}`, t(`setup.lending.${key}`),
        html`<div class="setup-unit"><input id="ln-${key}" type="number" inputmode="numeric" min="${min}" max="${max}" step="${step}" required value="${L[key]}"><span>${unit}</span></div>`);
      const moneyField = (key) => field(`ln-${key}`, t(`setup.lending.${key}`),
        html`<div class="setup-unit currency"><span>${currencySymbol}</span><input id="ln-${key}" type="number" inputmode="decimal" min="0" step="${1 / 10 ** minorDigits}" required value="${toMajor(L[key])}"></div>`,
        key === "fine_per_day" ? t("setup.lending.no_fines_hint") : "");
      return html`<p class="setup-eyebrow">${t("setup.lending.eyebrow")}</p>
        <h1 tabindex="-1">${t("setup.lending.title")}</h1>
        <p class="lead">${t("setup.lending.lead", { kind: t(`setup.kind.${S.library.kind}`) })}</p>
        <div class="setup-grid-3">
          ${numField("loan_days", t("setup.unit.days"), 1, 365)}
          ${numField("max_renewals", t("setup.unit.times"), 0, 20)}
          ${numField("max_loans", t("setup.unit.items"), 1, 500)}
          ${numField("hold_pickup_days", t("setup.unit.days"), 1, 60)}
          ${moneyField("fine_per_day")}
          ${moneyField("fine_cap")}
        </div>
        <div class="setup-preview" aria-live="polite" id="ln-preview">${lendingSentence(L)}</div>
        <details class="setup-help"><summary>${t("setup.lending.also_title")}</summary>
          <p>${t("setup.lending.also_lead")}</p>
          <dl class="setup-dl">
            <dt>${t("setup.lending.item_types")}</dt><dd>${p.item_types.map((x) => t(`setup.itype.${x.code}`, {}, x.name)).join(", ")}</dd>
            <dt>${t("setup.lending.categories")}</dt><dd>${p.categories.map((x) => t(`setup.cat.${x.code}`, {}, x.name)).join(", ")}</dd>
          </dl>
          <p class="hint">${t("setup.lending.later")}</p>
        </details>
        <button type="button" class="btn ghost sm" id="ln-reset">${icon("refresh")}${t("setup.lending.reset", { kind: t(`setup.kind.${S.library.kind}`) })}</button>`;
    },
    mount(scope) {
      scope.addEventListener("input", () => {
        const L = readLoans(scope);
        if (L) $("#ln-preview", scope).innerHTML = lendingSentence(L);
      });
      $("#ln-reset", scope).addEventListener("click", () => {
        S.loans = defaultsFor(S.library.kind);
        S.loansTouched = false;
        rerender(() => $("#ln-loan_days")?.focus());
      });
    },
    validate(scope) {
      const problems = [];
      const ranges = { loan_days: [1, 365], max_renewals: [0, 20], max_loans: [1, 500], hold_pickup_days: [1, 60] };
      for (const [key, [lo, hi]] of Object.entries(ranges)) {
        const el = $(`#ln-${key}`, scope), v = Number(el.value);
        if (!Number.isInteger(v) || v < lo || v > hi) problems.push([el, t("setup.err.range", { min: num(lo), max: num(hi) })]);
      }
      for (const key of ["fine_per_day", "fine_cap"]) {
        const el = $(`#ln-${key}`, scope), v = Number(String(el.value).replace(",", "."));
        if (el.value === "" || !Number.isFinite(v) || v < 0) problems.push([el, t("setup.err.money")]);
      }
      if (problems.length) return failStep(scope, problems);
      const L = readLoans(scope);
      if (JSON.stringify(L) !== JSON.stringify(S.loans)) S.loansTouched = true;
      S.loans = L;
      return true;
    },
  },

  start: {
    render() {
      const hasRecords = info.snapshot.records > 0;
      if (hasRecords && S.start === "sample") S.start = "empty";
      return html`<p class="setup-eyebrow">${t("setup.start.eyebrow")}</p>
        <h1 tabindex="-1">${t("setup.start.title")}</h1>
        <p class="lead">${hasRecords ? t("setup.start.lead_existing", { count: num(info.snapshot.records) }) : t("setup.start.lead")}</p>
        <fieldset class="setup-choices">
          <legend class="sr-only">${t("setup.start.title")}</legend>
          <div class="setup-choice-list">
            ${["empty", "sample", "import"].map((k) => {
              const disabled = k === "sample" && hasRecords;
              return html`<label class="setup-choice wide ${disabled ? "is-disabled" : ""}">
                <input type="radio" name="start" value="${k}" ${S.start === k ? raw("checked") : ""} ${disabled ? raw("disabled") : ""}
                  aria-describedby="start-${k}-desc">
                <span class="setup-choice-icon">${icon(START_ICONS[k])}</span>
                <span class="setup-choice-text"><strong>${t(`setup.start.${k}`)}</strong>
                  <span id="start-${k}-desc">${disabled ? t("setup.start.sample_disabled") : t(`setup.start.${k}_desc`)}</span></span>
              </label>`;
            })}
          </div>
        </fieldset>`;
    },
    validate(scope) {
      S.start = $("input[name=start]:checked", scope)?.value || "empty";
      return true;
    },
  },

  review: {
    render() {
      const L = S.loans;
      const section = (key, rows) => html`<section class="setup-review-block" aria-labelledby="rv-${key}">
        <div class="setup-review-head"><h2 id="rv-${key}">${t(`setup.review.${key}`)}</h2>
          <button type="button" class="btn ghost sm" data-goto="${key}">${icon("edit")}${t("setup.review.edit")}<span class="sr-only"> ${t(`setup.review.${key}`)}</span></button></div>
        <dl class="setup-dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></section>`;
      return html`<p class="setup-eyebrow">${t("setup.review.eyebrow")}</p>
        <h1 tabindex="-1">${t("setup.review.title")}</h1>
        <p class="lead">${t("setup.review.lead")}</p>
        ${section("library", [[t("setup.library.name"), S.library.name], [t("setup.review.kind"), t(`setup.kind.${S.library.kind}`)]])}
        ${info.needs_admin ? section("admin", [[t("setup.review.admin_name"), `${S.admin.first_name} ${S.admin.last_name}`.trim()],
          [t("setup.admin.username"), S.admin.username], [t("setup.admin.email"), S.admin.email]]) : ""}
        ${section("branches", S.branches.map((b) => [b.code, [b.name, b.address].filter(Boolean).join(" · ")]))}
        ${section("lending", [[t("setup.review.lending_rule"), lendingSentence(L)]])}
        ${section("start", [[t("setup.review.start_with"), t(`setup.start.${S.start}`)]])}
        <div class="alert info setup-note">${icon("info")}<div>${t("setup.review.note")}</div></div>`;
    },
    mount(scope) {
      scope.addEventListener("click", (e) => {
        const b = e.target.closest("[data-goto]");
        if (b) go(steps.findIndex((s) => s.key === b.dataset.goto));
      });
    },
    validate: () => true,
  },
};

function branchCard(b, i) {
  const one = S.branches.length === 1;
  return html`<li class="setup-branch">
    <div class="setup-branch-head"><h2 class="setup-branch-title">${t("setup.branches.branch_n", { n: num(i + 1) })}</h2>
      ${one ? "" : html`<button type="button" class="btn ghost sm" data-remove-branch="${i}">${icon("trash")}${t("setup.branches.remove")}<span class="sr-only"> ${b.name || t("setup.branches.branch_n", { n: num(i + 1) })}</span></button>`}</div>
    <div class="setup-grid-branch">
      ${field(`br-name-${i}`, t("setup.branches.name"), html`<input id="br-name-${i}" required maxlength="120" value="${b.name}">`)}
      ${field(`br-code-${i}`, t("setup.branches.code"), html`<input id="br-code-${i}" class="mono" required maxlength="16" spellcheck="false" autocapitalize="characters" value="${b.code}" aria-describedby="br-code-${i}-hint">`, t("setup.branches.code_hint"))}
    </div>
    ${field(`br-address-${i}`, t("setup.branches.address"), html`<input id="br-address-${i}" maxlength="255" autocomplete="street-address" value="${b.address || ""}">`)}
    <div class="setup-grid-2">
      ${field(`br-email-${i}`, t("setup.branches.email"), html`<input id="br-email-${i}" type="email" maxlength="120" value="${b.email || ""}">`)}
      ${field(`br-phone-${i}`, t("setup.branches.phone"), html`<input id="br-phone-${i}" type="tel" maxlength="40" autocomplete="tel" value="${b.phone || ""}">`)}
    </div>
  </li>`;
}

function readBranches(scope) {
  S.branches = S.branches.map((b, i) => ({
    ...b,
    name: $(`#br-name-${i}`, scope).value.replace(/\s+/g, " ").trim(),
    code: $(`#br-code-${i}`, scope).value.trim().toUpperCase(),
    address: $(`#br-address-${i}`, scope).value.trim(),
    email: $(`#br-email-${i}`, scope).value.trim(),
    phone: $(`#br-phone-${i}`, scope).value.trim(),
  }));
}

function readLoans(scope) {
  const int = (k) => Number($(`#ln-${k}`, scope).value);
  const minor = (k) => toMinor($(`#ln-${k}`, scope).value || 0);
  const L = { loan_days: int("loan_days"), max_renewals: int("max_renewals"), max_loans: int("max_loans"),
    hold_pickup_days: int("hold_pickup_days"), fine_per_day: minor("fine_per_day"), fine_cap: minor("fine_cap") };
  return Object.values(L).every((v) => Number.isFinite(v)) ? L : null;
}

function lendingSentence(L) {
  const parts = [t("setup.lending.sentence_loan", { count: L.max_loans, items: num(L.max_loans), days: num(L.loan_days) }),
    L.max_renewals ? t("setup.lending.sentence_renew", { count: L.max_renewals, n: num(L.max_renewals) }) : t("setup.lending.sentence_no_renew"),
    t("setup.lending.sentence_holds", { days: num(L.hold_pickup_days) }),
    L.fine_per_day ? t("setup.lending.sentence_fine", { fine: money(L.fine_per_day), cap: money(L.fine_cap) }) : t("setup.lending.sentence_no_fine")];
  return parts.join(" ");
}

// ------------------------------------------------------------------ shell

function renderRail() {
  $("#setup-steps").innerHTML = html`${steps.map((s, i) => {
    const state = i < at ? "done" : i === at ? "current" : "todo";
    const label = t(`setup.step.${s.key}`);
    return html`<li class="setup-step is-${state}" ${i === at ? raw('aria-current="step"') : ""}>
      ${i < at ? html`<button type="button" class="setup-step-btn" data-step="${i}">` : raw('<span class="setup-step-btn">')}
        <span class="setup-step-dot" aria-hidden="true">${i < at ? icon("check") : num(i + 1)}</span>
        <span class="setup-step-label">${label}<span class="sr-only"> · ${t(`setup.state.${state}`)}</span></span>
      ${raw(i < at ? "</button>" : "</span>")}
    </li>`;
  })}`;
}

function render(focus = true) {
  const step = steps[at];
  const def = STEP_DEFS[step.key];
  const last = at === steps.length - 1;
  root.innerHTML = html`<form class="setup-card" id="step-form" novalidate data-step="${step.key}">
    <p class="setup-progress small">${t("setup.progress", { n: num(at + 1), total: num(steps.length) })}</p>
    <div class="alert bad" id="step-alert" role="alert" tabindex="-1" hidden></div>
    ${def.render()}
    <div class="setup-actions">
      ${at > 0 ? html`<button type="button" class="btn" id="step-back">${icon("chevron-left", "flip-rtl")}${t("setup.back")}</button>` : html`<span></span>`}
      <div class="row tight">
        ${at === 0 && !info.needs_admin ? html`<button type="button" class="btn ghost" id="setup-skip">${t("setup.skip")}</button>` : ""}
        <button type="submit" class="btn primary ${last ? "lg" : ""}" id="step-next">${last ? html`${icon("check")}${t("setup.finish")}` : html`${t("setup.continue")}${icon("arrow-right", "flip-rtl")}`}</button>
      </div>
    </div>
  </form>`;
  root.removeAttribute("aria-busy");
  const form = $("#step-form", root);
  def.mount?.(form);
  form.addEventListener("submit", onSubmit);
  $("#step-back", form)?.addEventListener("click", () => go(at - 1));
  $("#setup-skip", form)?.addEventListener("click", onSkip);
  renderRail();
  document.title = `${t(`setup.step.${step.key}`)} · ${t("setup.title")}`;
  if (focus) $("h1", form)?.focus();
  save();
}

function rerender(after) {
  render(false);
  after?.();
}

function go(i) {
  if (i < 0 || i >= steps.length) return;
  at = i;
  render();
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors(form);
  const btn = $("#step-next", form);
  const ok = await busy(btn, () => Promise.resolve(STEP_DEFS[steps[at].key].validate(form)));
  if (!ok) return;
  if (at === 0 && resumeAt > 1) {
    const target = resumeAt;
    resumeAt = 0;
    go(target);
  } else if (at < steps.length - 1) go(at + 1);
  else await finish(btn);
}

async function onSkip(e) {
  try {
    await busy(e.currentTarget, () => api("/setup/skip", { method: "POST" }));
    forget();
    location.href = "/staff";
  } catch (err) { toast(err.message, "error"); }
}

function payload() {
  return {
    setup_code: info.needs_admin ? secret.code : null,
    library: S.library,
    admin: info.needs_admin ? { ...S.admin, password: secret.password } : null,
    branches: S.branches.map(({ id, code, name, address, email, phone }) => ({ id: id ?? null, code, name, address: address || "", email: email || "", phone: phone || "" })),
    loans: S.loans,
    start: S.start,
  };
}

// Server field paths (e.g. "branches.1.code") → wizard step and input id.
function locate(fieldPath) {
  const [head, a, b] = String(fieldPath || "").split(".");
  if (head === "library") return ["library", a === "kind" ? "input[name=kind]" : "#lib-name"];
  if (head === "admin") return ["admin", { first_name: "#adm-first", last_name: "#adm-last", username: "#adm-user", email: "#adm-email", password: "#adm-pw" }[a] || "#adm-first"];
  if (head === "branches") return ["branches", a !== undefined && b ? `#br-${b}-${a}` : "#branch-add"];
  if (head === "loans") return ["lending", `#ln-${a}`];
  if (head === "start") return ["start", "input[name=start]"];
  return ["welcome", "#setup-code"];
}

async function finish(btn) {
  try {
    const res = await busy(btn, () => api("/setup/complete", { method: "POST", body: payload() }));
    forget();
    secret = { code: "", password: "", confirm: "" };
    done(res);
  } catch (err) {
    if (err instanceof ApiError && err.status === 422 && err.data?.field) {
      const [key, sel] = locate(err.data.field);
      const i = steps.findIndex((s) => s.key === key);
      if (i >= 0) {
        go(i);
        const form = $("#step-form");
        failStep(form, [[$(sel, form) || $("h1", form), err.data.detail]]);
        return;
      }
    }
    if (err instanceof ApiError && err.status === 403 && info.needs_admin) {
      codeOk = false;
      go(0);
      const form = $("#step-form");
      failStep(form, [[$("#setup-code", form), t("setup.err.code_wrong")]]);
      return;
    }
    const alert = $("#step-alert");
    alert.innerHTML = html`${icon("alert")}<div>${err.message || t("setup.err.generic")}</div>`;
    alert.hidden = false;
    alert.focus?.();
  }
}

function done(res) {
  const s = res.summary || {};
  $("#setup-steps").innerHTML = html`${steps.map((st) => html`<li class="setup-step is-done"><span class="setup-step-btn">
    <span class="setup-step-dot" aria-hidden="true">${icon("check")}</span><span class="setup-step-label">${t(`setup.step.${st.key}`)}</span></span></li>`)}`;
  const importing = s.start === "import";
  root.innerHTML = html`<section class="setup-card setup-done" aria-labelledby="done-title">
    <div class="setup-done-mark" aria-hidden="true">${icon("check")}</div>
    <h1 id="done-title" tabindex="-1">${t("setup.done.title", { library: s.library_name || "" })}</h1>
    <p class="lead">${res.signed_in ? t("setup.done.lead_signed_in") : t("setup.done.lead")}</p>
    <ul class="setup-checklist">
      <li>${icon("check-circle")}<span>${t("setup.done.branches", { count: s.branches || 0, n: num(s.branches || 0) })}</span></li>
      <li>${icon("check-circle")}<span>${t("setup.done.rules")}</span></li>
      ${s.sample_records ? html`<li>${icon("check-circle")}<span>${t("setup.done.sample", { count: s.sample_records, n: num(s.sample_records) })}</span></li>` : ""}
    </ul>
    <h2 class="setup-next-title">${t("setup.done.next")}</h2>
    <div class="setup-next">
      ${importing ? html`<a class="btn primary lg" href="/staff/admin#maintenance">${icon("upload")}${t("setup.done.import")}</a>` : html`<a class="btn primary lg" href="/staff">${icon("home")}${t("setup.done.dashboard")}</a>`}
      <a class="btn lg" href="/">${icon("search")}${t("setup.done.catalogue")}</a>
      ${importing ? html`<a class="btn lg" href="/staff">${icon("home")}${t("setup.done.dashboard")}</a>` : ""}
    </div>
    <ul class="setup-tips">
      <li>${icon("shield")}<span>${t("setup.done.tip_2fa")}</span></li>
      <li>${icon("users")}<span>${t("setup.done.tip_staff")}</span></li>
      <li>${icon("settings")}<span>${t("setup.done.tip_settings")}</span></li>
    </ul>
  </section>`;
  document.title = `${t("setup.done.short")} · ${t("setup.title")}`;
  $("#done-title").focus();
}

// ------------------------------------------------------------------ boot

export default async function init() {
  root = $("#setup-root");
  $("#setup-steps")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-step]");
    if (b) go(Number(b.dataset.step));
  });
  try {
    info = await api("/setup/state");
  } catch (err) {
    root.innerHTML = html`<div class="setup-card"><div class="alert bad" role="alert">${icon("alert")}<div>${err.message}</div></div></div>`;
    root.removeAttribute("aria-busy");
    return;
  }
  if (!info.allowed) {
    location.replace("/");
    return;
  }
  presets = Object.fromEntries(info.presets.map((p) => [p.key, p]));
  steps = ["welcome", "library", ...(info.needs_admin ? ["admin"] : []), "branches", "lending", "start", "review"].map((key) => ({ key }));
  const saved = load();
  S = saved?.S && Array.isArray(saved.S.branches) ? saved.S : initialState(info.snapshot);
  // Branches saved before a reload must still exist (ids are only for branches already in the database).
  const known = new Set(info.snapshot.branches.map((b) => b.id));
  S.branches = S.branches.filter((b) => !b.id || known.has(b.id));
  if (!S.branches.length) S.branches = initialState(info.snapshot).branches;
  // Resume where the user left off, but never past the welcome step without the (unsaved) setup code.
  const resume = steps.findIndex((s) => s.key === saved?.at);
  at = info.needs_admin ? 0 : Math.max(0, resume);
  // The administrator's password was not stored either, so come back no further than that step.
  if (info.needs_admin && resume > 0) resumeAt = Math.min(resume, steps.findIndex((s) => s.key === "admin"));
  render(false);
}
