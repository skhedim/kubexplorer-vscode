// The tab controller, end to end on the demo cluster (no VS Code involved).
import { describe, expect, it, vi } from "vitest";
import { CrdCatalog } from "../../../src/kube/crds";
import { DEMO_CONTEXT, DemoClient } from "../../../src/kube/demo";
import { DemoMetrics } from "../../../src/kube/prometheus";
import { ResourceStore } from "../../../src/kube/store";
import { nullLogger } from "../../../src/kube/types";
import { PanelController, type PanelHost } from "../../../src/panel/controller";
import { MetricsHistory, MetricsService } from "../../../src/panel/metrics";
import { menuTarget } from "../../../src/resources/menu";
import { ResourceRegistry } from "../../../src/resources/registry";
import type { Protection } from "../../../src/shared/protection";
import type { HostMessage } from "../../../src/shared/protocol";

type Message<T extends HostMessage["type"]> = Extract<HostMessage, { type: T }>;

function setup(resource: string, protection?: Protection) {
  const messages: HostMessage[] = [];
  const host: PanelHost = {
    post: (m) => messages.push(m),
    runAction: vi.fn(),
    rowMenu: vi.fn(),
    bulkAction: vi.fn(),
    openResource: vi.fn(),
    setNamespaces: vi.fn(),
    refresh: vi.fn(),
    copyText: vi.fn(),
    updateSecret: vi.fn(async () => true),
    reportProblems: vi.fn(),
  };
  const client = new DemoClient();
  const registry = new ResourceRegistry();
  const controller = new PanelController({
    context: DEMO_CONTEXT,
    target: menuTarget(resource),
    registry,
    metrics: new MetricsService({ backend: new DemoMetrics(), client, registry, history: new MetricsHistory(), log: nullLogger }),
    crds: new CrdCatalog(client),
    store: new ResourceStore(client, { pollIntervalMs: () => 60_000 }, nullLogger),
    client,
    host,
    log: nullLogger,
    appearance: "vscode",
    protection,
    namespaces: { available: [], selected: [] },
  });
  const until = async <T extends HostMessage["type"]>(type: T, accept: (m: Message<T>) => boolean = () => true): Promise<Message<T>> => {
    const find = () => messages.filter((m): m is Message<T> => m.type === type).find(accept);
    await vi.waitFor(() => expect(find()).toBeDefined());
    return find()!;
  };
  const start = () => {
    controller.onMessage({ type: "ready" });
    controller.setVisible(true);
  };
  return { controller, host, messages, until, start };
}

