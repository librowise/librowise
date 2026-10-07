import { $, $$, api, authors, badge, confirmDialog, cover, date, empty, html, icon, money, relative, skeleton, toast, withBusy, parseDate } from "/static/js/core.js";
import { wireTabs } from "/static/js/a11y.js";
import { t } from "/static/js/i18n.js";
import { bookCard } from "/static/js/pages/opac-home.js";

let summary;

const dueBadge = (l) => {
  if (l.overdue) return badge("overdue", t("opac.account.overdue_days", { count: l.days_overdue }));
  const days = Math.ceil((parseDate(l.due_at) - Date.now()) / 86400000);
  return days <= 3 ? badge("warn", t("opac.account.due_rel", { when: relative(l.due_at) })) : badge("ok", t("opac.account.due_on", { date: date(l.due_at) }));
};

function loanRow(l) {
  const b = l.item.biblio;
  return html`<div class="result">
    <a href="/record/${b.id}" aria-hidden="true" tabindex="-1">${cover(b)}</a>
    <div class="grow stack tight"><h3><a href="/record/${b.id}">${b.title}</a></h3>
      <div class="meta">${authors(b.authors)} · ${t("opac.account.borrowed_on", { date: date(l.issued_at) })} · ${t("opac.account.renewed_times", { count: l.renewals })}</div>
      <div class="row tight">${dueBadge(l)}<span class="tiny muted mono">${l.item.barcode}</span></div></div>
    <div><button class="btn sm" data-renew="${l.id}" aria-label="${t("opac.account.renew_title", { title: b.title })}">${icon("refresh")}${t("opac.account.renew")}</button></div></div>`;
}

