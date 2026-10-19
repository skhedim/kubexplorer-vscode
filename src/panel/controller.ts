// Logic of one resource tab, independent from VS Code (unit tested, reused by the browser preview).
// The controller subscribes to the store while the tab is visible and pushes rows and details to the webview.

import type { KubeClient } from "../kube/client";
import type { CrdCatalog } from "../kube/crds";
import type { HelmClient } from "../kube/helm";
import type { ResourceStore, Snapshot } from "../kube/store";
import { type Disposable, errorMessage, type KubeObject, type Logger } from "../kube/types";
import { type DetailContext, indexRelated, type RowContext } from "../resources/descriptor";
import type { Problem } from "../resources/diagnostics";
import type { OverviewPage } from "../resources/overview";
import { overviewPage, type ResourceRegistry } from "../resources/registry";
import { decodeBase64 } from "../shared/encoding";
import { allowedActions, type Protection } from "../shared/protection";
import type { Appearance, HostMessage, NamespaceFilter, PanelTarget, ViewInit, WebviewMessage } from "../shared/protocol";
import type { ActionId, Details, ResourceRef, Row } from "../shared/view";
import type { MetricsService } from "./metrics";

/** What the controller delegates to its host (VS Code: dialogs, terminals, commands). */
export interface PanelHost {
  post(msg: HostMessage): void;
  runAction(context: string, action: ActionId, ref: ResourceRef, container?: string): void;
  rowMenu(context: string, ref: ResourceRef, actions: ActionId[]): void;
  bulkAction(context: string, action: ActionId, refs: ResourceRef[]): void;
  openResource(context: string, resource: string): void;
  setNamespaces(context: string, namespaces: string[]): void;
  refresh(context: string): void;
  copyText(text: string): void;
  /** Problems found by a page (Diagnostics), for the Problems view; an empty list clears them. */
  reportProblems?(context: string, problems: Problem[]): void;
  /** Changes one value of a Secret, after the confirmations of the context; false when cancelled. */
  updateSecret(context: string, ref: ResourceRef, key: string, value: string): Promise<boolean>;
}

export interface PanelDeps {
  context: string;
  target: PanelTarget;
  registry: ResourceRegistry;
  store: ResourceStore;
  client: KubeClient;
  host: PanelHost;
  log: Logger;
  appearance: Appearance;
  namespaces: NamespaceFilter;
  helm?: HelmClient;
  /** Usage charts; without it, the drawer shows none. */
  metrics?: MetricsService;
  /** Installed CRDs: overview pages skip the optional kinds that are missing. */
  crds?: CrdCatalog;
  /** A read-only context hides the actions that change the cluster. */
  protection?: Protection;
}

/** Refresh of the displayed ages: with a watch, a list only changes when the cluster does. */
const AGE_TICK_MS = 30_000;
/** Automatic refresh of the details (which may query the cluster), at most once every… */
const DETAILS_THROTTLE_MS = 2_000;
/** Refresh of the usage charts of the drawer. */
const METRICS_REFRESH_MS = 20_000;
/** Related lists recorded in the metrics history. */
const METRICS_LISTS = new Set(["podmetrics", "nodemetrics"]);

export class PanelController implements Disposable {
  private subscriptions: Disposable[] = [];
  private visible = false;
  private ready = false;
  private selected: ResourceRef | null = null;
  private detailsGeneration = 0;
  private lastSnapshot?: Snapshot;
  private rowContext: RowContext = { related: {} };
  private overviewLists = new Map<string, Snapshot>();
  private overviewMissing = new Set<string>();
  /** Bumped by each (un)subscription: invalidates an overview subscription still waiting for the CRDs. */
  private subscriptionGeneration = 0;
  private overviewQueued = false;
  private rowsQueued = false;
  private tick?: ReturnType<typeof setInterval>;
  private detailsTimer?: ReturnType<typeof setTimeout>;
  private lastDetailsAt = 0;
  private metricsTimer?: ReturnType<typeof setInterval>;
  /** uid of the object whose charts are refreshed. */
  private metricsUid?: string;

  constructor(private readonly d: PanelDeps) {}

  get context(): string {
    return this.d.context;
  }

  get target(): PanelTarget {
    return this.d.target;
  }

  private page(): OverviewPage {
    return overviewPage(this.d.target.kind === "overview" ? this.d.target.page : undefined);
  }

