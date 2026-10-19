// Pods: status and container states, following the rules of Freelens
// (pod.getStatusMessage, container-status-class-name).

import type { ContainerSpec, ContainerStatus } from "../kube/models";
import type { KubeObject } from "../kube/types";
import type { Brick, ContainerState, DetailItem, DetailSection, Tone } from "../shared/view";
import { defineResource } from "./descriptor";
import { fmtCpu, fmtMemory, podUsage, type Usage } from "./metrics";
import { conditionTags, formatAge, link, mono, ownerCell, text } from "./format";

interface ContainerInfo {
  name: string;
  image: string;
  init: boolean;
  state: ContainerState;
  reason?: string;
  ready: boolean;
  restarts: number;
  spec: ContainerSpec;
  status?: ContainerStatus;
}

const FAILED_WAITING = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "InvalidImageName",
  "CreateContainerError",
]);

function containerState(status: ContainerStatus | undefined): { state: ContainerState; reason?: string } {
  const restarts = status?.restartCount ?? 0;
  if (status?.state?.running) return { state: restarts > 0 ? "restarted" : "running" };
  if (status?.state?.waiting) {
    const reason = status.state.waiting.reason;
    return { state: reason && FAILED_WAITING.has(reason) ? "failed" : "waiting", reason };
  }
  if (status?.state?.terminated) {
    const t = status.state.terminated;
    return { state: t.exitCode === 0 ? "terminated" : "failed", reason: t.reason };
  }
  return { state: "waiting" };
}

function podContainers(pod: KubeObject): ContainerInfo[] {
  const make = (specs: ContainerSpec[] | undefined, statuses: ContainerStatus[] | undefined, init: boolean): ContainerInfo[] =>
    (specs ?? []).map((spec) => {
      const status = statuses?.find((s) => s.name === spec.name);
      return {
        name: spec.name,
        image: spec.image ?? "",
        init,
        ready: !!status?.ready,
        restarts: status?.restartCount ?? 0,
        spec,
        status,
        ...containerState(status),
      };
    });
  return [
    ...make(pod.spec?.initContainers, pod.status?.initContainerStatuses, true),
    ...make(pod.spec?.containers, pod.status?.containerStatuses, false),
  ];
}

/** Status shown in the Status column (same logic as Freelens). */
export function podStatus(pod: KubeObject): string {
  if (pod.metadata.deletionTimestamp) return "Terminating";
  if (pod.status?.reason === "Evicted") return "Evicted";
  for (const c of podContainers(pod)) {
    if (c.init && c.state !== "running" && c.state !== "terminated" && c.reason) return `Init:${c.reason}`;
  }
  for (const c of podContainers(pod)) {
    if (c.init) continue;
    if (c.state === "failed" || (c.state === "waiting" && c.reason)) return c.reason ?? "Waiting";
  }
  return pod.status?.phase ?? "Unknown";
}

export function podStatusTone(status: string): Tone {
  if (status === "Running") return "ok";
  if (status === "Succeeded" || status === "Completed") return "success";
  if (status === "Pending" || status === "Waiting") return "warning";
  if (status === "ContainerCreating" || status === "PodInitializing" || status.startsWith("Init:")) return "info";
  if (status === "Terminating" || status === "Unknown") return "terminated";
  return "error";
}

export function podRestarts(pod: KubeObject): number {
  return podContainers(pod)
    .filter((c) => !c.init)
    .reduce((n, c) => n + c.restarts, 0);
}

function podWarning(pod: KubeObject): string | undefined {
  const status = podStatus(pod);
  if (status === "Succeeded" || status === "Completed") return undefined;
  const notReady = podContainers(pod).filter((c) => !c.init && !c.ready);
  if (pod.status?.phase === "Pending" && !pod.spec?.nodeName) {
    const msg = pod.status?.conditions?.find((c: { type: string }) => c.type === "PodScheduled")?.message;
    return `Unschedulable${msg ? `: ${msg}` : ""}`;
  }
  return notReady.length ? `${notReady.length} container(s) not ready: ${notReady.map((c) => c.name).join(", ")}` : undefined;
}

export function containerBricks(pod: KubeObject): { bricks: Brick[] } {
  return {
    bricks: podContainers(pod).map((c) => ({
      state: c.state,
      init: c.init,
      title: `${c.init ? "[init] " : ""}${c.name}: ${c.reason ?? c.state}${c.ready ? ", ready" : ""}${c.restarts ? `, ${c.restarts} restart(s)` : ""}`,
    })),
  };
}

const STATE_TONE: Record<ContainerState, Tone> = {
  running: "ok",
  restarted: "ok",
  waiting: "warning",
  terminated: "terminated",
  failed: "error",
};

