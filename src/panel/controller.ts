// Logic of one resource tab, independent from VS Code (unit tested, reused by the browser preview).
// The controller subscribes to the store while the tab is visible and pushes rows and details to the webview.

import type { KubeClient } from "../kube/client";
import type { HelmClient } from "../kube/helm";
import type { ResourceStore, Snapshot } from "../kube/store";
import { type Disposable, errorMessage, type KubeObject, type Logger } from "../kube/types";
import { type DetailContext, indexRelated, type RowContext } from "../resources/descriptor";
import { buildOverview, OVERVIEW_RESOURCES, type OverviewResource } from "../resources/overview";
import type { ResourceRegistry } from "../resources/registry";
import { decodeBase64 } from "../shared/encoding";
import type { Appearance, HostMessage, NamespaceFilter, PanelTarget, ViewInit, WebviewMessage } from "../shared/protocol";
import type { ActionId, ResourceRef } from "../shared/view";

/** What the controller delegates to its host (VS Code: dialogs, terminals, commands). */
export interface PanelHost {
  post(msg: HostMessage): void;
  runAction(context: string, action: ActionId, ref: ResourceRef, container?: string): void;
  rowMenu(context: string, ref: ResourceRef, actions: ActionId[]): void;
  deleteMany(context: string, refs: ResourceRef[]): void;
  openResource(context: string, resource: string): void;
  setNamespaces(context: string, namespaces: string[]): void;
  refresh(context: string): void;
  copyText(text: string): void;
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
}

/** Refresh of the displayed ages: with a watch, a list only changes when the cluster does. */
const AGE_TICK_MS = 30_000;
/** Automatic refresh of the details (which may query the cluster), at most once every… */
const DETAILS_THROTTLE_MS = 2_000;

export class PanelController implements Disposable {
  private subscriptions: Disposable[] = [];
  private visible = false;
  private ready = false;
  private selected: ResourceRef | null = null;
  private detailsGeneration = 0;
  private lastSnapshot?: Snapshot;
  private rowContext: RowContext = { related: {} };
  private readonly overviewLists: Partial<Record<OverviewResource, Snapshot>> = {};
  private overviewQueued = false;
  private rowsQueued = false;
  private tick?: ReturnType<typeof setInterval>;
  private detailsTimer?: ReturnType<typeof setTimeout>;
  private lastDetailsAt = 0;

  constructor(private readonly d: PanelDeps) {}

  get context(): string {
    return this.d.context;
  }

  get target(): PanelTarget {
    return this.d.target;
  }

  title(): string {
    return this.d.target.kind === "overview" ? "Overview" : this.d.registry.require(this.d.target.resource).title;
  }

  private init(): ViewInit {
    if (this.d.target.kind === "overview") return { mode: "overview", context: this.d.context, title: "Overview" };
    const desc = this.d.registry.require(this.d.target.resource);
    return {
      mode: "list",
      context: this.d.context,
      resource: desc.id,
      title: desc.title,
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
        void this.pushDetails();
        break;
      case "action":
        host.runAction(context, msg.action, msg.ref, msg.container);
        break;
      case "rowMenu":
        host.rowMenu(context, msg.ref, msg.actions);
        break;
      case "deleteMany":
        host.deleteMany(context, msg.refs);
        break;
      case "openResource":
        host.openResource(context, msg.resource);
        break;
      case "revealSecret":
        void this.revealSecret(msg.ref, msg.key);
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

  private unsubscribe(): void {
    for (const s of this.subscriptions) s.dispose();
    this.subscriptions = [];
    clearInterval(this.tick);
    this.tick = undefined;
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
            if (!snap.loading) this.queueRows();
          }),
        ),
      );
      this.tick = setInterval(() => this.queueRows(), AGE_TICK_MS);
    } else {
      for (const resource of OVERVIEW_RESOURCES) {
        const kind = registry.require(resource);
        this.subscriptions.push(
          store.watch({ context, kind, namespaces }, (snap) => {
            this.overviewLists[resource] = snap;
            this.queueOverview();
          }),
        );
      }
    }
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
        rows: snap.items.map((o) => desc.toRow(o, this.rowContext)),
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
      const lists: Partial<Record<OverviewResource, KubeObject[]>> = {};
      const errors: Partial<Record<OverviewResource, string>> = {};
      for (const r of OVERVIEW_RESOURCES) {
        const snap = this.overviewLists[r];
        if (snap) lists[r] = snap.items;
        if (snap?.error) errors[r] = snap.error;
      }
      const loading = OVERVIEW_RESOURCES.some((r) => !this.overviewLists[r] || this.overviewLists[r]!.loading);
      const live = OVERVIEW_RESOURCES.every((r) => this.overviewLists[r]?.live);
      this.d.host.post({ type: "overview", data: buildOverview({ lists, errors }), loading, error: errors.pods, live });
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
      const details = obj ? await desc.details(obj, this.detailContext()) : null;
      if (generation === this.detailsGeneration) this.d.host.post({ type: "details", details });
    } catch (err) {
      const error = errorMessage(err);
      this.d.log.warn(`Details of ${ref.resource}/${ref.name}: ${error}`);
      if (generation === this.detailsGeneration) this.d.host.post({ type: "details", details: null, error });
    }
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

  dispose(): void {
    this.unsubscribe();
    clearTimeout(this.detailsTimer);
  }
}
