// Usage charts over time (the Freelens metric tabs): PromQL queries for a pod, the pods of a workload or a
// node, and the charts built from their results, with requests, limits and capacity as reference lines.

import { cpuMillis, memoryBytes } from "../kube/quantity";
import type { KubeObject } from "../kube/types";
import type { ContainerSpec } from "../kube/models";
import type { Chart, ChartSeries, MetricsData } from "../shared/view";

/** What the charts cover: some pods of one namespace (a pod, or the pods of a workload), or a node. */
export type MetricsScope = { kind: "pods"; namespace: string; pods: KubeObject[] } | { kind: "node"; node: KubeObject; pods: KubeObject[] };

/** [unix seconds, value] points. */
export type Series = [number, number][];

/** Results of the queries, by query key (see metricsQueries). */
export type MetricsResults = Partial<Record<QueryKey, Series>>;

type QueryKey = "cpu" | "memory" | "networkIn" | "networkOut" | "fs" | "fsCapacity";

/** The rate window: several scrapes long, whatever the scrape interval (15 to 60 s in practice). */
const RATE = "2m";

/** A literal in a PromQL regex: escaped for the regex, then for the double-quoted PromQL string. */
function promRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\/g, "\\\\");
}

/** cAdvisor series of a node: kube-prometheus-stack labels them with `node`, the prometheus chart with `instance`. */
function nodeQuery(metric: string, name: string, rate: boolean): string {
  const one = (label: string) => {
    const series = `${metric}{id="/",${label}="${name}"}`;
    return `sum(${rate ? `rate(${series}[${RATE}])` : series})`;
  };
  return `${one("node")} or ${one("instance")}`;
}

export function metricsQueries(scope: MetricsScope): Partial<Record<QueryKey, string>> {
  if (scope.kind === "node") {
    const name = scope.node.metadata.name;
    return {
      cpu: nodeQuery("container_cpu_usage_seconds_total", name, true),
      memory: nodeQuery("container_memory_working_set_bytes", name, false),
      networkIn: nodeQuery("container_network_receive_bytes_total", name, true),
      networkOut: nodeQuery("container_network_transmit_bytes_total", name, true),
      fs: nodeQuery("container_fs_usage_bytes", name, false),
      fsCapacity: nodeQuery("container_fs_limit_bytes", name, false),
    };
  }
  const pods = `namespace="${scope.namespace}",pod=~"${scope.pods.map((p) => promRegexLiteral(p.metadata.name)).join("|")}"`;
  // container="" is the pod cgroup, "POD" the pause container (dockershim): both would count twice.
  const containers = `container!="",container!="POD",${pods}`;
  return {
    cpu: `sum(rate(container_cpu_usage_seconds_total{${containers}}[${RATE}]))`,
    memory: `sum(container_memory_working_set_bytes{${containers}})`,
    networkIn: `sum(rate(container_network_receive_bytes_total{${pods}}[${RATE}]))`,
    networkOut: `sum(rate(container_network_transmit_bytes_total{${pods}}[${RATE}]))`,
    fs: `sum(container_fs_usage_bytes{${containers}})`,
  };
}

interface Totals {
  cpu: number; // cores
  memory: number; // bytes
}

/**
 * Sum of the requests or limits of running pods. A container without request requests nothing; a container
 * without limit is unbounded, so the pods have no limit line.
 */
function podTotals(pods: KubeObject[], field: "requests" | "limits"): Partial<Totals> {
  const active = pods.filter((p) => p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
  const containers: ContainerSpec[] = active.flatMap((p) => p.spec?.containers ?? []);
  if (!containers.length) return {};
  const sum = (resource: "cpu" | "memory", parse: (q: string | undefined) => number): number | undefined => {
    let total = 0;
    for (const c of containers) {
      const q = c.resources?.[field]?.[resource];
      if (q) total += parse(q);
      else if (field === "limits") return undefined;
    }
    return total;
  };
  return { cpu: (sum("cpu", cpuMillis) ?? NaN) / 1000 || undefined, memory: sum("memory", memoryBytes) };
}

function line(label: string, role: ChartSeries["role"], value: number | undefined): ChartSeries[] {
  return value !== undefined && Number.isFinite(value) && value > 0 ? [{ label, role, value }] : [];
}

function hasPoints(s: Series | undefined): s is Series {
  return !!s?.length;
}

/** The CPU and Memory charts, with requests and limits (pods) or requests and allocatable capacity (nodes). */
function resourceCharts(scope: MetricsScope, cpu: Series, memory: Series): Chart[] {
  const requests = podTotals(scope.pods, "requests");
  const limits = scope.kind === "pods" ? podTotals(scope.pods, "limits") : {};
  const allocatable =
    scope.kind === "node"
      ? {
          cpu: cpuMillis(scope.node.status?.allocatable?.cpu) / 1000,
          memory: memoryBytes(scope.node.status?.allocatable?.memory),
        }
      : {};
  return [
    {
      id: "cpu",
      title: "CPU",
      unit: "cpu",
      series: [
        { label: "Usage", role: "usage", points: cpu },
        ...line("Requests", "requests", requests.cpu),
        ...line("Limits", "limits", limits.cpu),
        ...line("Allocatable", "capacity", allocatable.cpu),
      ],
    },
    {
      id: "memory",
      title: "Memory",
      unit: "bytes",
      series: [
        { label: "Usage", role: "usage", points: memory },
        ...line("Requests", "requests", requests.memory),
        ...line("Limits", "limits", limits.memory),
        ...line("Allocatable", "capacity", allocatable.memory),
      ],
    },
  ];
}

/** Charts from Prometheus results; tabs without data (e.g. no filesystem metrics with containerd) are left out. */
export function prometheusCharts(scope: MetricsScope, results: MetricsResults, source: string): MetricsData {
  const charts = resourceCharts(scope, results.cpu ?? [], results.memory ?? []);
  if (hasPoints(results.networkIn) || hasPoints(results.networkOut))
    charts.push({
      id: "network",
      title: "Network",
      unit: "bytesPerSecond",
      series: [
        { label: "Receive", role: "usage", points: results.networkIn ?? [] },
        { label: "Transmit", role: "secondary", points: results.networkOut ?? [] },
      ],
    });
  if (hasPoints(results.fs))
    charts.push({
      id: "filesystem",
      title: "Filesystem",
      unit: "bytes",
      series: [{ label: "Usage", role: "usage", points: results.fs }, ...line("Capacity", "capacity", results.fsCapacity?.at(-1)?.[1])],
    });
  const empty = !hasPoints(results.cpu) && !hasPoints(results.memory);
  return { source, charts, note: empty ? "No data for this object in Prometheus yet" : undefined };
}

/** Charts from the samples of metrics-server collected while KubeXplorer runs (no Prometheus). */
export function historyCharts(scope: MetricsScope, samples: { cpu: Series; memory: Series }, prometheusError?: string): MetricsData {
  const few = samples.cpu.length < 3;
  return {
    source: "metrics-server",
    charts: resourceCharts(scope, samples.cpu, samples.memory),
    note: [
      prometheusError ? `Prometheus unavailable: ${prometheusError}.` : "",
      few ? "Collecting samples from metrics-server." : "Samples collected by metrics-server while KubeXplorer is open.",
      "Install Prometheus for a longer history and network charts.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}
