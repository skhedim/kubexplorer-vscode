// Karpenter (https://karpenter.sh), following the Freelens Karpenter extension: NodePools with their
// limits and usage, NodeClaims, NodeClasses (AWS, Azure, KWOK), and a Karpenter section in the details of
// the nodes it manages (the dashboard is in karpenterOverview.ts). Every kind is optional: it is shown
// only when its CRD is installed.

import { cpuMillis, memoryBytes } from "../kube/quantity";
import type { Taint } from "../kube/models";
import type { KubeObject } from "../kube/types";
import type { Cell, ColumnDef, DetailItem, DetailSection, Tone } from "../shared/view";
import { type DetailContext, defineResource, type ResourceDescriptor } from "./descriptor";
import { conditionTags, link, mono, text } from "./format";
import { fmtCpu, fmtMemory, usageBar } from "./metrics";

export const NODEPOOL_LABEL = "karpenter.sh/nodepool";
export const CAPACITY_TYPE_LABEL = "karpenter.sh/capacity-type";
export const INSTANCE_TYPE_LABEL = "node.kubernetes.io/instance-type";
export const ZONE_LABEL = "topology.kubernetes.io/zone";
const DISRUPTION_TAINTS = ["karpenter.sh/disrupted", "karpenter.sh/disruption"];

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

interface Requirement {
  key: string;
  operator: string;
  values?: string[];
  minValues?: number;
}

export function condition(o: KubeObject, type: string): Condition | undefined {
  return (o.status?.conditions ?? []).find((c: Condition) => c.type === type);
}

function readyCell(o: KubeObject): Cell {
  const ready = condition(o, "Ready");
  if (!ready) return text("Unknown", "muted");
  return ready.status === "True" ? text("Ready", "ok") : text(ready.reason || "Not Ready", "error", ready.message);
}

function requirementText(r: Requirement): string {
  const values = r.values?.length ? ` ${r.values.join(", ")}` : "";
  return `${r.key} ${r.operator}${values}${r.minValues ? ` (min ${r.minValues})` : ""}`;
}

function taintText(t: Taint): string {
  return `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`;
}

/** NodeClass reference of a NodePool or NodeClaim, linked to its descriptor when the kind is known. */
export function nodeClassLink(ref: { group?: string; kind?: string; name?: string } | undefined): Cell {
  if (!ref?.name) return "";
  const id = NODE_CLASS_IDS[ref.kind ?? ""];
  return id
    ? { link: ref.name, ref: { resource: id, name: ref.name }, title: `${ref.kind} ${ref.name}` }
    : `${ref.kind ?? ""} ${ref.name}`.trim();
}

function nodePoolLink(name: string | undefined): Cell {
  return name ? { link: name, ref: { resource: "karpenter:nodepools", name } } : "";
}

const col = (id: string, title: string, grow = 1): ColumnDef => ({ id, title, grow });

async function eventsSection(o: KubeObject, kind: string, ctx: DetailContext): Promise<DetailSection[]> {
  // Karpenter records the events of cluster-scoped objects in the default namespace.
  const items = await ctx.list("events", {
    namespaces: [],
    fieldSelector: `involvedObject.kind=${kind},involvedObject.name=${o.metadata.name}`,
  });
  const { columns, rows } = ctx.rowsOf("events", items);
  rows.sort((a, b) => Number(a.sort.lastSeen) - Number(b.sort.lastSeen));
  return [
    { type: "title", text: "Events" },
    { type: "table", columns: columns.filter((c) => c.id !== "object"), rows, empty: "No event" },
  ];
}

function conditionsGrid(o: KubeObject): DetailSection[] {
  const conditions: Condition[] = o.status?.conditions ?? [];
  if (!conditions.length) return [];
  return [
    { type: "title", text: "Conditions" },
    {
      type: "grid",
      columns: [col("type", "Type", 0.9), col("status", "Status", 0.4), col("reason", "Reason", 0.9), col("message", "Message", 2.4)],
      rows: conditions.map((c) => [
        text(
          c.type,
          c.status === "True"
            ? c.type === "Drifted" || c.type === "Consolidatable"
              ? "warning"
              : "ok"
            : c.status === "False"
              ? "error"
              : "muted",
        ),
        c.status,
        c.reason ?? "",
        text(c.message ?? "", undefined, c.message),
      ]),
      empty: "No condition",
    },
  ];
}

