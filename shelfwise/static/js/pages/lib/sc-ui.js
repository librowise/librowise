// Shared UI helpers for the serials and course-reserves pages.
import { $, $$, api, empty, html, icon, modal, qs, withBusy } from "/static/js/core.js";

/** Wire a `.tabs` tablist: click + arrow-key navigation. Returns a function that selects a tab by key. */
export function setupTabs(root, onSelect) {
  const tabs = $$('[role="tab"]', root);
  const select = (tab, focus = false) => {
    tabs.forEach((t) => { const on = t === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
    $(`#${tab.getAttribute("aria-controls")}`)?.setAttribute("aria-labelledby", tab.id);
    if (focus) tab.focus();
    onSelect(tab.dataset.tab);
  };
  root.addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t) select(t); });
  root.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
  return (key) => { const t = tabs.find((x) => x.dataset.tab === key); if (t) select(t); return !!t; };
}

/** Modal form that stays open until `action(FormData, dialog)` succeeds (errors are toasted).
 *  Resolves to the action's result, or null if cancelled. Inputs with `data-no-submit` ignore Enter. */
export function formModal(opts, action, setup) {
  let result = null;
  const done = modal(opts);
  const dlg = $$("dialog").at(-1);
  const form = $("form", dlg);
  const ok = $('button[value="ok"]', dlg);
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT" && !("noSubmit" in e.target.dataset) && e.target.type !== "checkbox") {
      e.preventDefault();
      form.requestSubmit(ok);
    }
  });
  form.addEventListener("submit", async (e) => {
    if (e.submitter !== ok) return;
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    try {
      result = await withBusy(ok, () => action(new FormData(form), dlg));
      dlg.close("ok");
    } catch { /* toast already shown by withBusy */ }
  });
  setup?.(dlg);
  return done.then(() => result);
}

export const errorBox = (msg) => html`<div class="alert bad" role="alert">${icon("alert")}<div>${msg}</div></div>`;
export const str = (fd, k) => String(fd.get(k) ?? "").trim();
export const optInt = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v));
export const paise = (rupees) => Math.round(Number(rupees || 0) * 100);
/** Local calendar date as YYYY-MM-DD (for <input type=date> defaults). */
export const isoDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * An ordered people picker (routing lists, course instructors). Renders into `root` and returns
 * `{ value() }` giving the selected `[{id, name, card_number, notes}]` in order.
 */
export function peoplePicker(root, { selected = [], ordered = false, notes = false, label = "Add a person" } = {}) {
  const people = selected.map((p) => ({ ...p }));
  const uid = Math.random().toString(36).slice(2, 8);
  root.innerHTML = html`<div class="stack tight">
    <ol class="sc-people ${ordered ? "ordered" : ""}" aria-live="polite"></ol>
    <div class="field"><label for="pp-q-${uid}">${label}</label>
      <div class="input-group"><input id="pp-q-${uid}" type="search" placeholder="Name or card number" autocomplete="off" data-no-submit>
      <button type="button" class="btn" data-pp-search>${icon("search")}<span class="sr-only">Search</span></button></div></div>
    <div class="sc-people-results" role="list"></div></div>`;
  const list = $("ol", root), input = $("input", root), results = $(".sc-people-results", root);
  const draw = () => {
    list.innerHTML = people.length ? html`${people.map((p, i) => html`<li>
      <span class="grow"><strong>${p.name}</strong> <span class="tiny muted mono">${p.card_number || ""}</span>
        ${notes ? html`<input type="text" class="sc-note" data-note="${i}" value="${p.notes || ""}" placeholder="Note (optional)" aria-label="Note for ${p.name}" maxlength="255" data-no-submit>` : ""}</span>
      ${ordered ? html`<button type="button" class="btn ghost sm icon-only" data-up="${i}" aria-label="Move ${p.name} up" ${i === 0 ? "disabled" : ""}>${icon("arrow-up")}</button>
        <button type="button" class="btn ghost sm icon-only" data-down="${i}" aria-label="Move ${p.name} down" ${i === people.length - 1 ? "disabled" : ""}>${icon("arrow-down")}</button>` : ""}
      <button type="button" class="btn ghost sm icon-only" data-remove="${i}" aria-label="Remove ${p.name}">${icon("x")}</button></li>`)}`
      : html`<li class="muted small">Nobody yet.</li>`;
  };
  const search = async () => {
    const q = input.value.trim();
    if (!q) { results.innerHTML = ""; return; }
    try {
      const r = await api(`/patrons?${qs({ q, per_page: 8 })}`);
      const rows = r.results.filter((p) => !people.some((x) => x.id === p.id));
      results.innerHTML = rows.length ? html`${rows.map((p) => html`<button type="button" class="chip" role="listitem" data-add="${p.id}"
          data-name="${p.full_name}" data-card="${p.card_number}">${icon("plus")} ${p.full_name} · ${p.card_number}</button>`)}`
        : html`<span class="small muted">No matching people.</span>`;
    } catch (e) { results.innerHTML = errorBox(e.message); }
  };
  root.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.matches("[data-pp-search]")) search();
    else if (t.dataset.add) {
      people.push({ id: +t.dataset.add, name: t.dataset.name, card_number: t.dataset.card, notes: "" });
      results.innerHTML = "";
      input.value = "";
      input.focus();
      draw();
    } else if (t.dataset.remove) { people.splice(+t.dataset.remove, 1); draw(); }
    else if (t.dataset.up) { const i = +t.dataset.up; [people[i - 1], people[i]] = [people[i], people[i - 1]]; draw(); $(`[data-up="${i - 1}"]`, root)?.focus(); }
    else if (t.dataset.down) { const i = +t.dataset.down; [people[i + 1], people[i]] = [people[i], people[i + 1]]; draw(); $(`[data-down="${i + 1}"]`, root)?.focus(); }
  });
  root.addEventListener("input", (e) => { if (e.target.dataset.note !== undefined) people[+e.target.dataset.note].notes = e.target.value; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  draw();
  return { value: () => people.map((p) => ({ ...p })) };
}

export const emptyRow = (cols, msg) => html`<tr><td colspan="${cols}">${empty(msg)}</td></tr>`;