  title(): string {
    const { target } = this.d;
    return target.kind === "overview" ? this.page().title : this.d.registry.require(target.resource).title;
  }

  private get protection(): Protection {
    return this.d.protection ?? "none";
  }

  private init(): ViewInit {
    const { context, target } = this.d;
    const base = { context, target, protection: this.protection, title: this.title() };
    if (target.kind === "overview") return { mode: "overview", ...base };
    const desc = this.d.registry.require(target.resource);
    return {
      mode: "list",
      ...base,
      resource: desc.id,
      kindName: desc.kindName,
      namespaced: desc.namespaced,
      columns: desc.columns,
      hasWarnings: desc.hasWarnings,
      defaultSort: desc.defaultSort,
    };
  }

  onMessage(msg: WebviewMessage): void {
    const { host, context } = this.d;
    switch (msg.type) {
      case "ready":
        this.ready = true;
        host.post({ type: "init", view: this.init(), appearance: this.d.appearance });
        host.post({ type: "namespaces", filter: this.d.namespaces });
        this.resubscribe();
        break;
      case "refresh":
        host.refresh(context);
        break;
      case "setNamespaces":
        host.setNamespaces(context, msg.namespaces);
        break;
      case "showDetails":
        this.selected = msg.ref;
        clearTimeout(this.detailsTimer);
        this.detailsTimer = undefined;
        this.stopMetrics();
        void this.pushDetails();
        break;
      case "action":
        host.runAction(context, msg.action, msg.ref, msg.container);
        break;
      case "rowMenu":
        host.rowMenu(context, msg.ref, msg.actions);
        break;
      case "bulkAction":
        host.bulkAction(context, msg.action, msg.refs);
        break;
      case "openResource":
        host.openResource(context, msg.resource);
        break;
      case "revealSecret":
        void this.revealSecret(msg.ref, msg.key);
        break;
      case "updateSecret":
        void this.updateSecret(msg.ref, msg.key, msg.value);
        break;
      case "copyText":
        host.copyText(msg.text);
        break;
    }
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.resubscribe();
  }

  setNamespaceFilter(filter: NamespaceFilter): void {
    const changed = filter.selected.join(",") !== this.d.namespaces.selected.join(",");
    this.d.namespaces = filter;
    if (this.ready) this.d.host.post({ type: "namespaces", filter });
    if (changed) this.resubscribe();
  }

  setAppearance(appearance: Appearance): void {
    this.d.appearance = appearance;
    if (this.ready) this.d.host.post({ type: "appearance", appearance });
  }

  /** The protection of the context changed (settings): the header and the offered actions follow. */
  setProtection(protection: Protection): void {
    if (protection === this.protection) return;
    this.d.protection = protection;
    if (!this.ready) return;
    this.d.host.post({ type: "protection", protection });
    this.queueRows();
    if (this.d.target.kind === "overview") this.queueOverview();
    if (this.selected) void this.pushDetails();
  }

  /** Without the actions a read-only context refuses. */
  private allowedRow(row: Row): Row {
    return { ...row, actions: allowedActions(row.actions, this.protection) };
  }

  private allowedDetails(details: Details): Details {
    const sections = details.sections.map((s) =>
      s.type === "group" && s.actions ? { ...s, actions: s.actions.filter((a) => allowedActions([a.action], this.protection).length) } : s,
    );
    return { ...details, actions: allowedActions(details.actions, this.protection), sections };
  }

  private unsubscribe(): void {
    this.subscriptionGeneration++;
    for (const s of this.subscriptions) s.dispose();
    this.subscriptions = [];
    clearInterval(this.tick);
    this.tick = undefined;
    this.stopMetrics();
  }

  /** (Re)subscribes to the store, only while the tab is visible and its webview ready. */
  private resubscribe(): void {
    this.unsubscribe();
    if (!this.visible || !this.ready) return;
    const { store, registry, context, target } = this.d;
    const namespaces = this.d.namespaces.selected;
    if (target.kind === "list") {
      const desc = registry.require(target.resource);
      this.rowContext = { related: {} };
      this.subscriptions.push(
        store.watch({ context, kind: desc, namespaces }, (snap) => {
          this.lastSnapshot = snap;
          this.queueRows();
        }),
        // Related lists (metrics…): their errors are ignored, the related columns simply stay empty.
        ...desc.related.map((id) =>
          store.watch({ context, kind: registry.require(id), namespaces }, (snap) => {
            this.rowContext = { related: { ...this.rowContext.related, [id]: indexRelated(snap.items) } };
            this.recordMetrics(id, snap);
            if (!snap.loading) this.queueRows();
          }),
        ),
      );
      this.tick = setInterval(() => this.queueRows(), AGE_TICK_MS);
    } else {
      void this.subscribeOverview(this.subscriptionGeneration);
    }
  }

