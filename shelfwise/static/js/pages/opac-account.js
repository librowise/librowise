import { $, $$, api, authors, badge, confirmDialog, cover, date, empty, html, icon, money, relative, skeleton, toast, withBusy, parseDate } from "/static/js/core.js";
import { bookCard } from "/static/js/pages/opac-home.js";
import { holdsPanel, messagingCard, onPanelChange, onPanelClick, onPanelSubmit, suggestionsPanel } from "/static/js/pages/opac-account-services.js";

let summary;

const dueBadge = (l) => {
  if (l.overdue) return badge("overdue", `Overdue ${l.days_overdue} day${l.days_overdue === 1 ? "" : "s"}`);
  const days = Math.ceil((parseDate(l.due_at) - Date.now()) / 86400000);
  return days <= 3 ? badge("warn", `Due ${relative(l.due_at)}`) : badge("ok", `Due ${date(l.due_at)}`);
};

function loanRow(l) {
  const b = l.item.biblio;
  return html`<div class="result">
    <a href="/record/${b.id}" aria-hidden="true" tabindex="-1">${cover(b)}</a>
    <div class="grow stack tight"><h3><a href="/record/${b.id}">${b.title}</a></h3>
      <div class="meta">${authors(b.authors)} · borrowed ${date(l.issued_at)} · renewed ${l.renewals}×</div>
      <div class="row tight">${dueBadge(l)}<span class="tiny muted mono">${l.item.barcode}</span></div></div>
    <div><button class="btn sm" data-renew="${l.id}">${icon("refresh")}Renew</button></div></div>`;
}

const TABS = {
  async loans() {
    if (!summary.loans.length) return empty("You have nothing on loan. Time to find your next read!", "book");
    return html`<div class="row between" style="margin-bottom:.75rem"><span class="muted small">${summary.loans.length} item(s)</span>
      <button class="btn sm" data-renew-all>${icon("refresh")}Renew all</button></div>
      <div class="card flush"><div class="card-body">${summary.loans.map(loanRow)}</div></div>`;
  },
  async holds() {
    return holdsPanel(summary);
  },
  suggestions: suggestionsPanel,
  async foryou() {
    const r = await api("/opac/me/recommendations");
    return html`<div class="alert info" style="margin-bottom:1rem">${icon("sparkle")}<div>${r.reason === "personalised"
      ? "Picked by our AI from your borrowing history and what readers like you enjoyed. Recommendations are computed privately inside the library system."
      : "Borrow a few titles and we'll personalise these. Meanwhile, here's what's trending."}</div></div>
      <div class="grid auto" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">${r.results.map(bookCard)}</div>`;
  },
  async lists() {
    const { results } = await api("/opac/me/lists");
    if (!results.length) return empty("No reading lists yet — use “Add to reading list” on any title.", "list");
    return html`${results.map((l) => html`<section class="shelf"><div class="shelf-head"><h2>${l.name} ${l.is_public ? html`<span class="badge info">Public</span>` : ""}</h2>
      <button class="btn sm ghost danger" data-delete-list="${l.id}">${icon("trash")}Delete list</button></div>
      ${l.results.length ? html`<div class="shelf-row">${l.results.map(bookCard)}</div>` : html`<p class="muted">Empty list.</p>`}</section>`)}`;
  },
  async history() {
    const r = await api("/opac/me/history");
    const head = html`<div class="row between" style="margin-bottom:.75rem"><span class="muted small">${r.keep_history ? "Your reading history is kept so we can personalise recommendations." : "History is off: returned loans are anonymised immediately."}</span>
      ${r.results.length ? html`<button class="btn sm danger" data-clear-history>${icon("trash")}Clear history</button>` : ""}</div>`;
    if (!r.results.length) return html`${head}${empty("No reading history.", "clock")}`;
    return html`${head}<div class="card flush"><div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Borrowed</th><th>Returned</th></tr></thead>
      <tbody>${r.results.map((l) => html`<tr><td><a href="/record/${l.item.biblio.id}">${l.item.biblio.title}</a></td><td>${date(l.issued_at)}</td><td>${date(l.returned_at)}</td></tr>`)}</tbody></table></div></div>`;
  },
  async charges() {
    return html`<div class="card pad" style="margin-bottom:1rem"><div class="stat" style="padding:0"><span class="label">Balance</span>
      <span class="value" style="color:${summary.balance > 0 ? "var(--danger)" : "var(--success)"}">${money(summary.balance)}</span>
      <span class="delta">Pay at any branch desk.</span></div></div>
      ${summary.ledger.length ? html`<div class="card flush"><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="num">Amount</th></tr></thead>
      <tbody>${summary.ledger.map((e) => html`<tr><td>${date(e.created_at)}</td><td>${badge(e.amount > 0 ? "warn" : "ok", e.kind)}</td><td>${e.note || ""}</td><td class="num">${money(e.amount)}</td></tr>`)}</tbody></table></div></div>` : empty("No charges — thank you!", "wallet")}`;
  },
  async settings() {
    const me = await api("/auth/me");
    return html`<div class="grid cols-2">
      <form class="card pad stack" id="pw-form"><h3>Change password</h3>
        <div class="field"><label for="cur">Current password</label><input id="cur" name="current_password" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="new">New password</label><input id="new" name="new_password" type="password" autocomplete="new-password" minlength="10" required>
          <span class="hint">At least 10 characters, mixing three of: lowercase, uppercase, digits, symbols.</span></div>
        <button class="btn primary">Update password</button></form>
      <div class="card pad stack"><h3>Privacy</h3>
        <label class="checkbox"><input type="checkbox" id="keep-history" ${me.keep_history ? "checked" : ""}> Keep my reading history</label>
        <p class="small muted">When off, items are detached from your account as soon as they're returned. Recommendations then use only trending titles.</p>
        <h3 style="margin-top:1rem">Appearance</h3>
        <button class="btn" data-appearance>${icon("palette")}Theme, density & text size</button></div></div>
      ${await messagingCard()}`;
  },
};

