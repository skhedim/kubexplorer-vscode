// List cache shared by every tab. One entry per (context, kind, namespaces): it lives while it has at
// least one subscriber, then LINGER_MS more (its watch running, no list), so that a tab shown again, or a list opened
// again, is there at once; then it stops.
//
// Updates, by order of preference:
// - an informer of the client (one list, then a watch from its resourceVersion, over the kubectl proxy of the cluster);
// - otherwise a `kubectl get --watch` (real time), started *before* a full list so that no change falls in between,
//   plus a periodic full resync for safety;
// - without a watch (demo cluster, virtual lists, APIs that refuse watches), the list is polled.

import type { Informing, KubeClient, Stoppable } from "./client";
import { type Disposable, errorMessage, type KindTarget, type KubeObject, type Logger } from "./types";

export interface Snapshot {
  items: KubeObject[];
  loading: boolean;
  error?: string;
  updatedAt?: number;
  /** True while the list is followed in real time. */
  live?: boolean;
}

export interface StoreKey {
  context: string;
  kind: KindTarget;
  namespaces: string[];
}

export interface StoreOptions {
  pollIntervalMs: () => number;
  /** Full list while a watch runs, to heal anything a watch could have missed. */
  resyncMs?: number;
  /** Bursts of watch events are coalesced into one update. */
  debounceMs?: number;
  /** An entry without subscribers is kept that long (0: stopped at once). */
  lingerMs?: number;
}

type Listener = (snapshot: Snapshot) => void;

interface Entry {
  key: StoreKey;
  listeners: Set<Listener>;
  snapshot: Snapshot;
  objects: Map<string, KubeObject>;
  timer?: ReturnType<typeof setTimeout>;
  emitTimer?: ReturnType<typeof setTimeout>;
  watch?: Stoppable;
  informer?: Informing;
  /** The client has no informer for this list: list and watch it. */
  noInform: boolean;
  /** The client cannot watch this kind: poll for good. */
  noWatch: boolean;
  /** Consecutive immediate watch failures (e.g. metrics.k8s.io, which refuses watches). */
  watchFailures: number;
  /** Watch events received while a list is in flight (null = deleted), merged when it completes. */
  touched?: Map<string, KubeObject | null>;
  inFlight: boolean;
  /** Bumped by forced refreshes: invalidates an obsolete in-flight list. */
  generation: number;
  disposed: boolean;
  /** Pending end of an entry without subscribers. */
  lingerTimer?: ReturnType<typeof setTimeout>;
  /** A list was due while the entry had no subscribers: done when one comes back. */
  stale: boolean;
}

/** An object key: its uid, or namespace/name for objects without uid (metrics-server objects). */
function objectKey(o: KubeObject): string {
  return o.metadata.uid || `${o.metadata.namespace ?? ""}/${o.metadata.name}`;
}

function storeKeyId(k: StoreKey): string {
  const ns = k.kind.namespaced ? [...k.namespaces].sort().join(",") : "";
  return `${k.context}|${k.kind.kubectlName}${k.kind.metadataOnly ? "#metadata" : ""}|${ns}`;
}

/** True when a is at least as recent as b (resourceVersion is numeric in practice; otherwise a wins). */
function isNewer(a: KubeObject, b: KubeObject): boolean {
  const ra = Number(a.metadata.resourceVersion);
  const rb = Number(b.metadata.resourceVersion);
  return !(Number.isFinite(ra) && Number.isFinite(rb)) || ra >= rb;
}

const IMMEDIATE_FAILURE_MS = 5_000;
const MAX_IMMEDIATE_FAILURES = 2;

