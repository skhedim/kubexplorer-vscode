// The CRDs installed on each cluster, cached briefly: menus and overview pages show the integrations
// (Flux, Karpenter) only when their CRDs exist.

import type { KubeClient } from "./client";
import type { KindTarget, KubeObject } from "./types";

const CRDS: KindTarget = { kubectlName: "customresourcedefinitions.apiextensions.k8s.io", namespaced: false };
const TTL_MS = 60_000;

/** "<plural>.<group>": the kubectl name of the kind a CRD defines. */
export function crdKindName(crd: KubeObject): string {
  return `${crd.spec?.names?.plural}.${crd.spec?.group}`;
}

export class CrdCatalog {
  private readonly cache = new Map<string, { at: number; crds: Promise<KubeObject[]> }>();

  constructor(private readonly client: Pick<KubeClient, "list">) {}

  list(context: string): Promise<KubeObject[]> {
    const hit = this.cache.get(context);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.crds;
    const crds = this.client.list(context, CRDS, { namespaces: [] });
    this.cache.set(context, { at: Date.now(), crds });
    // A failure is not cached: the next call tries again.
    crds.catch(() => this.cache.get(context)?.crds === crds && this.cache.delete(context));
    return crds;
  }

  /** kubectl names of the installed kinds; empty when the CRDs cannot be listed. */
  async kindNames(context: string): Promise<Set<string>> {
    try {
      return new Set((await this.list(context)).map(crdKindName));
    } catch {
      return new Set();
    }
  }

  invalidate(): void {
    this.cache.clear();
  }
}
