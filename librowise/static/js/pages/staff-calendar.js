// Staff: library calendar — month grid per branch, dated closures and weekly closed days.
import { $, $$, BOOT, api, confirmDialog, empty, html, icon, modal, skeleton, toast, withBusy } from "/static/js/core.js";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const state = { branch: null, year: 0, month: 0, data: null, branches: [] };

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const localDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayIso = () => { const d = new Date(); return iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
const fmt = (s, opts = { weekday: "long", day: "numeric", month: "long", year: "numeric" }) =>
  new Intl.DateTimeFormat(navigator.language || "en-IN", opts).format(localDate(s));
const branchName = () => state.branches.find((b) => b.id === state.branch)?.name || "";

function dayClass(d) {
  if (d.open) return d.open_override ? "special" : "open";
  return d.weekly ? "weekly" : "closed";
}

function dayLabel(d) {
  const state_ = d.open ? (d.open_override ? `Special opening${d.reason ? `: ${d.reason}` : ""}` : "Open")
    : `Closed${d.reason ? `: ${d.reason}` : ""}`;
  return `${fmt(d.date)} — ${state_}`;
}

function renderGrid() {
  const { days } = state.data;
  const lead = (localDate(days[0].date).getDay() + 6) % 7; // Monday-first weeks
  const today = todayIso();
  const cells = [...Array(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  const focusable = days.find((d) => d.date === today)?.date || days[0].date;
  $("#cal-grid").innerHTML = html`
    <div role="row" class="cal-row">${WEEKDAYS.map((w) => html`<div role="columnheader" class="cal-head"><abbr title="${w}">${w.slice(0, 3)}</abbr></div>`)}</div>
    ${rows.map((row) => html`<div role="row" class="cal-row">${row.map((d) => d
      ? html`<div role="gridcell"><button type="button" class="cal-day ${dayClass(d)} ${d.date === today ? "today" : ""} ${d.date < today ? "past" : ""}"
          data-date="${d.date}" tabindex="${d.date === focusable ? 0 : -1}" aria-label="${dayLabel(d)}">
          <span class="n">${Number(d.date.slice(8))}</span>
          ${d.reason && !d.weekly ? html`<span class="why">${d.reason}</span>` : ""}
          ${d.repeats_yearly ? html`<span class="tag" title="Repeats every year">yearly</span>` : ""}
          ${d.all_branches ? html`<span class="tag" title="All branches">all</span>` : ""}</button></div>`
      : html`<div role="gridcell" class="cal-blank"></div>`)}</div>`)}`;
}

async function load() {
  history.replaceState(null, "", `?branch=${state.branch}&month=${state.year}-${pad(state.month)}`);
  $("#cal-title").textContent = `${new Intl.DateTimeFormat(navigator.language || "en-IN", { month: "long", year: "numeric" })
    .format(new Date(state.year, state.month - 1, 1))} · ${branchName()}`;
  $("#cal-grid").innerHTML = skeleton(6);
  try {
    state.data = await api(`/calendar/${state.branch}/month?year=${state.year}&month=${state.month}`);
    renderGrid();
    renderWeekdays(state.data.closed_weekdays);
  } catch (e) {
    $("#cal-grid").innerHTML = empty(e.message, "alert");
  }
  loadUpcoming();
}

function renderWeekdays(closed) {
  $("#wk-days").innerHTML = html`<legend class="sr-only">Closed weekdays</legend>${WEEKDAYS.map((w, i) => html`
    <label class="checkbox"><input type="checkbox" name="wd" value="${i}" ${closed.includes(i) ? "checked" : ""}> ${w}</label>`)}`;
}

function nextOccurrence(e) {
  if (!e.repeats_yearly) return e.date;
  const t = todayIso();
  const y = Number(t.slice(0, 4));
  const thisYear = `${y}${e.date.slice(4)}`;
  return thisYear >= t ? thisYear : `${y + 1}${e.date.slice(4)}`;
}

async function loadUpcoming() {
  const box = $("#upcoming");
  box.innerHTML = skeleton(3);
  try {
    const { results } = await api(`/calendar/closures?branch_id=${state.branch}&start=${todayIso()}`);
    const rows = results.map((e) => ({ ...e, next: nextOccurrence(e) })).sort((a, b) => a.next.localeCompare(b.next)).slice(0, 25);
    box.innerHTML = rows.length ? html`<ul class="cal-upcoming">${rows.map((e) => html`<li>
        <div class="grow"><strong>${fmt(e.next, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</strong>
          ${e.open_override ? html`<span class="badge ok">Special opening</span>` : ""}
          <div class="small muted">${e.description || "Closed"} · ${e.all_branches ? "all branches" : e.branch}${e.repeats_yearly ? " · every year" : ""}</div></div>
        <button class="btn sm ghost danger" data-delete="${e.id}" data-label="${e.description || e.date}" aria-label="Remove ${e.description || "closure"} on ${e.next}">${icon("trash")}</button></li>`)}</ul>`
      : empty("No closures scheduled.", "clock");
  } catch (e) { box.innerHTML = empty(e.message, "alert"); }
}

// ------------------------------------------------------------------ dialogs

function closureForm(day, { allowDate = false } = {}) {
  return html`<div class="stack">
    ${allowDate ? html`<div class="grid cols-2">
        <div class="field"><label for="cl-day">From</label><input id="cl-day" name="day" type="date" required value="${day || todayIso()}"></div>
        <div class="field"><label for="cl-end">Until (optional)</label><input id="cl-end" name="end_day" type="date"><span class="hint">Close a range of days</span></div></div>`
      : html`<p>Close <strong>${branchName()}</strong> on <strong>${fmt(day)}</strong>.</p>`}
    <div class="field"><label for="cl-desc">Description</label><input id="cl-desc" name="description" maxlength="160" required placeholder="e.g. Diwali, Staff training day"></div>
    ${allowDate ? "" : html`<input type="hidden" name="day" value="${day}">
      <div class="field"><label for="cl-end">Closed through (optional)</label><input id="cl-end" name="end_day" type="date" min="${day}"><span class="hint">For multi-day closures such as renovations</span></div>`}
    <fieldset class="stack tight"><legend class="small" style="font-weight:600">Applies to</legend>
      <label class="checkbox"><input type="radio" name="scope" value="branch" checked> ${branchName()} only</label>
      <label class="checkbox"><input type="radio" name="scope" value="all"> All branches</label></fieldset>
    <label class="checkbox"><input type="checkbox" name="repeats_yearly"> Repeats every year on this date</label></div>`;
}

async function submitClosure(fd, { openOverride = false } = {}) {
  const body = {
    branch_id: fd.get("scope") === "all" ? null : state.branch,
    day: fd.get("day"),
    end_day: fd.get("end_day") || null,
    description: String(fd.get("description") || "").trim(),
    repeats_yearly: fd.has("repeats_yearly"),
    open_override: openOverride,
  };
  const r = await api("/calendar/closures", { method: "POST", body });
  toast(openOverride ? "Special opening saved" : `${r.results.length} day${r.results.length === 1 ? "" : "s"} closed`, "success");
  await load();
}

async function dayDialog(d) {
  try {
    if (d.closure_id) {
      const what = d.open_override ? "special opening" : "closure";
      const wide = [d.all_branches && "all branches", d.repeats_yearly && "every year"].filter(Boolean).join(" and ");
      const ok = await confirmDialog(`${fmt(d.date)}`, `${d.open_override ? "Special opening" : "Closed"}${d.reason ? `: ${d.reason}` : ""}. `
        + `Remove this ${what}?${wide ? ` It applies to ${wide}.` : ""}`, `Remove ${what}`);
      if (!ok) return;
      await api(`/calendar/closures/${d.closure_id}`, { method: "DELETE" });
      toast(`${what[0].toUpperCase()}${what.slice(1)} removed`, "success");
      await load();
    } else if (d.weekly) {
      const fd = await modal({ title: "Special opening", submit: "Open this day", body: html`<div class="stack">
        <p>${branchName()} is normally closed on ${WEEKDAYS[(localDate(d.date).getDay() + 6) % 7]}s. Open it on <strong>${fmt(d.date)}</strong>?</p>
        <div class="field"><label for="so-desc">Reason</label><input id="so-desc" name="description" maxlength="160" placeholder="e.g. Exam week"></div>
        <input type="hidden" name="day" value="${d.date}"><input type="hidden" name="scope" value="branch"></div>` });
      if (fd) await submitClosure(fd, { openOverride: true });
    } else {
      const fd = await modal({ title: "Close this day", submit: "Close day", body: closureForm(d.date) });
      if (fd) await submitClosure(fd);
    }
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ init

function move(delta) {
  const m = state.month - 1 + delta;
  state.year += Math.floor(m / 12);
  state.month = ((m % 12) + 12) % 12 + 1;
  load();
}

function gridKeys(e) {
  const btns = $$(".cal-day", $("#cal-grid"));
  const i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7, Home: -i, End: btns.length - 1 - i }[e.key];
  if (step === undefined) return;
  e.preventDefault();
  const j = i + step;
  if (j < 0) { move(-1); return; }
  if (j >= btns.length) { move(1); return; }
  btns[i].tabIndex = -1;
  btns[j].tabIndex = 0;
  btns[j].focus();
}

export default async function init() {
  const params = new URLSearchParams(location.search);
  try {
    state.branches = (await api("/lookups")).branches || [];
  } catch (e) { toast(e.message, "error"); return; }
  const wanted = Number(params.get("branch")) || BOOT.user?.home_branch_id;
  state.branch = (state.branches.find((b) => b.id === wanted) || state.branches[0])?.id;
  const sel = $("#cal-branch");
  sel.innerHTML = html`${state.branches.map((b) => html`<option value="${b.id}" ${b.id === state.branch ? "selected" : ""}>${b.name}</option>`)}`;
  sel.addEventListener("change", () => { state.branch = Number(sel.value); load(); });
  const m = /^(\d{4})-(\d{2})$/.exec(params.get("month") || "");
  const now = new Date();
  [state.year, state.month] = m ? [Number(m[1]), Number(m[2])] : [now.getFullYear(), now.getMonth() + 1];

  $("#cal-prev").addEventListener("click", () => move(-1));
  $("#cal-next").addEventListener("click", () => move(1));
  $("#cal-today").addEventListener("click", () => { const t = new Date(); state.year = t.getFullYear(); state.month = t.getMonth() + 1; load(); });
  $("#cal-grid").addEventListener("keydown", gridKeys);
  $("#cal-grid").addEventListener("click", (e) => {
    const b = e.target.closest(".cal-day");
    if (!b) return;
    const d = state.data.days.find((x) => x.date === b.dataset.date);
    if (d) dayDialog(d);
  });
  $("#weekdays-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const closed = $$("input[name=wd]:checked", e.target).map((c) => Number(c.value));
    try {
      await withBusy($("button[type=submit]", e.target), () => api(`/calendar/${state.branch}/weekdays`, { method: "PUT", body: { closed_weekdays: closed } }));
      toast("Weekly pattern saved", "success");
      load();
    } catch { /* toasted */ }
  });
  $("#add-closure").addEventListener("click", async () => {
    const fd = await modal({ title: "Add closure", submit: "Save closure", body: closureForm(null, { allowDate: true }) });
    if (!fd) return;
    try { await submitClosure(fd); } catch (e) { toast(e.message, "error"); }
  });
  $("#upcoming").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-delete]");
    if (!b) return;
    if (!(await confirmDialog("Remove closure?", `“${b.dataset.label}” will be removed from the calendar.`, "Remove"))) return;
    try {
      await withBusy(b, () => api(`/calendar/closures/${b.dataset.delete}`, { method: "DELETE" }));
      toast("Closure removed", "success");
      load();
    } catch { /* toasted */ }
  });
  load();
}
