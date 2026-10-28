// Formatting shared by the webview and the extension: chart values, durations.

import type { ChartUnit } from "./view";

function bytes(v: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 0.25 cores -> "250m", 1.5 -> "1.50", 52428800 bytes -> "50.0 MiB". */
export function formatUnit(unit: ChartUnit, v: number): string {
  if (!Number.isFinite(v)) return "";
  switch (unit) {
    case "cpu":
      if (v === 0) return "0";
      return v < 1 ? `${v < 0.001 ? "<1" : Math.round(v * 1000)}m` : v.toFixed(2);
    case "bytes":
      return bytes(v);
    case "bytesPerSecond":
      return `${bytes(v)}/s`;
  }
}

/** Compact duration, like Freelens: 45s, 12m, 3h12m, 4d6h, 41d. */
export function formatAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  let s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d >= 10) return `${d}d`;
  if (d > 0) return h ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
