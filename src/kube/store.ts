// List cache shared by every tab. One entry per (context, kind, namespaces): it lives while it has at
// least one subscriber, then stops.
//
// Updates: a `kubectl get --watch` (real time) when the client supports it, started *before* a full
// list so that no change falls in between, plus a periodic full resync for safety. Without a watch
// (demo cluster, virtual lists, APIs that refuse watches), the list is polled instead.

import type { KubeClient, Stoppable } from "./client";
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
}

/** An object key: its uid, or namespace/name for objects without uid (metrics-server objects). */
function objectKey(o: KubeObject): string {
  return o.metadata.uid || `${o.metadata.namespace ?? ""}/${o.metadata.name}`;
}

function storeKeyId(k: StoreKey): string {
  const ns = k.kind.namespaced ? [...k.namespaces].sort().join(",") : "";
  return `${k.context}|${k.kind.kubectlName}|${ns}`;
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
    this.opts = { resyncMs: 5 * 60_000, debounceMs: 100, ...opts };
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
        noWatch: false,
        watchFailures: 0,
        inFlight: false,
        generation: 0,
        disposed: false,
      };
      this.entries.set(id, entry);
    }
    entry.listeners.add(listener);
    listener(entry.snapshot);
    if (entry.listeners.size === 1) void this.list(entry);
    const e = entry;
    return {
      dispose: () => {
        e.listeners.delete(listener);
        if (e.listeners.size === 0) this.close(id, e);
      },
    };
  }

  /** Forces an immediate full list (after an action, or the Refresh button). */
  refresh(context?: string): void {
    for (const entry of this.entries.values()) {
      if (context && entry.key.context !== context) continue;
      entry.generation++;
      entry.inFlight = false;
      void this.list(entry);
    }
  }

  dispose(): void {
    for (const [id, e] of this.entries) this.close(id, e);
  }

  private close(id: string, e: Entry): void {
    e.disposed = true;
    clearTimeout(e.timer);
    clearTimeout(e.emitTimer);
    e.watch?.stop();
    this.entries.delete(id);
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
