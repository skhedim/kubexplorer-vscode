import { describe, expect, it } from "vitest";
import { buildMatrix, type ClusterScan, type FluxSummary } from "../../../src/resources/fleet";
import { fleetReport } from "../../../src/resources/fleetReport";

const summary = (name: string, extra: Partial<FluxSummary> = {}): FluxSummary => ({
  resource: "flux:kustomizations",
  kind: "Kustomization",
  namespace: "flux-system",
  name,
  state: "Ready",
  revision: "main@aaaaaaa",
  ...extra,
});
const NOW = Date.parse("2026-10-28T20:00:00Z");
const scan = (context: string, group: string, objects: FluxSummary[]): ClusterScan => ({
  context,
  group,
  status: "ok",
  flux: { installed: true, components: { "kustomize-controller": "v1.9.6" } },
  nodes: { ready: 3, total: 3 },
  kubernetes: ["v1.33.1"],
  objects,
  at: NOW - 60_000,
  checkedAt: NOW - 60_000,
});

describe("fleet report", () => {
  const scans: ClusterScan[] = [
    scan("prod-1", "prod", [summary("apps")]),
    scan("prod-2", "prod", [summary("apps", { revision: "main@bbbbbbb" }), summary("redis", { state: "Not Ready", message: "a | b" })]),
    { context: "prod-down", group: "prod", status: "error", error: "dial tcp: i/o timeout | retry", checkedAt: NOW - 120_000 },
  ];
  const report = fleetReport({ title: "Fleet report: prod", scans, rows: buildMatrix(scans), groups: ["prod"], now: NOW });

  it("sums up the fleet, then tables of the clusters and of the Flux objects that need a look", () => {
    expect(report).toContain("# Fleet report: prod\n\n2026-10-28 20:00 UTC · 3 clusters: 2 reachable, 1 unreachable, scanned 2m ago.");
    expect(report).toContain("| Cluster | Group | Status | Kubernetes | Nodes | Flux |");
    expect(report).toMatch(/\| prod-1 \| prod \| OK \| v1\.33\.1 \| 3\/3 \| kustomize v1\.9\.6 \|/);
    expect(report).toMatch(/\| prod-down \| prod \| Unreachable \|/);
    // Failing first, then drifting; Ready everywhere and the same is left out.
    const flux = report.slice(report.indexOf("## Flux"));
    expect(flux.indexOf("Kustomization redis")).toBeLessThan(flux.indexOf("Kustomization apps"));
    expect(flux).toContain("2 revisions in prod");
    expect(report).toContain("## Unreachable clusters\n\n- prod-down: dial tcp: i/o timeout \\| retry\n");
  });

  it("keeps the tables whole: a pipe in a value is escaped", () => {
    const pipe = fleetReport({
      title: "Fleet report",
      scans: [scan("a|b", "prod", [])],
      rows: [],
      groups: ["prod"],
      now: NOW,
    });
    expect(pipe).toContain("| a\\|b | prod |");
  });
});
