// Status bar: active cluster and namespace filter, both clickable.

import * as vscode from "vscode";
import type { ClusterState } from "./clusterState";

export class KubeStatusBar implements vscode.Disposable {
  private readonly cluster = vscode.window.createStatusBarItem("kubexplorer.cluster", vscode.StatusBarAlignment.Left, 50);
  private readonly namespaces = vscode.window.createStatusBarItem("kubexplorer.namespaces", vscode.StatusBarAlignment.Left, 49);
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly state: ClusterState) {
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
    this.cluster.text = `$(server-environment) ${context}`;
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
