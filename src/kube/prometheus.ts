// Prometheus, for the usage charts: found among the services of the cluster (or set in the settings),
// and queried through the API server service proxy, so that no port forward is needed.

import type { KubeClient } from "./client";
import { DEMO_CONTEXT } from "./demo";
import { errorMessage, type KindTarget, type KubeObject, type Logger } from "./types";

export interface TimeRange {
  /** Unix seconds. */
  start: number;
  end: number;
  step: number;
}

export interface RangeResults {
  /** Shown under the charts, e.g. "Prometheus monitoring/prometheus-server". */
  source: string;
  /** [unix seconds, value] points of each query (the first series of its result). */
  results: Record<string, [number, number][]>;
}

export interface MetricsBackend {
  /** Runs range queries; undefined when the cluster has no Prometheus (the caller falls back to metrics-server). */
  queryRange(context: string, queries: Record<string, string>, range: TimeRange): Promise<RangeResults | undefined>;
  /** Forgets the detected services (e.g. after a refresh). */
  invalidate(): void;
}

export interface PrometheusService {
  namespace: string;
  name: string;
  port: string;
}

/** The setting: "" detects, "off" disables, "namespace/service:port" sets the service. */
export function parsePrometheusSetting(value: string): PrometheusService | "off" | "auto" {
  const v = value.trim();
  if (!v) return "auto";
  if (v.toLowerCase() === "off") return "off";
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)(?::([\w-]+))?$/.exec(v);
  if (!m) throw new Error(`Invalid kubexplorer.prometheus setting "${value}": expected namespace/service:port, "off" or empty`);
  return { namespace: m[1], name: m[2], port: m[3] ?? "9090" };
}

interface ServicePortLike {
  name?: string;
  port: number;
}

/** The services of the common Prometheus installations, best first. */
const KNOWN_SERVICES: [RegExp, number][] = [
  [/^prometheus-operated$/, 100], // Prometheus Operator, kube-prometheus-stack
  [/-kube-prometheus-prometheus$|^kube-prometheus-stack-prometheus$/, 90],
  [/^prometheus-k8s$/, 85], // kube-prometheus, OpenShift
  [/^prometheus-server$/, 80], // prometheus-community/prometheus chart
  [/^prometheus$/, 70],
];
const NOT_PROMETHEUS = /alertmanager|pushgateway|node-exporter|operator|kube-state-metrics|adapter|blackbox|thanos/;

/** Picks the Prometheus service of a cluster, if any. */
export function pickPrometheus(services: KubeObject[]): PrometheusService | undefined {
  let best: { service: KubeObject; score: number } | undefined;
  for (const service of services) {
    const name = service.metadata.name;
    if (NOT_PROMETHEUS.test(name)) continue;
    const labels = service.metadata.labels ?? {};
    let score = KNOWN_SERVICES.find(([re]) => re.test(name))?.[1] ?? 0;
    if (!score && (labels["app.kubernetes.io/name"] === "prometheus" || labels.app === "prometheus")) score = 60;
    if (!score && name.includes("prometheus")) score = 10;
    if (score && (!best || score > best.score)) best = { service, score };
  }
  if (!best) return undefined;
  const ports: ServicePortLike[] = best.service.spec?.ports ?? [];
  const port =
    ports.find((p) => p.name === "web" || p.name === "http-web" || p.name === "http") ??
    ports.find((p) => p.port === 9090) ??
    ports.find((p) => p.port === 80) ??
    ports[0];
  return { namespace: best.service.metadata.namespace ?? "default", name: best.service.metadata.name, port: String(port?.port ?? 9090) };
}

const SERVICES: KindTarget = { kubectlName: "services", namespaced: true };
const DETECTION_TTL_MS = 5 * 60_000;

interface PrometheusResponse {
  status: string;
  error?: string;
  data?: { result?: { values?: [number, string][] }[] };
}

export class PrometheusClient implements MetricsBackend {
  private readonly detected = new Map<string, { at: number; service: Promise<PrometheusService | undefined> }>();

