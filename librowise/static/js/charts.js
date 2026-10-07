// Librowise chart toolkit — dependency-free, theme-aware SVG charts.
//
// Every chart renders into a container element and:
//   * sizes itself to the container (re-renders on resize, so text never shrinks on phones),
//   * takes all colour from CSS custom properties (--viz-1…8, --viz-seq, --viz-compare), so every theme works,
//   * is accessible: role="img" + an aria-label summary, keyboard navigation (arrow keys) with announced
//     values, hover/focus tooltips, and a "View data table" toggle exposing the underlying numbers.
//
// API (all return the container):
//   lineChart(el, { labels, series: [{ name, values, compare?, color? }], format, height, area, summary })
//   barChart(el, { labels, series, stacked?, format, height, summary })
//   hBarChart(el, { items: [{ label, value, href?, note? }], format, summary, max })
//   donutChart(el, { items: [{ label, value }], format, center, summary, maxSlices })
//   heatmap(el, { rows, cols, values: number[rows][cols], format, summary })
//   sparkline(values, { width, height, label }) -> SafeHTML <svg>
//   kpiTile({ label, value, previous, format, spark, href, invert, note }) -> SafeHTML tile

import { esc, html, num, raw } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

const NS = "http://www.w3.org/2000/svg";
let uid = 0;
const tr = (key, fallback, params = {}) => t(`charts.${key}`, params, fallback);
const color = (i, s) => s?.color || (s?.compare ? "var(--viz-compare)" : `var(--viz-${(i % 8) + 1})`);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ------------------------------------------------------------------ scales

function niceStep(range, ticks) {
  const raw0 = range / Math.max(ticks, 1);
  const mag = 10 ** Math.floor(Math.log10(raw0 || 1));
  const norm = raw0 / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}
function niceScale(max, ticks = 4, integer = false) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const step = integer ? Math.max(1, Math.ceil(niceStep(max, ticks))) : niceStep(max, ticks);
  const top = Math.ceil(max / step) * step;
  const out = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(+v.toFixed(10));
  return { max: top, ticks: out };
}
const compact = (v) => {
  try { return new Intl.NumberFormat(document.documentElement.lang || undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v); }
  catch { return String(v); }
};

// ------------------------------------------------------------------ frame: figure, tooltip, data table, resize

function dataTable(headers, rows, caption) {
  return html`<div class="table-wrap"><table class="table viz-data">
    <caption class="sr-only">${caption}</caption>
    <thead><tr>${headers.map((h, i) => html`<th scope="col" class="${i ? "num" : ""}">${h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (i ? html`<td class="num">${c}</td>` : html`<th scope="row">${c}</th>`))}</tr>`)}</tbody>
  </table></div>`;
}

function frame(el, { summary, table, legend }) {
  el.classList.add("viz");
  const showTable = el.dataset.vizTable === "1";
  if (!el.dataset.vizId) el.dataset.vizId = `viz${++uid}`;
  const id = el.dataset.vizId;
  el.innerHTML = html`${legend || ""}<div class="viz-canvas" ${showTable ? raw("hidden") : ""}><div class="viz-tip" role="presentation" hidden></div></div>
    <span class="sr-only" aria-live="polite" data-viz-live></span>
    <div class="viz-tablebox" id="${id}-table" ${showTable ? "" : raw("hidden")}>${table}</div>
    <div class="viz-tools"><button type="button" class="btn ghost sm" data-viz-toggle aria-controls="${id}-table" aria-expanded="${showTable}">
      ${showTable ? tr("view_chart", "View chart") : tr("view_table", "View data table")}</button></div>`;
  el.querySelector("[data-viz-toggle]").addEventListener("click", () => {
    el.dataset.vizTable = showTable ? "0" : "1";
    el._vizRender?.();
    el.querySelector("[data-viz-toggle]")?.focus();
  });
  const canvas = el.querySelector(".viz-canvas");
  canvas.dataset.summary = summary || "";
  return { canvas, tip: el.querySelector(".viz-tip"), live: el.querySelector("[data-viz-live]"), showTable };
}