// ---------- NodePools ----------

/** "used / limit" gauge of a NodePool resource (status.resources against spec.limits). */
export function limitBar(o: KubeObject, resource: "cpu" | "memory"): Cell {
  const parse = resource === "cpu" ? cpuMillis : memoryBytes;
  const format = resource === "cpu" ? fmtCpu : fmtMemory;
  const used = parse(o.status?.resources?.[resource] ?? "0");
  const limit = parse(o.spec?.limits?.[resource]);
  if (!Number.isFinite(limit)) return format(used) || "0";
  return usageBar(used, limit, format);
}

export const nodepools = defineResource({
  id: "karpenter:nodepools",
  kubectlName: "nodepools.karpenter.sh",
  title: "Node Pools",
  kindName: "NodePool",
  namespaced: false,
  optional: true,
  columns: [
    { id: "nodeClass", title: "Node Class", grow: 0.8, value: (o) => nodeClassLink(o.spec?.template?.spec?.nodeClassRef) },
    {
      id: "nodes",
      title: "Nodes",
      grow: 0.4,
      value: (o) => String(o.status?.nodes ?? o.status?.resources?.nodes ?? 0),
      sort: (o) => Number(o.status?.nodes ?? 0),
    },
    {
      id: "cpu",
      title: "CPU / Limit",
      grow: 0.9,
      value: (o) => limitBar(o, "cpu"),
      sort: (o) => cpuMillis(o.status?.resources?.cpu ?? "0"),
    },
    {
      id: "memory",
      title: "Memory / Limit",
      grow: 0.9,
      value: (o) => limitBar(o, "memory"),
      sort: (o) => memoryBytes(o.status?.resources?.memory ?? "0"),
    },
    { id: "weight", title: "Weight", grow: 0.4, value: (o) => String(o.spec?.weight ?? ""), sort: (o) => o.spec?.weight ?? 0 },
    { id: "ready", title: "Ready", grow: 0.6, value: readyCell },
  ],
  items: (o) => {
    const t = o.spec?.template;
    const d = o.spec?.disruption ?? {};
    return [
      { name: "Status", value: readyCell(o) },
      { name: "Node Class", value: nodeClassLink(t?.spec?.nodeClassRef) },
      { name: "Nodes", value: String(o.status?.nodes ?? 0) },
      { name: "CPU", value: limitBar(o, "cpu") },
      { name: "Memory", value: limitBar(o, "memory") },
      { name: "Limits", value: Object.entries(o.spec?.limits ?? {}).map(([k, v]) => `${k}: ${v}`) },
      { name: "Weight", value: String(o.spec?.weight ?? "") },
      { name: "Requirements", value: (t?.spec?.requirements ?? []).map((r: Requirement) => mono(requirementText(r))) },
      { name: "Taints", value: (t?.spec?.taints ?? []).map((x: Taint) => mono(taintText(x))) },
      { name: "Startup Taints", value: (t?.spec?.startupTaints ?? []).map((x: Taint) => mono(taintText(x))) },
      { name: "Expire After", value: t?.spec?.expireAfter ?? "" },
      { name: "Termination Grace Period", value: t?.spec?.terminationGracePeriod ?? "" },
      { name: "Consolidation", value: d.consolidationPolicy ? `${d.consolidationPolicy}, after ${d.consolidateAfter ?? "0s"}` : "" },
      {
        name: "Disruption Budgets",
        value: (d.budgets ?? []).map((b: { nodes: string; schedule?: string; duration?: string; reasons?: string[] }) =>
          [
            `${b.nodes} nodes`,
            b.reasons?.length ? `for ${b.reasons.join(", ")}` : "",
            b.schedule ? `at "${b.schedule}" for ${b.duration}` : "",
          ]
            .filter(Boolean)
            .join(" "),
        ),
      },
    ].filter((i) => (Array.isArray(i.value) ? i.value.length : i.value !== ""));
  },
  sections: async (o, ctx) => {
    const claims = await ctx.list("karpenter:nodeclaims", { namespaces: [], labelSelector: `${NODEPOOL_LABEL}=${o.metadata.name}` });
    const nodes = await ctx.list("nodes", { namespaces: [], labelSelector: `${NODEPOOL_LABEL}=${o.metadata.name}` });
    const claimRows = ctx.rowsOf("karpenter:nodeclaims", claims);
    const nodeRows = ctx.rowsOf("nodes", nodes);
    return [
      { type: "title", text: `Node Claims (${claims.length})` },
      { type: "table", columns: claimRows.columns, rows: claimRows.rows, empty: "No node claim" },
      { type: "title", text: `Nodes (${nodes.length})` },
      { type: "table", columns: nodeRows.columns, rows: nodeRows.rows, empty: "No node" },
      ...conditionsGrid(o),
      ...(await eventsSection(o, "NodePool", ctx)),
    ];
  },
});

