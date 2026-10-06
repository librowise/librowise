import { $, BOOT, api, authors, availabilityBadge, badge, cover, date, empty, html, icon, modal, raw, relative, toast, withBusy } from "/static/js/core.js";
import { bookCard } from "/static/js/pages/opac-home.js";

const LANG = { en: "English", hi: "Hindi", bn: "Bengali", fr: "French", es: "Spanish", de: "German" };
const stars = (n) => raw(`<span class="stars" aria-label="${n} out of 5">${"★".repeat(Math.round(n))}${"☆".repeat(5 - Math.round(n))}</span>`);

function details(b) {
  const rows = [
    ["Author", authors(b.authors)], ["Published", [b.publisher, b.pub_year].filter(Boolean).join(", ")],
    ["Edition", b.edition], ["Series", b.series], ["Pages", b.pages], ["Language", LANG[b.language] || b.language],
    ["ISBN", b.isbn], ["Classification", b.classification],
    ["Audience", b.audience ? b.audience.replace("_", " ") : null],
  ].filter(([, v]) => v);
  return html`<dl class="dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

function itemsTable(items) {
  if (!items.length) return empty("No physical copies.");
  return html`<div class="table-wrap"><table class="table"><thead><tr><th>Location</th><th>Call number</th><th>Type</th><th>Status</th></tr></thead>
    <tbody>${items.map((i) => html`<tr><td>${i.branch.name}${i.shelf_location ? html`<div class="tiny muted">${i.shelf_location}</div>` : ""}</td>
      <td class="mono small">${i.call_number || "—"}</td><td>${i.item_type.name}</td><td>${badge(i.status)}</td></tr>`)}</tbody></table></div>`;
}

function reviews(b) {
  return html`<div class="stack">
    ${b.rating.count ? html`<div class="row"><span style="font-size:1.6rem;font-weight:700">${b.rating.average}</span>${stars(b.rating.average)}<span class="muted small">${b.rating.count} rating${b.rating.count === 1 ? "" : "s"}</span></div>` : html`<p class="muted">No reviews yet.</p>`}
    ${b.reviews.filter((r) => r.body).map((r) => html`<div class="kv" style="flex-direction:column;gap:.2rem"><div class="row tight">${stars(r.rating)}<strong class="small">${r.by}</strong><span class="tiny muted">${relative(r.created_at)}</span></div><div>${r.body}</div></div>`)}
    ${BOOT.user ? html`<button class="btn" id="write-review">${icon("edit")}Rate & review</button>` : html`<a href="/login?next=/record/${b.id}" class="small">Sign in to write a review</a>`}
  </div>`;
}

export default async function init() {
  const id = BOOT.biblio_id;
  if (document.referrer.includes("/search")) $("#back-link").href = document.referrer;
  let b;
  try {
    b = await api(`/biblios/${id}`);
  } catch (e) {
    $("#record").innerHTML = empty(e.status === 404 ? "This record does not exist or was removed." : e.message, "alert");
    return;
  }
  document.title = `${b.title} · ${document.title}`;
  const a = b.availability;
  $("#record").innerHTML = html`<div class="record-layout">
    <div class="stack">${cover(b, "lg")}
      <div class="card pad stack tight">
        ${availabilityBadge(a)}
        ${b.holds_queued ? html`<span class="small muted">${b.holds_queued} waiting in the holds queue</span>` : ""}
        <button class="btn primary" id="place-hold">${icon("bookmark")}${a.available ? "Reserve a copy" : "Place hold"}</button>
        ${BOOT.user ? html`<button class="btn" id="add-list">${icon("list")}Add to reading list</button>` : ""}
        <button class="btn ghost sm" id="share">${icon("copy")}Copy link</button>
        ${BOOT.user?.is_staff ? html`<a class="btn ghost sm" href="/staff/catalog/${b.id}">${icon("settings")}Staff view</a>` : ""}
      </div>
    </div>
    <div class="stack">
      <div>
        <div class="row tight" style="margin-bottom:.4rem">${badge("info", b.material_type)}${b.ai_enriched ? html`<span class="badge ai">${icon("sparkle")}AI-enriched</span>` : ""}</div>
        <h1 class="record-title">${b.title}</h1>
        ${b.subtitle ? html`<p class="muted" style="font-size:1.1rem">${b.subtitle}</p>` : ""}
        <p>by ${(b.authors || []).map((au, i) => html`${i ? ", " : ""}<a href="/search?author=${encodeURIComponent(au)}">${authors([au])}</a>`)}</p>
      </div>
      ${b.description ? html`<p style="font-size:1.05rem;line-height:1.65">${b.description}</p>` : ""}
      <div class="row tight">${(b.subjects || []).map((s) => html`<a class="chip" href="/search?subject=${encodeURIComponent(s)}">${s}</a>`)}</div>
      <div class="card pad">${details(b)}</div>
      <div class="card"><div class="card-head"><h3>Copies</h3><span class="muted small">${a.available} of ${a.total} available</span></div><div class="card-body" style="padding-top:.5rem">${itemsTable(b.items)}</div></div>
      <div class="card"><div class="card-head"><h3>Reviews</h3></div><div class="card-body" id="reviews">${reviews(b)}</div></div>
    </div></div>`;

  if (b.material_type === "serial") latestIssues(b.id);
  $("#share").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied", "success"); } catch { toast(location.href); }
  });
  $("#place-hold").addEventListener("click", async (e) => {
    if (!BOOT.user) { location.href = `/login?next=/record/${id}`; return; }
    const { branches } = await api("/lookups");
    const fd = await modal({ title: "Place a hold", submit: "Place hold", body: html`<div class="stack">
      <p>We'll notify you when <strong>${b.title}</strong> is ready to collect.</p>
      <div class="field"><label for="pickup">Pickup location</label><select id="pickup" name="pickup" required>
        ${branches.map((br) => html`<option value="${br.id}" ${br.id === BOOT.user.home_branch_id ? "selected" : ""}>${br.name}</option>`)}</select></div>
      <div class="field"><label for="notes">Note to staff (optional)</label><input id="notes" name="notes" maxlength="255"></div></div>` });
    if (!fd) return;
    await withBusy(e.target.closest("button"), async () => {
      const h = await api("/opac/me/holds", { method: "POST", body: { biblio_id: id, pickup_branch_id: +fd.get("pickup"), notes: fd.get("notes") || null } });
      toast(`Hold placed — you are number ${h.queue_position} in the queue.`, "success");
    });
  });
  $("#add-list")?.addEventListener("click", async () => {
    const { results } = await api("/opac/me/lists");
    const fd = await modal({ title: "Add to reading list", submit: "Add", body: html`<div class="stack">
      ${results.length ? html`<div class="field"><label for="list">List</label><select id="list" name="list">${results.map((l) => html`<option value="${l.id}">${l.name} (${l.count})</option>`)}<option value="new">+ New list…</option></select></div>` : html`<input type="hidden" name="list" value="new">`}
      <div class="field"><label for="newname">New list name</label><input id="newname" name="newname" placeholder="e.g. Summer reading" maxlength="120"></div>
      <label class="checkbox"><input type="checkbox" name="public"> Make new list public</label></div>` });
    if (!fd) return;
    try {
      let listId = fd.get("list");
      if (listId === "new") {
        const name = fd.get("newname") || "My list";
        listId = (await api("/opac/me/lists", { method: "POST", body: { name, is_public: fd.get("public") === "on" } })).id;
      }
      await api(`/opac/me/lists/${listId}/items/${id}`, { method: "POST" });
      toast("Added to your reading list", "success");
    } catch (err) { toast(err.message, "error"); }
  });
  $("#reviews").addEventListener("click", async (e) => {
    if (!e.target.closest("#write-review")) return;
    let rating = 5;
    const p = modal({ title: "Rate & review", submit: "Submit", body: html`<div class="stack">
      <div class="rating-input" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" data-r="${n}" class="on" aria-label="${n} stars">★</button>`)}</div>
      <div class="field"><label for="rv">Your review (optional)</label><textarea id="rv" name="body" maxlength="4000"></textarea></div></div>` });
    const dlg = document.querySelector("dialog:last-of-type");
    dlg.addEventListener("click", (ev) => {
      const s = ev.target.closest("[data-r]");
      if (!s) return;
      rating = +s.dataset.r;
      dlg.querySelectorAll("[data-r]").forEach((x) => x.classList.toggle("on", +x.dataset.r <= rating));
    });
    const fd = await p;
    if (!fd) return;
    try {
      const r = await api(`/opac/biblios/${id}/review`, { method: "POST", body: { rating, body: fd.get("body") || null } });
      toast(r.approved ? "Thanks for your review!" : "Thanks! Your review will appear after moderation.", "success");
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

// ---- serials: "Latest issues" card for serial records (additive; fails silently) ----
async function latestIssues(biblioId) {
  let r;
  try { r = await api(`/serials/public/biblios/${biblioId}/issues`); } catch { return; }
  if (!r.results.length && !r.next_expected_on) return;
  const anchor = $("#reviews")?.closest(".card");
  if (!anchor) return;
  anchor.insertAdjacentHTML("beforebegin", html`<section class="card" aria-labelledby="latest-issues-h">
    <div class="card-head"><h3 id="latest-issues-h">Latest issues</h3>
      <span class="muted small">${r.frequency || ""}${r.next_expected_on ? ` · next expected ${date(r.next_expected_on)}` : ""}</span></div>
    <div class="card-body" style="padding-top:.5rem">${r.results.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Issue</th><th>Received</th><th>Location</th><th>Status</th></tr></thead>
      <tbody>${r.results.map((i) => html`<tr><td><strong>${i.enumeration}</strong><div class="tiny muted">${i.chronology || ""}</div></td>
        <td class="nowrap">${date(i.received_on)}</td><td>${i.branch}</td><td>${i.status ? badge(i.status) : html`<span class="muted small">In library</span>`}</td></tr>`)}</tbody>
      </table></div>` : html`<p class="muted small">No issues received yet.</p>`}</div></section>`);
}
