// Formatting of chart values (the webview and the extension share it).

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
