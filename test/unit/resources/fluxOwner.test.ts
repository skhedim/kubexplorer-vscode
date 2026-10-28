import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../../src/kube/types";
import { fluxOwner } from "../../../src/resources/fluxOwner";
import { metadataItems } from "../../../src/resources/format";
import { ResourceRegistry } from "../../../src/resources/registry";

const object = (labels: Record<string, string>): KubeObject => ({ metadata: { name: "web", namespace: "shop", uid: "u", labels } });

describe("objects managed by Flux", () => {
  it("finds the Kustomization or the HelmRelease that applies an object, from its labels", () => {
    expect(
      fluxOwner(object({ "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" })),
    ).toEqual({ resource: "flux:kustomizations", kind: "Kustomization", name: "apps", namespace: "flux-system" });
    // What a HelmRelease installs: the HelmRelease, even when the Kustomization that applied it labelled it too.
    expect(
      fluxOwner(
        object({
          "helm.toolkit.fluxcd.io/name": "redis",
          "helm.toolkit.fluxcd.io/namespace": "data",
          "kustomize.toolkit.fluxcd.io/name": "apps",
        }),
      ),
    ).toMatchObject({ kind: "HelmRelease", name: "redis", namespace: "data" });
    expect(fluxOwner(object({ app: "web" }))).toBeUndefined();
  });

  it("links to it in the drawer", () => {
    const managed = object({ "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" });
    const item = metadataItems(managed).find((i) => i.name === "Managed By");
    expect(item?.value).toMatchObject({
      link: "flux-system/apps",
      prefix: "Flux Kustomization ",
      ref: { resource: "flux:kustomizations", namespace: "flux-system", name: "apps" },
    });
    expect(metadataItems(object({})).some((i) => i.name === "Managed By")).toBe(false);
  });
});

describe("node and CronJob actions", () => {
  const registry = new ResourceRegistry();
  const node = (spec: object, labels: Record<string, string> = {}): KubeObject => ({ metadata: { name: "n1", uid: "n", labels }, spec });

  it("cordons a schedulable node, uncordons a cordoned one, and opens a shell on Linux nodes only", () => {
    const nodes = registry.require("nodes");
    expect(nodes.toRow(node({})).actions).toEqual(expect.arrayContaining(["nodeShell", "cordon", "drain"]));
    expect(nodes.toRow(node({})).actions).not.toContain("uncordon");
    expect(nodes.toRow(node({ unschedulable: true })).actions).toEqual(expect.arrayContaining(["uncordon", "drain"]));
    expect(nodes.toRow(node({ unschedulable: true })).actions).not.toContain("cordon");
    expect(nodes.toRow(node({}, { "kubernetes.io/os": "windows" })).actions).not.toContain("nodeShell");
    expect(nodes.patches.cordon!(node({}), "")).toEqual({ spec: { unschedulable: true } });
    expect(nodes.patches.uncordon!(node({}), "")).toEqual({ spec: { unschedulable: null } });
  });

  it("suspends and resumes a CronJob", () => {
    const cronjobs = registry.require("cronjobs");
    const cron = (suspend: boolean): KubeObject => ({
      metadata: { name: "backup", namespace: "ops", uid: "c" },
      spec: { suspend, schedule: "0 1 * * *" },
    });
    expect(cronjobs.toRow(cron(false)).actions).toContain("suspend");
    expect(cronjobs.toRow(cron(false)).actions).not.toContain("resume");
    expect(cronjobs.toRow(cron(true)).actions).toContain("resume");
    expect(cronjobs.patches.suspend!(cron(false), "")).toEqual({ spec: { suspend: true } });
    expect(cronjobs.patches.resume!(cron(true), "")).toEqual({ spec: { suspend: false } });
  });
});
