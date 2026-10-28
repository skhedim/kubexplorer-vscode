// Logic of one resource tab, independent from VS Code (unit tested, reused by the browser preview).
// The controller subscribes to the store while the tab is visible and pushes rows and details to the webview:
// - rows: the full list once, then what changed only (rowsPatch); a row is rebuilt only when its object or its
//   related objects (metrics) changed. Ages are computed by the webview: rows do not change as time passes.
// - details: refreshed when the object shown changes (its resourceVersion), and every DETAILS_REFRESH_MS for what
//   they show of other objects (the pods of a Deployment…).

import type { KubeClient } from "../kube/client";
import type { CrdCatalog } from "../kube/crds";
import type { HelmClient } from "../kube/helm";
import type { ResourceStore, Snapshot } from "../kube/store";
import { type Disposable, errorMessage, type KubeObject, type Logger } from "../kube/types";
import { type DetailContext, indexRelated, relatedOf, type ResourceDescriptor, type RowContext } from "../resources/descriptor";
import type { Problem } from "../resources/diagnostics";
import type { OverviewPage } from "../resources/overview";
import { overviewPage, type ResourceRegistry } from "../resources/registry";
import { decodeBase64 } from "../shared/encoding";
import { allowedActions, type Protection } from "../shared/protection";
import type { Appearance, ClusterTarget, HostMessage, NamespaceFilter, ViewInit, WebviewMessage } from "../shared/protocol";
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
  target: ClusterTarget;
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

/** Refresh of the details, for what they show of other objects (the object itself is followed by the lists). */
const DETAILS_REFRESH_MS = 30_000;
/** Automatic refresh of the details (which may query the cluster), at most once every… */
const DETAILS_THROTTLE_MS = 2_000;
/** Refresh of the usage charts of the drawer. */
const METRICS_REFRESH_MS = 20_000;
/** Related lists recorded in the metrics history. */
const METRICS_LISTS = new Set(["podmetrics", "nodemetrics"]);

/** A row sent to the webview, with what it was built from. */
interface SentRow {
  obj: KubeObject;
  related: (KubeObject | undefined)[];
  json: string;
  row: Row;
}

/** What the details of an object were built from: its version, or "" once it is gone. */
function detailsVersion(o: KubeObject | null): string {
  return o ? `${o.metadata.uid}/${o.metadata.resourceVersion ?? ""}` : "";
}

function objectKey(o: KubeObject): string {
  return o.metadata.uid || `${o.metadata.namespace ?? ""}/${o.metadata.name}`;
}

/** The same version of an object: the same instance, or the same resourceVersion (a list read again). */
function sameVersion(a: KubeObject, b: KubeObject): boolean {
  return (
    a === b ||
    (!!a.metadata.resourceVersion && a.metadata.resourceVersion === b.metadata.resourceVersion && a.metadata.uid === b.metadata.uid)
  );
}

export class PanelController implements Disposable {
  private subscriptions: Disposable[] = [];
  private visible = false;
  private ready = false;
  private selected: ResourceRef | null = null;
  /** An object to show in the drawer once the webview is ready (opened from another tab). */
  private pendingReveal?: ResourceRef;
  private detailsGeneration = 0;
  private lastSnapshot?: Snapshot;
  private rowContext: RowContext = { related: {} };
  private overviewLists = new Map<string, Snapshot>();
  private overviewMissing = new Set<string>();
  /** Bumped by each (un)subscription: invalidates an overview subscription still waiting for the CRDs. */
  private subscriptionGeneration = 0;
  private overviewQueued = false;
  private rowsQueued = false;
  /** Rows the webview has, by object: unchanged objects are neither rebuilt nor sent again. */
  private sentRows = new Map<string, SentRow>();
  /** The webview has a full list (rows): what follows are patches. */
  private rowsSent = false;
  private sentStatus = "";
  /** Version of the object shown in the drawer ("" once gone): its details are rebuilt when it changes. */
  private shownVersion?: string;
  private detailsTick?: ReturnType<typeof setInterval>;
  private detailsTimer?: ReturnType<typeof setTimeout>;
  private lastDetailsAt = 0;
  private metricsTimer?: ReturnType<typeof setInterval>;
  /** uid of the object whose charts are refreshed. */
  private metricsUid?: string;

  constructor(private readonly d: PanelDeps) {}

  get context(): string {
    return this.d.context;
  }