/** Re-render when the container width changes (debounced to animation frames). */
function responsive(el, render) {
  el._vizRender = render;
  render();
  if (el._vizObserver || typeof ResizeObserver === "undefined") return;
  let lastW = el.clientWidth, frameReq = 0;
  el._vizObserver = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (Math.abs(w - lastW) < 4) return;
    lastW = w;
    cancelAnimationFrame(frameReq);
    frameReq = requestAnimationFrame(() => el._vizRender?.());
  });
  el._vizObserver.observe(el);
}

function showTip(tip, canvas, x, y, content) {
  tip.innerHTML = content;
  tip.hidden = false;
  const cw = canvas.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 14;
  if (left + tw > cw) left = x - tw - 14;
  tip.style.left = `${clamp(left, 0, Math.max(0, cw - tw))}px`;
  tip.style.top = `${clamp(y - th / 2, 0, Math.max(0, canvas.clientHeight - th))}px`;
}

function svgEl(width, height, label) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("tabindex", "0");
  svg.classList.add("viz-svg");
  return svg;
}

const legendHtml = (series) => series.length < 2 ? "" : html`<ul class="viz-legend" aria-hidden="true">${series.map((s, i) =>
  html`<li><span class="viz-key ${s.compare ? "dashed" : ""}" style="--c:${color(i, s)}"></span>${s.name}</li>`)}</ul>`;

const tipRows = (rows) => rows.map(([name, value, c, dashed]) =>
  `<div class="viz-tip-row"><span class="viz-key ${dashed ? "dashed" : ""}" style="--c:${c}"></span><span>${esc(name)}</span><strong>${esc(value)}</strong></div>`).join("");

// ------------------------------------------------------------------ index-based charts (line & bar)

/** Shared keyboard/pointer handling for charts whose x axis is an ordered index. */
function indexInteraction(svg, { count, xAt, onIndex, onLeave }) {
  let current = -1;
  const set = (i, viaKeyboard) => { current = clamp(i, 0, count - 1); onIndex(current, viaKeyboard); };
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * svg.viewBox.baseVal.width;
    let best = 0, dist = Infinity;
    for (let i = 0; i < count; i++) { const d = Math.abs(xAt(i) - x); if (d < dist) { dist = d; best = i; } }
    set(best, false);
  });
  svg.addEventListener("pointerleave", () => { if (document.activeElement !== svg) onLeave(); });
  svg.addEventListener("focus", () => set(current < 0 ? count - 1 : current, true));
  svg.addEventListener("blur", onLeave);
  svg.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (step) { set((current < 0 ? count - 1 : current) + step, true); e.preventDefault(); }
    else if (e.key === "Home") { set(0, true); e.preventDefault(); }
    else if (e.key === "End") { set(count - 1, true); e.preventDefault(); }
    else if (e.key === "Escape") { onLeave(); }
  });
}

function xLabels(labels, xAt, width, y) {
  const maxLabels = Math.max(2, Math.floor(width / 78));
  const every = Math.ceil(labels.length / maxLabels);
  return labels.map((l, i) => (i % every === 0 || (i === labels.length - 1 && (labels.length - 1) % every > every / 2))
    ? `<text class="viz-axis" x="${xAt(i)}" y="${y}" text-anchor="middle">${esc(l)}</text>` : "").join("");
}

function yAxis(scale, format, left, right, yAt) {
  return scale.ticks.map((v) => `<line class="viz-grid ${v === 0 ? "base" : ""}" x1="${left}" x2="${right}" y1="${yAt(v)}" y2="${yAt(v)}"/>
    <text class="viz-axis" x="${left - 8}" y="${yAt(v) + 4}" text-anchor="end">${esc(format === num ? compact(v) : format(v))}</text>`).join("");
}

function seriesTable(labels, series, format, caption) {
  return dataTable([tr("period", "Period"), ...series.map((s) => s.name)],
    labels.map((l, i) => [l, ...series.map((s) => (s.values[i] === null || s.values[i] === undefined ? "—" : format(s.values[i])))]), caption);
}

