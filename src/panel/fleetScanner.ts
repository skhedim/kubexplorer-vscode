// Reads the clusters of the fleet, a bounded number at a time, and keeps a compact summary of each.
// - Scan: one request per cluster for its nodes and Flux objects (kubectl get a,b,c), plus the versions of the Flux
//   controllers, read again only every COMPONENTS_TTL_MS (they rarely change).
// - Diagnostics and search: on demand only, as they read more (pods, workloads…).
// Nothing runs on its own: the Fleet tab asks for scans while it is visible. VS Code-agnostic, unit tested.

import type { KubeClient, NamedKind } from "../kube/client";
import { errorMessage, type Disposable, type KubeObject, type Logger } from "../kube/types";
import { diagnose, diagnosticsPage } from "../resources/diagnostics";
import {
  type ClusterScan,
  FLEET_FLUX_KINDS,
  fluxComponents,
  SEARCH_KINDS,
  type SearchHit,
  searchFlux,
  summarizeCluster,
  summarizeDiagnostics,
} from "../resources/fleet";
import type { ResourceRegistry } from "../resources/registry";
import { forEachLimited } from "../shared/pool";

export interface FleetMember {
  context: string;
  group: string;
}

export interface FleetScannerDeps {
  client: KubeClient;
  registry: ResourceRegistry;
  /** The clusters of the fleet, in display order. */
  members(): FleetMember[];
  /** Clusters read at the same time. */
  concurrency(): number;
  log: Logger;
  now?: () => number;
}

export interface FleetProgress {
  label: string;
  done: number;
  total: number;
}

/** Versions of the Flux controllers are read again after… */
const COMPONENTS_TTL_MS = 10 * 60_000;
/** Kinds of the fleet diagnostics: ConfigMaps and Secrets are left out, as they can be large (dashboards, Helm releases). */
const DIAGNOSTIC_KINDS = diagnosticsPage.resources.filter((r) => r !== "configmaps" && r !== "secrets");
/** Hits kept by a search, at most. */
export const MAX_HITS = 2000;

export class FleetScanner {
  private readonly scans = new Map<string, ClusterScan>();
  private readonly listeners = new Set<() => void>();
  private readonly componentsAt = new Map<string, number>();
  private scanning?: Promise<void>;
  private searchGeneration = 0;
  private diagnosing?: Promise<void>;
  /** Operations in progress, by kind. */
  private readonly progress = new Map<string, FleetProgress>();

