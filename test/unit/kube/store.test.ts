import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InformHandlers, KubeClient, WatchEventType } from "../../../src/kube/client";
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
      const store = new ResourceStore(pollingClient(list), { pollIntervalMs: () => 1000, lingerMs: 0 }, nullLogger);
      const subscription = store.watch(key, () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      subscription.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(list).toHaveBeenCalledTimes(1);
    });

    it("keeps a list a while after its last subscriber, without polling it, and catches up when one comes back", async () => {
      let version = 1;
      const list = vi.fn(async () => [obj("a", String(version))]);
      const store = new ResourceStore(pollingClient(list), { pollIntervalMs: () => 1000, lingerMs: 30_000 }, nullLogger);
      store.watch(key, () => undefined).dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(1);
      expect(store.lingering()).toBe(1);
      // Nobody looks: no poll.
      version = 2;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(list).toHaveBeenCalledTimes(1);
      // Back: the last known items at once, then a list (a poll was missed).
      const seen: Snapshot[] = [];
      const back = store.watch(key, (s) => seen.push(s));
      expect(seen[0]).toMatchObject({ loading: false, items: [obj("a", "1")] });
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(2);
      expect(seen.at(-1)!.items).toEqual([obj("a", "2")]);
      back.dispose();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(store.lingering()).toBe(0);
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

    it("stops the watch a while after the last subscriber leaves", async () => {
      const { client, watchers } = watchingClient(() => []);
      const store = new ResourceStore(client, { pollIntervalMs: () => 5000, lingerMs: 30_000 }, nullLogger);
      const subscription = store.watch(key, () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      subscription.dispose();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(watchers[0].stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(watchers[0].stopped).toBe(true);
    });

    it("serves a list shown again from its watch, without listing it again", async () => {
      const { client, list, watchers } = watchingClient(() => [obj("a")]);
      const store = new ResourceStore(client, { pollIntervalMs: () => 5000, debounceMs: 10 }, nullLogger);
      store.watch(key, () => undefined).dispose();
      await vi.advanceTimersByTimeAsync(0);
      // A change while nobody looks: the watch follows it.
      watchers[0].emit("ADDED", obj("b"));
      await vi.advanceTimersByTimeAsync(10_000);
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s));
      await vi.advanceTimersByTimeAsync(100);
      expect(seen[0].items.map((o) => o.metadata.name).sort()).toEqual(["a", "b"]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(watchers).toHaveLength(1);
    });
  });

  describe("with an informer (kubectl proxy)", () => {
    function informingClient(list: () => KubeObject[] = () => [obj("polled")]) {
      const informers: { handlers: InformHandlers; stopped: boolean; resyncs: number }[] = [];
      const client = {
        list: vi.fn(async () => list()),
        inform: (_context: string, _kind: unknown, _opts: unknown, handlers: InformHandlers) => {
          const informer = { handlers, stopped: false, resyncs: 0 };
          informers.push(informer);
          return { stop: () => (informer.stopped = true), resync: () => informer.resyncs++ };
        },
      } as unknown as KubeClient;
      return { client, informers };
    }

    it("follows a list with the informer, without listing nor polling it", async () => {
      const { client, informers } = informingClient();
      const store = new ResourceStore(client, { pollIntervalMs: () => 1000, debounceMs: 10 }, nullLogger);
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s));
      const { handlers } = informers[0];
      handlers.sync([obj("a"), obj("b")]);
      handlers.status(true);
      handlers.event("DELETED", obj("a"));
      handlers.event("ADDED", obj("c"));
      await vi.advanceTimersByTimeAsync(10);
      expect(seen.at(-1)).toMatchObject({ loading: false, live: true });
      expect(seen.at(-1)!.items.map((o) => o.metadata.name)).toEqual(["b", "c"]);
      handlers.status(false, "connection refused");
      expect(seen.at(-1)).toMatchObject({ live: false, error: "connection refused" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.list).not.toHaveBeenCalled();
      // Refresh: the informer lists again.
      store.refresh();
      expect(informers[0].resyncs).toBe(1);
    });

    it("polls a list the informer cannot watch, and lists with kubectl one it cannot follow", async () => {
      const { client, informers } = informingClient();
      const store = new ResourceStore(client, { pollIntervalMs: () => 1000 }, nullLogger);
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s));
      informers[0].handlers.unsupported({ watch: true, message: "the list has no resourceVersion" });
      expect(informers[0].stopped).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.at(-1)).toMatchObject({ loading: false, live: false, items: [obj("polled")] });
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.list).toHaveBeenCalledTimes(2);
      expect(informers).toHaveLength(1);
      // A late report of the stopped informer changes nothing.
      informers[0].handlers.sync([]);
      expect(seen.at(-1)!.items).toEqual([obj("polled")]);
    });

    it("keeps the informer of a list without subscribers a while, then stops it", async () => {
      const { client, informers } = informingClient();
      const store = new ResourceStore(client, { pollIntervalMs: () => 1000, lingerMs: 30_000 }, nullLogger);
      store.watch(key, () => undefined).dispose();
      informers[0].handlers.sync([obj("a")]);
      const seen: Snapshot[] = [];
      store.watch(key, (s) => seen.push(s)).dispose();
      expect(seen[0]).toMatchObject({ loading: false, items: [obj("a")] });
      expect(informers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(informers[0].stopped).toBe(true);
    });
  });
});
