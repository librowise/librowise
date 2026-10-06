import { $, BOOT, api, badge, date, empty, formData, html, initials, modal, money, num, qs, skeleton, toast, parseDate } from "/static/js/core.js";

export function patronForm(lk, p = {}) {
  const opt = (list, sel) => list.map((x) => html`<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${x.name}</option>`);
  const isAdmin = BOOT.user.role === "admin";
  return html`<div class="grid cols-2">
    <div class="field"><label for="pf-fn">First name *</label><input id="pf-fn" name="first_name" required value="${p.first_name || ""}"></div>
    <div class="field"><label for="pf-ln">Last name *</label><input id="pf-ln" name="last_name" required value="${p.last_name || ""}"></div>
    <div class="field"><label for="pf-em">Email</label><input id="pf-em" name="email" type="email" value="${p.email || ""}"></div>
    <div class="field"><label for="pf-ph">Phone</label><input id="pf-ph" name="phone" type="tel" value="${p.phone || ""}"></div>
    <div class="field" style="grid-column:1/-1"><label for="pf-ad">Address</label><input id="pf-ad" name="address" value="${p.address || ""}"></div>
    <div class="field"><label for="pf-cat">Category *</label><select id="pf-cat" name="category_id" required>${opt(lk.categories, p.category?.id)}</select></div>
    <div class="field"><label for="pf-br">Home branch *</label><select id="pf-br" name="home_branch_id" required>${opt(lk.branches, p.home_branch?.id ?? BOOT.user.home_branch_id)}</select></div>
    ${p.id ? "" : html`<div class="field"><label for="pf-card">Card number</label><input id="pf-card" name="card_number" placeholder="Auto-generated if blank" pattern="[A-Za-z0-9-]*"></div>
      <div class="field"><label for="pf-dob">Date of birth</label><input id="pf-dob" name="date_of_birth" type="date"></div>`}
    <div class="field"><label for="pf-exp">Membership expires</label><input id="pf-exp" name="expires_on" type="date" value="${p.expires_on || ""}"><span class="hint">Blank = category default</span></div>
    ${isAdmin ? html`<div class="field"><label for="pf-role">Role</label><select id="pf-role" name="role">${["patron", "librarian", "admin"].map((r) => html`<option ${p.role === r ? "selected" : ""}>${r}</option>`)}</select></div>` : ""}
    <div class="field"><label for="pf-pw">${p.id ? "Reset password" : "Password"}</label><input id="pf-pw" name="password" type="password" autocomplete="new-password" minlength="10"><span class="hint">Optional. Min 10 chars, 3 character classes.</span></div>
    <div class="field" style="grid-column:1/-1"><label for="pf-no">Staff notes (shown at the desk)</label><input id="pf-no" name="notes" value="${p.notes || ""}"></div></div>`;
}

export function patronPayload(fd, isNew) {
  const d = Object.fromEntries([...fd].map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === "" && !isNew && ["email", "phone", "address", "notes", "expires_on"].includes(k)) out[k] = null;
    else if (v !== "") out[k] = ["category_id", "home_branch_id"].includes(k) ? +v : v;
  }
  return out;
}

export default async function init() {
  const form = $("#p-search");
  const params = new URLSearchParams(location.search);
  for (const [k, v] of params) if (form.elements[k]) form.elements[k].value = v;
  form.addEventListener("submit", (e) => { e.preventDefault(); location.search = qs(formData(form)); });
  const lk = await api("/lookups");

  const page = +(params.get("page") || 1);
  $("#p-results").innerHTML = `<div style="padding:1rem">${skeleton(8)}</div>`;
  try {
    const r = await api(`/patrons?${qs({ q: params.get("q"), role: params.get("role"), page, per_page: 25 })}`);
    if (r.total === 1 && params.get("q")) { location.replace(`/staff/patrons/${r.results[0].id}`); return; }
    $("#p-summary").textContent = `${num(r.total)} accounts`;
    $("#p-results").innerHTML = r.results.length ? html`<table class="table"><thead><tr><th>Name</th><th>Card</th><th>Category</th><th>Branch</th><th class="num">Loans</th><th class="num">Balance</th><th>Expires</th></tr></thead><tbody>
      ${r.results.map((p) => html`<tr class="clickable" data-href="/staff/patrons/${p.id}">
        <td><div class="row tight"><span class="avatar" style="width:2rem;height:2rem;font-size:.75rem">${initials(p.full_name)}</span>
          <div><a href="/staff/patrons/${p.id}"><strong>${p.full_name}</strong></a><div class="tiny muted">${p.email || ""}</div></div>
          ${p.role !== "patron" ? badge("info", p.role) : ""}${p.is_active ? "" : badge("bad", "inactive")}</div></td>
        <td class="mono small">${p.card_number}</td><td>${p.category.name}</td><td>${p.home_branch.name}</td>
        <td class="num">${p.open_loans}</td><td class="num">${p.balance > 0 ? html`<span style="color:var(--danger)">${money(p.balance)}</span>` : money(0)}</td>
        <td>${p.expires_on ? (parseDate(p.expires_on) < new Date() ? badge("bad", date(p.expires_on)) : date(p.expires_on)) : "—"}</td></tr>`)}</tbody></table>`
      : empty("No patrons found.", "users");
    const pages = Math.ceil(r.total / 25);
    if (pages > 1) $("#p-pager").innerHTML = html`<a class="btn sm ${page <= 1 ? "hidden" : ""}" href="?${qs({ ...Object.fromEntries(params), page: page - 1 })}">Previous</a>
      <span class="muted small">Page ${page} of ${pages}</span><a class="btn sm ${page >= pages ? "hidden" : ""}" href="?${qs({ ...Object.fromEntries(params), page: page + 1 })}">Next</a>`;
  } catch (e) { toast(e.message, "error"); }

  $("#p-results").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.target.closest("a")) location.href = tr.dataset.href;
  });
  const register = async () => {
    const fd = await modal({ title: "Register patron", body: patronForm(lk), submit: "Register", wide: true });
    if (!fd) return;
    try {
      const p = await api("/patrons", { method: "POST", body: patronPayload(fd, true) });
      toast(`Registered ${p.full_name} — card ${p.card_number}`, "success", 7000);
      location.href = `/staff/patrons/${p.id}`;
    } catch (e) { toast(e.message, "error"); }
  };
  $("#new-patron").addEventListener("click", register);
  if (location.hash === "#new") register();
}