  constructor(
    private readonly client: Pick<KubeClient, "list" | "getRaw">,
    private readonly setting: () => string,
    private readonly log: Logger,
  ) {}

  private service(context: string): Promise<PrometheusService | undefined> {
    const setting = parsePrometheusSetting(this.setting());
    if (setting === "off") return Promise.resolve(undefined);
    if (setting !== "auto") return Promise.resolve(setting);
    const hit = this.detected.get(context);
    if (hit && Date.now() - hit.at < DETECTION_TTL_MS) return hit.service;
    const service = this.client.list(context, SERVICES, { namespaces: [] }).then(
      (services) => {
        const found = pickPrometheus(services);
        this.log.info(
          found ? `Prometheus of ${context}: ${found.namespace}/${found.name}:${found.port}` : `No Prometheus found on ${context}`,
        );
        return found;
      },
      (err) => {
        this.log.warn(`Prometheus detection on ${context}: ${errorMessage(err)}`);
        return undefined;
      },
    );
    this.detected.set(context, { at: Date.now(), service });
    return service;
  }

  async queryRange(context: string, queries: Record<string, string>, range: TimeRange): Promise<RangeResults | undefined> {
    const svc = await this.service(context);
    if (!svc) return undefined;
    const base = `/api/v1/namespaces/${svc.namespace}/services/${svc.name}:${svc.port}/proxy/api/v1/query_range`;
    const entries = await Promise.all(
      Object.entries(queries).map(async ([key, query]) => {
        const params = new URLSearchParams({ query, start: String(range.start), end: String(range.end), step: String(range.step) });
        const response = JSON.parse(await this.client.getRaw(context, `${base}?${params}`)) as PrometheusResponse;
        if (response.status !== "success") throw new Error(response.error ?? "Prometheus query failed");
        const values = response.data?.result?.[0]?.values ?? [];
        return [key, values.map(([t, v]): [number, number] => [t, Number(v)]).filter(([, v]) => Number.isFinite(v))] as const;
      }),
    );
    return { source: `Prometheus ${svc.namespace}/${svc.name}`, results: Object.fromEntries(entries) };
  }

  invalidate(): void {
    this.detected.clear();
  }
}

/** Synthetic range results for the demo cluster: smooth, stable series derived from the query. */
export class DemoMetrics implements MetricsBackend {
  async queryRange(_context: string, queries: Record<string, string>, range: TimeRange): Promise<RangeResults> {
    const results: RangeResults["results"] = {};
    for (const [key, query] of Object.entries(queries)) {
      const seed = [...query].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
      const node = query.includes('id="/"');
      const base = query.includes("cpu")
        ? 0.02 + (seed % 300) / 1000
        : query.includes("network")
          ? 2_000 + (seed % 60_000)
          : query.includes("fs_limit")
            ? 100 * 2 ** 30
            : 40 * 2 ** 20 + (seed % 400) * 2 ** 20;
      const scale = node && !query.includes("fs_limit") ? 12 : 1;
      const points: [number, number][] = [];
      for (let t = range.start; t <= range.end; t += range.step) {
        const wave = 0.75 + 0.15 * Math.sin(t / 600 + (seed % 7)) + 0.1 * Math.sin(t / 97 + (seed % 3));
        points.push([t, base * scale * (query.includes("fs_limit") ? 1 : wave)]);
      }
      results[key] = points;
    }
    return { source: "demo metrics", results };
  }

  invalidate(): void {}
}

/** The demo cluster gets synthetic metrics, the others Prometheus. */
export class MetricsRouter implements MetricsBackend {
  private readonly demo = new DemoMetrics();

  constructor(private readonly real: MetricsBackend) {}

  queryRange(context: string, queries: Record<string, string>, range: TimeRange): Promise<RangeResults | undefined> {
    return (context === DEMO_CONTEXT ? this.demo : this.real).queryRange(context, queries, range);
  }

  invalidate(): void {
    this.real.invalidate();
  }
}
