import { $, api, badge, barChart, date, empty, hbars, html, money, num, relative, toast } from "/static/js/core.js";

const MATERIAL = { book: "Books", dvd: "DVDs", serial: "Magazines", audiobook: "Audiobooks", comic: "Graphic novels", ebook: "E-books" };

export default async function init() {
  $("#today").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  try {
    const [d, recent] = await Promise.all([api("/reports/dashboard"), api("/circulation/recent?limit=12")]);
    const s = d.stats;
    $("#stats").innerHTML = html`
      <a class="card stat" href="/staff/circulation"><span class="label">On loan</span><span class="value">${num(s.loans_open)}</span><span class="delta">${num(s.loans_today)} checked out today</span></a>
      <a class="card stat ${s.loans_overdue ? "alert" : ""}" href="/staff/reports"><span class="label">Overdue</span><span class="value">${num(s.loans_overdue)}</span><span class="delta">${s.loans_open ? Math.round((100 * s.loans_overdue) / s.loans_open) : 0}% of open loans</span></a>
      <a class="card stat" href="/staff/holds"><span class="label">Holds</span><span class="value">${num(s.holds_queued)}</span><span class="delta">${num(s.holds_ready)} awaiting pickup</span></a>
      <a class="card stat" href="/staff/catalog"><span class="label">Collection</span><span class="value">${num(s.titles)}</span><span class="delta">${num(s.items)} items · ${money(s.fines_outstanding)} owed</span></a>`;
    // Fill missing days so the chart reads as a continuous timeline
    const byDay = Object.fromEntries(d.trend.map((t) => [t.date, t.count]));
    const days = [...Array(30)].map((_, i) => { const dt = new Date(Date.now() - (29 - i) * 86400000); return dt.toISOString().slice(0, 10); });
    const values = days.map((k) => byDay[k] || 0);
    $("#trend").innerHTML = barChart(values, { labels: days.map((k) => date(k, { day: "numeric", month: "short" })) });
    $("#trend-total").textContent = `${num(values.reduce((a, b) => a + b, 0))} total`;
    $("#by-branch").innerHTML = d.by_branch.length ? hbars(d.by_branch) : empty("No loans yet");
    $("#by-material").innerHTML = hbars(d.by_material.map((m) => ({ label: MATERIAL[m.label] || m.label, value: m.value })));
    $("#risk").innerHTML = d.risk.length ? html`<div class="stack tight">${d.risk.map((r) => html`<div class="kv">
      <span class="grow"><strong>${r.title}</strong><div class="tiny muted"><a href="/staff/patrons/${r.patron_id}">${r.patron}</a> · due ${date(r.due_at)}</div></span>
      ${badge(r.level, `${Math.round(r.risk * 100)}% ${r.level}`)}</div>`)}</div>` : empty("No open loans to score.");
    $("#top").innerHTML = d.top_titles.length ? html`<ol class="stack tight" style="padding-left:1.2rem;margin:0">${d.top_titles.map((t) => html`<li><div class="row between"><span>${t.title}</span><span class="badge">${t.loans}</span></div></li>`)}</ol>` : empty("No loans this month");
    $("#recent").innerHTML = recent.results.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Patron</th><th>Event</th><th>When</th></tr></thead><tbody>
      ${recent.results.map((l) => html`<tr><td><a href="/staff/catalog/${l.item.biblio.id}">${l.item.biblio.title}</a><div class="tiny muted mono">${l.item.barcode}</div></td>
        <td>${l.patron ? html`<a href="/staff/patrons/${l.patron.id}">${l.patron.full_name}</a>` : html`<span class="muted">anonymised</span>`}</td>
        <td>${l.returned_at ? badge("ok", "Returned") : l.overdue ? badge("overdue", "Overdue") : badge("info", `Due ${date(l.due_at)}`)}</td>
        <td class="muted small">${relative(l.returned_at || l.issued_at)}</td></tr>`)}</tbody></table></div>` : empty("No activity yet");
  } catch (e) {
    toast(e.message, "error");
  }
}
