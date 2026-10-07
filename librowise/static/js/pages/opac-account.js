// OPAC "My account": overview tiles with next actions, then sections — loans (renew one / all, showing the
// new due date in place), holds (queue position, pickup readiness, pause/resume, edit, cancel), picks for you,
// reading lists, reading history (with its privacy switch), charges, purchase suggestions and settings
// (profile, security, notifications, privacy, appearance & language).
import { $, $$, BOOT, api, authors, confirmDialog, cover, date, html, icon, modal, money, num, parseDate, relative, toast, withBusy } from "/static/js/core.js";
import { wireTabs } from "/static/js/a11y.js";
import { t, wireLanguageSwitchers, languages, lang } from "/static/js/i18n.js";
import { applyAvatarHues } from "/static/js/ui/avatar.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { setFieldError } from "/static/js/ui/form.js";
import { statusPill } from "/static/js/ui/status.js";
import { bookCard, busy, passwordMeter, pwToggle, wirePasswordMeter, wirePasswordToggles } from "/static/js/pages/opac/common.js";
import { holdsPanel, messagingSection, onPanelChange, onPanelClick, onPanelSubmit, suggestionsPanel } from "/static/js/pages/opac-account-services.js";
import { mountSecurity } from "/static/js/security-panel.js";

let summary;
let pwCheck = null; // strength check of the settings form's new-password field
const renewResults = new Map(); // loan id → { ok, text } shown on the row after a renewal attempt
const TABS = ["loans", "holds", "foryou", "lists", "history", "charges", "suggestions", "settings"];
const daysUntil = (d) => Math.ceil((parseDate(d) - Date.now()) / 86400000);

// ------------------------------------------------------------------ overview

function tile({ tab, ic, label, value, note, next, tone = "" }) {
  return html`<button type="button" class="acct-tile ${tone ? `tone-${tone}` : ""}" data-goto="${tab}">
    <span class="at-label">${icon(ic)}${label}</span><span class="at-value">${value}</span>
    <span class="at-note">${note}</span>${next ? html`<span class="at-next">${next}${icon("arrow-right", "flip-rtl")}</span>` : ""}</button>`;
}

function renderOverview() {
  const loans = summary.loans;
  const overdue = loans.filter((l) => l.overdue).length;
  const ready = summary.holds.filter((h) => h.status === "ready");
  const soonest = [...loans].sort((a, b) => parseDate(a.due_at) - parseDate(b.due_at))[0];
  const owing = Number(summary.balance) > 0;
  const soonDays = soonest ? daysUntil(soonest.due_at) : null;
  $("#stats").innerHTML = html`
    ${tile({ tab: "loans", ic: "book", label: t("opac.account.stat_on_loan"), value: num(loans.length), tone: overdue ? "danger" : "",
      note: overdue ? t("opac.account.n_overdue", { count: overdue }) : loans.length ? t("opac.account.all_on_time") : t("opac.acct.nothing_borrowed"),
      next: loans.length ? t("opac.acct.next_renew") : t("opac.acct.next_find") })}
    ${tile({ tab: "loans", ic: "clock", label: t("opac.acct.stat_due_next"), tone: soonest && !soonest.overdue && soonDays <= 3 ? "warning" : soonest?.overdue ? "danger" : "",
      value: soonest ? (soonest.overdue ? t("opac.acct.overdue_short") : relative(soonest.due_at)) : "—",
      note: soonest ? soonest.item.biblio.title : t("opac.acct.no_due") })}
    ${tile({ tab: "holds", ic: "bookmark", label: t("opac.account.stat_holds"), value: num(summary.holds.length), tone: ready.length ? "info" : "",
      note: ready.length ? t("opac.acct.ready_at", { count: ready.length, branch: ready[0].pickup_branch.name }) : summary.holds.length ? t("opac.account.none_ready") : t("opac.acct.no_holds_short"),
      next: ready.length ? t("opac.acct.next_collect") : "" })}
    ${tile({ tab: "charges", ic: "wallet", label: t("opac.account.stat_charges"), value: money(summary.balance), tone: owing ? "danger" : "",
      note: owing ? t("opac.account.pay_at_desk") : t("opac.acct.nothing_owed"), next: owing ? t("opac.acct.next_details") : "" })}`;
  $("#stats").removeAttribute("aria-busy");
  $("#blocks").innerHTML = summary.blocks.length ? html`<div class="alert warn" role="alert" style="margin-bottom:1.25rem">${icon("alert")}<div><strong>${t("opac.account.blocked")}</strong> ${summary.blocks.join("; ")}</div></div>` : "";
  const counts = { loans: loans.length, holds: summary.holds.length };
  for (const [k, n] of Object.entries(counts)) {
    const el = $(`[data-count="${k}"]`);
    el.hidden = !n;
    el.textContent = num(n);
    el.classList.toggle("alert", k === "loans" ? overdue > 0 : ready.length > 0);
  }
}