const TABS = {
  async loans() {
    if (!summary.loans.length) return empty(t("opac.account.no_loans"), "book");
    return html`<div class="row between" style="margin-bottom:.75rem"><span class="muted small">${t("opac.account.items", { count: summary.loans.length })}</span>
      <button class="btn sm" data-renew-all>${icon("refresh")}${t("opac.account.renew_all")}</button></div>
      <div class="card flush"><div class="card-body">${summary.loans.map(loanRow)}</div></div>`;
  },
  async holds() {
    if (!summary.holds.length) return empty(t("opac.account.no_holds"), "bookmark");
    return html`<div class="card flush"><div class="card-body">${summary.holds.map((h) => html`<div class="result">
      <div class="grow stack tight"><h3><a href="/record/${h.biblio.id}">${h.biblio.title}</a></h3>
        <div class="meta">${t("opac.account.pickup_at", { branch: h.pickup_branch.name })} · ${t("opac.account.placed", { when: relative(h.created_at) })}</div>
        <div class="row tight">${badge(h.status)}${h.status === "queued" ? html`<span class="small muted">${t("opac.account.position", { n: h.queue_position })}</span>` : ""}
        ${h.status === "ready" ? html`<span class="small">${t("opac.account.collect_by")} <strong>${date(h.expires_at)}</strong></span>` : ""}</div></div>
      <div><button class="btn sm danger" data-cancel-hold="${h.id}" aria-label="${t("opac.account.cancel_hold_title", { title: h.biblio.title })}">${t("common.cancel")}</button></div></div>`)}</div></div>`;
  },
  async foryou() {
    const r = await api("/opac/me/recommendations");
    return html`<div class="alert info" style="margin-bottom:1rem">${icon("sparkle")}<div>${r.reason === "personalised"
      ? t("opac.account.foryou_personal") : t("opac.account.foryou_trending")}</div></div>
      <div class="grid auto" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">${r.results.map(bookCard)}</div>`;
  },
  async lists() {
    const { results } = await api("/opac/me/lists");
    if (!results.length) return empty(t("opac.account.no_lists"), "list");
    return html`${results.map((l) => html`<section class="shelf"><div class="shelf-head"><h2>${l.name} ${l.is_public ? html`<span class="badge info">${t("opac.account.public")}</span>` : ""}</h2>
      <button class="btn sm ghost danger" data-delete-list="${l.id}">${icon("trash")}${t("opac.account.delete_list")}</button></div>
      ${l.results.length ? html`<div class="shelf-row">${l.results.map(bookCard)}</div>` : html`<p class="muted">${t("opac.account.empty_list")}</p>`}</section>`)}`;
  },
  async history() {
    const r = await api("/opac/me/history");
    const head = html`<div class="row between" style="margin-bottom:.75rem"><span class="muted small">${r.keep_history ? t("opac.account.history_on") : t("opac.account.history_off")}</span>
      ${r.results.length ? html`<button class="btn sm danger" data-clear-history>${icon("trash")}${t("opac.account.clear_history")}</button>` : ""}</div>`;
    if (!r.results.length) return html`${head}${empty(t("opac.account.no_history"), "clock")}`;
    return html`${head}<div class="card flush"><div class="table-wrap"><table class="table"><caption class="sr-only">${t("opac.account.tab_history")}</caption><thead><tr><th scope="col">${t("opac.account.col_title")}</th><th scope="col">${t("opac.account.col_borrowed")}</th><th scope="col">${t("opac.account.col_returned")}</th></tr></thead>
      <tbody>${r.results.map((l) => html`<tr><td><a href="/record/${l.item.biblio.id}">${l.item.biblio.title}</a></td><td>${date(l.issued_at)}</td><td>${date(l.returned_at)}</td></tr>`)}</tbody></table></div></div>`;
  },
  async charges() {
    return html`<div class="card pad" style="margin-bottom:1rem"><div class="stat" style="padding:0"><span class="label">${t("opac.account.balance")}</span>
      <span class="value" style="color:${summary.balance > 0 ? "var(--danger)" : "var(--success)"}">${money(summary.balance)}</span>
      <span class="delta">${t("opac.account.pay_at_desk")}</span></div></div>
      ${summary.ledger.length ? html`<div class="card flush"><div class="table-wrap"><table class="table"><caption class="sr-only">${t("opac.account.tab_charges")}</caption><thead><tr><th scope="col">${t("opac.account.col_date")}</th><th scope="col">${t("opac.account.col_type")}</th><th scope="col">${t("opac.account.col_description")}</th><th scope="col" class="num">${t("opac.account.col_amount")}</th></tr></thead>
      <tbody>${summary.ledger.map((e) => html`<tr><td>${date(e.created_at)}</td><td>${badge(e.amount > 0 ? "warn" : "ok", t(`opac.account.ledger_${e.kind}`, {}, e.kind))}</td><td>${e.note || ""}</td><td class="num">${money(e.amount)}</td></tr>`)}</tbody></table></div></div>` : empty(t("opac.account.no_charges"), "wallet")}`;
  },
  async settings() {
    const me = await api("/auth/me");
    return html`<div class="grid cols-2">
      <form class="card pad stack" id="pw-form" novalidate><h3>${t("opac.account.change_password")}</h3>
        <div class="field"><label for="cur">${t("opac.account.current_password")}</label><input id="cur" name="current_password" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="new">${t("opac.account.new_password")}</label><input id="new" name="new_password" type="password" autocomplete="new-password" minlength="10" required aria-describedby="new-hint pw-error">
          <span class="hint" id="new-hint">${t("opac.account.password_hint")}</span></div>
        <p class="alert bad hidden" id="pw-error" role="alert"></p>
        <button class="btn primary">${t("opac.account.update_password")}</button></form>
      <div class="card pad stack"><h3>${t("opac.account.privacy")}</h3>
        <label class="checkbox"><input type="checkbox" id="keep-history" ${me.keep_history ? "checked" : ""}> ${t("opac.account.keep_history")}</label>
        <p class="small muted">${t("opac.account.privacy_note")}</p>
        <h3 style="margin-top:1rem">${t("common.appearance")}</h3>
        <button class="btn" data-appearance>${icon("palette")}${t("opac.account.appearance_button")}</button></div></div>`;
  },
};

