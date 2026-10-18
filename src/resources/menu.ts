// The Freelens side menu, rendered by the Resources view.

export interface MenuEntry {
  id: string;
  label: string;
  /** VS Code codicon. */
  icon?: string;
  /** Resource type to open; "overview" opens the cluster overview. */
  open?: string;
  children?: MenuEntry[];
  /** Children discovered at runtime (CRDs). */
  dynamic?: "crds";
}

export const MENU: MenuEntry[] = [
  { id: "cluster", label: "Cluster", icon: "dashboard", open: "overview" },
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

/** Every entry that can be opened (for the "Open Resource..." QuickPick). */
export function flattenMenu(entries: MenuEntry[] = MENU, parent?: string): { label: string; detail?: string; open: string }[] {
  return entries.flatMap((e) => [
    ...(e.open ? [{ label: e.label, detail: parent, open: e.open }] : []),
    ...(e.children ? flattenMenu(e.children, e.label) : []),
  ]);
}
