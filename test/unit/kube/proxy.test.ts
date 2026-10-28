// KubectlProxies against a fake kubectl: a Node.js script that serves `kubectl proxy` the way kubectl does.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type ApiError, FALLBACK } from "../../../src/kube/api";
import { KubectlProxies } from "../../../src/kube/proxy";
import { nullLogger } from "../../../src/kube/types";

const FAKE_KUBECTL = `#!/usr/bin/env node
// kubectl --context <c> proxy (--unix-socket=<path> | --port=0 --address=127.0.0.1) --api-prefix=<p> --reject-methods=<re>
const http = require("node:http");
const args = process.argv.slice(2);
const context = args[args.indexOf("--context") + 1];
const opt = (name) => args.find((a) => a.startsWith("--" + name + "="))?.split("=").slice(1).join("=");
if (context === "broken") {
  process.stderr.write("error: context was not found for specified context: broken\\n");
  process.exit(1);
}
const prefix = opt("api-prefix");
const server = http.createServer((req, res) => {
  if (!req.url.startsWith(prefix)) return res.writeHead(404).end("404 page not found");
  const path = "/" + req.url.slice(prefix.length);
  if (path === "/args") return res.end(JSON.stringify(args));
  if (path.startsWith("/api/v1/pods?watch=1")) {
    res.writeHead(200);
    // An event cut between two chunks.
    res.write(JSON.stringify({ type: "ADDED", object: { metadata: { name: "a" } } }) + "\\n" + '{"type":"MODIFIED",');
    setTimeout(() => res.end('"object":{"metadata":{"name":"a"}}}\\n'), 20);
    return;
  }
  if (path.startsWith("/api/v1/pods")) return res.end(JSON.stringify({ kind: "PodList", items: [{ metadata: { name: "a" } }], context }));
  if (path.startsWith("/silent")) return res.writeHead(200).write("");
  res.writeHead(403).end(JSON.stringify({ kind: "Status", code: 403, reason: "Forbidden", message: path + " is forbidden" }));
});
const socket = opt("unix-socket");
server.listen(socket ?? { port: 0, host: "127.0.0.1" }, () =>
  process.stdout.write("Starting to serve on " + (socket ?? "127.0.0.1:" + server.address().port) + "\\n"),
);
`;

const dir = mkdtempSync(join(tmpdir(), "kx-fake-kubectl-"));
const kubectl = join(dir, "kubectl");
writeFileSync(kubectl, FAKE_KUBECTL);
chmodSync(kubectl, 0o755);

describe.skipIf(process.platform === "win32")("KubectlProxies", () => {
  let proxies: KubectlProxies | undefined;
  afterEach(() => proxies?.dispose());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const lines = (p: KubectlProxies, context: string, path: string, idleTimeoutMs?: number) =>
    new Promise<{ lines: string[]; error?: ApiError }>((resolve) => {
      const got: string[] = [];
      p.stream(
        context,
        path,
        (l) => got.push(l),
        (error) => resolve({ lines: got, error }),
        { idleTimeoutMs },
      );
    });

  it("serves the lists and watches of a cluster through a single proxy, read-only, behind a secret prefix", async () => {
    proxies = new KubectlProxies(() => kubectl, nullLogger);
    expect(JSON.parse(await proxies.get("kind-a", "/api/v1/pods?limit=500"))).toMatchObject({ kind: "PodList", context: "kind-a" });
    const watch = await lines(proxies, "kind-a", "/api/v1/pods?watch=1");
    expect(watch.error).toBeUndefined();
    expect(watch.lines.map((l) => JSON.parse(l).type)).toEqual(["ADDED", "MODIFIED"]);
    const args: string[] = JSON.parse(await proxies.get("kind-a", "/args"));
    expect(args.find((a) => a.startsWith("--unix-socket="))).toMatch(new RegExp(`kubexplorer-${process.pid}-.+\\.sock$`));
    expect(args.find((a) => a.startsWith("--api-prefix="))).toMatch(/^--api-prefix=\/[0-9a-f]{32}\/$/);
    expect(args).toContain("--reject-methods=^(POST|PUT|PATCH|DELETE|CONNECT|OPTIONS|TRACE)$");
    expect(proxies.running()).toEqual(["kind-a"]);
  });

  it("removes the socket directories of extension hosts that ended without cleaning up", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const stale = join(tmpdir(), `kubexplorer-${deadPid}-test`);
    mkdirSync(stale, { recursive: true });
    proxies = new KubectlProxies(() => kubectl, nullLogger);
    await proxies.get("kind-a", "/api/v1/pods");
    expect(existsSync(stale)).toBe(false);
  });

  it("reports the errors of the API with their status and message", async () => {
    proxies = new KubectlProxies(() => kubectl, nullLogger);
    await expect(proxies.get("kind-a", "/api/v1/secrets")).rejects.toMatchObject({
      status: 403,
      reason: "Forbidden",
      message: "/api/v1/secrets is forbidden",
    });
    expect((await lines(proxies, "kind-a", "/api/v1/secrets?watch=1")).error).toMatchObject({ status: 403 });
  });

  it("ends a watch that goes silent", async () => {
    proxies = new KubectlProxies(() => kubectl, nullLogger);
    const silent = await lines(proxies, "kind-a", "/silent", 200);
    expect(silent.error?.message).toBe("nothing received for too long");
  });

  it("lets a cluster whose proxy cannot start fall back to kubectl, without trying again at once", async () => {
    proxies = new KubectlProxies(() => kubectl, nullLogger);
    const error = await proxies.get("broken", "/api/v1/pods").catch((e: ApiError) => e);
    expect(error).toMatchObject({ reason: FALLBACK, message: "error: context was not found for specified context: broken" });
    const again = Date.now();
    await expect(proxies.get("broken", "/api/v1/pods")).rejects.toMatchObject({ reason: FALLBACK });
    expect(Date.now() - again).toBeLessThan(50);
    expect(proxies.running()).toEqual([]);
  });

  it("listens on 127.0.0.1 where Unix sockets cannot be used (Windows), and starts a stopped proxy again", async () => {
    proxies = new KubectlProxies(() => kubectl, nullLogger, { listen: "tcp" });
    expect(JSON.parse(await proxies.get("kind-b", "/api/v1/pods"))).toMatchObject({ context: "kind-b" });
    expect(JSON.parse(await proxies.get("kind-b", "/args"))).toContain("--port=0");
    proxies.stop("kind-b");
    expect(proxies.running()).toEqual([]);
    expect(JSON.parse(await proxies.get("kind-b", "/api/v1/pods"))).toMatchObject({ context: "kind-b" });
  });

  it("does not take a proxy stopped while it starts for a failure", async () => {
    proxies = new KubectlProxies(() => kubectl, nullLogger);
    const first = proxies.get("kind-c", "/api/v1/pods").catch((e: ApiError) => e);
    proxies.stop();
    expect(await first).toMatchObject({ reason: FALLBACK });
    expect(JSON.parse(await proxies.get("kind-c", "/api/v1/pods"))).toMatchObject({ context: "kind-c" });
  });
});
