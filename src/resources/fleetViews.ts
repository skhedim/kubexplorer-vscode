// What the Fleet tab shows, built from the summaries of the scans: the clusters, the Flux matrix, the diagnostics
// and the search results as overview cards and tables, and the details of a cluster or of a Flux object across
// the clusters. The webview renders them like any overview. Pure module, unit tested.

import type {
  Cell,
  ColumnDef,
  DetailItem,
  Details,
  DetailSection,
  OverviewCard,
  OverviewData,
  ResourceRef,
  Row,
  Tone,
} from "../shared/view";
import type { Severity } from "./diagnostics";
import { type ClusterScan, type FluxSummary, fluxVersion, isFailing, type MatrixRow, readyCount, type SearchHit } from "./fleet";
import { formatAge } from "./format";

/** Pseudo resources of the rows of the Fleet tab: their details are built here, not read from a cluster. */
export const FLEET_CLUSTER = "fleet:cluster";
export const FLEET_FLUX = "fleet:flux";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const tag = (text: string, tone: Tone, title?: string): Cell => ({ tags: [{ text, tone, title }], solid: true });
const ago = (at: number | undefined, now: number) => (at ? `${formatAge(new Date(at).toISOString(), now)} ago` : "");

/** "v1.33.1 (70) · v1.32.4 (5)": the values and how many clusters have each, the most common first. */
export function distribution(values: (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v, n]) => (counts.size > 1 ? `${v} (${n})` : v))
    .join(" · ");
}

// ---------- Clusters ----------

/** The status of a cluster in one tag: unreachable, failing Flux objects, suspended or late ones, or OK. */
export function clusterStatus(s: ClusterScan): { text: string; tone: Tone; title?: string } {
  if (s.status === "error") return { text: "Unreachable", tone: "error", title: s.error };
  if (s.status === "pending") return s.scanning ? { text: "Scanning", tone: "info" } : { text: "Not scanned", tone: "muted" };
  if (!s.flux?.installed) return { text: "No Flux", tone: "muted" };
  const objects = s.objects ?? [];
  const failing = objects.filter(isFailing).length;
  if (failing) return { text: `${failing} failing`, tone: "error" };
  const suspended = objects.filter((o) => o.state === "Suspended").length;
  const behind = objects.filter((o) => o.behind).length;
  if (suspended || behind)
    return { text: [suspended && `${suspended} suspended`, behind && `${behind} behind`].filter(Boolean).join(", "), tone: "warning" };
  return { text: "OK", tone: "ok" };
}

function diagnosticsText(s: ClusterScan): Cell {
  const d = s.diagnostics;
  if (!d) return { text: "—", tone: "muted" };
  if (d.error) return { text: "Failed", tone: "error", title: d.error };
  const parts = [d.counts.error && plural(d.counts.error, "error"), d.counts.warning && plural(d.counts.warning, "warning")].filter(
    Boolean,
  );
  return { text: parts.join(" · ") || "No problem", tone: d.counts.error ? "error" : d.counts.warning ? "warning" : "ok" };
}

/** Whether a cluster has something to look at (problems only filter). */
export function clusterHasProblem(s: ClusterScan): boolean {
  const tone = clusterStatus(s).tone;
  return tone === "error" || tone === "warning" || !!s.diagnostics?.counts.error || !!s.diagnostics?.counts.warning;
}

/** The revision of the cluster: the one of its flux-system source, or of its first Git or OCI source. */
function mainRevision(s: ClusterScan): string | undefined {
  const sources = (s.objects ?? []).filter((o) => o.resource === "flux:gitrepositories" || o.resource === "flux:ocirepositories");
  return (sources.find((o) => o.name === "flux-system") ?? sources[0])?.revision;
}

const ratio = (r: { ready: number; total: number; failing?: number }): Cell =>
  r.total ? { text: `${r.ready}/${r.total}`, tone: r.failing ? "error" : r.ready < r.total ? "warning" : undefined } : "";

const SEVERITY_ORDER: Tone[] = ["error", "warning", "info", "muted", "ok"];

