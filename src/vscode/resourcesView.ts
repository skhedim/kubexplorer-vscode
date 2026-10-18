// The Resources view: the Freelens side menu, with Custom Resources discovered on the active cluster.

import * as vscode from "vscode";
import type { CrdCatalog } from "../kube/crds";
import { errorMessage, type Logger } from "../kube/types";
import { filterMenu, flattenMenu, MENU, type MenuEntry } from "../resources/menu";
import type { ResourceRegistry } from "../resources/registry";
import type { ClusterState } from "./clusterState";

export interface ResourceNode {
  id: string;
  label: string;
  icon?: string;
  /** Resource type to open; "overview" opens the cluster overview, "overview:<page>" another overview page. */
  open?: string;
  parent?: ResourceNode;
  children?: ResourceNode[];
  dynamic?: "crds";
  error?: string;
}

function toNodes(entries: MenuEntry[], parent?: ResourceNode): ResourceNode[] {
  return entries.map((e) => {
    const node: ResourceNode = { id: e.id, label: e.label, icon: e.icon, open: e.open, parent, dynamic: e.dynamic };
    if (e.children) node.children = toNodes(e.children, node);
    return node;
  });
}

export class ResourcesView implements vscode.TreeDataProvider<ResourceNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ResourceNode | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** The menu of the active cluster, without the integrations whose CRDs are missing. */
  private roots?: Promise<ResourceNode[]>;
  private crdChildren?: ResourceNode[];
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly state: ClusterState,
    private readonly crds: CrdCatalog,
    private readonly registry: ResourceRegistry,
    private readonly log: Logger,
  ) {
    this.subscription = state.onDidChangeActive(() => this.reset());
  }

  reset(): void {
    this.roots = undefined;
    this.crdChildren = undefined;
    this.emitter.fire();
  }

  private async menu(context: string): Promise<MenuEntry[]> {
    const installed = await this.crds.kindNames(context);
    return filterMenu(MENU, (open) => {
      const d = this.registry.get(open);
      return !d?.optional || installed.has(d.kubectlName);
    });
  }

  /** The entries that can be opened on a cluster (for the "Open Resource..." quick pick). */
  async openableEntries(context: string): Promise<ReturnType<typeof flattenMenu>> {
    return flattenMenu(await this.menu(context));
  }

  getTreeItem(n: ResourceNode): vscode.TreeItem {
    const collapsible = n.children?.length || n.dynamic;
    const state = !collapsible
      ? vscode.TreeItemCollapsibleState.None
      : n.id === "workloads"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(n.label, state);
    item.id = `resource:${n.parent ? `${n.parent.id}/` : ""}${n.id}`;
    if (n.icon) item.iconPath = new vscode.ThemeIcon(n.icon);
    if (n.error) {
      item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
      item.tooltip = n.error;
    }
    if (n.open === "overview") {
      item.command = { command: "kubexplorer.openOverview", title: vscode.l10n.t("Open") };
    } else if (n.open) {
      item.contextValue = "resource";
      item.command = { command: "kubexplorer.openResource", title: vscode.l10n.t("Open"), arguments: [n.open] };
    }
    return item;
  }

  async getChildren(n?: ResourceNode): Promise<ResourceNode[]> {
    if (!this.state.active) return [];
    if (!n) return (this.roots ??= this.menu(this.state.active).then((entries) => toNodes(entries)));
    if (n.dynamic === "crds") return [...(n.children ?? []), ...(await this.loadCrds(n))];
    return n.children ?? [];
  }

  getParent(n: ResourceNode): ResourceNode | undefined {
    return n.parent;
  }

  /** Node of an opened resource type (to select it in the tree). */
  async findNode(resource: string): Promise<ResourceNode | undefined> {
    const roots = await this.roots;
    const walk = (nodes: ResourceNode[] | undefined): ResourceNode | undefined => {
      for (const n of nodes ?? []) {
        if (n.open === resource) return n;
        const found = walk(n.children) ?? (n.dynamic ? walk(this.crdChildren) : undefined);
        if (found) return found;
      }
      return undefined;
    };
    return walk(roots);
  }

  /** CRDs of the active cluster, grouped by API group. */
  private async loadCrds(parent: ResourceNode): Promise<ResourceNode[]> {
    if (this.crdChildren) return this.crdChildren;
    const context = this.state.active!;
    try {
      const crds = await this.crds.list(context);
      const groups = new Map<string, ResourceNode>();
      for (const crd of [...crds].sort((a, b) => String(a.spec?.names?.kind).localeCompare(String(b.spec?.names?.kind)))) {
        const groupName = crd.spec?.group ?? "?";
        let group = groups.get(groupName);
        if (!group) {
          group = { id: `group:${groupName}`, label: groupName, parent, children: [] };
          groups.set(groupName, group);
        }
        const id = this.registry.registerCrd(crd);
        group.children!.push({ id, label: crd.spec.names.kind, open: id, parent: group });
      }
      this.crdChildren = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
    } catch (err) {
      const message = errorMessage(err);
      this.log.warn(`Cannot list the CRDs of ${context}: ${message}`);
      this.crdChildren = [{ id: "crd-error", label: vscode.l10n.t("Custom resources unavailable"), error: message, parent }];
    }
    return this.crdChildren;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
