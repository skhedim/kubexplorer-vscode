// The fleet: groups, summaries of a cluster, the Flux matrix and its drifts, search.
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../../src/kube/types";
import {
  buildMatrix,
  type ClusterScan,
  DriftClock,
  fluxComponents,
  fluxControllerVersion,
  type FluxSummary,
  groupOf,
  groupOrder,
  matchesQuery,
  rolloutDrifts,
  SEARCH_KINDS,
  searchFlux,
  shortRevision,
  summarizeCluster,
} from "../../../src/resources/fleet";
import { byName, fixture } from "../helpers";

const GROUPS = { prod: ["*prod*"], dev: ["*dev*"] };

describe("fleet groups", () => {
  it("puts a context in the first group that matches, or in other", () => {
    expect(groupOf("kind-fleet-prod-1", GROUPS)).toBe("prod");
    expect(groupOf("eks-dev-eu", GROUPS)).toBe("dev");
    expect(groupOf("kind-kubexplorer", GROUPS)).toBe("other");
    expect(groupOf("prod-dev-mix", GROUPS)).toBe("prod");
    expect(groupOrder(GROUPS)).toEqual(["prod", "dev", "other"]);
  });
});

describe("cluster summaries", () => {
  it("shortens revisions", () => {
    expect(shortRevision("main@sha1:4f2a9c1e0b7d55")).toBe("main@4f2a9c1");
    expect(shortRevision("6.9.2@sha1:0123456789")).toBe("6.9.2@0123456");
    expect(shortRevision("sha256:abcdef0123456789")).toBe("sha256:abcdef0");
    expect(shortRevision("6.9.2")).toBe("6.9.2");
    expect(shortRevision(undefined)).toBeUndefined();
  });

  it("sums up the nodes and the Flux objects of a cluster of the development cluster", () => {
    const summary = summarizeCluster({
      nodes: fixture("nodes"),
      flux: {
        "flux:kustomizations": { kind: "Kustomization", items: fixture("flux-kustomizations") },
        "flux:helmreleases": { kind: "HelmRelease", items: fixture("flux-helmreleases") },
        "flux:gitrepositories": { kind: "GitRepository", items: fixture("flux-gitrepositories") },
      },
    });
    expect(summary.nodes!.total).toBe(fixture("nodes").length);
    expect(summary.kubernetes!.length).toBeGreaterThan(0);
    expect(summary.flux).toEqual({ installed: true });
    const podinfo = summary.objects!.find((o) => o.kind === "Kustomization" && o.name === "podinfo")!;
    expect(podinfo).toMatchObject({ state: "Ready", source: "GitRepository/flux-system/podinfo", behind: false });
    expect(podinfo.revision).toMatch(/^6\.9\.2@[0-9a-f]{7}$/);
    const broken = summary.objects!.find((o) => o.name === "broken-path")!;
    expect(broken.message).toBeTruthy();
    // Only the summary fields: no status, no inventory.
    expect(Object.keys(podinfo).sort()).toEqual([
      "apiVersion",
      "behind",
      "kind",
      "message",
      "name",
      "namespace",
      "resource",
      "revision",
      "source",
      "state",
    ]);
  });

  it("knows a cluster without Flux, and tells a Kustomization behind its source", () => {
    expect(summarizeCluster({ nodes: [], flux: {} }).flux).toEqual({ installed: false });
    const git = byName(fixture("flux-gitrepositories"), "podinfo");
    const ks = byName(fixture("flux-kustomizations"), "podinfo");
    const newer = { ...git, status: { ...git.status, artifact: { ...git.status.artifact, revision: "6.9.3@sha1:ffffffffffffff" } } };
    const summary = summarizeCluster({
      flux: {
        "flux:kustomizations": { kind: "Kustomization", items: [ks] },
        "flux:gitrepositories": { kind: "GitRepository", items: [newer] },
      },
    });
    expect(summary.objects!.find((o) => o.kind === "Kustomization")!.behind).toBe(true);
  });

  it("names the controller whose version it shows, not to be read as the version of Flux itself", () => {
    // Flux v2.x runs controllers in v1.x: a bare "v1.9.5" would read as Flux 1.
    expect(fluxControllerVersion({ "source-controller": "v1.9.6", "kustomize-controller": "v1.9.5" })).toBe("kustomize v1.9.5");
    expect(fluxControllerVersion({ "helm-controller": "v1.6.5" })).toBe("helm v1.6.5");
    expect(fluxControllerVersion(undefined)).toBeUndefined();
  });

  it("reads the versions of the Flux controllers", () => {
    const deployment = (name: string, image: string): KubeObject => ({
      metadata: { name, namespace: "flux-system", uid: name },
      spec: { template: { spec: { containers: [{ image }] } } },
    });
    expect(
      fluxComponents([
        deployment("source-controller", "registry.local:5000/fluxcd/source-controller:v1.9.6"),
        deployment("no-tag", "registry.local:5000/fluxcd/x"),
      ]),
    ).toEqual({ "source-controller": "v1.9.6" });
  });
});