// ---------- NodeClaims ----------

export type ClaimState = "Ready" | "Claiming" | "Launching" | "Registering" | "Initializing" | "Drifted" | "Terminating" | "Failed";

export function claimState(o: KubeObject): ClaimState {
  if (o.metadata.deletionTimestamp) return "Terminating";
  const launched = condition(o, "Launched");
  if (launched?.status === "False") return "Failed";
  if (condition(o, "Ready")?.status === "True") return condition(o, "Drifted")?.status === "True" ? "Drifted" : "Ready";
  if (!o.status?.nodeName) return launched?.status === "True" ? "Registering" : launched ? "Launching" : "Claiming";
  return condition(o, "Initialized")?.status === "True" ? "Ready" : "Initializing";
}

export const CLAIM_TONE: Record<ClaimState, Tone> = {
  Ready: "ok",
  Claiming: "info",
  Launching: "info",
  Registering: "info",
  Initializing: "info",
  Drifted: "warning",
  Terminating: "terminated",
  Failed: "error",
};

function claimCell(o: KubeObject): Cell {
  const state = claimState(o);
  const launched = condition(o, "Launched");
  return text(state, CLAIM_TONE[state], state === "Failed" ? launched?.message : undefined);
}

export const nodeclaims = defineResource({
  id: "karpenter:nodeclaims",
  kubectlName: "nodeclaims.karpenter.sh",
  title: "Node Claims",
  kindName: "NodeClaim",
  namespaced: false,
  optional: true,
  columns: [
    { id: "type", title: "Type", grow: 0.7, value: (o) => o.metadata.labels?.[INSTANCE_TYPE_LABEL] ?? "" },
    { id: "capacity", title: "Capacity", grow: 0.6, value: (o) => o.metadata.labels?.[CAPACITY_TYPE_LABEL] ?? "" },
    { id: "zone", title: "Zone", grow: 0.6, value: (o) => o.metadata.labels?.[ZONE_LABEL] ?? "" },
    { id: "node", title: "Node", grow: 1.6, value: (o) => link("Node", o.status?.nodeName) },
    { id: "nodePool", title: "Node Pool", grow: 0.6, value: (o) => nodePoolLink(o.metadata.labels?.[NODEPOOL_LABEL]) },
  ],
  endColumns: [{ id: "status", title: "Status", grow: 0.6, value: claimCell }],
  compact: ["name", "type", "capacity", "zone", "node", "age", "status"],
  warning: (o) => (claimState(o) === "Failed" ? (condition(o, "Launched")?.message ?? "Launch failed") : undefined),
  items: (o) =>
    [
      { name: "Status", value: claimCell(o) },
      { name: "Node Pool", value: nodePoolLink(o.metadata.labels?.[NODEPOOL_LABEL]) },
      { name: "Node Class", value: nodeClassLink(o.spec?.nodeClassRef) },
      { name: "Node", value: link("Node", o.status?.nodeName) },
      { name: "Instance Type", value: o.metadata.labels?.[INSTANCE_TYPE_LABEL] ?? "" },
      { name: "Capacity Type", value: o.metadata.labels?.[CAPACITY_TYPE_LABEL] ?? "" },
      { name: "Zone", value: o.metadata.labels?.[ZONE_LABEL] ?? "" },
      { name: "Provider ID", value: mono(o.status?.providerID ?? "") },
      { name: "Image ID", value: mono(o.status?.imageID ?? "") },
      { name: "Capacity", value: Object.entries(o.status?.capacity ?? {}).map(([k, v]) => `${k}: ${v}`) },
      { name: "Allocatable", value: Object.entries(o.status?.allocatable ?? {}).map(([k, v]) => `${k}: ${v}`) },
      { name: "Requirements", value: (o.spec?.requirements ?? []).map((r: Requirement) => mono(requirementText(r))) },
      { name: "Expire After", value: o.spec?.expireAfter ?? "" },
      { name: "Conditions", value: conditionTags(o.status?.conditions, true, true) },
    ].filter((i) => (Array.isArray(i.value) ? i.value.length : i.value !== "")),
  sections: async (o, ctx) => [...conditionsGrid(o), ...(await eventsSection(o, "NodeClaim", ctx))],
});

