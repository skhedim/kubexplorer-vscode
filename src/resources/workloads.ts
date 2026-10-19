// Workload controllers: Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs.

import type { ContainerSpec, PersistentVolumeClaimTemplate } from "../kube/models";
import type { KubeObject } from "../kube/types";
import type { Cell, DetailSection } from "../shared/view";
import type { MetricsScope } from "./charts";
import { type DetailContext, defineResource } from "./descriptor";
import { conditionTags, formatAge, labelTags, link, mono, ownerCell, selectorString, text } from "./format";

/** The "Pods" section of a drawer: pods matching a label selector. */
export async function podsSection(
  ctx: DetailContext,
  namespace: string | undefined,
  selector: Record<string, string> | undefined,
): Promise<DetailSection[]> {
  const labelSelector = selectorString(selector);
  if (!labelSelector || !namespace) return [];
  const items = await ctx.list("pods", { namespaces: [namespace], labelSelector });
  const { columns, rows } = ctx.rowsOf("pods", items);
  return [
    { type: "title", text: "Pods" },
    { type: "table", columns, rows, empty: "No pod" },
  ];
}

/** The usage charts of a workload: the sum of its pods. */
async function podsScope(
  ctx: DetailContext,
  namespace: string | undefined,
  selector: Record<string, string> | undefined,
): Promise<MetricsScope | undefined> {
  const labelSelector = selectorString(selector);
  if (!labelSelector || !namespace) return undefined;
  return { kind: "pods", namespace, pods: await ctx.list("pods", { namespaces: [namespace], labelSelector }) };
}

function readyCell(ready: number, desired: number): Cell {
  return text(`${ready}/${desired}`, ready < desired ? "warning" : undefined);
}

function images(o: KubeObject): Cell[] {
  return (o.spec?.template?.spec?.containers ?? o.spec?.jobTemplate?.spec?.template?.spec?.containers ?? []).map((c: ContainerSpec) =>
    mono(c.image),
  );
}

export const deployments = defineResource({
  id: "deployments",
  title: "Deployments",
  kindName: "Deployment",
  namespaced: true,
  columns: [
    {
      id: "pods",
      title: "Pods",
      grow: 0.6,
      value: (o) => readyCell(o.status?.readyReplicas ?? 0, o.spec?.replicas ?? 0),
      sort: (o) => (o.status?.readyReplicas ?? 0) / Math.max(1, o.spec?.replicas ?? 0),
    },
    { id: "replicas", title: "Replicas", grow: 0.6, value: (o) => String(o.spec?.replicas ?? 0), sort: (o) => o.spec?.replicas ?? 0 },
  ],
  endColumns: [{ id: "conditions", title: "Conditions", grow: 1.6, value: (o) => conditionTags(o.status?.conditions, true) }],
  actions: ["logs", "scale", "restart"],
  items: (o) => {
    const s = o.status ?? {};
    const desired = o.spec?.replicas ?? 0;
    const unavailable = s.unavailableReplicas ?? Math.max(0, desired - (s.availableReplicas ?? 0));
    return [
      {
        name: "Replicas",
        value: text(
          `${desired} desired, ${s.updatedReplicas ?? 0} updated, ${s.replicas ?? 0} total, ${s.availableReplicas ?? 0} available, ${unavailable} unavailable`,
          unavailable ? "warning" : undefined,
        ),
      },
      { name: "Selector", value: labelTags(o.spec?.selector?.matchLabels) },
      { name: "Images", value: images(o) },
      { name: "Strategy Type", value: o.spec?.strategy?.type ?? "" },
      ...(o.spec?.paused ? [{ name: "Paused", value: text("Yes", "warning") }] : []),
      { name: "Conditions", value: conditionTags(o.status?.conditions, true, true) },
    ];
  },
  metrics: (o, ctx) => podsScope(ctx, o.metadata.namespace, o.spec?.selector?.matchLabels),
  sections: (o, ctx) => podsSection(ctx, o.metadata.namespace, o.spec?.selector?.matchLabels),
});

