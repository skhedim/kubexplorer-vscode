// metrics-server metrics (pods.metrics.k8s.io, nodes.metrics.k8s.io): related lists, not shown in the menu.

import { cpuMillis, formatCpu, formatMemory, memoryBytes } from "../kube/quantity";
import type { KubeObject } from "../kube/types";
import type { Cell, Tone } from "../shared/view";
import { defineResource, relatedOf, type RowContext } from "./descriptor";

/**
 * metrics-server measures every 15 s by default (--metric-resolution): reading the metrics more often only
 * returns the same values again.
 */
const METRICS_RESOLUTION_MS = 15_000;

export const podmetrics = defineResource({
  id: "podmetrics",
  kubectlName: "pods.metrics.k8s.io",
  title: "Pod Metrics",
  minPollIntervalMs: METRICS_RESOLUTION_MS,
  kindName: "PodMetrics",
  namespaced: true,
  commonActions: [],
});
export const nodemetrics = defineResource({
  id: "nodemetrics",
  kubectlName: "nodes.metrics.k8s.io",
  title: "Node Metrics",
  minPollIntervalMs: METRICS_RESOLUTION_MS,
  kindName: "NodeMetrics",
  namespaced: false,
  commonActions: [],
});

export interface Usage {
  cpu: number; // millicœurs
  memory: number; // bytes
}

export function podUsage(rc: RowContext | undefined, pod: KubeObject): (Usage & { containers: Record<string, Usage> }) | undefined {
  const m = relatedOf(rc, "podmetrics", pod);
  if (!m) return undefined;
  const containers: Record<string, Usage> = {};
  for (const c of m.containers ?? []) containers[c.name] = { cpu: cpuMillis(c.usage?.cpu), memory: memoryBytes(c.usage?.memory) };
  const all = Object.values(containers);
  return { cpu: all.reduce((n, c) => n + c.cpu, 0), memory: all.reduce((n, c) => n + c.memory, 0), containers };
}

export function nodeUsage(rc: RowContext | undefined, node: KubeObject): Usage | undefined {
  const m = relatedOf(rc, "nodemetrics", node);
  return m ? { cpu: cpuMillis(m.usage?.cpu), memory: memoryBytes(m.usage?.memory) } : undefined;
}

function ratioTone(r: number): Tone {
  return r >= 0.9 ? "error" : r >= 0.75 ? "warning" : "ok";
}

/** Usage / allocatable gauge, labelled "42%". */
export function usageBar(used: number | undefined, total: number, format: (v: number) => string, marker?: number): Cell {
  if (used === undefined || !Number.isFinite(used) || !total) return "";
  const r = used / total;
  return { bar: Math.min(1, r), text: `${Math.round(r * 100)}%`, tone: ratioTone(r), marker, title: `${format(used)} / ${format(total)}` };
}

export const fmtCpu = formatCpu;
export const fmtMemory = formatMemory;