export class ResourceStore implements Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: Required<StoreOptions>;

  constructor(
    private readonly client: KubeClient,
    opts: StoreOptions,
    private readonly log: Logger,
  ) {
    this.opts = { resyncMs: 5 * 60_000, debounceMs: 100, lingerMs: 30_000, ...opts };
  }

  /** Subscribes to a list. The listener receives the current state right away, then every update. */
  watch(key: StoreKey, listener: Listener): Disposable {
    const id = storeKeyId(key);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        key,
        listeners: new Set(),
        snapshot: { items: [], loading: true },
        objects: new Map(),
        noInform: false,
        noWatch: false,
        watchFailures: 0,
        inFlight: false,
        generation: 0,
        disposed: false,
        stale: true,
      };
      this.entries.set(id, entry);
    }
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = undefined;
    entry.listeners.add(listener);
    listener(entry.snapshot);
    // A new entry, or one that missed a list while it had no subscribers.
    if (entry.listeners.size === 1 && entry.stale) this.start(entry);
    const e = entry;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        e.listeners.delete(listener);
        if (e.listeners.size || e.disposed) return;
        if (this.opts.lingerMs > 0) e.lingerTimer = setTimeout(() => this.close(id, e), this.opts.lingerMs);
        else this.close(id, e);
      },
    };
  }

  /** Forces an immediate full list (after an action, or the Refresh button). */
  refresh(context?: string): void {
    for (const entry of this.entries.values()) {
      if (context && entry.key.context !== context) continue;
      if (entry.informer) {
        entry.informer.resync();
        continue;
      }
      entry.generation++;
      entry.inFlight = false;
      void this.list(entry);
    }
  }

  /** Lists kept for subscribers to come (see LINGER_MS above), for tests and diagnostics. */
  lingering(): number {
    return [...this.entries.values()].filter((e) => !e.listeners.size).length;
  }

  dispose(): void {
    for (const [id, e] of this.entries) this.close(id, e);
  }

  private close(id: string, e: Entry): void {
    e.disposed = true;
    clearTimeout(e.timer);
    clearTimeout(e.emitTimer);
    clearTimeout(e.lingerTimer);
    e.watch?.stop();
    e.informer?.stop();
    if (this.entries.get(id) === e) this.entries.delete(id);
  }

  /** Starts following a list: with an informer of the client when it has one, else by listing it. */
  private start(e: Entry): void {
    if (e.informer) return;
    if (e.noInform || !this.client.inform) return void this.list(e);
    const { context, kind, namespaces } = e.key;
    const informer = this.client.inform(
      context,
      kind,
      { namespaces },
      {
        sync: (items) => {
          if (e.informer !== informer) return;
          clearTimeout(e.emitTimer);
          e.objects = new Map(items.map((o) => [objectKey(o), o]));
          this.emit(e, { loading: false, error: undefined, updatedAt: Date.now() });
        },
        event: (type, obj) => {
          if (e.informer !== informer) return;
          const key = objectKey(obj);
          if (type === "DELETED") e.objects.delete(key);
          else e.objects.set(key, obj);
          clearTimeout(e.emitTimer);
          e.emitTimer = setTimeout(() => this.emit(e, { updatedAt: Date.now(), error: undefined }), this.opts.debounceMs);
        },
        status: (live, error) => {
          if (e.informer !== informer) return;
          if (error) this.log.warn(`Following ${kind.kubectlName} (${context}) failed: ${error}`);
          // Followed again: the error is over.
          this.emit(e, error ? { live, error, loading: false } : { live, error: live ? undefined : e.snapshot.error });
        },
        unsupported: ({ watch, message }) => {
          if (e.informer !== informer) return;
          informer?.stop();
          e.informer = undefined;
          e.noInform = true;
          e.noWatch ||= watch;
          this.log.info(`${kind.kubectlName} (${context}): ${message}; ${watch ? "polling" : "listing with kubectl"} instead`);
          void this.list(e);
        },
      },
    );
    if (!informer) {
      e.noInform = true;
      return void this.list(e);
    }
    e.informer = informer;
    e.stale = false;
  }

  /** The poll interval of a list: the setting, but never below the floor of its kind. */
  private pollIntervalMs(e: Entry): number {
    return Math.max(this.opts.pollIntervalMs(), e.key.kind.minPollIntervalMs ?? 0);
  }

  private schedule(e: Entry, delayMs: number): void {
    clearTimeout(e.timer);
    e.timer = setTimeout(() => void this.list(e), delayMs);
  }

  private emit(e: Entry, patch: Partial<Snapshot>): void {
    e.snapshot = { ...e.snapshot, ...patch, items: [...e.objects.values()] };
    for (const listener of e.listeners) listener(e.snapshot);
  }

  private async list(e: Entry): Promise<void> {
    if (e.inFlight || e.disposed) return;
    clearTimeout(e.timer);
    // Nobody looks: no list (its watch, if any, keeps it current); one is done when a subscriber comes back.
    if (!e.listeners.size) {
      e.stale = true;
      return;
    }
    e.stale = false;
    e.inFlight = true;
    const generation = e.generation;
    const { context, kind, namespaces } = e.key;
    this.startWatch(e);
    e.touched = new Map();
    try {
      const items = await this.client.list(context, kind, { namespaces });
      if (generation !== e.generation || e.disposed) return;
      const next = new Map(items.map((o) => [objectKey(o), o]));
      for (const [key, o] of e.touched) {
        if (o === null) next.delete(key);
        else if (!next.has(key) || isNewer(o, next.get(key)!)) next.set(key, o);
      }
      e.objects = next;
      this.emit(e, { loading: false, error: undefined, updatedAt: Date.now(), live: !!e.watch });
      this.schedule(e, e.watch ? this.opts.resyncMs : this.pollIntervalMs(e));
    } catch (err) {
      if (generation !== e.generation || e.disposed) return;
      const error = errorMessage(err);
      this.log.warn(`Listing ${kind.kubectlName} (${context}) failed: ${error}`);
      // Keep the last known items: a network hiccup does not empty the screen.
      this.emit(e, { loading: false, error, live: false });
      this.schedule(e, this.pollIntervalMs(e));
    } finally {
      if (generation === e.generation) {
        e.inFlight = false;
        e.touched = undefined;
      }
    }
  }

  private startWatch(e: Entry): void {
    if (e.watch || e.noWatch || !this.client.watch) return;
    const { context, kind, namespaces } = e.key;
    const startedAt = Date.now();
    const handle = this.client.watch(
      context,
      kind,
      { namespaces },
      (type, obj) => {
        const key = objectKey(obj);
        if (type === "DELETED") e.objects.delete(key);
        else e.objects.set(key, obj);
        e.touched?.set(key, type === "DELETED" ? null : obj);
        clearTimeout(e.emitTimer);
        e.emitTimer = setTimeout(() => this.emit(e, { updatedAt: Date.now(), error: undefined }), this.opts.debounceMs);
      },
      (error) => {
        if (e.disposed || e.watch !== handle) return;
        e.watch = undefined;
        e.watchFailures = error && Date.now() - startedAt < IMMEDIATE_FAILURE_MS ? e.watchFailures + 1 : 0;
        if (e.watchFailures >= MAX_IMMEDIATE_FAILURES) {
          e.noWatch = true;
          this.log.info(`${kind.kubectlName} (${context}) cannot be watched: polling every ${this.pollIntervalMs(e) / 1000} s`);
        } else {
          this.log.info(`Watch of ${kind.kubectlName} (${context}) ended${error ? `: ${error}` : ""}; resuming with a full list`);
        }
        this.emit(e, { live: false });
        // A list in flight schedules the next one itself. Otherwise: full list (catches up), then a new watch.
        if (!e.inFlight) this.schedule(e, error ? this.pollIntervalMs(e) : 0);
      },
    );
    if (handle) e.watch = handle;
    else e.noWatch = true;
  }
}
