import { describe, expect, it } from "vitest";
import { nodes } from "../../../src/resources/cluster";
import { indexRelated, type RowContext } from "../../../src/resources/descriptor";
import { clusterUsage } from "../../../src/resources/overview";
import { pods } from "../../../src/resources/pods";
import { byName, fixture } from "../helpers";

const rc: RowContext = { related: { podmetrics: indexRelated(fixture("podmetrics")), nodemetrics: indexRelated(fixture("nodemetrics")) } };

describe("metrics (real kind cluster)", () => {
  it("shows the CPU and memory of pods", () => {
    const row = pods.toRow(byName(fixture("pods"), "web-app"), rc);
    expect(row.cells.memory).toMatch(/^\d+(\.\d)?(Mi|Ki)$/);
    expect(row.sort.cpu).toBeGreaterThanOrEqual(0);
  });

  it("leaves the columns empty without metrics-server", () => {
    const row = pods.toRow(byName(fixture("pods"), "web-app"));
    expect(row.cells.cpu).toBe("");
    expect(row.sort.cpu).toBe(-1);
  });

  it("renders node usage as gauges", () => {
    const row = nodes.toRow(byName(fixture("nodes"), "kubexplorer-control-plane"), rc);
    expect(row.cells.cpu).toMatchObject({ text: expect.stringMatching(/^\d+%$/), tone: expect.any(String) });
    expect((row.cells.cpu as { bar: number }).bar).toBeGreaterThan(0);
  });

  it("computes the cluster usage and requests", () => {
    const usage = clusterUsage({ nodes: fixture("nodes"), nodemetrics: fixture("nodemetrics"), pods: fixture("pods") }, {})!;
    expect(usage.cpu!.usage).toBeGreaterThan(0);
    expect(usage.cpu!.requests).toBeGreaterThan(0);
    expect(usage.memory!.text).toMatch(/used · .* requested · .* allocatable/);
    const capacity = fixture("nodes").reduce((n, node) => n + Number(node.status?.allocatable?.pods), 0);
    expect(usage.pods.capacity).toBe(capacity);
    // The Pending pod (512Gi requested, never scheduled) does not reserve anything.
    expect(usage.memory!.requests).toBeLessThan(1);
  });

  it("reports a missing metrics-server", () => {
    const usage = clusterUsage(
      { nodes: fixture("nodes"), nodemetrics: [], pods: [] },
      { nodemetrics: "the server could not find the requested resource" },
    )!;
    expect(usage.cpu).toBeUndefined();
    expect(usage.error).toMatch(/metrics-server/);
  });
});
