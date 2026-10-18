// The Karpenter dashboard (the Freelens Karpenter extension): a card per NodePool with its limits and
// requests, NodeClaims by status, nodes by capacity type, zone and instance type, and scaling decisions.

import { cpuMillis, memoryBytes } from "../kube/quantity";
import type { KubeObject } from "../kube/types";
import type { DonutSlice, OverviewCard } from "../shared/view";
import {
  CAPACITY_TYPE_LABEL,
  CLAIM_TONE,
  type ClaimState,
  claimState,
  condition,
  INSTANCE_TYPE_LABEL,
  limitBar,
  nodeClassLink,
  nodeclaims,
  NODEPOOL_LABEL,
  nodepools,
  ZONE_LABEL,
} from "./karpenter";
import { text } from "./format";
import { fmtCpu, fmtMemory, usageBar } from "./metrics";
import { eventColumns, eventRows, type OverviewPage } from "./overview";

function sumRequests(pods: KubeObject[]): { cpu: number; memory: number } {
  let cpu = 0;
  let memory = 0;
  for (const p of pods) {
    if (p.status?.phase === "Succeeded" || p.status?.phase === "Failed") continue;
    for (const c of p.spec?.containers ?? []) {
      cpu += cpuMillis(c.resources?.requests?.cpu) || 0;
      memory += memoryBytes(c.resources?.requests?.memory) || 0;
    }
  }
  return { cpu, memory };
}

/** A card per NodePool: provisioned capacity against its limits, and how much of it the pods request. */
function poolCard(pool: KubeObject, nodes: KubeObject[], pods: KubeObject[], claims: KubeObject[]): OverviewCard {
  const names = new Set(nodes.map((n) => n.metadata.name));
  const poolPods = pods.filter((p) => names.has(p.spec?.nodeName));
  const requests = sumRequests(poolPods);
  const allocatable = nodes.reduce(
    (a, n) => ({
      cpu: a.cpu + (cpuMillis(n.status?.allocatable?.cpu) || 0),
      memory: a.memory + (memoryBytes(n.status?.allocatable?.memory) || 0),
    }),
    { cpu: 0, memory: 0 },
  );
  const failed = claims.filter((c) => claimState(c) === "Failed").length;
  const launching = claims.filter((c) => !c.status?.nodeName && claimState(c) !== "Failed").length;
  const ready = nodes.filter((n) =>
    (n.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True"),
  ).length;
  const spot = nodes.filter((n) => n.metadata.labels?.[CAPACITY_TYPE_LABEL] === "spot").length;
  const readyCond = condition(pool, "Ready");
  return {
    title: pool.metadata.name,
    ref: { resource: nodepools.id, name: pool.metadata.name },
    tag:
      readyCond?.status === "True"
        ? { text: "Ready", tone: "ok" }
        : { text: readyCond?.reason || "Not Ready", tone: "error", title: readyCond?.message },
    items: [
      {
        name: "Nodes",
        value: text(
          [
            `${ready}/${nodes.length} ready`,
            launching && `${launching} launching`,
            failed && `${failed} failed to launch`,
            spot && `${spot} spot`,
          ]
            .filter(Boolean)
            .join(" · "),
          failed ? "warning" : undefined,
        ),
      },
      { name: "CPU / Limit", value: limitBar(pool, "cpu") },
      { name: "Memory / Limit", value: limitBar(pool, "memory") },
      { name: "CPU Requests", value: usageBar(requests.cpu, allocatable.cpu, fmtCpu) || "—" },
      { name: "Memory Requests", value: usageBar(requests.memory, allocatable.memory, fmtMemory) || "—" },
      { name: "Pods", value: String(poolPods.length) },
      { name: "Node Class", value: nodeClassLink(pool.spec?.template?.spec?.nodeClassRef) },
    ],
  };
}

function categoryDonut(title: string, resource: string, values: string[]): { title: string; resource: string; slices: DonutSlice[] } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const slices = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, value], i): DonutSlice => ({ label, value, tone: "info", color: i % 8 }));
  return { title, resource, slices };
}

const CLAIM_STATES: ClaimState[] = ["Ready", "Drifted", "Claiming", "Launching", "Registering", "Initializing", "Terminating", "Failed"];

export const karpenterOverview: OverviewPage = {
  id: "karpenter",
  title: "Karpenter",
  resources: [nodepools.id, nodeclaims.id, "nodes", "pods", "events"],
  primary: nodepools.id,
  build({ lists, missing }) {
    if (missing?.has(nodepools.id)) return { donuts: [], tables: [], empty: "Karpenter is not installed on this cluster." };
    const pools = lists[nodepools.id] ?? [];
    const claims = lists[nodeclaims.id] ?? [];
    const managed = (lists.nodes ?? []).filter((n) => n.metadata.labels?.[NODEPOOL_LABEL]);
    const pods = lists.pods ?? [];
    const label = (key: string) => managed.map((n) => n.metadata.labels?.[key] ?? "unknown");
    const states = new Map<ClaimState, number>();
    for (const c of claims) states.set(claimState(c), (states.get(claimState(c)) ?? 0) + 1);
    const claimRows = claims
      .map((c) => nodeclaims.toCompactRow(c))
      .sort((a, b) => String(a.sort.status).localeCompare(String(b.sort.status)));
    return {
      cards: pools.map((p) =>
        poolCard(
          p,
          managed.filter((n) => n.metadata.labels?.[NODEPOOL_LABEL] === p.metadata.name),
          pods,
          claims.filter((c) => c.metadata.labels?.[NODEPOOL_LABEL] === p.metadata.name),
        ),
      ),
      donuts: [
        {
          title: "Node Claims",
          resource: nodeclaims.id,
          slices: CLAIM_STATES.filter((s) => states.get(s)).map((s) => ({ label: s, value: states.get(s)!, tone: CLAIM_TONE[s] })),
        },
        categoryDonut("Capacity Types", "nodes", label(CAPACITY_TYPE_LABEL)),
        categoryDonut("Zones", "nodes", label(ZONE_LABEL)),
        categoryDonut("Instance Types", "nodes", label(INSTANCE_TYPE_LABEL)),
      ],
      tables: [
        { title: "Node Claims", icon: "server", columns: nodeclaims.compactColumns, rows: claimRows, empty: "No node claim" },
        {
          title: "Scaling Decisions",
          icon: "history",
          columns: eventColumns,
          rows: eventRows(
            lists.events ?? [],
            (e) =>
              (e.involvedObject?.apiVersion ?? "").startsWith("karpenter") ||
              e.source?.component === "karpenter" ||
              e.reportingComponent === "karpenter",
          ),
          empty: "No Karpenter event",
        },
      ],
    };
  },
};