// ---------- NodeClasses ----------

function selectorTerms(terms: Record<string, unknown>[] | undefined): Cell[] {
  return (terms ?? []).map((t) =>
    mono(
      Object.entries(t)
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(", "),
    ),
  );
}

export const ec2nodeclasses = defineResource({
  id: "karpenter:ec2nodeclasses",
  kubectlName: "ec2nodeclasses.karpenter.k8s.aws",
  title: "EC2 Node Classes",
  kindName: "EC2NodeClass",
  namespaced: false,
  optional: true,
  columns: [
    { id: "role", title: "Role", grow: 1.2, value: (o) => o.spec?.role ?? o.spec?.instanceProfile ?? "" },
    { id: "amis", title: "AMIs", grow: 0.4, value: (o) => String(o.status?.amis?.length ?? 0) },
    { id: "subnets", title: "Subnets", grow: 0.4, value: (o) => String(o.status?.subnets?.length ?? 0) },
    { id: "ready", title: "Ready", grow: 0.6, value: readyCell },
  ],
  items: (o) => [
    { name: "Status", value: readyCell(o) },
    { name: "Role", value: o.spec?.role ?? "" },
    { name: "Instance Profile", value: o.status?.instanceProfile ?? o.spec?.instanceProfile ?? "" },
    { name: "AMI Selector", value: selectorTerms(o.spec?.amiSelectorTerms) },
    { name: "Subnet Selector", value: selectorTerms(o.spec?.subnetSelectorTerms) },
    { name: "Security Group Selector", value: selectorTerms(o.spec?.securityGroupSelectorTerms) },
    {
      name: "Security Groups",
      value: (o.status?.securityGroups ?? []).map((g: { id: string; name?: string }) => mono(`${g.id}${g.name ? ` (${g.name})` : ""}`)),
    },
  ],
  sections: (o) => {
    const amis: { id: string; name?: string; requirements?: Requirement[] }[] = o.status?.amis ?? [];
    const subnets: { id: string; zone?: string; zoneID?: string }[] = o.status?.subnets ?? [];
    return [
      { type: "title", text: "AMIs" },
      {
        type: "grid",
        columns: [col("id", "ID", 1), col("name", "Name", 1), col("requirements", "Requirements", 1.6)],
        rows: amis.map((a) => [mono(a.id), a.name ?? "", (a.requirements ?? []).map(requirementText).join("; ")]),
        empty: "No AMI resolved",
      },
      { type: "title", text: "Subnets" },
      {
        type: "grid",
        columns: [col("id", "ID", 1), col("zone", "Zone", 0.8), col("zoneId", "Zone ID", 0.8)],
        rows: subnets.map((s) => [mono(s.id), s.zone ?? "", s.zoneID ?? ""]),
        empty: "No subnet resolved",
      },
      ...conditionsGrid(o),
    ];
  },
});

