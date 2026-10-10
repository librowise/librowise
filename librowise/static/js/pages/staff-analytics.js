// Staff › Insights › Analytics — period/branch/granularity toolbar (in the URL), KPI tiles with deltas and
// drill-downs, and chart cards (title, period, "Table" toggle, CSV, "Open report") over the analytics API.
import { $, $$, api, html, money, num, qs, withBusy } from "/static/js/core.js";
import { barChart, donutChart, heatmap, hBarChart, kpiTile, lineChart } from "/static/js/charts.js";
import { t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { segmented, wireSegmented } from "/static/js/ui/tabs.js";
import {
  bucketLabel, cardEmpty, cardError, chartSkeleton, createToolbar, deltaText, drill, fmt, kpiError, miniStat,
  rangeText, refreshInsightLinks, setKpis, weekday, wireCard, wireViews,
} from "/static/js/pages/lib/insights-ui.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const page = $("#ins-page");
const canReports = page.dataset.canReports === "true";
let tb, views, seq = 0;
const cards = new Map();
const cache = new Map();

const S = () => tb.state;
const unit = () => t(`insights.analytics.unit_${S().g}`);
const label = (s) => bucketLabel(s, S().g);
const params = () => qs(tb.apiParams());

function fetchPanel(name) {
  const key = `${name}?${params()}`;
  if (!cache.has(key)) cache.set(key, api(`/analytics/${name}?${params()}`).catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

/** Append a block (optional small heading) to a card body and return the element charts render into. */
function block(body, heading) {
  const wrap = document.createElement("div");
  wrap.className = "ins-block";
  if (heading) wrap.innerHTML = html`<h3 class="ins-block-title">${heading}</h3>`;
  const el = document.createElement("div");
  wrap.append(el);
  body.append(wrap);
  return el;
}

function headline(body, value, rest = "") {
  const el = document.createElement("p");
  el.className = "ins-headline";
  el.innerHTML = html`<strong class="num">${value}</strong>${rest ? html` <span class="ins-headline-rest">${rest}</span>` : ""}`;
  body.append(el);
}

function minis(body, items) {
  const el = document.createElement("div");
  el.className = "ins-minis";
  el.innerHTML = html`${items}`;
  body.append(el);
}

const cmp = () => S().compare;
const delta = (cur, prev, goodWhen) => (cmp() ? deltaText(cur, prev, { goodWhen }) : "");
const chartOpts = { tools: false };

// ------------------------------------------------------------------ panel renderers

const RENDER = {
  circulation(body, d) {
    headline(body, num(d.totals.checkouts), html`${t("insights.analytics.checkouts_word", { count: d.totals.checkouts })} ${delta(d.totals.checkouts, d.totals.previous_checkouts)}`);
    const series = [{ name: t("insights.analytics.this_period"), values: d.checkouts }];
    if (cmp()) series.push({ name: t("insights.analytics.previous_period"), values: d.previous_checkouts, compare: true });
    lineChart(block(body), {
      ...chartOpts, labels: d.labels.map(label), height: 260, series,
      summary: t("insights.analytics.sum.circulation", { unit: unit(), range: rangeText(S().start, S().end), total: num(d.totals.checkouts), previous: num(d.totals.previous_checkouts) }),
    });
  },
  activity(body, d) {
    headline(body, num(d.totals.returns), html`${t("insights.analytics.returns_word", { count: d.totals.returns })} · ${t("insights.analytics.renewals_count", { count: d.totals.renewals })}`);
    barChart(block(body), {
      ...chartOpts, labels: d.labels.map(label), height: 220,
      series: [{ name: t("insights.analytics.returns"), values: d.returns }, { name: t("insights.analytics.renewals"), values: d.renewals }],
      summary: t("insights.analytics.sum.activity", { unit: unit(), returns: num(d.totals.returns), renewals: num(d.totals.renewals) }),
    });
  },
  heatmap(body, d) {
    const b = d.busiest;
    const day = b ? weekday(Math.max(0, WEEKDAYS.indexOf(b.day))) : "";
    headline(body, b ? `${day} ${fmt.hour(b.hour)}:00` : "—", b ? t("insights.analytics.busiest", { count: b.count }) : t("insights.analytics.no_checkouts"));
    heatmap(block(body), {
      ...chartOpts, rows: d.rows.map((_, i) => weekday(i)), cols: d.cols, values: d.values, rowHeader: t("insights.analytics.day"),
      colFormat: (h) => fmt.hour(h), format: (v) => num(v), summary: t("insights.analytics.sum.heatmap"),
    });
  },
  turnover(body, d) {
    headline(body, fmt.dec(d.overall), t("insights.analytics.loans_per_item"));
    hBarChart(block(body, t("insights.analytics.turnover_by_type")), {
      ...chartOpts, format: (v) => fmt.dec(v), valueLabel: t("insights.analytics.loans_per_item_col"), summary: t("insights.analytics.sum.turnover_type"),
      items: d.by_type.map((r) => ({ label: r.label, value: r.turnover, note: t("insights.analytics.loans_items", { loans: num(r.loans), items: num(r.items) }) })),
    });
    hBarChart(block(body, t("insights.analytics.top_subjects")), {
      ...chartOpts, valueLabel: t("insights.analytics.loans"), summary: t("insights.analytics.sum.subjects"),
      items: d.by_subject.map((r) => ({ label: r.label, value: r.loans, note: t("insights.analytics.per_item", { value: fmt.dec(r.turnover) }), href: drill.catalog(r.label) })),
    });
  },
  collection(body, d) {
    headline(body, num(d.total_items), t("insights.analytics.items_in_circulation", { count: d.total_items }));
    minis(body, [
      miniStat(t("insights.analytics.never_borrowed"), fmt.pct(d.never_borrowed_share, 1), t("insights.analytics.items_count", { count: d.never_borrowed })),
      miniStat(t("insights.analytics.idle_in_period"), fmt.pct(d.idle_share, 1), t("insights.analytics.items_count", { count: d.not_borrowed_in_period })),
    ]);
    barChart(block(body, t("insights.analytics.by_acquired")), {
      ...chartOpts, labels: d.by_acquisition_year.map((r) => (r.label === "Unknown" ? t("insights.analytics.unknown") : r.label)), height: 170,
      series: [{ name: t("insights.analytics.items"), values: d.by_acquisition_year.map((r) => r.value) }], summary: t("insights.analytics.sum.acquired"),
    });
    barChart(block(body, t("insights.analytics.by_decade")), {
      ...chartOpts, labels: d.by_publication_decade.map((r) => (r.label === "Unknown" ? t("insights.analytics.unknown") : r.label)), height: 170,
      series: [{ name: t("insights.analytics.items"), values: d.by_publication_decade.map((r) => r.value) }], summary: t("insights.analytics.sum.decade"),
    });
  },
  holds(body, d) {
    headline(body, num(d.totals.placed), html`${t("insights.analytics.holds_placed_word", { count: d.totals.placed })} ${delta(d.totals.placed, d.totals.previous_placed)}`);
    minis(body, [
      miniStat(t("insights.analytics.median_wait"), d.median_days_to_ready === null ? "—" : t("insights.analytics.days", { count: d.median_days_to_ready }), t("insights.analytics.placed_to_ready")),
      miniStat(t("insights.analytics.filled"), d.fill_rate === null ? "—" : fmt.pct(d.fill_rate), t("insights.analytics.of_placed")),
      miniStat(t("insights.analytics.queued_now"), num(d.queued_now), "", drill.holds()),
      miniStat(t("insights.analytics.on_shelf_now"), num(d.ready_now), "", drill.holds()),
    ]);
    lineChart(block(body), {
      ...chartOpts, labels: d.labels.map(label), height: 200, area: false,
      series: [{ name: t("insights.analytics.placed"), values: d.placed }, { name: t("insights.analytics.filled_series"), values: d.filled }],
      summary: t("insights.analytics.sum.holds", { unit: unit(), placed: num(d.totals.placed), filled: num(d.totals.filled) }),
    });
  },
  patrons(body, d) {
    headline(body, num(d.active), t("insights.analytics.active_of", { registered: num(d.registered), pct: fmt.pct(d.active_share) }));
    minis(body, [
      miniStat(t("insights.analytics.active_borrowers"), num(d.active), delta(d.active, d.previous_active), drill.patrons("active", S().branch ? { branch_id: S().branch } : {})),
      miniStat(t("insights.analytics.new_registrations"), num(d.new_total), delta(d.new_total, d.previous_new),
        canReports ? drill.insights("reports", S(), "new_patrons") : ""),
    ]);
    barChart(block(body, t("insights.analytics.registered_vs_active")), {
      ...chartOpts, labels: d.by_category.map((c) => c.label), height: 190,
      series: [{ name: t("insights.analytics.registered"), values: d.by_category.map((c) => c.registered) }, { name: t("insights.analytics.active"), values: d.by_category.map((c) => c.active) }],
      summary: t("insights.analytics.sum.categories"),
    });
    hBarChart(block(body, t("insights.analytics.active_by_category")), {
      ...chartOpts, valueLabel: t("insights.analytics.active"), summary: t("insights.analytics.sum.active_share"),
      items: d.by_category.filter((c) => c.active > 0).sort((a, b) => b.active - a.active)
        .map((c) => ({ label: c.label, value: c.active, href: drill.category(c.id), note: d.active ? fmt.pct(c.active / d.active) : "" })),
    });
  },
  fines(body, d) {
    const tt = d.totals;
    headline(body, money(tt.charged), html`${t("insights.analytics.charged_word")} ${delta(tt.charged, d.previous_totals.charged, "down")}`);
    minis(body, [
      miniStat(t("insights.analytics.collected"), money(tt.paid), delta(tt.paid, d.previous_totals.paid)),
      miniStat(t("insights.analytics.waived"), money(tt.waived)),
      miniStat(t("insights.analytics.outstanding_now"), money(d.outstanding), "", drill.patrons("owing", S().branch ? { branch_id: S().branch } : {})),
    ]);
    barChart(block(body), {
      ...chartOpts, labels: d.labels.map(label), height: 210, format: money,
      series: [{ name: t("insights.analytics.charged"), values: d.charged }, { name: t("insights.analytics.paid"), values: d.paid }, { name: t("insights.analytics.waived"), values: d.waived }],
      summary: t("insights.analytics.sum.fines", { unit: unit() }),
    });
  },
  top(body, d) {
    const seg = document.createElement("div");
    seg.className = "ins-top-switch";
    seg.innerHTML = segmented({ name: "top", label: t("insights.analytics.top_show"), value: "titles",
      options: [["titles", t("insights.analytics.titles")], ["authors", t("insights.analytics.authors")], ["subjects", t("insights.analytics.subjects")]] });
    body.append(seg);
    const el = block(body);
    const href = { titles: (r) => drill.record(r.id), authors: (r) => drill.catalog(r.label), subjects: (r) => drill.catalog(r.label) };
    const show = (kind) => hBarChart(el, {
      ...chartOpts, items: d[kind].map((r) => ({ ...r, href: href[kind](r) })), valueLabel: t("insights.analytics.loans"),
      summary: t(`insights.analytics.sum.top_${kind}`),
    });
    wireSegmented(seg, (kind) => { show(kind); cards.get("top").applyView(); });
    show("titles");
  },
  branches(body, d) {
    const rows = d.branches;
    if (!rows.length) { body.innerHTML = html`${cardEmpty(t("insights.analytics.no_branches"), "", "inbox")}`; return; }
    const best = (k) => Math.max(...rows.map((r) => r[k]));
    const lead = (r, k) => rows.length > 1 && r[k] > 0 && r[k] === best(k);
    const n = (k, f = num) => ({ key: k, label: t(`insights.analytics.col.${k}`), align: "num", sortable: true, csv: (r) => r[k],
      render: (r) => (lead(r, k) ? html`<strong class="ins-lead" title="${t("insights.analytics.leading")}">${f(r[k])}</strong>` : f(r[k])) });
    const el = document.createElement("div");
    body.append(el);
    let sorted = [...rows];
    const table = dataTable(el, {
      id: "analytics-branches", caption: t("insights.analytics.branches_caption"),
      columns: [
        { key: "name", label: t("insights.analytics.col.branch"), primary: true, hideable: false, sortable: true, csv: (r) => r.name,
          render: (r) => html`<a href="${drill.insights("analytics", { ...S(), branch: String(r.id) })}">${r.name}</a>${r.selected ? html` <span class="badge pill info"><span class="dot" aria-hidden="true"></span>${t("insights.analytics.selected")}</span>` : ""}` },
        n("checkouts"), { ...n("returns"), hidden: true }, n("active_patrons"), n("holds_placed"), { ...n("items"), hidden: true },
        n("turnover", (v) => fmt.dec(v)), n("open_loans"),
        { key: "overdue", label: t("insights.analytics.col.overdue"), align: "num", sortable: true, csv: (r) => r.overdue,
          render: (r) => html`${r.overdue ? html`<a href="${drill.patrons("overdue")}">${num(r.overdue)}</a>` : num(0)} <span class="muted small">(${fmt.pct(r.overdue_rate)})</span>` },
      ],
      onSort: (s) => {
        const dir = s.dir === "desc" ? -1 : 1;
        sorted = [...rows].sort((a, b) => dir * (s.key === "name" ? a.name.localeCompare(b.name) : a[s.key] - b[s.key]));
        table.setRows(sorted);
      },
      empty: { art: "inbox", title: t("insights.analytics.no_branches") },
    });
    table.setRows(sorted);
  },
};

// ------------------------------------------------------------------ loading

async function loadPanel(view, mySeq) {
  const card = cards.get(view);
  const section = card.card;
  const name = section.dataset.panel;
  card.sub.textContent = rangeText(S().start, S().end);
  card.setCsv(`/api/v1/analytics/${name}?${params()}&fmt=csv`);
  card.body.setAttribute("aria-busy", "true");
  card.body.innerHTML = html`${chartSkeleton(view)}`;
  try {
    const data = await fetchPanel(name);
    if (mySeq !== seq) return;
    card.body.innerHTML = "";
    RENDER[view](card.body, data);
    card.applyView();
  } catch (e) {
    if (mySeq !== seq) return;
    cardError(card.body, e, () => loadPanel(view, seq));
  } finally {
    card.body.removeAttribute("aria-busy");
  }
}

async function loadKpis(mySeq) {
  const box = $("#ins-kpis");
  try {
    const { kpis: k } = await fetchPanel("overview");
    if (mySeq !== seq) return;
    const s = S();
    const prev = tb.previous();
    const compareLabel = t("insights.common.vs_range", { range: rangeText(prev.start, prev.end) });
    const br = s.branch ? { branch_id: s.branch } : {};
    const tile = (key, labelKey, opts = {}) => kpiTile({
      label: t(labelKey), value: k[key].value, previous: s.compare ? k[key].previous : undefined,
      format: k[key].money ? money : num, compareLabel, className: "ins-kpi", ...opts,
    });
    setKpis(box, [
      tile("checkouts", "insights.analytics.kpi.checkouts", { spark: k.checkouts.spark, href: canReports ? drill.insights("reports", s, "circulation_by_branch") : "" }),
      tile("returns", "insights.analytics.kpi.returns"),
      tile("renewals", "insights.analytics.kpi.renewals"),
      tile("active_patrons", "insights.analytics.kpi.active_patrons", { href: drill.patrons("active", br) }),
      tile("new_patrons", "insights.analytics.kpi.new_patrons", { href: canReports ? drill.insights("reports", s, "new_patrons") : "" }),
      tile("holds_placed", "insights.analytics.kpi.holds_placed", { href: drill.holds() }),
      tile("fines_charged", "insights.analytics.kpi.fines_charged", { invert: true, href: canReports ? drill.insights("reports", s, "fines") : "" }),
      tile("fines_paid", "insights.analytics.kpi.fines_paid"),
    ]);
  } catch (e) {
    if (mySeq !== seq) return;
    kpiError(box, e, () => loadKpis(seq));
  }
}

function loadAll() {
  const mySeq = ++seq;
  cache.clear();
  refreshInsightLinks(page, S());
  views?.render();
  return Promise.all([loadKpis(mySeq), ...[...cards.keys()].map((view) => loadPanel(view, mySeq))]);
}

// ------------------------------------------------------------------ init

export default async function init() {
  tb = createToolbar({ granularity: true, compare: true, onChange: loadAll });
  $$(".ins-panel", page).forEach((s) => cards.set(s.dataset.view, wireCard(s)));
  $$(".ins-card-sub", page).forEach((el) => { el.textContent = rangeText(S().start, S().end); });

  $("#ins-refresh").addEventListener("click", (e) => withBusy(e.currentTarget, loadAll));
  loadAll();
  await tb.loadBranches();
  const presets = [
    { id: "d30", label: t("insights.analytics.view.last30"), params: { range: "30d", g: "day" } },
    { id: "q", label: t("insights.analytics.view.quarter"), params: { range: "90d", g: "week" } },
    { id: "ytd", label: t("insights.analytics.view.ytd"), params: { range: "ytd", g: "month" } },
    { id: "y", label: t("insights.analytics.view.year"), params: { range: "365d", g: "month" } },
    // one "last 30 days" view per branch (first four) when the library has several
    ...(tb.branches().length > 1 ? tb.branches().slice(0, 3).map((b) => ({ id: `b${b.id}`, label: t("insights.analytics.view.branch", { name: b.name }),
      params: { range: "30d", g: "day", branch: String(b.id) } })) : []),
  ];
  views = wireViews($("#ins-views"), { id: "analytics", toolbar: tb, keys: ["range", "branch", "g", "start", "end"], presets,
    current: () => { const s = S(); return { range: s.range, branch: s.branch, g: s.g, start: s.range === "custom" ? s.start : "", end: s.range === "custom" ? s.end : "" }; } });
}
