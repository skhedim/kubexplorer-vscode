import { describe, expect, it } from "vitest";
import { chartObject, DemoHelm, helmDate, releaseObject, splitChart } from "../../../src/kube/helm";

describe("Helm parsing", () => {
  it("converts helm list dates to ISO 8601", () => {
    expect(helmDate("2026-10-18 19:03:08.747354579 +0200 CEST")).toBe("2026-10-18T19:03:08.747+02:00");
    expect(Date.parse(helmDate("2026-10-18 19:03:08.747354579 +0200 CEST")!)).toBe(Date.parse("2026-10-18T17:03:08.747Z"));
    expect(helmDate(undefined)).toBeUndefined();
  });

  it("splits chart names and versions", () => {
    expect(splitChart("demo-app-0.1.0")).toEqual({ name: "demo-app", version: "0.1.0" });
    expect(splitChart("kube-prometheus-stack-62.7.0")).toEqual({ name: "kube-prometheus-stack", version: "62.7.0" });
    expect(splitChart("cert-manager-v1.15.3")).toEqual({ name: "cert-manager-v1.15.3", version: "" });
  });

  it("shapes releases and charts like Kubernetes objects", () => {
    const release = releaseObject({
      name: "web",
      namespace: "prod",
      revision: "3",
      updated: "2026-10-18 19:03:08.7 +0200 CEST",
      status: "deployed",
      chart: "web-1.2.0",
      app_version: "2",
    });
    expect(release.metadata).toMatchObject({ name: "web", namespace: "prod", uid: "helm-release:prod/web", resourceVersion: "3" });
    expect(release.helm).toMatchObject({ revision: 3, chartName: "web", chartVersion: "1.2.0" });
    const chart = chartObject({ name: "bitnami/redis", version: "20.1.3", app_version: "7.4.0", description: "Redis" });
    expect(chart.helm).toMatchObject({ repo: "bitnami", chart: "redis" });
  });

  it("simulates history and rollbacks on the demo cluster", async () => {
    const helm = new DemoHelm();
    const history = await helm.history("demo", "payments", "fraud-scorer");
    expect(history.at(-1)).toMatchObject({ revision: 7, status: "failed" });
    await helm.rollback("demo", "payments", "fraud-scorer");
    const [release] = (await helm.listReleases("demo", ["payments"])).filter((r) => r.metadata.name === "fraud-scorer");
    expect(release.helm).toMatchObject({ revision: 8, status: "deployed" });
  });
});
