// Usage charts of the drawer: Prometheus range queries when the cluster has a Prometheus, otherwise the
// metrics-server samples collected while KubeXplorer runs (shared by every tab).

import type { KubeClient } from "../kube/client";
import type { MetricsBackend } from "../kube/prometheus";
import { cpuMillis, memoryBytes } from "../kube/quantity";
import { errorMessage, type KubeObject, type Logger } from "../kube/types";
import { historyCharts, type MetricsScope, metricsQueries, prometheusCharts, type Series } from "../resources/charts";
import type { ResourceRegistry } from "../resources/registry";
import type { MetricsData } from "../shared/view";

/** The charts show the last hour. */
const RANGE_S = 3600;
const STEP_S = 60;
/** Samples taken in the same window are merged (several tabs may receive the same metrics list). */
const SAMPLE_S = 10;

interface Sample {
  t: number;
  cpu: number; // cores
  memory: number; // bytes
}

/** metrics-server samples of the last hour, per pod and node. */
export class MetricsHistory {
  private readonly samples = new Map<string, Sample[]>();

  private static key(context: string, kind: "pod" | "node", namespace: string | undefined, name: string): string {
    return `${context}|${kind}|${namespace ?? ""}/${name}`;
  }

  private add(key: string, sample: Sample): void {
    let list = this.samples.get(key);
    if (!list) this.samples.set(key, (list = []));
    if (list.at(-1)?.t === sample.t) list[list.length - 1] = sample;
    else list.push(sample);
  }

  /** Forgets the samples older than the charts, and the objects that have none left (deleted pods). */
  private prune(t: number): void {
    for (const [key, list] of this.samples) {
      while (list.length && list[0].t < t - RANGE_S) list.shift();
      if (!list.length) this.samples.delete(key);
    }
  }

  /** Records a list of PodMetrics or NodeMetrics objects. */
  record(context: string, items: KubeObject[], now = Date.now()): void {
    const t = Math.round(now / 1000 / SAMPLE_S) * SAMPLE_S;
    for (const m of items) {
      if (m.kind === "NodeMetrics" || m.usage) {
        this.add(MetricsHistory.key(context, "node", undefined, m.metadata.name), {
          t,
          cpu: cpuMillis(m.usage?.cpu) / 1000,
          memory: memoryBytes(m.usage?.memory),
        });
      } else {
        const containers: { usage?: { cpu?: string; memory?: string } }[] = m.containers ?? [];
        this.add(MetricsHistory.key(context, "pod", m.metadata.namespace, m.metadata.name), {
          t,
          cpu: containers.reduce((n, c) => n + (cpuMillis(c.usage?.cpu) || 0), 0) / 1000,
          memory: containers.reduce((n, c) => n + (memoryBytes(c.usage?.memory) || 0), 0),
        });
      }
    }
    this.prune(t);
  }

  /** The samples of a scope; the samples of several pods are summed per sampling window. */
  series(context: string, scope: MetricsScope): { cpu: Series; memory: Series } {
    const keys =
      scope.kind === "node"
        ? [MetricsHistory.key(context, "node", undefined, scope.node.metadata.name)]
        : scope.pods.map((p) => MetricsHistory.key(context, "pod", scope.namespace, p.metadata.name));
    const sums = new Map<number, { cpu: number; memory: number }>();
    for (const key of keys) {
      for (const s of this.samples.get(key) ?? []) {
        const sum = sums.get(s.t) ?? { cpu: 0, memory: 0 };
        sum.cpu += s.cpu;
        sum.memory += s.memory;
        sums.set(s.t, sum);
      }
    }
    const times = [...sums.keys()].sort((a, b) => a - b);
    return { cpu: times.map((t) => [t, sums.get(t)!.cpu]), memory: times.map((t) => [t, sums.get(t)!.memory]) };
  }
}

export interface MetricsServiceDeps {
  backend?: MetricsBackend;
  client: KubeClient;
  registry: ResourceRegistry;
  history: MetricsHistory;
  log: Logger;
}

export class MetricsService {
  constructor(private readonly d: MetricsServiceDeps) {}

  get history(): MetricsHistory {
    return this.d.history;
  }

  async load(context: string, scope: MetricsScope, now = Date.now()): Promise<MetricsData> {
    if (scope.kind === "pods" && !scope.pods.length) return { source: "", charts: [], note: "No pod" };
    let prometheusError: string | undefined;
    if (this.d.backend) {
      const end = Math.floor(now / 1000);
      try {
        const r = await this.d.backend.queryRange(context, metricsQueries(scope), { start: end - RANGE_S, end, step: STEP_S });
        if (r) return prometheusCharts(scope, r.results, r.source);
      } catch (err) {
        prometheusError = errorMessage(err).split("\n")[0];
        this.d.log.warn(`Prometheus queries on ${context}: ${prometheusError}`);
      }
    }
    await this.sample(context, scope, now);
    return historyCharts(scope, this.d.history.series(context, scope), prometheusError);
  }

  /** Takes a metrics-server sample of the scope now (in addition to the samples of the open lists). */
  private async sample(context: string, scope: MetricsScope, now: number): Promise<void> {
    try {
      const items =
        scope.kind === "node"
          ? await this.d.client.list(context, this.d.registry.require("nodemetrics"), {
              namespaces: [],
              fieldSelector: `metadata.name=${scope.node.metadata.name}`,
            })
          : (await this.d.client.list(context, this.d.registry.require("podmetrics"), { namespaces: [scope.namespace] })).filter((m) =>
              scope.pods.some((p) => p.metadata.name === m.metadata.name),
            );
      this.d.history.record(context, items, now);
    } catch {
      // No metrics-server: the charts stay empty, with their note.
    }
  }
}
