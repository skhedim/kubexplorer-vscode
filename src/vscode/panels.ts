// Resource tabs in the editor area. VS Code adapter around PanelController (which is VS Code-agnostic).
//
// Tab reuse: opening a resource type from the Resources view replaces the content of the "reusable" tab
// (like VS Code preview editors) instead of piling up tabs. Tabs opened with "Open in New Tab" are kept.

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import type { CrdCatalog } from "../kube/crds";
import type { HelmClient } from "../kube/helm";
import type { ResourceStore } from "../kube/store";
import type { Logger } from "../kube/types";
import { PanelController, type PanelHost } from "../panel/controller";
import { FleetController } from "../panel/fleetController";
import type { FleetScanner } from "../panel/fleetScanner";
import type { MetricsService } from "../panel/metrics";
import type { ResourceRegistry } from "../resources/registry";
import { shortContextName } from "../shared/clusterNames";
import { menuTarget } from "../resources/menu";
import type { Protection } from "../shared/protection";
import type { Appearance, HostMessage, NamespaceFilter, PanelTarget, PersistedState, WebviewMessage } from "../shared/protocol";
import type { ResourceRef } from "../shared/view";
import type { ResourceActions } from "./actions";
import type { ClusterState } from "./clusterState";
import { config } from "./config";
import type { FleetActions } from "./fleetActions";
import type { ProblemsView } from "./problems";
import type { ContextGuard } from "./protection";

export const VIEW_TYPE = "kubexplorer.resource";

export interface PanelsDeps {
  registry: ResourceRegistry;
  store: ResourceStore;
  client: KubeClient;
  helm: HelmClient;
  state: ClusterState;
  actions: ResourceActions;
  metrics: MetricsService;
  crds: CrdCatalog;
  guard: ContextGuard;
  problems: ProblemsView;
  scanner: FleetScanner;
  fleetActions: FleetActions;
  /** Fleet groups, in display order. */
  fleetGroups(): string[];
  log: Logger;
}

/** What a tab runs: the controller of a cluster tab, or of the Fleet tab. */
interface TabController {
  title(): string;
  onMessage(msg: WebviewMessage): void;
  setVisible(visible: boolean): void;
  setAppearance(appearance: Appearance): void;
  setProtection(protection: Protection): void;
  setNamespaceFilter(filter: NamespaceFilter): void;
  reveal(ref: ResourceRef): void;
  dispose(): void;
}

export interface ActiveTab {
  context: string;
  target: PanelTarget;
}

interface Tab {
  panel: vscode.WebviewPanel;
  controller: TabController;
  context: string;
  target: PanelTarget;
  /** Replaced by the next resource opened from the Resources view. */
  reusable: boolean;
}

