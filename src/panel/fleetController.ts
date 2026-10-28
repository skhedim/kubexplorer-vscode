// Logic of the Fleet tab, independent from VS Code (unit tested, reused by the browser preview): what it shows
// (clusters, Flux matrix, diagnostics, search), for which group, and the details of a row. The clusters are read by
// the FleetScanner, shared with the Clusters view; this tab asks for a scan when shown, then periodically.

import type { Disposable, Logger } from "../kube/types";
import { buildMatrix, type MatrixRow, SEARCH_KINDS, type SearchHit } from "../resources/fleet";
import {
  clusterDetails,
  clustersData,
  diagnosticsData,
  FLEET_CLUSTER,
  FLEET_FLUX,
  fluxData,
  fluxRowDetails,
  searchData,
} from "../resources/fleetViews";
import { formatAge } from "../resources/format";
import type { Appearance, HostMessage, ViewInit, WebviewMessage } from "../shared/protocol";
import type { Details, FleetTab, FleetView, OverviewData, ResourceRef } from "../shared/view";
import { type FleetScanner, MAX_HITS } from "./fleetScanner";

export type FleetAction = "reconcile" | "suspend" | "resume";

/** What the controller delegates to VS Code. */
export interface FleetHost {
  post(msg: HostMessage): void;
  /** Opens an object (or an overview page: resource "overview", "overview:<page>") in a tab of its cluster. */
  openInCluster(ref: ResourceRef): void;
  /** A Flux action on the clusters of a matrix row, after asking which ones. */
  fluxAction(action: FleetAction, row: MatrixRow): void;
  copyText(text: string): void;
}

export interface FleetControllerDeps {
  scanner: FleetScanner;
  host: FleetHost;
  /** Group names, in display order. */
  groups(): string[];
  /** Automatic scans while the tab is visible, at most once every… */
  refreshIntervalMs(): number;
  appearance: Appearance;
  log: Logger;
  /** Group shown first (the tab was opened from a group of the Clusters view). */
  group?: string | null;
  now?: () => number;
}

/** Updates of the scans (one per cluster) are coalesced: at most one view every… */
const PUSH_THROTTLE_MS = 300;

export class FleetController {
  /** A Fleet tab belongs to no cluster. */
  readonly context = "";
  private ready = false;
  private visible = false;
  private tab: FleetTab = "clusters";
  private group: string | null;
  private problemsOnly = false;
  private search: { kind: string; query: string; hits: SearchHit[]; searched: boolean } = {
    kind: SEARCH_KINDS[0].id,
    query: "",
    hits: [],
    searched: false,
  };
  private selected: ResourceRef | null = null;
  private matrix?: MatrixRow[];
  private subscription?: Disposable;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private pushTimer?: ReturnType<typeof setTimeout>;
  private lastPush = 0;