  /** The metrics-server lists feed the history of the usage charts. */
  private recordMetrics(id: string, snap: Snapshot): void {
    if (METRICS_LISTS.has(id) && !snap.loading && !snap.error) this.d.metrics?.history.record(this.d.context, snap.items);
  }

  private async subscribeOverview(generation: number): Promise<void> {
    const { store, registry, context } = this.d;
    const page = this.page();
    const descriptors = page.resources.map((id) => registry.require(id));
    const installed = descriptors.some((d) => d.optional) ? await this.d.crds?.kindNames(context) : undefined;
    if (generation !== this.subscriptionGeneration) return;
    this.overviewLists = new Map();
    this.overviewMissing = new Set(descriptors.filter((d) => d.optional && installed && !installed.has(d.kubectlName)).map((d) => d.id));
    for (const desc of descriptors) {
      if (this.overviewMissing.has(desc.id)) continue;
      this.subscriptions.push(
        store.watch({ context, kind: desc, namespaces: this.d.namespaces.selected }, (snap) => {
          this.overviewLists.set(desc.id, snap);
          this.recordMetrics(desc.id, snap);
          this.queueOverview();
        }),
      );
    }
    if (!this.subscriptions.length) this.queueOverview();
  }

  /** Coalesces the updates (main list + related lists) received in the same tick. */
  private queueRows(): void {
    if (this.rowsQueued || this.d.target.kind !== "list") return;
    this.rowsQueued = true;
    const desc = this.d.registry.require(this.d.target.resource);
    queueMicrotask(() => {
      this.rowsQueued = false;
      const snap = this.lastSnapshot;
      if (!snap) return;
      this.d.host.post({
        type: "rows",
        rows: snap.items.map((o) => this.allowedRow(desc.toRow(o, this.rowContext))),
        loading: snap.loading,
        error: snap.error,
        live: snap.live,
      });
      if (this.selected && !snap.loading) this.scheduleDetails();
    });
  }

  /** Refreshes the details after an update, throttled (a watch may emit often). */
  private scheduleDetails(): void {
    if (this.detailsTimer) return;
    const wait = Math.max(0, this.lastDetailsAt + DETAILS_THROTTLE_MS - Date.now());
    this.detailsTimer = setTimeout(() => {
      this.detailsTimer = undefined;
      void this.pushDetails();
    }, wait);
  }

  /** Coalesces the updates of the overview lists received in the same tick. */
  private queueOverview(): void {
    if (this.overviewQueued) return;
    this.overviewQueued = true;
    queueMicrotask(() => {
      this.overviewQueued = false;
      const page = this.page();
      const watched = page.resources.filter((r) => !this.overviewMissing.has(r));
      const lists: Partial<Record<string, KubeObject[]>> = {};
      const errors: Partial<Record<string, string>> = {};
      for (const [r, snap] of this.overviewLists) {
        lists[r] = snap.items;
        if (snap.error) errors[r] = snap.error;
      }
      const loading = watched.some((r) => this.overviewLists.get(r)?.loading ?? true);
      const live = watched.every((r) => this.overviewLists.get(r)?.live);
      const input = { lists, errors, missing: this.overviewMissing };
      const built = page.build(input);
      const data = { ...built, tables: built.tables.map((t) => ({ ...t, rows: t.rows.map((r) => this.allowedRow(r)) })) };
      this.d.host.post({ type: "overview", data, loading, error: page.primary ? errors[page.primary] : undefined, live });
      // Once every list is loaded: partial lists would report objects as missing.
      if (page.problems && !loading) this.d.host.reportProblems?.(this.d.context, page.problems(input));
      if (this.selected && !loading) this.scheduleDetails();
    });
  }

  private detailContext(): DetailContext {
    const { client, registry, context } = this.d;
    return {
      context,
      helm: this.d.helm,
      rowContext: this.rowContext,
      list: (resource, opts) => client.list(context, registry.require(resource), opts),
      rowsOf: (resource, items) => {
        const desc = registry.require(resource);
        return { columns: desc.compactColumns, rows: items.map((o) => desc.toCompactRow(o, this.rowContext)) };
      },
    };
  }

