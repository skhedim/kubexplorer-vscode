// Formatting and cell helpers shared by the descriptors.

import type { KubeObject } from "../kube/types";
import type { Cell, DetailItem, ResourceRef, Tag, Tone } from "../shared/view";

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

export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Plain text of a cell (sorting, search). */
export function cellText(cell: Cell | Cell[] | undefined): string {
  if (cell === undefined) return "";
  if (Array.isArray(cell)) return cell.map(cellText).join(" ");
  if (typeof cell === "string") return cell;
  if ("text" in cell) return cell.text;
  if ("link" in cell) return `${cell.prefix ?? ""}${cell.link}`;
  if ("tags" in cell) return cell.tags.map((t) => t.text).join(" ");
  return "";
}

export function text(value: unknown, tone?: Tone, title?: string): Cell {
  const t = value === undefined || value === null ? "" : String(value);
  return tone || title ? { text: t, tone, title } : t;
}

export function mono(value: unknown): Cell {
  return { text: value === undefined ? "" : String(value), mono: true };
}

export function labelTags(map: Record<string, string> | undefined): Cell {
  return { tags: Object.entries(map ?? {}).map(([k, v]): Tag => ({ text: v === "" ? k : `${k}=${v}` })) };
}

export interface ConditionLike {
  type: string;
  status: string;
  message?: string;
  reason?: string;
}

const GOOD_CONDITIONS = new Set([
  "Ready",
  "Available",
  "Initialized",
  "PodScheduled",
  "ContainersReady",
  "Complete",
  "PodReadyToStartContainers",
]);
const BAD_CONDITIONS = new Set([
  "ReplicaFailure",
  "Failed",
  "DisruptionTarget",
  "MemoryPressure",
  "DiskPressure",
  "PIDPressure",
  "NetworkUnavailable",
]);

function conditionTone(c: ConditionLike): Tone {
  if (c.status !== "True") return "muted";
  if (BAD_CONDITIONS.has(c.type)) return "error";
  if (GOOD_CONDITIONS.has(c.type)) return "ok";
  return "info";
}

/** Conditions as colored tags. onlyTrue: true conditions only (like the Freelens lists). */
export function conditionTags(conds: ConditionLike[] | undefined, onlyTrue: boolean, solid = false): Cell {
  return {
    solid,
    tags: (conds ?? [])
      .filter((c) => !onlyTrue || c.status === "True")
      .map((c) => ({
        text: c.type,
        tone: conditionTone(c),
        title: [c.reason, c.message].filter(Boolean).join(" — ") || `${c.type}: ${c.status}`,
      })),
  };
}

/** Kind -> registry identifier mapping (for links). */
const KIND_TO_RESOURCE: Record<string, string> = {
  Pod: "pods",
  Deployment: "deployments",
  ReplicaSet: "replicasets",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  Job: "jobs",
  CronJob: "cronjobs",
  Node: "nodes",
  Service: "services",
  ConfigMap: "configmaps",
  Secret: "secrets",
  PersistentVolumeClaim: "persistentvolumeclaims",
  PersistentVolume: "persistentvolumes",
  Namespace: "namespaces",
  ServiceAccount: "serviceaccounts",
  Ingress: "ingresses",
  HorizontalPodAutoscaler: "horizontalpodautoscalers",
};

function resourceForKind(kind: string): string | undefined {
  return KIND_TO_RESOURCE[kind];
}

export function link(kind: string, name: string | undefined, namespace?: string, prefix?: string): Cell {
  if (!name) return "";
  const resource = resourceForKind(kind);
  if (!resource) return prefix ? `${prefix}${name}` : name;
  const ref: ResourceRef = {
    resource,
    name,
    namespace: resource === "nodes" || resource === "namespaces" || resource === "persistentvolumes" ? undefined : namespace,
  };
  return { link: name, ref, prefix };
}

export function ownerCell(o: KubeObject, showKindOnly = false): Cell {
  const owner = o.metadata.ownerReferences?.find((r) => r.controller) ?? o.metadata.ownerReferences?.[0];
  if (!owner) return "";
  const resource = resourceForKind(owner.kind);
  if (!resource) return `${owner.kind} ${owner.name}`;
  const ref = { resource, name: owner.name, namespace: o.metadata.namespace };
  return showKindOnly ? { link: owner.kind, ref, title: owner.name } : { link: owner.name, ref, prefix: `${owner.kind} ` };
}

/** Metadata rows at the top of every drawer (like KubeObjectMeta in Freelens). */
export function metadataItems(o: KubeObject): DetailItem[] {
  const m = o.metadata;
  const items: DetailItem[] = [
    {
      name: "Created",
      value: text(`${formatAge(m.creationTimestamp)} ago (${formatDate(m.creationTimestamp)})`, undefined, m.creationTimestamp),
    },
    { name: "Name", value: m.name },
  ];
  if (m.namespace) items.push({ name: "Namespace", value: link("Namespace", m.namespace) });
  items.push({ name: "UID", value: { text: m.uid, mono: true, tone: "muted" } });
  if (m.labels && Object.keys(m.labels).length) items.push({ name: "Labels", value: labelTags(m.labels) });
  const annotations = Object.fromEntries(
    Object.entries(m.annotations ?? {}).filter(([k]) => k !== "kubectl.kubernetes.io/last-applied-configuration"),
  );
  if (Object.keys(annotations).length) items.push({ name: "Annotations", value: labelTags(annotations) });
  if (m.ownerReferences?.length) items.push({ name: "Controlled By", value: ownerCell(o) });
  if (m.deletionTimestamp) items.push({ name: "Deleting", value: text(`for ${formatAge(m.deletionTimestamp)}`, "warning") });
  return items;
}

export function selectorString(sel: Record<string, string> | undefined): string {
  return Object.entries(sel ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/** "16303384Ki" -> "15.5 GiB" */
export function formatBytes(quantity: string | undefined): string {
  if (!quantity) return "";
  const m = /^(\d+(?:\.\d+)?)([KMGTPE]i?)?$/.exec(quantity);
  if (!m) return quantity;
  const units: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  const bytes = Number(m[1]) * (units[m[2] ?? ""] ?? 1);
  const gi = bytes / 1024 ** 3;
  return gi >= 1 ? `${gi.toFixed(1)} GiB` : `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}