const CLUSTER_COLUMNS: ColumnDef[] = [
  { id: "cluster", title: "Cluster", grow: 1.8 },
  { id: "group", title: "Group", grow: 0.5 },
  { id: "status", title: "Status", grow: 0.9 },
  { id: "kubernetes", title: "Kubernetes", grow: 0.8 },
  { id: "nodes", title: "Nodes", grow: 0.4 },
  { id: "flux", title: "Flux", grow: 0.6 },
  { id: "kustomizations", title: "Kustomizations", grow: 0.8 },
  { id: "helmreleases", title: "Helm Releases", grow: 0.8 },
  { id: "revision", title: "Revision", grow: 0.9 },
  { id: "diagnostics", title: "Diagnostics", grow: 0.9 },
  { id: "scanned", title: "Scanned", grow: 0.5 },
];

function clusterRow(s: ClusterScan, now: number): Row {
  const status = clusterStatus(s);
  const components = Object.entries(s.flux?.components ?? {}).map(([c, v]) => `${c} ${v}`);
  const ks = readyCount(s.objects, "flux:kustomizations");
  const hr = readyCount(s.objects, "flux:helmreleases");
  const cells: Record<string, Cell> = {
    cluster: s.context,
    group: s.group,
    status: tag(status.text, status.tone, status.title),
    kubernetes: (s.kubernetes ?? []).join(", "),
    nodes: s.nodes ? ratio(s.nodes) : "",
    flux: s.flux?.installed ? { text: fluxVersion(s.flux.components) ?? "?", title: components.join("\n") } : "",
    kustomizations: ratio(ks),
    helmreleases: ratio(hr),
    revision: mainRevision(s) ? { text: mainRevision(s)!, mono: true } : "",
    diagnostics: diagnosticsText(s),
    scanned: { text: ago(s.at, now), title: s.ms ? `in ${s.ms} ms` : undefined },
  };
  return {
    uid: `cluster:${s.context}`,
    ref: { resource: FLEET_CLUSTER, name: s.context },
    cells,
    sort: {
      cluster: s.context,
      group: s.group,
      status: SEVERITY_ORDER.indexOf(status.tone),
      kubernetes: (s.kubernetes ?? []).join(),
      nodes: s.nodes?.total ?? 0,
      kustomizations: ks.failing * 1000 + ks.total,
      helmreleases: hr.failing * 1000 + hr.total,
      diagnostics: (s.diagnostics?.counts.error ?? -1) * 1000 + (s.diagnostics?.counts.warning ?? 0),
      scanned: s.at ?? 0,
    },
    search: `${s.context} ${s.group} ${status.text} ${(s.kubernetes ?? []).join(" ")} ${mainRevision(s) ?? ""}`.toLowerCase(),
    actions: [],
  };
}

function summaryCard(title: string, scans: ClusterScan[]): OverviewCard {
  const reachable = scans.filter((s) => s.status === "ok");
  const failingClusters = reachable.filter((s) => (s.objects ?? []).some(isFailing));
  const failing = reachable.reduce((n, s) => n + (s.objects ?? []).filter(isFailing).length, 0);
  const unreachable = scans.filter((s) => s.status === "error").length;
  const tone: Tone = unreachable || failing ? "error" : reachable.length < scans.length ? "muted" : "ok";
  const items: DetailItem[] = [
    { name: "Clusters", value: `${scans.length}${unreachable ? `, ${unreachable} unreachable` : ""}` },
    {
      name: "Flux",
      value: failing
        ? { text: `${plural(failing, "object")} failing on ${plural(failingClusters.length, "cluster")}`, tone: "error" }
        : reachable.length
          ? "Every object ready"
          : "—",
    },
    { name: "Kubernetes", value: distribution(reachable.flatMap((s) => s.kubernetes ?? [])) || "—" },
    {
      name: "Flux versions",
      value: distribution(reachable.filter((s) => s.flux?.installed).map((s) => fluxVersion(s.flux?.components))) || "—",
    },
  ];
  return { title, tag: { text: unreachable || failing ? plural(failingClusters.length + unreachable, "problem") : "OK", tone }, items };
}

