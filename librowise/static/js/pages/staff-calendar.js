// Staff › Calendar: when each branch is open. Due dates skip closed days, fines count open days only and
// hold pickup windows are measured in open days, so this page drives real behaviour.
//   Month view — one branch, always six weeks tall (no layout shift between months), arrow-key navigation.
//   Week view  — every branch side by side for one week: "who is open on Diwali week?" at a glance.
import { $, $$, BOOT, api, html, icon, modal, toast } from "/static/js/core.js";
import { locale, t } from "/static/js/i18n.js";
import { confirmDialog } from "/static/js/ui/dialog.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";

const S = { branch: 0, branches: [], view: "month", year: 0, month: 0, weekStart: null, data: null, months: new Map(), seq: 0 };
const canEdit = () => $("#cal").dataset.canEdit === "true";

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayIso = () => isoOf(new Date());
const fmt = (s, opts = { weekday: "long", day: "numeric", month: "long", year: "numeric" }) => new Intl.DateTimeFormat(locale, opts).format(dateOf(s));
const mondayOf = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
// Monday-first weekday names in the UI language (1 Jan 2024 was a Monday).
const WEEKDAYS = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i));
const wdName = (i, style = "long") => new Intl.DateTimeFormat(locale, { weekday: style }).format(WEEKDAYS[i]);
const branchName = (id = S.branch) => S.branches.find((b) => b.id === id)?.name || "";

function kindOf(d) {
  if (d.open) return d.open_override ? "special" : "open";
  return d.weekly && !d.closure_id ? "weekly" : "closed";
}
function statusText(d) {
  const k = kindOf(d);
  const why = d.reason && k !== "weekly" ? d.reason : "";
  return why ? t(`desk.cal.state_${k}_why`, { reason: why }) : t(`desk.cal.state_${k}`);
}

async function month(branch, year, m) {
  const key = `${branch}:${year}-${m}`;
  if (!S.months.has(key)) S.months.set(key, api(`/calendar/${branch}/month?year=${year}&month=${m}`).catch((e) => { S.months.delete(key); throw e; }));
  return S.months.get(key);
}

// ------------------------------------------------------------------ month view

function monthGrid(data) {
  const first = dateOf(data.days[0].date);
  const lead = (first.getDay() + 6) % 7;
  const today = todayIso();
  const cells = [...Array(lead).fill(null), ...data.days];
  while (cells.length < 42) cells.push(null); // always six weeks: the card never changes height
  const focus = data.days.find((d) => d.date === today)?.date || data.days[0].date;
  const rows = [];
  for (let i = 0; i < 42; i += 7) rows.push(cells.slice(i, i + 7));
  return html`<div class="cal-grid" role="grid" aria-labelledby="cal-title">
    <div role="row" class="cal-row">${[...Array(7)].map((_, i) => html`<div role="columnheader" class="cal-head"><abbr title="${wdName(i)}">${wdName(i, "short")}</abbr></div>`)}</div>
    ${rows.map((row) => html`<div role="row" class="cal-row">${row.map((d) => (d ? html`<div role="gridcell" class="cal-cell">
      <button type="button" class="cal-day is-${kindOf(d)} ${d.date === today ? "is-today" : ""} ${d.date < today ? "is-past" : ""}" data-date="${d.date}"
        tabindex="${d.date === focus ? 0 : -1}" ${d.date === today ? html`aria-current="date"` : ""}>
        <span class="n" aria-hidden="true">${new Intl.NumberFormat(locale).format(Number(d.date.slice(8)))}</span>
        <span class="sr-only">${fmt(d.date)}, ${statusText(d)}</span>
        ${d.reason && kindOf(d) !== "weekly" ? html`<span class="why" aria-hidden="true">${d.reason}</span>` : ""}
        ${d.repeats_yearly || d.all_branches ? html`<span class="tags" aria-hidden="true">${d.repeats_yearly ? html`<span class="tag">${icon("refresh")}${t("desk.cal.tag_yearly")}</span>` : ""}${
          d.all_branches ? html`<span class="tag">${icon("globe")}${t("desk.cal.tag_all")}</span>` : ""}</span>` : ""}
      </button></div>` : html`<div role="gridcell" class="cal-cell is-blank"></div>`))}</div>`)}
  </div>`;
}

