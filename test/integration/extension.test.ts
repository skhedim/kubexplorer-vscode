// Integration tests in a real VS Code (npm run test:integration), against the local kind cluster.
// VS Code gets a KUBECONFIG holding only the kind context (see .vscode-test.mjs and dev-cluster/setup.sh).

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import type { KubeXplorerApi } from "../../src/extension";
import type { Snapshot } from "../../src/kube/store";
import { buildMatrix } from "../../src/resources/fleet";

const CONTEXT = "kind-kubexplorer";
/** The mini fleet, when dev-cluster/fleet/setup.sh created it. */
const FLEET = (process.env.KUBECONFIG ?? "").includes(".kubeconfig-fleet")
  ? ["kind-fleet-dev-1", "kind-fleet-dev-2", "kind-fleet-prod-1", "kind-fleet-prod-2"]
  : [];
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
    const files = (process.env.KUBECONFIG ?? "").split(":");
    assert.ok(
      files.length && files.every((f) => /test\/\.kubeconfig-(kind|fleet)$/.test(f)),
      "integration tests must run with the dedicated kind kubeconfigs",
    );
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

  it("lists the kind contexts and activates the current one", () => {
    const names = api.state.contexts.map((c) => c.name);
    assert.ok(names.includes(CONTEXT));
    // Next to it, only the clusters of the mini fleet (dev-cluster/fleet/setup.sh), when created.
    assert.deepEqual(
      names.filter((n) => n !== CONTEXT),
      FLEET,
    );
    assert.equal(api.state.active, CONTEXT);
    assert.match(String(api.clustersView.getTreeItem(api.state.contexts.find((c) => c.name === CONTEXT)!).description), /active/);
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
        "Diagnostics",
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

  it("diagnoses the cluster, in its tab and in the Problems view", async () => {
    const problems = () => vscode.languages.getDiagnostics().filter(([uri]) => uri.scheme === "kubexplorer");
    await vscode.commands.executeCommand("kubexplorer.openResource", "overview:diagnostics");
    await waitFor(() => kubexplorerTabs().find((t) => t.startsWith("Diagnostics")), "diagnostics tab");
    // fraud-scorer crashes on the development cluster: its pod and its Deployment are reported.
    const [uri, diagnostics] = await waitFor(
      () => problems().find(([u]) => u.path === "/kind-kubexplorer/deployments/payments/fraud-scorer.yaml"),
      "problems of fraud-scorer",
      30_000,
    );
    assert.ok(
      diagnostics.some((d) => d.severity === vscode.DiagnosticSeverity.Error && d.code === "workload-down"),
      uri.toString(),
    );
    // A problem opens the YAML of its object.
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.match(doc.getText(), /kind: Deployment/);
    await closeAllEditors();
    await waitFor(() => problems().every(([, d]) => d.length === 0), "problems cleared");
  });

  it("follows every list of a page through a single kubectl proxy, and no kubectl process per list", async function () {
    if (process.platform !== "linux") this.skip();
    /** The kubectl processes of this extension host (the tests run in it). */
    const kubectlChildren = () =>
      execFileSync("ps", ["-o", "args=", "--ppid", String(process.pid)])
        .toString()
        .split("\n")
        .filter((l) => l.includes(`--context ${CONTEXT}`));
    await vscode.commands.executeCommand("kubexplorer.openResource", "overview:diagnostics");
    await waitFor(() => kubexplorerTabs().find((t) => t.startsWith("Diagnostics")), "diagnostics tab");
    await waitFor(
      () => vscode.languages.getDiagnostics().some(([uri, d]) => uri.scheme === "kubexplorer" && d.length),
      "the problems of the page, once its lists are loaded",
      30_000,
    );
    assert.deepEqual(api.proxies.running(), [CONTEXT]);
    const processes = kubectlChildren();
    assert.equal(processes.filter((l) => / proxy /.test(l)).length, 1, processes.join("\n"));
    assert.equal(processes.filter((l) => / get .*--watch/.test(l)).length, 0, processes.join("\n"));
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

  it("applies a YAML document with its Apply command (Ctrl+S)", async () => {
    await vscode.workspace.getConfiguration("kubexplorer").update("confirmApply", false, vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand("kubexplorer.resource.edit", {
        context: CONTEXT,
        ref: { resource: "configmaps", namespace: "frontend", name: "web-app-config" },
      });
      const editor = await waitFor(
        () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "kubexplorer"),
        "YAML editor",
      );
      const doc = editor.document;
      const stamp = `apply-${Date.now()}`;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), doc.getText().replace(/APP_ENV: \S+/, `APP_ENV: ${stamp}`));
      await vscode.workspace.applyEdit(edit);
      await vscode.commands.executeCommand("kubexplorer.applyDocument");
      assert.equal(doc.isDirty, false);
      assert.equal(kubectl("-n", "frontend", "get", "configmap", "web-app-config", "-o", "jsonpath={.data.APP_ENV}"), stamp);
    } finally {
      kubectl("-n", "frontend", "patch", "configmap", "web-app-config", "-p", '{"data":{"APP_ENV":"production"}}');
      await vscode.workspace.getConfiguration("kubexplorer").update("confirmApply", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("never applies an auto save to the cluster, only an explicit save", async () => {
    const files = vscode.workspace.getConfiguration("files");
    await files.update("autoSave", "afterDelay", vscode.ConfigurationTarget.Global);
    await files.update("autoSaveDelay", 200, vscode.ConfigurationTarget.Global);
    // Even without the review of the changes, an auto save must not reach the cluster.
    await vscode.workspace.getConfiguration("kubexplorer").update("confirmApply", false, vscode.ConfigurationTarget.Global);
    const appEnv = () => kubectl("-n", "frontend", "get", "configmap", "web-app-config", "-o", "jsonpath={.data.APP_ENV}");
    let doc: vscode.TextDocument | undefined;
    try {
      await vscode.commands.executeCommand("kubexplorer.resource.edit", {
        context: CONTEXT,
        ref: { resource: "configmaps", namespace: "frontend", name: "web-app-config" },
      });
      const editor = await waitFor(
        () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "kubexplorer"),
        "YAML editor",
      );
      doc = editor.document;
      const stamp = `typed-${Date.now()}`;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), doc.getText().replace(/APP_ENV: \S+/, `APP_ENV: ${stamp}`));
      await vscode.workspace.applyEdit(edit);
      // Long enough for several auto saves.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.equal(appEnv(), "production");
      assert.equal(doc.isDirty, true, "the changes stay in the editor, not applied");
      await vscode.commands.executeCommand("kubexplorer.applyDocument");
      assert.equal(appEnv(), stamp);
    } finally {
      if (doc?.isDirty) {
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
      kubectl("-n", "frontend", "patch", "configmap", "web-app-config", "-p", '{"data":{"APP_ENV":"production"}}');
      await files.update("autoSave", undefined, vscode.ConfigurationTarget.Global);
      await files.update("autoSaveDelay", undefined, vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration("kubexplorer").update("confirmApply", undefined, vscode.ConfigurationTarget.Global);
    }
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
    const done = vscode.commands.executeCommand("kubexplorer.resource.logs", {
      context: CONTEXT,
      ref: { resource: "pods", namespace: "frontend", name: pod },
      container: "log-shipper",
    });
    const terminal = await waitFor(async () => {
      // A container that restarted asks first for its current or previous logs.
      await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
      return vscode.window.terminals.find((t) => t.name === `Logs: ${pod} › log-shipper`);
    }, "logs terminal");
    await done;
    terminal.dispose();
  });

  it("filters namespaces and persists the filter", async () => {
    await api.state.setNamespaces(CONTEXT, ["payments", "frontend"]);
    assert.deepEqual(api.state.selectedNamespaces(CONTEXT), ["frontend", "payments"]);
    await api.state.loadNamespaces(CONTEXT, true);
    assert.ok(api.state.filter(CONTEXT).available.includes("monitoring"));
    await api.state.setNamespaces(CONTEXT, []);
  });

  it("follows a list in real time (a watch through the kubectl proxy)", async () => {
    const name = `it-watch-${Date.now()}`;
    let snapshot: Snapshot | undefined;
    const subscription = api.store.watch(
      { context: CONTEXT, kind: api.registry.require("configmaps"), namespaces: ["frontend"] },
      (s) => (snapshot = s),
    );
    try {
      await waitFor(() => snapshot && !snapshot.loading && snapshot.live, "a live list");
      assert.ok(api.proxies.running().includes(CONTEXT));
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
  it("follows the logs of every pod of a workload", async () => {
    await vscode.commands.executeCommand("kubexplorer.resource.logs", {
      context: CONTEXT,
      ref: { resource: "deployments", namespace: "frontend", name: "web-app" },
      container: "log-shipper",
    });
    const terminal = await waitFor(
      () => vscode.window.terminals.find((t) => t.name === "Logs: deployment/web-app › log-shipper"),
      "workload logs terminal",
    );
    terminal.dispose();
    // The stream itself: lines of several pods, prefixed with their name.
    const pods = new Set<string>();
    const stream = api.client.streamLogs(
      CONTEXT,
      {
        namespace: "frontend",
        pod: "deployment/web-app",
        selector: "app.kubernetes.io/name=web-app",
        container: "log-shipper",
        previous: false,
        follow: false,
        tailLines: 5,
      },
      (chunk) => [...chunk.matchAll(/^\[pod\/([^/]+)\//gm)].forEach((m) => pods.add(m[1])),
      () => undefined,
    );
    try {
      await waitFor(() => pods.size >= 2, "log lines of two pods");
    } finally {
      stream.stop();
    }
  });

  it("edits the values of a Secret in clear", async () => {
    const name = `it-decoded-${Date.now()}`;
    kubectl("-n", "payments", "create", "secret", "generic", name, "--from-literal=password=s3cr3t", "--from-literal=user=admin");
    await vscode.workspace.getConfiguration("kubexplorer").update("confirmApply", false, vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand("kubexplorer.resource.editDecoded", {
        context: CONTEXT,
        ref: { resource: "secrets", namespace: "payments", name },
      });
      const editor = await waitFor(
        () => vscode.window.visibleTextEditors.find((e) => e.document.uri.path.endsWith(`${name} (decoded).yaml`)),
        "decoded Secret editor",
      );
      const doc = editor.document;
      assert.match(doc.getText(), /stringData:\n {2}password: "s3cr3t"\n {2}user: "admin"/);
      assert.doesNotMatch(doc.getText(), /czNjcjN0/);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), doc.getText().replace('"s3cr3t"', '"changed: #1"'));
      await vscode.workspace.applyEdit(edit);
      assert.ok(await doc.save(), "the save must succeed");
      const data = JSON.parse(kubectl("-n", "payments", "get", "secret", name, "-o", "jsonpath={.data}"));
      assert.equal(Buffer.from(data.password, "base64").toString(), "changed: #1");
      assert.equal(Buffer.from(data.user, "base64").toString(), "admin");
    } finally {
      kubectl("-n", "payments", "delete", "secret", name, "--wait=false");
      await vscode.workspace.getConfiguration("kubexplorer").update("confirmApply", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("changes one value of a Secret, edited in the drawer", async () => {
    const name = `it-value-${Date.now()}`;
    kubectl("-n", "payments", "create", "secret", "generic", name, "--from-literal=password=old", "--from-literal=user=admin");
    try {
      const saved = await api.actions.updateSecretValue(
        CONTEXT,
        { resource: "secrets", namespace: "payments", name },
        "password",
        "nouvé\nau",
      );
      assert.equal(saved, true);
      const data = JSON.parse(kubectl("-n", "payments", "get", "secret", name, "-o", "jsonpath={.data}"));
      assert.equal(Buffer.from(data.password, "base64").toString(), "nouvé\nau");
      assert.equal(Buffer.from(data.user, "base64").toString(), "admin");
    } finally {
      kubectl("-n", "payments", "delete", "secret", name, "--wait=false");
    }
  });

  it("refuses changes on a read-only context", async () => {
    const settings = vscode.workspace.getConfiguration("kubexplorer");
    await settings.update("protectedContexts", ["kind-*"], vscode.ConfigurationTarget.Global);
    await settings.update("protectedContextsMode", "readOnly", vscode.ConfigurationTarget.Global);
    const restartedAt = () =>
      kubectl("-n", "frontend", "get", "deployment", "web-app", "-o", "jsonpath={.spec.template.metadata.annotations}");
    const before = restartedAt();
    try {
      assert.equal(api.guard.protection(CONTEXT), "readOnly");
      await vscode.commands.executeCommand("kubexplorer.resource.delete", {
        context: CONTEXT,
        ref: { resource: "configmaps", namespace: "frontend", name: "web-app-config" },
      });
      await api.actions.runMany(CONTEXT, "restart", [
        { resource: "deployments", namespace: "frontend", name: "web-app" },
        { resource: "deployments", namespace: "payments", name: "payments-api" },
      ]);
      assert.equal(kubectl("-n", "frontend", "get", "configmap", "web-app-config", "-o", "name").trim(), "configmap/web-app-config");
      assert.equal(restartedAt(), before);
      // YAML documents open read-only.
      await vscode.commands.executeCommand("kubexplorer.resource.edit", {
        context: CONTEXT,
        ref: { resource: "configmaps", namespace: "frontend", name: "web-app-config" },
      });
      const editor = await waitFor(
        () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "kubexplorer"),
        "YAML editor",
      );
      assert.equal((await vscode.workspace.fs.stat(editor.document.uri)).permissions, vscode.FilePermission.Readonly);
    } finally {
      await settings.update("protectedContexts", undefined, vscode.ConfigurationTarget.Global);
      await settings.update("protectedContextsMode", undefined, vscode.ConfigurationTarget.Global);
    }
    assert.equal(api.guard.protection(CONTEXT), "none");
  });

  it("asks Flux to reconcile several objects at once", async function () {
    if (!kubectl("get", "crds", "-o", "name").includes("kustomizations.kustomize.toolkit.fluxcd.io")) this.skip();
    const before = Date.now();
    const names = ["podinfo", "broken-path"];
    await api.actions.runMany(
      CONTEXT,
      "reconcile",
      names.map((name) => ({ resource: "flux:kustomizations", namespace: "flux-system", name })),
    );
    for (const name of names) {
      const requestedAt = kubectl(
        "-n",
        "flux-system",
        "get",
        "kustomizations.kustomize.toolkit.fluxcd.io",
        name,
        "-o",
        "jsonpath={.metadata.annotations.reconcile\\.fluxcd\\.io/requestedAt}",
      );
      assert.ok(Date.parse(requestedAt) >= before - 1000, `${name}: ${requestedAt}`);
    }
  });
  describe("the fleet (dev-cluster/fleet/setup.sh)", function () {
    before(function () {
      if (!FLEET.length) this.skip();
    });

    it("groups the clusters by prod and dev in the Clusters view", async () => {
      const roots = api.clustersView.getChildren();
      assert.deepEqual(
        roots.map((r) => ("group" in r ? r.group : r.name)),
        ["prod", "dev", "other"],
      );
      assert.deepEqual(
        api.clustersView.getChildren(roots[0]).map((c) => ("name" in c ? c.name : "")),
        ["kind-fleet-prod-1", "kind-fleet-prod-2"],
      );
    });

    it("scans the fleet and finds its drifts", async function () {
      this.timeout(120_000);
      await api.scanner.scan();
      const scans = api.scanner.list();
      for (const context of FLEET) assert.equal(api.scanner.get(context)?.status, "ok", `${context}: ${api.scanner.get(context)?.error}`);
      assert.deepEqual(
        FLEET.map((c) => api.scanner.get(c)?.flux?.components?.["kustomize-controller"]?.startsWith("v")),
        FLEET.map(() => true),
      );
      const rows = buildMatrix(scans);
      const row = (resource: string, name: string) => rows.find((r) => r.resource === resource && r.name === name)!;
      // fleet-dev-1 runs older versions than fleet-dev-2; prod runs the same everywhere.
      await waitFor(
        async () => {
          await api.scanner.scan(FLEET);
          return buildMatrix(api.scanner.list())
            .find((r) => r.resource === "flux:gitrepositories" && r.name === "podinfo")
            ?.drift.includes("2 revisions in dev");
        },
        "the revision drift of podinfo in dev",
        90_000,
      );
      assert.ok(row("flux:kustomizations", "podinfo").drift.includes("1 suspended"));
      assert.deepEqual(row("flux:kustomizations", "redis").missing, ["kind-fleet-dev-1"]);
      // The other group is not compared with the fleet: kind-kubexplorer has its own objects.
      assert.ok(!row("flux:kustomizations", "podinfo").missing.includes(CONTEXT));
    });

    it("reconciles a Flux object on several clusters", async () => {
      const podinfo = buildMatrix(api.scanner.list()).find((r) => r.resource === "flux:helmreleases" && r.name === "podinfo-helm")!;
      const before = Date.now();
      const targets = ["kind-fleet-dev-1", "kind-fleet-dev-2"];
      const result = await api.fleetActions.run("reconcile", podinfo, targets);
      assert.deepEqual(result, { ok: 2, failures: [] });
      for (const context of targets) {
        const requestedAt = execFileSync(
          "kubectl",
          [
            "--context",
            context,
            "-n",
            "flux-system",
            "get",
            "helmreleases.helm.toolkit.fluxcd.io",
            "podinfo-helm",
            "-o",
            "jsonpath={.metadata.annotations.reconcile\\.fluxcd\\.io/requestedAt}",
          ],
          { env: process.env },
        ).toString();
        assert.ok(Date.parse(requestedAt) >= before - 1000, `${context}: ${requestedAt}`);
      }
    });

    it("opens the Fleet tab, and an object of a cluster in that cluster", async () => {
      await vscode.commands.executeCommand("kubexplorer.openFleet", { group: "dev" });
      await waitFor(() => kubexplorerTabs().find((t) => t === "Fleet: dev"), "Fleet tab");
      api.panels.openInCluster({
        context: "kind-fleet-prod-1",
        resource: "flux:kustomizations",
        namespace: "flux-system",
        name: "podinfo",
      });
      await waitFor(() => api.state.active === "kind-fleet-prod-1", "active cluster");
      await waitFor(() => kubexplorerTabs().find((t) => t.startsWith("Kustomizations")), "Kustomizations tab");
      await api.state.setActive(CONTEXT);
    });
  });
});