export function lineChart(el, opts) {
  const { labels = [], series = [], format = num, height = 240, area = true, summary = "" } = opts;
  const caption = summary || tr("line_summary", "Line chart");
  responsive(el, () => {
    const { canvas, tip, live, showTable } = frame(el, { summary: caption, table: seriesTable(labels, series, format, caption), legend: legendHtml(series) });
    if (showTable) return;
    if (!labels.length) { canvas.innerHTML = html`<div class="empty small">${tr("no_data", "No data for this period")}</div>`; return; }
    const W = Math.max(280, canvas.clientWidth || el.clientWidth || 600);
    const allMax = Math.max(0, ...series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined)));
    const scale = niceScale(allMax, 4, format === num);
    const left = 10 + Math.max(...scale.ticks.map((v) => (format === num ? compact(v) : String(format(v))).length)) * 7, right = W - 12, top = 12, bottom = height - 26;
    const n = labels.length;
    const xAt = (i) => (n === 1 ? (left + right) / 2 : left + (i * (right - left)) / (n - 1));
    const yAt = (v) => bottom - (v / scale.max) * (bottom - top);
    const svg = svgEl(W, height, caption);
    const paths = series.map((s, si) => {
      const pts = s.values.map((v, i) => (v === null || v === undefined ? null : [xAt(i), yAt(v)]));
      let d = "", pen = false;
      pts.forEach((p) => { if (!p) { pen = false; return; } d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`; pen = true; });
      const firstReal = pts.findIndex(Boolean), lastReal = pts.length - 1 - [...pts].reverse().findIndex(Boolean);
      const fill = area && !s.compare && si === series.findIndex((x) => !x.compare) && firstReal >= 0
        ? `<path class="viz-area" style="--c:${color(si, s)}" d="${d}L${xAt(lastReal)},${bottom}L${xAt(firstReal)},${bottom}Z"/>` : "";
      const single = n === 1 && pts[0] ? `<circle class="viz-dot" style="--c:${color(si, s)}" cx="${pts[0][0]}" cy="${pts[0][1]}" r="4"/>` : "";
      return `${fill}<path class="viz-line ${s.compare ? "compare" : ""}" style="--c:${color(si, s)}" d="${d}"/>${single}`;
    }).join("");
    svg.innerHTML = `${yAxis(scale, format, left, right, yAt)}${paths}${xLabels(labels, xAt, W, height - 6)}
      <g class="viz-cursor" style="display:none"><line x1="0" x2="0" y1="${top}" y2="${bottom}"/>${series.map((s, si) => `<circle r="4.5" style="--c:${color(si, s)}"/>`).join("")}</g>`;
    canvas.append(svg);
    const cursor = svg.querySelector(".viz-cursor");
    indexInteraction(svg, {
      count: n, xAt,
      onIndex(i, kb) {
        cursor.style.display = "";
        cursor.querySelector("line").setAttribute("x1", xAt(i));
        cursor.querySelector("line").setAttribute("x2", xAt(i));
        cursor.querySelectorAll("circle").forEach((c, si) => {
          const v = series[si].values[i];
          c.style.display = v === null || v === undefined ? "none" : "";
          c.setAttribute("cx", xAt(i)); c.setAttribute("cy", yAt(v || 0));
        });
        const rows = series.map((s, si) => [s.name, s.values[i] === null || s.values[i] === undefined ? "—" : format(s.values[i]), color(si, s), s.compare]);
        const ratio = canvas.clientWidth / W;
        showTip(tip, canvas, xAt(i) * ratio, (top + bottom) / 2 * ratio, `<div class="viz-tip-title">${esc(labels[i])}</div>${tipRows(rows)}`);
        if (kb) live.textContent = `${labels[i]}: ${rows.map((r) => `${r[0]} ${r[1]}`).join(", ")}`;
      },
      onLeave() { cursor.style.display = "none"; tip.hidden = true; },
    });
  });
  return el;
}

function barTop(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function barChart(el, opts) {
  const { labels = [], series = [], stacked = false, format = num, height = 240, summary = "" } = opts;
  const caption = summary || tr("bar_summary", "Bar chart");
  responsive(el, () => {
    const { canvas, tip, live, showTable } = frame(el, { summary: caption, table: seriesTable(labels, series, format, caption), legend: legendHtml(series) });
    if (showTable) return;
    if (!labels.length) { canvas.innerHTML = html`<div class="empty small">${tr("no_data", "No data for this period")}</div>`; return; }
    const W = Math.max(280, canvas.clientWidth || el.clientWidth || 600);
    const n = labels.length;
    const totals = labels.map((_, i) => (stacked ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(0, ...series.map((s) => s.values[i] || 0))));
    const scale = niceScale(Math.max(0, ...totals), 4, format === num);
    const left = 10 + Math.max(...scale.ticks.map((v) => (format === num ? compact(v) : String(format(v))).length)) * 7, right = W - 8, top = 12, bottom = height - 26;
    const band = (right - left) / n;
    const xAt = (i) => left + band * (i + 0.5);
    const yAt = (v) => bottom - (v / scale.max) * (bottom - top);
    const gap = Math.min(band * 0.25, 10);
    const groupW = band - gap;
    const svg = svgEl(W, height, caption);
    let bars = "";
    labels.forEach((_, i) => {
      if (stacked) {
        let acc = 0;
        const top0 = series.findLastIndex((s) => (s.values[i] || 0) > 0);
        series.forEach((s, si) => {
          const v = s.values[i] || 0;
          if (!v) return;
          const y1 = yAt(acc + v), y0 = yAt(acc);
          const h = Math.max(0, y0 - y1 - (acc > 0 ? 2 : 0));
          bars += si === top0 ? `<path class="viz-bar" style="--c:${color(si, s)}" d="${barTop(left + band * i + gap / 2, y1, groupW, h, 4)}"/>`
            : `<rect class="viz-bar" style="--c:${color(si, s)}" x="${left + band * i + gap / 2}" y="${y1}" width="${groupW}" height="${h}"/>`;
          acc += v;
        });
      } else {
        const bw = Math.max(1, (groupW - (series.length - 1) * 2) / series.length);
        series.forEach((s, si) => {
          const v = s.values[i] || 0;
          bars += `<path class="viz-bar ${s.compare ? "compare" : ""}" style="--c:${color(si, s)}" d="${barTop(left + band * i + gap / 2 + si * (bw + 2), yAt(v), bw, bottom - yAt(v), 4)}"/>`;
        });
      }
    });
    svg.innerHTML = `${yAxis(scale, format, left, right, yAt)}<rect class="viz-band" style="display:none" y="${top}" height="${bottom - top}" width="${band}"/>${bars}${xLabels(labels, xAt, W, height - 6)}`;
    canvas.append(svg);
    const bandEl = svg.querySelector(".viz-band");
    indexInteraction(svg, {
      count: n, xAt,
      onIndex(i, kb) {
        bandEl.style.display = "";
        bandEl.setAttribute("x", left + band * i);
        const rows = series.map((s, si) => [s.name, format(s.values[i] || 0), color(si, s), s.compare]);
        if (stacked && series.length > 1) rows.push([tr("total", "Total"), format(totals[i]), "transparent", false]);
        const ratio = canvas.clientWidth / W;
        showTip(tip, canvas, xAt(i) * ratio, yAt(totals[i]) * ratio, `<div class="viz-tip-title">${esc(labels[i])}</div>${tipRows(rows)}`);
        if (kb) live.textContent = `${labels[i]}: ${rows.map((r) => `${r[0]} ${r[1]}`).join(", ")}`;
      },
      onLeave() { bandEl.style.display = "none"; tip.hidden = true; },
    });
  });
  return el;
}

// ------------------------------------------------------------------ horizontal bars (HTML: values always visible)

export function hBarChart(el, opts) {
  const { items = [], format = num, summary = "", max, valueLabel = tr("value", "Value") } = opts;
  const caption = summary || tr("hbar_summary", "Ranked bars");
  responsive(el, () => {
    const { canvas, showTable } = frame(el, { summary: caption, table: dataTable([tr("item", "Item"), valueLabel], items.map((i) => [i.label, format(i.value)]), caption) });
    if (showTable) return;
    if (!items.length) { canvas.innerHTML = html`<div class="empty small">${tr("no_data", "No data for this period")}</div>`; return; }
    const top = max ?? Math.max(1, ...items.map((i) => i.value));
    canvas.innerHTML = html`<ol class="viz-hbars" aria-label="${caption}">${items.map((i) => html`<li>
      <span class="lbl" title="${i.label}">${i.href ? html`<a href="${i.href}">${i.label}</a>` : i.label}${i.note ? html`<span class="tiny muted"> · ${i.note}</span>` : ""}</span>
      <span class="track" aria-hidden="true"><span class="fill" style="width:${clamp((100 * i.value) / top, 0, 100)}%"></span></span>
      <span class="val">${format(i.value)}</span></li>`)}</ol>`;
  });
  return el;
}

// ------------------------------------------------------------------ donut

export function donutChart(el, opts) {
  const { format = num, summary = "", center, maxSlices = 6 } = opts;
  let items = [...(opts.items || [])].filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  if (items.length > maxSlices) {
    const rest = items.slice(maxSlices - 1).reduce((a, i) => a + i.value, 0);
    items = [...items.slice(0, maxSlices - 1), { label: tr("other", "Other"), value: rest, other: true }];
  }
  const total = items.reduce((a, i) => a + i.value, 0);
  const pct = (v) => `${total ? Math.round((100 * v) / total) : 0}%`;
  const caption = summary || tr("donut_summary", "Share of total");
  responsive(el, () => {
    const { canvas, tip, live, showTable } = frame(el, { summary: caption,
      table: dataTable([tr("item", "Item"), tr("value", "Value"), tr("share", "Share")], items.map((i) => [i.label, format(i.value), pct(i.value)]), caption) });
    if (showTable) return;
    if (!total) { canvas.innerHTML = html`<div class="empty small">${tr("no_data", "No data for this period")}</div>`; return; }
    const S = 180, R = 84, r = 56, cx = S / 2, cy = S / 2;
    const svg = svgEl(S, S, `${caption}: ${items.map((i) => `${i.label} ${pct(i.value)}`).join(", ")}`);
    let a0 = -Math.PI / 2, arcs = "";
    items.forEach((it, i) => {
      const a1 = a0 + (2 * Math.PI * it.value) / total;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a, rad) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`;
      const d = items.length === 1
        ? `M${cx - R},${cy}A${R},${R} 0 1 1 ${cx + R},${cy}A${R},${R} 0 1 1 ${cx - R},${cy}M${cx - r},${cy}A${r},${r} 0 1 0 ${cx + r},${cy}A${r},${r} 0 1 0 ${cx - r},${cy}Z`
        : `M${p(a0, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r)}A${r},${r} 0 ${large} 0 ${p(a0, r)}Z`;
      arcs += `<path class="viz-slice" data-i="${i}" style="--c:${it.other ? "var(--viz-compare)" : color(i)}" d="${d}" fill-rule="evenodd"/>`;
      a0 = a1;
    });
    svg.innerHTML = `${arcs}<text class="viz-center" x="${cx}" y="${cy - 2}" text-anchor="middle">${esc(center?.value ?? format(total))}</text>
      <text class="viz-axis" x="${cx}" y="${cy + 16}" text-anchor="middle">${esc(center?.label ?? tr("total", "Total"))}</text>`;
    const wrap = document.createElement("div");
    wrap.className = "viz-donut";
    wrap.append(svg);
    wrap.insertAdjacentHTML("beforeend", html`<ul class="viz-donut-legend">${items.map((it, i) => html`<li data-i="${i}">
      <span class="viz-key" style="--c:${it.other ? "var(--viz-compare)" : color(i)}"></span><span class="grow">${it.label}</span>
      <strong>${format(it.value)}</strong><span class="muted small">${pct(it.value)}</span></li>`)}</ul>`);
    canvas.append(wrap);
    let cur = -1;
    const focusSlice = (i, kb, evt) => {
      cur = (i + items.length) % items.length;
      svg.querySelectorAll(".viz-slice").forEach((s) => s.classList.toggle("dim", +s.dataset.i !== cur));
      wrap.querySelectorAll("li").forEach((li) => li.classList.toggle("active", +li.dataset.i === cur));
      const it = items[cur];
      const rect = canvas.getBoundingClientRect();
      const x = evt ? evt.clientX - rect.left : (svg.getBoundingClientRect().right - rect.left);
      const y = evt ? evt.clientY - rect.top : S / 2;
      showTip(tip, canvas, x, y, `<div class="viz-tip-title">${esc(it.label)}</div>${tipRows([[format(it.value), pct(it.value), it.other ? "var(--viz-compare)" : color(cur), false]])}`);
      if (kb) live.textContent = `${it.label}: ${format(it.value)}, ${pct(it.value)}`;
    };
    const clear = () => { cur = -1; tip.hidden = true; svg.querySelectorAll(".dim").forEach((s) => s.classList.remove("dim")); wrap.querySelectorAll(".active").forEach((s) => s.classList.remove("active")); };
    svg.addEventListener("pointermove", (e) => { const s = e.target.closest(".viz-slice"); if (s) focusSlice(+s.dataset.i, false, e); else clear(); });
    svg.addEventListener("pointerleave", clear);
    svg.addEventListener("focus", () => focusSlice(cur < 0 ? 0 : cur, true));
    svg.addEventListener("blur", clear);
    svg.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) { focusSlice(cur + step, true); e.preventDefault(); }
    });
  });
  return el;
}