function resources(r: Record<string, string> | undefined): string {
  if (!r) return "";
  return Object.entries(r)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

function containerSection(c: ContainerInfo, usage?: Usage): DetailSection {
  const items: DetailItem[] = [
    { name: "Status", value: text(`${c.reason ? `${c.state}, ${c.reason}` : c.state}${c.ready ? ", ready" : ""}`, STATE_TONE[c.state]) },
  ];
  if (usage) items.push({ name: "Usage", value: `CPU ${fmtCpu(usage.cpu)} · Memory ${fmtMemory(usage.memory)}` });
  const last = c.status?.lastState?.terminated;
  if (last)
    items.push({
      name: "Last Status",
      value: text(
        `Terminated (${last.reason ?? "?"}, exit code ${last.exitCode})${last.finishedAt ? ` ${formatAge(last.finishedAt)} ago` : ""}`,
        "warning",
      ),
    });
  items.push({ name: "Image", value: mono(c.image) });
  const ports = (c.spec.ports ?? []).map((p) => `${p.name ? `${p.name}: ` : ""}${p.containerPort}/${p.protocol ?? "TCP"}`);
  if (ports.length) items.push({ name: "Ports", value: ports.map((p: string) => text(p, "info")) });
  if (c.spec.command || c.spec.args)
    items.push({ name: "Command", value: mono([...(c.spec.command ?? []), ...(c.spec.args ?? [])].join(" ")) });
  if (c.spec.resources?.requests) items.push({ name: "Requests", value: resources(c.spec.resources.requests) });
  if (c.spec.resources?.limits) items.push({ name: "Limits", value: resources(c.spec.resources.limits) });
  const mounts = (c.spec.volumeMounts ?? []).map((m) => mono(`${m.mountPath} ← ${m.name}${m.readOnly ? " (ro)" : ""}`));
  if (mounts.length) items.push({ name: "Mounts", value: mounts });
  items.push({ name: "Restarts", value: String(c.restarts) });
  return {
    type: "group",
    title: c.name,
    brick: c.state,
    badge: c.init ? "init" : undefined,
    actions: c.init
      ? [{ action: "logs", container: c.name }]
      : [
          { action: "logs", container: c.name },
          { action: "shell", container: c.name },
          { action: "debug", container: c.name },
        ],
    items,
  };
}

export const pods = defineResource({
  id: "pods",
  title: "Pods",
  kindName: "Pod",
  namespaced: true,
  nameGrow: 2.5,
  warning: podWarning,
  columns: [
    { id: "containers", title: "Containers", grow: 0.9, value: containerBricks, sort: (o) => podContainers(o).length },
    // metrics-server metrics: empty when the metrics.k8s.io API is missing.
    {
      id: "cpu",
      title: "CPU",
      grow: 0.5,
      value: (o, rc) => fmtCpu(podUsage(rc, o)?.cpu ?? NaN),
      sort: (o, rc) => podUsage(rc, o)?.cpu ?? -1,
    },
    {
      id: "memory",
      title: "Memory",
      grow: 0.6,
      value: (o, rc) => fmtMemory(podUsage(rc, o)?.memory ?? NaN),
      sort: (o, rc) => podUsage(rc, o)?.memory ?? -1,
    },
    { id: "restarts", title: "Restarts", grow: 0.5, value: (o) => String(podRestarts(o)), sort: podRestarts },
    { id: "owner", title: "Controlled By", grow: 0.9, value: (o) => ownerCell(o, true) },
    { id: "node", title: "Node", grow: 1.3, value: (o) => link("Node", o.spec?.nodeName) },
    { id: "qos", title: "QoS", grow: 0.8, value: (o) => o.status?.qosClass ?? "" },
  ],
  endColumns: [{ id: "status", title: "Status", grow: 1, value: (o) => text(podStatus(o), podStatusTone(podStatus(o))) }],
  compact: ["name", "node", "containers", "cpu", "memory", "restarts", "age", "status"],
  actions: ["logs", "shell", "debug", "portForward"],
  related: ["podmetrics"],
  metrics: async (o) => ({ kind: "pods", namespace: o.metadata.namespace ?? "default", pods: [o] }),
  items: (o, rc) => [
    ...(() => {
      const u = podUsage(rc, o);
      return u ? [{ name: "Usage", value: `CPU ${fmtCpu(u.cpu)} · Memory ${fmtMemory(u.memory)}` }] : [];
    })(),
    { name: "Status", value: text(podStatus(o), podStatusTone(podStatus(o))) },
    { name: "Node", value: link("Node", o.spec?.nodeName) },
    { name: "Pod IP", value: o.status?.podIP ?? "" },
    { name: "Host IP", value: o.status?.hostIP ?? "" },
    { name: "Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    ...(o.spec?.priorityClassName ? [{ name: "Priority Class", value: o.spec.priorityClassName }] : []),
    { name: "QoS Class", value: o.status?.qosClass ?? "" },
    { name: "Conditions", value: conditionTags(o.status?.conditions, false, true) },
  ],
  sections: (o, ctx) => {
    const usage = podUsage(ctx.rowContext, o);
    const section = (c: ContainerInfo) => containerSection(c, usage?.containers[c.name]);
    const containers = podContainers(o);
    const init = containers.filter((c) => c.init);
    const main = containers.filter((c) => !c.init);
    const sections: DetailSection[] = [];
    if (init.length) sections.push({ type: "title", text: "Init Containers" }, ...init.map(section));
    sections.push({ type: "title", text: "Containers" }, ...main.map(section));
    return sections;
  },
});
