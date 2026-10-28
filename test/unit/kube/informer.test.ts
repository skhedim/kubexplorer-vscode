import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiWatchEvent, FALLBACK } from "../../../src/kube/api";
import type { InformHandlers } from "../../../src/kube/client";
import { Informer, type InformerSource } from "../../../src/kube/informer";
import type { KubeObject } from "../../../src/kube/types";

const obj = (name: string, resourceVersion: string): KubeObject => ({ metadata: { name, uid: name, resourceVersion } });

interface Watch {
  resourceVersion: string;
  emit: (type: ApiWatchEvent, o: KubeObject) => void;
  end: (error?: ApiError) => void;
  stopped: boolean;
}

function setup(list: () => Promise<{ items: KubeObject[]; resourceVersion?: string }>) {
  const watches: Watch[] = [];
  const source: InformerSource = {
    list: vi.fn(list),
    watch: (resourceVersion, _timeout, emit, end) => {
      const w = { resourceVersion, emit, end, stopped: false };
      watches.push(w);
      return { stop: () => (w.stopped = true) };
    },
  };
  const h = { sync: vi.fn(), event: vi.fn(), status: vi.fn(), unsupported: vi.fn() } satisfies InformHandlers;
  const informer = new Informer(source, h, { retryMs: 1000, random: () => 0 });
  informer.start();
  return { informer, source, watches, h };
}

describe("Informer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lists, then watches from the resourceVersion of the list", async () => {
    const { watches, h } = setup(async () => ({ items: [obj("a", "5")], resourceVersion: "10" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sync).toHaveBeenCalledWith([obj("a", "5")]);
    expect(watches.map((w) => w.resourceVersion)).toEqual(["10"]);
    expect(h.status).toHaveBeenLastCalledWith(true);
    watches[0].emit("MODIFIED", obj("a", "11"));
    expect(h.event).toHaveBeenCalledWith("MODIFIED", obj("a", "11"));
  });

  it("goes on from where a watch ended, without listing again (bookmarks included)", async () => {
    const { watches, source, h } = setup(async () => ({ items: [], resourceVersion: "10" }));
    await vi.advanceTimersByTimeAsync(0);
    watches[0].emit("ADDED", obj("a", "12"));
    watches[0].emit("BOOKMARK", { metadata: { name: "", uid: "", resourceVersion: "20" } });
    vi.setSystemTime(Date.now() + 300_000);
    watches[0].end();
    expect(watches.map((w) => w.resourceVersion)).toEqual(["10", "20"]);
    expect(source.list).toHaveBeenCalledTimes(1);
    expect(h.event).toHaveBeenCalledTimes(1);
  });

  it("lists again when the resourceVersion expired", async () => {
    let rv = 10;
    const { watches, h } = setup(async () => ({ items: [obj(`v${rv}`, String(rv))], resourceVersion: String(rv++) }));
    await vi.advanceTimersByTimeAsync(0);
    watches[0].end(new ApiError("too old resource version", 410, "Expired"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sync).toHaveBeenLastCalledWith([obj("v11", "11")]);
    expect(watches.map((w) => w.resourceVersion)).toEqual(["10", "11"]);
  });

  it("hands over a kind that cannot be watched (metrics.k8s.io), and a cluster without proxy", async () => {
    const metrics = setup(async () => ({ items: [], resourceVersion: "1" }));
    await vi.advanceTimersByTimeAsync(0);
    metrics.watches[0].end(new ApiError("the server does not allow this method on the requested resource", 405, "MethodNotAllowed"));
    expect(metrics.h.unsupported).toHaveBeenCalledWith({ watch: true, message: expect.stringContaining("does not allow") });

    const noProxy = setup(async () => {
      throw new ApiError("kubectl proxy did not start", undefined, FALLBACK);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(noProxy.h.unsupported).toHaveBeenCalledWith({ watch: false, message: "kubectl proxy did not start" });
    expect(noProxy.h.status).not.toHaveBeenCalled();
  });

  it("reports errors and tries again later, waiting longer each time", async () => {
    const { source, h, watches } = setup(async () => {
      throw new ApiError("connection refused");
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status).toHaveBeenLastCalledWith(false, "connection refused");
    await vi.advanceTimersByTimeAsync(999);
    expect(source.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(source.list).toHaveBeenCalledTimes(2);
    vi.mocked(source.list).mockResolvedValue({ items: [], resourceVersion: "3" });
    await vi.advanceTimersByTimeAsync(1);
    expect(source.list).toHaveBeenCalledTimes(3);
    expect(h.sync).toHaveBeenCalledWith([]);
    // A broken watch: watched again from the same resourceVersion, after a delay.
    watches[0].end(new ApiError("unexpected EOF"));
    expect(h.status).toHaveBeenLastCalledWith(false, "unexpected EOF");
    await vi.advanceTimersByTimeAsync(1000);
    expect(watches.map((w) => w.resourceVersion)).toEqual(["3", "3"]);
  });

  it("treats a watch that keeps ending at once as an error", async () => {
    const { watches, h } = setup(async () => ({ items: [], resourceVersion: "1" }));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) watches.at(-1)!.end();
    expect(watches).toHaveLength(3);
    expect(h.status).toHaveBeenLastCalledWith(false, "the watch keeps ending at once");
  });

  it("lists again on demand, and stays silent once stopped", async () => {
    const { informer, watches, source, h } = setup(async () => ({ items: [], resourceVersion: "1" }));
    await vi.advanceTimersByTimeAsync(0);
    informer.resync();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.list).toHaveBeenCalledTimes(2);
    expect(watches[0].stopped).toBe(true);
    informer.stop();
    expect(watches[1].stopped).toBe(true);
    watches[1].emit("ADDED", obj("late", "2"));
    watches[1].end(new ApiError("late"));
    expect(h.event).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalledWith(false, "late");
  });
});
