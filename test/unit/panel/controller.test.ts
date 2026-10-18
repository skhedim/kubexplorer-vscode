// The tab controller, end to end on the demo cluster (no VS Code involved).
import { describe, expect, it, vi } from "vitest";
import { DEMO_CONTEXT, DemoClient } from "../../../src/kube/demo";
import { ResourceStore } from "../../../src/kube/store";
import { nullLogger } from "../../../src/kube/types";
import { PanelController, type PanelHost } from "../../../src/panel/controller";
import { ResourceRegistry } from "../../../src/resources/registry";
import type { HostMessage } from "../../../src/shared/protocol";

type Message<T extends HostMessage["type"]> = Extract<HostMessage, { type: T }>;

function setup(resource: string) {
  const messages: HostMessage[] = [];
  const host: PanelHost = {
    post: (m) => messages.push(m),
    runAction: vi.fn(),
    rowMenu: vi.fn(),
    deleteMany: vi.fn(),
    openResource: vi.fn(),
    setNamespaces: vi.fn(),
    refresh: vi.fn(),
    copyText: vi.fn(),
  };
  const client = new DemoClient();
  const controller = new PanelController({
    context: DEMO_CONTEXT,
    target: resource === "overview" ? { kind: "overview" } : { kind: "list", resource },
    registry: new ResourceRegistry(),
    store: new ResourceStore(client, { pollIntervalMs: () => 60_000 }, nullLogger),
    client,
    host,
    log: nullLogger,
    appearance: "vscode",
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

  it("builds the overview from every list", async () => {
    const { until, start } = setup("overview");
    start();
    const overview = await until("overview", (m) => !m.loading);
    expect(overview.data.donuts.find((d) => d.resource === "pods")!.slices.length).toBeGreaterThan(1);
    expect(overview.data.events.rows).toHaveLength(2);
    expect(overview.data.usage?.cpu).toBeDefined();
  });
});
