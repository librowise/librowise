// OPAC home: hero search, "your library" strip (signed in), shelves, discover, reading lists, visit us.
import { $, $$, BOOT, api, cover, date, html, icon, money, num, parseDate, qs, relative } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { attachSuggest } from "/static/js/suggest.js";
import { avatar } from "/static/js/ui/avatar.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { FORMAT_ICON, bookCard, formatName, shelf, wireShelves } from "/static/js/pages/opac/common.js";

export { bookCard };

/** AI / keyword toggle of a search box (also used by the search results page). */
export function wireSearchMode(form) {
  const hidden = $("[name=mode]", form);
  const hint = document.getElementById($("[name=q]", form)?.getAttribute("aria-describedby") || "");
  $$("[data-mode]", form).forEach((btn) => btn.addEventListener("click", () => {
    $$("[data-mode]", form).forEach((b) => b.setAttribute("aria-pressed", b === btn));
    hidden.value = btn.dataset.mode;
    if (hint?.dataset.hintSmart) hint.textContent = btn.dataset.mode === "smart" ? hint.dataset.hintSmart : hint.dataset.hintKeyword;
    $("[name=q]", form).focus();
  }));
}

const SHELF_TITLES = { trending: "opac.home.shelf_trending", new: "opac.home.shelf_new", for_you: "opac.home.shelf_for_you" };
const SHELF_SUBS = { trending: "opac.home.sub_trending", new: "opac.home.sub_new", for_you: "opac.home.sub_for_you" };
const SHELF_HREF = { trending: "/search", new: "/search?sort=newest", for_you: "/account#foryou" };

// ------------------------------------------------------------------ "your library" strip

function youCard({ href, tone = "", ic, coverOf, label, value, note }) {
  return html`<a class="you-card ${tone ? `tone-${tone}` : ""}" href="${href}">
    ${coverOf ? html`<div aria-hidden="true">${cover(coverOf, "sm")}</div>` : html`<span class="you-ic">${icon(ic)}</span>`}
    <span class="yc-body"><span class="yc-label">${label}</span><span class="yc-value">${value}</span>${note ? html`<span class="yc-note">${note}</span>` : ""}</span></a>`;
}

async function yourLibrary() {
  const box = $("#you-strip");
  if (!box) return;
  try {
    const s = await api("/opac/me/summary");
    const loans = [...s.loans].sort((a, b) => parseDate(a.due_at) - parseDate(b.due_at));
    const overdue = loans.filter((l) => l.overdue);
    const ready = s.holds.filter((h) => h.status === "ready");
    const next = loans[0];
    const cards = [];
    if (next) {
      const days = Math.ceil((parseDate(next.due_at) - Date.now()) / 86400000);
      cards.push(youCard({
        href: "/account#loans", coverOf: next.item.biblio, tone: overdue.length ? "danger" : days <= 3 ? "warning" : "",
        label: overdue.length ? t("opac.home.you_overdue", { count: overdue.length }) : t("opac.home.you_due_next"),
        value: next.item.biblio.title,
        note: next.overdue ? t("opac.account.overdue_days", { count: next.days_overdue }) : t("opac.home.you_due", { when: relative(next.due_at), date: date(next.due_at) }),
      }));
    } else {
      cards.push(youCard({ href: "/search", ic: "book", label: t("opac.home.you_loans"), value: t("opac.home.you_no_loans"), note: t("opac.home.you_find") }));
    }
    cards.push(ready.length
      ? youCard({ href: "/account#holds", ic: "bookmark", tone: "info", label: t("opac.home.you_ready_label"), value: t("opac.account.n_ready", { count: ready.length }),
        note: t("opac.home.you_ready_at", { branch: ready[0].pickup_branch.name }) })
      : youCard({ href: "/account#holds", ic: "bookmark", label: t("opac.account.stat_holds"),
        value: s.holds.length ? t("opac.home.you_holds", { count: s.holds.length }) : t("opac.home.you_no_holds"),
        note: s.holds.length ? t("opac.account.none_ready") : t("opac.home.you_holds_hint") }));
    const owing = Number(s.balance) > 0;
    cards.push(owing
      ? youCard({ href: "/account#charges", ic: "wallet", tone: "warning", label: t("opac.account.stat_charges"), value: money(s.balance), note: t("opac.account.pay_at_desk") })
      : youCard({ href: "/account#foryou", ic: "sparkle", tone: "success", label: t("opac.home.you_picks"), value: t("opac.home.you_picks_value"), note: t("opac.home.you_picks_note") }));
    box.innerHTML = html`${cards}`;
  } catch {
    box.remove(); // the strip is a shortcut; the account page has the full picture
    return;
  }
  box.removeAttribute("aria-busy");
}

// ------------------------------------------------------------------ discover & visit

