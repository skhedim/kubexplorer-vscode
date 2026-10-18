// Nodes, Namespaces, Events.

import type { NodeAddress, Taint } from "../kube/models";
import type { KubeObject } from "../kube/types";
import type { Cell } from "../shared/view";
import { cpuMillis, memoryBytes } from "../kube/quantity";
import { defineResource } from "./descriptor";
import { fmtCpu, fmtMemory, nodeUsage, usageBar } from "./metrics";
import { conditionTags, formatAge, formatBytes, link, mono, text } from "./format";

function nodeRoles(o: KubeObject): string {
  const roles = Object.keys(o.metadata.labels ?? {})
    .filter((k) => k.startsWith("node-role.kubernetes.io/"))
    .map((k) => k.slice("node-role.kubernetes.io/".length));
  return roles.join(", ") || "<none>";
}

function nodeStatus(o: KubeObject): Cell {
  const ready = (o.status?.conditions ?? []).find((c: { type: string }) => c.type === "Ready");
  const unschedulable = o.spec?.unschedulable ? " (SchedulingDisabled)" : "";
  if (ready?.status === "True") return text(`Ready${unschedulable}`, unschedulable ? "warning" : "ok");
  return text(`NotReady${unschedulable}`, "error", ready?.message);
}

export const nodes = defineResource({
  id: "nodes",
  title: "Nodes",
  kindName: "Node",
  namespaced: false,
  columns: [
    // Utilisation / allocatable (metrics-server) ; vide si l'API metrics.k8s.io est absente.
    {
      id: "cpu",
      title: "CPU",
      grow: 0.8,
      value: (o, rc) => usageBar(nodeUsage(rc, o)?.cpu, cpuMillis(o.status?.allocatable?.cpu), fmtCpu),
      sort: (o, rc) => (nodeUsage(rc, o)?.cpu ?? -1) / (cpuMillis(o.status?.allocatable?.cpu) || 1),
    },
    {
      id: "memory",
      title: "Memory",
      grow: 0.8,
      value: (o, rc) => usageBar(nodeUsage(rc, o)?.memory, memoryBytes(o.status?.allocatable?.memory), fmtMemory),
      sort: (o, rc) => (nodeUsage(rc, o)?.memory ?? -1) / (memoryBytes(o.status?.allocatable?.memory) || 1),
    },
    {
      id: "taints",
      title: "Taints",
      grow: 0.4,
      value: (o) => String(o.spec?.taints?.length ?? 0),
      sort: (o) => o.spec?.taints?.length ?? 0,
    },
    { id: "roles", title: "Roles", grow: 0.8, value: nodeRoles },
    { id: "version", title: "Version", grow: 0.6, value: (o) => o.status?.nodeInfo?.kubeletVersion ?? "" },
  ],
  endColumns: [{ id: "conditions", title: "Conditions", grow: 0.9, value: nodeStatus }],
  related: ["nodemetrics"],
  items: (o, rc) => [
    ...(() => {
      const u = nodeUsage(rc, o);
      if (!u) return [];
      return [
        { name: "CPU", value: usageBar(u.cpu, cpuMillis(o.status?.allocatable?.cpu), fmtCpu) },
        { name: "Memory", value: usageBar(u.memory, memoryBytes(o.status?.allocatable?.memory), fmtMemory) },
      ];
    })(),
    { name: "Addresses", value: (o.status?.addresses ?? []).map((a: NodeAddress) => `${a.type}: ${a.address}`) },
    {
      name: "OS",
      value: `${o.status?.nodeInfo?.osImage ?? ""} (${o.status?.nodeInfo?.architecture ?? o.metadata.labels?.["kubernetes.io/arch"] ?? ""})`,
    },
    { name: "Kernel version", value: o.status?.nodeInfo?.kernelVersion ?? "" },
    { name: "Container runtime", value: o.status?.nodeInfo?.containerRuntimeVersion ?? "" },
    { name: "Kubelet version", value: o.status?.nodeInfo?.kubeletVersion ?? "" },
    {
      name: "Capacity",
      value: `CPU: ${o.status?.capacity?.cpu ?? "?"}, Memory: ${formatBytes(o.status?.capacity?.memory)}, Pods: ${o.status?.capacity?.pods ?? "?"}`,
    },
    {
      name: "Allocatable",
      value: `CPU: ${o.status?.allocatable?.cpu ?? "?"}, Memory: ${formatBytes(o.status?.allocatable?.memory)}, Pods: ${o.status?.allocatable?.pods ?? "?"}`,
    },
    { name: "Taints", value: (o.spec?.taints ?? []).map((t: Taint) => mono(`${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`)) },
    { name: "Conditions", value: conditionTags(o.status?.conditions, false, true) },
  ],
  sections: async (o, ctx) => {
    const items = await ctx.list("pods", { namespaces: [], fieldSelector: `spec.nodeName=${o.metadata.name}` });
    const { columns, rows } = ctx.rowsOf("pods", items);
    return [
      { type: "title", text: `Pods (${items.length})` },
      { type: "table", columns, rows, empty: "No pod" },
    ];
  },
});

