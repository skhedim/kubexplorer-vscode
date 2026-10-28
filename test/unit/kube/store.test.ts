import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeClient, WatchEventType } from "../../../src/kube/client";
import { ResourceStore, type Snapshot } from "../../../src/kube/store";
import { type KubeObject, nullLogger } from "../../../src/kube/types";

const pods = { kubectlName: "pods", namespaced: true };
const obj = (name: string, resourceVersion = "1"): KubeObject => ({ metadata: { name, uid: name, resourceVersion } });
const key = { context: "c", kind: pods, namespaces: [] };

type Emit = (type: WatchEventType, o: KubeObject) => void;

function pollingClient(list: KubeClient["list"]): KubeClient {
  return { list } as KubeClient;
}

function watchingClient(initial: () => KubeObject[] | Promise<KubeObject[]>) {
  const watchers: { emit: Emit; end: (error?: string) => void; stopped: boolean }[] = [];
  const list = vi.fn(async () => initial());
  const client = {
    list,
    watch: (_context: string, _kind: unknown, _opts: unknown, emit: Emit, end: (error?: string) => void) => {
      const watcher = { emit, end, stopped: false };
      watchers.push(watcher);
      return { stop: () => (watcher.stopped = true) };
    },
  } as unknown as KubeClient;
  return { client, list, watchers };
}