async function show(tab) {
  $$("#tabs [role=tab]").forEach((t) => t.setAttribute("aria-selected", t.dataset.tab === tab));
  $("#panel").innerHTML = skeleton(4);
  try {
    $("#panel").innerHTML = await TABS[tab]();
  } catch (e) { $("#panel").innerHTML = empty(e.message, "alert"); }
  history.replaceState(null, "", `#${tab}`);
  $("#panel [data-appearance]")?.addEventListener("click", () => $("header [data-appearance]").click());
}

async function refresh() {
  summary = await api("/opac/me/summary");
  const overdue = summary.loans.filter((l) => l.overdue).length;
  const ready = summary.holds.filter((h) => h.status === "ready").length;
  $("#stats").innerHTML = html`
    <div class="card stat"><span class="label">On loan</span><span class="value">${summary.loans.length}</span><span class="delta">${overdue ? `${overdue} overdue` : "All on time"}</span></div>
    <div class="card stat ${overdue ? "alert" : ""}"><span class="label">Overdue</span><span class="value">${overdue}</span></div>
    <div class="card stat"><span class="label">Holds</span><span class="value">${summary.holds.length}</span><span class="delta">${ready ? `${ready} ready to collect` : "None ready yet"}</span></div>
    <div class="card stat ${summary.balance > 0 ? "alert" : ""}"><span class="label">Charges</span><span class="value">${money(summary.balance)}</span></div>`;
  $("#blocks").innerHTML = summary.blocks.length ? html`<div class="alert warn" style="margin-bottom:1rem">${icon("alert")}<div><strong>Borrowing is blocked:</strong> ${summary.blocks.join("; ")}</div></div>` : "";
}

export default async function init() {
  await refresh();
  const initial = location.hash.slice(1);
  show(TABS[initial] ? initial : "loans");
  $("#tabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) show(t.dataset.tab); });
  $("#panel").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    try {
      if (t.dataset.renew) {
        const l = await withBusy(t, () => api(`/opac/me/loans/${t.dataset.renew}/renew`, { method: "POST" }));
        toast(`Renewed — now due ${date(l.due_at)}`, "success");
        await refresh(); show("loans");
      } else if (t.hasAttribute("data-renew-all")) {
        let ok = 0; const errors = [];
        for (const l of summary.loans) {
          try { await api(`/opac/me/loans/${l.id}/renew`, { method: "POST" }); ok++; } catch (err) { errors.push(`${l.item.biblio.title}: ${err.message}`); }
        }
        toast(`${ok} renewed${errors.length ? `; ${errors.length} could not be renewed` : ""}`, errors.length ? "info" : "success", 6000);
        errors.slice(0, 3).forEach((m) => toast(m, "error", 7000));
        await refresh(); show("loans");
      } else if (t.dataset.cancelHold) {
        if (!(await confirmDialog("Cancel hold?", "You'll lose your place in the queue.", "Cancel hold"))) return;
        await api(`/opac/me/holds/${t.dataset.cancelHold}`, { method: "DELETE" });
        toast("Hold cancelled", "success"); await refresh(); show("holds");
      } else if (t.dataset.deleteList) {
        if (!(await confirmDialog("Delete list?", "This removes the list (not the books).", "Delete"))) return;
        await api(`/opac/me/lists/${t.dataset.deleteList}`, { method: "DELETE" });
        show("lists");
      } else if (t.hasAttribute("data-clear-history")) {
        if (!(await confirmDialog("Clear reading history?", "Returned loans will be permanently anonymised.", "Clear history"))) return;
        const r = await api("/opac/me/history", { method: "DELETE" });
        toast(`${r.anonymized} records anonymised`, "success"); show("history");
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
  const ctx = { refresh, show };
  $("#panel").addEventListener("click", (e) => onPanelClick(e, ctx));
  $("#panel").addEventListener("submit", (e) => onPanelSubmit(e, ctx));
  $("#panel").addEventListener("change", onPanelChange);
  $("#panel").addEventListener("change", async (e) => {
    if (e.target.id === "keep-history") {
      await api("/auth/preferences", { method: "PATCH", body: { keep_history: e.target.checked } });
      toast("Privacy preference saved", "success");
    }
  });
  $("#panel").addEventListener("submit", async (e) => {
    if (e.target.id !== "pw-form") return;
    e.preventDefault();
    const f = e.target;
    try {
      await withBusy($("button", f), () => api("/auth/password", { method: "POST", body: { current_password: f.current_password.value, new_password: f.new_password.value } }));
      f.reset();
      toast("Password updated. Other sessions have been signed out.", "success");
    } catch { /* already reported */ }
  });
}
