// The Freelens side menu, rendered by the Resources view, with the menus of the Flux and Karpenter
// extensions of Freelens, shown when their CRDs are installed.

import type { PanelTarget } from "../shared/protocol";

export interface MenuEntry {
  id: string;
  label: string;
  /** VS Code codicon. */
  icon?: string;
  /** Resource type to open; "overview" opens the cluster overview, "overview:<page>" another overview page. */
  open?: string;
  children?: MenuEntry[];
  /** Children discovered at runtime (CRDs). */
  dynamic?: "crds";
}

/** The tab an `open` value opens. */
export function menuTarget(open: string): PanelTarget {
  if (open === "overview") return { kind: "overview" };
  if (open.startsWith("overview:")) return { kind: "overview", page: open.slice("overview:".length) };
  return { kind: "list", resource: open };
}

/** The `open` value of a tab (to select its menu entry). */
export function menuOpen(target: PanelTarget): string {
  if (target.kind === "list") return target.resource;
  return target.page ? `overview:${target.page}` : "overview";
}

const entry = (id: string, label: string): MenuEntry => ({ id, label, open: id });

export const MENU: MenuEntry[] = [
  { id: "cluster", label: "Cluster", icon: "dashboard", open: "overview" },
  { id: "diagnostics", label: "Diagnostics", icon: "checklist", open: "overview:diagnostics" },
  { id: "nodes", label: "Nodes", icon: "server", open: "nodes" },
  {
    id: "workloads",
    label: "Workloads",
    icon: "package",
    children: [
      { id: "overview", label: "Overview", open: "overview" },
      { id: "pods", label: "Pods", open: "pods" },
      { id: "deployments", label: "Deployments", open: "deployments" },
      { id: "daemonsets", label: "Daemon Sets", open: "daemonsets" },
      { id: "statefulsets", label: "Stateful Sets", open: "statefulsets" },
      { id: "replicasets", label: "Replica Sets", open: "replicasets" },
      { id: "jobs", label: "Jobs", open: "jobs" },
      { id: "cronjobs", label: "Cron Jobs", open: "cronjobs" },
    ],
  },
  {
    id: "config",
    label: "Config",
    icon: "settings",
    children: [
      { id: "configmaps", label: "Config Maps", open: "configmaps" },
      { id: "secrets", label: "Secrets", open: "secrets" },
      { id: "resourcequotas", label: "Resource Quotas", open: "resourcequotas" },
      { id: "limitranges", label: "Limit Ranges", open: "limitranges" },
      { id: "horizontalpodautoscalers", label: "Horizontal Pod Autoscalers", open: "horizontalpodautoscalers" },
      { id: "poddisruptionbudgets", label: "Pod Disruption Budgets", open: "poddisruptionbudgets" },
      { id: "priorityclasses", label: "Priority Classes", open: "priorityclasses" },
      { id: "runtimeclasses", label: "Runtime Classes", open: "runtimeclasses" },
      { id: "leases", label: "Leases", open: "leases" },
      { id: "mutatingwebhookconfigurations", label: "Mutating Webhook Configs", open: "mutatingwebhookconfigurations" },
      { id: "validatingwebhookconfigurations", label: "Validating Webhook Configs", open: "validatingwebhookconfigurations" },
    ],
  },
  {
    id: "network",
    label: "Network",
    icon: "globe",
    children: [
      { id: "services", label: "Services", open: "services" },
      { id: "endpoints", label: "Endpoints", open: "endpoints" },
      { id: "ingresses", label: "Ingresses", open: "ingresses" },
      { id: "ingressclasses", label: "Ingress Classes", open: "ingressclasses" },
      { id: "networkpolicies", label: "Network Policies", open: "networkpolicies" },
      { id: "portforwards", label: "Port Forwarding", open: "portforwards" },
    ],
  },
  {
    id: "storage",
    label: "Storage",
    icon: "database",
    children: [
      { id: "persistentvolumeclaims", label: "Persistent Volume Claims", open: "persistentvolumeclaims" },
      { id: "persistentvolumes", label: "Persistent Volumes", open: "persistentvolumes" },
      { id: "storageclasses", label: "Storage Classes", open: "storageclasses" },
    ],
  },
  { id: "namespaces", label: "Namespaces", icon: "layers", open: "namespaces" },
  { id: "events", label: "Events", icon: "history", open: "events" },
  {
    id: "helm",
    label: "Helm",
    icon: "rocket",
    children: [
      { id: "helmcharts", label: "Charts", open: "helmcharts" },
      { id: "helmreleases", label: "Releases", open: "helmreleases" },
    ],
  },
  {
    id: "flux",
    label: "Flux",
    icon: "sync",
    children: [
      { id: "flux-overview", label: "Overview", open: "overview:flux" },
      {
        id: "flux-operator",
        label: "Operator",
        children: [
          entry("flux:fluxinstances", "Flux Instances"),
          entry("flux:fluxreports", "Flux Reports"),
          entry("flux:resourcesets", "Resource Sets"),
          entry("flux:resourcesetinputproviders", "Input Providers"),
        ],
      },
      entry("flux:kustomizations", "Kustomizations"),
      entry("flux:helmreleases", "Helm Releases"),
      {
        id: "flux-sources",
        label: "Sources",
        children: [
          entry("flux:gitrepositories", "Git Repositories"),
          entry("flux:ocirepositories", "OCI Repositories"),
          entry("flux:helmrepositories", "Helm Repositories"),
          entry("flux:helmcharts", "Helm Charts"),
          entry("flux:buckets", "Buckets"),
          entry("flux:externalartifacts", "External Artifacts"),
          entry("flux:artifactgenerators", "Artifact Generators"),
        ],
      },
      {
        id: "flux-image",
        label: "Image Automation",
        children: [
          entry("flux:imagerepositories", "Image Repositories"),
          entry("flux:imagepolicies", "Image Policies"),
          entry("flux:imageupdateautomations", "Image Update Automations"),
        ],
      },
      {
        id: "flux-notifications",
        label: "Notifications",
        children: [entry("flux:alerts", "Alerts"), entry("flux:providers", "Providers"), entry("flux:receivers", "Receivers")],
      },
    ],
  },
  {
    id: "karpenter",
    label: "Karpenter",
    icon: "server-environment",
    children: [
      { id: "karpenter-overview", label: "Overview", open: "overview:karpenter" },
      entry("karpenter:nodepools", "Node Pools"),
      entry("karpenter:nodeclaims", "Node Claims"),
      entry("karpenter:ec2nodeclasses", "EC2 Node Classes"),
      entry("karpenter:aksnodeclasses", "AKS Node Classes"),
      entry("karpenter:kwoknodeclasses", "KWOK Node Classes"),
    ],
  },
  {
    id: "access",
    label: "Access Control",
    icon: "shield",
    children: [
      { id: "serviceaccounts", label: "Service Accounts", open: "serviceaccounts" },
      { id: "clusterroles", label: "Cluster Roles", open: "clusterroles" },
      { id: "roles", label: "Roles", open: "roles" },
      { id: "clusterrolebindings", label: "Cluster Role Bindings", open: "clusterrolebindings" },
      { id: "rolebindings", label: "Role Bindings", open: "rolebindings" },
    ],
  },
  {
    id: "crds",
    label: "Custom Resources",
    icon: "extensions",
    dynamic: "crds",
    children: [{ id: "customresourcedefinitions", label: "Definitions", open: "customresourcedefinitions" }],
  },
];

/**
 * The menu without the entries whose resource is not available: `available(open)` tells whether a resource
 * type can be listed (its CRD is installed). A section is kept when one of its resources is; its overview
 * pages follow it.
 */
export function filterMenu(entries: MenuEntry[], available: (open: string) => boolean): MenuEntry[] {
  return entries.flatMap((e) => {
    if (!e.children) return !e.open || e.open.startsWith("overview") || available(e.open) ? [e] : [];
    const children = filterMenu(e.children, available);
    const listed = children.some((c) => c.children || (c.open && !c.open.startsWith("overview")));
    return listed || e.dynamic ? [{ ...e, children }] : [];
  });
}

/** Every entry that can be opened (for the "Open Resource..." QuickPick). */
export function flattenMenu(entries: MenuEntry[] = MENU, parent?: string): { label: string; detail?: string; open: string }[] {
  return entries.flatMap((e) => [
    ...(e.open ? [{ label: e.label, detail: parent, open: e.open }] : []),
    ...(e.children ? flattenMenu(e.children, e.label) : []),
  ]);
}
