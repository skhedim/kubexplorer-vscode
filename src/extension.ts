// Entry point: wires the layers (kube → resources → panel → vscode) and registers the commands.

import * as vscode from "vscode";
import { CrdCatalog } from "./kube/crds";
import { DEMO_CONTEXT } from "./kube/demo";
import { HelmCli, HelmRouter, helmSources } from "./kube/helm";
import { KubectlClient } from "./kube/kubectl";
import { PortForwardManager } from "./kube/portForward";
import { MetricsRouter, PrometheusClient } from "./kube/prometheus";
import { RoutingClient } from "./kube/routing";
import { ResourceStore } from "./kube/store";
import { errorMessage } from "./kube/types";
import { PORT_FORWARDS } from "./kube/virtualKinds";
import { FleetScanner } from "./panel/fleetScanner";
import { MetricsHistory, MetricsService } from "./panel/metrics";
import { groupOf, groupOrder } from "./resources/fleet";
import { menuOpen, menuTarget } from "./resources/menu";
import { ResourceRegistry } from "./resources/registry";
import type { PanelTarget } from "./shared/protocol";
import { ALL_ACTIONS, type ActionId } from "./shared/view";
import { ResourceActions, toTarget } from "./vscode/actions";
import { FleetActions } from "./vscode/fleetActions";
import { ClustersView } from "./vscode/clustersView";
import { ClusterState } from "./vscode/clusterState";
import { config } from "./vscode/config";
import { DESCRIBE_SCHEME, DescribeProvider, ReadonlyDocuments, ResourceFileSystem, VIEW_SCHEME, YAML_SCHEME } from "./vscode/documents";
import { createLogger } from "./vscode/logger";
import { ResourcePanels, VIEW_TYPE } from "./vscode/panels";
import { ProblemsView } from "./vscode/problems";
import { globMatch } from "./shared/protection";
import { ContextGuard } from "./vscode/protection";
import { type ResourceNode, ResourcesView } from "./vscode/resourcesView";
import { KubeStatusBar } from "./vscode/statusBar";
import { Terminals } from "./vscode/terminals";

