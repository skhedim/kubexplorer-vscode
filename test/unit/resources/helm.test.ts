import { describe, expect, it } from "vitest";
import { chartObject, type HelmClient, releaseObject } from "../../../src/kube/helm";
import { helmcharts, helmreleases } from "../../../src/resources/helm";
import { emptyDetailContext, fixture } from "../helpers";

const release = () =>
  releaseObject(fixture("helm-releases").find((r) => (r as unknown as { name: string }).name === "shop-landing") as never);

describe("Helm descriptors", () => {
  it("lists real releases", () => {
    const row = helmreleases.toRow(release());
    expect(row.cells).toMatchObject({ name: "shop-landing", namespace: "frontend", chart: "demo-app", version: "0.1.0" });
    expect(row.cells.status).toEqual({ text: "deployed", tone: "ok" });
    expect(row.actions).toEqual(["values", "manifest", "rollback", "copyName", "delete"]);
  });

  it("shows notes and history in the details", async () => {
    const helm = {
      notes: async () => "shop-landing is running",
      history: async () => [
        {
          revision: 1,
          updated: "2026-10-18T19:03:08+02:00",
          status: "superseded",
          chart: "demo-app-0.1.0",
          app_version: "1.27",
          description: "Install complete",
        },
        {
          revision: 2,
          updated: "2026-10-18T19:03:09+02:00",
          status: "deployed",
          chart: "demo-app-0.1.0",
          app_version: "1.27",
          description: "Upgrade complete",
        },
      ],
    } as unknown as HelmClient;
    const details = await helmreleases.details(release(), { ...emptyDetailContext, helm });
    const table = details.sections.find((s) => s.type === "table");
    expect(table?.type === "table" && table.rows.map((r) => r.cells.revision)).toEqual(["2", "1"]);
    expect(JSON.stringify(details.sections)).toContain("shop-landing is running");
  });

  it("lists repository charts without an Age column", () => {
    const row = helmcharts.toRow(
      chartObject({
        name: "kyverno/kyverno",
        version: "3.7.1",
        app_version: "v1.17.1",
        description: "Kubernetes Native Policy Management",
      }),
    );
    expect(row.cells).toMatchObject({ name: "kyverno/kyverno", repo: "kyverno", version: "3.7.1" });
    expect(row.cells).not.toHaveProperty("age");
    expect(row.actions).toEqual(["install", "values", "copyName"]);
  });
});
