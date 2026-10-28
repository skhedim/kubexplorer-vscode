// The Flux object that applies an object, from the labels kustomize-controller and helm-controller put on what they
// apply. A change made directly on such an object is undone at the next reconciliation, unless that Flux object is
// suspended: the drawer links to it, and changes warn first (src/vscode/fluxGuard.ts).

import type { KubeObject } from "../kube/types";

export interface FluxOwner {
  /** Registry identifier of its kind. */
  resource: "flux:kustomizations" | "flux:helmreleases";
  kind: "Kustomization" | "HelmRelease";
  namespace: string;
  name: string;
}

const OWNERS = [
  // A HelmRelease first: what it installs may also carry the labels of the Kustomization that applied the HelmRelease.
  { prefix: "helm.toolkit.fluxcd.io", resource: "flux:helmreleases", kind: "HelmRelease" },
  { prefix: "kustomize.toolkit.fluxcd.io", resource: "flux:kustomizations", kind: "Kustomization" },
] as const;

export function fluxOwner(o: KubeObject): FluxOwner | undefined {
  const labels = o.metadata.labels ?? {};
  for (const { prefix, resource, kind } of OWNERS) {
    const name = labels[`${prefix}/name`];
    if (name) return { resource, kind, name, namespace: labels[`${prefix}/namespace`] ?? o.metadata.namespace ?? "flux-system" };
  }
  return undefined;
}

export function ownerLabel(owner: FluxOwner): string {
  return `${owner.kind} ${owner.namespace}/${owner.name}`;
}
