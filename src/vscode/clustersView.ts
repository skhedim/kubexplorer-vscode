// The Clusters view: the kubeconfig contexts, like the Freelens hotbar.

import * as vscode from "vscode";
import type { ContextInfo } from "../kube/types";
import { avatarSvg } from "../shared/clusterNames";
import type { ClusterState } from "./clusterState";
import type { ContextGuard } from "./protection";

export class ClustersView implements vscode.TreeDataProvider<ContextInfo>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly state: ClusterState,
    private readonly guard: ContextGuard,
  ) {
    this.subscriptions = [
      state.onDidChangeContexts(() => this.emitter.fire()),
      state.onDidChangeActive(() => this.emitter.fire()),
      guard.onDidChange(() => this.emitter.fire()),
    ];
  }

  getTreeItem(c: ContextInfo): vscode.TreeItem {
    const active = c.name === this.state.active;
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
    item.id = `cluster:${c.name}`;
    // A data: URI: tree icons must not be loaded from files outside of the extension folder.
    item.iconPath = vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(avatarSvg(c.name)).toString("base64")}`);
    const protection = this.guard.protection(c.name);
    item.description = [
      active ? vscode.l10n.t("● active") : "",
      protection === "readOnly" ? vscode.l10n.t("read-only") : protection === "confirm" ? vscode.l10n.t("protected") : "",
      c.current ? "kubeconfig" : "",
      c.demo ? vscode.l10n.t("demo") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    item.contextValue = active ? "cluster.active" : "cluster";
    const tooltip = new vscode.MarkdownString(`**${c.name}**`);
    if (c.cluster) tooltip.appendMarkdown(`\n\n${vscode.l10n.t("Cluster: `{0}`", c.cluster)}`);
    if (c.user) tooltip.appendMarkdown(`\n\n${vscode.l10n.t("User: `{0}`", c.user)}`);
    if (c.namespace) tooltip.appendMarkdown(`\n\n${vscode.l10n.t("Default namespace: `{0}`", c.namespace)}`);
    if (c.current) tooltip.appendMarkdown(`\n\n_${vscode.l10n.t("Current context of the kubeconfig")}_`);
    if (protection !== "none")
      tooltip.appendMarkdown(
        `\n\n$(shield) ${protection === "readOnly" ? vscode.l10n.t("Read-only: no change is allowed") : vscode.l10n.t("Protected: changes ask to type the name of their target")}`,
      );
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.command = { command: "kubexplorer.activateContext", title: vscode.l10n.t("Activate"), arguments: [c.name] };
    item.accessibilityInformation = { label: active ? vscode.l10n.t("Cluster {0}, active", c.name) : vscode.l10n.t("Cluster {0}", c.name) };
    return item;
  }

  getChildren(element?: ContextInfo): ContextInfo[] {
    return element ? [] : this.state.contexts;
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}
