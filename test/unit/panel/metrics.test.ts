// Usage charts: Prometheus first, then the samples of metrics-server collected in memory.
import { describe, expect, it, vi } from "vitest";
import type { KubeClient } from "../../../src/kube/client";
import type { MetricsBackend } from "../../../src/kube/prometheus";
import { nullLogger, type KubeObject } from "../../../src/kube/types";
import { MetricsHistory, MetricsService } from "../../../src/panel/metrics";
import type { MetricsScope } from "../../../src/resources/charts";
import { ResourceRegistry } from "../../../src/resources/registry";

const podMetrics = (name: string, cpu: string, memory: string): KubeObject => ({
  kind: "PodMetrics",
  metadata: { name, namespace: "shop", uid: "" },
  containers: [{ name: "app", usage: { cpu, memory } }],
});
const pod = (name: string): KubeObject => ({ metadata: { name, namespace: "shop", uid: name }, spec: { containers: [{ name: "app" }] } });
const scope: MetricsScope = { kind: "pods", namespace: "shop", pods: [pod("a"), pod("b")] };

describe("MetricsHistory", () => {
  it("sums the pods of a scope per sample and forgets samples older than an hour", () => {
    const history = new MetricsHistory();
    history.record("kind", [podMetrics("a", "100m", "10Mi"), podMetrics("b", "50m", "20Mi")], 1_000_000);
    history.record("kind", [podMetrics("a", "200m", "10Mi")], 1_030_000);
    const { cpu, memory } = history.series("kind", scope);
    expect(cpu.map(([t]) => t)).toEqual([1000, 1030]);
    expect(cpu[0][1]).toBeCloseTo(0.15);
    expect(memory).toEqual([
      [1000, 30 * 2 ** 20],
      [1030, 10 * 2 ** 20],
    ]);
    history.record("kind", [podMetrics("a", "1", "1Mi")], 1_000_000 + 3_700_000);
    expect(history.series("kind", scope).cpu).toEqual([[4700, 1]]);
    expect(history.series("other", scope).cpu).toEqual([]);
  });
});

describe("MetricsService", () => {
  const registry = new ResourceRegistry();
  const client = { list: vi.fn(async () => [podMetrics("a", "100m", "10Mi"), podMetrics("c", "1", "1Gi")]) } as unknown as KubeClient;

  it("uses Prometheus when the cluster has one", async () => {
    const backend: MetricsBackend = {
      queryRange: async () => ({ source: "Prometheus x/y", results: { cpu: [[1, 0.1]] } }),
      invalidate() {},
    };
    const service = new MetricsService({ backend, client, registry, history: new MetricsHistory(), log: nullLogger });
    const data = await service.load("kind", scope);
    expect(data.source).toBe("Prometheus x/y");
  });

  it("falls back to metrics-server samples of the scope's pods", async () => {
    const backend: MetricsBackend = { queryRange: async () => undefined, invalidate() {} };
    const service = new MetricsService({ backend, client, registry, history: new MetricsHistory(), log: nullLogger });
    const data = await service.load("kind", scope, 2_000_000);
    expect(data.source).toBe("metrics-server");
    expect(data.charts[0].series[0].points).toEqual([[2000, 0.1]]);
  });

  it("explains why Prometheus could not be used", async () => {
    const backend: MetricsBackend = {
      queryRange: async () => {
        throw new Error("the server could not find the requested resource\nmore");
      },
      invalidate() {},
    };
    const service = new MetricsService({ backend, client, registry, history: new MetricsHistory(), log: nullLogger });
    expect((await service.load("kind", scope)).note).toMatch(/^Prometheus unavailable: the server could not find the requested resource\./);
  });
});