function gridKeys(e) {
  const btns = $$(".cal-day[data-date]", $("#cal-body"));
  const i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  const rtl = document.documentElement.dir === "rtl";
  const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: 7, ArrowUp: -7, Home: -(i % 7), End: 6 - (i % 7), PageUp: "prev", PageDown: "next" }[e.key];
  if (step === undefined) return;
  e.preventDefault();
  if (step === "prev" || step === "next") { move(step === "prev" ? -1 : 1); return; }
  const j = i + step;
  if (j < 0 || j >= btns.length) { move(j < 0 ? -1 : 1, { focusEdge: j < 0 ? "end" : "start" }); return; }
  btns[i].tabIndex = -1;
  btns[j].tabIndex = 0;
  btns[j].focus();
}

// ------------------------------------------------------------------ week view

async function weekData(start) {
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const months = [...new Set(days.map((d) => `${d.getFullYear()}-${d.getMonth() + 1}`))];
  const out = [];
  for (const b of S.branches) {
    const all = (await Promise.all(months.map((k) => { const [y, m] = k.split("-").map(Number); return month(b.id, y, m); }))).flatMap((x) => x.days);
    out.push({ branch: b, days: days.map((d) => all.find((x) => x.date === isoOf(d))) });
  }
  return { days, rows: out };
}

function weekTable(w) {
  const today = todayIso();
  return html`<div class="cal-week-wrap" role="region" aria-labelledby="cal-title" tabindex="0"><table class="cal-week">
    <caption class="sr-only">${t("desk.cal.week_caption")}</caption>
    <thead><tr><th scope="col">${t("common.branch")}</th>${w.days.map((d) => html`<th scope="col" class="${isoOf(d) === today ? "is-today" : ""}">
      <span class="wd">${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d)}</span>
      <span class="dn">${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d)}</span></th>`)}</tr></thead>
    <tbody>${w.rows.map((r) => html`<tr><th scope="row">${r.branch.name}</th>${r.days.map((d) => (d ? html`<td>
      <button type="button" class="cal-chip is-${kindOf(d)}" data-date="${d.date}" data-branch="${r.branch.id}">
        <span class="cc-state">${t(`desk.cal.state_${kindOf(d)}`)}</span>${d.reason && kindOf(d) !== "weekly" ? html`<span class="cc-why">${d.reason}</span>` : ""}
        <span class="sr-only">, ${r.branch.name}, ${fmt(d.date)}</span></button></td>` : html`<td>—</td>`))}</tr>`)}</tbody></table></div>`;
}

// ------------------------------------------------------------------ load & render

function title() {
  if (S.view === "month") {
    return t("desk.cal.title_month", { month: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(S.year, S.month - 1, 1)), branch: branchName() });
  }
  const end = addDays(S.weekStart, 6);
  const f = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
  return t("desk.cal.title_week", { range: f.formatRange ? f.formatRange(S.weekStart, end) : `${f.format(S.weekStart)} – ${f.format(end)}` });
}

async function load({ focusEdge = null } = {}) {
  const seq = ++S.seq;
  const q = S.view === "month" ? `branch=${S.branch}&month=${S.year}-${pad(S.month)}` : `branch=${S.branch}&week=${isoOf(S.weekStart)}`;
  history.replaceState(null, "", `?${q}`);
  $("#cal-title").textContent = title();
  const body = $("#cal-body");
  const hadFocus = body.contains(document.activeElement);
  try {
    if (S.view === "month") {
      const data = await month(S.branch, S.year, S.month);
      if (seq !== S.seq) return;
      S.data = data;
      body.innerHTML = monthGrid(data);
      renderWeekdays(data.closed_weekdays);
      if (hadFocus || focusEdge) {
        const btns = $$(".cal-day[data-date]", body);
        const target = focusEdge === "end" ? btns.at(-1) : focusEdge === "start" ? btns[0] : $(".cal-day[tabindex='0']", body);
        btns.forEach((b) => { b.tabIndex = b === target ? 0 : -1; });
        target?.focus();
      }
    } else {
      const w = await weekData(S.weekStart);
      if (seq !== S.seq) return;
      body.innerHTML = weekTable(w);
      const mine = await month(S.branch, S.weekStart.getFullYear(), S.weekStart.getMonth() + 1);
      renderWeekdays(mine.closed_weekdays);
    }
  } catch (e) {
    if (seq === S.seq) body.innerHTML = errorState(e);
  }
  loadUpcoming();
}

