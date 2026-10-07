import { $, BOOT, api, authors, availabilityBadge, badge, cover, empty, html, icon, modal, raw, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { bookCard } from "/static/js/pages/opac-home.js";
import { enhanceRecord } from "/static/js/record-extras.js";

const LANGS = ["en", "hi", "bn", "fr", "es", "de", "ta", "ur"];
const langName = (v) => (LANGS.includes(v) ? t(`lang.${v}`) : v);
const stars = (n) => raw(`<span class="stars" role="img" aria-label="${t("opac.record.stars", { n })}">${"★".repeat(Math.round(n))}${"☆".repeat(5 - Math.round(n))}</span>`);

function details(b) {
  const rows = [
    [t("opac.record.author"), authors(b.authors)], [t("opac.record.published"), [b.publisher, b.pub_year].filter(Boolean).join(", ")],
    [t("opac.record.edition"), b.edition], [t("opac.record.series"), b.series], [t("opac.record.pages"), b.pages], [t("opac.record.language"), langName(b.language)],
    ["ISBN", b.isbn], [t("opac.record.classification"), b.classification],
    [t("opac.record.audience"), b.audience ? t(`opac.record.audience_${b.audience}`, {}, b.audience.replace("_", " ")) : null],
  ].filter(([, v]) => v);
  return html`<dl class="dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

function itemsTable(items) {
  if (!items.length) return empty(t("opac.record.no_copies"));
  return html`<div class="table-wrap"><table class="table"><caption class="sr-only">${t("opac.record.copies")}</caption><thead><tr><th scope="col">${t("opac.record.location")}</th><th scope="col">${t("opac.record.call_number")}</th><th scope="col">${t("opac.record.type")}</th><th scope="col">${t("opac.record.status")}</th></tr></thead>
    <tbody>${items.map((i) => html`<tr><td>${i.branch.name}${i.shelf_location ? html`<div class="tiny muted">${i.shelf_location}</div>` : ""}</td>
      <td class="mono small">${i.call_number || "—"}</td><td>${i.item_type.name}</td><td>${badge(i.status)}</td></tr>`)}</tbody></table></div>`;
}

function reviews(b) {
  return html`<div class="stack">
    ${b.rating.count ? html`<div class="row"><span style="font-size:1.6rem;font-weight:700">${b.rating.average}</span>${stars(b.rating.average)}<span class="muted small">${t("opac.record.ratings", { count: b.rating.count })}</span></div>` : html`<p class="muted">${t("opac.record.no_reviews")}</p>`}
    ${b.reviews.filter((r) => r.body).map((r) => html`<div class="kv" style="flex-direction:column;gap:.2rem"><div class="row tight">${stars(r.rating)}<strong class="small">${r.by}</strong><span class="tiny muted">${relative(r.created_at)}</span></div><div>${r.body}</div></div>`)}
    ${BOOT.user ? html`<button class="btn" id="write-review">${icon("edit")}${t("opac.record.write_review")}</button>` : html`<a href="/login?next=/record/${b.id}" class="small">${t("opac.record.sign_in_review")}</a>`}
  </div>`;
}

export default async function init() {
  const id = BOOT.biblio_id;
  if (document.referrer.includes("/search")) $("#back-link").href = document.referrer;
  let b;
  try {
    b = await api(`/biblios/${id}`);
  } catch (e) {
    $("#record").innerHTML = empty(e.status === 404 ? t("opac.record.not_found") : e.message, "alert");
    $("#record").removeAttribute("aria-busy");
    return;
  }
  document.title = `${b.title} · ${document.title}`;
  const a = b.availability;
  $("#record").innerHTML = html`<div class="record-layout">
    <div class="stack">${cover(b, "lg")}
      <div class="card pad stack tight">
        ${availabilityBadge(a)}
        ${b.holds_queued ? html`<span class="small muted">${t("opac.record.queue", { count: b.holds_queued })}</span>` : ""}
        <button class="btn primary" id="place-hold">${icon("bookmark")}${a.available ? t("opac.record.reserve") : t("opac.record.place_hold")}</button>
        ${BOOT.user ? html`<button class="btn" id="add-list">${icon("list")}${t("opac.record.add_to_list")}</button>` : ""}
        <button class="btn ghost sm" id="share">${icon("copy")}${t("opac.record.copy_link")}</button>
        ${BOOT.user?.is_staff ? html`<a class="btn ghost sm" href="/staff/catalog/${b.id}">${icon("settings")}${t("opac.record.staff_view")}</a>` : ""}
      </div>
    </div>
    <div class="stack">
      <div>
        <div class="row tight" style="margin-bottom:.4rem">${badge("info", t(`format.${b.material_type}`, {}, b.material_type))}${b.ai_enriched ? html`<span class="badge ai">${icon("sparkle")}${t("opac.record.ai_enriched")}</span>` : ""}</div>
        <h1 class="record-title">${b.title}</h1>
        ${b.subtitle ? html`<p class="muted" style="font-size:1.1rem">${b.subtitle}</p>` : ""}
        <p>${t("opac.record.by")} ${(b.authors || []).map((au, i) => html`${i ? ", " : ""}<a href="/search?author=${encodeURIComponent(au)}">${authors([au])}</a>`)}</p>
      </div>
      ${b.description ? html`<p style="font-size:1.05rem;line-height:1.65">${b.description}</p>` : ""}
      <div class="row tight">${(b.subjects || []).map((s) => html`<a class="chip" href="/search?subject=${encodeURIComponent(s)}">${s}</a>`)}</div>
      <div class="card pad"><h2 class="sr-only">${t("opac.record.details")}</h2>${details(b)}</div>
      <div class="card"><div class="card-head"><h2 class="h3">${t("opac.record.copies")}</h2><span class="muted small">${t("opac.record.available_of", { available: a.available, total: a.total })}</span></div><div class="card-body" style="padding-top:.5rem">${itemsTable(b.items)}</div></div>
      <div class="card"><div class="card-head"><h2 class="h3">${t("opac.record.reviews")}</h2></div><div class="card-body" id="reviews">${reviews(b)}</div></div>
    </div></div>`;
  $("#record").removeAttribute("aria-busy");
  enhanceRecord(b);

  $("#share").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast(t("opac.record.link_copied"), "success"); } catch { toast(location.href); }
  });
  $("#place-hold").addEventListener("click", async (e) => {
    if (!BOOT.user) { location.href = `/login?next=/record/${id}`; return; }
    const { branches } = await api("/lookups");
    const fd = await modal({ title: t("opac.record.hold_title"), submit: t("opac.record.place_hold"), body: html`<div class="stack">
      <p>${t("opac.record.hold_intro", { title: b.title })}</p>
      <div class="field"><label for="pickup">${t("opac.record.pickup")}</label><select id="pickup" name="pickup" required>
        ${branches.map((br) => html`<option value="${br.id}" ${br.id === BOOT.user.home_branch_id ? "selected" : ""}>${br.name}</option>`)}</select></div>
      <div class="field"><label for="notes">${t("opac.record.hold_note")}</label><input id="notes" name="notes" maxlength="255"></div></div>` });
    if (!fd) return;
    await withBusy(e.target.closest("button"), async () => {
      const h = await api("/opac/me/holds", { method: "POST", body: { biblio_id: id, pickup_branch_id: +fd.get("pickup"), notes: fd.get("notes") || null } });
      toast(t("opac.record.hold_placed", { n: h.queue_position }), "success");
    });
  });
  $("#add-list")?.addEventListener("click", async () => {
    const { results } = await api("/opac/me/lists");
    const fd = await modal({ title: t("opac.record.add_to_list"), submit: t("opac.record.add"), body: html`<div class="stack">
      ${results.length ? html`<div class="field"><label for="list">${t("opac.record.list")}</label><select id="list" name="list">${results.map((l) => html`<option value="${l.id}">${l.name} (${l.count})</option>`)}<option value="new">${t("opac.record.new_list_option")}</option></select></div>` : html`<input type="hidden" name="list" value="new">`}
      <div class="field"><label for="newname">${t("opac.record.new_list_name")}</label><input id="newname" name="newname" placeholder="${t("opac.record.new_list_placeholder")}" maxlength="120"></div>
      <label class="checkbox"><input type="checkbox" name="public"> ${t("opac.record.new_list_public")}</label></div>` });
    if (!fd) return;
    try {
      let listId = fd.get("list");
      if (listId === "new") {
        const name = fd.get("newname") || t("opac.record.default_list_name");
        listId = (await api("/opac/me/lists", { method: "POST", body: { name, is_public: fd.get("public") === "on" } })).id;
      }
      await api(`/opac/me/lists/${listId}/items/${id}`, { method: "POST" });
      toast(t("opac.record.added_to_list"), "success");
    } catch (err) { toast(err.message, "error"); }
  });
  $("#reviews").addEventListener("click", async (e) => {
    if (!e.target.closest("#write-review")) return;
    let rating = 5;
    const p = modal({ title: t("opac.record.write_review"), submit: t("opac.record.submit"), body: html`<div class="stack">
      <div class="rating-input" role="radiogroup" aria-label="${t("opac.record.rating")}">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" data-r="${n}" class="on" role="radio" aria-checked="${n === 5}" aria-label="${t("opac.record.n_stars", { count: n })}">★</button>`)}</div>
      <div class="field"><label for="rv">${t("opac.record.review_body")}</label><textarea id="rv" name="body" maxlength="4000"></textarea></div></div>` });
    const dlg = document.querySelector("dialog:last-of-type");
    dlg.addEventListener("click", (ev) => {
      const s = ev.target.closest("[data-r]");
      if (!s) return;
      rating = +s.dataset.r;
      dlg.querySelectorAll("[data-r]").forEach((x) => { x.classList.toggle("on", +x.dataset.r <= rating); x.setAttribute("aria-checked", String(+x.dataset.r === rating)); });
    });
    const fd = await p;
    if (!fd) return;
    try {
      const r = await api(`/opac/biblios/${id}/review`, { method: "POST", body: { rating, body: fd.get("body") || null } });
      toast(r.approved ? t("opac.record.review_thanks") : t("opac.record.review_moderation"), "success");
      setTimeout(() => location.reload(), 800);
    } catch (err) { toast(err.message, "error"); }
  });

  try {
    const rel = await api(`/biblios/${id}/related`);
    if (rel.results.length) {
      $("#related").innerHTML = html`${rel.results.map(bookCard)}`;
      $("#related-section").hidden = false;
    }
  } catch { /* recommendations are optional */ }
}