const summary = (name: string, extra: Partial<FluxSummary> = {}): FluxSummary => ({
  resource: "flux:kustomizations",
  kind: "Kustomization",
  namespace: "flux-system",
  name,
  state: "Ready",
  revision: "main@aaaaaaa",
  ...extra,
});
const scan = (context: string, group: string, objects: FluxSummary[]): ClusterScan => ({
  context,
  group,
  status: "ok",
  flux: { installed: true },
  objects,
});

describe("Flux matrix", () => {
  const scans: ClusterScan[] = [
    scan("prod-1", "prod", [summary("apps"), summary("monitoring")]),
    scan("prod-2", "prod", [summary("apps", { revision: "main@bbbbbbb" }), summary("monitoring", { state: "Suspended" })]),
    scan("prod-3", "prod", [summary("apps")]),
    scan("dev-1", "dev", [
      summary("apps", { revision: "main@ccccccc" }),
      summary("redis", { state: "Not Ready", message: "path not found" }),
    ]),
    scan("dev-2", "dev", [summary("apps", { revision: "main@ccccccc" })]),
    { context: "prod-down", group: "prod", status: "error", error: "timeout" },
    { context: "dev-noflux", group: "dev", status: "ok", flux: { installed: false }, objects: [] },
  ];
  const rows = buildMatrix(scans);
  const row = (name: string) => rows.find((r) => r.name === name)!;

  it("compares the revisions within each group, not across them", () => {
    // prod runs aaaaaaa (2) and bbbbbbb (1); dev runs ccccccc everywhere: only prod drifts.
    expect(row("apps").drift).toEqual(["2 revisions in prod"]);
    expect(row("apps").expected).toEqual({ prod: "main@aaaaaaa", dev: "main@ccccccc" });
    expect(row("apps").revisions.map((r) => [r.revision, r.contexts.length])).toEqual([
      ["main@aaaaaaa", 2],
      ["main@ccccccc", 2],
      ["main@bbbbbbb", 1],
    ]);
  });

  it("breaks a tie within a group with the revision most clusters run", () => {
    const tie = buildMatrix([
      scan("p1", "prod", [summary("app", { revision: "v2" })]),
      scan("p2", "prod", [summary("app", { revision: "v2" })]),
      scan("d1", "dev", [summary("app", { revision: "v1" })]),
      scan("d2", "dev", [summary("app", { revision: "v2" })]),
    ])[0];
    expect(tie.expected).toEqual({ prod: "v2", dev: "v2" });
    expect(tie.drift).toEqual(["2 revisions in dev"]);
  });

  it("expects an object on every cluster of its groups, Flux installed and reachable", () => {
    expect(row("monitoring").missing).toEqual(["prod-3"]);
    expect(row("monitoring").drift).toEqual(["1 suspended", "missing on 1 cluster"]);
    // dev-2 lacks redis; dev-noflux and prod-down are not compared.
    expect(row("redis").missing).toEqual(["dev-2"]);
  });

  it("puts the failing objects first", () => {
    expect(rows.map((r) => [r.name, r.tone])).toEqual([
      ["redis", "error"],
      ["apps", "warning"],
      ["monitoring", "warning"],
    ]);
  });

  it("does not report missing an object a few clusters of a large group have: it is specific to them", () => {
    const big = Array.from({ length: 6 }, (_, i) =>
      scan(`prod-${i}`, "prod", i === 0 ? [summary("apps"), summary("canary")] : [summary("apps")]),
    );
    const canary = buildMatrix(big).find((r) => r.name === "canary")!;
    expect(canary.missing).toEqual([]);
    expect(canary.partial).toEqual(["1 of 6 in prod"]);
    expect(canary.tone).toBe("ok");
    // On half of the group: expected on all of it.
    const half = buildMatrix(big.map((s, i) => (i < 3 ? { ...s, objects: [...s.objects!, summary("canary")] } : s))).find(
      (r) => r.name === "canary",
    )!;
    expect(half.missing).toEqual(["prod-3", "prod-4", "prod-5"]);
  });
});