  constructor(private readonly d: FleetScannerDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** The summary of every member, pending for those never scanned. */
  list(): ClusterScan[] {
    return this.d.members().map(({ context, group }) => {
      const scan = this.scans.get(context);
      return scan ? (scan.group === group ? scan : { ...scan, group }) : { context, group, status: "pending" };
    });
  }

  get(context: string): ClusterScan | undefined {
    return this.scans.get(context);
  }

  /** Operations in progress (scan, diagnostics, search). */
  activity(): FleetProgress[] {
    return [...this.progress.values()];
  }

  /** End of the oldest scan of the members, undefined while one was never scanned. */
  oldestScan(): number | undefined {
    const ats = this.list().map((s) => s.at);
    return ats.some((a) => a === undefined) ? undefined : Math.min(...(ats as number[]));
  }

  private kinds(ids: readonly string[]): NamedKind[] {
    return ids.map((id) => {
      const d = this.d.registry.require(id);
      return { kubectlName: d.kubectlName, namespaced: d.namespaced, kindName: d.kindName };
    });
  }

  private update(context: string, patch: Partial<ClusterScan>): void {
    // The group is looked up once per cluster (members() matches every context against the group patterns).
    const previous = this.scans.get(context) ?? {
      context,
      group: this.d.members().find((m) => m.context === context)?.group ?? "",
      status: "pending" as const,
    };
    this.scans.set(context, { ...previous, ...patch });
  }

  /** Runs `task` on clusters, a bounded number at a time, reporting its progress. */
  private async run(
    key: string,
    label: string,
    contexts: string[],
    limit: number,
    task: (context: string) => Promise<void>,
    cancelled?: () => boolean,
  ): Promise<void> {
    const progress: FleetProgress = { label, done: 0, total: contexts.length };
    this.progress.set(key, progress);
    this.changed();
    try {
      await forEachLimited(
        contexts,
        limit,
        async (context) => {
          await task(context);
          progress.done++;
          this.changed();
        },
        cancelled,
      );
    } finally {
      if (this.progress.get(key) === progress) this.progress.delete(key);
      this.changed();
    }
  }

  /** Scans the given clusters (every member by default); a scan in progress is joined rather than doubled. */
  scan(contexts?: string[]): Promise<void> {
    if (this.scanning) return this.scanning;
    const targets = contexts ?? this.d.members().map((m) => m.context);
    this.scanning = this.run("scan", "Scanning", targets, this.d.concurrency(), (c) => this.scanOne(c)).finally(
      () => (this.scanning = undefined),
    );
    return this.scanning;
  }

  private async scanOne(context: string): Promise<void> {
    const started = this.now();
    this.update(context, { scanning: true });
    this.changed();
    try {
      const fluxKinds = this.kinds(FLEET_FLUX_KINDS);
      const [nodesKind] = this.kinds(["nodes"]);
      const { items, missing } = await this.d.client.listMany(context, [nodesKind, ...fluxKinds]);
      const flux: Record<string, { kind: string; items: KubeObject[] } | undefined> = {};
      FLEET_FLUX_KINDS.forEach((id, i) => {
        const k = fluxKinds[i];
        if (!missing.includes(k.kubectlName)) flux[id] = { kind: k.kindName, items: items[k.kubectlName] ?? [] };
      });
      const summary = summarizeCluster({ nodes: items[nodesKind.kubectlName], flux });
      let components = this.scans.get(context)?.flux?.components;
      if (summary.flux?.installed && (!components || this.now() - (this.componentsAt.get(context) ?? 0) > COMPONENTS_TTL_MS)) {
        const [deploymentsKind] = this.kinds(["deployments"]);
        const deployments = await this.d.client.listMany(context, [deploymentsKind], { namespace: "flux-system" });
        components = fluxComponents(deployments.items[deploymentsKind.kubectlName] ?? []);
        this.componentsAt.set(context, this.now());
      }
      this.update(context, {
        ...summary,
        flux: { installed: !!summary.flux?.installed, components: summary.flux?.installed ? components : undefined },
        status: "ok",
        error: undefined,
        scanning: false,
        at: this.now(),
        ms: this.now() - started,
      });
    } catch (err) {
      const error = errorMessage(err).split("\n")[0];
      this.d.log.warn(`Fleet: cannot scan ${context}: ${error}`);
      this.update(context, { status: "error", error, scanning: false });
    }
  }

  /** Runs the diagnostics of the given clusters (heavier: half the concurrency). */
  diagnose(contexts: string[]): Promise<void> {
    if (this.diagnosing) return this.diagnosing;
    const limit = Math.max(1, Math.floor(this.d.concurrency() / 2));
    this.diagnosing = this.run("diagnose", "Diagnosing", contexts, limit, (c) => this.diagnoseOne(c)).finally(
      () => (this.diagnosing = undefined),
    );
    return this.diagnosing;
  }

  private async diagnoseOne(context: string): Promise<void> {
    try {
      const kinds = this.kinds(DIAGNOSTIC_KINDS);
      const { items } = await this.d.client.listMany(context, kinds);
      const lists = Object.fromEntries(DIAGNOSTIC_KINDS.map((id, i) => [id, items[kinds[i].kubectlName]]));
      this.update(context, { diagnostics: summarizeDiagnostics(diagnose({ lists, errors: {} }, this.now()), this.now()) });
    } catch (err) {
      const previous = this.scans.get(context)?.diagnostics;
      this.update(context, {
        diagnostics: {
          at: this.now(),
          counts: previous?.counts ?? { error: 0, warning: 0, info: 0 },
          problems: previous?.problems ?? [],
          error: errorMessage(err).split("\n")[0],
        },
      });
    }
  }

  /**
   * Searches the given clusters; hits arrive cluster by cluster. A new search cancels the previous one.
   * Flux objects are searched in the summaries of the scans, without asking the clusters.
   */
  async search(contexts: string[], kindId: string, query: string, onHits: (hits: SearchHit[]) => void): Promise<void> {
    const generation = ++this.searchGeneration;
    const kind = SEARCH_KINDS.find((k) => k.id === kindId);
    if (!kind) return;
    if (!kind.resources.length) {
      onHits(
        searchFlux(
          this.list().filter((s) => contexts.includes(s.context)),
          query,
        ).slice(0, MAX_HITS),
      );
      return;
    }
    const cancelled = () => generation !== this.searchGeneration;
    let found = 0;
    const kinds = this.kinds(kind.resources);
    await this.run(
      "search",
      "Searching",
      contexts,
      this.d.concurrency(),
      async (context) => {
        try {
          const { items } = await this.d.client.listMany(context, kinds);
          if (cancelled() || found >= MAX_HITS) return;
          const hits: SearchHit[] = [];
          kind.resources.forEach((resource, i) => {
            for (const o of items[kinds[i].kubectlName] ?? []) {
              const detail = kind.match(o, query);
              if (detail !== undefined)
                hits.push({ context, resource, kind: kinds[i].kindName, namespace: o.metadata.namespace, name: o.metadata.name, detail });
            }
          });
          found += hits.length;
          onHits(hits);
        } catch (err) {
          if (!cancelled())
            onHits([{ context, resource: "", kind: "", name: "", detail: errorMessage(err).split("\n")[0], tone: "error" }]);
        }
      },
      cancelled,
    );
  }
}