  get target(): ClusterTarget {
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
        if (this.pendingReveal) this.reveal(this.pendingReveal);
        break;
      case "refresh":
        host.refresh(context);
        break;
      case "setNamespaces":
        host.setNamespaces(context, msg.namespaces);
        break;
      case "showDetails":
        this.selected = msg.ref;
        this.shownVersion = undefined;
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

  /** Shows an object in the drawer (e.g. opened from the Fleet tab). */
  reveal(ref: ResourceRef): void {
    if (!this.ready) {
      this.pendingReveal = ref;
      return;
    }
    this.pendingReveal = undefined;
    this.d.host.post({ type: "reveal", ref });
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
    // Every row offers other actions: send them all again.
    this.resetRows();
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
    clearInterval(this.detailsTick);
    this.detailsTick = undefined;
    this.stopMetrics();
  }

  private resetRows(): void {
    this.sentRows = new Map();
    this.rowsSent = false;
    this.sentStatus = "";
  }

  /** (Re)subscribes to the store, only while the tab is visible and its webview ready. */
  private resubscribe(): void {
    this.unsubscribe();
    if (!this.visible || !this.ready) return;
    const { store, registry, context, target } = this.d;
    const namespaces = this.d.namespaces.selected;
    this.detailsTick = setInterval(() => this.selected && this.scheduleDetails(), DETAILS_REFRESH_MS);
    if (target.kind === "list") {
      const desc = registry.require(target.resource);
      this.rowContext = { related: {} };
      this.resetRows();
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
      const kind = page.metadataOnly?.includes(desc.id) ? { ...desc, metadataOnly: true } : desc;
      this.subscriptions.push(
        store.watch({ context, kind, namespaces: this.d.namespaces.selected }, (snap) => {
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
      const { rows, upsert, remove } = this.diffRows(snap.items, desc);
      const status = { loading: snap.loading, error: snap.error, live: snap.live };
      const statusKey = JSON.stringify(status);
      // A patch as large as the list is no cheaper than the list.
      if (!this.rowsSent || upsert.length + remove.length > rows.length / 2) this.d.host.post({ type: "rows", rows, ...status });
      else if (upsert.length || remove.length || statusKey !== this.sentStatus)
        this.d.host.post({ type: "rowsPatch", upsert, remove, ...status });
      this.rowsSent = true;
      this.sentStatus = statusKey;
      if (!snap.loading) this.detailsMayHaveChanged();
    });
  }

  /** The rows of the objects, rebuilding only those whose object or related objects changed. */
  private diffRows(items: KubeObject[], desc: ResourceDescriptor): { rows: Row[]; upsert: Row[]; remove: string[] } {
    const next = new Map<string, SentRow>();
    const upsert: Row[] = [];
    for (const o of items) {
      const key = objectKey(o);
      const related = desc.related.map((id) => relatedOf(this.rowContext, id, o));
      const prev = this.sentRows.get(key);
      if (prev && sameVersion(prev.obj, o) && related.every((r, i) => r === prev.related[i])) {
        next.set(key, prev);
        continue;
      }
      const built = this.allowedRow(desc.toRow(o, this.rowContext));
      const row = built.uid ? built : { ...built, uid: key };
      const json = JSON.stringify(row);
      // Rebuilt but identical (e.g. new metrics, same rounded values): nothing to send.
      if (prev?.json === json) next.set(key, { ...prev, obj: o, related });
      else {
        next.set(key, { obj: o, related, json, row });
        upsert.push(row);
      }
    }
    const remove: string[] = [];
    for (const [key, sent] of this.sentRows) if (!next.has(key)) remove.push(sent.row.uid);
    this.sentRows = next;
    return { rows: [...next.values()].map((s) => s.row), upsert, remove };
  }

  /**
   * The object shown in the drawer, from the lists this tab follows: undefined when they do not include it (another
   * kind or namespace), null when it is gone.
   */
  private localObject(ref: ResourceRef): KubeObject | null | undefined {
    const { target } = this.d;
    // A list of which the page reads the metadata only cannot fill a drawer.
    const partial = target.kind === "overview" && this.page().metadataOnly?.includes(ref.resource);
    const snap =
      target.kind === "list"
        ? target.resource === ref.resource
          ? this.lastSnapshot
          : undefined
        : partial
          ? undefined
          : this.overviewLists.get(ref.resource);
    if (!snap) return undefined;
    const selected = this.d.namespaces.selected;
    if (this.d.registry.get(ref.resource)?.namespaced && ref.namespace && selected.length && !selected.includes(ref.namespace))
      return undefined;
    const found = snap.items.find((o) => o.metadata.name === ref.name && o.metadata.namespace === ref.namespace);
    if (found) return found;
    return snap.loading || snap.error ? undefined : null;
  }

  /** A list changed: refreshes the details if the object they show changed (or is gone). */
  private detailsMayHaveChanged(): void {
    if (!this.selected) return;
    const obj = this.localObject(this.selected);
    // Not followed here: the periodic refresh keeps the drawer current. Without resourceVersion (Helm releases, port
    // forwards), a change cannot be told apart: refresh.
    if (obj === undefined) return;
    if (obj && !obj.metadata.resourceVersion) this.scheduleDetails();
    else if (detailsVersion(obj) !== this.shownVersion) this.scheduleDetails();
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
      if (!loading) this.detailsMayHaveChanged();
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
    // Followed by a list of this tab: no need to ask the cluster.
    const local = this.localObject(ref);
    if (local !== undefined) return local ?? undefined;
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
      this.shownVersion = detailsVersion(obj ?? null);
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
