// Follows a list the way Kubernetes clients do (an informer): one full list, then a watch from its resourceVersion.
// When the server ends the watch (every few minutes), the next one starts where it stopped: no list again. Only an
// expired resourceVersion (410 Gone) lists again. Errors are retried with a growing delay.
// Browser-safe, unit tested with a fake source.

import { ApiError, type ApiWatchEvent, FALLBACK } from "./api";
import type { InformHandlers, Informing, Stoppable } from "./client";
import { errorMessage, type KubeObject } from "./types";

export interface InformerSource {
  list(): Promise<{ items: KubeObject[]; resourceVersion?: string }>;
  watch(
    resourceVersion: string,
    timeoutSeconds: number,
    onEvent: (type: ApiWatchEvent, obj: KubeObject) => void,
    onEnd: (error?: ApiError) => void,
  ): Stoppable;
}

export interface InformerOptions {
  /** First delay before trying again after an error, doubled at each failure up to MAX_RETRY_MS. */
  retryMs?: number;
  random?: () => number;
  now?: () => number;
}

const MAX_RETRY_MS = 60_000;
/** Watches last between 5 and 10 minutes (like client-go), so that the watches of many lists do not end together. */
const MIN_WATCH_SECONDS = 300;
/** A watch that ends that fast without an event, three times in a row, is treated as an error. */
const QUICK_END_MS = 1_000;
const MAX_QUICK_ENDS = 3;

export class Informer implements Informing {
  private resourceVersion?: string;
  private stream?: Stoppable;
  /** The watch in progress: the end of an older one is ignored. */
  private current?: object;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failures = 0;
  private quickEnds = 0;
  /** Bumped by every new list: an obsolete one is ignored. */
  private generation = 0;

  constructor(
    private readonly source: InformerSource,
    private readonly h: InformHandlers,
    private readonly opts: InformerOptions = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    void this.relist();
  }

  /** Lists again now (the Refresh button). */
  resync(): void {
    void this.relist();
  }

  stop(): void {
    this.stopped = true;
    this.halt();
  }

  private halt(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.current = undefined;
    this.stream?.stop();
    this.stream = undefined;
  }

  private retry(fn: () => void): void {
    const delay = Math.min(MAX_RETRY_MS, (this.opts.retryMs ?? 5_000) * 2 ** this.failures);
    this.failures++;
    this.timer = setTimeout(fn, delay);
  }

  private fail(err: unknown, retry: () => void): void {
    if (err instanceof ApiError && err.reason === FALLBACK) return this.h.unsupported({ watch: false, message: err.message });
    this.h.status(false, errorMessage(err));
    this.retry(retry);
  }

  private async relist(): Promise<void> {
    if (this.stopped) return;
    this.halt();
    const generation = ++this.generation;
    try {
      const { items, resourceVersion } = await this.source.list();
      if (this.stopped || generation !== this.generation) return;
      this.failures = 0;
      this.h.sync(items);
      // Without a resourceVersion there is nothing to watch from: the owner polls.
      if (!resourceVersion) this.h.unsupported({ watch: true, message: "the list has no resourceVersion" });
      else this.watch(resourceVersion);
    } catch (err) {
      if (this.stopped || generation !== this.generation) return;
      this.fail(err, () => void this.relist());
    }
  }

  private watch(resourceVersion: string): void {
    this.resourceVersion = resourceVersion;
    const started = this.now();
    let events = 0;
    const timeout = Math.round(MIN_WATCH_SECONDS * (1 + (this.opts.random ?? Math.random)()));
    const current = {};
    this.current = current;
    const stream = this.source.watch(
      resourceVersion,
      timeout,
      (type, obj) => {
        if (this.current !== current) return;
        events++;
        this.failures = 0;
        if (obj.metadata.resourceVersion) this.resourceVersion = obj.metadata.resourceVersion;
        if (type !== "BOOKMARK") this.h.event(type, obj);
      },
      (error) => {
        if (this.current !== current || this.stopped) return;
        this.current = undefined;
        this.stream = undefined;
        if (!error) {
          // Ended by the server: go on from where it stopped, unless it keeps ending at once.
          this.quickEnds = this.now() - started < QUICK_END_MS && !events ? this.quickEnds + 1 : 0;
          if (this.quickEnds < MAX_QUICK_ENDS) return this.watch(this.resourceVersion!);
          this.quickEnds = 0;
          error = new ApiError("the watch keeps ending at once");
        }
        // Too old to go on from: list again.
        if (error.status === 410) return void this.relist();
        // The kind cannot be watched (metrics.k8s.io): the owner polls it.
        if (error.status === 405) return this.h.unsupported({ watch: true, message: error.message });
        this.fail(error, () => this.watch(this.resourceVersion!));
      },
    );
    // Unless it already ended.
    if (this.current !== current) return;
    this.stream = stream;
    this.h.status(true);
  }
}
