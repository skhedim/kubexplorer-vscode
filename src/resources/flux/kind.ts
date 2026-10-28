// What every Flux kind shares: links between Flux objects, the status columns and drawer items, the conditions and
// inventory sections, the Reconcile / Suspend / Resume actions, and fluxKind(), which defines a kind with all of them.

import type { KubeObject } from "../../kube/types";
import type { ActionId, Cell, ColumnDef, DetailItem, DetailSection, Tone } from "../../shared/view";
import { type ColumnSpec, type DetailContext, defineResource, type ResourceDescriptor, type ResourceSpec } from "../descriptor";
import { link, mono, since, text } from "../format";
import { ANNOTATION_SUSPEND, apiGroup, type Condition, fluxState, fluxSuspended, sortConditions, stateCell, statusMessage } from "./status";

// ---------- Links between Flux objects ----------

/** Registry identifier of each Flux kind, for the links (sources, inventory, references). */
const KIND_IDS: Record<string, string> = {
  FluxInstance: "flux:fluxinstances",
  FluxReport: "flux:fluxreports",
  ResourceSet: "flux:resourcesets",
  ResourceSetInputProvider: "flux:resourcesetinputproviders",
  Kustomization: "flux:kustomizations",
  HelmRelease: "flux:helmreleases",
  GitRepository: "flux:gitrepositories",
  HelmRepository: "flux:helmrepositories",
  HelmChart: "flux:helmcharts",
  Bucket: "flux:buckets",
  OCIRepository: "flux:ocirepositories",
  ExternalArtifact: "flux:externalartifacts",
  ArtifactGenerator: "flux:artifactgenerators",
  ImageRepository: "flux:imagerepositories",
  ImagePolicy: "flux:imagepolicies",
  ImageUpdateAutomation: "flux:imageupdateautomations",
  Alert: "flux:alerts",
  Provider: "flux:providers",
  Receiver: "flux:receivers",
};

/** A link to a Flux or built-in object; plain text for the other kinds. */
export function objectLink(kind: string, name: string | undefined, namespace: string | undefined, group = "", withKind = false): Cell {
  if (!name) return "";
  const prefix = withKind ? `${kind} ` : undefined;
  const id = group.endsWith("fluxcd.io") ? KIND_IDS[kind] : undefined;
  if (id) return { link: name, ref: { resource: id, namespace, name }, prefix };
  return link(kind, name, namespace, prefix);
}

export interface ObjectRef {
  kind?: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
}

export const SOURCE_GROUPS: Record<string, string> = { ArtifactGenerator: "source.extensions.fluxcd.io" };

/** A sourceRef / chartRef / providerRef, in the namespace of the object by default. */
export function refLink(o: KubeObject, ref: ObjectRef | undefined, defaultKind: string, withKind = true): Cell {
  if (!ref?.name) return "";
  const kind = ref.kind ?? defaultKind;
  return objectLink(kind, ref.name, ref.namespace ?? o.metadata.namespace, SOURCE_GROUPS[kind] ?? "source.toolkit.fluxcd.io", withKind);
}

export function sourceText(ref: ObjectRef | undefined): string {
  return ref?.name ? `${ref.kind ?? ""} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`.trim() : "";
}

// ---------- Columns and detail helpers ----------

const resumedColumn: ColumnSpec = {
  id: "resumed",
  title: "Resumed",
  grow: 0.5,
  value: (o) => (fluxSuspended(o) ? text("No", "info") : "Yes"),
};

/** The Condition and Status columns of every Flux list. */
const statusColumns: ColumnSpec[] = [
  { id: "condition", title: "Condition", grow: 0.7, value: stateCell, sort: (o) => fluxState(o) },
  { id: "status", title: "Status", grow: 2, value: (o) => text(statusMessage(o), undefined, statusMessage(o)) },
];

export function yesNo(v: unknown): string {
  return v === undefined ? "" : v ? "Yes" : "No";
}

export function secretLink(o: KubeObject, ref: { name?: string } | undefined): Cell {
  return link("Secret", ref?.name, o.metadata.namespace);
}

