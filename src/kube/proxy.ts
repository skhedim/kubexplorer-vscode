// One `kubectl proxy` per cluster: lists and watches go through it over HTTP, instead of a kubectl process each (a
// tab of 10 lists cost 10 processes of 30 to 50 MB). kubectl still authenticates (exec plugins, tokens…).
// - Started on first use, stopped after IDLE_MS without a request nor a watch.
// - Private: a Unix socket in a directory only the user can open (mkdtemp: 0700). On Windows, where Node.js cannot
//   reach a Unix socket, 127.0.0.1 on a random port behind a secret path prefix. Read-only either way: the proxy
//   refuses any other method than GET, and kubectl refuses exec and attach by default.
// - A proxy that cannot start makes its cluster fall back to kubectl processes for a while (FALLBACK).

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { Agent, type IncomingMessage, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type ApiTransport, FALLBACK } from "./api";
import type { Stoppable } from "./client";
import { cleanStderr } from "./kubectl";
import { type Disposable, errorMessage, type Logger } from "./types";

/** A proxy without a request nor a watch is stopped after… */
const IDLE_MS = 3 * 60_000;
const START_TIMEOUT_MS = 15_000;
/** After a failed start, the cluster goes through kubectl processes for… */
const FALLBACK_MS = 60_000;
const READ_ONLY = "^(POST|PUT|PATCH|DELETE|CONNECT|OPTIONS|TRACE)$";

interface Endpoint {
  socketPath?: string;
  port?: number;
  /** Secret path prefix of every request. */
  prefix: string;
}

interface Proxy {
  child: ChildProcess;
  ready: Promise<Endpoint>;
  agent: Agent;
  /** Watches in progress. */
  streams: number;
  lastUsed: number;
  started?: boolean;
  /** Stopped by stop(): its end is no failure. */
  stopped?: boolean;
}

export interface ProxyOptions {
  /** unix: a Unix socket (default, but on Windows); tcp: 127.0.0.1 on a random port. */
  listen?: "unix" | "tcp";
  idleMs?: number;
  startTimeoutMs?: number;
}

/** Directories of the sockets: kubexplorer-<pid of the extension host>-<random>. */
const SOCKET_DIR = /^kubexplorer-(\d+)-/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes the socket directories of extension hosts that ended without cleaning up (killed). Best effort. */
function removeStaleSocketDirs(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      const pid = Number(SOCKET_DIR.exec(name)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }
  } catch {
    // Another user's directory, a race with another window…: left alone.
  }
}

/** The message of an error response: a Kubernetes Status, or the text of kubectl proxy. */
function responseError(res: IncomingMessage, body: string): ApiError {
  try {
    const status = JSON.parse(body) as { kind?: string; message?: string; reason?: string; code?: number };
    if (status.kind === "Status")
      return new ApiError(status.message ?? `HTTP ${res.statusCode}`, status.code ?? res.statusCode, status.reason);
  } catch {
    // Not JSON: an error of the proxy itself (cluster unreachable…).
  }
  return new ApiError(body.trim().split("\n")[0] || `HTTP ${res.statusCode}`, res.statusCode);
}

export class KubectlProxies implements ApiTransport, Disposable {
  private readonly proxies = new Map<string, Proxy>();
  private readonly failures = new Map<string, { at: number; message: string }>();
  private dir?: string;
  private sockets = 0;
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly listen: "unix" | "tcp";

