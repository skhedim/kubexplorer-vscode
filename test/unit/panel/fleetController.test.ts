// The Fleet tab controller, on a fake fleet: what it shows, its filters, details, actions and search.
import { afterEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../../../src/kube/types";
import { FleetController, type FleetHost } from "../../../src/panel/fleetController";
import { FleetScanner } from "../../../src/panel/fleetScanner";
import { ResourceRegistry } from "../../../src/resources/registry";
import type { HostMessage } from "../../../src/shared/protocol";
import type { FleetView } from "../../../src/shared/view";
import { fakeFleetClient } from "../helpers";

const MEMBERS = [
  { context: "prod-1", group: "prod" },
  { context: "prod-2", group: "prod" },
  { context: "dev-1", group: "dev" },
];

function setup(opts: { unreachable?: string[] } = {}) {
  const messages: HostMessage[] = [];
  const host: FleetHost = { post: (m) => messages.push(m), openInCluster: vi.fn(), fluxAction: vi.fn(), copyText: vi.fn() };
  const fake = fakeFleetClient(opts);
  const scanner = new FleetScanner({
    client: fake.client,
    registry: new ResourceRegistry(),
    members: () => MEMBERS,
    concurrency: () => 2,
    log: nullLogger,
  });
  const controller = new FleetController({
    scanner,
    host,
    groups: () => ["prod", "dev", "other"],
    refreshIntervalMs: () => 60_000,
    appearance: "vscode",
    log: nullLogger,
  });
  const views = () => messages.filter((m): m is Extract<HostMessage, { type: "fleet" }> => m.type === "fleet").map((m) => m.view);
  const last = (): FleetView => views().at(-1)!;
  const start = async () => {
    controller.onMessage({ type: "ready" });
    controller.setVisible(true);
    // Every cluster scanned: the view tells when.
    await vi.waitFor(() => expect(last()?.updated).toBeDefined());
  };
  return { controller, host, messages, last, start, fake };
}

describe("FleetController", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  it("scans the clusters once shown, and shows them with their groups", async () => {
    const { controller, messages, last, start, fake } = setup({ unreachable: ["dev-1"] });
    dispose = () => controller.dispose();
    controller.onMessage({ type: "ready" });
    expect(messages[0]).toMatchObject({ type: "init", view: { mode: "fleet", title: "Fleet", target: { kind: "fleet" } } });
    // Nothing is read before the tab is visible.
    expect(fake.calls).toEqual([]);
    controller.setVisible(true);
    // Every cluster checked, the unreachable one included: the view tells when.
    await vi.waitFor(() => expect(last().updated).toMatch(/^scanned \d+s ago$/));
    const dev1 = last().data.tables[0].rows.find((r) => r.cells.cluster === "dev-1")!;
    expect(dev1.cells.status).toMatchObject({ tags: [{ text: "Unreachable" }] });
    expect(last()).toMatchObject({ tab: "clusters", groups: ["prod", "dev"], group: null, clusters: 3 });
    void start;
  });

  it("does not scan again when shown again while the scans are fresh, even with an unreachable cluster", async () => {
    const { controller, last, fake } = setup({ unreachable: ["dev-1"] });
    dispose = () => controller.dispose();
    controller.onMessage({ type: "ready" });
    controller.setVisible(true);
    await vi.waitFor(() => expect(last().updated).toBeDefined());
    const calls = fake.calls.length;
    controller.setVisible(false);
    controller.setVisible(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls.length).toBe(calls);
    // The refresh button reads everything again, the versions of the Flux controllers included.
    controller.onMessage({ type: "refresh" });
    await vi.waitFor(() => expect(fake.calls.filter((c) => c.namespace === "flux-system").length).toBe(4));
  });

  it("filters a group, switches tabs, and keeps only the problems when asked", async () => {
    const { controller, last, start } = setup();
    dispose = () => controller.dispose();
    await start();
    controller.onMessage({ type: "fleetState", group: "prod" });
    expect(last()).toMatchObject({ group: "prod", clusters: 2 });
    controller.onMessage({ type: "fleetState", tab: "flux" });
    const flux = last().data.tables[0];
    // The development cluster has a suspended Kustomization: it drifts.
    expect(flux.rows.find((r) => r.cells.object === "Kustomization suspended")!.cells.status).toMatchObject({ tags: [{ text: "Drift" }] });
    controller.onMessage({ type: "fleetState", problemsOnly: true });
    const problems = last().data.tables[0].rows;
    expect(problems.length).toBeLessThan(flux.rows.length);
    expect(problems.every((r) => /Failing|Drift/.test(JSON.stringify(r.cells.status)))).toBe(true);
  });

  it("details a Flux object across the clusters, and hands its actions to the host", async () => {
    const { controller, host, messages, last, start } = setup();
    dispose = () => controller.dispose();
    await start();
    controller.onMessage({ type: "fleetState", tab: "flux" });
    const row = last().data.tables[0].rows.find((r) => r.cells.object === "Kustomization podinfo")!;
    controller.onMessage({ type: "showDetails", ref: row.ref });
    const details = messages.filter((m) => m.type === "details").at(-1)!;
    expect(details).toMatchObject({ details: { title: "Kustomization: flux-system/podinfo", actions: ["reconcile", "suspend"] } });
    controller.onMessage({ type: "action", action: "reconcile", ref: row.ref });
    expect(host.fluxAction).toHaveBeenCalledWith(
      "reconcile",
      expect.objectContaining({ name: "podinfo", resource: "flux:kustomizations" }),
    );
    const ref = { context: "prod-1", resource: "flux:kustomizations", namespace: "flux-system", name: "podinfo" };
    controller.onMessage({ type: "openInCluster", ref });
    expect(host.openInCluster).toHaveBeenCalledWith(ref);
  });

  it("runs the diagnostics and the search of the clusters shown", async () => {
    const { controller, last, start, fake } = setup();
    dispose = () => controller.dispose();
    await start();
    controller.onMessage({ type: "fleetState", group: "dev", tab: "diagnostics" });
    controller.onMessage({ type: "fleetRun", what: "diagnose" });
    await vi.waitFor(() => expect(last().data.tables[0].rows.map((r) => r.cells.cluster)).toEqual(["dev-1"]));
    expect(fake.calls.filter((c) => c.kinds.includes("Pod")).map((c) => c.context)).toEqual(["dev-1"]);
    controller.onMessage({ type: "fleetState", tab: "search", searchKind: "images" });
    controller.onMessage({ type: "fleetRun", what: "search", query: "nginx" });
    await vi.waitFor(() => expect(last().data.tables[0].rows.length).toBeGreaterThan(0));
    expect(last().data.tables[0].rows.every((r) => r.ref.context === "dev-1")).toBe(true);
    expect(last().searchQuery).toBe("nginx");
  });
});