  constructor(private readonly d: FleetControllerDeps) {
    this.group = d.group ?? null;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  title(): string {
    return this.group ? `Fleet: ${this.group}` : "Fleet";
  }

  private init(): ViewInit {
    return { mode: "fleet", context: "", target: { kind: "fleet" }, title: this.title() };
  }

  /** The clusters shown: those of the selected group. */
  private contexts(): string[] {
    return this.d.scanner
      .list()
      .filter((s) => !this.group || s.group === this.group)
      .map((s) => s.context);
  }

  onMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.d.host.post({ type: "init", view: this.init(), appearance: this.d.appearance });
        this.start();
        break;
      // Asked by the user: everything is read again, caches included.
      case "refresh":
        void this.d.scanner.scan(this.contexts(), { force: true });
        break;
      case "fleetState":
        if (msg.tab) this.tab = msg.tab;
        if (msg.group !== undefined) this.group = msg.group;
        if (msg.problemsOnly !== undefined) this.problemsOnly = msg.problemsOnly;
        if (msg.searchKind) this.search = { ...this.search, kind: msg.searchKind, hits: [], searched: false };
        this.push();
        break;
      case "fleetRun":
        if (msg.what === "scan") void this.d.scanner.scan(this.contexts(), { force: true });
        else if (msg.what === "diagnose") void this.d.scanner.diagnose(this.contexts());
        else this.runSearch(msg.query ?? "");
        break;
      case "showDetails":
        this.selected = msg.ref;
        this.pushDetails();
        break;
      case "action": {
        const row = msg.ref.resource === FLEET_FLUX ? this.matrixRows().find((r) => r.key === msg.ref.name) : undefined;
        if (row && (msg.action === "reconcile" || msg.action === "suspend" || msg.action === "resume"))
          this.d.host.fluxAction(msg.action, row);
        break;
      }
      case "openInCluster":
        this.d.host.openInCluster(msg.ref);
        break;
      case "copyText":
        this.d.host.copyText(msg.text);
        break;
    }
  }

  private runSearch(query: string): void {
    this.search = { ...this.search, query, hits: [], searched: true };
    this.push();
    void this.d.scanner.search(this.contexts(), this.search.kind, query, (hits) => {
      if (this.search.query !== query) return;
      this.search.hits = [...this.search.hits, ...hits].slice(0, MAX_HITS);
      this.schedulePush();
    });
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.start();
    else this.stop();
  }

  /** While visible and ready: follow the scans, scan now if the last one is too old, then periodically. */
  private start(): void {
    if (!this.visible || !this.ready || this.subscription) return;
    this.subscription = this.d.scanner.onDidChange(() => this.schedulePush());
    this.push();
    const oldest = this.d.scanner.oldestCheck();
    if (oldest === undefined || this.now() - oldest > this.d.refreshIntervalMs()) void this.d.scanner.scan();
    this.refreshTimer = setInterval(() => void this.d.scanner.scan(), this.d.refreshIntervalMs());
  }

  private stop(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    const wait = Math.max(0, this.lastPush + PUSH_THROTTLE_MS - this.now());
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.push();
    }, wait);
  }

  private matrixRows(): MatrixRow[] {
    return (this.matrix ??= buildMatrix(this.d.scanner.list().filter((s) => !this.group || s.group === this.group)));
  }

  /** The view of the tab, built from the current scans. */
  view(): FleetView {
    this.matrix = undefined;
    const all = this.d.scanner.list();
    const scans = all.filter((s) => !this.group || s.group === this.group);
    const now = this.now();
    const present = new Set(all.map((s) => s.group));
    const groups = this.d.groups().filter((g) => present.has(g));
    let data: OverviewData;
    if (this.tab === "flux") data = fluxData(this.matrixRows(), scans, this.problemsOnly);
    else if (this.tab === "diagnostics") data = diagnosticsData(scans, this.problemsOnly, now);
    else if (this.tab === "search") data = searchData(this.search.hits, this.search.searched, this.search.hits.length >= MAX_HITS);
    else data = clustersData(scans, this.group ? [this.group] : groups, this.problemsOnly, now);
    // The oldest attempt, successful or not: an unreachable cluster was checked too.
    const checks = scans.map((s) => s.checkedAt);
    const oldest = checks.every((c) => c !== undefined) && checks.length ? Math.min(...(checks as number[])) : undefined;
    return {
      tab: this.tab,
      groups,
      group: this.group,
      problemsOnly: this.problemsOnly,
      clusters: scans.length,
      progress: this.d.scanner.activity()[0],
      updated: oldest ? `scanned ${formatAge(new Date(oldest).toISOString(), now)} ago` : undefined,
      searchKinds: SEARCH_KINDS.map((k) => ({ id: k.id, label: k.label })),
      searchKind: this.search.kind,
      searchQuery: this.search.query,
      data,
    };
  }

  private push(): void {
    if (!this.ready) return;
    this.lastPush = this.now();
    this.d.host.post({ type: "fleet", view: this.view() });
    if (this.selected) this.pushDetails();
  }

  private details(ref: ResourceRef): Details | null {
    if (ref.resource === FLEET_CLUSTER) {
      const scan = this.d.scanner.list().find((s) => s.context === ref.name);
      return scan ? clusterDetails(scan, this.now()) : null;
    }
    if (ref.resource === FLEET_FLUX) {
      const row = this.matrixRows().find((r) => r.key === ref.name);
      return row ? fluxRowDetails(row, this.d.scanner.list()) : null;
    }
    return null;
  }

  private pushDetails(): void {
    if (!this.ready) return;
    this.d.host.post({ type: "details", details: this.selected ? this.details(this.selected) : null });
  }

  /** Shows a group (the tab is opened again from another group of the Clusters view). */
  showGroup(group: string | null): void {
    this.group = group;
    this.push();
  }

  setAppearance(appearance: Appearance): void {
    this.d.appearance = appearance;
    if (this.ready) this.d.host.post({ type: "appearance", appearance });
  }

  // A Fleet tab has no protection nor namespaces of its own; it reveals nothing.
  setProtection(): void {}
  setNamespaceFilter(): void {}
  reveal(): void {}

  dispose(): void {
    this.stop();
  }
}
