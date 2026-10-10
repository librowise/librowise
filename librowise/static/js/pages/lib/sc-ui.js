// Shared UI helpers for the serials and course-reserves pages (translated; see lib/collection.js for the rest).
import { $, $$, api, html, icon, qs } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { emptyState } from "/static/js/ui/empty.js";
import { alertBox, formModal, isoDay, optInt, paise, str } from "/static/js/pages/lib/collection.js";

export { formModal, isoDay, optInt, paise, str };

/** Wire a tablist: click + arrow-key navigation (RTL-aware). Returns a function that selects a tab by key. */
export function setupTabs(root, onSelect) {
  const tabs = $$('[role="tab"]', root);
  const select = (tab, focus = false) => {
    tabs.forEach((x) => { const on = x === tab; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; });
    $(`#${tab.getAttribute("aria-controls")}`)?.setAttribute("aria-labelledby", tab.id);
    if (focus) tab.focus();
    onSelect(tab.dataset.tab);
  };
  root.addEventListener("click", (e) => { const x = e.target.closest('[role="tab"]'); if (x) select(x); });
  root.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const rtl = getComputedStyle(root).direction === "rtl";
    const next = { [rtl ? "ArrowLeft" : "ArrowRight"]: i + 1, [rtl ? "ArrowRight" : "ArrowLeft"]: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
  return (key) => { const x = tabs.find((y) => y.dataset.tab === key); if (x) select(x); return !!x; };
}

export const errorBox = (msg) => alertBox(msg);
/** Calendar-day distance for a date-only value ("today", "in 3 days", "5 days ago"), in the UI language. */
export function relDay(ymd) {
  if (!ymd) return "";
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const now = new Date();
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  try { return new Intl.RelativeTimeFormat(document.documentElement.lang || "en", { numeric: "auto" }).format(days, "day"); } catch { return String(days); }
}
/** Legacy English plural helper (kept for callers outside the collection pages). */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * An ordered people picker (routing lists, course instructors). Renders into `root` and returns
 * `{ value() }` giving the selected `[{id, name, card_number, notes}]` in order.
 */
export function peoplePicker(root, { selected = [], ordered = false, notes = false, label = t("coll.sc.add_person") } = {}) {
  const people = selected.map((p) => ({ ...p }));
  const uid = Math.random().toString(36).slice(2, 8);
  root.innerHTML = html`<div class="stack tight">
    <ol class="sc-people ${ordered ? "ordered" : ""}" aria-live="polite"></ol>
    <div class="field"><label for="pp-q-${uid}">${label}</label>
      <div class="input-group"><input id="pp-q-${uid}" type="search" placeholder="${t("coll.holds.patron_placeholder")}" autocomplete="off" data-no-submit>
      <button type="button" class="btn" data-pp-search>${icon("search")}<span class="sr-only">${t("common.search")}</span></button></div></div>
    <div class="sc-people-results" role="list"></div></div>`;
  const list = $("ol", root), input = $("input", root), results = $(".sc-people-results", root);
  const draw = () => {
    list.innerHTML = people.length ? html`${people.map((p, i) => html`<li>
      <span class="grow"><strong>${p.name}</strong> <span class="tiny muted mono">${p.card_number || ""}</span>
        ${notes ? html`<input type="text" class="sc-note" data-note="${i}" value="${p.notes || ""}" placeholder="${t("coll.sc.note_optional")}" aria-label="${t("coll.sc.note_for", { name: p.name })}" maxlength="255" data-no-submit>` : ""}</span>
      ${ordered ? html`<button type="button" class="btn ghost sm icon-only" data-up="${i}" aria-label="${t("coll.sc.move_up", { name: p.name })}" ${i === 0 ? "disabled" : ""}>${icon("arrow-up")}</button>
        <button type="button" class="btn ghost sm icon-only" data-down="${i}" aria-label="${t("coll.sc.move_down", { name: p.name })}" ${i === people.length - 1 ? "disabled" : ""}>${icon("arrow-down")}</button>` : ""}
      <button type="button" class="btn ghost sm icon-only" data-remove="${i}" aria-label="${t("coll.chips.remove", { value: p.name })}">${icon("x")}</button></li>`)}`
      : html`<li class="muted small">${t("coll.sc.nobody")}</li>`;
  };
  const search = async () => {
    const q = input.value.trim();
    if (!q) { results.innerHTML = ""; return; }
    try {
      const r = await api(`/patrons?${qs({ q, per_page: 8 })}`);
      const rows = r.results.filter((p) => !people.some((x) => x.id === p.id));
      results.innerHTML = rows.length ? html`${rows.map((p) => html`<button type="button" class="chip" role="listitem" data-add="${p.id}"
          data-name="${p.full_name}" data-card="${p.card_number}">${icon("plus")} ${p.full_name} · ${p.card_number}</button>`)}`
        : html`<span class="small muted">${t("coll.sc.no_people")}</span>`;
    } catch (e) { results.innerHTML = errorBox(e.message); }
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.matches("[data-pp-search]")) search();
    else if (b.dataset.add) {
      people.push({ id: +b.dataset.add, name: b.dataset.name, card_number: b.dataset.card, notes: "" });
      results.innerHTML = "";
      input.value = "";
      input.focus();
      draw();
    } else if (b.dataset.remove) { people.splice(+b.dataset.remove, 1); draw(); input.focus(); }
    else if (b.dataset.up) { const i = +b.dataset.up; [people[i - 1], people[i]] = [people[i], people[i - 1]]; draw(); $(`[data-up="${i - 1}"]`, root)?.focus(); }
    else if (b.dataset.down) { const i = +b.dataset.down; [people[i + 1], people[i]] = [people[i], people[i + 1]]; draw(); $(`[data-down="${i + 1}"]`, root)?.focus(); }
  });
  root.addEventListener("input", (e) => { if (e.target.dataset.note !== undefined) people[+e.target.dataset.note].notes = e.target.value; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); search(); } });
  draw();
  return { value: () => people.map((p) => ({ ...p })) };
}

export const emptyRow = (cols, msg) => html`<tr><td colspan="${cols}">${emptyState({ compact: true, title: msg })}</td></tr>`;
