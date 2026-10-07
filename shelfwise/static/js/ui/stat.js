// KPI / stat tiles and progress bars.
//
//   statTile({ label: "On loan", value: 1204, icon: "repeat", delta: 12, deltaLabel: "vs last week", href: "/staff/circulation" })
//   statTile({ label: "Overdue", value: 37, tone: "danger", goodWhen: "down", delta: 5 })
//   progress({ value: 72, label: "Budget committed", tone: "warning" })   → labelled <div role="progressbar">
//   progress({ indeterminate: true, label: "Importing…" })
// For tiles with sparklines and period comparison use charts.js kpiTile() (same visual language).
import { html, icon, num } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

export function statTile({ label, value, icon: ic = "", delta = null, deltaLabel = "", goodWhen = "up", tone = "", href = "", format = num, foot = "" }) {
  let trend = "";
  if (delta !== null && delta !== undefined) {
    const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    const good = dir === "flat" ? "flat" : (dir === goodWhen ? "up" : "down");
    const text = `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${format(Math.abs(delta))}`;
    trend = html`<span class="trend ${good}">${icon(dir === "down" ? "arrow-down" : dir === "up" ? "arrow-up" : "arrow-right")}${text}
      <span class="sr-only">${t(dir === "up" ? "ui.stat.increase" : dir === "down" ? "ui.stat.decrease" : "ui.stat.no_change")}</span></span>`;
  }
  const inner = html`<div class="kpi-label">${ic ? icon(ic) : ""}${label}</div>
    <div class="kpi-value">${typeof value === "number" ? format(value) : value}</div>
    ${trend || deltaLabel || foot ? html`<div class="kpi-foot">${trend}${deltaLabel ? html`<span>${deltaLabel}</span>` : ""}${foot}</div>` : ""}`;
  const cls = `card kpi-tile${tone ? ` tone-${tone}` : ""}`;
  return href ? html`<a class="${cls}" href="${href}">${inner}</a>` : html`<div class="${cls}">${inner}</div>`;
}

export function progress({ value = 0, max = 100, label, tone = "", indeterminate = false, showValue = true }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const bar = html`<div class="progress ${tone ? `tone-${tone}` : ""} ${indeterminate ? "indeterminate" : ""}" role="progressbar" aria-label="${label}"
    ${indeterminate ? "" : html`aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${value}" aria-valuetext="${Math.round(pct)}%"`}><span class="bar" style="--value:${pct}%"></span></div>`;
  return showValue && !indeterminate ? html`<div class="progress-row">${bar}<span class="num small">${Math.round(pct)}%</span></div>` : bar;
}