// ------------------------------------------------------------------ loans

function dueTag(l) {
  if (l.overdue) return statusPill("loan", "overdue", t("opac.account.overdue_days", { count: l.days_overdue }));
  const d = daysUntil(l.due_at);
  return d <= 3 ? statusPill("loan", "due_soon", t("opac.account.due_rel", { when: relative(l.due_at) }))
    : statusPill("loan", "active", t("opac.account.due_on", { date: date(l.due_at) }));
}

function loanRow(l) {
  const b = l.item.biblio;
  const res = renewResults.get(l.id);
  return html`<li class="item-row ${l.overdue ? "is-overdue" : ""}">
    <a href="/record/${b.id}" tabindex="-1" aria-hidden="true">${cover(b)}</a>
    <div style="min-width:0"><h3><a href="/record/${b.id}">${b.title}</a></h3>
      <div class="ir-meta">${[authors(b.authors), t("opac.account.borrowed_on", { date: date(l.issued_at) }), l.renewals ? t("opac.account.renewed_times", { count: l.renewals }) : ""].filter(Boolean).join(" · ")}</div>
      <div class="ir-tags">${dueTag(l)}<span class="tiny muted mono" title="${t("opac.acct.barcode")}">${l.item.barcode}</span>
        ${res ? html`<span class="ir-result ${res.ok ? "ok" : "bad"}" role="status">${icon(res.ok ? "check-circle" : "alert")}${res.text}</span>` : ""}</div></div>
    <div class="ir-actions"><button type="button" class="btn sm" data-renew="${l.id}" aria-label="${t("opac.account.renew_title", { title: b.title })}">${icon("refresh")}${t("opac.account.renew")}</button></div></li>`;
}

function loansPanel() {
  const loans = [...summary.loans].sort((a, b) => parseDate(a.due_at) - parseDate(b.due_at));
  if (!loans.length) return emptyState({ art: "books", title: t("opac.acct.no_loans_title"), body: t("opac.account.no_loans"),
    actions: html`<a class="btn primary" href="/search">${icon("search")}${t("opac.acct.find_more")}</a><a class="btn" href="/account#foryou" data-goto="foryou">${t("opac.acct.see_picks")}</a>` });
  const groups = [
    [t("opac.acct.group_overdue"), loans.filter((l) => l.overdue)],
    [t("opac.acct.group_week"), loans.filter((l) => !l.overdue && daysUntil(l.due_at) <= 7)],
    [t("opac.acct.group_later"), loans.filter((l) => !l.overdue && daysUntil(l.due_at) > 7)],
  ].filter(([, list]) => list.length);
  return html`<div class="panel-head"><div><h2>${t("opac.acct.tab_loans")}</h2><p class="sub">${t("opac.acct.loans_sub", { count: loans.length })}</p></div>
      <button type="button" class="btn" data-renew-all>${icon("refresh")}${t("opac.account.renew_all")}</button></div>
    ${groups.map(([title, list]) => html`<h3 class="group-title">${title} <span class="badge neutral">${num(list.length)}</span></h3>
      <ul class="item-list">${list.map(loanRow)}</ul>`)}`;
}

async function renewOne(btn, id) {
  try {
    const l = await withBusy(btn, () => api(`/opac/me/loans/${id}/renew`, { method: "POST" }));
    renewResults.set(id, { ok: true, text: t("opac.account.renewed_until", { date: date(l.due_at) }) });
  } catch (err) {
    renewResults.set(id, { ok: false, text: err.message });
  }
  await refresh();
  await show("loans", { keepFocus: `[data-renew="${id}"]` });
}