  private async findObject(ref: ResourceRef): Promise<KubeObject | undefined> {
    const desc = this.d.registry.require(ref.resource);
    const same = this.d.target.kind === "list" && this.d.target.resource === ref.resource;
    const local = same
      ? this.lastSnapshot?.items.find((o) => o.metadata.name === ref.name && o.metadata.namespace === ref.namespace)
      : undefined;
    if (local) return local;
    const items = await this.d.client.list(this.d.context, desc, {
      namespaces: desc.namespaced && ref.namespace ? [ref.namespace] : [],
      fieldSelector: `metadata.name=${ref.name}`,
    });
    // Virtual lists ignore fieldSelector: look the object up explicitly.
    return items.find((o) => o.metadata.name === ref.name && (!desc.namespaced || o.metadata.namespace === ref.namespace));
  }

  private async pushDetails(): Promise<void> {
    const generation = ++this.detailsGeneration;
    this.lastDetailsAt = Date.now();
    const ref = this.selected;
    if (!ref) {
      this.d.host.post({ type: "details", details: null });
      return;
    }
    try {
      const desc = this.d.registry.get(ref.resource);
      if (!desc) throw new Error(`Unsupported resource type: ${ref.resource}`);
      const obj = await this.findObject(ref);
      const details = obj ? this.allowedDetails(await desc.details(obj, this.detailContext())) : null;
      if (generation !== this.detailsGeneration) return;
      this.d.host.post({ type: "details", details });
      if (obj && desc.metrics && this.d.metrics) this.startMetrics(obj.metadata.uid);
    } catch (err) {
      const error = errorMessage(err);
      this.d.log.warn(`Details of ${ref.resource}/${ref.name}: ${error}`);
      if (generation === this.detailsGeneration) this.d.host.post({ type: "details", details: null, error });
    }
  }

  /** Loads the charts of the object shown in the drawer now, then every METRICS_REFRESH_MS while it stays shown. */
  private startMetrics(uid: string): void {
    if (this.metricsUid === uid) return;
    this.stopMetrics();
    this.metricsUid = uid;
    const load = async () => {
      const ref = this.selected;
      const desc = ref && this.d.registry.get(ref.resource);
      if (!ref || !desc?.metrics || !this.d.metrics) return;
      try {
        const obj = await this.findObject(ref);
        const scope = obj && (await desc.metrics(obj, this.detailContext()));
        const data = scope ? await this.d.metrics.load(this.d.context, scope) : null;
        if (this.metricsUid === uid) this.d.host.post({ type: "metrics", uid, data });
      } catch (err) {
        if (this.metricsUid === uid) this.d.host.post({ type: "metrics", uid, data: { source: "", charts: [], error: errorMessage(err) } });
      }
    };
    void load();
    this.metricsTimer = setInterval(() => void load(), METRICS_REFRESH_MS);
  }

  private stopMetrics(): void {
    clearInterval(this.metricsTimer);
    this.metricsTimer = undefined;
    this.metricsUid = undefined;
  }

  /** Decodes one Secret value, read fresh from the cluster, and sends it to the webview only. */
  private async revealSecret(ref: ResourceRef, key: string): Promise<void> {
    try {
      const secret = await this.findObject(ref);
      const raw = secret?.data?.[key];
      if (!secret || typeof raw !== "string") throw new Error(`Key ${key} not found`);
      this.d.host.post({ type: "secretValue", uid: secret.metadata.uid, key, value: decodeBase64(raw) });
    } catch (err) {
      this.d.host.post({ type: "secretValue", uid: "", key, error: errorMessage(err) });
    }
  }

  private async updateSecret(ref: ResourceRef, key: string, value: string): Promise<void> {
    try {
      const saved = await this.d.host.updateSecret(this.d.context, ref, key, value);
      this.d.host.post({ type: "secretUpdated", key, saved });
    } catch (err) {
      this.d.host.post({ type: "secretUpdated", key, saved: false, error: errorMessage(err) });
    }
  }

  dispose(): void {
    this.unsubscribe();
    clearTimeout(this.detailsTimer);
    // The problems of a closed Diagnostics tab would go stale in the Problems view.
    if (this.d.target.kind === "overview" && this.page().problems) this.d.host.reportProblems?.(this.d.context, []);
  }
}
