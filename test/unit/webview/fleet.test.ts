// @vitest-environment happy-dom
// The Fleet tab in the webview: header controls, filtering, and objects opened in their cluster.
import { describe, expect, it } from "vitest";
import type { HostMessage, WebviewMessage } from "../../../src/shared/protocol";
import type { FleetView, Row } from "../../../src/shared/view";
import { App } from "../../../src/webview/app";

const row = (context: string, status: string): Row => ({
  uid: `cluster:${context}`,
  ref: { resource: "fleet:cluster", name: context },
  cells: { cluster: context, status },
  sort: { cluster: context },
  search: `${context} ${status}`.toLowerCase(),
  actions: [],
});

const view = (extra: Partial<FleetView> = {}): FleetView => ({
  tab: "clusters",
  groups: ["prod", "dev"],
  group: null,
  problemsOnly: false,
  clusters: 3,
  updated: "scanned 1m ago",
  searchKinds: [
    { id: "workloads", label: "Workloads" },
    { id: "images", label: "Images" },
  ],
  searchKind: "workloads",
  searchQuery: "",
  data: {
    donuts: [],
    tables: [
      {
        title: "Clusters",
        columns: [
          { id: "cluster", title: "Cluster" },
          { id: "status", title: "Status" },
        ],
        rows: [row("prod-1", "OK"), row("prod-2", "1 failing"), row("dev-1", "OK")],
        empty: "No cluster",
      },
    ],
  },
  ...extra,
});

function setup(v: FleetView = view()) {
  document.body.innerHTML = `<div id="app"></div>`;
  const sent: WebviewMessage[] = [];
  const app = new App(document.getElementById("app")!, {
    postMessage: (m) => sent.push(m),
    getState: () => undefined,
    setState: () => undefined,
  });
  app.start();
  const receive = (msg: HostMessage) => window.dispatchEvent(new MessageEvent("message", { data: msg }));
  receive({ type: "init", appearance: "vscode", view: { mode: "fleet", context: "", target: { kind: "fleet" }, title: "Fleet" } });
  receive({ type: "fleet", view: v });
  return { sent, receive };
}

const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();
const rows = () => [...document.querySelectorAll(".overview-table .row:not(.head)")].map((r) => r.textContent?.trim());

describe("webview Fleet tab", () => {
  it("shows the tabs, the groups and the status of the scans", () => {
    setup();
    expect([...document.querySelectorAll(".fleet-tab")].map((t) => t.textContent?.trim())).toEqual([
      "Clusters",
      "Flux",
      "Diagnostics",
      "Search",
    ]);
    expect([...document.querySelectorAll('[data-action="fleet-group"]')].map((t) => t.textContent)).toEqual(["All", "prod", "dev"]);
    expect(document.getElementById("r-fleet-status")?.textContent).toBe("3 clusters · scanned 1m ago");
    expect(rows()).toHaveLength(3);
  });

  it("asks the extension for another tab, group or filter", () => {
    const { sent } = setup();
    click('[data-action="fleet-tab"][data-tab="flux"]');
    expect(sent.at(-1)).toEqual({ type: "fleetState", tab: "flux" });
    click('[data-action="fleet-group"][data-group="prod"]');
    expect(sent.at(-1)).toEqual({ type: "fleetState", group: "prod" });
    click('[data-action="fleet-group"][data-group=""]');
    expect(sent.at(-1)).toEqual({ type: "fleetState", group: null });
    click('[data-action="fleet-problems"]');
    expect(sent.at(-1)).toEqual({ type: "fleetState", problemsOnly: true });
    click('[data-action="fleet-run"][data-what="scan"]');
    expect(sent.at(-1)).toMatchObject({ type: "fleetRun", what: "scan" });
  });

  it("filters the rows with the search box, and updates the progress without touching the controls", () => {
    const { receive } = setup();
    const input = document.getElementById("search") as HTMLInputElement;
    input.value = "prod";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows()).toHaveLength(2);
    const header = document.querySelector(".fleet-tabs");
    receive({ type: "fleet", view: view({ progress: { label: "Scanning", done: 1, total: 3 } }) });
    expect(document.getElementById("r-fleet-status")?.textContent).toContain("Scanning 1/3");
    // The controls were not rendered again.
    expect(document.querySelector(".fleet-tabs")).toBe(header);
  });

  it("searches on Enter in the Search tab, with the chosen kind", () => {
    const { sent } = setup(view({ tab: "search", data: { donuts: [], tables: [] } }));
    const select = document.getElementById("fleet-kind") as HTMLSelectElement;
    select.value = "images";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "fleetState", searchKind: "images" });
    const input = document.getElementById("search") as HTMLInputElement;
    input.value = "nginx";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Typing renders the header again: the box is a new element, focused like the previous one.
    document.getElementById("search")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "fleetRun", what: "search", query: "nginx" });
  });

  it("opens the details of a fleet row, and an object of a cluster in that cluster", () => {
    const hit: Row = {
      ...row("prod-1", "x"),
      uid: "hit:0",
      ref: { context: "prod-1", resource: "deployments", namespace: "web", name: "api" },
    };
    const { sent, receive } = setup();
    click(".overview-table .row:not(.head)");
    expect(sent.at(-1)).toEqual({ type: "showDetails", ref: { resource: "fleet:cluster", name: "prod-1" } });
    receive({
      type: "fleet",
      view: view({
        tab: "search",
        data: { donuts: [], tables: [{ title: "Results", columns: [{ id: "cluster", title: "Cluster" }], rows: [hit], empty: "" }] },
      }),
    });
    click('.overview-table .row[data-uid="hit:0"]');
    expect(sent.at(-1)).toEqual({ type: "openInCluster", ref: hit.ref });
  });
});
