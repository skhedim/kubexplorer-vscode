// Formatting and cell helpers shared by the descriptors.

import type { KubeObject } from "../kube/types";
import { formatAge } from "../shared/units";
import type { Cell, DetailItem, ResourceRef, Tag, Tone } from "../shared/view";

export { formatAge };

/**
 * The time elapsed since an ISO date, kept current by the webview ("3h12m", or "3h12m ago" with a suffix); empty
 * without a date. Rows built with it do not change as time passes.
 */
export function since(iso: string | undefined, opts: { prefix?: string; suffix?: string; tone?: Tone; title?: string } = {}): Cell {
  return iso ? { since: iso, ...opts, title: opts.title ?? iso } : "";
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
  // The date itself: stable, unlike the elapsed time.
  if ("since" in cell) return cell.since;
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
      value: since(m.creationTimestamp, { suffix: ` ago (${formatDate(m.creationTimestamp)})` }),
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
  if (m.deletionTimestamp) items.push({ name: "Deleting", value: since(m.deletionTimestamp, { prefix: "for ", tone: "warning" }) });
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