// ------------------------------------------------------------------ heatmap

export function heatmap(el, opts) {
  const { rows = [], cols = [], values = [], format = num, summary = "", rowHeader = "", colFormat = (c) => c } = opts;
  const max = Math.max(0, ...values.flat());
  const caption = summary || tr("heatmap_summary", "Heatmap");
  responsive(el, () => {
    const { canvas, tip, live, showTable } = frame(el, { summary: caption,
      table: dataTable([rowHeader, ...cols.map(colFormat)], rows.map((r, ri) => [r, ...cols.map((_, ci) => format(values[ri]?.[ci] || 0))]), caption) });
    if (showTable) return;
    const W = Math.max(300, canvas.clientWidth || el.clientWidth || 600);
    const left = 10 + Math.max(...rows.map((r) => String(r).length)) * 7, top = 4, right = W - 4;
    const cw = (right - left) / Math.max(cols.length, 1);
    const ch = clamp(cw * 0.9, 16, 30);
    const height = top + rows.length * ch + 22;
    const svg = svgEl(W, height, caption);
    let cells = "";
    rows.forEach((r, ri) => {
      cells += `<text class="viz-axis" x="${left - 8}" y="${top + ri * ch + ch / 2 + 4}" text-anchor="end">${esc(r)}</text>`;
      cols.forEach((_, ci) => {
        const v = values[ri]?.[ci] || 0;
        const k = max ? v / max : 0;
        cells += `<rect class="viz-cell" data-r="${ri}" data-c="${ci}" x="${left + ci * cw + 1}" y="${top + ri * ch + 1}" width="${Math.max(1, cw - 2)}" height="${ch - 2}" rx="3"
          style="--k:${v ? Math.round(12 + 88 * k) : 0}%"/>`;
      });
    });
    const every = Math.ceil(cols.length / Math.max(2, Math.floor(W / 46)));
    const xl = cols.map((c, ci) => (ci % every === 0 ? `<text class="viz-axis" x="${left + ci * cw + cw / 2}" y="${height - 6}" text-anchor="middle">${esc(colFormat(c))}</text>` : "")).join("");
    svg.innerHTML = `${cells}${xl}<rect class="viz-cell-focus" style="display:none" rx="4" width="${cw}" height="${ch}"/>`;
    canvas.append(svg);
    canvas.insertAdjacentHTML("beforeend", html`<div class="viz-scale" aria-hidden="true"><span>${format(0)}</span><span class="ramp"></span><span>${format(max)}</span></div>`);
    const ring = svg.querySelector(".viz-cell-focus");
    let cur = [-1, -1];
    const pick = (ri, ci, kb) => {
      cur = [clamp(ri, 0, rows.length - 1), clamp(ci, 0, cols.length - 1)];
      const [r, c] = cur;
      ring.style.display = ""; ring.setAttribute("x", left + c * cw); ring.setAttribute("y", top + r * ch);
      const v = values[r]?.[c] || 0;
      const ratio = canvas.clientWidth / W;
      showTip(tip, canvas, (left + c * cw + cw) * ratio, (top + r * ch + ch / 2) * ratio,
        `<div class="viz-tip-title">${esc(rows[r])} · ${esc(colFormat(cols[c]))}</div><div class="viz-tip-row"><strong>${esc(format(v))}</strong></div>`);
      if (kb) live.textContent = `${rows[r]} ${colFormat(cols[c])}: ${format(v)}`;
    };
    const clear = () => { ring.style.display = "none"; tip.hidden = true; };
    svg.addEventListener("pointermove", (e) => { const c = e.target.closest(".viz-cell"); if (c) pick(+c.dataset.r, +c.dataset.c, false); });
    svg.addEventListener("pointerleave", () => { if (document.activeElement !== svg) clear(); });
    svg.addEventListener("focus", () => pick(Math.max(cur[0], 0), Math.max(cur[1], 0), true));
    svg.addEventListener("blur", clear);
    svg.addEventListener("keydown", (e) => {
      const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      if (d) { pick(cur[0] + d[0], cur[1] + d[1], true); e.preventDefault(); }
    });
  });
  return el;
}