/** Drops the rows without a value, so that the drawer shows only what is set. */
export function present(items: DetailItem[]): DetailItem[] {
  return items.filter((i) => {
    const v = i.value;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object" && "tags" in v) return v.tags.length > 0;
    return typeof v === "object" && "text" in v ? v.text !== "" : v !== "";
  });
}

function statusItems(o: KubeObject): DetailItem[] {
  return present([
    { name: "Status", value: stateCell(o) },
    { name: "Message", value: statusMessage(o) },
    { name: "Resumed", value: fluxSuspended(o) ? text("No (suspended)", "info") : "Yes" },
    { name: "Interval", value: o.spec?.interval ?? "" },
    { name: "Timeout", value: o.spec?.timeout ?? "" },
  ]);
}

export function artifactItems(o: KubeObject): DetailItem[] {
  const a = o.status?.artifact;
  if (!a) return [];
  return present([
    { name: "Artifact Revision", value: mono(a.revision ?? "") },
    { name: "Artifact Digest", value: a.digest ? mono(a.digest) : "" },
    { name: "Artifact Size", value: a.size ? `${(a.size / 1024).toFixed(1)} KiB` : "" },
    { name: "Artifact Updated", value: since(a.lastUpdateTime, { suffix: " ago" }) },
  ]);
}

export const col = (id: string, title: string, grow = 1): ColumnDef => ({ id, title, grow });

function conditionsSection(o: KubeObject): DetailSection[] {
  const conditions: Condition[] = o.status?.conditions ?? [];
  if (!conditions.length) return [];
  const tone = (c: Condition): Tone | undefined =>
    c.status === "True"
      ? c.type === "Stalled"
        ? "error"
        : "ok"
      : c.status === "False"
        ? c.type === "Ready"
          ? "error"
          : "muted"
        : "warning";
  return [
    { type: "title", text: "Conditions" },
    {
      type: "grid",
      columns: [
        col("type", "Type", 0.8),
        col("status", "Status", 0.4),
        col("reason", "Reason", 1),
        col("message", "Message", 2.5),
        col("age", "Age", 0.4),
      ],
      rows: sortConditions(conditions).map((c) => [
        text(c.type, tone(c)),
        c.status,
        c.reason ?? "",
        text(c.message ?? "", undefined, c.message),
        since(c.lastTransitionTime),
      ]),
      empty: "No condition",
    },
  ];
}

/** status.inventory.entries: ids "<namespace>_<name>_<group>_<kind>", with the version in v. */
export function inventoryEntries(o: KubeObject): { namespace?: string; name: string; group: string; kind: string; version: string }[] {
  const entries: { id: string; v?: string }[] = o.status?.inventory?.entries ?? [];
  return entries.flatMap((e) => {
    const [namespace, name, group, kind] = e.id.split("_");
    return name && kind ? [{ namespace: namespace || undefined, name, group: group ?? "", kind, version: e.v ?? "" }] : [];
  });
}

export function inventorySection(o: KubeObject): DetailSection[] {
  const entries = inventoryEntries(o);
  if (!o.status?.inventory) return [];
  return [
    { type: "title", text: `Inventory (${entries.length})` },
    {
      type: "grid",
      columns: [col("kind", "Kind", 0.8), col("name", "Name", 1.6), col("namespace", "Namespace", 0.8), col("api", "API Version", 1)],
      rows: entries.map((e) => [
        e.kind,
        objectLink(e.kind, e.name, e.namespace, e.group),
        e.namespace ?? "",
        mono(e.group ? `${e.group}/${e.version}` : e.version),
      ]),
      empty: "No object",
    },
  ];
}

export function dependsOnItem(o: KubeObject, kind: string): DetailItem[] {
  const deps: ObjectRef[] = o.spec?.dependsOn ?? [];
  return deps.length
    ? [{ name: "Depends On", value: deps.map((d) => objectLink(kind, d.name, d.namespace ?? o.metadata.namespace, "fluxcd.io")) }]
    : [];
}

