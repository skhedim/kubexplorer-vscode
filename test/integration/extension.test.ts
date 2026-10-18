// Integration tests in a real VS Code (npm run test:integration), against the local kind cluster.
// VS Code gets a KUBECONFIG holding only the kind context (see .vscode-test.mjs and dev-cluster/setup.sh).

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import type { KubeXplorerApi } from "../../src/extension";
import type { Snapshot } from "../../src/kube/store";

const CONTEXT = "kind-kubexplorer";
const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { env: process.env }).toString();

async function waitFor<T>(probe: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function kubexplorerTabs(): string[] {
  return vscode.window.tabGroups.all.flatMap((g) =>
    g.tabs
      .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("kubexplorer.resource"))
      .map((t) => t.label),
  );
}

async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

describe("KubeXplorer in VS Code", function () {
  this.timeout(60_000);
  let api: KubeXplorerApi;

  before(async () => {
    assert.ok(process.env.KUBECONFIG?.endsWith(".kubeconfig-kind"), "integration tests must run with the dedicated kind kubeconfig");
    const extension = vscode.extensions.getExtension<KubeXplorerApi>("skhedim.kubexplorer");
    assert.ok(extension, "extension not found");
    api = await extension.activate();
  });

  afterEach(closeAllEditors);

  it("registers its commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "kubexplorer.openResource",
      "kubexplorer.openResourceInNewTab",
      "kubexplorer.resource.logs",
      "kubexplorer.selectNamespaces",
    ]) {
      assert.ok(commands.includes(command), command);
    }
  });

  it("lists the kind context and activates it", () => {
    assert.deepEqual(
      api.state.contexts.map((c) => c.name),
      [CONTEXT],
    );
    assert.equal(api.state.active, CONTEXT);
    assert.match(String(api.clustersView.getTreeItem(api.state.contexts[0]).description), /active/);
  });

  it("mirrors the Freelens menu in the Resources view, with Flux and Karpenter when installed", async () => {
    const crds = kubectl("get", "crds", "-o", "name");
    const flux = crds.includes("kustomizations.kustomize.toolkit.fluxcd.io");
    const karpenter = crds.includes("nodepools.karpenter.sh");
    const roots = await api.resourcesView.getChildren();
    assert.deepEqual(
      roots.map((r) => r.label),
      [
        "Cluster",
        "Nodes",
        "Workloads",
        "Config",
        "Network",
        "Storage",
        "Namespaces",
        "Events",
        "Helm",
        ...(flux ? ["Flux"] : []),
        ...(karpenter ? ["Karpenter"] : []),
        "Access Control",
        "Custom Resources",
      ],
    );
    if (karpenter) {
      const entries = await api.resourcesView.getChildren(roots.find((r) => r.id === "karpenter"));
      // AKS and KWOK node classes are not installed on the development cluster.
      assert.deepEqual(
        entries.map((e) => e.label),
        ["Overview", "Node Pools", "Node Claims", "EC2 Node Classes"],
      );
    }
    const workloads = await api.resourcesView.getChildren(roots.find((r) => r.id === "workloads"));
    assert.ok(workloads.some((w) => w.open === "pods"));
    const network = await api.resourcesView.getChildren(roots.find((r) => r.id === "network"));
    assert.ok(network.some((n) => n.open === "portforwards"));
    // "Definitions", then a group per API group of the CRDs, and no error.
    const custom = await api.resourcesView.getChildren(roots.find((r) => r.id === "crds"));
    assert.equal(custom[0].label, "Definitions");
    assert.ok(!custom.some((c) => c.error), custom.map((c) => c.error).join());
    if (flux) {
      // The CRDs with a dedicated view open it.
      const group = await api.resourcesView.getChildren(custom.find((c) => c.label === "kustomize.toolkit.fluxcd.io"));
      assert.equal(group[0].open, "flux:kustomizations");
    }
  });

  it("reuses the current tab when opening another resource type", async () => {
    await vscode.commands.executeCommand("kubexplorer.openResource", "daemonsets");
    await waitFor(() => kubexplorerTabs().includes(`Daemon Sets · ${CONTEXT}`), "Daemon Sets tab");
    await vscode.commands.executeCommand("kubexplorer.openResource", "deployments");
    await waitFor(() => kubexplorerTabs().includes(`Deployments · ${CONTEXT}`), "Deployments tab");
    assert.deepEqual(kubexplorerTabs(), [`Deployments · ${CONTEXT}`]);
  });

  it("keeps tabs opened with Open in New Tab", async () => {
    await vscode.commands.executeCommand("kubexplorer.openResource", "pods");
    await vscode.commands.executeCommand("kubexplorer.openResourceInNewTab", "services");
    await vscode.commands.executeCommand("kubexplorer.openResource", "configmaps");
    await waitFor(() => kubexplorerTabs().length === 2 && kubexplorerTabs().includes(`Config Maps · ${CONTEXT}`), "two tabs");
    assert.deepEqual(kubexplorerTabs().sort(), [`Config Maps · ${CONTEXT}`, `Services · ${CONTEXT}`]);
  });

  it("opens the YAML of an object and applies changes on save", async () => {
    await vscode.workspace.getConfiguration("kubexplorer").update("confirmApply", false, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("kubexplorer.resource.edit", {
      context: CONTEXT,
      ref: { resource: "configmaps", namespace: "frontend", name: "web-app-config" },
    });
    const editor = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "kubexplorer"),
      "YAML editor",
    );
    const doc = editor.document;
    assert.equal(doc.languageId, "yaml");
    assert.match(doc.getText(), /kind: ConfigMap/);
    assert.doesNotMatch(doc.getText(), /managedFields/);

    const stamp = `it-${Date.now()}`;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), doc.getText().replace(/APP_ENV: \S+/, `APP_ENV: ${stamp}`));
    await vscode.workspace.applyEdit(edit);
    assert.ok(await doc.save(), "the save must succeed");
    assert.equal(kubectl("-n", "frontend", "get", "configmap", "web-app-config", "-o", "jsonpath={.data.APP_ENV}"), stamp);
    kubectl("-n", "frontend", "patch", "configmap", "web-app-config", "-p", '{"data":{"APP_ENV":"production"}}');
    await vscode.workspace.getConfiguration("kubexplorer").update("confirmApply", undefined, vscode.ConfigurationTarget.Global);
  });

  it("opens kubectl describe as a read-only document", async () => {
    await vscode.commands.executeCommand("kubexplorer.resource.describe", {
      context: CONTEXT,
      ref: { resource: "deployments", namespace: "frontend", name: "web-app" },
    });
    const editor = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "kubexplorer-describe"),
      "describe document",
    );
    assert.match(editor.document.getText(), /Replicas:\s+3 desired/);
  });

  it("opens the logs of a container in a terminal", async () => {
    const pod = kubectl(
      "-n",
      "frontend",
      "get",
      "pods",
      "-l",
      "app.kubernetes.io/name=web-app",
      "-o",
      "jsonpath={.items[0].metadata.name}",
    );
    await vscode.commands.executeCommand("kubexplorer.resource.logs", {
      context: CONTEXT,
      ref: { resource: "pods", namespace: "frontend", name: pod },
      container: "log-shipper",
    });
    const terminal = await waitFor(() => vscode.window.terminals.find((t) => t.name === `Logs: ${pod} › log-shipper`), "logs terminal");
    terminal.dispose();
  });

  it("filters namespaces and persists the filter", async () => {
    await api.state.setNamespaces(CONTEXT, ["payments", "frontend"]);
    assert.deepEqual(api.state.selectedNamespaces(CONTEXT), ["frontend", "payments"]);
    await api.state.loadNamespaces(CONTEXT, true);
    assert.ok(api.state.filter(CONTEXT).available.includes("monitoring"));
    await api.state.setNamespaces(CONTEXT, []);
  });

  it("follows a list in real time (kubectl watch)", async () => {
    const name = `it-watch-${Date.now()}`;
    let snapshot: Snapshot | undefined;
    const subscription = api.store.watch(
      { context: CONTEXT, kind: api.registry.require("configmaps"), namespaces: ["frontend"] },
      (s) => (snapshot = s),
    );
    try {
      await waitFor(() => snapshot && !snapshot.loading && snapshot.live, "a live list");
      kubectl("-n", "frontend", "create", "configmap", name, "--from-literal=k=v");
      // Within the 5 s polling interval: only the watch can explain it.
      await waitFor(() => snapshot!.items.some((o) => o.metadata.name === name), "creation seen by the watch", 4_000);
      kubectl("-n", "frontend", "delete", "configmap", name);
      await waitFor(() => !snapshot!.items.some((o) => o.metadata.name === name), "deletion seen by the watch", 4_000);
    } finally {
      subscription.dispose();
    }
  });

  it("reads metrics-server metrics of pods and nodes", async () => {
    const podMetrics = await waitFor(
      async () => {
        const items = await api.client.list(CONTEXT, api.registry.require("podmetrics"), { namespaces: ["frontend"] });
        return items.length ? items : undefined;
      },
      "pod metrics",
      90_000,
    );
    assert.ok(podMetrics[0].containers?.[0]?.usage?.memory);
    const nodeMetrics = await api.client.list(CONTEXT, api.registry.require("nodemetrics"), { namespaces: [] });
    assert.equal(nodeMetrics.length, 3);
  });

  it("draws the usage charts of the pods of a workload", async () => {
    const pods = await api.client.list(CONTEXT, api.registry.require("pods"), {
      namespaces: ["frontend"],
      labelSelector: "app.kubernetes.io/name=web-app",
    });
    assert.ok(pods.length > 0);
    const data = await api.metrics.load(CONTEXT, { kind: "pods", namespace: "frontend", pods });
    assert.deepEqual(
      data.charts.slice(0, 2).map((c) => c.id),
      ["cpu", "memory"],
    );
    // Prometheus when dev-cluster/setup.sh --addons installed it, metrics-server samples otherwise.
    assert.match(data.source, /^(Prometheus monitoring\/prometheus-server|metrics-server)$/);
    assert.ok(data.charts[0].series.some((s) => s.role === "requests"));
  });

  it("asks Flux to reconcile an object", async function () {
    if (!kubectl("get", "crds", "-o", "name").includes("kustomizations.kustomize.toolkit.fluxcd.io")) this.skip();
    const before = Date.now();
    await vscode.commands.executeCommand("kubexplorer.resource.reconcile", {
      context: CONTEXT,
      ref: { resource: "flux:kustomizations", namespace: "flux-system", name: "podinfo" },
    });
    const requestedAt = kubectl(
      "-n",
      "flux-system",
      "get",
      "kustomizations.kustomize.toolkit.fluxcd.io",
      "podinfo",
      "-o",
      "jsonpath={.metadata.annotations.reconcile\\.fluxcd\\.io/requestedAt}",
    );
    assert.ok(Date.parse(requestedAt) >= before - 1000, requestedAt);
  });

  it("lists Helm releases, opens a manifest and rolls back", async () => {
    const releases = await api.client.list(CONTEXT, api.registry.require("helmreleases"), { namespaces: [] });
    assert.ok(releases.some((r) => r.metadata.name === "shop-landing"));
    await vscode.commands.executeCommand("kubexplorer.resource.manifest", {
      context: CONTEXT,
      ref: { resource: "helmreleases", namespace: "frontend", name: "shop-landing" },
    });
    const editor = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "kubexplorer-view"),
      "manifest",
    );
    assert.match(editor.document.getText(), /kind: Deployment/);
    assert.equal(editor.document.languageId, "yaml");

    const before = await api.helm.history(CONTEXT, "frontend", "shop-landing");
    await api.helm.rollback(CONTEXT, "frontend", "shop-landing", before[0].revision);
    const after = await api.helm.history(CONTEXT, "frontend", "shop-landing");
    assert.equal(after.at(-1)!.revision, before.at(-1)!.revision + 1);
    assert.match(after.at(-1)!.description, /Rollback to/);
  });

  it("forwards a service port and lists it in Port Forwarding", async () => {
    const pf = await api.portForwards.start(CONTEXT, "frontend", "services", "web-app", 80, 0);
    try {
      assert.ok(pf.localPort && pf.localPort > 0);
      assert.equal((await fetch(`http://127.0.0.1:${pf.localPort}/`)).status, 200);
      const listed = await api.client.list(CONTEXT, api.registry.require("portforwards"), { namespaces: [] });
      assert.equal(listed[0].portForward.status, "active");
    } finally {
      await vscode.commands.executeCommand("kubexplorer.resource.stop", {
        context: CONTEXT,
        ref: { resource: "portforwards", namespace: "frontend", name: pf.id },
      });
    }
    assert.equal((await api.client.list(CONTEXT, api.registry.require("portforwards"), { namespaces: [] })).length, 0);
  });
});