function sameTarget(a: PanelTarget, b: PanelTarget): boolean {
  if (a.kind === "overview") return b.kind === "overview" && a.page === b.page;
  if (a.kind === "fleet") return b.kind === "fleet";
  return b.kind === "list" && a.resource === b.resource;
}

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class ResourcePanels implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private readonly tabs = new Set<Tab>();
  private readonly activeEmitter = new vscode.EventEmitter<ActiveTab>();
  /** The active KubeXplorer tab changed (used to select the matching entry of the Resources view). */
  readonly onDidChangeActiveTab = this.activeEmitter.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly d: PanelsDeps,
  ) {
    this.subscriptions = [
      d.state.onDidChangeNamespaces((context) => {
        for (const tab of this.tabs) if (tab.context === context) tab.controller.setNamespaceFilter(d.state.filter(context));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("kubexplorer.appearance"))
          for (const tab of this.tabs) tab.controller.setAppearance(config.appearance());
      }),
      d.guard.onDidChange(() => {
        for (const tab of this.tabs) tab.controller.setProtection(d.guard.protection(tab.context));
      }),
    ];
  }

  /**
   * Opens (or reveals) a tab. newTab: keep the current tabs and open a dedicated one. reveal: an object to show in
   * its drawer.
   */
  open(context: string, target: PanelTarget, opts: { newTab?: boolean; reveal?: ResourceRef } = {}): void {
    if (target.kind === "list" && !this.d.registry.get(target.resource)) {
      void vscode.window.showWarningMessage(vscode.l10n.t("Unknown resource type: {0}", target.resource));
      return;
    }
    const existing = [...this.tabs].find((t) => t.context === context && sameTarget(t.target, target));
    if (existing) {
      if (opts.newTab) existing.reusable = false;
      existing.panel.reveal();
      if (opts.reveal) existing.controller.reveal(opts.reveal);
      return;
    }
    const reuse = !opts.newTab && config.reuseTab();
    const reusable = reuse ? [...this.tabs].find((t) => t.reusable) : undefined;
    if (reusable) {
      this.retarget(reusable, context, target);
      reusable.panel.reveal();
      if (opts.reveal) reusable.controller.reveal(opts.reveal);
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "KubeXplorer", vscode.ViewColumn.Active, this.webviewOptions());
    const tab = this.attach(panel, context, target, reuse);
    if (opts.reveal) tab.controller.reveal(opts.reveal);
  }

  /** Opens the Fleet tab (a single one), showing a group or every cluster. */
  openFleet(group: string | null = null): void {
    const existing = [...this.tabs].find((t) => t.target.kind === "fleet");
    if (existing) {
      (existing.controller as FleetController).showGroup(group);
      existing.panel.title = existing.controller.title();
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "KubeXplorer", vscode.ViewColumn.Active, this.webviewOptions());
    this.attach(panel, "", { kind: "fleet" }, false, group);
  }

  /** Opens an object of another cluster (or one of its overview pages), making that cluster the active one. */
  openInCluster(ref: ResourceRef): void {
    const context = ref.context;
    if (!context) return;
    void this.d.state.setActive(context);
    if (ref.resource.startsWith("overview")) this.open(context, menuTarget(ref.resource));
    else if (this.d.registry.get(ref.resource))
      this.open(
        context,
        { kind: "list", resource: ref.resource },
        { reveal: { resource: ref.resource, namespace: ref.namespace, name: ref.name } },
      );
  }

  /** Restores the tabs that were open when VS Code was closed. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const saved = (state as Partial<PersistedState> | undefined)?.panel;
    if (!saved || (saved.target.kind === "list" && !this.d.registry.get(saved.target.resource))) {
      // Unknown type (e.g. a CRD not discovered yet): closing beats showing a broken tab.
      panel.dispose();
      return;
    }
    panel.webview.options = this.webviewOptions();
    const fleet = saved.target.kind === "fleet";
    this.attach(panel, saved.context, saved.target, !fleet && config.reuseTab() && ![...this.tabs].some((t) => t.reusable));
  }

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    // No retainContextWhenHidden: a hidden webview is rebuilt from its persisted state when shown again.
    return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
  }

  private attach(panel: vscode.WebviewPanel, context: string, target: PanelTarget, reusable: boolean, group: string | null = null): Tab {
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "tab-icon.svg");
    const tab: Tab = { panel, context, target, reusable, controller: this.createController(panel, context, target, group) };
    this.tabs.add(tab);
    this.load(tab);

    const subscriptions = [
      // tab.controller changes when the tab is reused: always dispatch to the current one.
      panel.webview.onDidReceiveMessage((msg: WebviewMessage) => tab.controller.onMessage(msg)),
      panel.onDidChangeViewState(() => {
        tab.controller.setVisible(panel.visible);
        if (panel.active) this.activeEmitter.fire({ context: tab.context, target: tab.target });
      }),
    ];
    panel.onDidDispose(() => {
      tab.controller.dispose();
      subscriptions.forEach((s) => s.dispose());
      this.tabs.delete(tab);
    });
    return tab;
  }

  /** Shows another resource type in an existing tab. */
  private retarget(tab: Tab, context: string, target: PanelTarget): void {
    tab.controller.dispose();
    tab.context = context;
    tab.target = target;
    tab.controller = this.createController(tab.panel, context, target);
    this.load(tab);
  }

  /** (Re)loads the webview of a tab: it starts fresh and sends "ready" to its controller. */
  private load(tab: Tab): void {
    if (tab.target.kind === "fleet") tab.panel.title = tab.controller.title();
    else {
      void this.d.state.loadNamespaces(tab.context);
      tab.panel.title = `${tab.controller.title()} · ${shortContextName(tab.context)}`;
    }
    tab.panel.webview.html = this.html(tab.panel.webview);
    tab.controller.setVisible(tab.panel.visible);
    if (tab.panel.active) this.activeEmitter.fire({ context: tab.context, target: tab.target });
  }

  private createController(panel: vscode.WebviewPanel, context: string, target: PanelTarget, group: string | null = null): TabController {
    const { state, actions, store } = this.d;
    if (target.kind === "fleet") {
      return new FleetController({
        scanner: this.d.scanner,
        host: {
          post: (msg: HostMessage) => void panel.webview.postMessage(msg),
          openInCluster: (ref) => this.openInCluster(ref),
          fluxAction: (action, row) => void this.d.fleetActions.flux(action, row),
          copyText: (text) => void actions.copyText(text),
          // An untitled Markdown document: to read, copy, or save.
          openReport: (markdown) =>
            void vscode.workspace
              .openTextDocument({ language: "markdown", content: markdown })
              .then((doc) => vscode.window.showTextDocument(doc, { preview: false })),
        },
        groups: () => this.d.fleetGroups(),
        refreshIntervalMs: () => config.fleetRefreshIntervalMs(),
        driftGraceMs: () => config.fleetDriftGraceMs(),
        appearance: config.appearance(),
        log: this.d.log,
        group,
      });
    }
    const host: PanelHost = {
      post: (msg: HostMessage) => void panel.webview.postMessage(msg),
      runAction: (ctx, action, ref, container) => void actions.run(action, { context: ctx, ref, container }),
      rowMenu: (ctx, ref, list) => void actions.rowMenu(ctx, ref, list),
      bulkAction: (ctx, action, refs) => void actions.runMany(ctx, action, refs),
      openResource: (ctx, resource) => this.open(ctx, { kind: "list", resource }),
      setNamespaces: (ctx, namespaces) => void state.setNamespaces(ctx, namespaces),
      refresh: (ctx) => {
        store.refresh(ctx);
        void state.loadNamespaces(ctx, true);
      },
      copyText: (text) => void actions.copyText(text),
      updateSecret: (ctx, ref, key, value) => actions.updateSecretValue(ctx, ref, key, value),
      reportProblems: (ctx, problems) => this.d.problems.report(ctx, problems),
    };
    return new PanelController({
      context,
      target,
      host,
      registry: this.d.registry,
      store,
      client: this.d.client,
      helm: this.d.helm,
      metrics: this.d.metrics,
      crds: this.d.crds,
      log: this.d.log,
      appearance: config.appearance(),
      protection: this.d.guard.protection(context),
      namespaces: state.filter(context),
    });
  }

  private html(webview: vscode.Webview): string {
    const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", ...path));
    const scriptNonce = nonce();
    const csp = [
      "default-src 'none'",
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${scriptNonce}'`,
    ].join("; ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset("codicons", "codicon.css")}">
<link rel="stylesheet" href="${asset("styles.css")}">
<title>KubeXplorer</title>
</head>
<body data-appearance="${config.appearance()}">
<div id="app"></div>
<script nonce="${scriptNonce}" src="${asset("dist", "webview.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const tab of [...this.tabs]) tab.panel.dispose();
    this.subscriptions.forEach((s) => s.dispose());
    this.activeEmitter.dispose();
  }
}
