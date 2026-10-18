// Flux (https://fluxcd.io), following the Freelens Flux extension: one list per kind with its status,
// details with the source, inventory, history, conditions and events, Reconcile / Suspend / Resume
// actions, and an overview page. Every kind is optional: it is shown only when its CRD is installed.

import type { KubeObject } from "../kube/types";
import type { ActionId, Cell, ColumnDef, DetailItem, DetailSection, Tone } from "../shared/view";
import { type ColumnSpec, type DetailContext, defineResource, type ResourceDescriptor, type ResourceSpec } from "./descriptor";
import { formatAge, formatDate, labelTags, link, mono, text } from "./format";
import { eventColumns, eventRows, type OverviewPage } from "./overview";

// ---------- Status (getConditionText of the Freelens extension) ----------

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

const CONDITION_PRIORITY: Record<string, number> = { ArtifactInStorage: 3, Released: 3, Synced: 4, Ready: 5 };

/** Newest first; on the same date, the most significant type first. */
function sortConditions(conditions: Condition[]): Condition[] {
  const time = (c: Condition) => Date.parse(c.lastTransitionTime ?? "") || 0;
  return [...conditions].sort((a, b) => time(b) - time(a) || (CONDITION_PRIORITY[b.type] ?? 0) - (CONDITION_PRIORITY[a.type] ?? 0));
}

const ANNOTATION_SUSPEND: Record<string, string> = {
  "fluxcd.controlplane.io": "fluxcd.controlplane.io/reconcile",
  "source.extensions.fluxcd.io": "source.extensions.fluxcd.io/reconcile",
};

function apiGroup(o: KubeObject): string {
  return (o.apiVersion ?? "").split("/")[0];
}

/** Suspended through spec.suspend, or the reconcile annotation of the Flux Operator kinds. */
export function fluxSuspended(o: KubeObject): boolean {
  const annotation = ANNOTATION_SUSPEND[apiGroup(o)];
  return annotation ? o.metadata.annotations?.[annotation] === "disabled" : !!o.spec?.suspend;
}

export type FluxState = "Ready" | "Not Ready" | "Stalled" | "In Progress" | "Suspended" | "Unknown";

export function fluxState(o: KubeObject): FluxState {
  if (fluxSuspended(o)) return "Suspended";
  const conditions: Condition[] = o.status?.conditions ?? [];
  if (!conditions.length) return "Unknown";
  // Reconciling=True: a reconcile is in progress, even if Ready still reflects the previous one.
  if (conditions.some((c) => c.type === "Reconciling" && c.status === "True")) return "In Progress";
  const ready = conditions.find((c) => c.type === "Ready");
  if (ready) {
    if (ready.status === "True") return "Ready";
    if (conditions.some((c) => c.type === "Stalled" && c.status === "True")) return "Stalled";
    return ready.status === "False" ? "Not Ready" : "In Progress";
  }
  const last = sortConditions(conditions)[0];
  if (last.status === "False") return "Not Ready";
  return last.type === "Stalled" ? "Stalled" : "In Progress";
}

const STATE_TONE: Record<FluxState, Tone | undefined> = {
  Ready: "ok",
  "Not Ready": "error",
  Stalled: "error",
  "In Progress": "warning",
  Suspended: "info",
  Unknown: undefined,
};

function stateCell(o: KubeObject): Cell {
  const state = fluxState(o);
  return { tags: [{ text: state, tone: STATE_TONE[state] }], solid: true };
}

function statusMessage(o: KubeObject): string {
  const conditions: Condition[] = o.status?.conditions ?? [];
  return conditions.length ? (sortConditions(conditions)[0].message ?? "") : "";
}

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
function objectLink(kind: string, name: string | undefined, namespace: string | undefined, group = "", withKind = false): Cell {
  if (!name) return "";
  const prefix = withKind ? `${kind} ` : undefined;
  const id = group.endsWith("fluxcd.io") ? KIND_IDS[kind] : undefined;
  if (id) return { link: name, ref: { resource: id, namespace, name }, prefix };
  return link(kind, name, namespace, prefix);
}

interface ObjectRef {
  kind?: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
}

const SOURCE_GROUPS: Record<string, string> = { ArtifactGenerator: "source.extensions.fluxcd.io" };

/** A sourceRef / chartRef / providerRef, in the namespace of the object by default. */
function refLink(o: KubeObject, ref: ObjectRef | undefined, defaultKind: string, withKind = true): Cell {
  if (!ref?.name) return "";
  const kind = ref.kind ?? defaultKind;
  return objectLink(kind, ref.name, ref.namespace ?? o.metadata.namespace, SOURCE_GROUPS[kind] ?? "source.toolkit.fluxcd.io", withKind);
}

