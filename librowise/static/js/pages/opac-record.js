// OPAC record page: cinematic header with the availability card (one primary action: Place hold), tabs
// Details / Copies / Reviews / Similar, "more by this author" and the virtual shelf. Placing a hold while
// signed out returns here with ?hold=1 after sign-in and opens the hold dialog automatically.
import { $, $$, BOOT, api, authors, coverSrc, cover, date, html, icon, modal, num, qs, raw, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { openCitations, shelfBrowser } from "/static/js/record-extras.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { statusPill, statusText } from "/static/js/ui/status.js";
import { tabs, wireTabsPanel } from "/static/js/ui/tabs.js";
import { FORMAT_ICON, audienceName, bookCard, formatName, langName, shelf, skeletonCard, wireShelves } from "/static/js/pages/opac/common.js";

const UNHOLDABLE = ["withdrawn", "lost", "damaged", "missing"];
const stars = (n) => raw(`<span class="stars" role="img" aria-label="${t("opac.record.stars", { n: Math.round(n * 10) / 10 })}">${"★".repeat(Math.round(n))}${"☆".repeat(5 - Math.round(n))}</span>`);
const loginFor = (path) => `/login?${qs({ next: path })}`;

let b, mine = null, related = null;

// ------------------------------------------------------------------ header

function myState() {
  if (!mine) return {};
  const loan = mine.loans.find((l) => l.item.biblio.id === b.id);
  const hold = mine.holds.find((h) => h.biblio.id === b.id);
  return { loan, hold };
}

function availability() {
  const a = b.availability || { available: 0, total: 0 };
  const holdable = (b.items || []).filter((i) => !UNHOLDABLE.includes(i.status));
  const branches = new Map();
  for (const i of b.items || []) {
    if (UNHOLDABLE.includes(i.status)) continue;
    const e = branches.get(i.branch.name) || { name: i.branch.name, available: 0, total: 0 };
    e.total += 1;
    if (i.status === "available") e.available += 1;
    branches.set(i.branch.name, e);
  }
  return { a, holdable, branches: [...branches.values()].sort((x, y) => y.available - x.available || x.name.localeCompare(y.name)) };
}

function actionCard() {
  const { a, holdable, branches } = availability();
  const { loan, hold } = myState();
  const where = branches.filter((x) => x.available).map((x) => x.name);
  let tone, head, sub;
  if (a.available > 0) {
    tone = "success"; head = t("opac.rec.available_now");
    sub = t("opac.rec.available_where", { count: a.available, total: a.total, where: where.slice(0, 2).join(", ") + (where.length > 2 ? "…" : "") });
  } else if (holdable.length) {
    tone = "warning"; head = t("opac.rec.all_out");
    sub = b.holds_queued ? t("opac.record.queue", { count: b.holds_queued }) : t("opac.rec.be_first");
  } else {
    tone = "neutral"; head = t("opac.rec.no_copies"); sub = t("opac.rec.no_copies_hint");
  }
  let mineBox = "";
  if (loan) {
    mineBox = html`<div class="ra-mine">${icon("book")}<div>${loan.overdue ? t("opac.rec.mine_overdue") : t("opac.rec.mine_loan", { date: date(loan.due_at) })}
      <a href="/account#loans">${t("opac.rec.mine_manage")}</a></div></div>`;
  } else if (hold) {
    const ready = hold.status === "ready";
    mineBox = html`<div class="ra-mine">${icon(ready ? "check-circle" : "bookmark")}<div>${ready
      ? t("opac.rec.mine_ready", { branch: hold.pickup_branch.name, date: date(hold.expires_at) })
      : hold.suspended ? t("opac.rec.mine_paused") : t("opac.rec.mine_hold", { n: hold.queue_position || 1 })}</div></div>`;
  }
  let primary;
  if (hold) {
    primary = html`<a class="btn lg ra-primary" href="/account#holds">${icon("bookmark")}${t("opac.rec.mine_view")}</a>`;
  } else if (!holdable.length) {
    primary = html`<button class="btn primary lg ra-primary" type="button" disabled aria-describedby="ra-sub">${icon("bookmark")}${t("opac.record.place_hold")}</button>`;
  } else {
    primary = html`<button class="btn primary lg ra-primary" type="button" id="place-hold">${icon("bookmark-plus")}${t("opac.record.place_hold")}</button>`;
  }
  return html`
    <div class="ra-status"><span class="ra-dot ${tone}" aria-hidden="true"></span><div><strong>${head}</strong><span id="ra-sub">${sub}</span></div></div>
    ${mineBox}
    ${primary}
    ${!BOOT.user && holdable.length ? html`<p class="tiny muted" style="margin:-.4rem 0 0;text-align:center">${t("opac.rec.signin_hint")}</p>` : ""}
    <div class="ra-secondary">
      <button class="btn" type="button" id="add-list">${icon("list")}<span>${t("opac.rec.save")}</span></button>
      <button class="btn" type="button" id="cite" aria-haspopup="dialog">${icon("quote")}<span>${t("discovery.cite")}</span></button>
      <button class="btn" type="button" id="share">${icon("copy")}<span>${t("opac.rec.share")}</span></button>
    </div>
    ${branches.length ? html`<ul class="ra-branches" aria-label="${t("opac.rec.by_branch")}">${branches.map((x) => html`<li><span>${x.name}</span>${x.available
      ? statusPill("item", "available", t("opac.rec.n_available", { count: x.available }))
      : statusPill("item", "on_loan", t("opac.rec.none_available"))}</li>`)}</ul>` : ""}
    ${BOOT.user?.is_staff ? html`<a class="ra-staff" href="/staff/catalog/${b.id}">${icon("settings")} ${t("opac.record.staff_view")}</a>` : ""}`;
}

function hero() {
  const facts = [
    b.pub_year ? html`<li>${icon("calendar")}${b.pub_year}</li>` : "",
    b.pages ? html`<li>${icon("book")}${t("opac.rec.pages_n", { count: b.pages })}</li>` : "",
    b.language ? html`<li>${icon("globe")}${langName(b.language)}</li>` : "",
    b.rating?.count ? html`<li class="rec-rating">${stars(b.rating.average)}<span>${num(b.rating.average)} · <a href="#reviews" data-goto-tab="reviews">${t("opac.record.ratings", { count: b.rating.count })}</a></span></li>` : "",
  ];
  const by = (b.authors || []).map((au, i) => html`${i ? ", " : ""}<a href="/search?${qs({ author: au })}">${authors([au])}</a>`);
  const src = coverSrc(b, true);
  return html`
    <div class="rec-backdrop" aria-hidden="true">${src ? html`<img src="${src}" alt="" decoding="async">` : ""}</div>
    <div class="inner">
      <nav class="crumbs-opac" aria-label="${t("opac.record.breadcrumb")}">${backLink()}</nav>
      <div class="rec-grid">
        <div class="rec-cover" aria-hidden="true">${cover(b, "lg")}</div>
        <div class="rec-main">
          <div class="rec-tags"><span class="badge outline">${icon(FORMAT_ICON[b.material_type] || "book")}${formatName(b.material_type)}</span>
            ${b.audience ? html`<span class="badge neutral">${audienceName(b.audience)}</span>` : ""}
            ${b.ai_enriched ? html`<span class="badge ai">${icon("sparkle")}${t("opac.record.ai_enriched")}</span>` : ""}</div>
          <h1 class="rec-title">${b.title}</h1>
          ${b.subtitle ? html`<p class="rec-subtitle">${b.subtitle}</p>` : ""}
          ${by.length ? html`<p class="rec-by">${t("opac.record.by")} ${by}</p>` : ""}
          <ul class="rec-facts">${facts}</ul>
        </div>
        <div class="rec-about">
          ${b.description ? html`<p class="rec-desc clamped" id="rec-desc">${b.description}</p>
            <button type="button" class="link-btn rec-more" id="rec-more" aria-controls="rec-desc" aria-expanded="false" hidden>${t("opac.rec.read_more")}</button>` : ""}
          ${(b.subjects || []).length ? html`<div class="rec-subjects">${b.subjects.slice(0, 8).map((s) => html`<a class="chip" href="/search?${qs({ subject: s })}">${s.split(" -- ").join(" › ")}</a>`)}</div>` : ""}
        </div>
        <aside class="rec-action" id="rec-action" aria-label="${t("opac.rec.availability")}">${actionCard()}</aside>
      </div>
    </div>`;
}

function backLink() {
  let href = "/search", label = t("opac.rec.back_search");
  try {
    const ref = new URL(document.referrer);
    if (ref.origin === location.origin && ref.pathname === "/search") { href = ref.pathname + ref.search; label = t("opac.rec.back_results"); }
  } catch { /* no referrer */ }
  return html`<a href="${href}" id="back-link">${icon("chevron-left", "icon-back")}${label}</a>`;
}

// ------------------------------------------------------------------ tab panels

function detailsPanel() {
  const rows = [
    [t("opac.record.author"), authors(b.authors)], [t("opac.record.published"), [b.publisher, b.pub_year].filter(Boolean).join(", ")],
    [t("opac.record.edition"), b.edition], [t("opac.record.pages"), b.pages ? num(b.pages) : null],
    [t("opac.record.language"), langName(b.language)], [t("opac.rec.format"), formatName(b.material_type)],
    [t("opac.record.audience"), audienceName(b.audience)], ["ISBN", b.isbn], ["ISSN", b.issn],
    [t("opac.record.classification"), b.classification],
  ].filter(([, v]) => v);
  return html`<div class="facts-grid">
    <section class="card pad" aria-labelledby="facts-h"><h2 class="h3" id="facts-h" style="font-size:1.05rem">${t("opac.rec.about_edition")}</h2>
      <dl class="dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd class="${k === "ISBN" || k === "ISSN" ? "mono" : ""}">${v}</dd>`)}</dl></section>
    <div class="stack">
      ${b.series ? html`<section class="card pad" aria-labelledby="series-h"><h2 id="series-h" style="font-size:1.05rem">${t("opac.record.series")}</h2>
        <p style="margin:0"><a href="/browse?${qs({ index: "titles", start: b.series })}">${b.series}</a></p>
        <p class="small muted" style="margin:.35rem 0 0">${t("opac.rec.series_hint")}</p></section>` : ""}
      ${(b.subjects || []).length ? html`<section class="card pad" aria-labelledby="subj-h"><h2 id="subj-h" style="font-size:1.05rem">${t("opac.rec.subjects")}</h2>
        <ul style="margin:0;padding-inline-start:1.1rem;display:grid;gap:.3rem">${b.subjects.map((s) => html`<li><a href="/search?${qs({ subject: s })}">${s.split(" -- ").join(" › ")}</a></li>`)}</ul></section>` : ""}
      ${b.authors?.length ? html`<section class="card pad" aria-labelledby="auth-h"><h2 id="auth-h" style="font-size:1.05rem">${t("opac.rec.explore")}</h2>
        <ul style="margin:0;padding-inline-start:1.1rem;display:grid;gap:.3rem">${b.authors.map((au) => html`<li><a href="/browse?${qs({ index: "authors", start: au })}">${t("opac.rec.author_index", { name: authors([au]) })}</a></li>`)}</ul></section>` : ""}
    </div></div>`;
}

function copiesPanel() {
  const items = b.items || [];
  if (!items.length) return emptyState({ art: "books", title: t("opac.record.no_copies"), body: t("opac.rec.no_copies_hint") });
  const { branches } = availability();
  return html`${branches.length ? html`<div class="copy-branches">${branches.map((x) => {
    const shelfAt = items.find((i) => i.branch.name === x.name && i.status === "available") || items.find((i) => i.branch.name === x.name);
    return html`<div class="copy-branch"><h3>${x.name}</h3>
      <div class="cb-count">${x.available ? statusPill("item", "available", t("opac.rec.n_available", { count: x.available })) : statusPill("item", "on_loan", t("opac.rec.none_available"))}
        <span class="small muted"> · ${t("opac.rec.n_copies", { count: x.total })}</span></div>
      ${shelfAt?.call_number ? html`<div class="cb-where">${t("opac.rec.find_at")} <span class="mono">${shelfAt.call_number}</span>${shelfAt.shelf_location ? ` · ${shelfAt.shelf_location}` : ""}</div>` : ""}</div>`;
  })}</div>` : ""}
    <div class="card flush"><div class="table-wrap"><table class="table copies-table"><caption class="sr-only">${t("opac.record.copies")}</caption>
      <thead><tr><th scope="col">${t("opac.record.location")}</th><th scope="col">${t("opac.record.call_number")}</th><th scope="col">${t("opac.record.type")}</th><th scope="col">${t("opac.record.status")}</th></tr></thead>
      <tbody>${items.map((i) => html`<tr><td data-label="${t("opac.record.location")}"><strong>${i.branch.name}</strong>${i.shelf_location ? html`<div class="tiny muted">${i.shelf_location}</div>` : ""}</td>
        <td class="mono small" data-label="${t("opac.record.call_number")}">${i.call_number || "—"}</td><td data-label="${t("opac.record.type")}">${i.item_type.name}</td>
        <td class="ct-status">${statusPill("item", i.status)}</td></tr>`)}</tbody></table></div></div>
    <div id="issues-slot"></div>`;
}

function reviewsPanel() {
  const r = b.rating || { count: 0 };
  const dist = [5, 4, 3, 2, 1].map((n) => ({ n, c: (b.reviews || []).filter((x) => x.rating === n).length }));
  const most = Math.max(1, ...dist.map((d) => d.c));
  const write = BOOT.user ? html`<button class="btn primary" type="button" id="write-review">${icon("edit")}${t("opac.record.write_review")}</button>`
    : html`<a class="btn" href="${loginFor(`/record/${b.id}#reviews`)}">${t("opac.record.sign_in_review")}</a>`;
  const list = (b.reviews || []).filter((x) => x.body);
  return html`${r.count ? html`<div class="rating-summary"><div><div class="big">${num(r.average)}</div>${stars(r.average)}
      <div class="small muted">${t("opac.record.ratings", { count: r.count })}</div></div>
    <div class="rating-bars" role="list" aria-label="${t("opac.rec.rating_breakdown")}">${dist.map((d) => html`<div class="rb" role="listitem"><span>${t("opac.record.n_stars", { count: d.n })}</span>
      <span class="track" aria-hidden="true"><span class="fill" style="display:block;width:${(100 * d.c) / most}%"></span></span><span class="num">${num(d.c)}</span></div>`)}</div>
    <div style="margin-inline-start:auto">${write}</div></div>`
    : emptyState({ art: "inbox", title: t("opac.record.no_reviews"), body: t("opac.rec.be_first_review"), actions: write })}
    ${list.length ? html`<h2 class="sr-only">${t("opac.record.reviews")}</h2><div class="review-list">${list.map((x) => html`<article class="review"><header>${stars(x.rating)}<strong>${x.by}</strong>
      <span class="tiny muted">${relative(x.created_at)}</span></header><p>${x.body}</p></article>`)}</div>` : ""}`;
}

function similarPanel() {
  if (related === null) return html`<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(min(100%,9rem),1fr));gap:1.25rem 1rem">${Array.from({ length: 6 }, skeletonCard)}</div>`;
  if (!related.length) return emptyState({ art: "books", title: t("opac.rec.no_similar"), body: t("opac.rec.no_similar_body"),
    actions: (b.subjects || []).length ? html`<a class="btn" href="/search?${qs({ subject: b.subjects[0] })}">${t("opac.rec.more_subject", { subject: b.subjects[0].split(" -- ")[0] })}</a>` : "" });
  return html`<p class="tip">${icon("sparkle")}<span>${t("opac.rec.similar_hint")}</span></p>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(min(100%,9rem),1fr));gap:1.25rem 1rem">${related.map(bookCard)}</div>`;
}

