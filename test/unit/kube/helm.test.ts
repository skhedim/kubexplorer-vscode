import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chartObject, DemoHelm, HelmCli, helmDate, releaseObject, splitChart } from "../../../src/kube/helm";
import { nullLogger } from "../../../src/kube/types";

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

describe.skipIf(process.platform === "win32")("HelmCli", () => {
  /** A fake helm: records its arguments; Helm 4 refuses `list --all`, and lists every release without it. */
  function fakeHelm(major: 3 | 4) {
    const dir = mkdtempSync(join(tmpdir(), "kx-fake-helm-"));
    const helm = join(dir, "helm");
    const calls = join(dir, "calls");
    writeFileSync(
      helm,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
if (${major} === 4 && args.includes("--all")) { process.stderr.write("Error: unknown flag: --all\\n"); process.exit(1); }
process.stdout.write(JSON.stringify([{ name: "web", namespace: "shop", revision: "2", updated: "2026-10-28 10:00:00.0 +0000 UTC", status: "deployed", chart: "web-1.0.0", app_version: "1.0" }]));
`,
    );
    chmodSync(helm, 0o755);
    return {
      cli: new HelmCli(() => helm, nullLogger),
      calls: () => readFileSync(calls, "utf8").trim().split("\n"),
      dispose: () => rmSync(dir, { recursive: true }),
    };
  }

  it("lists every release with Helm 3 (--all) and Helm 4 (all by default, no --all)", async () => {
    for (const major of [3, 4] as const) {
      const helm = fakeHelm(major);
      try {
        expect((await helm.cli.listReleases("kind", [])).map((r) => r.metadata.name)).toEqual(["web"]);
        // Helm 4: asked once with --all, then never again.
        await helm.cli.listReleases("kind", []);
        const lists = helm.calls().filter((c) => c.startsWith("list"));
        expect(lists.map((c) => c.includes("--all ") || c.endsWith("--all"))).toEqual(major === 3 ? [true, true] : [true, false, false]);
      } finally {
        helm.dispose();
      }
    }
  });
});