export const statefulsets = defineResource({
  id: "statefulsets",
  title: "Stateful Sets",
  kindName: "StatefulSet",
  namespaced: true,
  columns: [
    { id: "pods", title: "Pods", grow: 0.6, value: (o) => readyCell(o.status?.readyReplicas ?? 0, o.spec?.replicas ?? 0) },
    { id: "replicas", title: "Replicas", grow: 0.6, value: (o) => String(o.spec?.replicas ?? 0), sort: (o) => o.spec?.replicas ?? 0 },
  ],
  actions: ["logs", "scale", "restart"],
  items: (o) => [
    { name: "Selector", value: labelTags(o.spec?.selector?.matchLabels) },
    { name: "Service", value: link("Service", o.spec?.serviceName, o.metadata.namespace) },
    { name: "Images", value: images(o) },
    { name: "Update Strategy", value: o.spec?.updateStrategy?.type ?? "" },
    {
      name: "Volume Claims",
      value: (o.spec?.volumeClaimTemplates ?? []).map(
        (v: PersistentVolumeClaimTemplate) => `${v.metadata?.name} (${v.spec?.resources?.requests?.storage ?? "?"})`,
      ),
    },
  ],
  metrics: (o, ctx) => podsScope(ctx, o.metadata.namespace, o.spec?.selector?.matchLabels),
  sections: (o, ctx) => podsSection(ctx, o.metadata.namespace, o.spec?.selector?.matchLabels),
});

export const daemonsets = defineResource({
  id: "daemonsets",
  title: "Daemon Sets",
  kindName: "DaemonSet",
  namespaced: true,
  columns: [
    { id: "pods", title: "Pods", grow: 0.6, value: (o) => readyCell(o.status?.numberReady ?? 0, o.status?.desiredNumberScheduled ?? 0) },
    { id: "nodeSelector", title: "Node Selector", grow: 1.2, value: (o) => labelTags(o.spec?.template?.spec?.nodeSelector), sort: false },
  ],
  actions: ["logs", "restart"],
  items: (o) => [
    { name: "Selector", value: labelTags(o.spec?.selector?.matchLabels) },
    { name: "Images", value: images(o) },
    { name: "Strategy Type", value: o.spec?.updateStrategy?.type ?? "" },
    {
      name: "Pods",
      value: `${o.status?.numberReady ?? 0} ready, ${o.status?.desiredNumberScheduled ?? 0} desired, ${o.status?.numberMisscheduled ?? 0} misscheduled`,
    },
  ],
  metrics: (o, ctx) => podsScope(ctx, o.metadata.namespace, o.spec?.selector?.matchLabels),
  sections: (o, ctx) => podsSection(ctx, o.metadata.namespace, o.spec?.selector?.matchLabels),
});

export const replicasets = defineResource({
  id: "replicasets",
  title: "Replica Sets",
  kindName: "ReplicaSet",
  namespaced: true,
  columns: [
    { id: "desired", title: "Desired", grow: 0.5, value: (o) => String(o.spec?.replicas ?? 0), sort: (o) => o.spec?.replicas ?? 0 },
    { id: "current", title: "Current", grow: 0.5, value: (o) => String(o.status?.replicas ?? 0), sort: (o) => o.status?.replicas ?? 0 },
    {
      id: "ready",
      title: "Ready",
      grow: 0.5,
      value: (o) =>
        text(String(o.status?.readyReplicas ?? 0), (o.status?.readyReplicas ?? 0) < (o.spec?.replicas ?? 0) ? "warning" : undefined),
      sort: (o) => o.status?.readyReplicas ?? 0,
    },
    { id: "owner", title: "Controlled By", grow: 1, value: (o) => ownerCell(o) },
  ],
  actions: ["logs", "scale"],
  items: (o) => [
    { name: "Selector", value: labelTags(o.spec?.selector?.matchLabels) },
    { name: "Images", value: images(o) },
    { name: "Replicas", value: `${o.status?.replicas ?? 0} current / ${o.spec?.replicas ?? 0} desired` },
  ],
  metrics: (o, ctx) => podsScope(ctx, o.metadata.namespace, o.spec?.selector?.matchLabels),
  sections: (o, ctx) => podsSection(ctx, o.metadata.namespace, o.spec?.selector?.matchLabels),
});

