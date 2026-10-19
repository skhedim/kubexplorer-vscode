// Flux descriptors, on objects captured from the development cluster (dev-cluster/setup.sh --addons).
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../../src/kube/types";
import type { DetailContext } from "../../../src/resources/descriptor";
import { fluxKustomizations, fluxOverview, fluxState, inventoryEntries } from "../../../src/resources/flux";
import { ResourceRegistry } from "../../../src/resources/registry";
import { byName, fixture } from "../helpers";

const registry = new ResourceRegistry();

/** Registry identifier -> fixture. */
const FIXTURES: Record<string, string> = {
  "flux:kustomizations": "flux-kustomizations",
  "flux:helmreleases": "flux-helmreleases",
  "flux:gitrepositories": "flux-gitrepositories",
  "flux:ocirepositories": "flux-ocirepositories",
  "flux:helmrepositories": "flux-helmrepositories",
  "flux:helmcharts": "flux-helmcharts",
  "flux:buckets": "flux-buckets",
  "flux:imagerepositories": "flux-imagerepositories",
  "flux:imagepolicies": "flux-imagepolicies",
  "flux:alerts": "flux-alerts",
  "flux:providers": "flux-providers",
  "flux:receivers": "flux-receivers",
};

const ctx: DetailContext = {
  context: "test",
  list: async (resource) => (resource === "events" ? fixture("events") : []),
  rowsOf: (resource, items) => {
    const d = registry.require(resource);
    return { columns: d.compactColumns, rows: items.map((o: KubeObject) => d.toCompactRow(o)) };
  },
};

const withConditions = (conditions: object[], spec: object = {}): KubeObject => ({
  apiVersion: "kustomize.toolkit.fluxcd.io/v1",
  metadata: { name: "x", namespace: "flux-system", uid: "u" },
  spec,
  status: { conditions },
});

describe.each(Object.entries(FIXTURES))("%s", (resource, file) => {
  const descriptor = registry.require(resource);
  const items = fixture(file);

  it("is an optional kind, served by its CRD", () => {
    expect(descriptor.optional).toBe(true);
    expect(descriptor.kubectlName).toMatch(/\.fluxcd\.io$/);
  });

  it("renders every column of every object, and its details", async () => {
    for (const o of items) {
      const row = descriptor.toRow(o);
      for (const col of descriptor.columns) expect(row.cells, col.id).toHaveProperty(col.id);
    }
    const details = await descriptor.details(items[0], ctx);
    expect(details.title).toBe(`${descriptor.kindName}: ${items[0].metadata.name}`);
    expect(details.sections.some((s) => s.type === "title" && s.text === "Events")).toBe(true);
  });
});

describe("Flux status (getConditionText of the Freelens extension)", () => {
  it("follows the Ready condition", () => {
    expect(fluxState(withConditions([{ type: "Ready", status: "True" }]))).toBe("Ready");
    expect(fluxState(withConditions([{ type: "Ready", status: "False" }]))).toBe("Not Ready");
    expect(fluxState(withConditions([{ type: "Ready", status: "Unknown" }]))).toBe("In Progress");
    expect(fluxState(withConditions([]))).toBe("Unknown");
  });

  it("reports a reconcile in progress, then Stalled, then Suspended first", () => {
    expect(
      fluxState(
        withConditions([
          { type: "Ready", status: "True" },
          { type: "Reconciling", status: "True" },
        ]),
      ),
    ).toBe("In Progress");
    expect(
      fluxState(
        withConditions([
          { type: "Ready", status: "False" },
          { type: "Stalled", status: "True" },
        ]),
      ),
    ).toBe("Stalled");
    expect(fluxState(withConditions([{ type: "Ready", status: "False" }], { suspend: true }))).toBe("Suspended");
  });

  it("reports a failed reconcile that Flux retries as not ready, not in progress", () => {
    expect(
      fluxState(
        withConditions([
          { type: "Reconciling", status: "True", reason: "ProgressingWithRetry" },
          { type: "Ready", status: "False", reason: "ArtifactFailed" },
        ]),
      ),
    ).toBe("Not Ready");
  });

  it("uses the reconcile annotation of the Flux Operator kinds", () => {
    const instance: KubeObject = {
      apiVersion: "fluxcd.controlplane.io/v1",
      metadata: { name: "flux", namespace: "flux-system", uid: "u", annotations: { "fluxcd.controlplane.io/reconcile": "disabled" } },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    };
    expect(fluxState(instance)).toBe("Suspended");
  });

  it("classifies the objects of the development cluster", () => {
    const kustomizations = fixture("flux-kustomizations");
    expect(fluxState(byName(kustomizations, "podinfo"))).toBe("Ready");
    expect(fluxState(byName(kustomizations, "suspended"))).toBe("Suspended");
    expect(fluxState(byName(kustomizations, "broken-path"))).toBe("Not Ready");
  });
});