async function renewAll(btn) {
  let ok = 0, failed = 0;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  for (const l of summary.loans) {
    try {
      const r = await api(`/opac/me/loans/${l.id}/renew`, { method: "POST" });
      renewResults.set(l.id, { ok: true, text: t("opac.account.renewed_until", { date: date(r.due_at) }) });
      ok++;
    } catch (err) {
      renewResults.set(l.id, { ok: false, text: err.message });
      failed++;
    }
  }
  toast(failed ? t("opac.account.renewed_some", { count: ok, failed }) : t("opac.account.renewed_n", { count: ok }), failed ? "info" : "success", 6000);
  await refresh();
  await show("loans", { keepFocus: "[data-renew-all]" });
}

// ------------------------------------------------------------------ for you, lists, history, charges

async function foryouPanel() {
  const r = await api("/opac/me/recommendations");
  return html`<div class="panel-head"><div><h2>${t("opac.acct.tab_foryou")}</h2></div></div>
    <p class="tip">${icon("sparkle")}<span>${r.reason === "personalised" ? t("opac.account.foryou_personal") : t("opac.account.foryou_trending")}</span></p>
    ${r.results.length ? html`<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(min(100%,9rem),1fr));gap:1.5rem 1rem">${r.results.map(bookCard)}</div>`
      : emptyState({ art: "books", title: t("opac.acct.no_picks") })}`;
}

async function listsPanel() {
  const { results } = await api("/opac/me/lists");
  const head = html`<div class="panel-head"><div><h2>${t("opac.acct.tab_lists")}</h2><p class="sub">${t("opac.acct.lists_sub")}</p></div>
    <button type="button" class="btn primary" data-new-list>${icon("plus")}${t("opac.acct.new_list")}</button></div>`;
  if (!results.length) return html`${head}${emptyState({ art: "books", title: t("opac.acct.no_lists_title"), body: t("opac.account.no_lists") })}`;
  return html`${head}${results.map((l) => html`<section class="list-card" aria-labelledby="list-${l.id}">
    <div class="lc-head"><h3 id="list-${l.id}">${l.name} ${l.is_public ? html`<span class="badge info">${icon("globe")}${t("opac.account.public")}</span>` : html`<span class="badge neutral">${t("opac.acct.private")}</span>`}
      <span class="small muted" style="font-weight:var(--fw-regular)">${t("opac.acct.titles_n", { count: l.count })}</span></h3>
      <button type="button" class="btn sm ghost danger" data-delete-list="${l.id}" data-name="${l.name}">${icon("trash")}${t("opac.account.delete_list")}</button></div>
    ${l.results.length ? html`<div class="shelf-row">${l.results.map((b) => html`<div class="lc-item">${bookCard(b)}
      <button type="button" class="btn ghost lc-remove" data-remove-from="${l.id}" data-biblio="${b.id}" aria-label="${t("opac.acct.remove_from_list", { title: b.title, list: l.name })}">${icon("x")}</button></div>`)}</div>`
      : html`<p class="muted small" style="margin:0">${t("opac.acct.empty_list")}</p>`}</section>`)}`;
}

async function historyPanel() {
  const r = await api("/opac/me/history");
  const toggle = html`<div class="set-section" style="margin-bottom:1.25rem;grid-template-columns:minmax(0,1fr)"><div class="switch-row">
    <div class="sr-text"><strong id="kh-label">${t("opac.account.keep_history")}</strong><span id="kh-desc">${r.keep_history ? t("opac.account.history_on") : t("opac.account.history_off")}</span></div>
    <span class="switch"><input type="checkbox" role="switch" id="keep-history" aria-labelledby="kh-label" aria-describedby="kh-desc" ${r.keep_history ? "checked" : ""}></span></div></div>`;
  const head = html`<div class="panel-head"><div><h2>${t("opac.acct.tab_history")}</h2><p class="sub">${t("opac.acct.history_sub", { count: r.results.length })}</p></div></div>`;
  if (!r.results.length) return html`${head}${toggle}${emptyState({ art: "inbox", title: t("opac.account.no_history"), body: r.keep_history ? t("opac.acct.history_empty_on") : t("opac.acct.history_empty_off") })}`;
  return html`${head}${toggle}<ul class="item-list">${r.results.map((l) => {
    const b = l.item.biblio;
    return html`<li class="item-row"><a href="/record/${b.id}" tabindex="-1" aria-hidden="true">${cover(b)}</a>
      <div style="min-width:0"><h3><a href="/record/${b.id}">${b.title}</a></h3><div class="ir-meta">${authors(b.authors)}</div>
        <div class="ir-tags"><span>${t("opac.acct.borrowed_returned", { from: date(l.issued_at), to: date(l.returned_at) })}</span></div></div>
      <div class="ir-actions"><a class="btn sm" href="/record/${b.id}">${t("opac.acct.borrow_again")}</a></div></li>`;
  })}</ul>
    <section class="set-section" style="margin-top:2rem;grid-template-columns:minmax(0,1fr)" aria-labelledby="danger-h">
      <div class="switch-row"><div class="sr-text"><strong id="danger-h">${t("opac.account.clear_history")}</strong><span>${t("opac.account.clear_history_text")}</span></div>
      <button type="button" class="btn danger" data-clear-history>${icon("trash")}${t("opac.account.clear_history")}</button></div></section>`;
}

const LEDGER = { overdue: "opac.account.ledger_overdue", lost: "opac.account.ledger_lost", manual: "opac.account.ledger_manual", payment: "opac.account.ledger_payment", waiver: "opac.account.ledger_waiver" };

function chargesPanel() {
  const owing = Number(summary.balance) > 0;
  return html`<div class="panel-head"><div><h2>${t("opac.acct.tab_charges")}</h2></div></div>
    <div class="balance-card"><div><div class="eyebrow">${t("opac.account.balance")}</div><div class="bal ${owing ? "owing" : "clear"}">${money(summary.balance)}</div></div>
      <div class="bal-help">${owing ? html`<p><strong>${t("opac.acct.how_to_pay")}</strong></p><p>${t("opac.acct.how_to_pay_body")}</p>`
        : html`<p><strong>${t("opac.account.no_charges")}</strong></p><p>${t("opac.acct.charges_clear_body")}</p>`}</div></div>
    ${summary.ledger.length ? html`<div class="card flush"><div class="table-wrap" tabindex="0" role="region" aria-labelledby="ledger-cap"><table class="table"><caption class="sr-only" id="ledger-cap">${t("opac.acct.ledger")}</caption>
      <thead><tr><th scope="col">${t("opac.account.col_date")}</th><th scope="col">${t("opac.account.col_type")}</th><th scope="col">${t("opac.account.col_description")}</th><th scope="col" class="num">${t("opac.account.col_amount")}</th></tr></thead>
      <tbody>${summary.ledger.map((e) => html`<tr><td class="nowrap">${date(e.created_at)}</td><td><span class="badge pill ${e.amount > 0 ? "warning" : "success"}"><span class="dot" aria-hidden="true"></span>${LEDGER[e.kind] ? t(LEDGER[e.kind]) : e.kind}</span></td>
        <td>${e.note || "—"}</td><td class="num">${money(e.amount)}</td></tr>`)}</tbody></table></div></div>` : ""}`;
}

// ------------------------------------------------------------------ settings

function section(id, ic, title, desc, body) {
  return html`<section class="set-section" aria-labelledby="set-${id}"><header><h2 id="set-${id}">${icon(ic)}${title}</h2>${desc ? html`<p>${desc}</p>` : ""}</header>
    <div class="set-body">${body}</div></section>`;
}

async function settingsPanel() {
  const [me, messaging] = await Promise.all([api("/auth/me"), messagingSection()]);
  const profile = [
    [t("opac.acct.name"), me.full_name], [t("opac.acct.card_number"), me.card_number], [t("opac.acct.email"), me.email || "—"],
    [t("opac.acct.phone"), me.phone || "—"], [t("opac.acct.home_branch"), me.home_branch?.name], [t("opac.acct.category"), me.category?.name],
    [t("opac.acct.member_until_label"), me.expires_on ? date(me.expires_on) : t("opac.acct.no_expiry")],
  ];
  const langs = Object.entries(languages);
  return html`<div class="settings-grid">
    ${section("profile", "user", t("opac.acct.set_profile"), t("opac.acct.set_profile_desc"), html`<dl class="profile-dl">${profile.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`)}
    ${section("security", "shield", t("opac.acct.set_security"), t("opac.acct.set_security_desc"), html`
      <form class="stack" id="pw-form" novalidate aria-labelledby="pw-h">
        <h3 id="pw-h" style="margin:0;font-size:1rem">${t("opac.account.change_password")}</h3>
        <div class="field"><label for="cur">${t("opac.account.current_password")}</label>
          <div class="pw-wrap"><input id="cur" name="current_password" type="password" autocomplete="current-password" required aria-describedby="cur-err">${pwToggle("cur")}</div>
          <div class="field-error" id="cur-err" hidden></div></div>
        <div class="field"><label for="new">${t("opac.account.new_password")}</label>
          <div class="pw-wrap"><input id="new" name="new_password" type="password" autocomplete="new-password" minlength="10" required aria-describedby="new-rules new-err">${pwToggle("new")}</div>
          ${passwordMeter("new")}<div class="field-error" id="new-err" hidden></div></div>
        <div><button class="btn primary" type="submit">${t("opac.account.update_password")}</button></div>
      </form>
      <div id="security-root"></div>`)}
    ${section("notify", "bell", t("opac.acct.set_notify"), t("opac.acct.set_notify_desc"), messaging)}
    ${section("privacy", "key", t("opac.account.privacy"), t("opac.acct.set_privacy_desc"), html`<div class="switch-row">
      <div class="sr-text"><strong id="kh-label">${t("opac.account.keep_history")}</strong><span id="kh-desc">${t("opac.account.privacy_note")}</span></div>
      <span class="switch"><input type="checkbox" role="switch" id="keep-history" aria-labelledby="kh-label" aria-describedby="kh-desc" ${me.keep_history ? "checked" : ""}></span></div>`)}
    ${section("look", "palette", t("opac.acct.set_look"), t("opac.acct.set_look_desc"), html`<div class="row">
      <button type="button" class="btn" data-appearance>${icon("palette")}${t("opac.account.appearance_button")}</button>
      ${langs.length > 1 ? html`<div class="field" style="min-width:12rem"><label for="acct-lang">${t("common.language")}</label>
        <select id="acct-lang" data-lang-switch>${langs.map(([code, name]) => html`<option value="${code}" lang="${code}" ${code === lang ? "selected" : ""}>${name}</option>`)}</select></div>` : ""}</div>`)}
  </div>`;
}

async function changePassword(f) {
  const cur = f.current_password, nw = f.new_password;
  setFieldError(cur, ""); setFieldError(nw, "");
  const strength = pwCheck?.() || null;
  let bad = null;
  if (!cur.value) { setFieldError(cur, t("opac.acct.pw_current_needed")); bad = cur; }
  if (nw.value.length < 10 || !strength?.ok) { setFieldError(nw, t("opac.acct.pw_rules_unmet")); bad ||= nw; }
  if (bad) { bad.focus(); return; }
  try {
    await busy($("button[type=submit]", f), () => api("/auth/password", { method: "POST", body: { current_password: cur.value, new_password: nw.value } }));
    f.reset();
    nw.dispatchEvent(new Event("input"));
    toast(t("opac.account.password_updated"), "success");
  } catch (ex) {
    if (ex.status === 400) { setFieldError(cur, ex.message); cur.focus(); } else { setFieldError(nw, ex.message); nw.focus(); }
  }
}

// ------------------------------------------------------------------ tabs

const PANELS = { loans: loansPanel, holds: () => holdsPanel(summary), foryou: foryouPanel, lists: listsPanel, history: historyPanel,
  charges: chargesPanel, suggestions: suggestionsPanel, settings: settingsPanel };
let current = null;

async function show(tab, { keepFocus = null } = {}) {
  current = tab;
  $$("#tabs [role=tab]").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.tab === tab)));
  $("#tab-select").value = tab;
  history.replaceState(null, "", `#${tab}`);
  const panel = $("#panel");
  panel.setAttribute("aria-busy", "true");
  if (!keepFocus) panel.innerHTML = html`<div aria-hidden="true">${Array.from({ length: 3 }, () => html`<div class="skeleton" style="height:6rem;border-radius:var(--radius-lg);margin-bottom:.75rem"></div>`)}</div>`;
  let out;
  try {
    out = await PANELS[tab]();
  } catch (e) {
    out = errorState(e);
  }
  if (current !== tab) return; // the reader moved on while this loaded
  panel.innerHTML = out;
  panel.removeAttribute("aria-busy");
  if (keepFocus) $(keepFocus, panel)?.focus();
  if (tab === "settings") {
    wirePasswordToggles(panel);
    const nw = $("#new", panel);
    if (nw) pwCheck = wirePasswordMeter(nw, { personal: () => [...String(BOOT.user?.name || "").split(/\s+/), BOOT.user?.card] });
    wireLanguageSwitchers(panel);
    if ($("#security-root")) mountSecurity($("#security-root")).catch((e) => toast(e.message, "error"));
  }
}

