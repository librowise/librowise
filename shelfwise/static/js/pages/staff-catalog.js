import { $, api, authors, availabilityBadge, cover, empty, formData, html, num, qs, skeleton, toast } from "/static/js/core.js";

const FORMAT = { book: "Book", ebook: "E-book", audiobook: "Audiobook", dvd: "DVD", serial: "Magazine", comic: "Graphic novel" };

export default async function init() {
  const form = $("#cat-search");
  const params = new URLSearchParams(location.search);
  const lk = await api("/lookups");
  $("#cmt").insertAdjacentHTML("beforeend", html`${lk.material_types.map((m) => html`<option value="${m}">${FORMAT[m] || m}</option>`)}`);
  $("#cbr").insertAdjacentHTML("beforeend", html`${lk.branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}`);
  for (const [k, v] of params) { const el = form.elements[k]; if (el) el.type === "checkbox" ? (el.checked = v === "true") : (el.value = v); }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = formData(form);
    location.search = qs({ ...d, available_only: d.available_only ? "true" : undefined });
  });

  const page = +(params.get("page") || 1);
  const query = Object.fromEntries(params);
  if (!query.q && (!query.sort || query.sort === "relevance")) query.sort = "newest";
  $("#cat-results").innerHTML = `<div style="padding:1rem">${skeleton(8)}</div>`;
  try {
    const r = await api(`/search?${qs({ ...query, per_page: 25, page })}`);
    $("#cat-summary").textContent = `${num(r.total)} records · ${r.took_ms} ms`;
    $("#cat-results").innerHTML = r.results.length ? html`<table class="table"><thead><tr><th></th><th>Title</th><th>Year</th><th>Format</th><th>Class</th><th>Copies</th></tr></thead><tbody>
      ${r.results.map((b) => html`<tr class="clickable" data-href="/staff/catalog/${b.id}">
        <td style="width:56px">${cover(b, "sm")}</td>
        <td><a href="/staff/catalog/${b.id}"><strong>${b.title}</strong></a><div class="small muted">${authors(b.authors)}</div>
          ${b.isbn ? html`<div class="tiny muted mono">ISBN ${b.isbn}</div>` : ""}</td>
        <td>${b.pub_year || "—"}</td><td>${FORMAT[b.material_type] || b.material_type}</td>
        <td class="mono small">${b.classification || "—"}</td><td>${availabilityBadge(b.availability)}</td></tr>`)}</tbody></table>`
      : empty("No records match. Try different terms or create a new record.", "search");
    const pages = Math.ceil(r.total / 25);
    if (pages > 1) {
      $("#cat-pager").innerHTML = html`<a class="btn sm ${page <= 1 ? "hidden" : ""}" href="?${qs({ ...Object.fromEntries(params), page: page - 1 })}">Previous</a>
        <span class="muted small">Page ${page} of ${pages}</span>
        <a class="btn sm ${page >= pages ? "hidden" : ""}" href="?${qs({ ...Object.fromEntries(params), page: page + 1 })}">Next</a>`;
    }
  } catch (e) {
    toast(e.message, "error");
  }
  $("#cat-results").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.target.closest("a")) location.href = tr.dataset.href;
  });
}
