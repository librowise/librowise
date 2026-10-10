// Staff › Administration › System — health tiles, the background job queue (filter, details, retry, cancel,
// run now), schedules, workers, database, request latency and the read-only backup list.
import { $, api, datetime, html, icon, num, relative, toast } from "/static/js/core.js";
import { locale, t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { confirmDialog } from "/static/js/ui/dialog.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { selectChip, urlState, wireFilterBar } from "/static/js/ui/filters.js";
import { sidePanel } from "/static/js/ui/panel.js";
import { statTile } from "/static/js/ui/stat.js";
import { statusPill, statusText } from "/static/js/ui/status.js";
import { bytes, cronText, dl, duration, jobDescription, jobLabel, pill, rowMenu, wireKit } from "/static/js/pages/lib/admin-kit.js";
import { editDialog, humanize } from "/static/js/pages/lib/settings-ui.js";

const STATUSES = ["queued", "running", "failed", "dead", "succeeded", "cancelled"];
const filters = urlState({ status: "", type: "", page: 1, per_page: 10 });
const state = { overview: null, jobs: [], table: null };
const firstLine = (s) => (s || "").trim().split("\n").filter(Boolean).pop() || "";
const when = (v) => (v ? html`<span title="${datetime(v)}">${relative(v)}</span>` : html`<span class="muted">—</span>`);

/** Connection URL for people: percent-decoded, any password masked. */
export function displayUrl(url) {
  let s = String(url || "");
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  return s.replace(/(\/\/[^:/@]+):[^@/]*@/, "$1:••••••@");
}

// ------------------------------------------------------------------ health

function healthTiles(o) {
  const w = o.checks.worker || {};
  const db = o.checks.database || {};
  const q = o.queue.by_status;
  const alive = o.workers.filter((x) => x.alive).length;
  const waiting = (q.queued || 0) + (q.failed || 0);
  return html`
    ${statTile({ label: t("admin.system.kpi.readiness"), icon: "activity", tone: o.ready ? "" : "danger",
      value: o.ready ? t("admin.system.ready") : t("admin.system.not_ready"),
      foot: db.ok ? t("admin.system.db_answered", { ms: num(db.latency_ms) }) : t("admin.system.db_down") })}
    ${statTile({ label: t("admin.system.kpi.workers"), icon: "monitor", tone: w.required && !w.ok ? "danger" : alive ? "" : "warning", value: alive,
      foot: w.heartbeat_age_seconds === null || w.heartbeat_age_seconds === undefined ? t("admin.system.no_worker")
        : t("admin.system.heartbeat", { ago: duration(w.heartbeat_age_seconds) }) })}
    ${statTile({ label: t("admin.system.kpi.queue"), icon: "layers", tone: q.dead ? "danger" : "", value: waiting,
      foot: t("admin.system.queue_foot", { running: num(q.running || 0), dead: num(q.dead || 0), lag: duration(o.queue.lag_seconds || 0) }) })}
    ${statTile({ label: t("admin.system.kpi.database"), icon: "table", value: bytes(o.database.size_bytes),
      foot: t("admin.system.db_foot", { engine: engineName(o.database.dialect), version: o.version, uptime: duration(o.uptime_seconds, "long") }) })}`;
}

const engineName = (d) => ({ sqlite: "SQLite", postgresql: "PostgreSQL", mysql: "MySQL" }[d] || humanize(d));

// ------------------------------------------------------------------ jobs

function jobMenu(j) {
  return rowMenu({ label: t("admin.system.job_n", { name: jobLabel(j.type), id: j.id }), items: [
    { id: "details", label: t("admin.system.view_details"), icon: "info" },
    { id: "retry", label: t("admin.system.retry"), icon: "refresh", hidden: !["failed", "dead", "cancelled"].includes(j.status) },
    { id: "cancel", label: t("admin.system.cancel_job"), icon: "x-circle", danger: true, hidden: !["queued", "failed"].includes(j.status) },
  ] });
}

function outcome(j) {
  if (j.last_error) return html`<span class="sys-error" title="${firstLine(j.last_error)}">${firstLine(j.last_error)}</span>`;
  if (j.result && typeof j.result === "object") {
    const n = Object.keys(j.result).length;
    return n ? html`<span class="muted">${t("admin.system.result_n", { count: n })}</span>` : "";
  }
  return j.result ? String(j.result) : html`<span class="muted">—</span>`;
}

function jobsTable(el) {
  const s = filters.get();
  return dataTable(el, {
    id: "system-jobs", caption: t("admin.system.jobs_title"), rowKey: (j) => j.id, rowLabel: (j) => jobLabel(j.type),
    perPage: s.per_page, perPageOptions: [10, 25, 50, 100],
    columns: [
      { key: "type", label: t("admin.system.col.job"), primary: true, hideable: false, csv: (j) => jobLabel(j.type),
        render: (j) => html`<div class="dt-cell-stack"><button type="button" class="link-btn as-row-title" data-job-details>${jobLabel(j.type)}</button>
          <span class="sub">${j.schedule ? t("admin.system.job_meta_scheduled", { id: j.id }) : t("admin.system.job_meta", { id: j.id })}</span></div>` },
      { key: "status", label: t("admin.system.col.status"), csv: (j) => statusText(j.status), render: (j) => statusPill("job", j.status) },
      { key: "attempts", label: t("admin.system.col.attempts"), align: "num", csv: (j) => j.attempts, render: (j) => t("admin.system.attempts_of", { n: num(j.attempts), m: num(j.max_attempts) }) },
      { key: "run_at", label: t("admin.system.col.run_at"), csv: (j) => j.run_at, render: (j) => when(j.run_at) },
      { key: "finished_at", label: t("admin.system.col.finished"), csv: (j) => j.finished_at || "", render: (j) => when(j.finished_at) },
      { key: "outcome", label: t("admin.system.col.outcome"), cardHidden: true, csv: (j) => firstLine(j.last_error) || "", render: outcome },
      { key: "actions", label: t("admin.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "as-cell-actions", headClass: "as-cell-actions", render: jobMenu },
    ],
    onPage: ({ page, perPage }) => { filters.set({ page, per_page: perPage }); loadJobs(); },
    exportName: "librowise-jobs",
    empty: { art: "done", title: t("admin.system.no_jobs_title"), body: t("admin.system.no_jobs_body") },
  });
}

async function loadJobs() {
  const s = filters.get();
  const table = state.table;
  table.setLoading();
  try {
    const data = await api(`/system/jobs?${new URLSearchParams(Object.entries({ status: s.status, type: s.type, page: s.page, per_page: s.per_page }).filter(([, v]) => v !== ""))}`);
    state.jobs = data.results;
    table.setRows(data.results, { total: data.total, page: data.page, perPage: data.per_page });
  } catch (err) { table.setError(err, loadJobs); }
}

function renderFilters(o) {
  const s = filters.get();
  const types = [...o.job_types].sort((a, b) => jobLabel(a.type).localeCompare(jobLabel(b.type), locale));
  $("#sys-filter-row").innerHTML = html`
    ${selectChip({ name: "status", label: t("admin.system.col.status"), value: s.status, options: [["", t("admin.system.any_status")], ...STATUSES.map((x) => [x, statusText(x)])] })}
    ${selectChip({ name: "type", label: t("admin.system.col.job"), value: s.type, options: [["", t("admin.system.any_job")], ...types.map((x) => [x.type, jobLabel(x.type)])] })}`;
}

function jobDetails(j) {
  const payload = j.payload && Object.keys(j.payload).length ? dl(Object.entries(j.payload).map(([k, v]) => [humanize(k), typeof v === "object" ? JSON.stringify(v) : String(v)])) : null;
  const result = j.result && typeof j.result === "object" && Object.keys(j.result).length
    ? dl(Object.entries(j.result).map(([k, v]) => [humanize(k), typeof v === "number" ? num(v) : typeof v === "object" ? JSON.stringify(v) : String(v)])) : null;
  const sp = sidePanel({
    title: jobLabel(j.type), subtitle: t("admin.system.job_meta", { id: j.id }), wide: !!j.last_error,
    body: html`<div class="stack">
      <p class="small muted">${jobDescription(j.type, "")}</p>
      ${dl([
        [t("admin.system.col.status"), statusPill("job", j.status)],
        [t("admin.system.col.attempts"), t("admin.system.attempts_of", { n: num(j.attempts), m: num(j.max_attempts) })],
        [t("admin.system.col.run_at"), html`${datetime(j.run_at)} <span class="muted">(${relative(j.run_at)})</span>`],
        [t("admin.system.started"), j.started_at ? datetime(j.started_at) : null],
        [t("admin.system.col.finished"), j.finished_at ? datetime(j.finished_at) : null],
        [t("admin.system.worker"), j.locked_by ? html`<span class="mono small">${j.locked_by}</span>` : null],
        [t("admin.system.schedule"), j.schedule ? jobLabel(j.schedule) : null],
        [t("admin.system.priority"), num(j.priority)],
      ])}
      ${payload ? html`<section class="as-detail-block"><h3>${t("admin.system.payload")}</h3>${payload}</section>` : ""}
      ${result ? html`<section class="as-detail-block"><h3>${t("admin.system.result")}</h3>${result}</section>` : ""}
      ${j.last_error ? html`<section class="as-detail-block"><h3>${t("admin.system.last_error")}</h3><p class="sys-error-line">${firstLine(j.last_error)}</p>
        <pre class="as-code" tabindex="0" aria-label="${t("admin.system.trace")}">${j.last_error}</pre></section>` : ""}</div>`,
    footer: html`${["queued", "failed"].includes(j.status) ? html`<button type="button" class="btn danger" data-act="cancel">${icon("x-circle")}${t("admin.system.cancel_job")}</button>` : ""}
      <span class="spacer grow"></span>
      ${["failed", "dead", "cancelled"].includes(j.status) ? html`<button type="button" class="btn primary" data-act="retry">${icon("refresh")}${t("admin.system.retry")}</button>` : ""}
      <button type="button" class="btn" data-close>${t("common.close")}</button>`,
  });
  sp.el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (await jobAction(j, b.dataset.act)) sp.close();
  });
}

async function jobAction(j, action) {
  if (action === "cancel" && !(await confirmDialog(t("admin.system.cancel_title", { name: jobLabel(j.type) }), t("admin.system.cancel_text"), t("admin.system.cancel_job")))) return false;
  try {
    await api(`/system/jobs/${j.id}/${action}`, { method: "POST" });
    toast(action === "retry" ? t("admin.system.retried", { name: jobLabel(j.type) }) : t("admin.system.cancelled", { name: jobLabel(j.type) }), "success");
    await refresh();
    return true;
  } catch (err) { toast(err.message, "error"); return false; }
}

async function runJob() {
  const types = [...(state.overview?.job_types || [])].sort((a, b) => jobLabel(a.type).localeCompare(jobLabel(b.type), locale));
  const job = await editDialog({
    title: t("admin.system.run_title"), submit: t("admin.system.queue_job"), size: "md",
    body: html`<p class="small muted">${t("admin.system.run_intro")}</p>
      <fieldset class="sys-job-choices"><legend class="sr-only">${t("admin.system.col.job")}</legend>
      ${types.map((x, i) => html`<label class="sys-job-choice"><input type="radio" name="type" value="${x.type}" ${i === 0 ? "checked" : ""} required>
        <span><strong>${jobLabel(x.type)}</strong><span class="small muted">${jobDescription(x.type, x.description)}</span>
        <span class="tiny muted">${t("admin.system.max_attempts", { count: x.max_attempts })}</span></span></label>`)}</fieldset>`,
    onSubmit: (d) => api("/system/jobs", { method: "POST", body: { type: d.type } }),
  });
  if (!job) return;
  toast(t("admin.system.queued", { name: jobLabel(job.type) }), "success");
  await refresh();
}

// ------------------------------------------------------------------ cards

function schedulesTable(el, o) {
  const tz = o.schedules[0]?.timezone;
  $("#sys-tz").textContent = tz ? t("admin.system.tz_note", { tz }) : t("admin.system.schedules_desc");
  const table = dataTable(el, {
    id: "system-schedules", caption: t("admin.system.schedules_title"), rowKey: (s) => s.name,
    columns: [
      { key: "name", label: t("admin.system.col.schedule"), primary: true, hideable: false, csv: (s) => jobLabel(s.name),
        render: (s) => html`<div class="dt-cell-stack"><strong>${jobLabel(s.name)}</strong><span class="sub" title="${s.cron}">${cronText(s.cron)}</span></div>
          ${s.registered ? "" : pill("danger", t("admin.system.no_handler"))}` },
      { key: "next", label: t("admin.system.col.next_run"), csv: (s) => s.next_run || "",
        render: (s) => (s.next_run ? html`<div class="dt-cell-stack"><span>${relative(s.next_run)}</span><span class="sub">${datetime(s.next_run)}</span></div>` : html`<span class="muted">—</span>`) },
      { key: "last", label: t("admin.system.col.last_run"), csv: (s) => s.last_slot || "",
        render: (s) => (s.last_slot ? html`<div class="dt-cell-stack"><span>${s.last_status ? statusPill("job", s.last_status) : ""}</span><span class="sub">${relative(s.last_slot)}</span></div>`
          : html`<span class="muted">${t("admin.common.never")}</span>`) },
    ],
    empty: { art: "inbox", title: t("admin.system.no_schedules"), body: t("admin.system.no_schedules_body") },
  });
  table.setRows(o.schedules);
}

function workersTable(el, o) {
  const table = dataTable(el, {
    id: "system-workers", caption: t("admin.system.workers_title"), rowKey: (w) => w.worker_id,
    columns: [
      { key: "id", label: t("admin.system.col.worker"), primary: true, hideable: false, csv: (w) => w.worker_id,
        render: (w) => html`<div class="dt-cell-stack"><span class="mono small">${w.worker_id}</span><span class="sub">${t("admin.system.worker_meta", { host: w.hostname || "—", count: w.concurrency })}</span></div>` },
      { key: "status", label: t("admin.system.col.status"), csv: (w) => (w.stopping ? "stopped" : w.alive ? "alive" : "stale"),
        render: (w) => (w.stopping ? pill("neutral", t("admin.system.w_stopped")) : w.alive
          ? (w.current_jobs.length ? pill("info", t("admin.system.w_busy", { count: w.current_jobs.length })) : pill("success", t("admin.system.w_idle")))
          : pill("danger", t("admin.system.w_stale"))) },
      { key: "done", label: t("admin.system.col.done"), align: "num", csv: (w) => w.jobs_succeeded, render: (w) => num(w.jobs_succeeded) },
      { key: "failed", label: t("admin.system.col.failed"), align: "num", csv: (w) => w.jobs_failed, render: (w) => num(w.jobs_failed) },
      { key: "seen", label: t("admin.system.col.heartbeat"), csv: (w) => w.last_seen_at, render: (w) => when(w.last_seen_at) },
    ],
    empty: { art: "inbox", title: t("admin.system.no_workers"), body: t("admin.system.no_workers_body") },
  });
  table.setRows(o.workers);
}

function dbCard(d, o) {
  const rowNames = { biblios: "titles", items: "items", patrons: "patrons", loans: "loans", jobs: "jobs" };
  return html`${dl([
    [t("admin.system.db.engine"), `${engineName(d.dialect)}${d.server_version ? ` ${d.server_version}` : ""}`],
    [t("admin.system.db.connection"), html`<code class="as-url">${displayUrl(d.url)}</code>`],
    [t("admin.system.db.size"), bytes(d.size_bytes)],
    [t("admin.system.db.search"), String(d.search_backend || "").replace(/^fts(\d)$/i, "SQLite FTS$1").replace(/^postgres(ql)?$/i, "PostgreSQL")],
    [t("admin.system.db.pool"), t("admin.system.db.pool_value", { used: num(d.pool?.checkedout || 0), size: num(d.pool?.size || 0) })],
    d.journal_mode ? [t("admin.system.db.journal"), String(d.journal_mode).toUpperCase()] : null,
    d.connections !== undefined ? [t("admin.system.db.connections"), num(d.connections)] : null,
  ])}
  <h3 class="as-mini-head">${t("admin.system.db.records")}</h3>
  ${dl(Object.entries(d.rows || {}).map(([k, v]) => [t(`admin.system.db.row.${rowNames[k] || "other"}`, {}, humanize(k)), num(v)]), { cols: 2 })}
  <h3 class="as-mini-head">${t("admin.system.db.operations")}</h3>
  ${dl([
    [t("admin.system.db.rate_limit"), humanize(o.rate_limit_backend)],
    [t("admin.system.db.logs"), String(o.log_format).toUpperCase()],
    [t("admin.system.db.metrics"), html`<code class="as-url">/metrics</code> <span class="small muted">${o.metrics_token_configured ? t("admin.system.db.metrics_token") : t("admin.system.db.metrics_admin")}</span>`],
    [t("admin.system.db.environment"), humanize(o.environment)],
  ])}`;
}

function latencyTable(el, o) {
  const table = dataTable(el, {
    id: "system-latency", caption: t("admin.system.latency_title"), rowKey: (r) => `${r.method} ${r.route}`,
    columns: [
      { key: "route", label: t("admin.system.col.route"), primary: true, hideable: false, csv: (r) => `${r.method} ${r.route}`,
        render: (r) => html`<span class="sys-route"><span class="sys-method">${r.method}</span><code>${r.route}</code></span>` },
      { key: "count", label: t("admin.system.col.requests"), align: "num", csv: (r) => r.count, render: (r) => num(r.count) },
      { key: "p50", label: t("admin.system.col.p50"), align: "num", csv: (r) => r.p50_ms ?? "", render: (r) => ms(r.p50_ms) },
      { key: "p95", label: t("admin.system.col.p95"), align: "num", csv: (r) => r.p95_ms ?? "", render: (r) => ms(r.p95_ms) },
    ],
    empty: { art: "inbox", title: t("admin.system.no_latency"), body: t("admin.system.no_latency_body") },
  });
  table.setRows(o.latency.routes);
}
const ms = (v) => (v === null || v === undefined ? t("admin.system.over_10s") : t("admin.system.at_most_ms", { ms: num(v) }));

function backupsTable(el, o) {
  $("#sys-backup-dir").innerHTML = html`${t("admin.system.backup_dir")} <code class="as-url">${displayUrl(o.backup_dir)}</code>`;
  const table = dataTable(el, {
    id: "system-backups", caption: t("admin.system.backups_title"), rowKey: (b) => b.name,
    columns: [
      { key: "name", label: t("admin.system.col.file"), primary: true, hideable: false, csv: (b) => b.name,
        render: (b) => html`<div class="dt-cell-stack"><span class="mono small">${b.name}</span><span class="sub">${humanize(b.kind || "")}</span></div>` },
      { key: "created", label: t("admin.system.col.created"), csv: (b) => b.created_at, render: (b) => html`<div class="dt-cell-stack"><span>${relative(b.created_at)}</span><span class="sub">${datetime(b.created_at)}</span></div>` },
      { key: "size", label: t("admin.system.col.size"), align: "num", csv: (b) => b.size, render: (b) => bytes(b.size) },
      { key: "checksum", label: t("admin.system.col.checksum"), csv: (b) => b.sha256 || "",
        render: (b) => (b.sha256 ? html`<span class="mono small" title="${b.sha256}">${b.sha256.slice(0, 12)}…</span>` : pill("warning", t("admin.system.no_manifest"))) },
    ],
    exportName: "librowise-backups",
    empty: { art: "inbox", title: t("admin.system.no_backups"), body: t("admin.system.no_backups_body") },
  });
  table.setRows(o.backups);
}

// ------------------------------------------------------------------ load

function sectionError(el, err) { el.innerHTML = errorState(err, { retry: false }); }

async function refresh(btn) {
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  try {
    const o = await api("/system/overview");
    state.overview = o;
    const health = $("#sys-health");
    health.innerHTML = healthTiles(o);
    health.removeAttribute("aria-busy");
    const q = o.queue.by_status;
    $("#sys-queue-summary").textContent = t("admin.system.queue_summary", { queued: num(q.queued || 0), running: num(q.running || 0), failed: num(q.failed || 0), dead: num(q.dead || 0) });
    renderFilters(o);
    for (const [id, fn] of [["#sys-schedules", schedulesTable], ["#sys-workers", workersTable], ["#sys-latency", latencyTable], ["#sys-backups", backupsTable]]) {
      try { fn($(id), o); } catch (err) { sectionError($(id), err); }
    }
    $("#sys-db").innerHTML = dbCard(o.database, o);
    await loadJobs();
    $("#sys-updated").textContent = t("admin.system.updated", { time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()) });
  } catch (e) {
    if (e.status === 403) $("#sys-health").innerHTML = html`<div class="card">${emptyState({ art: "error", title: t("admin.settings.denied.title"), body: t("admin.system.denied") })}</div>`;
    else toast(e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); }
  }
}

export default async function init() {
  wireKit();
  state.table = jobsTable($("#sys-jobs"));
  state.table.setLoading();
  wireFilterBar($("#sys-filters"), (changes) => { filters.set({ ...changes, page: 1 }); loadJobs(); }, { keys: ["status", "type"] });
  $("#sys-refresh").addEventListener("click", (e) => refresh(e.currentTarget));
  $("#sys-run").addEventListener("click", runJob);
  const jobsEl = $("#sys-jobs");
  const find = (el) => state.jobs.find((j) => String(j.id) === el.closest("tr[data-key]")?.dataset.key);
  jobsEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-job-details]")) { const j = find(e.target); if (j) jobDetails(j); }
  });
  jobsEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("tbody tr[data-key]")) { e.preventDefault(); const j = find(e.target); if (j) jobDetails(j); }
  });
  jobsEl.addEventListener("rowmenu", (e) => {
    const j = find(e.target);
    if (!j) return;
    if (e.detail.action === "details") jobDetails(j); else jobAction(j, e.detail.action);
  });
  await refresh();
}
