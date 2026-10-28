import { describe, expect, it, vi } from "vitest";
import { ApiError, ApiReader, type ApiTransport, type ApiWatchEvent, FALLBACK, splitKubectlName } from "../../../src/kube/api";
import type { KubeObject } from "../../../src/kube/types";

const GROUPS = {
  kind: "APIGroupList",
  groups: [
    { name: "apps", preferredVersion: { version: "v1" } },
    { name: "autoscaling", preferredVersion: { version: "v2" } },
    { name: "kustomize.toolkit.fluxcd.io", preferredVersion: { version: "v1" } },
  ],
};

const pod = (name: string, namespace = "default") => ({ metadata: { name, namespace, uid: name, resourceVersion: "1" } });

/** A transport answering GETs from a function of the path, and streams from scripted lines. */
function fakeTransport(answer: (path: string) => unknown) {
  const gets: string[] = [];
  const streams: { path: string; onLine: (l: string) => void; onEnd: (e?: ApiError) => void; stopped: boolean; idleTimeoutMs?: number }[] =
    [];
  const transport: ApiTransport = {
    get: vi.fn(async (_context: string, path: string) => {
      gets.push(path);
      const body = answer(path);
      if (body instanceof ApiError) throw body;
      return JSON.stringify(body);
    }),
    stream: (_context, path, onLine, onEnd, opts) => {
      const s = { path, onLine, onEnd, stopped: false, idleTimeoutMs: opts?.idleTimeoutMs };
      streams.push(s);
      return { stop: () => (s.stopped = true) };
    },
  };
  return { transport, gets, streams };
}

const pods = { kubectlName: "pods", namespaced: true };

describe("splitKubectlName", () => {
  it("places the kinds named by their plural, and the qualified ones", () => {
    expect(splitKubectlName("pods")).toEqual({ resource: "pods", group: "" });
    expect(splitKubectlName("cronjobs")).toEqual({ resource: "cronjobs", group: "batch" });
    expect(splitKubectlName("kustomizations.kustomize.toolkit.fluxcd.io")).toEqual({
      resource: "kustomizations",
      group: "kustomize.toolkit.fluxcd.io",
    });
    expect(splitKubectlName("widgets")).toBeUndefined();
  });
});