describe("PanelController", () => {
  it("queries the cluster only once visible and ready", async () => {
    const { controller, messages, until } = setup("pods");
    controller.onMessage({ type: "ready" });
    expect(messages.map((m) => m.type)).toEqual(["init", "namespaces"]);
    controller.setVisible(true);
    const rows = await until("rows", (m) => !m.loading);
    expect(rows.rows.length).toBeGreaterThan(5);
  });

  it("pushes the details of an object of another kind (drawer links)", async () => {
    const { controller, until, start } = setup("pods");
    start();
    await until("rows", (m) => !m.loading);
    controller.onMessage({ type: "showDetails", ref: { resource: "deployments", namespace: "frontend", name: "web-app" } });
    const { details } = await until("details", (m) => m.details !== null);
    expect(details?.title).toBe("Deployment: web-app");
    expect(details?.sections.some((s) => s.type === "table" && s.rows.length === 3)).toBe(true);
  });

  it("reveals one Secret value on request only", async () => {
    const { controller, messages, until, start } = setup("secrets");
    start();
    await until("rows", (m) => !m.loading);
    expect(JSON.stringify(messages)).not.toContain("secret-value");
    controller.onMessage({
      type: "revealSecret",
      ref: { resource: "secrets", namespace: "payments", name: "payments-db" },
      key: "password",
    });
    const revealed = await until("secretValue");
    expect(revealed).toMatchObject({ key: "password", value: "secret" });
  });

  it("reports an unknown Secret key", async () => {
    const { controller, until, start } = setup("secrets");
    start();
    controller.onMessage({ type: "revealSecret", ref: { resource: "secrets", namespace: "payments", name: "payments-db" }, key: "nope" });
    const revealed = await until("secretValue");
    expect(revealed.error).toMatch(/not found/);
  });

  it("forwards actions to the host with the tab context", () => {
    const { controller, host } = setup("pods");
    const ref = { resource: "pods", namespace: "a", name: "b" };
    controller.onMessage({ type: "action", action: "logs", ref, container: "c" });
    expect(host.runAction).toHaveBeenCalledWith(DEMO_CONTEXT, "logs", ref, "c");
    controller.onMessage({ type: "copyText", text: "x" });
    expect(host.copyText).toHaveBeenCalledWith("x");
  });

  it("saves a Secret value through the host, and reports the outcome to the webview", async () => {
    const { controller, host, until } = setup("secrets");
    const ref = { resource: "secrets", namespace: "payments", name: "payments-db" };
    controller.onMessage({ type: "updateSecret", ref, key: "password", value: "n3w" });
    expect(host.updateSecret).toHaveBeenCalledWith(DEMO_CONTEXT, ref, "password", "n3w");
    expect(await until("secretUpdated")).toEqual({ type: "secretUpdated", key: "password", saved: true });
    vi.mocked(host.updateSecret).mockRejectedValueOnce(new Error("Conflict"));
    controller.onMessage({ type: "updateSecret", ref, key: "password", value: "x" });
    expect(await until("secretUpdated", (m) => !!m.error)).toMatchObject({ saved: false, error: "Conflict" });
  });

  it("forwards bulk actions on the checked rows", () => {
    const { controller, host } = setup("deployments");
    const refs = [
      { resource: "deployments", namespace: "a", name: "b" },
      { resource: "deployments", namespace: "a", name: "c" },
    ];
    controller.onMessage({ type: "bulkAction", action: "restart", refs });
    expect(host.bulkAction).toHaveBeenCalledWith(DEMO_CONTEXT, "restart", refs);
  });

  it("hides the actions that change the cluster on a read-only context", async () => {
    const { controller, messages, until, start } = setup("pods", "readOnly");
    start();
    expect(messages.find((m) => m.type === "init")).toMatchObject({ view: { protection: "readOnly" } });
    const { rows } = await until("rows", (m) => !m.loading);
    expect(rows[0].actions).toEqual(["logs", "portForward", "edit", "describe", "copyName"]);
    controller.onMessage({ type: "showDetails", ref: rows[0].ref });
    const { details } = await until("details", (m) => m.details !== null);
    expect(details!.actions).not.toContain("delete");
    const groups = details!.sections.flatMap((s) => (s.type === "group" ? (s.actions ?? []).map((a) => a.action) : []));
    expect(groups).toContain("logs");
    expect(groups).not.toContain("shell");
    expect(groups).not.toContain("debug");
  });

  it("follows a change of protection: the header, then the actions", async () => {
    const { controller, messages, until, start } = setup("deployments");
    start();
    const before = await until("rows", (m) => !m.loading);
    expect(before.rows[0].actions).toContain("restart");
    messages.length = 0;
    controller.setProtection("readOnly");
    expect(messages[0]).toEqual({ type: "protection", protection: "readOnly" });
    const after = await until("rows");
    expect(after.rows[0].actions).toEqual(["logs", "edit", "describe", "copyName"]);
  });

  it("publishes the problems of the Diagnostics page once loaded, and clears them when closed", async () => {
    const { controller, host, until, start } = setup("overview:diagnostics");
    start();
    const overview = await until("overview", (m) => !m.loading);
    expect(overview.data.cards![0].title).toBe("Health");
    await vi.waitFor(() => expect(host.reportProblems).toHaveBeenCalled());
    const [context, problems] = vi.mocked(host.reportProblems!).mock.calls.at(-1)!;
    expect(context).toBe(DEMO_CONTEXT);
    expect(problems.some((p) => p.ref.name === "fraud-scorer" && p.severity === "error")).toBe(true);
    controller.dispose();
    expect(host.reportProblems).toHaveBeenLastCalledWith(DEMO_CONTEXT, []);
  });

  it("builds the overview from every list", async () => {
    const { until, start } = setup("overview");
    start();
    const overview = await until("overview", (m) => !m.loading);
    expect(overview.data.donuts.find((d) => d.resource === "pods")!.slices.length).toBeGreaterThan(1);
    expect(overview.data.tables[0].rows).toHaveLength(2);
    expect(overview.data.usage?.cpu).toBeDefined();
  });

  it("sends the usage charts of the object shown in the drawer, after its details", async () => {
    const { controller, messages, until, start } = setup("pods");
    start();
    const rows = await until("rows", (m) => !m.loading);
    const pod = rows.rows.find((r) => r.ref.name.startsWith("web-app"))!;
    controller.onMessage({ type: "showDetails", ref: pod.ref });
    const metrics = await until("metrics");
    expect(metrics.uid).toBe(pod.uid);
    expect(metrics.data!.charts.map((c) => c.id)).toEqual(["cpu", "memory", "network", "filesystem"]);
    const types = messages.map((m) => m.type);
    expect(types.indexOf("details")).toBeLessThan(types.indexOf("metrics"));
    controller.dispose();
  });

  it("shows that an integration is not installed", async () => {
    // The demo cluster has no Flux CRD: the page subscribes to the events only.
    const { until, start, controller } = setup("overview:flux");
    start();
    const overview = await until("overview", (m) => !m.loading);
    expect(overview.data.empty).toMatch(/Flux is not installed/);
    expect(controller.title()).toBe("Flux");
  });
});