// ------------------------------------------------------------------ sparkline & KPI tile (string renderers)

export function sparkline(values, { width = 120, height = 34, label = "" } = {}) {
  const v = (values || []).map((x) => Number(x) || 0);
  if (v.length < 2) return raw("");
  const max = Math.max(...v), min = Math.min(0, ...v), span = max - min || 1;
  const x = (i) => 2 + (i * (width - 4)) / (v.length - 1);
  const y = (val) => height - 3 - ((val - min) / span) * (height - 6);
  const d = v.map((val, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join("");
  return raw(`<svg class="viz-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ${label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true"`}>
    <path class="area" d="${d}L${x(v.length - 1)},${height}L${x(0)},${height}Z"/><path class="line" d="${d}"/>
    <circle cx="${x(v.length - 1)}" cy="${y(v.at(-1))}" r="2.6"/></svg>`);
}

/** Percentage change, or null when there is no meaningful baseline. */
export function delta(current, previous) {
  if (previous === null || previous === undefined) return null;
  if (!previous) return current ? null : 0;
  return (current - previous) / Math.abs(previous);
}

export function kpiTile({ label, value, previous, format = num, spark, href, invert = false, note = "", alert = false, compareLabel }) {
  const d = delta(value, previous);
  let deltaHtml = "";
  if (d !== null) {
    const good = d === 0 ? null : (d > 0) !== invert;
    const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "■";
    const abs = Math.abs(d * 100);
    const pctTxt = abs > 999 ? ">999%" : `${abs < 10 && d !== 0 ? abs.toFixed(1) : Math.round(abs)}%`;
    const word = d > 0 ? tr("up", "up") : d < 0 ? tr("down", "down") : tr("flat", "no change");
    deltaHtml = html`<span class="kpi-delta ${good === null ? "flat" : good ? "good" : "bad"}">
      <span aria-hidden="true">${arrow}</span> ${d === 0 ? tr("flat", "no change") : pctTxt}<span class="sr-only"> ${d === 0 ? "" : word}</span>
      <span class="muted">${compareLabel || tr("vs_previous", "vs previous period")}</span></span>`;
  } else if (previous !== undefined && previous !== null) {
    deltaHtml = html`<span class="kpi-delta flat"><span class="muted">${tr("new", "new this period")}</span></span>`;
  }
  const inner = html`<span class="label">${label}</span>
    <span class="kpi-main"><span class="value">${format(value)}</span>${spark ? sparkline(spark) : ""}</span>
    ${deltaHtml}${note ? html`<span class="delta">${note}</span>` : ""}`;
  return href ? html`<a class="card stat kpi ${alert ? "alert" : ""}" href="${href}">${inner}</a>` : html`<div class="card stat kpi ${alert ? "alert" : ""}">${inner}</div>`;
}