describe("ApiReader", () => {
  it("builds the paths with the preferred version of the group, read once", async () => {
    const { transport, gets } = fakeTransport(() => GROUPS);
    const api = new ApiReader(transport);
    expect(await api.collectionPath("c", pods, "web")).toBe("/api/v1/namespaces/web/pods");
    expect(await api.collectionPath("c", { kubectlName: "deployments", namespaced: true })).toBe("/apis/apps/v1/deployments");
    expect(await api.collectionPath("c", { kubectlName: "horizontalpodautoscalers.autoscaling", namespaced: true }, "a")).toBe(
      "/apis/autoscaling/v2/namespaces/a/horizontalpodautoscalers",
    );
    expect(await api.collectionPath("c", { kubectlName: "nodes", namespaced: false }, "ignored")).toBe("/api/v1/nodes");
    expect(gets).toEqual(["/apis"]);
  });

  it("reads the groups again for a kind it does not know, then reports it like kubectl", async () => {
    const { transport, gets } = fakeTransport(() => GROUPS);
    const api = new ApiReader(transport);
    await api.collectionPath("c", { kubectlName: "deployments", namespaced: true });
    const missing = api.collectionPath("c", { kubectlName: "nodepools.karpenter.sh", namespaced: false });
    await expect(missing).rejects.toThrow('the server doesn\'t have a resource type "nodepools.karpenter.sh"');
    expect(gets).toEqual(["/apis", "/apis"]);
    // A kind named by an unknown plural is left to kubectl.
    await expect(api.collectionPath("c", { kubectlName: "widgets", namespaced: true })).rejects.toMatchObject({ reason: FALLBACK });
  });

  it("lists page by page, with the apiVersion and kind of every item and the resourceVersion of the list", async () => {
    const { transport, gets } = fakeTransport((path) =>
      path.includes("continue=")
        ? { apiVersion: "v1", kind: "PodList", metadata: { resourceVersion: "42" }, items: [pod("c")] }
        : { apiVersion: "v1", kind: "PodList", metadata: { resourceVersion: "42", continue: "next" }, items: [pod("a"), pod("b")] },
    );
    const api = new ApiReader(transport);
    const { items, resourceVersion } = await api.list("c", pods, { namespaces: [], labelSelector: "app=web" });
    expect(items.map((o) => o.metadata.name)).toEqual(["a", "b", "c"]);
    expect(items[0]).toMatchObject({ apiVersion: "v1", kind: "Pod" });
    expect(resourceVersion).toBe("42");
    expect(gets).toEqual([
      "/api/v1/pods?labelSelector=app%3Dweb&limit=500",
      "/api/v1/pods?labelSelector=app%3Dweb&limit=500&continue=next",
    ]);
  });

  it("reads one namespace, or all of them to keep several", async () => {
    const { transport, gets } = fakeTransport(() => ({ kind: "PodList", items: [pod("a", "x"), pod("b", "y"), pod("c", "z")] }));
    const api = new ApiReader(transport);
    await api.list("c", pods, { namespaces: ["x"] });
    expect(gets.at(-1)).toBe("/api/v1/namespaces/x/pods?limit=500");
    const { items } = await api.list("c", pods, { namespaces: ["x", "z"] });
    expect(gets.at(-1)).toBe("/api/v1/pods?limit=500");
    expect(items.map((o) => o.metadata.name)).toEqual(["a", "c"]);
  });

  it("starts a list again once when its continue token expired", async () => {
    let calls = 0;
    const { transport } = fakeTransport((path) => {
      calls++;
      if (calls === 2) return new ApiError("The provided continue parameter is too old", 410, "Expired");
      return path.includes("continue=")
        ? { kind: "PodList", metadata: { resourceVersion: "9" }, items: [pod("b")] }
        : { kind: "PodList", metadata: { resourceVersion: "9", continue: "t" }, items: [pod("a")] };
    });
    const { items } = await new ApiReader(transport).list("c", pods, { namespaces: [] });
    expect(items.map((o) => o.metadata.name)).toEqual(["a", "b"]);
    expect(calls).toBe(4);
  });

  it("watches from a resourceVersion, and reports an expired one as 410", async () => {
    const { transport, streams } = fakeTransport(() => GROUPS);
    const api = new ApiReader(transport);
    const events: [ApiWatchEvent, string][] = [];
    const onEnd = vi.fn();
    api.watch("c", pods, { namespaces: ["web"] }, "42", 300, (type, o: KubeObject) => events.push([type, o.metadata.name]), onEnd);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    const s = streams[0];
    expect(s.path).toBe("/api/v1/namespaces/web/pods?watch=1&allowWatchBookmarks=true&resourceVersion=42&timeoutSeconds=300");
    expect(s.idleTimeoutMs).toBe(360_000);
    s.onLine(JSON.stringify({ type: "ADDED", object: pod("a") }));
    s.onLine("not json");
    s.onLine(JSON.stringify({ type: "BOOKMARK", object: { metadata: { resourceVersion: "50" } } }));
    s.onLine(
      JSON.stringify({ type: "ERROR", object: { kind: "Status", code: 410, reason: "Expired", message: "too old resource version" } }),
    );
    expect(events).toEqual([
      ["ADDED", "a"],
      ["BOOKMARK", undefined],
    ]);
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ status: 410, message: "too old resource version" }));
    expect(s.stopped).toBe(true);
  });

  it("does not report the end of a watch stopped by its owner", async () => {
    const { transport, streams } = fakeTransport(() => GROUPS);
    const onEnd = vi.fn();
    const watch = new ApiReader(transport).watch("c", pods, { namespaces: [] }, "1", 300, vi.fn(), onEnd);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    watch.stop();
    expect(streams[0].stopped).toBe(true);
    streams[0].onEnd();
    expect(onEnd).not.toHaveBeenCalled();
  });
});
