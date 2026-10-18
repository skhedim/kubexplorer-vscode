// Line charts of the usage over time (the metric tabs of Freelens), drawn as SVG: a measured series as an
// area, a second one as a line, and requests / limits / capacity as dashed reference lines.

import { formatUnit } from "../shared/units";
import type { Chart, ChartSeries, MetricsData } from "../shared/view";
import { codicon, data, esc } from "./dom";

export const CHART_HEIGHT = 180;
const PAD = { left: 64, right: 12, top: 10, bottom: 24 };

interface Scale {
  tMin: number;
  tMax: number;
  yMax: number;
  /** Values of the horizontal grid lines, from 0 to yMax. */
  ticks: number[];
  width: number;
}

const measured = (s: ChartSeries) => s.points ?? [];

function scaleOf(chart: Chart, width: number): Scale {
  const points = chart.series.flatMap(measured);
  const times = points.map(([t]) => t);
  let tMin = times.length ? Math.min(...times) : 0;
  let tMax = times.length ? Math.max(...times) : 1;
  if (tMax - tMin < 60) {
    tMin -= 30;
    tMax += 30;
  }
  const values = [...points.map(([, v]) => v), ...chart.series.map((s) => s.value ?? 0)];
  const max = Math.max(0, ...values) * 1.05;
  const step = niceStep(max / 4, chart.unit !== "cpu");
  const count = Math.max(1, Math.ceil(max / step));
  return { tMin, tMax, yMax: count * step, ticks: Array.from({ length: count + 1 }, (_, i) => i * step), width };
}

/** A round grid step: 1, 2, 2.5 or 5 times a power of ten, in KiB / MiB / GiB for bytes. */
function niceStep(raw: number, binary: boolean): number {
  if (!(raw > 0)) return binary ? 1024 : 0.001;
  const unit = binary ? 1024 ** Math.max(0, Math.floor(Math.log(raw) / Math.log(1024))) : 1;
  const v = raw / unit;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp * unit;
}

function x(s: Scale, t: number): number {
  return PAD.left + ((t - s.tMin) / (s.tMax - s.tMin)) * (s.width - PAD.left - PAD.right);
}

function y(s: Scale, v: number): number {
  const plot = CHART_HEIGHT - PAD.top - PAD.bottom;
  return PAD.top + plot - (Math.min(v, s.yMax) / s.yMax) * plot;
}

function round(n: number): string {
  return n.toFixed(1);
}

/** Path segments of a series, broken where samples are missing (gaps longer than 2.5 steps). */
function segments(points: [number, number][]): [number, number][][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const deltas = sorted.slice(1).map(([t], i) => t - sorted[i][0]);
  const step = deltas.length ? Math.min(...deltas.filter((d) => d > 0)) : 0;
  const out: [number, number][][] = [];
  let current: [number, number][] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && step && p[0] - sorted[i - 1][0] > step * 2.5) {
      out.push(current);
      current = [];
    }
    current.push(p);
  });
  if (current.length) out.push(current);
  return out;
}

function seriesSvg(s: Scale, series: ChartSeries): string {
  const cls = `series-${series.role}`;
  if (series.value !== undefined) {
    const yy = round(y(s, series.value));
    return `<line class="ref ${cls}" x1="${PAD.left}" x2="${s.width - PAD.right}" y1="${yy}" y2="${yy}"><title>${esc(series.label)}</title></line>`;
  }
  return segments(measured(series))
    .map((seg) => {
      if (seg.length === 1) return `<circle class="dot ${cls}" cx="${round(x(s, seg[0][0]))}" cy="${round(y(s, seg[0][1]))}" r="2.5"/>`;
      const line = seg.map(([t, v], i) => `${i ? "L" : "M"}${round(x(s, t))},${round(y(s, v))}`).join("");
      const base = round(y(s, 0));
      const area =
        series.role === "usage"
          ? `<path class="area ${cls}" d="${line}L${round(x(s, seg.at(-1)![0]))},${base}L${round(x(s, seg[0][0]))},${base}Z"/>`
          : "";
      return `${area}<path class="line ${cls}" d="${line}"/>`;
    })
    .join("");
}