export async function activate(context: vscode.ExtensionContext) {
  const { logger: log, channel } = createLogger();
  const helm = new HelmRouter(new HelmCli(config.helmPath, log));
  // A port forward that starts, stops or fails refreshes the Port Forwarding list right away.
  const portForwards = new PortForwardManager(config.kubectlPath, log, () => store.refresh());
  const client = new RoutingClient(
    new KubectlClient(config.kubectlPath, log),
    {
      demoEnabled: config.demoCluster,
      watchEnabled: config.watch,
      virtualSources: { ...helmSources(helm), [PORT_FORWARDS]: portForwards },
    },
    log,
  );
  const registry = new ResourceRegistry();
  const crds = new CrdCatalog(client);
  const prometheus = new MetricsRouter(new PrometheusClient(client, config.prometheus, log));
  const metrics = new MetricsService({ backend: prometheus, client, registry, history: new MetricsHistory(), log });
  const store = new ResourceStore(client, { pollIntervalMs: config.pollIntervalMs }, log);
  const state = new ClusterState(context.globalState, client, log);
  const terminals = new Terminals(client);
  const documents = new ReadonlyDocuments();
  const guard = new ContextGuard();
  const problems = new ProblemsView();
  const files = new ResourceFileSystem(client, registry, store, documents, guard, log);
  // The fleet: the contexts matching kubexplorer.fleet.contexts, in groups (kubexplorer.fleet.groups).
  const scanner = new FleetScanner({
    client,
    registry,
    members: () => {
      const patterns = config.fleetContexts();
      const groups = config.fleetGroups();
      const order = groupOrder(groups);
      return state.contexts
        .filter((c) => patterns.some((p) => globMatch(p, c.name)))
        .map((c) => ({ context: c.name, group: groupOf(c.name, groups) }))
        .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.context.localeCompare(b.context));
    },
    concurrency: config.fleetConcurrency,
    log,
  });
  const fleetActions = new FleetActions({ client, registry, scanner, guard, log });
  const actions = new ResourceActions({ client, helm, portForwards, registry, store, terminals, documents, files, guard, log });
  const panels = new ResourcePanels(context.extensionUri, {
    registry,
    store,
    client,
    helm,
    state,
    actions,
    metrics,
    crds,
    guard,
    problems,
    scanner,
    fleetActions,
    fleetGroups: () => groupOrder(config.fleetGroups()),
    log,
  });

  const clustersView = new ClustersView(state, guard, scanner);
  const resourcesView = new ResourcesView(state, crds, registry, log);
  const clustersTree = vscode.window.createTreeView("kubexplorer.clusters", { treeDataProvider: clustersView });
  const resourcesTree = vscode.window.createTreeView<ResourceNode>("kubexplorer.resources", { treeDataProvider: resourcesView });

  const updateResourcesDescription = () => (resourcesTree.description = state.active ?? "");
  /** The active context, or a prompt to pick one. */
  const activeContext = (): string | undefined => {
    if (!state.active) {
      const select = vscode.l10n.t("Select Cluster");
      void vscode.window.showWarningMessage(vscode.l10n.t("No active cluster."), select).then((choice) => {
        if (choice === select) void vscode.commands.executeCommand("kubexplorer.selectContext");
      });
    }
    return state.active;
  };
  const openTarget = (target: PanelTarget, newTab = false) => {
    const ctx = activeContext();
    if (ctx) panels.open(ctx, target, { newTab });
  };
  const resourceCommand = (action: ActionId) =>
    vscode.commands.registerCommand(`kubexplorer.resource.${action}`, (arg: unknown) => {
      const target = toTarget(arg);
      return target && actions.run(action, target);
    });

  context.subscriptions.push(
    channel,
    store,
    portForwards,
    state,
    terminals,
    documents,
    guard,
    problems,
    panels,
    clustersView,
    resourcesView,
    clustersTree,
    resourcesTree,
    new KubeStatusBar(state, guard),
    files,
    vscode.workspace.registerFileSystemProvider(YAML_SCHEME, files, {
      isCaseSensitive: true,
    }),
    vscode.workspace.registerTextDocumentContentProvider(DESCRIBE_SCHEME, new DescribeProvider(client, registry)),
    vscode.workspace.registerTextDocumentContentProvider(VIEW_SCHEME, documents),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, panels),
    state.onDidChangeActive(updateResourcesDescription),
    // The active tab selects the matching entry of the Resources view, like the Freelens side menu.
    panels.onDidChangeActiveTab(async ({ context: ctx, target }) => {
      if (ctx !== state.active || !resourcesTree.visible) return;
      const node = await resourcesView.findNode(menuOpen(target));
      if (node) void resourcesTree.reveal(node, { select: true, focus: false });
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kubexplorer.demoCluster") || e.affectsConfiguration("kubexplorer.kubectlPath"))
        void state.reloadContexts();
      if (e.affectsConfiguration("kubexplorer.prometheus")) prometheus.invalidate();
    }),

    vscode.commands.registerCommand("kubexplorer.refresh", async () => {
      await state.reloadContexts();
      crds.invalidate();
      prometheus.invalidate();
      resourcesView.reset();
      store.refresh();
      if (state.active) void state.loadNamespaces(state.active, true);
    }),
    vscode.commands.registerCommand("kubexplorer.activateContext", (arg: string | { name: string }) =>
      state.setActive(typeof arg === "string" ? arg : arg.name),
    ),
    vscode.commands.registerCommand("kubexplorer.copyContextName", (arg: { name: string }) => actions.copyText(arg.name)),
    vscode.commands.registerCommand("kubexplorer.selectContext", async () => {
      if (!state.contexts.length) await state.reloadContexts();
      const items = state.contexts.map((c) => ({
        label: c.name,
        description: [c.name === state.active ? vscode.l10n.t("active") : "", c.current ? "kubeconfig" : ""].filter(Boolean).join(" · "),
        detail: c.cluster,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("KubeXplorer: Active Cluster"),
        placeHolder: state.contextsError ?? vscode.l10n.t("Pick a kubeconfig context"),
      });
      if (pick) await state.setActive(pick.label);
    }),
    vscode.commands.registerCommand("kubexplorer.selectNamespaces", async () => {
      const ctx = activeContext();
      if (!ctx) return;
      await state.loadNamespaces(ctx);
      const selected = new Set(state.selectedNamespaces(ctx));
      const picks = await vscode.window.showQuickPick(
        state.filter(ctx).available.map((n) => ({ label: n, picked: selected.has(n) })),
        {
          title: vscode.l10n.t("Displayed Namespaces: {0}", ctx),
          placeHolder: vscode.l10n.t("No selection means every namespace"),
          canPickMany: true,
        },
      );
      if (picks)
        await state.setNamespaces(
          ctx,
          picks.map((p) => p.label),
        );
    }),
    vscode.commands.registerCommand("kubexplorer.openResource", (open: string) => openTarget(menuTarget(open))),
    vscode.commands.registerCommand("kubexplorer.openResourceInNewTab", (node: ResourceNode | string) => {
      const open = typeof node === "string" ? node : node.open;
      if (open) openTarget(menuTarget(open), true);
    }),
    vscode.commands.registerCommand("kubexplorer.openOverview", async (cluster?: { name: string }) => {
      if (cluster?.name) await state.setActive(cluster.name);
      openTarget({ kind: "overview" });
    }),
    vscode.commands.registerCommand("kubexplorer.openResourcePicker", async () => {
      const ctx = activeContext();
      if (!ctx) return;
      const pick = await vscode.window.showQuickPick(resourcesView.openableEntries(ctx), {
        title: vscode.l10n.t("Open Resource: {0}", ctx),
        matchOnDetail: true,
      });
      if (pick) panels.open(ctx, menuTarget(pick.open));
    }),
    vscode.commands.registerCommand("kubexplorer.toggleDemoCluster", async () => {
      const enabled = !config.demoCluster();
      await config.setDemoCluster(enabled);
      if (enabled) await state.setActive(DEMO_CONTEXT);
    }),
    vscode.commands.registerCommand("kubexplorer.showLog", () => channel.show()),
    // From the title of the Clusters view (every cluster), or from a group.
    vscode.commands.registerCommand("kubexplorer.openFleet", (arg?: string | { group: string }) =>
      panels.openFleet(typeof arg === "string" ? arg : (arg?.group ?? null)),
    ),
    // Ctrl+S in the YAML of an object: review the diff, then apply or cancel.
    vscode.commands.registerCommand("kubexplorer.applyDocument", async (uri?: vscode.Uri) => {
      const document = uri
        ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
        : vscode.window.activeTextEditor?.document;
      if (document?.uri.scheme !== YAML_SCHEME) return vscode.commands.executeCommand("workbench.action.files.save");
      try {
        await files.apply(document);
      } catch (err) {
        void vscode.window.showErrorMessage(vscode.l10n.t("KubeXplorer: {0}", errorMessage(err)));
      }
    }),
    ...ALL_ACTIONS.map(resourceCommand),
  );

  log.info(`KubeXplorer ${context.extension.packageJSON.version} activated (kubectl: ${config.kubectlPath()})`);
  await state.reloadContexts();
  updateResourcesDescription();
  // Exposed for the integration tests (vscode.extensions.getExtension(...).exports).
  return {
    state,
    registry,
    store,
    client,
    helm,
    portForwards,
    panels,
    clustersView,
    resourcesView,
    metrics,
    actions,
    guard,
    scanner,
    fleetActions,
  };
}

export type KubeXplorerApi = Awaited<ReturnType<typeof activate>>;

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
