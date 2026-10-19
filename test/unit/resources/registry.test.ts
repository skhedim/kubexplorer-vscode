// Every descriptor must render every real object of its kind, as rows and as details.
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../../src/kube/types";
import type { DetailContext } from "../../../src/resources/descriptor";
import { flattenMenu, menuTarget } from "../../../src/resources/menu";
import { buildOverview } from "../../../src/resources/overview";
import { overviewPage, ResourceRegistry } from "../../../src/resources/registry";
import { fixture } from "../helpers";

const registry = new ResourceRegistry();
const FIXTURES = [
  "pods",
  "deployments",
  "statefulsets",
  "daemonsets",
  "replicasets",
  "jobs",
  "cronjobs",
  "nodes",
  "namespaces",
  "events",
  "services",
  "configmaps",
  "secrets",
  "ingresses",
  "persistentvolumeclaims",
  "persistentvolumes",
  "storageclasses",
  "podmetrics",
  "nodemetrics",
];

const ctx: DetailContext = {
  context: "test",
  list: async (resource) => (FIXTURES.includes(resource) ? fixture(resource) : []),
  rowsOf: (resource, items) => {
    const d = registry.require(resource);
    return { columns: d.compactColumns, rows: items.map((o: KubeObject) => d.toCompactRow(o)) };
  },
};

describe.each(FIXTURES)("%s", (resource) => {
  const descriptor = registry.require(resource);
  const items = fixture(resource);

  it("renders a cell for every column of every object", () => {
    expect(items.length).toBeGreaterThan(0);
    for (const o of items) {
      const row = descriptor.toRow(o);
      for (const col of descriptor.columns) if (col.id !== "warning") expect(row.cells).toHaveProperty(col.id);
    }
  });

  it("builds the details", async () => {
    const details = await descriptor.details(items[0], ctx);
    // The usage charts come first, then the metadata.
    expect(details.sections[0].type).toBe(descriptor.metrics ? "metrics" : "items");
    expect(details.sections.some((s) => s.type === "items")).toBe(true);
    expect(details.ref).toEqual({ resource, namespace: items[0].metadata.namespace, name: items[0].metadata.name });
  });
});

describe("registry", () => {
  it("covers every entry of the Freelens menu", () => {
    for (const { open } of flattenMenu()) {
      const target = menuTarget(open);
      if (target.kind === "list") expect(registry.get(target.resource), open).toBeDefined();
      else expect(overviewPage(target.page).id, open).toBe(target.page);
    }
  });

  it("never puts Secret values in the view model, only revealable keys", async () => {
    const secret = fixture("secrets")[0];
    const details = await registry.require("secrets").details(secret, ctx);
    expect(JSON.stringify(details)).not.toContain(Object.values(secret.data)[0] as string);
    const items = details.sections.flatMap((s) => (s.type === "items" ? s.items : []));
    expect(items.filter((i) => i.secretKey).map((i) => i.secretKey)).toEqual(Object.keys(secret.data));
  });

  it("offers the logs of every workload with a selector, and decoded editing of Secrets", () => {
    for (const resource of ["deployments", "statefulsets", "daemonsets", "replicasets", "jobs"]) {
      for (const o of fixture(resource)) {
        expect(registry.require(resource).toRow(o).actions, resource).toContain("logs");
        expect(o.spec?.selector?.matchLabels, `${resource} ${o.metadata.name}`).toBeDefined();
      }
    }
    expect(registry.require("cronjobs").actions).not.toContain("logs");
    expect(registry.require("secrets").actions).toEqual(["editDecoded", "edit", "describe", "copyName", "delete"]);
  });

  it("finds the pods of a Deployment through its selector", async () => {
    const deployment = fixture("deployments").find((d) => d.metadata.name === "web-app")!;
    let selector: string | undefined;
    await registry.require("deployments").details(deployment, { ...ctx, list: async (_r, opts) => ((selector = opts.labelSelector), []) });
    expect(selector).toBe("app.kubernetes.io/name=web-app");
  });

  it("generates a CRD descriptor with its printer columns", () => {
    const id = registry.registerCrd({
      metadata: { name: "certificates.cert-manager.io", uid: "u" },
      spec: {
        group: "cert-manager.io",
        scope: "Namespaced",
        names: { kind: "Certificate", plural: "certificates" },
        versions: [
          {
            name: "v1",
            storage: true,
            additionalPrinterColumns: [{ name: "Ready", type: "string", jsonPath: ".status.conditions[0].status" }],
          },
        ],
      },
    });
    const descriptor = registry.require(id);
    expect(descriptor.kubectlName).toBe("certificates.cert-manager.io");
    const row = descriptor.toRow({
      metadata: { name: "tls", namespace: "default", uid: "x" },
      status: { conditions: [{ status: "True" }] },
    });
    expect(row.cells.pc0).toBe("True");
  });
});

describe("overview", () => {
  it("counts the statuses of real workloads", () => {
    const data = buildOverview({
      lists: { pods: fixture("pods"), deployments: fixture("deployments"), jobs: fixture("jobs"), events: fixture("events") },
      errors: {},
    });
    const pods = data.donuts.find((d) => d.resource === "pods")!;
    expect(pods.slices.find((s) => s.tone === "error")?.value).toBeGreaterThanOrEqual(1);
    expect(pods.slices.find((s) => s.tone === "warning")?.value).toBeGreaterThanOrEqual(1);
    const deployments = data.donuts.find((d) => d.resource === "deployments")!;
    expect(deployments.slices.reduce((n, s) => n + s.value, 0)).toBe(fixture("deployments").length);
    expect(data.tables[0].rows.length).toBeGreaterThan(0);
  });
});