  constructor(
    private readonly kubectlPath: () => string,
    private readonly log: Logger,
    private readonly opts: ProxyOptions = {},
  ) {
    this.listen = opts.listen ?? (process.platform === "win32" ? "tcp" : "unix");
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  /** Contexts with a proxy running or starting. */
  running(): string[] {
    return [...this.proxies.keys()];
  }

  private sweep(): void {
    const idle = this.opts.idleMs ?? IDLE_MS;
    for (const [context, p] of this.proxies) if (!p.streams && Date.now() - p.lastUsed > idle) this.stop(context, "idle");
  }

  /** Stops the proxy of a context, or every proxy (e.g. the kubeconfig changed). */
  stop(context?: string, why = "stopped"): void {
    for (const [ctx, p] of [...this.proxies]) {
      if (context && ctx !== context) continue;
      this.proxies.delete(ctx);
      p.stopped = true;
      p.child.kill();
      p.agent.destroy();
      this.log.info(`kubectl proxy of ${ctx}: ${why}`);
    }
    if (!context) this.failures.clear();
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.stop(undefined, "disposed");
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }

  private proxy(context: string): Proxy {
    const existing = this.proxies.get(context);
    if (existing) return existing;
    const failure = this.failures.get(context);
    if (failure && Date.now() - failure.at < FALLBACK_MS) throw new ApiError(failure.message, undefined, FALLBACK);
    const prefix = `/${randomBytes(16).toString("hex")}/`;
    let socketPath: string | undefined;
    if (this.listen === "unix") {
      if (!this.dir) {
        removeStaleSocketDirs();
        this.dir = mkdtempSync(join(tmpdir(), `kubexplorer-${process.pid}-`));
      }
      socketPath = join(this.dir, `${++this.sockets}.sock`);
    }
    const args = [
      ...["--context", context, "proxy"],
      ...(socketPath ? [`--unix-socket=${socketPath}`] : ["--port=0", "--address=127.0.0.1"]),
      `--api-prefix=${prefix}`,
      `--reject-methods=${READ_ONLY}`,
    ];
    const child = spawn(this.kubectlPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    const ready = new Promise<Endpoint>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`kubectl proxy did not start within ${(this.opts.startTimeoutMs ?? START_TIMEOUT_MS) / 1000} s`));
      }, this.opts.startTimeoutMs ?? START_TIMEOUT_MS);
      child.stdout!.setEncoding("utf8").on("data", (d: string) => {
        out += d;
        const served = /Starting to serve on (\S+)/.exec(out)?.[1];
        if (!served) return;
        clearTimeout(timer);
        resolve(socketPath ? { socketPath, prefix } : { port: Number(served.split(":").pop()), prefix });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(cleanStderr(stderr) || `kubectl proxy exited with code ${code}`));
      });
    });
    const proxy: Proxy = { child, ready, agent: new Agent({ keepAlive: true }), streams: 0, lastUsed: Date.now() };
    this.proxies.set(context, proxy);
    ready.then(
      () => {
        proxy.started = true;
        this.log.info(`kubectl proxy of ${context}: started (${socketPath ? "Unix socket" : "127.0.0.1"})`);
      },
      (err: unknown) => {
        // Stopped while it started: not a failure.
        if (proxy.stopped) return;
        if (this.proxies.get(context) === proxy) this.proxies.delete(context);
        const message = errorMessage(err);
        this.log.warn(`kubectl proxy of ${context} cannot start, kubectl processes instead: ${message}`);
        this.failures.set(context, { at: Date.now(), message });
      },
    );
    // A proxy that ends once started (a failed start is handled above): the next request starts another one.
    child.on("exit", (code) => {
      if (!proxy.started || proxy.stopped || this.proxies.get(context) !== proxy) return;
      this.proxies.delete(context);
      proxy.agent.destroy();
      this.log.warn(`kubectl proxy of ${context} exited (${code}): ${cleanStderr(stderr)}`);
    });
    return proxy;
  }

  /** Sends a GET to the proxy of a context, starting it when needed. */
  private async send(
    context: string,
    path: string,
    accept = "application/json",
  ): Promise<{ proxy: Proxy; req: ReturnType<typeof request> }> {
    const proxy = this.proxy(context);
    let endpoint: Endpoint;
    try {
      endpoint = await proxy.ready;
    } catch (err) {
      throw new ApiError(errorMessage(err), undefined, FALLBACK);
    }
    proxy.lastUsed = Date.now();
    const req = request({
      agent: proxy.agent,
      socketPath: endpoint.socketPath,
      host: endpoint.socketPath ? "localhost" : "127.0.0.1",
      port: endpoint.port,
      path: `${endpoint.prefix}${path.replace(/^\//, "")}`,
      headers: { accept },
    });
    return { proxy, req };
  }

  async get(context: string, path: string, opts: { timeoutMs?: number; accept?: string } = {}): Promise<string> {
    const started = Date.now();
    const { req } = await this.send(context, path, opts.accept);
    return new Promise((resolve, reject) => {
      req.setTimeout(opts.timeoutMs ?? 30_000, () =>
        req.destroy(new ApiError(`no response within ${(opts.timeoutMs ?? 30_000) / 1000} s`, 504)),
      );
      req.on("error", (e) => reject(e instanceof ApiError ? e : new ApiError(e.message)));
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (e) => reject(new ApiError(e.message)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const ok = !!res.statusCode && res.statusCode < 300;
          this.log.trace(`GET ${path.split("?")[0]} via proxy: ${res.statusCode} (${Date.now() - started} ms)`);
          if (ok) resolve(body);
          else reject(responseError(res, body));
        });
      });
      req.end();
    });
  }

  stream(
    context: string,
    path: string,
    onLine: (line: string) => void,
    onEnd: (error?: ApiError) => void,
    opts: { idleTimeoutMs?: number; accept?: string } = {},
  ): Stoppable {
    let stopped = false;
    let req: ReturnType<typeof request> | undefined;
    let proxy: Proxy | undefined;
    const finish = (error?: ApiError) => {
      if (stopped) return;
      stopped = true;
      if (proxy) {
        proxy.streams--;
        proxy.lastUsed = Date.now();
      }
      req?.destroy();
      onEnd(error);
    };
    this.send(context, path, opts.accept).then(
      (sent) => {
        ({ proxy, req } = sent);
        if (stopped) return void req.destroy();
        proxy.streams++;
        if (opts.idleTimeoutMs) req.setTimeout(opts.idleTimeoutMs, () => finish(new ApiError("nothing received for too long")));
        req.on("error", (e) => finish(e instanceof ApiError ? e : new ApiError(e.message)));
        req.on("response", (res) => {
          if (res.statusCode !== 200) {
            let body = "";
            res.setEncoding("utf8").on("data", (d: string) => (body += d));
            res.on("end", () => finish(responseError(res, body)));
            return;
          }
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            for (let i = buffer.indexOf("\n"); i >= 0 && !stopped; i = buffer.indexOf("\n")) {
              const line = buffer.slice(0, i);
              buffer = buffer.slice(i + 1);
              if (line.trim()) onLine(line);
            }
          });
          res.on("end", () => finish());
          res.on("error", (e) => finish(new ApiError(e.message)));
        });
        req.end();
      },
      (err: unknown) => finish(err instanceof ApiError ? err : new ApiError(errorMessage(err))),
    );
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (proxy && req) {
          proxy.streams--;
          proxy.lastUsed = Date.now();
        }
        req?.destroy();
      },
    };
  }
}
