// Staff: System — health, job queue (filter, retry, cancel, enqueue), schedules, workers,
// database information, request latency and the (read-only) backup list.
import { $, api, badge, confirmDialog, datetime, empty, esc, html, num, qs, relative, toast, withBusy } from "/static/js/core.js";

const JOB_BADGE = { queued: "queued", running: "info", succeeded: "ok", failed: "warn", dead: "bad", cancelled: "" };
const state = { status: "", type: "", page: 1, types: [] };

const bytes = (n) => {
  if (n === null || n === undefined) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const secs = (s) => (s === null || s === undefined ? "—" : s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const jobBadge = (s) => badge(JOB_BADGE[s] ?? "", s);
const firstLine = (t) => (t || "").trim().split("\n").filter(Boolean).pop() || "";

function healthTiles(o) {
  const w = o.checks.worker || {};
  const db = o.checks.database || {};
  const q = o.queue.by_status;
  const alive = o.workers.filter((x) => x.alive).length;
  return html`
    <div class="card stat ${o.ready ? "" : "alert"}"><span class="label">Readiness</span><span class="value">${o.ready ? "Ready" : "Unavailable"}</span>
      <span class="delta">Database ${db.ok ? `OK · ${db.latency_ms} ms` : "unreachable"}</span></div>
    <div class="card stat ${w.required && !w.ok ? "alert" : ""}"><span class="label">Workers</span><span class="value">${num(alive)}</span>
      <span class="delta">${w.heartbeat_age_seconds === null ? "No heartbeat yet" : `Last heartbeat ${secs(w.heartbeat_age_seconds)} ago`}${w.required ? " · required" : ""}</span></div>
    <div class="card stat ${q.dead ? "alert" : ""}"><span class="label">Queue</span><span class="value">${num(q.queued + q.failed)}</span>
      <span class="delta">${num(q.running)} running · ${num(q.dead)} dead · lag ${secs(o.queue.lag_seconds)}</span></div>
    <div class="card stat"><span class="label">Database</span><span class="value">${bytes(o.database.size_bytes)}</span>
      <span class="delta">${o.database.dialect} ${o.database.server_version || ""} · v${o.version} · up ${secs(o.uptime_seconds)}</span></div>`;
}

function jobsTable(data) {
  if (!data.results.length) return empty("No jobs match these filters.", "inbox");
  const pages = Math.max(1, Math.ceil(data.total / data.per_page));
  return html`<div class="table-wrap"><table class="table"><thead><tr>
      <th>#</th><th>Type</th><th>Status</th><th class="num">Attempts</th><th>Run at</th><th>Finished</th><th>Details</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
    ${data.results.map((j) => html`<tr>
      <td class="mono">${j.id}</td>
      <td><strong>${j.type}</strong>${j.schedule ? html`<div class="tiny muted">schedule: ${j.schedule}</div>` : ""}</td>
      <td>${jobBadge(j.status)}${j.locked_by ? html`<div class="tiny muted mono">${j.locked_by}</div>` : ""}</td>
      <td class="num">${j.attempts}/${j.max_attempts}</td>
      <td class="small">${datetime(j.run_at)}</td>
      <td class="small muted">${j.finished_at ? relative(j.finished_at) : "—"}</td>
      <td class="small" style="max-width:26rem">${j.last_error
        ? html`<details><summary class="mono tiny">${firstLine(j.last_error).slice(0, 120)}</summary><pre class="tiny sys-pre">${j.last_error}</pre></details>`
        : j.result ? html`<span class="mono tiny">${JSON.stringify(j.result).slice(0, 160)}</span>` : ""}</td>
      <td class="nowrap">${["failed", "dead", "cancelled"].includes(j.status) ? html`<button class="btn sm" data-retry="${j.id}">Retry</button>` : ""}
        ${["queued", "failed"].includes(j.status) ? html`<button class="btn sm ghost" data-cancel="${j.id}">Cancel</button>` : ""}</td>
    </tr>`)}</tbody></table></div>
    ${pages > 1 ? html`<nav class="pager" aria-label="Job pages">
      <button class="btn sm" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>&larr; Newer</button>
      <span class="small muted">Page ${num(data.page)} of ${num(pages)} · ${num(data.total)} jobs</span>
      <button class="btn sm" data-page="${data.page + 1}" ${data.page >= pages ? "disabled" : ""}>Older &rarr;</button></nav>` : ""}`;
}

function schedulesTable(rows) {
  if (!rows.length) return empty("No schedules configured (SHELFWISE_SCHEDULES).", "clock");
  return html`<div class="table-wrap"><table class="table"><thead><tr><th>Schedule</th><th>Cron</th><th>Next run</th><th>Last slot</th></tr></thead><tbody>
    ${rows.map((s) => html`<tr><td><strong>${s.name}</strong>${s.registered ? "" : html` ${badge("bad", "no handler")}`}</td>
      <td class="mono small">${s.cron}</td><td class="small">${s.next_run ? datetime(s.next_run) : "—"}</td>
      <td class="small">${s.last_slot ? html`${datetime(s.last_slot)} ${s.last_status ? jobBadge(s.last_status) : ""}` : html`<span class="muted">never</span>`}</td></tr>`)}
  </tbody></table></div>`;
}

function workersTable(rows) {
  if (!rows.length) return html`${empty("No worker has reported yet.", "clock")}<p class="tiny muted" style="margin:.5rem 0 0">Start one with <code>python -m shelfwise worker --concurrency 2</code>.</p>`;
  return html`<div class="table-wrap"><table class="table"><thead><tr><th>Worker</th><th>Status</th><th class="num">Done</th><th class="num">Failed</th><th>Heartbeat</th></tr></thead><tbody>
    ${rows.map((w) => html`<tr><td><span class="mono small">${w.worker_id}</span><div class="tiny muted">concurrency ${w.concurrency} · started ${relative(w.started_at)}</div></td>
      <td>${w.stopping ? badge("", "stopped") : w.alive ? badge("ok", w.current_jobs.length ? `busy (${w.current_jobs.length})` : "idle") : badge("bad", "stale")}</td>
      <td class="num">${num(w.jobs_succeeded)}</td><td class="num">${num(w.jobs_failed)}</td><td class="small muted">${secs(w.age_seconds)} ago</td></tr>`)}
  </tbody></table></div>`;
}

function dbInfo(d, o) {
  const kv = (k, v) => html`<div class="kv"><span class="muted">${k}</span><strong>${v}</strong></div>`;
  return html`<div class="stack tight">
    ${kv("Engine", `${d.dialect} ${d.server_version || ""}`)}${kv("Connection", html`<span class="mono tiny">${d.url}</span>`)}
    ${kv("Size", bytes(d.size_bytes))}${kv("Search backend", d.search_backend)}
    ${kv("Pool (in use / size)", `${num(d.pool.checkedout)} / ${num(d.pool.size)}`)}
    ${Object.entries(d.rows).map(([k, v]) => kv(`Rows: ${k}`, num(v)))}
    ${kv("Rate limiting", o.rate_limit_backend)}${kv("Log format", o.log_format)}
    ${kv("Metrics endpoint", o.metrics_token_configured ? "/metrics (token or admin session)" : "/metrics (admin session only)")}
  </div>`;
}

function latencyTable(l) {
  if (!l.routes.length) return empty("No requests measured yet.", "chart");
  return html`<div class="table-wrap"><table class="table"><thead><tr><th>Route</th><th class="num">Requests</th><th class="num">p50</th><th class="num">p95</th></tr></thead><tbody>
    ${l.routes.map((r) => html`<tr><td class="mono tiny">${r.method} ${r.route}</td><td class="num">${num(r.count)}</td>
      <td class="num">${r.p50_ms === null ? ">10 s" : `${r.p50_ms} ms`}</td><td class="num">${r.p95_ms === null ? ">10 s" : `${r.p95_ms} ms`}</td></tr>`)}
  </tbody></table></div>`;
}

function backupsTable(rows) {
  if (!rows.length) return empty("No backups found in the backup directory.", "inbox");
  return html`<div class="table-wrap"><table class="table"><thead><tr><th>File</th><th>Created</th><th class="num">Size</th><th>Checksum</th></tr></thead><tbody>
    ${rows.map((b) => html`<tr><td class="mono small">${b.name}</td><td class="small">${datetime(b.created_at)}</td><td class="num">${bytes(b.size)}</td>
      <td class="mono tiny">${b.sha256 ? `${b.sha256.slice(0, 16)}…` : badge("warn", "no manifest")}</td></tr>`)}
  </tbody></table></div>`;
}

async function loadJobs() {
  const data = await api(`/system/jobs?${qs({ status: state.status, type: state.type, page: state.page })}`);
  $("#sys-jobs").innerHTML = jobsTable(data);
}

async function load() {
  const o = await api("/system/overview");
  $("#sys-health").innerHTML = healthTiles(o);
  const q = o.queue.by_status;
  $("#sys-queue-summary").textContent = `${num(q.queued)} queued · ${num(q.running)} running · ${num(q.failed)} retrying · ${num(q.dead)} dead`;
  if (!state.types.length) {
    state.types = o.job_types;
    const opts = o.job_types.map((t) => `<option value="${esc(t.type)}">${esc(t.type)}</option>`).join("");
    $("#sys-type").insertAdjacentHTML("beforeend", opts);
    $("#sys-enqueue-type").innerHTML = o.job_types.map((t) => `<option value="${esc(t.type)}" title="${esc(t.description)}">${esc(t.type)}</option>`).join("");
  }
  $("#sys-tz").textContent = o.schedules[0] ? `times in your local zone · schedules run in ${o.schedules[0].timezone}` : "";
  $("#sys-schedules").innerHTML = schedulesTable(o.schedules);
  $("#sys-workers").innerHTML = workersTable(o.workers);
  $("#sys-db").innerHTML = dbInfo(o.database, o);
  $("#sys-latency").innerHTML = latencyTable(o.latency);
  $("#sys-backup-dir").textContent = o.backup_dir;
  $("#sys-backups").innerHTML = backupsTable(o.backups);
  await loadJobs();
  $("#sys-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

async function refresh(btn) {
  try {
    await (btn ? withBusy(btn, load) : load());
  } catch (e) {
    if (e.status === 403) {
      $("#sys-health").innerHTML = html`<div class="alert warn" role="alert">Administrator access (jobs:manage) is required for this page.</div>`;
    } else toast(e.message, "error");
  }
}

export default async function init() {
  await refresh();
  $("#sys-refresh").addEventListener("click", (e) => refresh(e.currentTarget));
  $("#sys-job-filters").addEventListener("change", (e) => {
    if (e.target.id === "sys-status") state.status = e.target.value;
    else if (e.target.id === "sys-type") state.type = e.target.value;
    else return;
    state.page = 1;
    loadJobs().catch((err) => toast(err.message, "error"));
  });
  $("#sys-job-filters").addEventListener("submit", (e) => e.preventDefault());
  $("#sys-enqueue").addEventListener("click", async (e) => {
    const type = $("#sys-enqueue-type").value;
    if (!type || !(await confirmDialog("Queue job", `Queue a "${type}" job now? A running worker will pick it up.`, "Queue", false))) return;
    try {
      const j = await withBusy(e.currentTarget, () => api("/system/jobs", { method: "POST", body: { type } }));
      toast(`Job #${j.id} (${j.type}) queued`, "success");
      await load();
    } catch { /* toasted */ }
  });
  $("#sys-jobs").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-retry],button[data-cancel],button[data-page]");
    if (!btn) return;
    if (btn.dataset.page) {
      state.page = Number(btn.dataset.page);
      loadJobs().catch((err) => toast(err.message, "error"));
      return;
    }
    const id = btn.dataset.retry || btn.dataset.cancel;
    const action = btn.dataset.retry ? "retry" : "cancel";
    if (action === "cancel" && !(await confirmDialog("Cancel job", `Cancel job #${id}? It will not run.`, "Cancel job"))) return;
    try {
      await withBusy(btn, () => api(`/system/jobs/${id}/${action}`, { method: "POST" }));
      toast(`Job #${id} ${action === "retry" ? "re-queued" : "cancelled"}`, "success");
      await load();
    } catch { /* toasted */ }
  });
}