function jobStatus(o: KubeObject): Cell {
  const conds: { type: string; status: string }[] = o.status?.conditions ?? [];
  if (conds.some((c) => c.type === "Complete" && c.status === "True")) return text("Complete", "success");
  if (conds.some((c) => c.type === "Failed" && c.status === "True")) return text("Failed", "error");
  if (o.status?.active) return text("Running", "ok");
  return text("Pending", "warning");
}

export const jobs = defineResource({
  id: "jobs",
  title: "Jobs",
  kindName: "Job",
  namespaced: true,
  columns: [
    { id: "completions", title: "Completions", grow: 0.6, value: (o) => `${o.status?.succeeded ?? 0}/${o.spec?.completions ?? 1}` },
    { id: "owner", title: "Controlled By", grow: 1, value: (o) => ownerCell(o) },
  ],
  endColumns: [{ id: "status", title: "Status", grow: 0.7, value: jobStatus }],
  actions: ["logs"],
  items: (o) => [
    { name: "Status", value: jobStatus(o) },
    {
      name: "Completions",
      value: `${o.status?.succeeded ?? 0} succeeded, ${o.status?.failed ?? 0} failed, ${o.status?.active ?? 0} active (target ${o.spec?.completions ?? 1})`,
    },
    { name: "Parallelism", value: String(o.spec?.parallelism ?? 1) },
    {
      name: "Duration",
      value: o.status?.startTime
        ? formatAge(o.status.startTime, o.status.completionTime ? Date.parse(o.status.completionTime) : Date.now())
        : "",
    },
    { name: "Images", value: images(o) },
    { name: "Conditions", value: conditionTags(o.status?.conditions, true, true) },
  ],
  sections: (o, ctx) => podsSection(ctx, o.metadata.namespace, o.spec?.selector?.matchLabels ?? { "job-name": o.metadata.name }),
});

export const cronjobs = defineResource({
  id: "cronjobs",
  title: "Cron Jobs",
  kindName: "CronJob",
  namespaced: true,
  columns: [
    { id: "schedule", title: "Schedule", grow: 0.8, value: (o) => mono(o.spec?.schedule) },
    {
      id: "suspend",
      title: "Suspend",
      grow: 0.5,
      value: (o) => text(o.spec?.suspend ? "True" : "False", o.spec?.suspend ? "warning" : undefined),
    },
    {
      id: "active",
      title: "Active",
      grow: 0.4,
      value: (o) => String(o.status?.active?.length ?? 0),
      sort: (o) => o.status?.active?.length ?? 0,
    },
    {
      id: "last",
      title: "Last Schedule",
      grow: 0.6,
      value: (o) => formatAge(o.status?.lastScheduleTime),
      sort: (o) => -Date.parse(o.status?.lastScheduleTime ?? "0"),
    },
  ],
  actions: ["trigger"],
  items: (o) => [
    { name: "Schedule", value: mono(o.spec?.schedule) },
    { name: "Suspend", value: o.spec?.suspend ? "True" : "False" },
    { name: "Last Schedule", value: o.status?.lastScheduleTime ? `${formatAge(o.status.lastScheduleTime)} ago` : "Never" },
    { name: "Images", value: images(o) },
  ],
  sections: async (o, ctx) => {
    const all = await ctx.list("jobs", { namespaces: [o.metadata.namespace ?? ""] });
    const owned = all.filter((j) => j.metadata.ownerReferences?.some((r) => r.kind === "CronJob" && r.name === o.metadata.name));
    const { columns, rows } = ctx.rowsOf("jobs", owned);
    return [
      { type: "title", text: "Jobs" },
      { type: "table", columns, rows, empty: "No job" },
    ];
  },
});
