// Registry of resource types: built-in ones plus CRDs discovered at runtime.

import type { KubeObject } from "../kube/types";
import { clusterrolebindings, clusterroles, rolebindings, roles, serviceaccounts } from "./access";
import { events, namespaces, nodes } from "./cluster";
import {
  configmaps,
  horizontalpodautoscalers,
  leases,
  limitranges,
  mutatingwebhooks,
  poddisruptionbudgets,
  priorityclasses,
  resourcequotas,
  runtimeclasses,
  secrets,
  validatingwebhooks,
} from "./config";
import { crdDescriptor, crdResourceId, customresourcedefinitions } from "./crd";
import type { ResourceDescriptor } from "./descriptor";
import { helmcharts, helmreleases } from "./helm";
import { nodemetrics, podmetrics } from "./metrics";
import { portforwards } from "./portForwards";
import { endpoints, ingressclasses, ingresses, networkpolicies, services } from "./network";
import { pods } from "./pods";
import { persistentvolumeclaims, persistentvolumes, storageclasses } from "./storage";
import { cronjobs, daemonsets, deployments, jobs, replicasets, statefulsets } from "./workloads";

const BUILT_IN: ResourceDescriptor[] = [
  nodes,
  namespaces,
  events,
  pods,
  deployments,
  daemonsets,
  statefulsets,
  replicasets,
  jobs,
  cronjobs,
  configmaps,
  secrets,
  resourcequotas,
  limitranges,
  horizontalpodautoscalers,
  poddisruptionbudgets,
  priorityclasses,
  runtimeclasses,
  leases,
  mutatingwebhooks,
  validatingwebhooks,
  services,
  endpoints,
  ingresses,
  ingressclasses,
  networkpolicies,
  portforwards,
  persistentvolumeclaims,
  persistentvolumes,
  storageclasses,
  serviceaccounts,
  clusterroles,
  roles,
  clusterrolebindings,
  rolebindings,
  customresourcedefinitions,
  helmcharts,
  helmreleases,
  podmetrics,
  nodemetrics,
];

export class ResourceRegistry {
  private readonly byId = new Map<string, ResourceDescriptor>(BUILT_IN.map((d) => [d.id, d]));

  get(id: string): ResourceDescriptor | undefined {
    return this.byId.get(id);
  }

  require(id: string): ResourceDescriptor {
    const d = this.byId.get(id);
    if (!d) throw new Error(`Unknown resource type: ${id}`);
    return d;
  }

  /** Registers (or updates) the descriptor of a CRD and returns its identifier. */
  registerCrd(crd: KubeObject): string {
    const id = crdResourceId(crd);
    this.byId.set(id, crdDescriptor(crd));
    return id;
  }

  all(): ResourceDescriptor[] {
    return [...this.byId.values()];
  }
}
