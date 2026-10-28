// Messages exchanged between a resource tab (webview) and the extension.

import type { Protection } from "./protection";
import type { ActionId, ColumnDef, Details, FleetTab, FleetView, MetricsData, OverviewData, ResourceRef, Row } from "./view";

export type Appearance = "vscode" | "freelens";

/** page: an overview page other than the cluster one ("flux", "karpenter"). fleet: every cluster. */
export type PanelTarget = { kind: "list"; resource: string } | { kind: "overview"; page?: string } | { kind: "fleet" };

/** What a tab of one cluster shows. */
export type ClusterTarget = Exclude<PanelTarget, { kind: "fleet" }>;

interface BaseViewInit {
  context: string;
  /** What the tab shows, persisted to restore it after a restart. */
  target: PanelTarget;
  title: string;
  /** A protected context (e.g. production) is flagged in the header. */
  protection?: Protection;
}

export interface ListViewInit extends BaseViewInit {
  mode: "list";
  resource: string;
  kindName: string;
  namespaced: boolean;
  columns: ColumnDef[];
  hasWarnings: boolean;
  defaultSort: { col: string; desc: boolean };
}

export interface OverviewViewInit extends BaseViewInit {
  mode: "overview";
}

export interface FleetViewInit extends BaseViewInit {
  mode: "fleet";
}

export type ViewInit = ListViewInit | OverviewViewInit | FleetViewInit;

export interface NamespaceFilter {
  available: string[];
  /** Empty means every namespace. */
  selected: string[];
}

export type HostMessage =
  | { type: "init"; view: ViewInit; appearance: Appearance }
  | { type: "appearance"; appearance: Appearance }
  | { type: "protection"; protection: Protection }
  | { type: "namespaces"; filter: NamespaceFilter }
  /** live: the list is followed in real time (watch) rather than polled. */
  | { type: "rows"; rows: Row[]; loading: boolean; error?: string; live?: boolean }
  /** What changed since the last rows: rows added or changed, and the uids of the rows removed. */
  | { type: "rowsPatch"; upsert: Row[]; remove: string[]; loading: boolean; error?: string; live?: boolean }
  | { type: "overview"; data: OverviewData; loading: boolean; error?: string; live?: boolean }
  | { type: "fleet"; view: FleetView }
  /** Shows an object in the drawer (opened from another tab, e.g. the fleet). */
  | { type: "reveal"; ref: ResourceRef }
  /** Details of the object shown in the drawer; null when the object is gone. */
  | { type: "details"; details: Details | null; error?: string }
  /** Usage charts of the object shown in the drawer; null when it has none. */
  | { type: "metrics"; uid: string; data: MetricsData | null }
  /** Decoded value of one Secret key, sent only on explicit request (revealSecret). */
  | { type: "secretValue"; uid: string; key: string; value?: string; error?: string }
  /** Outcome of updateSecret: saved, cancelled (saved false, no error) or failed. */
  | { type: "secretUpdated"; key: string; saved: boolean; error?: string };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "setNamespaces"; namespaces: string[] }
  /** Opens the drawer on an object, possibly of another kind; null closes it. */
  | { type: "showDetails"; ref: ResourceRef | null }
  | { type: "action"; action: ActionId; ref: ResourceRef; container?: string }
  /** The ⋮ button: the extension offers the actions in a native QuickPick. */
  | { type: "rowMenu"; ref: ResourceRef; actions: ActionId[] }
  /** An action on the checked rows (BULK_ACTIONS). */
  | { type: "bulkAction"; action: ActionId; refs: ResourceRef[] }
  | { type: "openResource"; resource: string }
  /** An object of another cluster (ref.context), opened in a tab of that cluster. */
  | { type: "openInCluster"; ref: ResourceRef }
  /** Fleet tab: what it shows. */
  | { type: "fleetState"; tab?: FleetTab; group?: string | null; problemsOnly?: boolean; searchKind?: string }
  /** Fleet tab: scan the clusters, run their diagnostics, or search them. */
  | { type: "fleetRun"; what: "scan" | "diagnose" | "search"; query?: string }
  | { type: "revealSecret"; ref: ResourceRef; key: string }
  /** A Secret value edited in the drawer; it reaches the extension only when saved. */
  | { type: "updateSecret"; ref: ResourceRef; key: string; value: string }
  | { type: "copyText"; text: string };

/** Context attached to rows for the native context menus (data-vscode-context). */
export interface RowMenuContext {
  webviewSection: "row";
  preventDefaultContextMenuItems: true;
  kubexplorerContext: string;
  kubexplorerResource: string;
  kubexplorerNamespace?: string;
  kubexplorerName: string;
  /** "logs,shell,…", matched by the `when` clauses of package.json. */
  kubexplorerActions: string;
}

/** Webview state persisted with setState(): it lets the serializer restore the tab after a reload. */
export interface PersistedState {
  panel?: { context: string; target: PanelTarget };
  search: string;
  sort?: { col: string; desc: boolean };
  selected: ResourceRef | null;
  drawerWidth: number;
}
