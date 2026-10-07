import { $, $$, BOOT, api, authors, badge, confirmDialog, cover, date, empty, html, icon, initials, modal, money, relative, skeleton, toast, parseDate } from "/static/js/core.js";
import { patronForm, patronPayload } from "/static/js/pages/staff-patrons.js";

let p, lk, tab = "loans";
const pid = () => +BOOT.path_params.patron_id;

const PANELS = {
  loans: () => p.loans.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Barcode</th><th>Issued</th><th>Due</th><th class="num">Renewals</th><th></th></tr></thead><tbody>
    ${p.loans.map((l) => html`<tr><td><a href="/staff/catalog/${l.item.biblio.id}">${l.item.biblio.title}</a></td><td class="mono small">${l.item.barcode}</td>
      <td>${date(l.issued_at)}</td><td>${l.overdue ? badge("overdue", `${l.days_overdue}d overdue`) : date(l.due_at)}</td><td class="num">${l.renewals}</td>
      <td class="right nowrap"><button class="btn sm" data-renew="${l.id}">Renew</button> <button class="btn sm danger" data-lost="${l.id}">Lost</button></td></tr>`)}</tbody></table></div>`
    : empty("No current loans", "book"),
  holds: () => p.holds.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Pickup</th><th>Status</th><th>Placed</th><th></th></tr></thead><tbody>
    ${p.holds.map((h) => html`<tr><td><a href="/staff/catalog/${h.biblio.id}">${h.biblio.title}</a></td><td>${h.pickup_branch.name}</td>
      <td>${h.suspended ? badge("warn", h.suspended_until ? `Suspended until ${date(h.suspended_until)}` : "Suspended") : badge(h.status)} ${h.queue_position ? html`<span class="tiny muted">#${h.queue_position}</span>` : ""}${h.expires_at ? html`<div class="tiny muted">until ${date(h.expires_at)}</div>` : ""}
        ${h.item_level && h.requested_item ? html`<div class="tiny muted">Copy ${h.requested_item.barcode} only</div>` : ""}${h.notes ? html`<div class="tiny muted">${h.notes}</div>` : ""}</td>
      <td>${relative(h.created_at)}</td><td class="right nowrap">${h.status === "queued" && !h.item ? (h.suspended
        ? html`<button class="btn sm" data-hold-resume="${h.id}">Resume</button> `
        : html`<button class="btn sm" data-hold-suspend="${h.id}">Suspend</button> `) : ""}<button class="btn sm danger" data-cancel-hold="${h.id}">Cancel</button></td></tr>`)}</tbody></table></div>`
    : empty("No active holds", "bookmark"),
  async history() {
    const r = await api(`/patrons/${p.id}/history`);
    return r.results.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Borrowed</th><th>Returned</th><th class="num">Fine</th></tr></thead><tbody>
      ${r.results.map((l) => html`<tr><td><a href="/staff/catalog/${l.item.biblio.id}">${l.item.biblio.title}</a></td><td>${date(l.issued_at)}</td><td>${date(l.returned_at)}</td><td class="num">${l.fine_charged ? money(l.fine_charged) : "—"}</td></tr>`)}</tbody></table></div>`
      : empty(p.keep_history ? "No returned loans yet" : "This patron has opted out of reading history", "clock");
  },
  async account() {
    const r = await api(`/patrons/${p.id}/ledger`);
    return html`<div class="row between" style="margin-bottom:1rem"><div class="stat" style="padding:0"><span class="label">Balance</span><span class="value" style="color:${r.balance > 0 ? "var(--danger)" : "inherit"}">${money(r.balance)}</span></div>
      <div class="row tight"><button class="btn primary" data-money="pay">${icon("wallet")}Take payment</button><button class="btn" data-money="waive">Waive</button><button class="btn" data-money="charge">Add charge</button></div></div>
      ${r.entries.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Type</th><th>Note</th><th class="num">Amount</th></tr></thead><tbody>
      ${r.entries.map((e) => html`<tr><td>${date(e.created_at)}</td><td>${badge(e.amount > 0 ? "warn" : "ok", e.kind)}</td><td>${e.note || ""}</td><td class="num">${money(e.amount)}</td></tr>`)}</tbody></table></div>` : empty("No transactions", "wallet")}`;
  },
  async recs() {
    const r = await api(`/patrons/${p.id}/recommendations`);
    return html`<p class="small muted">${icon("sparkle")} ${r.reason === "personalised" ? "Based on this patron's history and similar readers — useful for readers' advisory at the desk." : "No history yet — showing trending titles."}</p>
      <div class="stack tight">${r.results.map((b) => html`<div class="row"><a href="/staff/catalog/${b.id}">${cover(b, "sm")}</a><div class="grow"><a href="/staff/catalog/${b.id}"><strong>${b.title}</strong></a><div class="small muted">${authors(b.authors)}</div></div>
        ${b.availability?.available ? badge("available", "On shelf") : badge("on_loan", "Out")}<button class="btn sm" data-hold-for="${b.id}">Hold</button></div>`)}</div>`;
  },
};

async function showTab(t) {
  tab = t;
  $$("#ptabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === t));
  $("#ppanel").innerHTML = skeleton(4);
  try { $("#ppanel").innerHTML = await PANELS[t](); } catch (e) { $("#ppanel").innerHTML = empty(e.message, "alert"); }
}

async function load() {
  p = await api(`/patrons/${pid()}`);
  $("#crumb").textContent = p.full_name;
  document.title = `${p.full_name} · Staff`;
  const expired = p.expires_on && parseDate(p.expires_on) < new Date();
  $("#patron").innerHTML = html`<div class="card pad" style="margin-bottom:1rem"><div class="row between" style="align-items:flex-start">
      <div class="patron-card"><div class="avatar lg">${initials(p.full_name)}</div>
        <div><h1 style="margin:0">${p.full_name}</h1>
          <div class="muted">${p.card_number} · ${p.category.name} · ${p.home_branch.name}${p.role !== "patron" ? ` · ${p.role}` : ""}</div>
          <div class="row tight" style="margin-top:.4rem">${p.is_active ? badge("ok", "Active") : badge("bad", "Inactive")}
            ${p.registration_status === "pending" ? html`<a class="badge warn" href="/staff/requests">Online registration awaiting approval</a>` : ""}
            ${p.expires_on ? badge(expired ? "bad" : "", `${expired ? "Expired" : "Expires"} ${date(p.expires_on)}`) : ""}
            ${badge(p.balance > 0 ? "warn" : "ok", `Balance ${money(p.balance)}`)}${p.keep_history ? "" : badge("info", "History off")}</div>
          <div class="small muted" style="margin-top:.4rem">${[p.email, p.phone, p.address].filter(Boolean).join(" · ")}</div></div></div>
      <div class="row tight"><a class="btn primary" href="/staff/circulation?patron=${encodeURIComponent(p.card_number)}#checkout">${icon("arrow-up")}Check out</a>
        <button class="btn" id="edit">${icon("edit")}Edit</button>${expired ? html`<button class="btn" id="renew-membership">${icon("refresh")}Renew membership</button>` : ""}
        <button class="btn danger" id="erase">${icon("trash")}Erase</button></div></div>
    ${p.blocks.length ? html`<div class="alert bad" style="margin-top:1rem">${icon("alert")}<div><strong>Borrowing blocked:</strong> ${p.blocks.join("; ")}</div></div>` : ""}
    ${p.notes ? html`<div class="alert info" style="margin-top:1rem">${icon("info")}<div>${p.notes}</div></div>` : ""}</div>
    <div class="tabs" role="tablist" id="ptabs">
      ${[["loans", `Loans (${p.loans.length})`], ["holds", `Holds (${p.holds.length})`], ["history", "History"], ["account", "Account"], ["recs", "AI picks"]]
        .map(([k, v]) => html`<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${v}</button>`)}</div>
    <div class="card pad" id="ppanel" role="tabpanel"></div>`;
  await showTab(tab);
}

export default async function init() {
  lk = await api("/lookups");
  try { await load(); } catch (e) { $("#patron").innerHTML = empty(e.message, "alert"); return; }
  $("#patron").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    try {
      if (t.dataset.tab) return showTab(t.dataset.tab);
      if (t.id === "edit") {
        const fd = await modal({ title: `Edit ${p.full_name}`, body: patronForm(lk, p), wide: true });
        if (!fd) return;
        await api(`/patrons/${p.id}`, { method: "PATCH", body: patronPayload(fd, false) });
        toast("Patron updated", "success");
      } else if (t.id === "renew-membership") {
        const next = new Date(); next.setFullYear(next.getFullYear() + 1);
        await api(`/patrons/${p.id}`, { method: "PATCH", body: { expires_on: next.toISOString().slice(0, 10) } });
        toast("Membership renewed for one year", "success");
      } else if (t.id === "erase") {
        if (!(await confirmDialog("Erase patron?", "Personal data will be scrubbed and the account deactivated. Loan history is anonymised. This cannot be undone.", "Erase"))) return;
        await api(`/patrons/${p.id}`, { method: "DELETE" });
        toast("Patron erased", "success");
        location.href = "/staff/patrons";
        return;
      } else if (t.dataset.renew) {
        try { await api(`/loans/${t.dataset.renew}/renew`, { method: "POST", body: { override: false } }); }
        catch (err) {
          if (err.status !== 422 || !(await confirmDialog("Renewal blocked", `${err.message}. Override?`, "Override & renew"))) throw err;
          await api(`/loans/${t.dataset.renew}/renew`, { method: "POST", body: { override: true } });
        }
        toast("Renewed", "success");
      } else if (t.dataset.lost) {
        if (!(await confirmDialog("Mark as lost?", "The patron will be charged the replacement cost.", "Mark lost"))) return;
        const r = await api(`/loans/${t.dataset.lost}/lost`, { method: "POST" });
        toast(`Charged ${money(r.charged)}`, "success");
      } else if (t.dataset.cancelHold) {
        if (!(await confirmDialog("Cancel hold?", "The patron will lose their place in the queue.", "Cancel hold"))) return;
        await api(`/holds/${t.dataset.cancelHold}`, { method: "DELETE" });
      } else if (t.dataset.holdSuspend) {
        const fd = await modal({ title: "Suspend hold", submit: "Suspend", body: html`<div class="field"><label for="hs-until">Resume automatically on (optional)</label><input id="hs-until" name="until" type="date"></div>` });
        if (!fd) return;
        await api(`/holds/${t.dataset.holdSuspend}/suspend`, { method: "POST", body: { until: fd.get("until") || null } });
        toast("Hold suspended", "success");
      } else if (t.dataset.holdResume) {
        await api(`/holds/${t.dataset.holdResume}/resume`, { method: "POST" });
        toast("Hold resumed", "success");
      } else if (t.dataset.money) {
        const kind = t.dataset.money;
        const fd = await modal({ title: { pay: "Take payment", waive: "Waive charges", charge: "Add manual charge" }[kind], submit: "Confirm", body: html`<div class="stack">
          <div class="field"><label for="m-amt">Amount (₹)</label><input id="m-amt" name="amount" type="number" min="0.01" step="0.01" required value="${kind !== "charge" && p.balance > 0 ? p.balance : ""}"></div>
          <div class="field"><label for="m-note">Note${kind === "pay" ? "" : " *"}</label><input id="m-note" name="note" ${kind === "pay" ? "" : "required"} placeholder="${kind === "pay" ? "Cash / UPI / card" : "Reason"}"></div></div>` });
        if (!fd) return;
        const r = await api(`/patrons/${p.id}/${kind}`, { method: "POST", body: { amount: Math.round(+fd.get("amount") * 100), note: fd.get("note") || null } });
        toast(`New balance ${money(r.balance)}`, "success");
        tab = "account";
      } else if (t.dataset.holdFor) {
        await api("/holds", { method: "POST", body: { biblio_id: +t.dataset.holdFor, patron_card: p.card_number, pickup_branch_id: p.home_branch.id } });
        toast("Hold placed", "success");
        tab = "holds";
      } else return;
      await load();
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
}
