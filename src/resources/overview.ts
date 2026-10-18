// Data of the Overview page: cluster usage, status donuts per workload kind and Warning events.

import type { KubeObject } from "../kube/types";
import { cpuMillis, memoryBytes } from "../kube/quantity";
import type { ClusterUsage, Donut, DonutSlice, OverviewData, Tone } from "../shared/view";
import { fmtCpu, fmtMemory } from "./metrics";
import { events } from "./cluster";
import { podStatus, podStatusTone } from "./pods";

export const OVERVIEW_RESOURCES = [
  "pods",
  "deployments",
  "daemonsets",
  "statefulsets",
  "replicasets",
  "jobs",
  "cronjobs",
  "events",
  "nodes",
  "nodemetrics",
] as const;
export type OverviewResource = (typeof OVERVIEW_RESOURCES)[number];

type WorkloadResource = Exclude<OverviewResource, "events" | "nodes" | "nodemetrics">;

const TITLES: Record<WorkloadResource, string> = {
  pods: "Pods",
  deployments: "Deployments",
  daemonsets: "Daemon Sets",
  statefulsets: "Stateful Sets",
  replicasets: "Replica Sets",
  jobs: "Jobs",
  cronjobs: "Cron Jobs",
};

const LABELS: Partial<Record<Tone, string>> = {
  ok: "Running",
  warning: "Pending",
  error: "Failed",
  success: "Succeeded",
  terminated: "Terminated",
  info: "Scheduled",
  muted: "Suspended",
};

function slices(counts: Map<Tone, number>): DonutSlice[] {
  const order: Tone[] = ["ok", "warning", "error", "success", "info", "terminated", "muted"];
  return order.filter((t) => counts.get(t)).map((t) => ({ label: LABELS[t] ?? t, value: counts.get(t)!, tone: t }));
}

function classify(resource: WorkloadResource, o: KubeObject): Tone {
  switch (resource) {
    case "pods": {
      const t = podStatusTone(podStatus(o));
      return t === "info" ? "warning" : t;
    }
    case "deployments":
    case "statefulsets":
    case "replicasets": {
      if ((o.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "ReplicaFailure" && c.status === "True"))
        return "error";
      return (o.status?.readyReplicas ?? 0) >= (o.spec?.replicas ?? 0) ? "ok" : "warning";
    }
    case "daemonsets":
      return (o.status?.numberReady ?? 0) >= (o.status?.desiredNumberScheduled ?? 0) ? "ok" : "warning";
    case "jobs": {
      const conds: { type: string; status: string }[] = o.status?.conditions ?? [];
      if (conds.some((c) => c.type === "Failed" && c.status === "True")) return "error";
      if (conds.some((c) => c.type === "Complete" && c.status === "True")) return "success";
      return o.status?.active ? "ok" : "warning";
    }
    case "cronjobs":
      return o.spec?.suspend ? "muted" : "info";
  }
}

export interface OverviewInput {
  lists: Partial<Record<OverviewResource, KubeObject[]>>;
  errors: Partial<Record<OverviewResource, string>>;
}

export function buildOverview({ lists, errors }: OverviewInput): OverviewData {
  const donuts: Donut[] = (Object.keys(TITLES) as WorkloadResource[]).map((resource) => {
    const counts = new Map<Tone, number>();
    for (const o of lists[resource] ?? []) {
      const tone = classify(resource, o);
      counts.set(tone, (counts.get(tone) ?? 0) + 1);
    }
    return { title: TITLES[resource], resource, slices: slices(counts), error: errors[resource] };
  });
  const warnings = (lists.events ?? [])
    .filter((e) => e.type === "Warning")
    .map((e) => events.toRow(e))
    .sort((a, b) => Number(a.sort.lastSeen) - Number(b.sort.lastSeen))
    .slice(0, 100);
  return {
    usage: clusterUsage(lists, errors),
    donuts,
    events: { columns: events.columns.filter((c) => c.id !== "type" && c.id !== "warning"), rows: warnings },
  };
}

/** Requests of a pod (finished pods do not reserve anything anymore). */
function podRequests(pod: KubeObject): { cpu: number; memory: number } {
  if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") return { cpu: 0, memory: 0 };
  let cpu = 0;
  let memory = 0;
  for (const c of pod.spec?.containers ?? []) {
    cpu += cpuMillis(c.resources?.requests?.cpu) || 0;
    memory += memoryBytes(c.resources?.requests?.memory) || 0;
  }
  return { cpu, memory };
}

/** Cluster usage (the Freelens "Cluster" page): metrics-server usage and requests, relative to the allocatable capacity. */
export function clusterUsage(lists: OverviewInput["lists"], errors: OverviewInput["errors"]): ClusterUsage | undefined {
  const nodes = lists.nodes;
  if (!nodes?.length) return undefined;
  const alloc = nodes.reduce(
    (a, n) => ({
      cpu: a.cpu + (cpuMillis(n.status?.allocatable?.cpu) || 0),
      memory: a.memory + (memoryBytes(n.status?.allocatable?.memory) || 0),
      pods: a.pods + (Number(n.status?.allocatable?.pods) || 0),
    }),
    { cpu: 0, memory: 0, pods: 0 },
  );
  // Only scheduled pods reserve node resources (a Pending pod reserves nothing).
  const pods = (lists.pods ?? []).filter((p) => p.spec?.nodeName && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
  const req = pods.map(podRequests).reduce((a, r) => ({ cpu: a.cpu + r.cpu, memory: a.memory + r.memory }), { cpu: 0, memory: 0 });
  const metrics = lists.nodemetrics;
  const usage = metrics?.length
    ? metrics.reduce((a, m) => ({ cpu: a.cpu + (cpuMillis(m.usage?.cpu) || 0), memory: a.memory + (memoryBytes(m.usage?.memory) || 0) }), {
        cpu: 0,
        memory: 0,
      })
    : undefined;
  return {
    cpu:
      usage && alloc.cpu
        ? {
            usage: usage.cpu / alloc.cpu,
            requests: req.cpu / alloc.cpu,
            text: `${fmtCpu(usage.cpu)} used · ${fmtCpu(req.cpu)} requested · ${fmtCpu(alloc.cpu)} allocatable`,
          }
        : undefined,
    memory:
      usage && alloc.memory
        ? {
            usage: usage.memory / alloc.memory,
            requests: req.memory / alloc.memory,
            text: `${fmtMemory(usage.memory)} used · ${fmtMemory(req.memory)} requested · ${fmtMemory(alloc.memory)} allocatable`,
          }
        : undefined,
    pods: { count: pods.length, capacity: alloc.pods },
    error: usage ? undefined : errors.nodemetrics ? "metrics-server is unavailable: install it to see the cluster usage" : undefined,
  };
}