function renderWeekdays(closed) {
  $("#wk-days").innerHTML = html`<legend class="sr-only">${t("desk.cal.weekly_title")}</legend>${[...Array(7)].map((_, i) => html`
    <label class="cal-wd"><input type="checkbox" name="wd" value="${i}" ${closed.includes(i) ? "checked" : ""} ${canEdit() ? "" : "disabled"}><span>${wdName(i)}</span></label>`)}`;
}

function nextOccurrence(e) {
  if (!e.repeats_yearly) return e.date;
  const today = todayIso(), y = Number(today.slice(0, 4));
  const thisYear = `${y}${e.date.slice(4)}`;
  return thisYear >= today ? thisYear : `${y + 1}${e.date.slice(4)}`;
}

async function loadUpcoming() {
  const box = $("#upcoming");
  try {
    const { results } = await api(`/calendar/closures?branch_id=${S.branch}&start=${todayIso()}`);
    const rows = results.map((e) => ({ ...e, next: nextOccurrence(e) })).sort((a, b) => a.next.localeCompare(b.next)).slice(0, 12);
    box.innerHTML = rows.length ? html`<ul class="cal-upcoming">${rows.map((e) => html`<li>
        <span class="cu-date" aria-hidden="true"><span class="m">${fmt(e.next, { month: "short" })}</span><span class="d">${fmt(e.next, { day: "numeric" })}</span></span>
        <div class="grow"><strong>${e.description || (e.open_override ? t("desk.cal.special") : t("desk.cal.closed"))}</strong>
          <div class="small muted">${fmt(e.next, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
          <div class="cu-tags">${e.open_override ? html`<span class="badge pill success"><span class="dot" aria-hidden="true"></span>${t("desk.cal.special")}</span>` : ""}
            <span class="badge pill neutral">${e.all_branches ? t("desk.cal.all_branches") : e.branch}</span>
            ${e.repeats_yearly ? html`<span class="badge pill neutral">${t("desk.cal.every_year")}</span>` : ""}</div></div>
        ${canEdit() ? html`<button type="button" class="btn sm ghost icon-only danger" data-delete="${e.id}" data-label="${e.description || fmt(e.next)}"
          aria-label="${t("desk.cal.remove_named", { name: e.description || fmt(e.next) })}" data-tip="${t("desk.cal.remove")}">${icon("trash")}</button>` : ""}</li>`)}</ul>`
      : emptyState({ art: "done", compact: true, title: t("desk.cal.none_title"), body: t("desk.cal.none_body") });
  } catch (e) { box.innerHTML = errorState(e, { retry: false }); }
}

function move(delta, opts) {
  if (S.view === "month") {
    const m = S.month - 1 + delta;
    S.year += Math.floor(m / 12);
    S.month = ((m % 12) + 12) % 12 + 1;
  } else S.weekStart = addDays(S.weekStart, 7 * delta);
  load(opts);
}

function syncSeg() {
  $$("#cal-view [role=radio]").forEach((b) => { const on = b.dataset.value === S.view; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; });
}

function setView(view) {
  S.view = view;
  syncSeg();
  if (view === "week") {
    const anchor = S.year === new Date().getFullYear() && S.month === new Date().getMonth() + 1 ? new Date() : new Date(S.year, S.month - 1, 1);
    S.weekStart = mondayOf(anchor);
  } else if (S.weekStart) { S.year = S.weekStart.getFullYear(); S.month = S.weekStart.getMonth() + 1; }
  load();
}

// ------------------------------------------------------------------ dialogs

function closureForm(day, branch, { allowDate = false } = {}) {
  return html`<div class="stack">
    ${allowDate ? html`<div class="grid cols-2">
        <div class="field"><label for="cl-day">${t("desk.cal.from")}</label><input id="cl-day" name="day" type="date" required value="${day || todayIso()}"></div>
        <div class="field"><label for="cl-end">${t("desk.cal.until")} <span class="muted">${t("desk.optional")}</span></label><input id="cl-end" name="end_day" type="date"></div></div>`
      : html`<p>${t("desk.cal.close_on", { branch: branchName(branch), date: fmt(day) })}</p><input type="hidden" name="day" value="${day}">
        <div class="field"><label for="cl-end">${t("desk.cal.closed_through")} <span class="muted">${t("desk.optional")}</span></label><input id="cl-end" name="end_day" type="date" min="${day}">
          <span class="hint">${t("desk.cal.closed_through_hint")}</span></div>`}
    <div class="field"><label for="cl-desc">${t("desk.cal.description")}</label><input id="cl-desc" name="description" maxlength="160" required placeholder="${t("desk.cal.description_placeholder")}"></div>
    <fieldset class="stack tight cal-scope"><legend>${t("desk.cal.applies_to")}</legend>
      <label class="checkbox"><input type="radio" name="scope" value="branch" checked> ${t("desk.cal.only_branch", { branch: branchName(branch) })}</label>
      <label class="checkbox"><input type="radio" name="scope" value="all"> ${t("desk.cal.all_branches")}</label></fieldset>
    <label class="checkbox"><input type="checkbox" name="repeats_yearly"> ${t("desk.cal.repeats")}</label></div>`;
}

async function submitClosure(fd, branch, { openOverride = false } = {}) {
  const r = await api("/calendar/closures", { method: "POST", body: {
    branch_id: fd.get("scope") === "all" ? null : branch, day: fd.get("day"), end_day: fd.get("end_day") || null,
    description: String(fd.get("description") || "").trim(), repeats_yearly: fd.has("repeats_yearly"), open_override: openOverride } });
  toast(openOverride ? t("desk.cal.saved_special") : t("desk.cal.saved_closed", { count: r.results.length }), "success");
  S.months.clear();
  await load();
}

async function dayDialog(d, branch = S.branch) {
  if (!canEdit()) return;
  try {
    if (d.closure_id) {
      const what = d.open_override ? t("desk.cal.special") : t("desk.cal.closed");
      const scope = [d.all_branches && t("desk.cal.all_branches"), d.repeats_yearly && t("desk.cal.every_year")].filter(Boolean).join(" · ");
      const ok = await confirmDialog(fmt(d.date), `${what}${d.reason ? `: ${d.reason}` : ""}${scope ? ` (${scope})` : ""}. ${t("desk.cal.remove_q")}`, t("desk.cal.remove"));
      if (!ok) return;
      await api(`/calendar/closures/${d.closure_id}`, { method: "DELETE" });
      toast(t("desk.cal.removed"), "success");
      S.months.clear();
      await load();
    } else if (d.weekly) {
      const wd = (dateOf(d.date).getDay() + 6) % 7;
      const fd = await modal({ title: t("desk.cal.special_title"), submit: t("desk.cal.special_submit"), size: "sm", body: html`<div class="stack">
        <p>${t("desk.cal.special_body", { branch: branchName(branch), weekday: wdName(wd), date: fmt(d.date) })}</p>
        <div class="field"><label for="so-desc">${t("desk.cal.reason")} <span class="muted">${t("desk.optional")}</span></label><input id="so-desc" name="description" maxlength="160"></div>
        <input type="hidden" name="day" value="${d.date}"><input type="hidden" name="scope" value="branch"></div>` });
      if (fd) await submitClosure(fd, branch, { openOverride: true });
    } else {
      const fd = await modal({ title: t("desk.cal.close_title"), submit: t("desk.cal.close_submit"), body: closureForm(d.date, branch) });
      if (fd) await submitClosure(fd, branch);
    }
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ init

export default async function init() {
  const params = new URLSearchParams(location.search);
  try { S.branches = (await api("/lookups")).branches || []; } catch (e) { $("#cal-body").innerHTML = errorState(e); return; }
  if (!S.branches.length) { $("#cal-body").innerHTML = emptyState({ art: "inbox", title: t("desk.cal.no_branches") }); return; }
  const wanted = Number(params.get("branch")) || BOOT.user?.home_branch_id;
  S.branch = (S.branches.find((b) => b.id === wanted) || S.branches[0]).id;
  const sel = $("#cal-branch");
  sel.innerHTML = html`${S.branches.map((b) => html`<option value="${b.id}" ${b.id === S.branch ? "selected" : ""}>${b.name}</option>`)}`;
  sel.addEventListener("change", () => { S.branch = Number(sel.value); load(); });
  const m = /^(\d{4})-(\d{2})$/.exec(params.get("month") || "");
  const now = new Date();
  [S.year, S.month] = m ? [Number(m[1]), Number(m[2])] : [now.getFullYear(), now.getMonth() + 1];
  const wk = /^\d{4}-\d{2}-\d{2}$/.test(params.get("week") || "") ? dateOf(params.get("week")) : null;

  $("#cal-prev").addEventListener("click", () => move(-1));
  $("#cal-next").addEventListener("click", () => move(1));
  $("#cal-today").addEventListener("click", () => {
    const d = new Date();
    S.year = d.getFullYear(); S.month = d.getMonth() + 1; S.weekStart = mondayOf(d);
    load();
  });
  const seg = $("#cal-view");
  seg.addEventListener("click", (e) => { const b = e.target.closest("[role=radio]"); if (b && b.dataset.value !== S.view) setView(b.dataset.value); });
  seg.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = S.view === "month" ? "week" : "month";
    setView(next);
    $(`#cal-view [data-value="${next}"]`).focus();
  });
  $("#cal-body").addEventListener("keydown", gridKeys);
  $("#cal-body").addEventListener("click", async (e) => {
    if (e.target.closest("[data-retry]")) { S.months.clear(); load(); return; }
    const b = e.target.closest("[data-date]");
    if (!b) return;
    const branch = Number(b.dataset.branch) || S.branch;
    const day = b.dataset.date;
    const data = await month(branch, Number(day.slice(0, 4)), Number(day.slice(5, 7)));
    const d = data.days.find((x) => x.date === day);
    if (d) dayDialog(d, branch);
  });
  $("#weekdays-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const closed = $$("input[name=wd]:checked", e.target).map((c) => Number(c.value));
    try {
      await api(`/calendar/${S.branch}/weekdays`, { method: "PUT", body: { closed_weekdays: closed } });
      toast(t("desk.cal.weekly_saved", { branch: branchName() }), "success");
      S.months.clear();
      load();
    } catch (err) { toast(err.message, "error"); }
  });
  $("#add-closure")?.addEventListener("click", async () => {
    const fd = await modal({ title: t("desk.cal.add_closure"), submit: t("desk.cal.close_submit"), body: closureForm(null, S.branch, { allowDate: true }) });
    if (!fd) return;
    try { await submitClosure(fd, S.branch); } catch (err) { toast(err.message, "error"); }
  });
  $("#upcoming").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-delete]");
    if (!b) return;
    if (!(await confirmDialog(t("desk.cal.remove_title"), t("desk.cal.remove_body", { name: b.dataset.label }), t("desk.cal.remove")))) return;
    try {
      await api(`/calendar/closures/${b.dataset.delete}`, { method: "DELETE" });
      toast(t("desk.cal.removed"), "success");
      S.months.clear();
      load();
    } catch (err) { toast(err.message, "error"); }
  });
  if (wk) { S.weekStart = mondayOf(wk); S.view = "week"; syncSeg(); }
  load();
}