function sourceText(ref: ObjectRef | undefined): string {
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

function yesNo(v: unknown): string {
  return v === undefined ? "" : v ? "Yes" : "No";
}

function secretLink(o: KubeObject, ref: { name?: string } | undefined): Cell {
  return link("Secret", ref?.name, o.metadata.namespace);
}

/** Drops the rows without a value, so that the drawer shows only what is set. */
function present(items: DetailItem[]): DetailItem[] {
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

function artifactItems(o: KubeObject): DetailItem[] {
  const a = o.status?.artifact;
  if (!a) return [];
  return present([
    { name: "Artifact Revision", value: mono(a.revision ?? "") },
    { name: "Artifact Digest", value: a.digest ? mono(a.digest) : "" },
    { name: "Artifact Size", value: a.size ? `${(a.size / 1024).toFixed(1)} KiB` : "" },
    { name: "Artifact Updated", value: a.lastUpdateTime ? `${formatAge(a.lastUpdateTime)} ago` : "" },
  ]);
}

const col = (id: string, title: string, grow = 1): ColumnDef => ({ id, title, grow });

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
        text(formatAge(c.lastTransitionTime), undefined, c.lastTransitionTime),
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

function inventorySection(o: KubeObject): DetailSection[] {
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

function dependsOnItem(o: KubeObject, kind: string): DetailItem[] {
  const deps: ObjectRef[] = o.spec?.dependsOn ?? [];
  return deps.length
    ? [{ name: "Depends On", value: deps.map((d) => objectLink(kind, d.name, d.namespace ?? o.metadata.namespace, "fluxcd.io")) }]
    : [];
}

/** Events of the object, newest first. */
async function eventsSection(o: KubeObject, kind: string, ctx: DetailContext): Promise<DetailSection[]> {
  const items = await ctx.list("events", {
    namespaces: o.metadata.namespace ? [o.metadata.namespace] : [],
    fieldSelector: `involvedObject.kind=${kind},involvedObject.name=${o.metadata.name}`,
  });
  const { columns, rows } = ctx.rowsOf("events", items);
  rows.sort((a, b) => Number(a.sort.lastSeen) - Number(b.sort.lastSeen));
  return [
    { type: "title", text: "Events" },
    { type: "table", columns: columns.filter((c) => c.id !== "object"), rows, empty: "No event" },
  ];
}

function valuesBlock(name: string, value: unknown): DetailItem[] {
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

function fluxKind(k: FluxKindSpec): ResourceDescriptor {
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
    sections: async (o, ctx) => [
      ...(k.sections?.(o, ctx) ?? []),
      ...(status ? conditionsSection(o) : []),
      ...(await eventsSection(o, k.kind, ctx)),
    ],
  });
}

const CONTROL_PLANE = "fluxcd.controlplane.io";
const SOURCE = "source.toolkit.fluxcd.io";
const IMAGE = "image.toolkit.fluxcd.io";
const NOTIFICATION = "notification.toolkit.fluxcd.io";

function gitRef(ref: Record<string, string> | undefined): string {
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

function ociRef(ref: Record<string, string> | undefined): string {
  if (!ref) return "latest";
  return ref.digest ? `digest ${ref.digest}` : ref.semver ? `semver ${ref.semver}` : ref.tag ? `tag ${ref.tag}` : "latest";
}

const lastHistory = (o: KubeObject) => o.status?.history?.[0];

/** Kustomization and HelmRelease of the reconcile chain. */
export const fluxKustomizations = fluxKind({
  id: "flux:kustomizations",
  plural: "kustomizations",
  group: "kustomize.toolkit.fluxcd.io",
  kind: "Kustomization",
  title: "Kustomizations",
  columns: [
    { id: "source", title: "Source", grow: 1, value: (o) => refLink(o, o.spec?.sourceRef, "GitRepository", false) },
    { id: "revision", title: "Revision", grow: 1.2, value: (o) => mono(o.status?.lastAppliedRevision ?? "") },
  ],
  items: (o) => [
    { name: "Source", value: refLink(o, o.spec?.sourceRef, "GitRepository") },
    { name: "Path", value: mono(o.spec?.path ?? "./") },
    { name: "Target Namespace", value: link("Namespace", o.spec?.targetNamespace) },
    { name: "Prune", value: yesNo(o.spec?.prune) },
    { name: "Wait", value: yesNo(o.spec?.wait) },
    { name: "Force", value: o.spec?.force ? "Yes" : "" },
    { name: "Retry Interval", value: o.spec?.retryInterval ?? "" },
    { name: "Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    { name: "Kube Config", value: secretLink(o, o.spec?.kubeConfig?.secretRef) },
    {
      name: "Decryption",
      value: o.spec?.decryption ? `${o.spec.decryption.provider} (${o.spec.decryption.secretRef?.name ?? "no secret"})` : "",
    },
    { name: "Last Applied Revision", value: mono(o.status?.lastAppliedRevision ?? "") },
    { name: "Last Attempted Revision", value: mono(o.status?.lastAttemptedRevision ?? "") },
    ...dependsOnItem(o, "Kustomization"),
    ...valuesBlock("Post Build Substitutions", o.spec?.postBuild?.substitute),
  ],
  sections: inventorySection,
});

export const fluxHelmReleases = fluxKind({
  id: "flux:helmreleases",
  plural: "helmreleases",
  group: "helm.toolkit.fluxcd.io",
  kind: "HelmRelease",
  title: "Helm Releases",
  columns: [
    {
      id: "source",
      title: "Source",
      grow: 1,
      value: (o) =>
        o.spec?.chartRef
          ? refLink(o, o.spec.chartRef, "OCIRepository", false)
          : refLink(o, o.spec?.chart?.spec?.sourceRef, "HelmRepository", false),
    },
    { id: "chartVersion", title: "Chart Version", grow: 0.7, value: (o) => lastHistory(o)?.chartVersion ?? "" },
    { id: "appVersion", title: "App Version", grow: 0.7, value: (o) => lastHistory(o)?.appVersion ?? "" },
  ],
  items: (o) => [
    {
      name: "Release Name",
      value: o.spec?.releaseName ?? `${o.spec?.targetNamespace ? `${o.spec.targetNamespace}-` : ""}${o.metadata.name}`,
    },
    {
      name: "Source",
      value: o.spec?.chartRef ? refLink(o, o.spec.chartRef, "OCIRepository") : refLink(o, o.spec?.chart?.spec?.sourceRef, "HelmRepository"),
    },
    { name: "Chart", value: o.spec?.chart?.spec?.chart ?? lastHistory(o)?.chartName ?? "" },
    { name: "Chart Version", value: lastHistory(o)?.chartVersion ?? o.spec?.chart?.spec?.version ?? "" },
    { name: "App Version", value: lastHistory(o)?.appVersion ?? "" },
    { name: "Helm Chart", value: objectLink("HelmChart", o.status?.helmChart?.split("/")[1], o.status?.helmChart?.split("/")[0], SOURCE) },
    { name: "Target Namespace", value: link("Namespace", o.spec?.targetNamespace) },
    { name: "Storage Namespace", value: link("Namespace", o.spec?.storageNamespace) },
    { name: "Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    { name: "Max History", value: o.spec?.maxHistory !== undefined ? String(o.spec.maxHistory) : "" },
    { name: "Drift Detection", value: o.spec?.driftDetection?.mode ?? "" },
    { name: "Install CRDs", value: o.spec?.install?.crds ?? "" },
    { name: "Upgrade CRDs", value: o.spec?.upgrade?.crds ?? "" },
    { name: "Last Attempted Revision", value: mono(o.status?.lastAttemptedRevision ?? "") },
    ...dependsOnItem(o, "HelmRelease"),
    ...valuesBlock("Values", o.spec?.values),
  ],
  sections: (o) => {
    const history: Record<string, string | number>[] = o.status?.history ?? [];
    if (!history.length) return [];
    return [
      { type: "title", text: "History" },
      {
        type: "grid",
        columns: [
          col("version", "Revision", 0.4),
          col("chart", "Chart Version", 0.8),
          col("app", "App Version", 0.7),
          col("status", "Status", 0.7),
          col("deployed", "Last Deployed", 1),
        ],
        rows: history.map((h) => [
          String(h.version ?? ""),
          `${h.chartName ?? ""} ${h.chartVersion ?? ""}`.trim(),
          String(h.appVersion ?? ""),
          text(String(h.status ?? ""), h.status === "deployed" ? "ok" : h.status === "failed" ? "error" : undefined),
          text(formatDate(String(h.lastDeployed ?? "")), undefined, String(h.lastDeployed ?? "")),
        ]),
        empty: "No release",
      },
    ];
  },
});

export const fluxGitRepositories = fluxKind({
  id: "flux:gitrepositories",
  plural: "gitrepositories",
  group: SOURCE,
  kind: "GitRepository",
  title: "Git Repositories",
  columns: [
    { id: "url", title: "URL", grow: 1.6, value: (o) => o.spec?.url ?? "" },
    { id: "ref", title: "Target Ref", grow: 0.8, value: (o) => gitRef(o.spec?.ref) },
    { id: "revision", title: "Revision", grow: 1.2, value: (o) => mono(o.status?.artifact?.revision ?? "") },
  ],
  items: (o) => [
    { name: "URL", value: o.spec?.url ?? "" },
    { name: "Git Ref", value: gitRef(o.spec?.ref) },
    { name: "Authentication Provider", value: o.spec?.provider ?? "" },
    { name: "Git Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Verify Signatures", value: o.spec?.verify ? `${o.spec.verify.mode} (${o.spec.verify.secretRef?.name ?? ""})` : "" },
    { name: "Recurse Submodules", value: o.spec?.recurseSubmodules ? "Yes" : "" },
    ...valuesBlock("Source Ignore", o.spec?.ignore),
    ...artifactItems(o),
  ],
});

export const fluxHelmRepositories = fluxKind({
  id: "flux:helmrepositories",
  plural: "helmrepositories",
  group: SOURCE,
  kind: "HelmRepository",
  title: "Helm Repositories",
  columns: [
    { id: "url", title: "URL", grow: 1.8, value: (o) => o.spec?.url ?? "" },
    { id: "type", title: "Type", grow: 0.5, value: (o) => o.spec?.type ?? "default" },
  ],
  items: (o) => [
    { name: "URL", value: o.spec?.url ?? "" },
    { name: "Type", value: o.spec?.type ?? "default" },
    { name: "Authentication Provider", value: o.spec?.provider ?? "" },
    { name: "Authentication Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Pass Credentials", value: o.spec?.passCredentials ? "Yes" : "" },
    ...artifactItems(o),
  ],
});

export const fluxHelmCharts = fluxKind({
  id: "flux:helmcharts",
  plural: "helmcharts",
  group: SOURCE,
  kind: "HelmChart",
  title: "Helm Charts",
  columns: [
    { id: "chart", title: "Chart", grow: 1, value: (o) => o.spec?.chart ?? "" },
    { id: "version", title: "Version", grow: 0.6, value: (o) => o.spec?.version ?? "*" },
    { id: "sourceKind", title: "Source Kind", grow: 0.7, value: (o) => o.spec?.sourceRef?.kind ?? "" },
    { id: "sourceName", title: "Source Name", grow: 0.9, value: (o) => refLink(o, o.spec?.sourceRef, "HelmRepository", false) },
  ],
  items: (o) => [
    { name: "Chart", value: o.spec?.chart ?? "" },
    { name: "Version", value: o.spec?.version ?? "*" },
    { name: "Source", value: refLink(o, o.spec?.sourceRef, "HelmRepository") },
    { name: "Reconcile Strategy", value: o.spec?.reconcileStrategy ?? "" },
    { name: "Values Files", value: (o.spec?.valuesFiles ?? []).map(mono) },
    ...artifactItems(o),
  ],
});

export const fluxBuckets = fluxKind({
  id: "flux:buckets",
  plural: "buckets",
  group: SOURCE,
  kind: "Bucket",
  title: "Buckets",
  columns: [
    { id: "provider", title: "Provider", grow: 0.6, value: (o) => o.spec?.provider ?? "generic" },
    { id: "bucket", title: "Bucket", grow: 1, value: (o) => o.spec?.bucketName ?? "" },
  ],
  items: (o) => [
    { name: "Provider", value: o.spec?.provider ?? "generic" },
    { name: "Bucket", value: o.spec?.bucketName ?? "" },
    { name: "Endpoint", value: o.spec?.endpoint ?? "" },
    { name: "Region", value: o.spec?.region ?? "" },
    { name: "Insecure Endpoint", value: o.spec?.insecure ? text("Yes", "warning") : "" },
    { name: "Authentication Credentials", value: secretLink(o, o.spec?.secretRef) },
    ...artifactItems(o),
  ],
});

export const fluxOciRepositories = fluxKind({
  id: "flux:ocirepositories",
  plural: "ocirepositories",
  group: SOURCE,
  kind: "OCIRepository",
  title: "OCI Repositories",
  columns: [
    { id: "url", title: "URL", grow: 1.8, value: (o) => o.spec?.url ?? "" },
    { id: "revision", title: "Revision", grow: 1, value: (o) => mono(o.status?.artifact?.revision ?? "") },
  ],
  items: (o) => [
    { name: "URL", value: o.spec?.url ?? "" },
    { name: "Reference", value: ociRef(o.spec?.ref) },
    { name: "Authentication Provider", value: o.spec?.provider ?? "" },
    { name: "Registry Login Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Image Pull Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    { name: "Insecure Container Registry", value: o.spec?.insecure ? text("Yes", "warning") : "" },
    {
      name: "Layer Selector",
      value: o.spec?.layerSelector ? `${o.spec.layerSelector.mediaType ?? ""} ${o.spec.layerSelector.operation ?? ""}`.trim() : "",
    },
    {
      name: "Verify",
      value: o.spec?.verify ? `${o.spec.verify.provider}${o.spec.verify.secretRef ? ` (${o.spec.verify.secretRef.name})` : ""}` : "",
    },
    ...artifactItems(o),
  ],
});

export const fluxExternalArtifacts = fluxKind({
  id: "flux:externalartifacts",
  plural: "externalartifacts",
  group: SOURCE,
  kind: "ExternalArtifact",
  title: "External Artifacts",
  suspend: "none",
  columns: [
    { id: "source", title: "Source", grow: 1, value: (o) => sourceText(o.spec?.sourceRef) },
    { id: "revision", title: "Revision", grow: 1.2, value: (o) => mono(o.status?.artifact?.revision ?? "") },
  ],
  items: (o) => [{ name: "Source", value: sourceText(o.spec?.sourceRef) }, ...artifactItems(o)],
});

export const fluxArtifactGenerators = fluxKind({
  id: "flux:artifactgenerators",
  plural: "artifactgenerators",
  group: "source.extensions.fluxcd.io",
  kind: "ArtifactGenerator",
  title: "Artifact Generators",
  suspend: "annotation",
  columns: [
    { id: "sources", title: "Sources", grow: 0.5, value: (o) => String(o.spec?.sources?.length ?? 0) },
    { id: "artifacts", title: "Artifacts", grow: 0.5, value: (o) => String(o.spec?.artifacts?.length ?? 0) },
  ],
  items: (o) => [
    {
      name: "Sources",
      value: (o.spec?.sources ?? []).map((s: ObjectRef & { alias?: string }) => `${s.alias ? `${s.alias}: ` : ""}${sourceText(s)}`),
    },
    { name: "Artifacts", value: (o.spec?.artifacts ?? []).map((a: { name: string }) => a.name) },
  ],
});

export const fluxImageRepositories = fluxKind({
  id: "flux:imagerepositories",
  plural: "imagerepositories",
  group: IMAGE,
  kind: "ImageRepository",
  title: "Image Repositories",
  columns: [
    { id: "image", title: "Image", grow: 1.6, value: (o) => o.spec?.image ?? "" },
    {
      id: "tags",
      title: "Tags",
      grow: 0.4,
      value: (o) => String(o.status?.lastScanResult?.tagCount ?? ""),
      sort: (o) => o.status?.lastScanResult?.tagCount ?? 0,
    },
  ],
  items: (o) => [
    { name: "Image", value: mono(o.spec?.image ?? "") },
    { name: "Exclusion", value: (o.spec?.exclusionList ?? []).map(mono) },
    { name: "Authentication Provider", value: o.spec?.provider ?? "" },
    { name: "Image Registry Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    { name: "Scan Time", value: o.status?.lastScanResult?.scanTime ? `${formatAge(o.status.lastScanResult.scanTime)} ago` : "" },
    { name: "Tag Count", value: String(o.status?.lastScanResult?.tagCount ?? "") },
    { name: "Latest Tags", value: { tags: (o.status?.lastScanResult?.latestTags ?? []).map((t: string) => ({ text: t })) } },
  ],
});

function latestImage(o: KubeObject): string {
  const ref = o.status?.latestRef;
  return ref ? `${ref.name}:${ref.tag}` : (o.status?.latestImage ?? "");
}

function imagePolicy(p: Record<string, Record<string, string>> | undefined): string {
  if (!p) return "";
  if (p.semver) return `SemVer ${p.semver.range}`;
  if (p.alphabetical) return `Alphabetical (${p.alphabetical.order ?? "asc"})`;
  if (p.numerical) return `Numerical (${p.numerical.order ?? "asc"})`;
  return "";
}

export const fluxImagePolicies = fluxKind({
  id: "flux:imagepolicies",
  plural: "imagepolicies",
  group: IMAGE,
  kind: "ImagePolicy",
  title: "Image Policies",
  columns: [
    {
      id: "repository",
      title: "Repository",
      grow: 1,
      value: (o) =>
        objectLink(
          "ImageRepository",
          o.spec?.imageRepositoryRef?.name,
          o.spec?.imageRepositoryRef?.namespace ?? o.metadata.namespace,
          IMAGE,
        ),
    },
    { id: "latest", title: "Latest Tag", grow: 0.8, value: (o) => o.status?.latestRef?.tag ?? latestImage(o).split(":").pop() ?? "" },
  ],
  items: (o) => [
    {
      name: "Image Repository",
      value: objectLink(
        "ImageRepository",
        o.spec?.imageRepositoryRef?.name,
        o.spec?.imageRepositoryRef?.namespace ?? o.metadata.namespace,
        IMAGE,
      ),
    },
    { name: "Policy", value: imagePolicy(o.spec?.policy) },
    {
      name: "Filter Tags",
      value: o.spec?.filterTags
        ? mono(`${o.spec.filterTags.pattern}${o.spec.filterTags.extract ? ` → ${o.spec.filterTags.extract}` : ""}`)
        : "",
    },
    { name: "Digest Reflection Policy", value: o.spec?.digestReflectionPolicy ?? "" },
    { name: "Latest Image", value: mono(latestImage(o)) },
    {
      name: "Previous Image",
      value: o.status?.observedPreviousRef ? mono(`${o.status.observedPreviousRef.name}:${o.status.observedPreviousRef.tag}`) : "",
    },
  ],
});

export const fluxImageUpdateAutomations = fluxKind({
  id: "flux:imageupdateautomations",
  plural: "imageupdateautomations",
  group: IMAGE,
  kind: "ImageUpdateAutomation",
  title: "Image Update Automations",
  columns: [
    {
      id: "lastRun",
      title: "Last Run",
      grow: 0.6,
      value: (o) => formatAge(o.status?.lastAutomationRunTime),
      sort: (o) => -Date.parse(o.status?.lastAutomationRunTime ?? "0"),
    },
  ],
  items: (o) => [
    { name: "Git Repository", value: refLink(o, o.spec?.sourceRef, "GitRepository") },
    { name: "Git Ref", value: gitRef(o.spec?.git?.checkout?.ref) },
    {
      name: "Commit Author",
      value: o.spec?.git?.commit?.author ? `${o.spec.git.commit.author.name} <${o.spec.git.commit.author.email}>` : "",
    },
    { name: "Push Branch", value: o.spec?.git?.push?.branch ?? "" },
    { name: "Push Refspec", value: o.spec?.git?.push?.refspec ?? "" },
    { name: "Update Strategy", value: o.spec?.update ? `${o.spec.update.strategy ?? "Setters"} ${o.spec.update.path ?? ""}`.trim() : "" },
    { name: "Policy Selector", value: labelTags(o.spec?.policySelector?.matchLabels) },
    { name: "Last Run", value: o.status?.lastAutomationRunTime ? `${formatAge(o.status.lastAutomationRunTime)} ago` : "" },
    { name: "Last Push Commit", value: mono(o.status?.lastPushCommit ?? "") },
    { name: "Last Push", value: o.status?.lastPushTime ? `${formatAge(o.status.lastPushTime)} ago` : "" },
    ...(o.spec?.git?.commit?.messageTemplate ? [{ name: "Message Template", value: o.spec.git.commit.messageTemplate, block: true }] : []),
  ],
});

export const fluxAlerts = fluxKind({
  id: "flux:alerts",
  plural: "alerts",
  group: NOTIFICATION,
  kind: "Alert",
  title: "Alerts",
  status: false,
  columns: [{ id: "severity", title: "Severity", grow: 0.5, value: (o) => o.spec?.eventSeverity ?? "info" }],
  items: (o) => [
    { name: "Resumed", value: fluxSuspended(o) ? text("No (suspended)", "info") : "Yes" },
    { name: "Event Severity", value: o.spec?.eventSeverity ?? "info" },
    { name: "Provider", value: objectLink("Provider", o.spec?.providerRef?.name, o.metadata.namespace, NOTIFICATION) },
    {
      name: "Event Sources",
      value: (o.spec?.eventSources ?? []).map((s: ObjectRef) =>
        s.name === "*" ? `${s.kind} *${s.namespace ? ` in ${s.namespace}` : ""}` : refLink(o, s, s.kind ?? ""),
      ),
    },
    { name: "Inclusions", value: (o.spec?.inclusionList ?? []).map(mono) },
    { name: "Exclusions", value: (o.spec?.exclusionList ?? []).map(mono) },
    { name: "Summary", value: o.spec?.summary ?? "" },
  ],
});

export const fluxProviders = fluxKind({
  id: "flux:providers",
  plural: "providers",
  group: NOTIFICATION,
  kind: "Provider",
  title: "Providers",
  status: false,
  columns: [
    { id: "type", title: "Type", grow: 0.6, value: (o) => o.spec?.type ?? "" },
    { id: "channel", title: "Channel", grow: 0.8, value: (o) => o.spec?.channel ?? "" },
  ],
  items: (o) => [
    { name: "Resumed", value: fluxSuspended(o) ? text("No (suspended)", "info") : "Yes" },
    { name: "Type", value: o.spec?.type ?? "" },
    { name: "Channel", value: o.spec?.channel ?? "" },
    { name: "Username", value: o.spec?.username ?? "" },
    { name: "Address", value: o.spec?.address ?? "" },
    { name: "Timeout", value: o.spec?.timeout ?? "" },
    { name: "Proxy", value: o.spec?.proxy ?? "" },
    { name: "Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "TLS Certificate", value: secretLink(o, o.spec?.certSecretRef) },
  ],
});

export const fluxReceivers = fluxKind({
  id: "flux:receivers",
  plural: "receivers",
  group: NOTIFICATION,
  kind: "Receiver",
  title: "Receivers",
  columns: [{ id: "type", title: "Type", grow: 0.6, value: (o) => o.spec?.type ?? "" }],
  items: (o) => [
    { name: "Type", value: o.spec?.type ?? "" },
    { name: "Events", value: { tags: (o.spec?.events ?? []).map((e: string) => ({ text: e })) } },
    { name: "Resources", value: (o.spec?.resources ?? []).map((r: ObjectRef) => refLink(o, r, r.kind ?? "")) },
    { name: "Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Webhook Path", value: mono(o.status?.webhookPath ?? "") },
  ],
});

export const fluxInstances = fluxKind({
  id: "flux:fluxinstances",
  plural: "fluxinstances",
  group: CONTROL_PLANE,
  kind: "FluxInstance",
  title: "Flux Instances",
  suspend: "annotation",
  columns: [
    { id: "revision", title: "Revision", grow: 1.2, value: (o) => mono(o.status?.lastAppliedRevision ?? "") },
    { id: "enabled", title: "Enabled", grow: 0.5, value: (o) => (fluxSuspended(o) ? text("No", "info") : "Yes") },
  ],
  items: (o) => [
    { name: "Distribution", value: `${o.spec?.distribution?.version ?? ""} (${o.spec?.distribution?.registry ?? ""})` },
    { name: "Components", value: { tags: (o.spec?.components ?? []).map((c: string) => ({ text: c })) } },
    {
      name: "Cluster",
      value: o.spec?.cluster
        ? `${o.spec.cluster.type ?? ""} ${o.spec.cluster.size ?? ""}${o.spec.cluster.multitenant ? ", multitenant" : ""}`.trim()
        : "",
    },
    {
      name: "Sync",
      value: o.spec?.sync ? `${o.spec.sync.kind} ${o.spec.sync.url} (${o.spec.sync.ref}) ${o.spec.sync.path ?? ""}`.trim() : "",
    },
    { name: "Last Applied Revision", value: mono(o.status?.lastAppliedRevision ?? "") },
  ],
  sections: inventorySection,
});

interface ReconcilerStats {
  running?: number;
  failing?: number;
  suspended?: number;
  totalSize?: string;
}

function reportStats(o: KubeObject): Required<Omit<ReconcilerStats, "totalSize">> {
  const reconcilers: { stats?: ReconcilerStats }[] = o.spec?.reconcilers ?? [];
  return reconcilers.reduce(
    (a, r) => ({
      running: a.running + (r.stats?.running ?? 0),
      failing: a.failing + (r.stats?.failing ?? 0),
      suspended: a.suspended + (r.stats?.suspended ?? 0),
    }),
    { running: 0, failing: 0, suspended: 0 },
  );
}

export const fluxReports = fluxKind({
  id: "flux:fluxreports",
  plural: "fluxreports",
  group: CONTROL_PLANE,
  kind: "FluxReport",
  title: "Flux Reports",
  suspend: "annotation",
  columns: [
    { id: "version", title: "Version", grow: 0.6, value: (o) => o.spec?.distribution?.version ?? "" },
    {
      id: "failing",
      title: "Failing",
      grow: 0.4,
      value: (o) => text(String(reportStats(o).failing), reportStats(o).failing ? "error" : undefined),
    },
    { id: "running", title: "Running", grow: 0.4, value: (o) => String(reportStats(o).running) },
    { id: "suspended", title: "Suspended", grow: 0.5, value: (o) => String(reportStats(o).suspended) },
    { id: "enabled", title: "Enabled", grow: 0.5, value: (o) => (fluxSuspended(o) ? text("No", "info") : "Yes") },
  ],
  items: (o) => [
    { name: "Distribution", value: `${o.spec?.distribution?.version ?? ""} ${o.spec?.distribution?.status ?? ""}`.trim() },
    { name: "Entitlement", value: o.spec?.distribution?.entitlement ?? "" },
    { name: "Managed By", value: o.spec?.distribution?.managedBy ?? "" },
    {
      name: "Cluster",
      value: o.spec?.cluster
        ? `${o.spec.cluster.serverVersion ?? ""} ${o.spec.cluster.platform ?? ""}, ${o.spec.cluster.nodes ?? "?"} nodes`
        : "",
    },
    {
      name: "Sync",
      value: o.spec?.sync ? `${o.spec.sync.source ?? ""} ${o.spec.sync.path ?? ""} ${o.spec.sync.ready ? "(ready)" : ""}`.trim() : "",
    },
  ],
  sections: (o) => {
    const components: { name: string; image?: string; ready?: boolean; status?: string }[] = o.spec?.components ?? [];
    const reconcilers: { kind: string; apiVersion?: string; stats?: ReconcilerStats }[] = o.spec?.reconcilers ?? [];
    return [
      { type: "title", text: "Components" },
      {
        type: "grid",
        columns: [col("name", "Name", 1), col("image", "Image", 2), col("ready", "Ready", 0.4)],
        rows: components.map((c) => [c.name, mono(c.image ?? ""), text(c.ready ? "Yes" : "No", c.ready ? "ok" : "error", c.status)]),
        empty: "No component",
      },
      { type: "title", text: "Reconcilers" },
      {
        type: "grid",
        columns: [
          col("kind", "Kind", 1),
          col("running", "Running", 0.5),
          col("failing", "Failing", 0.5),
          col("suspended", "Suspended", 0.5),
          col("size", "Size", 0.5),
        ],
        rows: reconcilers.map((r) => [
          r.kind,
          String(r.stats?.running ?? 0),
          text(String(r.stats?.failing ?? 0), r.stats?.failing ? "error" : undefined),
          String(r.stats?.suspended ?? 0),
          r.stats?.totalSize ?? "",
        ]),
        empty: "No reconciler",
      },
    ];
  },
});

export const fluxResourceSets = fluxKind({
  id: "flux:resourcesets",
  plural: "resourcesets",
  group: CONTROL_PLANE,
  kind: "ResourceSet",
  title: "Resource Sets",
  suspend: "annotation",
  columns: [
    { id: "revision", title: "Revision", grow: 1.2, value: (o) => mono(o.status?.lastAppliedRevision ?? "") },
    { id: "enabled", title: "Enabled", grow: 0.5, value: (o) => (fluxSuspended(o) ? text("No", "info") : "Yes") },
  ],
  items: (o) => [
    { name: "Inputs", value: String(o.spec?.inputs?.length ?? 0) },
    {
      name: "Input Providers",
      value: (o.spec?.inputsFrom ?? []).map((r: ObjectRef) =>
        objectLink(r.kind ?? "ResourceSetInputProvider", r.name, o.metadata.namespace, CONTROL_PLANE),
      ),
    },
    { name: "Resources", value: String(o.spec?.resources?.length ?? 0) },
    { name: "Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    { name: "Last Applied Revision", value: mono(o.status?.lastAppliedRevision ?? "") },
    ...dependsOnItem(o, "ResourceSet"),
  ],
  sections: inventorySection,
});

export const fluxResourceSetInputProviders = fluxKind({
  id: "flux:resourcesetinputproviders",
  plural: "resourcesetinputproviders",
  group: CONTROL_PLANE,
  kind: "ResourceSetInputProvider",
  title: "Input Providers",
  suspend: "annotation",
  columns: [
    { id: "type", title: "Type", grow: 0.7, value: (o) => o.spec?.type ?? "" },
    { id: "url", title: "URL", grow: 1.5, value: (o) => o.spec?.url ?? "" },
    { id: "enabled", title: "Enabled", grow: 0.5, value: (o) => (fluxSuspended(o) ? text("No", "info") : "Yes") },
  ],
  items: (o) => [
    { name: "Type", value: o.spec?.type ?? "" },
    { name: "URL", value: o.spec?.url ?? "" },
    { name: "Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Exported Inputs", value: String(o.status?.exportedInputs?.length ?? 0) },
    ...valuesBlock("Filter", o.spec?.filter),
  ],
});

export const FLUX_KINDS: ResourceDescriptor[] = [
  fluxInstances,
  fluxReports,
  fluxResourceSets,
  fluxResourceSetInputProviders,
  fluxKustomizations,
  fluxHelmReleases,
  fluxGitRepositories,
  fluxHelmRepositories,
  fluxHelmCharts,
  fluxBuckets,
  fluxOciRepositories,
  fluxExternalArtifacts,
  fluxArtifactGenerators,
  fluxImageRepositories,
  fluxImagePolicies,
  fluxImageUpdateAutomations,
  fluxAlerts,
  fluxProviders,
  fluxReceivers,
];

// ---------- Overview ----------

/** The kinds charted on the overview, in the order of the Freelens extension. */
const CHARTED = [
  fluxKustomizations,
  fluxHelmReleases,
  fluxGitRepositories,
  fluxHelmRepositories,
  fluxHelmCharts,
  fluxBuckets,
  fluxOciRepositories,
  fluxExternalArtifacts,
  fluxArtifactGenerators,
  fluxImageRepositories,
  fluxImagePolicies,
  fluxImageUpdateAutomations,
  fluxResourceSets,
  fluxResourceSetInputProviders,
];

const SLICES: { state: FluxState; label: string; tone: Tone }[] = [
  { state: "Ready", label: "Ready", tone: "ok" },
  { state: "In Progress", label: "In Progress", tone: "warning" },
  { state: "Not Ready", label: "Not Ready", tone: "error" },
  { state: "Stalled", label: "Stalled", tone: "error" },
  { state: "Suspended", label: "Suspended", tone: "info" },
  { state: "Unknown", label: "Unknown", tone: "muted" },
];

export const fluxOverview: OverviewPage = {
  id: "flux",
  title: "Flux",
  resources: [...CHARTED.map((d) => d.id), "events"],
  build({ lists, missing }) {
    const charted = CHARTED.filter((d) => lists[d.id]);
    const donuts = charted.map((d) => {
      const counts = new Map<FluxState, number>();
      for (const o of lists[d.id]!) counts.set(fluxState(o), (counts.get(fluxState(o)) ?? 0) + 1);
      return {
        title: d.title,
        resource: d.id,
        slices: SLICES.filter((s) => counts.get(s.state)).map((s) => ({ label: s.label, value: counts.get(s.state)!, tone: s.tone })),
      };
    });
    const events = eventRows(lists.events ?? [], (e) => (e.involvedObject?.apiVersion ?? "").includes("fluxcd.io"));
    return {
      donuts,
      tables: [{ title: "Flux Events", icon: "history", columns: eventColumns, rows: events, empty: "No Flux event" }],
      empty: CHARTED.every((d) => missing?.has(d.id)) ? "Flux is not installed on this cluster." : undefined,
    };
  },
};
