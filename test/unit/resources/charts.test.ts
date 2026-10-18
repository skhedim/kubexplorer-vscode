// Usage charts: PromQL queries and the charts built from their results.
import { describe, expect, it } from "vitest";
import { historyCharts, type MetricsScope, metricsQueries, prometheusCharts } from "../../../src/resources/charts";
import type { KubeObject } from "../../../src/kube/types";

const pod = (name: string, resources: object): KubeObject => ({
  metadata: { name, namespace: "shop", uid: name },
  spec: { containers: [{ name: "app", resources }] },
  status: { phase: "Running" },
});

const scope: MetricsScope = {
  kind: "pods",
  namespace: "shop",
  pods: [
    pod("web-1", { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "500m" } }),
    pod("web.2", { requests: { cpu: "150m", memory: "64Mi" } }),
    pod("sidecar", {}),
  ],
};

describe("metricsQueries", () => {
  it("sums the containers of the pods, without the pod cgroup nor the pause container", () => {
    const q = metricsQueries(scope);
    expect(q.cpu).toBe(
      'sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace="shop",pod=~"web-1|web\\\\.2|sidecar"}[2m]))',
    );
    expect(q.networkIn).toContain('namespace="shop",pod=~"web-1|web\\\\.2|sidecar"');
    expect(q.fsCapacity).toBeUndefined();
  });

  it("reads the root cgroup of a node, with either node label", () => {
    const q = metricsQueries({ kind: "node", node: { metadata: { name: "worker", uid: "n" } }, pods: [] });
    expect(q.memory).toBe(
      'sum(container_memory_working_set_bytes{id="/",node="worker"}) or sum(container_memory_working_set_bytes{id="/",instance="worker"})',
    );
  });
});

describe("charts", () => {
  const series: [number, number][] = [
    [1000, 0.1],
    [1060, 0.2],
  ];

  it("draws requests (a missing one counts as nothing), and limits only when every container has one", () => {
    const data = prometheusCharts(scope, { cpu: series, memory: series }, "Prometheus monitoring/prometheus");
    const cpu = data.charts.find((c) => c.id === "cpu")!;
    expect(cpu.series).toEqual([
      { label: "Usage", role: "usage", points: series },
      { label: "Requests", role: "requests", value: 0.25 },
    ]);
    const memory = data.charts.find((c) => c.id === "memory")!;
    expect(memory.series.find((s) => s.role === "requests")?.value).toBe(128 * 2 ** 20);
    expect(data.source).toBe("Prometheus monitoring/prometheus");
  });

  it("leaves out the tabs without data", () => {
    expect(prometheusCharts(scope, { cpu: series, memory: series }, "").charts.map((c) => c.id)).toEqual(["cpu", "memory"]);
    const all = prometheusCharts(scope, { cpu: series, memory: series, networkIn: series, fs: series }, "");
    expect(all.charts.map((c) => c.id)).toEqual(["cpu", "memory", "network", "filesystem"]);
  });

  it("draws the allocatable capacity of a node", () => {
    const node: KubeObject = { metadata: { name: "n", uid: "n" }, status: { allocatable: { cpu: "3920m", memory: "8Gi" } } };
    const data = prometheusCharts({ kind: "node", node, pods: [] }, { cpu: series, memory: series }, "");
    expect(data.charts[0].series.find((s) => s.role === "capacity")?.value).toBeCloseTo(3.92);
  });

  it("explains the metrics-server fallback", () => {
    const data = historyCharts(scope, { cpu: [], memory: [] }, "connection refused");
    expect(data.source).toBe("metrics-server");
    expect(data.note).toMatch(/^Prometheus unavailable: connection refused\. Collecting samples/);
  });
});