export function clustersData(scans: ClusterScan[], groups: string[], problemsOnly: boolean, now: number): OverviewData {
  const rows = scans
    .filter((s) => !problemsOnly || clusterHasProblem(s))
    .map((s) => clusterRow(s, now))
    .sort((a, b) => Number(a.sort.status) - Number(b.sort.status) || String(a.sort.cluster).localeCompare(String(b.sort.cluster)));
  const cards =
    groups.length > 1
      ? groups.map((g) =>
          summaryCard(
            g,
            scans.filter((s) => s.group === g),
          ),
        )
      : [summaryCard("Fleet", scans)];
  return {
    cards,
    donuts: [],
    tables: [
      {
        title: "Clusters",
        icon: "server-environment",
        columns: CLUSTER_COLUMNS,
        rows,
        empty: problemsOnly ? "No cluster with a problem" : "No cluster",
      },
    ],
  };
}

/** The details of a cluster: its summary, its Flux objects and its problems. */
export function clusterDetails(s: ClusterScan, now: number): Details {
  const status = clusterStatus(s);
  const open = (label: string, resource: string): Cell => ({ link: label, ref: { context: s.context, resource, name: "" } });
  const items: DetailItem[] = [
    { name: "Group", value: s.group },
    { name: "Status", value: tag(status.text, status.tone, status.title) },
    ...(s.error ? [{ name: "Error", value: { text: s.error, tone: "error" as const } }] : []),
    { name: "Kubernetes", value: (s.kubernetes ?? []).join(", ") },
    ...(s.nodes ? [{ name: "Nodes", value: `${s.nodes.ready}/${s.nodes.total} ready` }] : []),
    ...(s.flux?.components
      ? [{ name: "Flux", value: Object.entries(s.flux.components).map(([c, v]): Cell => ({ text: `${c} ${v}`, mono: true })) }]
      : []),
    { name: "Scanned", value: s.at ? `${ago(s.at, now)}${s.ms ? `, in ${s.ms} ms` : ""}` : "Never" },
    {
      name: "Open",
      value: [open("Cluster overview", "overview"), open("Diagnostics", "overview:diagnostics"), open("Flux overview", "overview:flux")],
    },
  ];
  const sections: DetailSection[] = [{ type: "items", items }];
  const objects = s.objects ?? [];
  if (s.flux?.installed) {
    sections.push(
      { type: "title", text: `Flux objects (${objects.length})` },
      {
        type: "grid",
        columns: [
          { id: "kind", title: "Kind", grow: 0.9 },
          { id: "name", title: "Name", grow: 1.3 },
          { id: "state", title: "State", grow: 0.7 },
          { id: "revision", title: "Revision", grow: 1 },
          { id: "message", title: "Message", grow: 1.6 },
        ],
        rows: [...objects]
          .sort((a, b) => Number(isFailing(b)) - Number(isFailing(a)) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
          .map((o) => [o.kind, objectLink(s.context, o), stateTag(o), o.revision ? { text: o.revision, mono: true } : "", o.message ?? ""]),
        empty: "No Flux object",
      },
    );
  }
  if (s.diagnostics) {
    const d = s.diagnostics;
    sections.push(
      { type: "title", text: `Problems (${d.counts.error} errors, ${d.counts.warning} warnings, ${d.counts.info} info)` },
      {
        type: "grid",
        columns: [
          { id: "severity", title: "Severity", width: 96 },
          { id: "object", title: "Object", grow: 1.3 },
          { id: "problem", title: "Problem", grow: 3 },
        ],
        rows: d.problems.map((p) => [
          tag(SEVERITY_LABEL[p.severity], p.severity),
          { link: p.ref.name, ref: { ...p.ref, context: s.context }, prefix: `${p.kind} ` },
          p.message,
        ]),
        empty: d.error ?? "No error nor warning",
      },
    );
  }
  return {
    uid: `cluster:${s.context}`,
    ref: { resource: FLEET_CLUSTER, name: s.context },
    kindName: "Cluster",
    title: `Cluster: ${s.context}`,
    actions: [],
    sections,
  };
}

const SEVERITY_LABEL: Record<Severity, string> = { error: "Error", warning: "Warning", info: "Info" };

const STATE_TONE: Record<FluxSummary["state"], Tone> = {
  Ready: "ok",
  "Not Ready": "error",
  Stalled: "error",
  "In Progress": "warning",
  Suspended: "info",
  Unknown: "muted",
};

const stateTag = (o: FluxSummary): Cell =>
  tag(o.behind ? `${o.state}, behind` : o.state, o.behind && o.state === "Ready" ? "warning" : STATE_TONE[o.state]);

const objectLink = (context: string, o: FluxSummary): Cell => ({
  link: o.namespace ? `${o.namespace}/${o.name}` : o.name,
  ref: { context, resource: o.resource, namespace: o.namespace, name: o.name },
});

// ---------- Flux matrix ----------

const FLUX_COLUMNS: ColumnDef[] = [
  { id: "status", title: "Status", width: 90 },
  { id: "object", title: "Object", grow: 1.6 },
  { id: "namespace", title: "Namespace", grow: 0.8 },
  { id: "clusters", title: "Clusters", grow: 1 },
  { id: "revision", title: "Revision", grow: 1.2 },
  { id: "drift", title: "Drift", grow: 1.6 },
];

function fluxRow(row: MatrixRow): Row {
  const cells = Object.values(row.cells);
  const ready = cells.filter((o) => o.state === "Ready").length;
  const [main, ...others] = row.revisions;
  return {
    uid: `flux:${row.key}`,
    ref: { resource: FLEET_FLUX, name: row.key },
    cells: {
      status: tag(row.tone === "error" ? "Failing" : row.tone === "warning" ? "Drift" : "OK", row.tone),
      object: `${row.kind} ${row.name}`,
      namespace: row.namespace,
      clusters: {
        text: `${ready}/${cells.length} ready${row.missing.length ? ` · ${row.missing.length} missing` : ""}`,
        tone: ready < cells.length ? "warning" : undefined,
      },
      revision: main ? { text: `${main.revision}${others.length ? ` (+${plural(others.length, "other")})` : ""}`, mono: true } : "",
      drift: { text: row.drift.join(" · ") || "—", tone: row.tone === "ok" ? "muted" : row.tone },
    },
    sort: {
      status: SEVERITY_ORDER.indexOf(row.tone),
      object: `${row.kind} ${row.name}`,
      namespace: row.namespace,
      clusters: ready / Math.max(1, cells.length),
      revision: main?.revision ?? "",
      drift: row.drift.length,
    },
    search:
      `${row.kind} ${row.namespace} ${row.name} ${row.revisions.map((r) => r.revision).join(" ")} ${row.drift.join(" ")}`.toLowerCase(),
    actions: [],
  };
}

export function fluxData(rows: MatrixRow[], scans: ClusterScan[], problemsOnly: boolean): OverviewData {
  const withFlux = scans.filter((s) => s.status === "ok" && s.flux?.installed).length;
  const failing = rows.filter((r) => r.tone === "error").length;
  const drifting = rows.filter((r) => r.tone === "warning").length;
  const card: OverviewCard = {
    title: "Flux objects",
    tag: failing
      ? { text: `${failing} failing`, tone: "error" }
      : drifting
        ? { text: `${drifting} drifting`, tone: "warning" }
        : { text: "OK", tone: "ok" },
    items: [
      { name: "Objects", value: `${rows.length} on ${plural(withFlux, "cluster")} with Flux` },
      { name: "Failing", value: failing ? { text: `${failing}`, tone: "error" } : "0" },
      { name: "Drifting", value: drifting ? { text: `${drifting}: revisions, missing, suspended or behind`, tone: "warning" } : "0" },
    ],
  };
  const shown = rows.filter((r) => !problemsOnly || r.tone !== "ok").map(fluxRow);
  return {
    cards: [card],
    donuts: [],
    tables: [
      {
        title: "Flux objects",
        icon: "sync",
        columns: FLUX_COLUMNS,
        rows: shown,
        empty: problemsOnly ? "No failing nor drifting object" : "No Flux object",
      },
    ],
  };
}

/** The actions a matrix row offers: Resume when suspended somewhere, Reconcile and Suspend when active somewhere. */
export function fluxRowActions(row: MatrixRow): ("reconcile" | "suspend" | "resume")[] {
  const cells = Object.values(row.cells);
  const active = cells.some((o) => o.state !== "Suspended");
  const suspended = cells.some((o) => o.state === "Suspended");
  return [...(active ? (["reconcile", "suspend"] as const) : []), ...(suspended ? (["resume"] as const) : [])];
}

/** A Flux object across the clusters: its state and revision on each, the clusters missing it. */
export function fluxRowDetails(row: MatrixRow, scans: ClusterScan[]): Details {
  const groupOf = new Map(scans.map((s) => [s.context, s.group]));

  const sources = [
    ...new Set(
      Object.values(row.cells)
        .map((o) => o.source)
        .filter(Boolean),
    ),
  ] as string[];
  const present = Object.entries(row.cells)
    .sort(([a, x], [b, y]) => Number(isFailing(y)) - Number(isFailing(x)) || a.localeCompare(b))
    .map(([context, o]): Cell[] => [
      { link: context, ref: { context, resource: o.resource, namespace: o.namespace, name: o.name } },
      groupOf.get(context) ?? "",
      stateTag(o),
      // A revision other than the one of most of its group drifts.
      o.revision
        ? { text: o.revision, mono: true, tone: o.revision !== row.expected[groupOf.get(context) ?? ""] ? "warning" : undefined }
        : "",
      o.message ?? "",
    ]);
  const missing = row.missing.map((context): Cell[] => [context, groupOf.get(context) ?? "", tag("Missing", "muted"), "", ""]);
  return {
    uid: `flux:${row.key}`,
    ref: { resource: FLEET_FLUX, name: row.key },
    kindName: row.kind,
    title: `${row.kind}: ${row.namespace}/${row.name}`,
    actions: fluxRowActions(row),
    sections: [
      {
        type: "items",
        items: [
          { name: "Kind", value: row.kind },
          { name: "Namespace", value: row.namespace },
          ...(sources.length ? [{ name: "Source", value: sources }] : []),
          { name: "Revisions", value: row.revisions.map((r): Cell => ({ text: `${r.revision} (${r.contexts.length})`, mono: true })) },
          { name: "Drift", value: row.drift.length ? { tags: row.drift.map((d) => ({ text: d, tone: row.tone })) } : "None" },
        ],
      },
      { type: "title", text: `Clusters (${present.length + missing.length})` },
      {
        type: "grid",
        columns: [
          { id: "cluster", title: "Cluster", grow: 1.4 },
          { id: "group", title: "Group", grow: 0.5 },
          { id: "state", title: "State", grow: 0.8 },
          { id: "revision", title: "Revision", grow: 1 },
          { id: "message", title: "Message", grow: 1.6 },
        ],
        rows: [...present, ...missing],
        empty: "Nowhere",
      },
    ],
  };
}

// ---------- Diagnostics ----------

const DIAGNOSTIC_COLUMNS: ColumnDef[] = [
  { id: "cluster", title: "Cluster", grow: 1.6 },
  { id: "group", title: "Group", grow: 0.5 },
  { id: "errors", title: "Errors", grow: 0.4 },
  { id: "warnings", title: "Warnings", grow: 0.4 },
  { id: "info", title: "Info", grow: 0.4 },
  { id: "top", title: "Most severe problem", grow: 3 },
  { id: "checked", title: "Checked", grow: 0.5 },
];

export function diagnosticsData(scans: ClusterScan[], problemsOnly: boolean, now: number): OverviewData {
  const checked = scans.filter((s) => s.diagnostics);
  const total = (sev: Severity) => checked.reduce((n, s) => n + (s.diagnostics!.counts[sev] ?? 0), 0);
  const failed = checked.filter((s) => s.diagnostics!.error).length;
  const card: OverviewCard = {
    title: "Diagnostics",
    tag: total("error")
      ? { text: plural(total("error"), "error"), tone: "error" }
      : total("warning")
        ? { text: plural(total("warning"), "warning"), tone: "warning" }
        : { text: checked.length ? "OK" : "Not run", tone: checked.length ? "ok" : "muted" },
    items: [
      { name: "Clusters", value: `${checked.length}/${scans.length} checked${failed ? `, ${failed} failed` : ""}` },
      { name: "Problems", value: `${plural(total("error"), "error")} · ${plural(total("warning"), "warning")} · ${total("info")} info` },
      { name: "Checks", value: "Every rule of the Diagnostics page, but the ConfigMaps and Secrets (not read on the fleet)" },
    ],
  };
  const rows: Row[] = checked
    .filter((s) => !problemsOnly || s.diagnostics!.counts.error || s.diagnostics!.counts.warning || s.diagnostics!.error)
    .map((s): Row => {
      const d = s.diagnostics!;
      const top = d.problems[0];
      return {
        uid: `diagnostics:${s.context}`,
        ref: { resource: FLEET_CLUSTER, name: s.context },
        cells: {
          cluster: s.context,
          group: s.group,
          errors: { text: String(d.counts.error), tone: d.counts.error ? "error" : "muted" },
          warnings: { text: String(d.counts.warning), tone: d.counts.warning ? "warning" : "muted" },
          info: String(d.counts.info),
          top: d.error
            ? { text: d.error, tone: "error" }
            : top
              ? `${top.kind} ${top.ref.namespace ? `${top.ref.namespace}/` : ""}${top.ref.name}: ${top.message}`
              : "—",
          checked: ago(d.at, now),
        },
        sort: {
          cluster: s.context,
          group: s.group,
          errors: d.counts.error,
          warnings: d.counts.warning,
          info: d.counts.info,
          checked: d.at,
        },
        search: `${s.context} ${s.group} ${d.problems.map((p) => `${p.ref.name} ${p.message}`).join(" ")}`.toLowerCase(),
        actions: [],
      };
    })
    .sort(
      (a, b) =>
        Number(b.sort.errors) - Number(a.sort.errors) ||
        Number(b.sort.warnings) - Number(a.sort.warnings) ||
        String(a.sort.cluster).localeCompare(String(b.sort.cluster)),
    );
  return {
    cards: [card],
    donuts: [],
    tables: [
      {
        title: "Clusters",
        icon: "checklist",
        columns: DIAGNOSTIC_COLUMNS,
        rows,
        empty: checked.length
          ? "No cluster with a problem"
          : "Run the diagnostics with the ▶ button: they read the pods and workloads of every cluster shown",
      },
    ],
  };
}

// ---------- Search ----------

const SEARCH_COLUMNS: ColumnDef[] = [
  { id: "cluster", title: "Cluster", grow: 1.3 },
  { id: "kind", title: "Kind", grow: 0.7 },
  { id: "namespace", title: "Namespace", grow: 0.8 },
  { id: "name", title: "Name", grow: 1.3 },
  { id: "detail", title: "Detail", grow: 2.4 },
];

export function searchData(hits: SearchHit[], searched: boolean, truncated: boolean): OverviewData {
  const clusters = new Set(hits.filter((h) => h.resource).map((h) => h.context)).size;
  // Hits arrive in the order the clusters answer: sorted for reading.
  const sorted = [...hits].sort(
    (a, b) =>
      a.context.localeCompare(b.context) ||
      a.kind.localeCompare(b.kind) ||
      (a.namespace ?? "").localeCompare(b.namespace ?? "") ||
      a.name.localeCompare(b.name),
  );
  const rows = sorted.map((h, i): Row => {
    const ref: ResourceRef = { context: h.context, resource: h.resource, namespace: h.namespace, name: h.name };
    return {
      uid: `hit:${i}`,
      ref,
      cells: {
        cluster: h.context,
        kind: h.kind,
        namespace: h.namespace ?? "",
        name: h.resource ? { link: h.name, ref } : "",
        detail: { text: h.detail, tone: h.tone, mono: !!h.resource && !h.tone },
      },
      sort: { cluster: h.context, kind: h.kind, namespace: h.namespace ?? "", name: h.name, detail: h.detail },
      search: `${h.context} ${h.kind} ${h.namespace ?? ""} ${h.name} ${h.detail}`.toLowerCase(),
      actions: [],
    };
  });
  return {
    cards: searched
      ? [
          {
            title: "Search",
            items: [
              {
                name: "Found",
                value: `${plural(hits.filter((h) => h.resource).length, "object")} on ${plural(clusters, "cluster")}${truncated ? " (first ones only)" : ""}`,
              },
            ],
          },
        ]
      : [],
    donuts: [],
    tables: [
      {
        title: "Results",
        icon: "search",
        columns: SEARCH_COLUMNS,
        rows,
        empty: searched ? "Nothing found" : "Pick a kind, type a name (or part of it, * allowed), then press Enter",
      },
    ],
  };
}