async function show(tab) {
  $$("#tabs [role=tab]").forEach((x) => x.setAttribute("aria-selected", x.dataset.tab === tab));
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
    <div class="card stat"><span class="label">${t("opac.account.stat_on_loan")}</span><span class="value">${summary.loans.length}</span><span class="delta">${overdue ? t("opac.account.n_overdue", { count: overdue }) : t("opac.account.all_on_time")}</span></div>
    <div class="card stat ${overdue ? "alert" : ""}"><span class="label">${t("opac.account.stat_overdue")}</span><span class="value">${overdue}</span></div>
    <div class="card stat"><span class="label">${t("opac.account.stat_holds")}</span><span class="value">${summary.holds.length}</span><span class="delta">${ready ? t("opac.account.n_ready", { count: ready }) : t("opac.account.none_ready")}</span></div>
    <div class="card stat ${summary.balance > 0 ? "alert" : ""}"><span class="label">${t("opac.account.stat_charges")}</span><span class="value">${money(summary.balance)}</span></div>`;
  $("#blocks").innerHTML = summary.blocks.length ? html`<div class="alert warn" role="alert" style="margin-bottom:1rem">${icon("alert")}<div><strong>${t("opac.account.blocked")}</strong> ${summary.blocks.join("; ")}</div></div>` : "";
}

export default async function init() {
  await refresh();
  const initial = location.hash.slice(1);
  show(TABS[initial] ? initial : "loans");
  wireTabs($("#tabs"), $("#panel"));
  $("#tabs").addEventListener("click", (e) => { const x = e.target.closest("[data-tab]"); if (x) show(x.dataset.tab); });
  $("#panel").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.renew) {
        const l = await withBusy(b, () => api(`/opac/me/loans/${b.dataset.renew}/renew`, { method: "POST" }));
        toast(t("opac.account.renewed_until", { date: date(l.due_at) }), "success");
        await refresh(); show("loans");
      } else if (b.hasAttribute("data-renew-all")) {
        let ok = 0; const errors = [];
        for (const l of summary.loans) {
          try { await api(`/opac/me/loans/${l.id}/renew`, { method: "POST" }); ok++; } catch (err) { errors.push(`${l.item.biblio.title}: ${err.message}`); }
        }
        toast(errors.length ? t("opac.account.renewed_some", { count: ok, failed: errors.length }) : t("opac.account.renewed_n", { count: ok }), errors.length ? "info" : "success", 6000);
        errors.slice(0, 3).forEach((m) => toast(m, "error", 7000));
        await refresh(); show("loans");
      } else if (b.dataset.cancelHold) {
        if (!(await confirmDialog(t("opac.account.cancel_hold_q"), t("opac.account.cancel_hold_text"), t("opac.account.cancel_hold")))) return;
        await api(`/opac/me/holds/${b.dataset.cancelHold}`, { method: "DELETE" });
        toast(t("opac.account.hold_cancelled"), "success"); await refresh(); show("holds");
      } else if (b.dataset.deleteList) {
        if (!(await confirmDialog(t("opac.account.delete_list_q"), t("opac.account.delete_list_text"), t("opac.account.delete")))) return;
        await api(`/opac/me/lists/${b.dataset.deleteList}`, { method: "DELETE" });
        show("lists");
      } else if (b.hasAttribute("data-clear-history")) {
        if (!(await confirmDialog(t("opac.account.clear_history_q"), t("opac.account.clear_history_text"), t("opac.account.clear_history")))) return;
        const r = await api("/opac/me/history", { method: "DELETE" });
        toast(t("opac.account.anonymised", { count: r.anonymized }), "success"); show("history");
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
  $("#panel").addEventListener("change", async (e) => {
    if (e.target.id === "keep-history") {
      await api("/auth/preferences", { method: "PATCH", body: { keep_history: e.target.checked } });
      toast(t("opac.account.privacy_saved"), "success");
    }
  });
  $("#panel").addEventListener("submit", async (e) => {
    if (e.target.id !== "pw-form") return;
    e.preventDefault();
    const f = e.target;
    const err = $("#pw-error", f);
    err.classList.add("hidden");
    if (!f.checkValidity()) {
      err.textContent = t("opac.account.password_invalid");
      err.classList.remove("hidden");
      (f.current_password.value ? f.new_password : f.current_password).focus();
      return;
    }
    try {
      await withBusy($("button", f), () => api("/auth/password", { method: "POST", body: { current_password: f.current_password.value, new_password: f.new_password.value } }));
      f.reset();
      toast(t("opac.account.password_updated"), "success");
    } catch (ex) { err.textContent = ex.message; err.classList.remove("hidden"); }
  });
}
