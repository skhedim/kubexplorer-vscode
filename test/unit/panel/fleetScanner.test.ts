// The fleet scanner, on a fake client: bounded concurrency, unreachable clusters, cached controller versions,
// diagnostics and search.
import { describe, expect, it, vi } from "vitest";
import type { KubeClient } from "../../../src/kube/client";
import { nullLogger } from "../../../src/kube/types";
import { FleetScanner } from "../../../src/panel/fleetScanner";
import { ResourceRegistry } from "../../../src/resources/registry";
import { fakeFleetClient as fakeClient } from "../helpers";

const registry = new ResourceRegistry();

const MEMBERS = ["prod-1", "prod-2", "prod-3", "dev-1", "dev-2", "dev-3"].map((context) => ({ context, group: context.split("-")[0] }));

function setup(client: KubeClient, now = () => 1_000_000) {
  return new FleetScanner({ client, registry, members: () => MEMBERS, concurrency: () => 2, log: nullLogger, now });
}

describe("FleetScanner", () => {
  it("scans every cluster with one request, a bounded number at a time", async () => {
    const fake = fakeClient({ withoutFlux: ["dev-3"] });
    const scanner = setup(fake.client);
    const changes = vi.fn();
    scanner.onDidChange(changes);
    expect(scanner.list().every((s) => s.status === "pending")).toBe(true);
    await scanner.scan();
    expect(fake.maxInFlight()).toBe(2);
    const scans = scanner.list();
    expect(scans.every((s) => s.status === "ok" && !s.scanning)).toBe(true);
    expect(scans.find((s) => s.context === "prod-1")!.objects!.length).toBeGreaterThan(3);
    expect(scans.find((s) => s.context === "dev-3")!.flux).toEqual({ installed: false, components: undefined });
    // Nodes and Flux in one request per cluster, then the controllers of flux-system for those with Flux.
    const perCluster = fake.calls.filter((c) => c.context === "prod-1");
    expect(perCluster.map((c) => c.namespace ?? "*")).toEqual(["*", "flux-system"]);
    expect(perCluster[0].kinds).toEqual([
      "Node",
      "Kustomization",
      "HelmRelease",
      "GitRepository",
      "OCIRepository",
      "HelmRepository",
      "Bucket",
    ]);
    expect(fake.calls.filter((c) => c.context === "dev-3")).toHaveLength(1);
    expect(changes).toHaveBeenCalled();
    expect(scanner.activity()).toEqual([]);
  });

  it("reads the versions of the controllers again only after a while", async () => {
    const fake = fakeClient();
    let now = 1_000_000;
    const scanner = setup(fake.client, () => now);
    await scanner.scan(["prod-1"]);
    await scanner.scan(["prod-1"]);
    expect(fake.calls.filter((c) => c.namespace === "flux-system")).toHaveLength(1);
    now += 11 * 60_000;
    await scanner.scan(["prod-1"]);
    expect(fake.calls.filter((c) => c.namespace === "flux-system")).toHaveLength(2);
  });

  it("keeps the last summary of a cluster that became unreachable, with the error", async () => {
    const fake = fakeClient({ unreachable: ["prod-2"] });
    const scanner = setup(fake.client);
    await scanner.scan();
    expect(scanner.get("prod-2")).toMatchObject({ status: "error", error: "Unable to connect to the server: i/o timeout" });
    expect(scanner.oldestScan()).toBeUndefined();
  });

  it("joins a scan in progress rather than starting another one", async () => {
    const fake = fakeClient();
    const scanner = setup(fake.client);
    const first = scanner.scan();
    expect(scanner.scan()).toBe(first);
    await first;
    expect(fake.calls.filter((c) => c.namespace === undefined)).toHaveLength(MEMBERS.length);
  });

  it("diagnoses clusters without reading their ConfigMaps nor Secrets", async () => {
    const fake = fakeClient({ unreachable: ["dev-2"] });
    const scanner = setup(fake.client);
    await scanner.diagnose(["prod-1", "dev-2"]);
    const kinds = fake.calls.find((c) => c.context === "prod-1")!.kinds;
    expect(kinds).toContain("Pod");
    expect(kinds).not.toContain("ConfigMap");
    expect(kinds).not.toContain("Secret");
    expect(scanner.get("prod-1")!.diagnostics!.counts.error).toBeGreaterThan(0);
    expect(scanner.get("prod-1")!.diagnostics!.problems.every((p) => p.severity !== "info")).toBe(true);
    expect(scanner.get("dev-2")!.diagnostics!.error).toMatch(/Unable to connect/);
  });

  it("searches the clusters, and cancels a search replaced by another", async () => {
    const scanner = setup(fakeClient({ unreachable: ["dev-1"] }).client);
    const first: string[] = [];
    const second: string[] = [];
    const running = scanner.search(
      MEMBERS.map((m) => m.context),
      "workloads",
      "web",
      (hits) => first.push(...hits.map((h) => h.context)),
    );
    await scanner.search(["prod-1"], "workloads", "payments", (hits) => second.push(...hits.map((h) => `${h.context}/${h.name}`)));
    await running;
    expect(second).toEqual(["prod-1/payments-api"]);
    // The first search stopped early: not every cluster answered it.
    expect(new Set(first).size).toBeLessThan(MEMBERS.length);
  });

  it("searches Flux objects in the scans, without asking the clusters", async () => {
    const fake = fakeClient();
    const scanner = setup(fake.client);
    await scanner.scan(["prod-1"]);
    const before = fake.calls.length;
    const hits: string[] = [];
    await scanner.search(["prod-1"], "flux", "podinfo", (h) => hits.push(...h.map((x) => x.name)));
    expect(fake.calls.length).toBe(before);
    expect(hits).toContain("podinfo");
  });
});
