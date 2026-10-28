// Flux Operator: Flux instances and reports, resource sets and their input providers.

import type { KubeObject } from "../../kube/types";
import { link, mono, text } from "../format";
import { col, CONTROL_PLANE, dependsOnItem, fluxKind, inventorySection, type ObjectRef, objectLink, secretLink, valuesBlock } from "./kind";
import { fluxSuspended } from "./status";

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
