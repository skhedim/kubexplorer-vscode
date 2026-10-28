// The fleet: many clusters seen together. Groups of contexts, a compact summary of each cluster (nodes, Flux
// components and objects, diagnostics), the Flux matrix that compares the objects of a group across its clusters
// to find drifts, and the cross-cluster search. Pure module, unit tested.
//
// Only summaries are kept: a scan reads full objects, keeps a few fields of each and drops the rest.

import type { KubeObject } from "../kube/types";
import { globMatch } from "../shared/protection";
import type { Tone } from "../shared/view";
import type { Problem, Severity } from "./diagnostics";
import { fluxState, type FluxState } from "./flux";

// ---------- Groups ----------

/** Group name → context patterns (`*` matches any text). */
export type FleetGroups = Record<string, string[]>;

/** The group of the contexts no pattern matches. */
export const OTHER_GROUP = "other";

/** The first group whose patterns match the context, or OTHER_GROUP. */
export function groupOf(context: string, groups: FleetGroups): string {
  for (const [name, patterns] of Object.entries(groups)) if (patterns.some((p) => p.trim() && globMatch(p.trim(), context))) return name;
  return OTHER_GROUP;
}

/** The groups in their configured order, then OTHER_GROUP. */
export function groupOrder(groups: FleetGroups): string[] {
  return [...Object.keys(groups).filter((g) => g !== OTHER_GROUP), OTHER_GROUP];
}

// ---------- Cluster summaries ----------

/** The Flux kinds a scan reads (registry identifiers): what is deployed, and where it comes from. */
export const FLEET_FLUX_KINDS = [
  "flux:kustomizations",
  "flux:helmreleases",
  "flux:gitrepositories",
  "flux:ocirepositories",
  "flux:helmrepositories",
  "flux:buckets",
] as const;

/** Sources whose revision is a digest that changes on its own (Helm indexes): never compared. */
const UNCOMPARED = new Set(["flux:helmrepositories"]);

export interface FluxSummary {
  resource: string;
  kind: string;
  apiVersion?: string;
  namespace: string;
  name: string;
  state: FluxState;
  /** What it applied or fetched: a shortened revision, or the version of a chart. */
  revision?: string;
  /** Source of a Kustomization or HelmRelease, as "Kind/namespace/name". */
  source?: string;
  /** A Kustomization that has not applied the last revision of its source yet. */
  behind?: boolean;
  /** Message of the Ready condition, when not ready. */
  message?: string;
}

export interface ClusterDiagnostics {
  at: number;
  counts: Record<Severity, number>;
  /** Errors and warnings, the most severe first, at most MAX_PROBLEMS. */
  problems: Problem[];
  error?: string;
}

export interface ClusterScan {
  context: string;
  group: string;
  /** pending: never scanned; error: the last scan failed (the cluster may be unreachable). */
  status: "pending" | "ok" | "error";
  scanning?: boolean;
  error?: string;
  /** End of the last successful scan, and its duration (ms). */
  at?: number;
  ms?: number;
  /** End of the last scan attempt, successful or not. */
  checkedAt?: number;
  /** Distinct kubelet versions of the nodes. */
  kubernetes?: string[];
  nodes?: { ready: number; total: number };
  flux?: {
    installed: boolean;
    /** Controller → image tag (e.g. kustomize-controller → v1.9.6). */
    components?: Record<string, string>;
  };
  objects?: FluxSummary[];
  diagnostics?: ClusterDiagnostics;
}

/** Problems kept per cluster by the fleet diagnostics. */
export const MAX_PROBLEMS = 100;

/** "main@sha1:0123456789abcdef" → "main@0123456"; "sha256:abcdef…" → "sha256:abcdef0". */
export function shortRevision(revision: string | undefined): string | undefined {
  if (!revision) return undefined;
  const m = /^(?:(.*)@)?(sha1|sha256|blake3):([0-9a-f]+)$/.exec(revision);
  if (!m) return revision;
  return m[1] ? `${m[1]}@${m[3].slice(0, 7)}` : `${m[2]}:${m[3].slice(0, 7)}`;
}