function timeLabel(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function axes(s: Scale, chart: Chart): string {
  const grid = s.ticks
    .map((v) => {
      const yy = round(y(s, v));
      return `<line class="grid" x1="${PAD.left}" x2="${s.width - PAD.right}" y1="${yy}" y2="${yy}"/><text class="axis" x="${PAD.left - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle">${esc(formatUnit(chart.unit, v))}</text>`;
    })
    .join("");
  const count = Math.max(2, Math.min(6, Math.floor((s.width - PAD.left - PAD.right) / 90)));
  const times = Array.from({ length: count }, (_, i) => s.tMin + ((s.tMax - s.tMin) * i) / (count - 1));
  const labels = times
    .map((t, i) => {
      const anchor = i === 0 ? "start" : i === count - 1 ? "end" : "middle";
      return `<text class="axis" x="${round(x(s, t))}" y="${CHART_HEIGHT - 6}" text-anchor="${anchor}">${esc(timeLabel(t))}</text>`;
    })
    .join("");
  return grid + labels;
}

function latest(series: ChartSeries): number | undefined {
  return series.value ?? measured(series).at(-1)?.[1];
}

function legend(chart: Chart): string {
  return chart.series
    .map((series) => {
      const v = latest(series);
      return `<span class="legend-item"><span class="swatch series-${series.role}"></span>${esc(series.label)}${v !== undefined ? ` <b>${esc(formatUnit(chart.unit, v))}</b>` : ""}</span>`;
    })
    .join("");
}

function chartSvg(chart: Chart, width: number): string {
  const s = scaleOf(chart, width);
  const hasData = chart.series.some((series) => measured(series).length);
  // Reference lines first: the measured series are drawn over them.
  const ordered = [...chart.series].sort((a, b) => Number(a.value === undefined) - Number(b.value === undefined));
  return `
  <svg class="chart-svg" width="${width}" height="${CHART_HEIGHT}" viewBox="0 0 ${width} ${CHART_HEIGHT}" role="img" aria-label="${esc(chart.title)}"
    ${data({ chart: chart.id, tmin: s.tMin, tmax: s.tMax, left: PAD.left, right: width - PAD.right })}>
    ${axes(s, chart)}
    ${hasData ? ordered.map((series) => seriesSvg(s, series)).join("") : `<text class="axis" x="${width / 2}" y="${CHART_HEIGHT / 2}" text-anchor="middle">No data yet</text>`}
    <line class="cursor" x1="0" x2="0" y1="${PAD.top}" y2="${CHART_HEIGHT - PAD.bottom}" visibility="hidden"/>
  </svg>`;
}

/** The charts section of the drawer; `active` is the selected tab. */
export function renderMetrics(m: MetricsData | undefined, active: string, width: number): string {
  if (!m) return `<div class="metrics loading"><div class="spinner small"></div><span class="dim">Loading metrics…</span></div>`;
  if (m.error && !m.charts.length) return `<div class="metrics"><span class="tone-error">${codicon("error")} ${esc(m.error)}</span></div>`;
  if (!m.charts.length) return m.note ? `<div class="metrics dim">${esc(m.note)}</div>` : "";
  const chart = m.charts.find((c) => c.id === active) ?? m.charts[0];
  const tabs = m.charts
    .map(
      (c) =>
        `<button type="button" role="tab" class="metrics-tab" aria-selected="${c.id === chart.id}" ${data({ action: "chart-tab", chart: c.id })}>${esc(c.title)}</button>`,
    )
    .join("");
  return `
  <div class="metrics">
    <div class="metrics-tabs" role="tablist">${tabs}</div>
    <div class="chart">
      ${chartSvg(chart, width)}
      <div class="chart-tooltip" hidden></div>
    </div>
    <div class="chart-legend">${legend(chart)}</div>
    <div class="metrics-note dim">${esc([m.source && `Source: ${m.source}`, m.note].filter(Boolean).join(" · "))}</div>
  </div>`;
}

/** The value of each series at time t (nearest sample), for the tooltip; undefined outside the data. */
export function valuesAt(chart: Chart, t: number): { time: number; rows: { label: string; role: string; text: string }[] } | undefined {
  const usage = chart.series.find((s) => measured(s).length);
  if (!usage) return undefined;
  const nearest = (points: [number, number][]) =>
    points.reduce<[number, number] | undefined>((best, p) => (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best), undefined);
  const anchor = nearest(measured(usage))!;
  return {
    time: anchor[0],
    rows: chart.series.flatMap((s) => {
      const v = s.value ?? nearest(measured(s))?.[1];
      return v === undefined ? [] : [{ label: s.label, role: s.role, text: formatUnit(chart.unit, v) }];
    }),
  };
}

export function tooltipHtml(values: NonNullable<ReturnType<typeof valuesAt>>): string {
  return `<div class="tooltip-time">${esc(new Date(values.time * 1000).toLocaleTimeString())}</div>${values.rows
    .map((r) => `<div><span class="swatch series-${r.role}"></span>${esc(r.label)}: <b>${esc(r.text)}</b></div>`)
    .join("")}`;
}