export function valuesBlock(name: string, value: unknown): DetailItem[] {
  if (value === undefined || value === null || (typeof value === "object" && !Object.keys(value).length)) return [];
  return [{ name, value: JSON.stringify(value, null, 2), block: true }];
}

// ---------- Actions ----------

const REQUESTED_AT = "reconcile.fluxcd.io/requestedAt";

function reconcileAnnotation(now: string): object {
  return { metadata: { annotations: { [REQUESTED_AT]: now } } };
}

type SuspendMode = "spec" | "annotation" | "none";

function fluxActions(suspend: SuspendMode, reconcile: boolean): Pick<ResourceSpec, "actions" | "hideAction" | "patches"> {
  const actions: ActionId[] = [
    ...(reconcile ? (["reconcile"] as const) : []),
    ...(suspend !== "none" ? (["suspend", "resume"] as const) : []),
  ];
  const patches: ResourceDescriptor["patches"] = {};
  if (reconcile) patches.reconcile = (_o, now) => reconcileAnnotation(now);
  if (suspend === "spec") {
    patches.suspend = () => ({ spec: { suspend: true } });
    // Like `flux resume`: resume, then reconcile right away.
    patches.resume = (_o, now) => ({ spec: { suspend: false }, ...reconcileAnnotation(now) });
  } else if (suspend === "annotation") {
    patches.suspend = (o) => ({ metadata: { annotations: { [ANNOTATION_SUSPEND[apiGroup(o)]]: "disabled" } } });
    patches.resume = (o, now) => ({ metadata: { annotations: { [ANNOTATION_SUSPEND[apiGroup(o)]]: "enabled", [REQUESTED_AT]: now } } });
  }
  return {
    actions,
    patches,
    hideAction: (o, action) =>
      (action === "resume" && !fluxSuspended(o)) || ((action === "suspend" || action === "reconcile") && fluxSuspended(o)),
  };
}

// ---------- Descriptors ----------

interface FluxKindSpec {
  id: string;
  plural: string;
  group: string;
  kind: string;
  title: string;
  /** Columns between Namespace and Resumed / Condition / Status. */
  columns?: ColumnSpec[];
  /** No spec.suspend (spec), the reconcile annotation (annotation), or neither. */
  suspend?: SuspendMode;
  /** false: no status (notification kinds of v1beta3): no Condition / Status columns nor Reconcile. */
  status?: boolean;
  items?(o: KubeObject): DetailItem[];
  sections?(o: KubeObject, ctx: DetailContext): DetailSection[];
}

export function fluxKind(k: FluxKindSpec): ResourceDescriptor {
  const suspend = k.suspend ?? "spec";
  const status = k.status !== false;
  return defineResource({
    id: k.id,
    kubectlName: `${k.plural}.${k.group}`,
    title: k.title,
    kindName: k.kind,
    namespaced: true,
    optional: true,
    columns: [...(k.columns ?? []), ...(suspend === "spec" && status ? [resumedColumn] : []), ...(status ? statusColumns : [])],
    ...fluxActions(suspend, status),
    items: (o) => [...(status ? statusItems(o) : []), ...present(k.items?.(o) ?? [])],
    sections: (o, ctx) => [...(k.sections?.(o, ctx) ?? []), ...(status ? conditionsSection(o) : [])],
  });
}

export const CONTROL_PLANE = "fluxcd.controlplane.io";
export const SOURCE = "source.toolkit.fluxcd.io";
export const IMAGE = "image.toolkit.fluxcd.io";
export const NOTIFICATION = "notification.toolkit.fluxcd.io";

export function gitRef(ref: Record<string, string> | undefined): string {
  if (!ref) return "";
  return (
    ref.name ??
    (ref.commit
      ? `commit ${ref.commit.slice(0, 12)}`
      : ref.tag
        ? `tag ${ref.tag}`
        : ref.semver
          ? `semver ${ref.semver}`
          : ref.branch
            ? `branch ${ref.branch}`
            : "")
  );
}