function brief(message: string | undefined, max = 200): string | undefined {
  const line = message?.split("\n")[0].trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function sourceOf(o: KubeObject): string | undefined {
  const ref = o.spec?.sourceRef ?? o.spec?.chart?.spec?.sourceRef ?? o.spec?.chartRef;
  return ref?.kind && ref.name ? `${ref.kind}/${ref.namespace ?? o.metadata.namespace ?? ""}/${ref.name}` : undefined;
}

function revisionOf(resource: string, o: KubeObject): string | undefined {
  if (resource === "flux:kustomizations") return shortRevision(o.status?.lastAppliedRevision);
  // The chart version of the last release; the revision of an OCI chart otherwise.
  if (resource === "flux:helmreleases") return o.status?.history?.[0]?.chartVersion ?? shortRevision(o.status?.lastAttemptedRevision);
  if (UNCOMPARED.has(resource)) return undefined;
  return shortRevision(o.status?.artifact?.revision);
}

export function summarizeFlux(resource: string, kind: string, o: KubeObject): FluxSummary {
  const state = fluxState(o);
  const ready = (o.status?.conditions as { type: string; message?: string }[] | undefined)?.find((c) => c.type === "Ready");
  return {
    resource,
    kind,
    apiVersion: o.apiVersion,
    namespace: o.metadata.namespace ?? "",
    name: o.metadata.name,
    state,
    revision: revisionOf(resource, o),
    source: sourceOf(o),
    message: state === "Ready" || state === "Suspended" ? undefined : brief(ready?.message),
  };
}

/** Marks the Kustomizations that have not applied the revision their source holds. */
function markBehind(objects: FluxSummary[], raw: Map<string, KubeObject>): void {
  const artifacts = new Map<string, string | undefined>();
  for (const o of objects)
    if (o.resource !== "flux:kustomizations" && o.resource !== "flux:helmreleases")
      artifacts.set(`${o.kind}/${o.namespace}/${o.name}`, o.revision);
  for (const o of objects) {
    if (o.resource !== "flux:kustomizations" || o.state === "Suspended" || !o.source) continue;
    const latest = artifacts.get(o.source);
    const applied = shortRevision(raw.get(`${o.namespace}/${o.name}`)?.status?.lastAppliedRevision);
    o.behind = !!latest && !!applied && latest !== applied;
  }
}

/** Nodes, Kubernetes versions and Flux objects of a cluster, from the lists of one scan. */
export function summarizeCluster(lists: {
  nodes?: KubeObject[];
  flux: Record<string, { kind: string; items: KubeObject[] } | undefined>;
}): Pick<ClusterScan, "kubernetes" | "nodes" | "flux" | "objects"> {
  const nodes = lists.nodes ?? [];
  const ready = nodes.filter((n) =>
    (n.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True"),
  );
  const versions = [...new Set(nodes.map((n) => n.status?.nodeInfo?.kubeletVersion).filter(Boolean) as string[])].sort();
  const installed = !!lists.flux["flux:kustomizations"];
  const objects: FluxSummary[] = [];
  const kustomizations = new Map<string, KubeObject>();
  for (const [resource, list] of Object.entries(lists.flux)) {
    for (const o of list?.items ?? []) {
      objects.push(summarizeFlux(resource, list!.kind, o));
      if (resource === "flux:kustomizations") kustomizations.set(`${o.metadata.namespace}/${o.metadata.name}`, o);
    }
  }
  markBehind(objects, kustomizations);
  return { kubernetes: versions, nodes: { ready: ready.length, total: nodes.length }, flux: { installed }, objects };
}

/** Flux controllers and their versions, from the Deployments of flux-system. */
export function fluxComponents(deployments: KubeObject[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of deployments) {
    const image: string | undefined = d.spec?.template?.spec?.containers?.[0]?.image;
    // The tag follows the last ":" of the last path segment (an earlier ":" is the port of a registry).
    const tag = image?.slice(image.lastIndexOf("/") + 1).split(":")[1];
    if (tag) out[d.metadata.name] = tag;
  }
  return out;
}

/**
 * The version shown for the Flux of a cluster: the one of kustomize-controller, its core, named as such
 * ("kustomize v1.9.6"). Flux records only the versions of its controllers (v1.x) in the cluster, not its own (v2.x):
 * a bare "v1.9.6" under "Flux" would read as the long gone Flux 1.
 */
export function fluxControllerVersion(components: Record<string, string> | undefined): string | undefined {
  const name = components?.["kustomize-controller"] ? "kustomize-controller" : Object.keys(components ?? {})[0];
  return name ? `${name.replace(/-controller$/, "")} ${components![name]}` : undefined;
}

/** Counts of the Flux objects of one kind in a cluster. */
export function readyCount(objects: FluxSummary[] | undefined, resource: string): { ready: number; total: number; failing: number } {
  const list = (objects ?? []).filter((o) => o.resource === resource);
  return {
    ready: list.filter((o) => o.state === "Ready").length,
    total: list.length,
    failing: list.filter((o) => o.state === "Not Ready" || o.state === "Stalled").length,
  };
}

export const isFailing = (o: FluxSummary) => o.state === "Not Ready" || o.state === "Stalled";

// ---------- The Flux matrix ----------

export interface MatrixRow {
  key: string;
  resource: string;
  kind: string;
  apiVersion?: string;
  namespace: string;
  name: string;
  /** The object on each cluster that has it. */
  cells: Record<string, FluxSummary>;
  /** Clusters of the same groups (with Flux) that do not have it. */
  missing: string[];
  /** Distinct revisions, the most common first. */
  revisions: { revision: string; contexts: string[] }[];
  /** The most common revision of each group: a cluster that differs from its group drifts. */
  expected: Record<string, string>;
  tone: Tone;
  /** What is wrong or differs, in words. */
  drift: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The values and the keys that have each, the most common first (ties: the most common in `overall`, if given). */
function tally(entries: [string, string | undefined][], overall?: Map<string, number>): { revision: string; contexts: string[] }[] {
  const by = new Map<string, string[]>();
  for (const [context, revision] of entries) {
    if (!revision) continue;
    const contexts = by.get(revision);
    if (contexts) contexts.push(context);
    else by.set(revision, [context]);
  }
  return [...by]
    .map(([revision, contexts]) => ({ revision, contexts }))
    .sort(
      (a, b) =>
        b.contexts.length - a.contexts.length ||
        (overall?.get(b.revision) ?? 0) - (overall?.get(a.revision) ?? 0) ||
        a.revision.localeCompare(b.revision),
    );
}

/**
 * Compares the Flux objects of the clusters, group by group (prod and dev may run different versions on purpose):
 * an object is expected on every cluster of the groups it is in, with the same revision.
 */
export function buildMatrix(scans: ClusterScan[]): MatrixRow[] {
  const withFlux = scans.filter((s) => s.status === "ok" && s.flux?.installed);
  const groupMembers = new Map<string, string[]>();
  for (const s of withFlux) {
    const members = groupMembers.get(s.group);
    if (members) members.push(s.context);
    else groupMembers.set(s.group, [s.context]);
  }
  const groupOfContext = new Map(withFlux.map((s) => [s.context, s.group]));

  const rows = new Map<string, MatrixRow>();
  for (const s of withFlux)
    for (const o of s.objects ?? []) {
      const key = `${o.resource}/${o.namespace}/${o.name}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          resource: o.resource,
          kind: o.kind,
          apiVersion: o.apiVersion,
          namespace: o.namespace,
          name: o.name,
          cells: {},
          missing: [],
          revisions: [],
          expected: {},
          tone: "ok",
          drift: [],
        };
        rows.set(key, row);
      }
      row.cells[s.context] = o;
    }

  for (const row of rows.values()) {
    const present = Object.keys(row.cells);
    const groups = new Set(present.map((c) => groupOfContext.get(c)));
    row.missing = [...groups].flatMap((g) => (groupMembers.get(g!) ?? []).filter((c) => !row.cells[c]));
    const entries = Object.entries(row.cells).map(([context, o]): [string, string | undefined] => [context, o.revision]);
    row.revisions = tally(entries);
    // A tie within a group (1 cluster against 1) goes to the revision most clusters run.
    const overall = new Map(row.revisions.map((r) => [r.revision, r.contexts.length]));
    const drifting: string[] = [];
    for (const g of groups) {
      const inGroup = tally(
        entries.filter(([context]) => groupOfContext.get(context) === g),
        overall,
      );
      if (inGroup.length) row.expected[g!] = inGroup[0].revision;
      if (inGroup.length > 1) drifting.push(`${inGroup.length} revisions in ${g}`);
    }
    const cells = Object.values(row.cells);
    const failing = cells.filter(isFailing).length;
    const suspended = cells.filter((o) => o.state === "Suspended").length;
    const behind = cells.filter((o) => o.behind).length;
    if (failing) row.drift.push(`${failing} not ready`);
    row.drift.push(...drifting);
    if (behind) row.drift.push(`${behind} behind their source`);
    if (suspended) row.drift.push(`${suspended} suspended`);
    if (row.missing.length) row.drift.push(`missing on ${plural(row.missing.length, "cluster")}`);
    row.tone = failing ? "error" : row.drift.length ? "warning" : "ok";
  }
  const order: Tone[] = ["error", "warning", "ok"];
  return [...rows.values()].sort(
    (a, b) =>
      order.indexOf(a.tone) - order.indexOf(b.tone) ||
      a.kind.localeCompare(b.kind) ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name),
  );
}

// ---------- Diagnostics ----------

export function summarizeDiagnostics(problems: Problem[], at: number): ClusterDiagnostics {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const p of problems) counts[p.severity]++;
  return { at, counts, problems: problems.filter((p) => p.severity !== "info").slice(0, MAX_PROBLEMS) };
}

// ---------- Search ----------

export interface SearchKind {
  id: string;
  label: string;
  /** Lists to read on each cluster (registry identifiers); none: searched in the summaries of the scans. */
  resources: string[];
  /** Details of a matching object, undefined when it does not match. */
  match(o: KubeObject, query: string): string | undefined;
}

export interface SearchHit {
  context: string;
  resource: string;
  kind: string;
  namespace?: string;
  name: string;
  detail: string;
  tone?: Tone;
}

/** Case-insensitive: a glob when the query holds `*` or `?`, a substring otherwise. */
export function matchesQuery(text: string | undefined, query: string): boolean {
  if (!text) return false;
  const q = query.trim();
  if (!q) return true;
  return /[*?]/.test(q) ? globMatch(q, text) : text.toLowerCase().includes(q.toLowerCase());
}

/** The containers of a pod, or of the pod template of a workload or CronJob. */
function containers(o: KubeObject): { name: string; image: string }[] {
  const spec = o.spec?.jobTemplate?.spec?.template?.spec ?? o.spec?.template?.spec ?? o.spec ?? {};
  return [...(spec.initContainers ?? []), ...(spec.containers ?? [])];
}

const byName = (detail: (o: KubeObject) => string) => (o: KubeObject, q: string) =>
  matchesQuery(o.metadata.name, q) ? detail(o) : undefined;

const workloadDetail = (o: KubeObject) => {
  const desired = o.spec?.replicas ?? o.status?.desiredNumberScheduled ?? 0;
  const ready = o.status?.readyReplicas ?? o.status?.numberReady ?? 0;
  return `${ready}/${desired} ready · ${containers(o)
    .map((c) => c.image)
    .join(", ")}`;
};

export const SEARCH_KINDS: SearchKind[] = [
  { id: "workloads", label: "Workloads", resources: ["deployments", "statefulsets", "daemonsets"], match: byName(workloadDetail) },
  {
    id: "images",
    label: "Images",
    resources: ["deployments", "statefulsets", "daemonsets", "cronjobs"],
    match: (o, q) => {
      const images = [...new Set(containers(o).map((c) => c.image))].filter((i) => matchesQuery(i, q));
      return images.length ? images.join(", ") : undefined;
    },
  },
  { id: "pods", label: "Pods", resources: ["pods"], match: byName((o) => `${o.status?.phase ?? ""} · ${o.spec?.nodeName ?? ""}`) },
  {
    id: "services",
    label: "Services",
    resources: ["services"],
    match: byName((o) => `${o.spec?.type ?? ""} ${(o.spec?.ports ?? []).map((p: { port: number }) => p.port).join(",")}`),
  },
  {
    id: "ingresses",
    label: "Ingresses (name or host)",
    resources: ["ingresses"],
    match: (o, q) => {
      const hosts: string[] = (o.spec?.rules ?? []).map((r: { host?: string }) => r.host).filter(Boolean);
      return matchesQuery(o.metadata.name, q) || hosts.some((h) => matchesQuery(h, q)) ? hosts.join(", ") || "—" : undefined;
    },
  },
  {
    id: "configmaps",
    label: "Config Maps",
    resources: ["configmaps"],
    match: byName((o) => plural(Object.keys(o.data ?? {}).length, "key")),
  },
  { id: "namespaces", label: "Namespaces", resources: ["namespaces"], match: byName((o) => o.status?.phase ?? "") },
  { id: "flux", label: "Flux objects", resources: [], match: () => undefined },
];

/** Flux objects of the scans matching a query (name, revision or source), without asking the clusters. */
export function searchFlux(scans: ClusterScan[], query: string): SearchHit[] {
  return scans.flatMap((s) =>
    (s.objects ?? [])
      .filter((o) => matchesQuery(o.name, query) || matchesQuery(o.revision, query) || matchesQuery(o.source, query))
      .map((o) => ({
        context: s.context,
        resource: o.resource,
        kind: o.kind,
        namespace: o.namespace,
        name: o.name,
        detail: [o.state, o.revision].filter(Boolean).join(" · "),
        tone: isFailing(o) ? ("error" as const) : o.state === "Ready" ? ("ok" as const) : ("warning" as const),
      })),
  );
}
