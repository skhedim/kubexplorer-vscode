// The Fleet tab of the browser preview: a simulated fleet of six clusters, built on the demo cluster, with Flux
// objects in every state the tab renders (ready, failing, suspended, behind their source, revision and chart
// version drifts, an object missing on a cluster) and an unreachable cluster.

import type { ManyResult, NamedKind } from "../src/kube/client";
import { DemoClient } from "../src/kube/demo";
import { type KubeObject, nullLogger } from "../src/kube/types";
import { FleetController } from "../src/panel/fleetController";
import { FleetScanner } from "../src/panel/fleetScanner";
import { groupOf, groupOrder } from "../src/resources/fleet";
import type { ResourceRegistry } from "../src/resources/registry";
import type { Appearance, HostMessage } from "../src/shared/protocol";

const GROUPS = { prod: ["*prod*"], dev: ["*dev*"] };
const CONTEXTS = ["prod-eu-1", "prod-eu-2", "prod-us-1", "dev-1", "dev-2", "prod-legacy"];
const REV = { current: "main@sha1:4f2a9c1e0b7d", previous: "main@sha1:9b1d7e33aa02" };

const ready = (ok: boolean, message = "") => [
  {
    type: "Ready",
    status: ok ? "True" : "False",
    reason: ok ? "ReconciliationSucceeded" : "BuildFailed",
    message,
    lastTransitionTime: new Date().toISOString(),
  },
];

function flux(context: string): KubeObject[] {
  const meta = (name: string) => ({ name, namespace: "flux-system", uid: `${context}-${name}` });
  const applied = context === "prod-eu-2" ? REV.previous : REV.current;
  const ks = (name: string, extra: { ok?: boolean; message?: string; suspend?: boolean } = {}): KubeObject => ({
    apiVersion: "kustomize.toolkit.fluxcd.io/v1",
    kind: "Kustomization",
    metadata: meta(name),
    spec: { sourceRef: { kind: "GitRepository", name: "flux-system" }, path: `./clusters/${context}/${name}`, suspend: extra.suspend },
    status: { conditions: ready(extra.ok ?? true, extra.message), lastAppliedRevision: applied },
  });
  const objects: KubeObject[] = [
    {
      apiVersion: "source.toolkit.fluxcd.io/v1",
      kind: "GitRepository",
      metadata: meta("flux-system"),
      spec: { url: "ssh://git@git.example.com/platform/fleet-manifests" },
      status: { conditions: ready(true), artifact: { revision: REV.current } },
    },
    ks("flux-system"),
    ks("infrastructure"),
    ks(
      "apps",
      context === "dev-1" ? { ok: false, message: 'kustomize build failed: accumulating resources: "./redis" does not exist' } : {},
    ),
    ...(context === "dev-2" ? [] : [ks("monitoring", { suspend: context === "prod-us-1" })]),
    {
      apiVersion: "helm.toolkit.fluxcd.io/v2",
      kind: "HelmRelease",
      metadata: meta("ingress-nginx"),
      spec: { chart: { spec: { chart: "ingress-nginx", version: "4.x", sourceRef: { kind: "HelmRepository", name: "ingress-nginx" } } } },
      status: { conditions: ready(true), history: [{ chartVersion: context === "prod-us-1" ? "4.10.1" : "4.11.3" }] },
    },
  ];
  return objects;
}

/** The demo cluster, with the Flux objects of each simulated cluster. */
class FleetDemoClient extends DemoClient {
  override async listMany(context: string, kinds: NamedKind[], opts: { namespace?: string } = {}): Promise<ManyResult> {
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 400));
    if (context === "prod-legacy") throw new Error("Unable to connect to the server: dial tcp 10.0.0.12:443: i/o timeout");
    if (opts.namespace === "flux-system")
      return {
        items: Object.fromEntries(
          kinds.map((k) => [
            k.kubectlName,
            ["source-controller:v1.7.2", "kustomize-controller:v1.7.0", "helm-controller:v1.4.1"].map((image) => ({
              metadata: { name: image.split(":")[0], namespace: "flux-system", uid: image },
              spec: { template: { spec: { containers: [{ name: "manager", image: `ghcr.io/fluxcd/${image}` }] } } },
            })),
          ]),
        ),
        missing: [],
      };
    const base = await super.listMany(context, kinds, opts);
    const objects = flux(context);
    for (const k of kinds.filter((k) => k.kubectlName.includes("fluxcd.io"))) {
      base.items[k.kubectlName] = objects.filter((o) => o.kind === k.kindName);
      base.missing = base.missing.filter((m) => m !== k.kubectlName);
    }
    return base;
  }
}

export function startFleetPreview(
  registry: ResourceRegistry,
  appearance: Appearance,
  post: (msg: HostMessage) => void,
  hostLog: (m: string) => void,
) {
  const scanner = new FleetScanner({
    client: new FleetDemoClient(),
    registry,
    members: () => CONTEXTS.map((context) => ({ context, group: groupOf(context, GROUPS) })),
    concurrency: () => 3,
    log: nullLogger,
  });
  return new FleetController({
    scanner,
    host: {
      post,
      openInCluster: (ref) => hostLog(`open ${ref.resource} ${ref.name} in ${ref.context}`),
      fluxAction: (action, row) => hostLog(`native quick pick: ${action} ${row.key} on which clusters?`),
      copyText: (text) => hostLog(`copied ${text.length} characters`),
    },
    groups: () => groupOrder(GROUPS),
    refreshIntervalMs: () => 120_000,
    appearance,
    log: nullLogger,
  });
}
