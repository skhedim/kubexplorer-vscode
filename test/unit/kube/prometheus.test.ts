// Prometheus detection and range queries through the API server proxy.
import { describe, expect, it, vi } from "vitest";
import { parsePrometheusSetting, pickPrometheus, PrometheusClient } from "../../../src/kube/prometheus";
import { nullLogger, type KubeObject } from "../../../src/kube/types";

const service = (namespace: string, name: string, ports: object[], labels: Record<string, string> = {}): KubeObject => ({
  metadata: { name, namespace, uid: name, labels },
  spec: { ports },
});

describe("Prometheus", () => {
  it("parses the setting", () => {
    expect(parsePrometheusSetting("")).toBe("auto");
    expect(parsePrometheusSetting("OFF")).toBe("off");
    expect(parsePrometheusSetting("monitoring/prometheus-server:80")).toEqual({
      namespace: "monitoring",
      name: "prometheus-server",
      port: "80",
    });
    expect(parsePrometheusSetting("monitoring/prometheus")).toEqual({ namespace: "monitoring", name: "prometheus", port: "9090" });
    expect(() => parsePrometheusSetting("http://prometheus:9090")).toThrow(/namespace\/service:port/);
  });

  it("prefers the services of the common installations", () => {
    const services = [
      service("monitoring", "kube-prometheus-stack-alertmanager", [{ name: "http-web", port: 9093 }]),
      service("monitoring", "prometheus-server", [{ name: "http", port: 80 }]),
      service("monitoring", "prometheus-operated", [{ name: "web", port: 9090 }]),
    ];
    expect(pickPrometheus(services)).toEqual({ namespace: "monitoring", name: "prometheus-operated", port: "9090" });
    expect(pickPrometheus(services.slice(0, 2))).toEqual({ namespace: "monitoring", name: "prometheus-server", port: "80" });
    expect(pickPrometheus([service("obs", "metrics", [{ port: 9090 }], { "app.kubernetes.io/name": "prometheus" })])?.name).toBe("metrics");
    expect(pickPrometheus(services.slice(0, 1))).toBeUndefined();
  });

  it("queries the detected service through the API server proxy", async () => {
    const getRaw = vi.fn(async (_context: string, _path: string) =>
      JSON.stringify({
        status: "success",
        data: {
          result: [
            {
              values: [
                [1000, "0.5"],
                [1060, "NaN"],
              ],
            },
          ],
        },
      }),
    );
    const list = vi.fn(async () => [service("monitoring", "prometheus-server", [{ name: "http", port: 80 }])]);
    const client = new PrometheusClient({ list, getRaw }, () => "", nullLogger);
    const r = await client.queryRange("kind", { cpu: 'sum(rate(x{pod="a"}[2m]))' }, { start: 1000, end: 1060, step: 60 });
    expect(r).toEqual({ source: "Prometheus monitoring/prometheus-server", results: { cpu: [[1000, 0.5]] } });
    const path = getRaw.mock.calls[0][1];
    expect(path.startsWith("/api/v1/namespaces/monitoring/services/prometheus-server:80/proxy/api/v1/query_range?")).toBe(true);
    expect(new URLSearchParams(path.split("?")[1]).get("query")).toBe('sum(rate(x{pod="a"}[2m]))');
    // The detection is cached.
    await client.queryRange("kind", { cpu: "up" }, { start: 1000, end: 1060, step: 60 });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("reports no Prometheus, and errors of the queries", async () => {
    const none = new PrometheusClient({ list: async () => [], getRaw: vi.fn() }, () => "", nullLogger);
    expect(await none.queryRange("kind", { cpu: "up" }, { start: 0, end: 60, step: 60 })).toBeUndefined();
    const off = new PrometheusClient({ list: vi.fn(), getRaw: vi.fn() }, () => "off", nullLogger);
    expect(await off.queryRange("kind", { cpu: "up" }, { start: 0, end: 60, step: 60 })).toBeUndefined();
    const failing = new PrometheusClient(
      { list: vi.fn(), getRaw: async () => JSON.stringify({ status: "error", error: "bad_data: parse error" }) },
      () => "monitoring/prometheus:9090",
      nullLogger,
    );
    await expect(failing.queryRange("kind", { cpu: "up(" }, { start: 0, end: 60, step: 60 })).rejects.toThrow("bad_data: parse error");
  });
});
