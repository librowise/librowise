// "System health" card on the staff Home for administrators (jobs:manage): database, worker, queue,
// failed jobs and backups at a glance, from /api/v1/system/overview. Librarians never load this.
import { api, html, icon, num, relative } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { errorState } from "/static/js/ui/empty.js";
import { statusPill } from "/static/js/ui/status.js";

const ok = (good, label) => html`<span class="badge pill ${good ? "success" : "danger"}"><span class="dot" aria-hidden="true"></span>${label}</span>`;

export async function renderSystemHealth(el) {
  try {
    const o = await api("/system/overview");
    const q = o.queue?.by_status || {};
    const worker = o.checks?.worker || {};
    const lastBackup = (o.backups || [])[0];
    const failed = (q.failed || 0) + (q.dead || 0);
    el.innerHTML = html`<div class="grid cols-4 sys-health">
      <div class="stack tight"><span class="small muted">${t("ui.health.database")}</span>${ok(o.checks?.database?.ok, o.checks?.database?.ok ? t("ui.health.ok_ms", { ms: o.checks.database.latency_ms }) : t("ui.health.down"))}</div>
      <div class="stack tight"><span class="small muted">${t("ui.health.worker")}</span>${ok(worker.ok, worker.ok ? t("ui.health.heartbeat", { s: num(Math.round(worker.heartbeat_age_seconds || 0)) }) : t("ui.health.no_worker"))}</div>
      <div class="stack tight"><span class="small muted">${t("ui.health.queue")}</span>
        <span>${failed ? statusPill("job", "dead", t("ui.health.failed_jobs", { count: failed })) : statusPill("job", "succeeded", t("ui.health.queue_ok", { count: q.queued || 0 }))}</span></div>
      <div class="stack tight"><span class="small muted">${t("ui.health.backup")}</span>
        ${lastBackup ? html`<span>${icon("check-circle")} ${relative(lastBackup.created_at)}</span>` : statusPill("job", "failed", t("ui.health.no_backup"))}</div>
    </div><p class="tiny muted" style="margin:.75rem 0 0">v${o.version} · ${o.environment} · ${t("ui.health.uptime", { when: relative(new Date(Date.now() - o.uptime_seconds * 1000).toISOString()) })}</p>`;
  } catch (e) {
    el.innerHTML = errorState(e, { retry: false });
  }
}