function discover(d) {
  if (!d || !d.total) return;
  const subjects = d.subjects.map(([s, n]) => html`<a class="topic" href="/search?${qs({ subject: s })}">${s.split(" -- ")[0]}<span class="n"><span class="sr-only">(</span>${num(n)}<span class="sr-only">)</span></span></a>`);
  const authorsList = d.authors.map(([a, n]) => {
    const name = a.split(",").reverse().join(" ").trim();
    return html`<li><a href="/search?${qs({ author: a })}">${avatar(name, { size: "md" })}<span class="an"><strong>${name}</strong><span>${t("opac.home.titles_n", { count: n })}</span></span></a></li>`;
  });
  const formats = d.formats.map(([f, n]) => html`<a class="format-tile" href="/search?${qs({ material_type: f })}">${icon(FORMAT_ICON[f] || "book")}<strong>${formatName(f)}</strong><span>${t("opac.home.titles_n", { count: n })}</span></a>`);
  $("#discover-sub").textContent = t("opac.home.discover_sub", { count: d.total });
  $("#discover").innerHTML = html`
    <div class="discover-card"><h3>${icon("list")}${t("opac.home.popular_subjects")}</h3><div class="topic-cloud">${subjects}</div>
      ${formats.length ? html`<div class="format-tiles">${formats}</div>` : ""}</div>
    <div class="discover-card"><h3>${icon("users")}${t("opac.home.popular_authors")}</h3><ul class="author-list">${authorsList}</ul>
      <p class="small" style="margin:1rem 0 0"><a href="/browse">${t("opac.home.browse_az")}</a></p></div>`;
  $("#discover-section").hidden = false;
}

const WEEKDAY = (d) => new Intl.DateTimeFormat(document.documentElement.lang || "en", { weekday: "narrow" }).format(parseDate(d));
const WEEKDAY_LONG = (d) => new Intl.DateTimeFormat(document.documentElement.lang || "en", { weekday: "long", day: "numeric", month: "long" }).format(parseDate(d));

function branchCard(b, today) {
  const status = b.open_today
    ? html`<span class="badge pill success"><span class="dot" aria-hidden="true"></span>${t("opac.home.open_today")}</span>`
    : html`<span class="badge pill neutral"><span class="dot" aria-hidden="true"></span>${t("opac.home.closed_today")}</span>
      <span>${b.reason ? `${b.reason} · ` : ""}${t("opac.home.reopens", { date: WEEKDAY_LONG(b.next_open) })}</span>`;
  const rows = [
    b.address ? html`<dt>${icon("map")}<span class="sr-only">${t("opac.home.address")}</span></dt><dd>${b.address}</dd>` : "",
    b.phone ? html`<dt>${icon("send")}<span class="sr-only">${t("opac.home.phone")}</span></dt><dd><a href="tel:${b.phone.replace(/[^\d+]/g, "")}">${b.phone}</a></dd>` : "",
    b.email ? html`<dt>${icon("inbox")}<span class="sr-only">${t("opac.home.email")}</span></dt><dd><a href="mailto:${b.email}">${b.email}</a></dd>` : "",
  ];
  return html`<article class="branch-card" aria-labelledby="br-${b.id}">
    <h3 id="br-${b.id}">${b.name}</h3>
    <div class="bc-status">${status}</div>
    ${rows.some(Boolean) ? html`<dl>${rows}</dl>` : ""}
    <div><div class="eyebrow" id="wk-${b.id}">${t("opac.home.this_week")}</div>
      <ul class="week" aria-labelledby="wk-${b.id}">${b.week.map((d) => html`<li class="${d.open ? "" : "closed"} ${d.date === today ? "today" : ""}"
        title="${WEEKDAY_LONG(d.date)}"><span aria-hidden="true">${WEEKDAY(d.date)}</span><span class="sr-only">${WEEKDAY_LONG(d.date)}: ${d.open ? t("opac.home.open") : t("opac.home.closed")}</span></li>`)}</ul></div>
    ${b.closures.length ? html`<p class="small muted" style="margin:0">${icon("calendar")} ${t("opac.home.upcoming_closures")}: ${b.closures.map((c) => `${date(c.date)}${c.reason ? ` (${c.reason})` : ""}`).join(", ")}</p>` : ""}
  </article>`;
}

async function visit() {
  try {
    const r = await api("/opac/library");
    if (!r.branches.length) return;
    $("#visit").innerHTML = html`${r.branches.map((b) => branchCard(b, r.today))}`;
    $("#visit-section").hidden = false;
  } catch { /* optional section */ }
}

// ------------------------------------------------------------------ page

export default async function init() {
  const form = $("#hero-search");
  wireSearchMode(form);
  attachSuggest($("#hero-q"));
  $(".suggest-chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-q]");
    if (chip) location.href = `/search?${qs({ mode: "smart", q: chip.dataset.q })}`;
  });
  if (BOOT.user) yourLibrary();
  visit();

  const shelvesBox = $("#shelves");
  try {
    const { shelves, discover: d } = await api("/opac/home");
    shelvesBox.innerHTML = shelves.length ? html`${shelves.map((s) => shelf({
      id: `shelf-${s.key}`, title: SHELF_TITLES[s.key] ? t(SHELF_TITLES[s.key]) : s.title, sub: SHELF_SUBS[s.key] ? t(SHELF_SUBS[s.key]) : "",
      href: SHELF_HREF[s.key] || "/search", items: s.results }))}`
      : emptyState({ art: "books", title: t("opac.home.empty"), body: t("opac.home.empty_body") });
    wireShelves(shelvesBox);
    discover(d);
  } catch (e) {
    shelvesBox.innerHTML = errorState(e);
    shelvesBox.addEventListener("click", (ev) => { if (ev.target.closest("[data-retry]")) location.reload(); }, { once: true });
  } finally {
    shelvesBox.removeAttribute("aria-busy");
  }
  try {
    const lists = await api("/opac/lists/public");
    const withTitles = lists.results.filter((l) => l.count);
    if (withTitles.length) {
      $("#public-lists").innerHTML = html`${withTitles.slice(0, 4).map((l) => shelf({ title: l.name, sub: t("opac.home.reading_list", { count: l.count }), items: l.results }))}`;
      wireShelves($("#public-lists"));
    }
  } catch { /* optional section */ }
}
