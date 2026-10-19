// The Clusters view: the kubeconfig contexts, like the Freelens hotbar, in fleet groups (prod, dev… from the
// kubexplorer.fleet.groups patterns) once several groups have clusters. The last scan of the fleet adds the state
// of each cluster.

import * as vscode from "vscode";
import type { ContextInfo } from "../kube/types";
import type { FleetScanner } from "../panel/fleetScanner";
import { type ClusterScan, groupOf, groupOrder, isFailing, OTHER_GROUP } from "../resources/fleet";
import { avatarSvg } from "../shared/clusterNames";
import type { ClusterState } from "./clusterState";
import { config } from "./config";
import type { ContextGuard } from "./protection";

export interface GroupNode {
  group: string;
  contexts: ContextInfo[];
}

export type ClusterNode = GroupNode | ContextInfo;

const isGroup = (n: ClusterNode): n is GroupNode => "group" in n;

/** Scans update the tree at most once every… (a scan reports each of its clusters). */
const REFRESH_DELAY_MS = 500;

/** The state of a scanned cluster, in a few words; undefined when there is nothing to say. */
function scanState(scan: ClusterScan | undefined): string | undefined {
  if (!scan) return undefined;
  if (scan.status === "error") return vscode.l10n.t("unreachable");
  const failing = (scan.objects ?? []).filter(isFailing).length;
  return failing ? vscode.l10n.t("{0} failing", failing) : undefined;
}

export class ClustersView implements vscode.TreeDataProvider<ClusterNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: { dispose(): void }[];
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly state: ClusterState,
    private readonly guard: ContextGuard,
    private readonly scanner: FleetScanner,
  ) {
    const refresh = () => this.emitter.fire();
    this.subscriptions = [
      state.onDidChangeContexts(refresh),
      state.onDidChangeActive(refresh),
      guard.onDidChange(refresh),
      scanner.onDidChange(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("kubexplorer.fleet") && refresh()),
    ];
  }

  private scheduleRefresh(): void {
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = undefined;
      this.emitter.fire();
    }, REFRESH_DELAY_MS);
  }

  getTreeItem(node: ClusterNode): vscode.TreeItem {
    return isGroup(node) ? this.groupItem(node) : this.contextItem(node);
  }

  private groupItem(g: GroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(g.group, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `group:${g.group}`;
    item.iconPath = new vscode.ThemeIcon(g.group === OTHER_GROUP ? "folder" : "server-environment");
    const scans = g.contexts.map((c) => this.scanner.get(c.name));
    const unreachable = scans.filter((s) => s?.status === "error").length;
    const failing = scans.filter((s) => s?.status === "ok" && (s.objects ?? []).some(isFailing)).length;
    item.description = [
      vscode.l10n.t("{0} cluster(s)", g.contexts.length),
      unreachable ? vscode.l10n.t("{0} unreachable", unreachable) : "",
      failing ? vscode.l10n.t("{0} with failures", failing) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    item.contextValue = "fleetGroup";
    return item;
  }

  private contextItem(c: ContextInfo): vscode.TreeItem {
    const active = c.name === this.state.active;
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
    item.id = `cluster:${c.name}`;
    // A data: URI: tree icons must not be loaded from files outside of the extension folder.
    item.iconPath = vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(avatarSvg(c.name)).toString("base64")}`);
    const protection = this.guard.protection(c.name);
    const scan = this.scanner.get(c.name);
    item.description = [
      active ? vscode.l10n.t("● active") : "",
      protection === "readOnly" ? vscode.l10n.t("read-only") : protection === "confirm" ? vscode.l10n.t("protected") : "",
      scanState(scan) ?? "",
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
    if (scan?.status === "error") tooltip.appendMarkdown(`\n\n$(error) ${scan.error ?? ""}`);
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.command = { command: "kubexplorer.activateContext", title: vscode.l10n.t("Activate"), arguments: [c.name] };
    item.accessibilityInformation = { label: active ? vscode.l10n.t("Cluster {0}, active", c.name) : vscode.l10n.t("Cluster {0}", c.name) };
    return item;
  }

  /** The groups that have clusters; a flat list when every cluster is in the same group. */
  getChildren(element?: ClusterNode): ClusterNode[] {
    if (element) return isGroup(element) ? element.contexts : [];
    const groups = config.fleetGroups();
    const byGroup = new Map<string, ContextInfo[]>();
    for (const c of this.state.contexts) {
      const g = groupOf(c.name, groups);
      byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
    }
    if (byGroup.size <= 1) return this.state.contexts;
    return groupOrder(groups).flatMap((group) => (byGroup.has(group) ? [{ group, contexts: byGroup.get(group)! }] : []));
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.subscriptions.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}