export const namespaces = defineResource({
  id: "namespaces",
  title: "Namespaces",
  kindName: "Namespace",
  namespaced: false,
  columns: [
    {
      id: "labels",
      title: "Labels",
      grow: 2,
      value: (o) => ({
        tags: Object.entries(o.metadata.labels ?? {})
          .filter(([k]) => k !== "kubernetes.io/metadata.name")
          .map(([k, v]) => ({ text: `${k}=${v}` })),
      }),
      sort: false,
    },
  ],
  endColumns: [
    {
      id: "status",
      title: "Status",
      grow: 0.6,
      value: (o) => text(o.status?.phase ?? "", o.status?.phase === "Active" ? "ok" : "warning"),
    },
  ],
});

function eventTime(o: KubeObject): string | undefined {
  return o.lastTimestamp ?? o.eventTime ?? o.metadata.creationTimestamp;
}

export const events = defineResource({
  id: "events",
  title: "Events",
  kindName: "Event",
  namespaced: true,
  showName: false,
  defaultSort: { col: "lastSeen", desc: false },
  warning: (o) => (o.type === "Warning" ? o.reason : undefined),
  columns: [
    { id: "type", title: "Type", grow: 0.5, value: (o) => text(o.type, o.type === "Warning" ? "warning" : undefined) },
    { id: "message", title: "Message", grow: 3, value: (o) => text(o.message, o.type === "Warning" ? "warning" : undefined, o.message) },
    {
      id: "object",
      title: "Involved Object",
      grow: 1.5,
      value: (o) => link(o.involvedObject?.kind ?? "", o.involvedObject?.name, o.involvedObject?.namespace),
    },
    { id: "source", title: "Source", grow: 0.8, value: (o) => o.source?.component ?? o.reportingComponent ?? "" },
    { id: "count", title: "Count", grow: 0.4, value: (o) => String(o.count ?? 1), sort: (o) => o.count ?? 1 },
  ],
  endColumns: [
    { id: "lastSeen", title: "Last Seen", grow: 0.5, value: (o) => formatAge(eventTime(o)), sort: (o) => -Date.parse(eventTime(o) ?? "0") },
  ],
  items: (o) => [
    { name: "Message", value: o.message ?? "" },
    { name: "Reason", value: o.reason ?? "" },
    { name: "Type", value: text(o.type, o.type === "Warning" ? "warning" : undefined) },
    {
      name: "Involved Object",
      value: link(o.involvedObject?.kind ?? "", o.involvedObject?.name, o.involvedObject?.namespace, `${o.involvedObject?.kind} `),
    },
    { name: "Source", value: o.source?.component ?? "" },
    { name: "Count", value: String(o.count ?? 1) },
    { name: "Last Seen", value: `${formatAge(eventTime(o))} ago` },
  ],
});