const PANELS = { details: detailsPanel, copies: copiesPanel, reviews: reviewsPanel, similar: similarPanel };
let tabsApi = null, currentTab = "details";

function renderBody() {
  const items = [
    { id: "details", label: t("opac.record.details") },
    { id: "copies", label: t("opac.record.copies"), count: (b.items || []).length },
    { id: "reviews", label: t("opac.record.reviews"), count: b.rating?.count || 0 },
    { id: "similar", label: t("opac.rec.similar") },
  ];
  const initial = items.some((i) => `#${i.id}` === location.hash) ? location.hash.slice(1) : "details";
  $("#rec-body").innerHTML = html`<div id="rec-tabs">${tabs({ id: "rec", label: t("opac.rec.sections"), items, selected: initial })}</div>
    <div class="rec-shelves" id="rec-shelves"></div>`;
  tabsApi = wireTabsPanel($("#rec-tabs"), (id, panel) => {
    currentTab = id;
    panel.innerHTML = PANELS[id]();
    if (id === "copies" && b.material_type === "serial") latestIssues();
  }, { hash: true });
}

const refreshPanel = (id) => { if (currentTab === id) tabsApi?.select(id); };

// ------------------------------------------------------------------ actions

async function placeHold(btn) {
  if (!BOOT.user) { location.href = loginFor(`/record/${b.id}?hold=1`); return; }
  const { branches } = await api("/lookups");
  const holdable = (b.items || []).filter((i) => !UNHOLDABLE.includes(i.status));
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const fd = await modal({ title: t("opac.record.hold_title"), submit: t("opac.record.place_hold"), body: html`<div class="stack">
    <p style="margin:0">${t("opac.record.hold_intro", { title: b.title })}</p>
    <div class="field"><label for="pickup">${t("opac.record.pickup")}</label><select id="pickup" name="pickup" required>
      ${branches.map((br) => html`<option value="${br.id}" ${br.id === BOOT.user.home_branch_id ? "selected" : ""}>${br.name}</option>`)}</select></div>
    ${holdable.length > 1 ? html`<div class="field"><label for="hold-copy">${t("opac.rec.hold_copy")}</label><select id="hold-copy" name="item_id" aria-describedby="hold-copy-hint">
      <option value="">${t("opac.rec.hold_any")}</option>
      ${holdable.map((i) => html`<option value="${i.id}">${[i.branch.name, i.call_number || i.barcode, i.item_type?.name, statusText(i.status)].filter(Boolean).join(" · ")}</option>`)}</select>
      <span class="hint" id="hold-copy-hint">${t("opac.rec.hold_copy_hint")}</span></div>` : ""}
    <div class="field"><label for="hold-nna">${t("opac.rec.hold_nna")}</label><input id="hold-nna" name="not_needed_after" type="date" min="${iso}" aria-describedby="hold-nna-hint">
      <span class="hint" id="hold-nna-hint">${t("opac.rec.hold_nna_hint")}</span></div>
    <div class="field"><label for="notes">${t("opac.record.hold_note")}</label><input id="notes" name="notes" maxlength="255"></div></div>` });
  if (!fd) return;
  const h = await withBusy(btn, () => api("/opac/me/holds", { method: "POST", body: { biblio_id: b.id, pickup_branch_id: +fd.get("pickup"), notes: fd.get("notes") || null,
    item_id: fd.get("item_id") ? Number(fd.get("item_id")) : null, not_needed_after: fd.get("not_needed_after") || null } })).catch(() => null);
  if (!h) return;
  mine = mine || { loans: [], holds: [] };
  mine.holds.push({ ...h, biblio: { id: b.id, title: b.title } });
  b.holds_queued = (b.holds_queued || 0) + 1;
  renderAction();
  $("#rec-action .ra-primary")?.focus();
  toast(t("opac.record.hold_placed", { n: h.queue_position }), "success", { action: { label: t("opac.rec.view_holds"), run: () => { location.href = "/account#holds"; } } });
}

