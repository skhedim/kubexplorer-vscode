// Diagnostics: the rules, on the objects of the development cluster and on crafted ones, and the page.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../../src/kube/types";
import { diagnose, diagnosticsPage, type Problem, problemsOf } from "../../../src/resources/diagnostics";
import { fixture } from "../helpers";

const lists = Object.fromEntries(
  diagnosticsPage.resources.filter((r) => existsSync(join(__dirname, "..", "..", "fixtures", `${r}.json`))).map((r) => [r, fixture(r)]),
);

const find = (problems: Problem[], name: string, rule: string) => problems.find((p) => p.ref.name.startsWith(name) && p.rule === rule);
const NOW = Date.parse("2026-10-19T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const obj = (name: string, extra: Partial<KubeObject> = {}): KubeObject => ({
  ...extra,
  metadata: { name, namespace: "shop", uid: name, ...extra.metadata },
});
const container = (extra: object = {}) => ({
  name: "app",
  image: "registry/app:1.2.3",
  resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } },
  readinessProbe: { httpGet: { path: "/" } },
  ...extra,
});
const deployment = (name: string, spec: object = {}, status: object = { readyReplicas: 1 }) =>
  obj(name, { spec: { replicas: 1, template: { spec: { containers: [container()], ...spec } } }, status });

describe("diagnostics of the development cluster", () => {
  const problems = diagnose({ lists, errors: {} }, NOW);

  it("reports what is broken", () => {
    expect(find(problems, "fraud-scorer-", "container-broken")).toMatchObject({ severity: "error", category: "Pods" });
    expect(find(problems, "fraud-scorer-", "container-broken")!.message).toMatch(/^Container scorer: CrashLoopBackOff, \d+ restarts/);
    expect(find(problems, "ledger-worker", "rollout-stuck")).toMatchObject({ severity: "error", kind: "Deployment" });
    expect(find(problems, "ledger-worker-", "pod-unschedulable")!.message).toMatch(/^Cannot be scheduled: 0\/\d+ nodes are available/);
  });

  it("reports the good practices on the workloads, not on each of their pods", () => {
    const requests = problems.filter((p) => p.rule === "container-no-requests");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((p) => p.kind !== "Pod")).toBe(true);
    expect(find(problems, "web-app", "container-no-requests")!.message).toBe(
      "Container log-shipper has no cpu nor memory request: the scheduler cannot place it reliably",
    );
  });

  it("leaves the good practices of Kubernetes itself alone, not its health", () => {
    expect(problems.some((p) => p.ref.namespace?.startsWith("kube-") && p.rule.startsWith("container-no"))).toBe(false);
    expect(problems.some((p) => p.ref.namespace === "kube-system" && p.severity === "error")).toBe(true);
  });

  it("finds unused ConfigMaps, and no missing reference on a sound cluster", () => {
    expect(find(problems, "web-app-config", "configmap-unused")).toMatchObject({ severity: "info" });
    expect(problems.filter((p) => p.rule === "missing-reference")).toEqual([]);
  });

  it("sorts errors first", () => {
    const order = problems.map((p) => ["error", "warning", "info"].indexOf(p.severity));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("diagnostic rules", () => {
  it("reports a missing ConfigMap or Secret, not an optional one, nor one of a list it could not read", () => {
    const web = deployment("web", {
      volumes: [
        { name: "cfg", configMap: { name: "settings" } },
        { name: "opt", secret: { secretName: "maybe", optional: true } },
      ],
      containers: [container({ envFrom: [{ secretRef: { name: "credentials" } }] })],
    });
    const problems = diagnose({ lists: { deployments: [web], configmaps: [obj("settings")], secrets: [] }, errors: {} }, NOW);
    expect(problems.filter((p) => p.rule === "missing-reference").map((p) => p.message)).toEqual([
      "Uses Secret credentials, which does not exist",
    ]);
    const forbidden = diagnose(
      { lists: { deployments: [web], configmaps: [], secrets: [] }, errors: { secrets: "forbidden", configmaps: "forbidden" } },
      NOW,
    );
    expect(forbidden.filter((p) => p.rule === "missing-reference")).toEqual([]);
  });

  it("reports floating images, missing requests and defaults, outside kube-* namespaces", () => {
    const web = deployment("web", { containers: [container({ image: "nginx", resources: {}, readinessProbe: undefined })] });
    const rules = diagnose({ lists: { deployments: [web] }, errors: {} }, NOW).map((p) => `${p.severity} ${p.rule}: ${p.message}`);
    expect(rules).toEqual([
      "warning container-no-requests: Container app has no cpu nor memory request: the scheduler cannot place it reliably",
      "warning image-floating: Container app runs nginx: the version can change on any restart",
      "info container-defaults: Container app has no memory limit nor readiness probe (it receives traffic as soon as it starts)",
    ]);
    const system = { ...web, metadata: { ...web.metadata, namespace: "kube-system" } };
    expect(diagnose({ lists: { deployments: [system] }, errors: {} }, NOW)).toEqual([]);
    expect(
      diagnose(
        { lists: { deployments: [deployment("pinned", { containers: [container({ image: "nginx@sha256:abc" })] })] }, errors: {} },
        NOW,
      ),
    ).toEqual([]);
  });

  it("tells a pod not ready for a while from one that just started", () => {
    const pod = (since: number) =>
      obj(`p${since}`, {
        metadata: {
          name: `p${since}`,
          namespace: "shop",
          uid: "u",
          ownerReferences: [{ kind: "ReplicaSet", name: "rs", controller: true }],
        },
        spec: { containers: [container()] },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "False", lastTransitionTime: ago(since) }] },
      });
    const problems = diagnose({ lists: { pods: [pod(2), pod(90)] }, errors: {} }, NOW);
    expect(problems.map((p) => `${p.ref.name}: ${p.message}`)).toEqual(["p90: Not ready for 1h"]);
  });

  it("reports OOM kills and frequent restarts", () => {
    const pod = obj("p", {
      metadata: { name: "p", namespace: "shop", uid: "u", ownerReferences: [{ kind: "ReplicaSet", name: "rs", controller: true }] },
      spec: { containers: [container()] },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "app", restartCount: 7, ready: true, state: { running: {} }, lastState: { terminated: { reason: "OOMKilled" } } },
        ],
      },
    });
    expect(diagnose({ lists: { pods: [pod] }, errors: {} }, NOW).map((p) => p.rule)).toEqual(["container-restarts", "container-oom"]);
  });

  it("reports services that reach no pod, and ingresses pointing nowhere", () => {
    const pod = obj("p", {
      metadata: {
        name: "p",
        namespace: "shop",
        uid: "u",
        labels: { app: "web" },
        ownerReferences: [{ kind: "ReplicaSet", name: "rs", controller: true }],
      },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "False", lastTransitionTime: ago(1) }] },
    });
    const services = [
      obj("web", { spec: { selector: { app: "web" }, ports: [{ name: "http", port: 80 }] } }),
      obj("ghost", { spec: { selector: { app: "ghost" } } }),
    ];
    const ingress = obj("site", {
      spec: {
        rules: [
          {
            http: {
              paths: [
                { backend: { service: { name: "web", port: { name: "https" } } } },
                { backend: { service: { name: "gone", port: { number: 80 } } } },
              ],
            },
          },
        ],
        tls: [{ secretName: "site-tls" }],
      },
    });
    const problems = diagnose({ lists: { pods: [pod], services, ingresses: [ingress], secrets: [] }, errors: {} }, NOW);
    expect(problems.map((p) => `${p.ref.name} ${p.rule}`)).toEqual([
      "site ingress-missing-service",
      "site ingress-missing-tls",
      "web service-no-ready-pods",
      "ghost service-no-pods",
      "site ingress-missing-port",
    ]);
  });

  it("reports nodes, storage, autoscalers and disruption budgets", () => {
    const node = obj("n1", {
      metadata: { name: "n1", uid: "n1" },
      spec: { unschedulable: true },
      status: {
        conditions: [
          { type: "Ready", status: "False", message: "kubelet stopped posting node status" },
          { type: "DiskPressure", status: "True" },
        ],
      },
    });
    const pvc = obj("data", { status: { phase: "Pending" } });
    const pv = obj("pv1", { metadata: { name: "pv1", uid: "pv1" }, status: { phase: "Released" } });
    const hpa = obj("web", {
      spec: { scaleTargetRef: { kind: "Deployment", name: "web" }, maxReplicas: 3 },
      status: { currentReplicas: 3 },
    });
    const lost = obj("lost", {
      spec: { scaleTargetRef: { kind: "Deployment", name: "gone" }, maxReplicas: 3 },
      status: { currentReplicas: 1 },
    });
    const pdb = obj("web", { status: { expectedPods: 2, disruptionsAllowed: 0 } });
    const problems = diagnose(
      {
        lists: {
          nodes: [node],
          persistentvolumeclaims: [pvc],
          persistentvolumes: [pv],
          horizontalpodautoscalers: [hpa, lost],
          poddisruptionbudgets: [pdb],
          deployments: [deployment("web")],
        },
        errors: {},
      },
      NOW,
    );
    expect(problems.map((p) => `${p.severity} ${p.kind} ${p.ref.name}: ${p.message}`)).toEqual([
      // Sorted by severity, then by namespace and name.
      "error HorizontalPodAutoscaler lost: Scales Deployment gone, which does not exist",
      "error Node n1: Not ready: kubelet stopped posting node status",
      "warning PersistentVolumeClaim data: Pending: no volume is bound to it",
      "warning Node n1: DiskPressure: pods may be evicted",
      "warning HorizontalPodAutoscaler web: At its maximum of 3 replicas: it cannot scale further",
      "warning PodDisruptionBudget web: Allows no disruption: it blocks the drain of nodes",
      "info Node n1: Cordoned: no new pod is scheduled on it",
      "info PersistentVolume pv1: Released: its claim was deleted, its data is kept",
    ]);
  });
});

