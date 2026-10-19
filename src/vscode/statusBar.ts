// Status bar: active cluster and namespace filter, both clickable. A protected cluster stands out in red.

import * as vscode from "vscode";
import type { ClusterState } from "./clusterState";
import type { ContextGuard } from "./protection";

export class KubeStatusBar implements vscode.Disposable {
  private readonly cluster = vscode.window.createStatusBarItem("kubexplorer.cluster", vscode.StatusBarAlignment.Left, 50);
  private readonly namespaces = vscode.window.createStatusBarItem("kubexplorer.namespaces", vscode.StatusBarAlignment.Left, 49);
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly state: ClusterState,
    private readonly guard: ContextGuard,
  ) {
    this.cluster.name = vscode.l10n.t("KubeXplorer: Cluster");
    this.cluster.command = "kubexplorer.selectContext";
    this.cluster.tooltip = vscode.l10n.t("KubeXplorer: active cluster (click to change)");
    this.namespaces.name = vscode.l10n.t("KubeXplorer: Namespaces");
    this.namespaces.command = "kubexplorer.selectNamespaces";
    this.namespaces.tooltip = vscode.l10n.t("KubeXplorer: displayed namespaces (click to filter)");
    this.subscriptions = [
      state.onDidChangeActive(() => this.update()),
      state.onDidChangeContexts(() => this.update()),
      state.onDidChangeNamespaces(() => this.update()),
      guard.onDidChange(() => this.update()),
    ];
    this.update();
  }

  private update(): void {
    const context = this.state.active;
    if (!context) {
      this.cluster.hide();
      this.namespaces.hide();
      return;
    }
    const selected = this.state.selectedNamespaces(context);
    const protection = this.guard.protection(context);
    const icon = protection === "readOnly" ? "lock" : protection === "confirm" ? "shield" : "server-environment";
    this.cluster.text = `$(${icon}) ${context}`;
    this.cluster.backgroundColor = protection === "none" ? undefined : new vscode.ThemeColor("statusBarItem.errorBackground");
    this.cluster.tooltip =
      protection === "readOnly"
        ? vscode.l10n.t("KubeXplorer: active cluster, read-only (click to change)")
        : protection === "confirm"
          ? vscode.l10n.t("KubeXplorer: active cluster, protected: changes ask to type the name of their target (click to change)")
          : vscode.l10n.t("KubeXplorer: active cluster (click to change)");
    this.namespaces.text = `$(layers) ${
      selected.length === 0
        ? vscode.l10n.t("all")
        : selected.length <= 2
          ? selected.join(", ")
          : vscode.l10n.t("{0} namespaces", selected.length)
    }`;
    this.cluster.show();
    this.namespaces.show();
  }

  dispose(): void {
    this.cluster.dispose();
    this.namespaces.dispose();
    this.subscriptions.forEach((s) => s.dispose());
  }
}
