// Karpenter descriptors and dashboard, on objects of the development cluster (kwok simulates the nodes).
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../../src/kube/types";
import type { DetailContext } from "../../../src/resources/descriptor";
import { claimState, ec2nodeclasses, nodeclaims, nodeKarpenterSection, nodepools } from "../../../src/resources/karpenter";
import { karpenterOverview } from "../../../src/resources/karpenterOverview";
import { ResourceRegistry } from "../../../src/resources/registry";
import { byName, emptyDetailContext, fixture } from "../helpers";

const registry = new ResourceRegistry();

const ctx: DetailContext = {
  context: "test",
  list: async (resource, opts) => {
    const all = resource === "karpenter:nodeclaims" ? fixture("karpenter-nodeclaims") : resource === "nodes" ? fixture("nodes") : [];
    const [key, value] = (opts.labelSelector ?? "=").split("=");
    return key ? all.filter((o) => o.metadata.labels?.[key] === value) : all;
  },
  rowsOf: (resource, items) => {
    const d = registry.require(resource);
    return { columns: d.compactColumns, rows: items.map((o: KubeObject) => d.toCompactRow(o)) };
  },
};

describe.each([
  [nodepools, "karpenter-nodepools"],
  [nodeclaims, "karpenter-nodeclaims"],
  [ec2nodeclasses, "karpenter-ec2nodeclasses"],
] as const)("$id", (descriptor, file) => {
  it("renders every column of every object, and its details", async () => {
    expect(descriptor.optional).toBe(true);
    for (const o of fixture(file)) {
      const row = descriptor.toRow(o);
      for (const col of descriptor.columns) if (col.id !== "warning") expect(row.cells, col.id).toHaveProperty(col.id);
      await descriptor.details(o, ctx);
    }
  });
});

describe("Karpenter", () => {
  it("derives the state of NodeClaims from their conditions", () => {
    const claims = fixture("karpenter-nodeclaims");
    expect(claimState(byName(claims, "default-x7k2p"))).toBe("Ready");
    expect(claimState(byName(claims, "default-m4q9z"))).toBe("Drifted");
    expect(claimState(byName(claims, "gpu-pending"))).toBe("Failed");
    expect(nodeclaims.toRow(byName(claims, "gpu-pending")).warning).toMatch(/unavailable/);
  });

  it("shows NodePool usage against its limits", () => {
    const row = nodepools.toRow(byName(fixture("karpenter-nodepools"), "default"));
    // 8 provisioned CPUs of a 32 CPU limit.
    expect(row.cells.cpu).toMatchObject({ bar: 0.25, text: "25%" });
    expect(row.cells.nodeClass).toMatchObject({ link: "default", ref: { resource: "karpenter:ec2nodeclasses", name: "default" } });
  });

  it("lists the claims and nodes of a NodePool", async () => {
    const details = await nodepools.details(byName(fixture("karpenter-nodepools"), "default"), ctx);
    const titles = details.sections.flatMap((s) => (s.type === "title" ? [s.text] : []));
    expect(titles).toEqual(expect.arrayContaining(["Node Claims (3)", "Nodes (3)", "Conditions", "Events (0)"]));
  });

  it("adds a Karpenter section to the nodes it manages only", async () => {
    const managed = await nodeKarpenterSection(byName(fixture("nodes"), "ip-10-0-2-34"), ctx);
    expect(managed[0]).toEqual({ type: "title", text: "Karpenter" });
    const items = managed[1].type === "items" ? managed[1].items : [];
    expect(items.find((i) => i.name === "Node Claim")?.value).toMatchObject({ link: "default-m4q9z" });
    expect(items.find((i) => i.name === "Capacity Type")?.value).toBe("Spot");
    expect(await nodeKarpenterSection(byName(fixture("nodes"), "kubexplorer-worker"), emptyDetailContext)).toEqual([]);
  });

  it("builds the dashboard: a card per NodePool, claims, topology and scaling decisions", () => {
    const data = karpenterOverview.build({
      lists: {
        "karpenter:nodepools": fixture("karpenter-nodepools"),
        "karpenter:nodeclaims": fixture("karpenter-nodeclaims"),
        nodes: fixture("nodes"),
        pods: fixture("pods"),
        events: fixture("events"),
      },
      errors: {},
    });
    expect(data.cards?.map((c) => c.title)).toEqual(["default", "gpu"]);
    const gpu = data.cards!.find((c) => c.title === "gpu")!;
    expect(gpu.items[0].value).toMatchObject({ text: expect.stringMatching(/1 failed to launch/) });
    expect(data.donuts.find((d) => d.title === "Zones")!.slices.reduce((n, s) => n + s.value, 0)).toBe(4);
    expect(data.tables.map((t) => t.title)).toEqual(["Node Claims", "Scaling Decisions"]);
  });

  it("says when Karpenter is not installed", () => {
    const data = karpenterOverview.build({ lists: {}, errors: {}, missing: new Set(["karpenter:nodepools", "karpenter:nodeclaims"]) });
    expect(data.empty).toMatch(/not installed/);
  });
});