async function addToList() {
  if (!BOOT.user) { location.href = loginFor(`/record/${b.id}`); return; }
  const { results } = await api("/opac/me/lists");
  const fd = await modal({ title: t("opac.record.add_to_list"), submit: t("opac.record.add"), body: html`<div class="stack">
    ${results.length ? html`<div class="field"><label for="list">${t("opac.record.list")}</label><select id="list" name="list">${results.map((l) => html`<option value="${l.id}">${l.name} (${num(l.count)})</option>`)}<option value="new">${t("opac.record.new_list_option")}</option></select></div>` : html`<input type="hidden" name="list" value="new">`}
    <div class="field"><label for="newname">${t("opac.record.new_list_name")}</label><input id="newname" name="newname" placeholder="${t("opac.record.new_list_placeholder")}" maxlength="120"></div>
    <label class="checkbox"><input type="checkbox" name="public"> ${t("opac.record.new_list_public")}</label></div>` });
  if (!fd) return;
  try {
    let listId = fd.get("list");
    if (listId === "new") {
      const name = fd.get("newname") || t("opac.record.default_list_name");
      listId = (await api("/opac/me/lists", { method: "POST", body: { name, is_public: fd.get("public") === "on" } })).id;
    }
    await api(`/opac/me/lists/${listId}/items/${b.id}`, { method: "POST" });
    toast(t("opac.record.added_to_list"), "success", { action: { label: t("opac.rec.view_lists"), run: () => { location.href = "/account#lists"; } } });
  } catch (err) { toast(err.message, "error"); }
}