describe("Flux actions", () => {
  const ready = byName(fixture("flux-kustomizations"), "podinfo");
  const suspended = byName(fixture("flux-kustomizations"), "suspended");

  it("offers Resume only on suspended objects, Reconcile and Suspend on the others", () => {
    expect(fluxKustomizations.toRow(ready).actions).toEqual(expect.arrayContaining(["reconcile", "suspend"]));
    expect(fluxKustomizations.toRow(ready).actions).not.toContain("resume");
    expect(fluxKustomizations.toRow(suspended).actions).toContain("resume");
    expect(fluxKustomizations.toRow(suspended).actions).not.toContain("reconcile");
  });

  it("builds the patches of the flux CLI", () => {
    const now = "2026-10-18T12:00:00.000Z";
    expect(fluxKustomizations.patches.reconcile!(ready, now)).toEqual({
      metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": now } },
    });
    expect(fluxKustomizations.patches.suspend!(ready, now)).toEqual({ spec: { suspend: true } });
    expect(fluxKustomizations.patches.resume!(suspended, now)).toEqual({
      spec: { suspend: false },
      metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": now } },
    });
  });
});

describe("Flux inventory", () => {
  it("parses the entries of a Kustomization", () => {
    const entries = inventoryEntries(byName(fixture("flux-kustomizations"), "podinfo"));
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: "Deployment", name: "podinfo", namespace: "apps", group: "apps", version: "v1" }),
    );
    expect(entries).toContainEqual(expect.objectContaining({ kind: "Service", group: "" }));
  });

  it("links the inventory objects to their views", async () => {
    const details = await fluxKustomizations.details(byName(fixture("flux-kustomizations"), "podinfo"), ctx);
    const grid = details.sections.find((s) => s.type === "grid" && s.columns[0].title === "Kind");
    expect(grid?.type === "grid" && grid.rows.find((r) => r[0] === "Deployment")?.[1]).toEqual({
      link: "podinfo",
      ref: { resource: "deployments", namespace: "apps", name: "podinfo" },
    });
  });
});

describe("Flux overview", () => {
  const lists = Object.fromEntries(Object.entries(FIXTURES).map(([id, file]) => [id, fixture(file)]));

  it("charts the status of every installed kind and lists the Flux events", () => {
    const data = fluxOverview.build({ lists: { ...lists, events: fixture("events") }, errors: {}, missing: new Set() });
    const kustomizations = data.donuts.find((d) => d.resource === "flux:kustomizations")!;
    expect(kustomizations.slices.reduce((n, s) => n + s.value, 0)).toBe(3);
    expect(kustomizations.slices.map((s) => s.label)).toContain("Suspended");
    expect(data.tables[0].rows.every((r) => r.search.length > 0)).toBe(true);
    expect(data.empty).toBeUndefined();
  });

  it("says when Flux is not installed", () => {
    const missing = new Set(fluxOverview.resources.filter((r) => r.startsWith("flux:")));
    expect(fluxOverview.build({ lists: { events: [] }, errors: {}, missing }).empty).toMatch(/not installed/);
  });
});