export const aksnodeclasses = defineResource({
  id: "karpenter:aksnodeclasses",
  kubectlName: "aksnodeclasses.karpenter.azure.com",
  title: "AKS Node Classes",
  kindName: "AKSNodeClass",
  namespaced: false,
  optional: true,
  columns: [
    { id: "image", title: "Image Family", grow: 0.8, value: (o) => o.spec?.imageFamily ?? "" },
    { id: "osDisk", title: "OS Disk", grow: 0.5, value: (o) => (o.spec?.osDiskSizeGB ? `${o.spec.osDiskSizeGB} GB` : "") },
    { id: "ready", title: "Ready", grow: 0.6, value: readyCell },
  ],
  items: (o) => [
    { name: "Status", value: readyCell(o) },
    { name: "Image Family", value: o.spec?.imageFamily ?? "" },
    { name: "Image Version", value: o.spec?.imageVersion ?? "" },
    { name: "OS Disk Size", value: o.spec?.osDiskSizeGB ? `${o.spec.osDiskSizeGB} GB` : "" },
    { name: "VNet Subnet", value: mono(o.spec?.vnetSubnetID ?? "") },
    { name: "Max Pods", value: String(o.spec?.maxPods ?? "") },
  ],
  sections: conditionsGrid,
});

export const kwoknodeclasses = defineResource({
  id: "karpenter:kwoknodeclasses",
  kubectlName: "kwoknodeclasses.karpenter.kwok.sh",
  title: "KWOK Node Classes",
  kindName: "KWOKNodeClass",
  namespaced: false,
  optional: true,
  columns: [{ id: "ready", title: "Ready", grow: 0.6, value: readyCell }],
  sections: conditionsGrid,
});

const NODE_CLASS_IDS: Record<string, string> = {
  EC2NodeClass: ec2nodeclasses.id,
  AKSNodeClass: aksnodeclasses.id,
  KWOKNodeClass: kwoknodeclasses.id,
};

export const KARPENTER_KINDS: ResourceDescriptor[] = [nodepools, nodeclaims, ec2nodeclasses, aksnodeclasses, kwoknodeclasses];

// ---------- Nodes ----------

/** The Karpenter part of the details of a node it manages; nothing for the other nodes. */
export async function nodeKarpenterSection(node: KubeObject, ctx: DetailContext): Promise<DetailSection[]> {
  const labels = node.metadata.labels ?? {};
  const pool = labels[NODEPOOL_LABEL];
  if (!pool) return [];
  let claim = node.metadata.ownerReferences?.find((r) => r.kind === "NodeClaim")?.name;
  if (!claim) {
    const claims = await ctx.list("karpenter:nodeclaims", { namespaces: [], labelSelector: `${NODEPOOL_LABEL}=${pool}` }).catch(() => []);
    claim = claims.find((c) => c.status?.nodeName === node.metadata.name)?.metadata.name;
  }
  const lifecycle = [
    labels["karpenter.sh/registered"] === "true" && "Registered",
    labels["karpenter.sh/initialized"] === "true" && "Initialized",
  ]
    .filter(Boolean)
    .join(", ");
  const disrupting = (node.spec?.taints ?? []).some((t: Taint) => DISRUPTION_TAINTS.includes(t.key));
  const doNotDisrupt = node.metadata.annotations?.["karpenter.sh/do-not-disrupt"] === "true";
  const items: DetailItem[] = [
    { name: "Node Pool", value: nodePoolLink(pool) },
    { name: "Node Claim", value: claim ? { link: claim, ref: { resource: nodeclaims.id, name: claim } } : "" },
    { name: "Instance Type", value: labels[INSTANCE_TYPE_LABEL] ?? "" },
    {
      name: "Capacity Type",
      value: labels[CAPACITY_TYPE_LABEL] === "spot" ? "Spot" : labels[CAPACITY_TYPE_LABEL] === "on-demand" ? "On-Demand" : "",
    },
    { name: "Zone", value: labels[ZONE_LABEL] ?? "" },
    { name: "Lifecycle", value: lifecycle },
    { name: "Disruption", value: disrupting ? text("Being disrupted", "warning") : doNotDisrupt ? "Do not disrupt" : "" },
  ].filter((i) => i.value !== "");
  return [
    { type: "title", text: "Karpenter" },
    { type: "items", items },
  ];
}