async function share() {
  const url = `${location.origin}/record/${b.id}`;
  if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ title: b.title, url }); return; } catch { /* cancelled */ return; }
  }
  try { await navigator.clipboard.writeText(url); toast(t("opac.record.link_copied"), "success"); } catch { toast(url); }
}

async function writeReview() {
  let rating = 5;
  const p = modal({ title: t("opac.record.write_review"), submit: t("opac.record.submit"), body: html`<div class="stack">
    <div class="field"><span class="label-like" id="rv-rating">${t("opac.record.rating")}</span>
    <div class="rating-input" role="radiogroup" aria-labelledby="rv-rating">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" data-r="${n}" class="on" role="radio" aria-checked="${n === 5}" tabindex="${n === 5 ? 0 : -1}" aria-label="${t("opac.record.n_stars", { count: n })}">★</button>`)}</div></div>
    <div class="field"><label for="rv">${t("opac.record.review_body")}</label><textarea id="rv" name="body" maxlength="4000"></textarea></div></div>` });
  const dlg = $$("dialog").at(-1);
  const set = (n, focus = false) => {
    rating = n;
    $$("[data-r]", dlg).forEach((x) => { const on = +x.dataset.r === n; x.classList.toggle("on", +x.dataset.r <= n); x.setAttribute("aria-checked", String(on)); x.tabIndex = on ? 0 : -1; if (on && focus) x.focus(); });
  };
  dlg.addEventListener("click", (ev) => { const s = ev.target.closest("[data-r]"); if (s) set(+s.dataset.r); });
  $(".rating-input", dlg).addEventListener("keydown", (ev) => {
    const rtl = document.documentElement.dir === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowUp: 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: -1 }[ev.key];
    if (!step) return;
    ev.preventDefault();
    set(Math.min(5, Math.max(1, rating + step)), true);
  });
  const fd = await p;
  if (!fd) return;
  try {
    const r = await api(`/opac/biblios/${b.id}/review`, { method: "POST", body: { rating, body: fd.get("body") || null } });
    toast(r.approved ? t("opac.record.review_thanks") : t("opac.record.review_moderation"), "success");
    if (r.approved) {
      b = await api(`/biblios/${b.id}`);
      refreshPanel("reviews");
    }
  } catch (err) { toast(err.message, "error"); }
}

function renderAction() {
  $("#rec-action").innerHTML = actionCard();
}

// ------------------------------------------------------------------ async extras

async function latestIssues() {
  let r;
  try { r = await api(`/serials/public/biblios/${b.id}/issues`); } catch { return; }
  const slot = $("#issues-slot");
  if (!slot || (!r.results.length && !r.next_expected_on)) return;
  slot.innerHTML = html`<section class="card" style="margin-top:1.25rem" aria-labelledby="latest-issues-h">
    <div class="card-head"><h2 id="latest-issues-h" style="font-size:1.05rem">${t("opac.rec.latest_issues")}</h2>
      <span class="muted small">${[r.frequency, r.next_expected_on ? t("opac.rec.next_expected", { date: date(r.next_expected_on) }) : ""].filter(Boolean).join(" · ")}</span></div>
    <div class="card-body" style="padding-top:.5rem">${r.results.length ? html`<div class="table-wrap"><table class="table">
      <caption class="sr-only">${t("opac.rec.latest_issues")}</caption>
      <thead><tr><th scope="col">${t("opac.rec.issue")}</th><th scope="col">${t("opac.rec.received")}</th><th scope="col">${t("opac.record.location")}</th><th scope="col">${t("opac.record.status")}</th></tr></thead>
      <tbody>${r.results.map((i) => html`<tr><td><strong>${i.enumeration}</strong><div class="tiny muted">${i.chronology || ""}</div></td>
        <td class="nowrap">${date(i.received_on)}</td><td>${i.branch}</td><td>${i.status ? statusPill("item", i.status) : html`<span class="muted small">${t("opac.rec.in_library")}</span>`}</td></tr>`)}</tbody>
      </table></div>` : html`<p class="muted small" style="margin:0">${t("opac.rec.no_issues")}</p>`}</div></section>`;
}

async function shelves() {
  const box = $("#rec-shelves");
  const first = (b.authors || [])[0];
  const [rel, more] = await Promise.all([
    api(`/biblios/${b.id}/related`).then((r) => r.results).catch(() => []),
    first ? api(`/search?${qs({ author: first, per_page: 13 })}`).then((r) => r.results.filter((x) => x.id !== b.id)).catch(() => []) : Promise.resolve([]),
  ]);
  related = rel;
  refreshPanel("similar");
  if (more.length) {
    box.insertAdjacentHTML("beforeend", shelf({ title: t("opac.rec.more_by", { name: authors([first]) }), href: `/search?${qs({ author: first })}`, items: more }));
    wireShelves(box);
  }
  await shelfBrowser(b, box);
}

async function missing() {
  const box = $("#missing-new");
  if (!box) return;
  try {
    const r = await api("/search?sort=newest&per_page=12");
    if (r.results.length) { box.innerHTML = shelf({ title: t("opac.rec.recently_added"), href: "/search?sort=newest", items: r.results }); wireShelves(box); }
  } catch { /* optional */ }
}

export default async function init() {
  if (!$("#record")) { missing(); return; }
  const id = BOOT.biblio_id;
  try {
    [b, mine] = await Promise.all([api(`/biblios/${id}`), BOOT.user ? api("/opac/me/summary").catch(() => null) : null]);
  } catch (e) {
    $(".rec-hero").innerHTML = html`<div class="inner">${errorState(e)}</div>`;
    $("#record").removeAttribute("aria-busy");
    $(".rec-hero").addEventListener("click", (ev) => { if (ev.target.closest("[data-retry]")) location.reload(); });
    return;
  }
  const heroEl = $(".rec-hero");
  heroEl.innerHTML = hero();
  // Generated-cover colours tint the backdrop when there is no cover image (or it fails to load).
  const gen = $(".rec-cover .cover", heroEl);
  if (gen) $(".rec-backdrop", heroEl).style.background = gen.style.background;
  $(".rec-backdrop img", heroEl)?.addEventListener("error", (e) => e.target.remove());
  renderBody();
  $("#record").removeAttribute("aria-busy");

  const desc = $("#rec-desc");
  if (desc && desc.scrollHeight > desc.clientHeight + 4) {
    const more = $("#rec-more");
    more.hidden = false;
    more.addEventListener("click", () => {
      const open = desc.classList.toggle("clamped") === false;
      more.setAttribute("aria-expanded", String(open));
      more.textContent = open ? t("opac.rec.read_less") : t("opac.rec.read_more");
    });
  }

  heroEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button, a[data-goto-tab]");
    if (!btn) return;
    if (btn.dataset.gotoTab) { e.preventDefault(); tabsApi.select(btn.dataset.gotoTab); $("#rec-tabs [role=tab][aria-selected=true]")?.focus(); return; }
    try {
      if (btn.id === "place-hold") await placeHold(btn);
      else if (btn.id === "add-list") await addToList();
      else if (btn.id === "cite") openCitations(b, btn);
      else if (btn.id === "share") await share();
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
  $("#rec-body").addEventListener("click", (e) => { if (e.target.closest("#write-review")) writeReview(); });

  const params = new URLSearchParams(location.search);
  if (params.has("hold")) {
    history.replaceState(null, "", location.pathname + location.hash);
    const btn = $("#place-hold");
    if (btn && BOOT.user) placeHold(btn).catch((err) => { if (!err.toasted) toast(err.message, "error"); });
  }
  shelves();
}