async function refresh() {
  summary = await api("/opac/me/summary");
  renderOverview();
}

export default async function init() {
  applyAvatarHues();
  const tablist = $("#tabs");
  wireTabs(tablist, $("#panel"));
  tablist.addEventListener("click", (e) => { const x = e.target.closest("[data-tab]"); if (x) show(x.dataset.tab); });
  $("#tab-select").addEventListener("change", (e) => show(e.target.value));
  const initial = location.hash.slice(1);
  const first = TABS.includes(initial) ? initial : "loans";
  try {
    await refresh();
  } catch (e) {
    $("#stats").innerHTML = "";
    $("#panel").innerHTML = errorState(e);
    return;
  }
  show(first);
  window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (TABS.includes(h) && h !== current) show(h); });

  document.addEventListener("click", (e) => {
    const go = e.target.closest("[data-goto]");
    if (go) { e.preventDefault(); show(go.dataset.goto); $(`#tab-${go.dataset.goto}`)?.scrollIntoView({ block: "nearest" }); }
  });
  const panel = $("#panel");
  panel.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.renew) await renewOne(b, Number(b.dataset.renew));
      else if (b.hasAttribute("data-renew-all")) await renewAll(b);
      else if (b.hasAttribute("data-new-list")) {
        const fd = await modal({ title: t("opac.acct.new_list"), submit: t("opac.acct.create"), size: "sm", body: html`<div class="stack">
          <div class="field"><label for="nl-name">${t("opac.record.new_list_name")}</label><input id="nl-name" name="name" required maxlength="120" placeholder="${t("opac.record.new_list_placeholder")}"></div>
          <label class="checkbox"><input type="checkbox" name="public"> ${t("opac.record.new_list_public")}</label></div>` });
        if (!fd) return;
        await api("/opac/me/lists", { method: "POST", body: { name: String(fd.get("name")).trim(), is_public: fd.get("public") === "on" } });
        toast(t("opac.acct.list_created"), "success");
        await show("lists");
      } else if (b.dataset.deleteList) {
        if (!(await confirmDialog(t("opac.account.delete_list_q"), t("opac.acct.delete_list_text", { name: b.dataset.name }), t("opac.account.delete_list")))) return;
        await api(`/opac/me/lists/${b.dataset.deleteList}`, { method: "DELETE" });
        toast(t("opac.acct.list_deleted"), "success");
        await show("lists");
      } else if (b.dataset.removeFrom) {
        const { removeFrom, biblio } = b.dataset;
        await withBusy(b, () => api(`/opac/me/lists/${removeFrom}/items/${biblio}`, { method: "DELETE" }));
        toast(t("opac.acct.removed_from_list"), "success", { action: { label: t("opac.acct.undo"), run: async () => {
          await api(`/opac/me/lists/${removeFrom}/items/${biblio}`, { method: "POST" });
          if (current === "lists") show("lists");
        } } });
        await show("lists");
      } else if (b.hasAttribute("data-clear-history")) {
        if (!(await confirmDialog(t("opac.account.clear_history_q"), t("opac.account.clear_history_text"), t("opac.account.clear_history")))) return;
        const r = await api("/opac/me/history", { method: "DELETE" });
        toast(t("opac.account.anonymised", { count: r.anonymized }), "success");
        await show("history");
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
  const ctx = { refresh, show };
  panel.addEventListener("click", (e) => onPanelClick(e, ctx));
  panel.addEventListener("submit", (e) => onPanelSubmit(e, ctx));
  panel.addEventListener("change", onPanelChange);
  panel.addEventListener("change", async (e) => {
    if (e.target.id !== "keep-history") return;
    const on = e.target.checked;
    try {
      await api("/auth/preferences", { method: "PATCH", body: { keep_history: on } });
      toast(on ? t("opac.acct.history_now_on") : t("opac.acct.history_now_off"), "success");
      const desc = $("#kh-desc", panel);
      if (desc && current === "history") desc.textContent = on ? t("opac.account.history_on") : t("opac.account.history_off");
    } catch (err) { e.target.checked = !on; toast(err.message, "error"); }
  });
  panel.addEventListener("submit", (e) => {
    if (e.target.id !== "pw-form") return;
    e.preventDefault();
    changePassword(e.target);
  });
}