describe("ResourceStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe("polling", () => {
    it("shares one list between subscribers and repeats it", async () => {
      const list = vi.fn(async () => [obj("a")]);
      const store = new ResourceStore(pollingClient(list), { pollIntervalMs: () => 5000 }, nullLogger);
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s));
      store.watch(key, () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(1);
      expect(seen.at(-1)).toMatchObject({ loading: false, live: false, items: [obj("a")] });
      await vi.advanceTimersByTimeAsync(5000);
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("never polls a kind more often than its floor (metrics, Helm), whatever the setting", async () => {
      const list = vi.fn(async () => [obj("a")]);
      const store = new ResourceStore(pollingClient(list), { pollIntervalMs: () => 5000 }, nullLogger);
      store.watch({ ...key, kind: { kubectlName: "pods.metrics.k8s.io", namespaced: true, minPollIntervalMs: 15_000 } }, () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(list).toHaveBeenCalledTimes(2);
      // A longer setting still wins over the floor.
      const slow = vi.fn(async () => []);
      const slowStore = new ResourceStore(pollingClient(slow), { pollIntervalMs: () => 30_000 }, nullLogger);
      slowStore.watch(
        { ...key, kind: { kubectlName: "pods.metrics.k8s.io", namespaced: true, minPollIntervalMs: 15_000 } },
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(29_999);
      expect(slow).toHaveBeenCalledTimes(1);
    });

    it("stops when the last subscriber leaves", async () => {
      const list = vi.fn(async () => []);
      const store = new ResourceStore(pollingClient(list), { pollIntervalMs: () => 1000 }, nullLogger);
      const subscription = store.watch(key, () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      subscription.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(list).toHaveBeenCalledTimes(1);
    });

    it("keeps the last known items on errors", async () => {
      let fail = false;
      const store = new ResourceStore(
        pollingClient(async () => {
          if (fail) throw new Error("connection refused");
          return [obj("a")];
        }),
        { pollIntervalMs: () => 1000 },
        nullLogger,
      );
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s));
      await vi.advanceTimersByTimeAsync(0);
      fail = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(seen.at(-1)).toMatchObject({ error: "connection refused", items: [obj("a")] });
    });

    it("tells namespace filters apart, regardless of their order", async () => {
      const list = vi.fn(async () => []);
      const store = new ResourceStore(pollingClient(list), { pollIntervalMs: () => 1000 }, nullLogger);
      store.watch({ ...key, namespaces: ["a", "b"] }, () => undefined);
      store.watch({ ...key, namespaces: ["b", "a"] }, () => undefined);
      store.watch({ ...key, namespaces: ["a"] }, () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("keeps objects without uid apart (metrics-server objects)", async () => {
      const metric = (namespace: string, name: string): KubeObject => ({ metadata: { name, namespace } as KubeObject["metadata"] });
      const store = new ResourceStore(
        pollingClient(async () => [metric("a", "p1"), metric("a", "p2"), metric("b", "p1")]),
        { pollIntervalMs: () => 5000 },
        nullLogger,
      );
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.at(-1)!.items).toHaveLength(3);
    });
  });

  describe("real time", () => {
    it("applies watch events without listing again", async () => {
      const { client, list, watchers } = watchingClient(() => [obj("a")]);
      const store = new ResourceStore(client, { pollIntervalMs: () => 5000, debounceMs: 50 }, nullLogger);
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.at(-1)).toMatchObject({ live: true, loading: false });

      watchers[0].emit("ADDED", obj("b"));
      watchers[0].emit("MODIFIED", obj("a", "2"));
      await vi.advanceTimersByTimeAsync(50);
      expect(
        seen
          .at(-1)!
          .items.map((o) => o.metadata.name)
          .sort(),
      ).toEqual(["a", "b"]);

      watchers[0].emit("DELETED", obj("a"));
      await vi.advanceTimersByTimeAsync(50);
      expect(seen.at(-1)!.items.map((o) => o.metadata.name)).toEqual(["b"]);
      // No polling during a watch, only the 5-minute resync.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(list).toHaveBeenCalledTimes(1);
    });

    it("starts the watch before the list and keeps the most recent version", async () => {
      let resolveList!: (items: KubeObject[]) => void;
      const { client, watchers } = watchingClient(() => new Promise((resolve) => (resolveList = resolve)));
      const store = new ResourceStore(client, { pollIntervalMs: () => 5000, debounceMs: 10 }, nullLogger);
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s));
      await vi.advanceTimersByTimeAsync(0);
      expect(watchers).toHaveLength(1);
      // While listing: one object created, one modified, one deleted.
      watchers[0].emit("ADDED", obj("new", "10"));
      watchers[0].emit("MODIFIED", obj("a", "9"));
      watchers[0].emit("DELETED", obj("gone", "11"));
      resolveList([obj("a", "5"), obj("gone", "5")]);
      await vi.advanceTimersByTimeAsync(20);
      const items = seen.at(-1)!.items;
      expect(items.map((o) => o.metadata.name).sort()).toEqual(["a", "new"]);
      expect(items.find((o) => o.metadata.name === "a")!.metadata.resourceVersion).toBe("9");
    });

    it("resumes with a full list when the watch ends", async () => {
      const { client, list, watchers } = watchingClient(() => [obj("a")]);
      const store = new ResourceStore(client, { pollIntervalMs: () => 5000, debounceMs: 10 }, nullLogger);
      store.watch(key, () => undefined);
      await vi.advanceTimersByTimeAsync(10_000);
      watchers[0].end(); // normal end (server-side timeout)
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(2);
      expect(watchers).toHaveLength(2);
    });

    it("falls back to polling when watches fail right away (metrics API)", async () => {
      const { client, list, watchers } = watchingClient(() => [obj("a")]);
      const store = new ResourceStore(client, { pollIntervalMs: () => 5000, debounceMs: 10 }, nullLogger);
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s));
      await vi.advanceTimersByTimeAsync(0);
      watchers[0].end("the server does not allow this method on the requested resource");
      await vi.advanceTimersByTimeAsync(5000);
      watchers[1].end("the server does not allow this method on the requested resource");
      await vi.advanceTimersByTimeAsync(5000);
      expect(watchers).toHaveLength(2);
      const calls = list.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(list.mock.calls.length).toBe(calls + 3);
      expect(seen.at(-1)!.live).toBe(false);
    });

    it("stops the watch when the last subscriber leaves", async () => {
      const { client, watchers } = watchingClient(() => []);
      const store = new ResourceStore(client, { pollIntervalMs: () => 5000 }, nullLogger);
      const subscription = store.watch(key, () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      subscription.dispose();
      expect(watchers[0].stopped).toBe(true);
    });
  });
});