describe("Diagnostics page", () => {
  it("scores the health, sums up each category and lists the problems per category", () => {
    const input = { lists, errors: {} };
    const data = diagnosticsPage.build(input);
    const [health, ...categories] = data.cards!;
    expect(health.title).toBe("Health");
    expect(health.tag!.text).toMatch(/^\d+%$/);
    expect(categories.map((c) => c.title)).toEqual(["Nodes", "Workloads", "Pods", "Network", "Configuration", "Storage", "Autoscaling"]);
    const workloads = data.tables.find((t) => t.title === "Workloads")!;
    expect(workloads.icon).toBe("error");
    expect(workloads.rows[0].cells.severity).toEqual({ tags: [{ text: "Error", tone: "error" }], solid: true });
    // Every row opens its object, and the Problems view gets the same problems.
    expect(data.tables.flatMap((t) => t.rows).every((r) => r.ref.name && r.ref.resource)).toBe(true);
    expect(diagnosticsPage.problems!(input)).toBe(problemsOf(input));
  });

  it("says when a kind could not be read", () => {
    const data = diagnosticsPage.build({ lists: { ...lists, secrets: [] }, errors: { secrets: "secrets is forbidden" } });
    const configuration = data.cards!.find((c) => c.title === "Configuration")!;
    expect(configuration.items.find((i) => i.name === "Unavailable")?.value).toMatchObject({ text: "Secret", tone: "warning" });
  });
});
