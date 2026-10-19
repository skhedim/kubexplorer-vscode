// What the Fleet tab shows: statuses, tables, details and actions.
import { describe, expect, it } from "vitest";
import { buildMatrix, type ClusterScan, type FluxSummary } from "../../../src/resources/fleet";
import {
  clusterDetails,
  clustersData,
  clusterStatus,
  diagnosticsData,
  distribution,
  fluxData,
  fluxRowActions,
  fluxRowDetails,
  searchData,
} from "../../../src/resources/fleetViews";
import type { Cell } from "../../../src/shared/view";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const ks = (name: string, extra: Partial<FluxSummary> = {}): FluxSummary => ({
  resource: "flux:kustomizations",
  kind: "Kustomization",
  namespace: "flux-system",
  name,
  state: "Ready",
  revision: "main@aaaaaaa",
  ...extra,
});
const scan = (context: string, group: string, objects: FluxSummary[], extra: Partial<ClusterScan> = {}): ClusterScan => ({
  context,
  group,
  status: "ok",
  at: NOW - 90_000,
  kubernetes: ["v1.33.1"],
  nodes: { ready: 3, total: 3 },
  flux: { installed: true, components: { "kustomize-controller": "v1.9.6", "source-controller": "v1.9.6" } },
  objects,
  ...extra,
});

const SCANS: ClusterScan[] = [
  scan("prod-1", "prod", [ks("apps"), ks("monitoring")]),
  scan("prod-2", "prod", [ks("apps", { state: "Not Ready", message: "build failed" }), ks("monitoring", { state: "Suspended" })]),
  scan("dev-1", "dev", [ks("apps", { behind: true })]),
  { context: "prod-down", group: "prod", status: "error", error: "i/o timeout" },
  { context: "dev-new", group: "dev", status: "pending", scanning: true },
];
/** The text a cell shows. */
function text(cell: Cell | undefined): unknown {
  if (!cell || typeof cell !== "object") return cell;
  if ("tags" in cell) return cell.tags[0].text;
  if ("link" in cell) return cell.link;
  return "text" in cell ? cell.text : cell;
}

describe("fleet statuses", () => {
  it("sums up a cluster in one tag", () => {
    expect(SCANS.map((s) => clusterStatus(s).text)).toEqual(["OK", "1 failing", "1 behind", "Unreachable", "Scanning"]);
    expect(clusterStatus({ context: "x", group: "dev", status: "ok", flux: { installed: false } }).text).toBe("No Flux");
    expect(distribution(["v1", "v2", "v1", undefined])).toBe("v1 (2) · v2 (1)");
    expect(distribution(["v1", "v1"])).toBe("v1");
  });
});

describe("Clusters tab", () => {
  it("lists the clusters, the most worrying first, with a card per group", () => {
    const data = clustersData(SCANS, ["prod", "dev"], false, NOW);
    expect(data.cards!.map((c) => [c.title, c.tag!.text])).toEqual([
      ["prod", "2 problems"],
      ["dev", "OK"],
    ]);
    const rows = data.tables[0].rows;
    expect(rows.map((r) => r.cells.cluster)).toEqual(["prod-2", "prod-down", "dev-1", "dev-new", "prod-1"]);
    expect(text(rows.find((r) => r.cells.cluster === "prod-1")!.cells.scanned)).toBe("1m ago");
    expect(rows.find((r) => r.cells.cluster === "prod-1")!.ref).toEqual({ resource: "fleet:cluster", name: "prod-1" });
  });

  it("keeps only the clusters with a problem when asked", () => {
    const rows = clustersData(SCANS, ["prod", "dev"], true, NOW).tables[0].rows;
    expect(rows.map((r) => r.cells.cluster)).toEqual(["prod-2", "prod-down", "dev-1"]);
  });

  it("details a cluster: its Flux objects, failing first, linked to the object in that cluster", () => {
    const details = clusterDetails(SCANS[1], NOW);
    const grid = details.sections.find((s) => s.type === "grid")!;
    expect(grid.type === "grid" && grid.rows[0][1]).toEqual({
      link: "flux-system/apps",
      ref: { context: "prod-2", resource: "flux:kustomizations", namespace: "flux-system", name: "apps" },
    });
    const open = details.sections[0].type === "items" ? details.sections[0].items.find((i) => i.name === "Open")!.value : [];
    expect((open as Cell[]).map((c) => typeof c === "object" && "ref" in c && c.ref.resource)).toEqual([
      "overview",
      "overview:diagnostics",
      "overview:flux",
    ]);
  });
});

describe("Flux tab", () => {
  const rows = buildMatrix(SCANS);

  it("shows each object across the clusters, failing first, and can keep only the problems", () => {
    const data = fluxData(rows, SCANS, false);
    expect(data.tables[0].rows.map((r) => [r.cells.object, text(r.cells.status)])).toEqual([
      ["Kustomization apps", "Failing"],
      ["Kustomization monitoring", "Drift"],
    ]);
    expect(text(data.tables[0].rows[0].cells.clusters)).toBe("2/3 ready");
    expect(fluxData(rows, SCANS, true).tables[0].rows).toHaveLength(2);
  });

  it("details an object: each cluster, the ones missing it, and the actions it allows", () => {
    const monitoring = rows.find((r) => r.name === "monitoring")!;
    expect(fluxRowActions(monitoring)).toEqual(["reconcile", "suspend", "resume"]);
    const details = fluxRowDetails(monitoring, SCANS);
    const grid = details.sections.find((s) => s.type === "grid")!;
    expect(grid.type === "grid" && grid.rows.map((r) => [text(r[0]), text(r[2])])).toEqual([
      ["prod-1", "Ready"],
      ["prod-2", "Suspended"],
    ]);
    expect(fluxRowActions({ ...monitoring, cells: { x: ks("m", { state: "Suspended" }) } })).toEqual(["resume"]);
  });
});

describe("Diagnostics and Search tabs", () => {
  it("lists the diagnosed clusters, the most errors first", () => {
    const diagnosed = [
      scan("a", "prod", [], { diagnostics: { at: NOW, counts: { error: 1, warning: 0, info: 2 }, problems: [] } }),
      scan("b", "prod", [], { diagnostics: { at: NOW, counts: { error: 3, warning: 1, info: 0 }, problems: [] } }),
      scan("c", "dev", []),
    ];
    const data = diagnosticsData(diagnosed, false, NOW);
    expect(data.tables[0].rows.map((r) => r.cells.cluster)).toEqual(["b", "a"]);
    expect(data.cards![0].items[0].value).toBe("2/3 checked");
    expect(diagnosticsData([scan("c", "dev", [])], false, NOW).tables[0].empty).toMatch(/Run the diagnostics/);
  });

  it("sorts the hits, links them to their cluster and reports the failed clusters", () => {
    const data = searchData(
      [
        { context: "b", resource: "deployments", kind: "Deployment", namespace: "web", name: "api", detail: "1/1" },
        { context: "a", resource: "", kind: "", name: "", detail: "timeout", tone: "error" },
        { context: "a", resource: "deployments", kind: "Deployment", namespace: "web", name: "api", detail: "1/1" },
      ],
      true,
      false,
    );
    expect(data.tables[0].rows.map((r) => `${r.cells.cluster} ${r.ref.name}`)).toEqual(["a ", "a api", "b api"]);
    expect(data.tables[0].rows[2].ref).toEqual({ context: "b", resource: "deployments", namespace: "web", name: "api" });
    expect(data.cards![0].items[0].value).toBe("2 objects on 2 clusters");
  });
});