describe("drifts over time", () => {
  const GRACE = 10 * 60_000;
  const steady = [scan("p1", "prod", [summary("app")]), scan("p2", "prod", [summary("app")])];
  // A push: p1 takes the new revision first.
  const pushed = [scan("p1", "prod", [summary("app", { revision: "main@new" })]), scan("p2", "prod", [summary("app")])];
  const timed = (clock: DriftClock, scans: ClusterScan[], now: number, complete = true) =>
    buildMatrix(scans, clock.observe(rolloutDrifts(buildMatrix(scans)), now, complete, GRACE))[0];

  it("shows a new drift as a rollout in progress, then as a drift once it lasts", () => {
    const clock = new DriftClock();
    expect(timed(clock, steady, 0).tone).toBe("ok");
    const rolling = timed(clock, pushed, 60_000);
    expect(rolling).toMatchObject({ tone: "info", rollout: ["2 revisions in prod"], drift: [] });
    expect(timed(clock, pushed, 60_000 + GRACE - 1).tone).toBe("info");
    expect(timed(clock, pushed, 60_000 + GRACE)).toMatchObject({ tone: "warning", drift: ["2 revisions in prod"], rollout: [] });
  });

  it("takes the drifts there at the first complete scan as lasting: their age is unknown", () => {
    const clock = new DriftClock();
    // Clusters still being scanned for the first time: nothing is new yet.
    expect(timed(clock, pushed, 0, false).tone).toBe("warning");
    expect(timed(clock, pushed, 1000, true).tone).toBe("warning");
  });

  it("forgets a drift that ended: it is new again when it comes back", () => {
    const clock = new DriftClock();
    timed(clock, pushed, 0);
    timed(clock, steady, 60_000);
    expect(timed(clock, pushed, 120_000).tone).toBe("info");
  });

  it("counts a failure at once, a rollout or not", () => {
    const clock = new DriftClock();
    timed(clock, steady, 0);
    const failing = [
      scan("p1", "prod", [summary("app", { revision: "main@new", state: "Not Ready" })]),
      scan("p2", "prod", [summary("app")]),
    ];
    expect(timed(clock, failing, 60_000)).toMatchObject({ tone: "error", drift: ["1 not ready"], rollout: ["2 revisions in prod"] });
  });
});

describe("fleet search", () => {
  it("matches a substring, or a glob", () => {
    expect(matchesQuery("payments-api", "API")).toBe(true);
    expect(matchesQuery("payments-api", "pay*api")).toBe(true);
    expect(matchesQuery("payments-api", "web*")).toBe(false);
    expect(matchesQuery(undefined, "x")).toBe(false);
  });

  it("finds images in workloads and CronJobs", () => {
    const images = SEARCH_KINDS.find((k) => k.id === "images")!;
    const deployment = byName(fixture("deployments"), "web-app");
    expect(images.match(deployment, "nginx")).toMatch(/^nginx:/);
    expect(images.match(deployment, "postgres")).toBeUndefined();
    const cronjob = fixture("cronjobs")[0];
    const image: string = cronjob.spec.jobTemplate.spec.template.spec.containers[0].image;
    expect(images.match(cronjob, image.split(":")[0])).toBe(image);
  });

  it("finds Flux objects in the scans, by name, revision or source", () => {
    const hits = searchFlux([scan("a", "prod", [summary("apps"), summary("infra", { revision: "main@ddddddd" })])], "ddd");
    expect(hits.map((h) => [h.context, h.name, h.detail])).toEqual([["a", "infra", "Ready · main@ddddddd"]]);
  });
});
