// Port forwards (kubectl port-forward) started from KubeXplorer, exposed as a virtual list.

import { type ChildProcess, spawn } from "node:child_process";
import type { ListOptions, VirtualSource } from "./client";
import { DEMO_CONTEXT } from "./demo";
import { cleanStderr } from "./kubectl";
import type { KubeObject, Logger } from "./types";

export type ForwardedResource = "pods" | "services";

export interface PortForward {
  id: string;
  context: string;
  namespace: string;
  resource: ForwardedResource;
  name: string;
  remotePort: number;
  localPort?: number;
  status: "starting" | "active" | "error";
  error?: string;
  startedAt: string;
}

/** Suggested local port: the remote one, except privileged ports (< 1024): 80 -> 8080, 443 -> 8443. */
export function suggestLocalPort(remote: number): number {
  if (remote >= 1024) return remote;
  if (remote === 80) return 8080;
  if (remote === 443) return 8443;
  return 10_000 + remote;
}

const FORWARDING = /Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+) ->/;
const START_TIMEOUT_MS = 20_000;

export class PortForwardManager implements VirtualSource {
  private readonly forwards = new Map<string, { pf: PortForward; child?: ChildProcess }>();
  private serial = 0;

  constructor(
    private readonly kubectlPath: () => string,
    private readonly log: Logger,
    private readonly onChange: () => void = () => undefined,
  ) {}

  /**
   * Starts a forward; resolves once kubectl announces the local port, rejects on failure.
   * A local port of 0 lets kubectl pick a free one.
   */
  start(
    context: string,
    namespace: string,
    resource: ForwardedResource,
    name: string,
    remotePort: number,
    localPort: number,
  ): Promise<PortForward> {
    if (context === DEMO_CONTEXT) return Promise.reject(new Error("Port forwarding is not available on the demo cluster"));
    const existing = this.all().find(
      (pf) =>
        pf.context === context &&
        pf.namespace === namespace &&
        pf.resource === resource &&
        pf.name === name &&
        pf.remotePort === remotePort &&
        pf.status === "active",
    );
    if (existing) return Promise.resolve(existing);

    const pf: PortForward = {
      id: `pf-${++this.serial}`,
      context,
      namespace,
      resource,
      name,
      remotePort,
      status: "starting",
      startedAt: new Date().toISOString(),
    };
    const target = `${resource === "services" ? "svc" : "pod"}/${name}`;
    const args = [
      "--context",
      context,
      "-n",
      namespace,
      "port-forward",
      target,
      `${localPort || ""}:${remotePort}`,
      "--address",
      "127.0.0.1",
    ];
    this.log.info(`kubectl ${args.join(" ")}`);
    const child = spawn(this.kubectlPath(), args);
    this.forwards.set(pf.id, { pf, child });
    this.onChange();

    return new Promise((resolve, reject) => {
      let stderr = "";
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        pf.status = "error";
        pf.error = message;
        child.kill();
        this.onChange();
        reject(new Error(message));
      };
      const timeout = setTimeout(() => fail(`kubectl port-forward did not answer within ${START_TIMEOUT_MS / 1000} s`), START_TIMEOUT_MS);

      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        const m = FORWARDING.exec(data);
        if (!m || settled) return;
        settled = true;
        clearTimeout(timeout);
        pf.localPort = Number(m[1]);
        pf.status = "active";
        this.log.info(`Forwarding 127.0.0.1:${pf.localPort} -> ${namespace}/${target}:${remotePort}`);
        this.onChange();
        resolve(pf);
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
        // Transient connection errors: kubectl keeps going, they are only logged.
        if (settled) this.log.warn(`Port forward ${pf.id}: ${data.trim()}`);
      });
      child.on("error", (e) => fail(e.message));
      child.on("close", (code) => {
        if (!settled) {
          fail(cleanStderr(stderr) || `kubectl port-forward exited with code ${code}`);
          return;
        }
        const entry = this.forwards.get(pf.id);
        if (entry?.child !== child) return; // stopped on purpose
        // Unexpected exit (pod deleted, connection lost): the row stays, in error.
        pf.status = "error";
        pf.error = cleanStderr(stderr) || "port forward interrupted";
        entry.child = undefined;
        this.onChange();
      });
    });
  }

  stop(id: string): void {
    const entry = this.forwards.get(id);
    if (!entry) return;
    this.forwards.delete(id);
    entry.child?.kill();
    this.log.info(`Port forward stopped: ${entry.pf.namespace}/${entry.pf.name}:${entry.pf.remotePort}`);
    this.onChange();
  }

  get(id: string): PortForward | undefined {
    return this.forwards.get(id)?.pf;
  }

  all(): PortForward[] {
    return [...this.forwards.values()].map((e) => e.pf);
  }

  async list(context: string, opts: ListOptions): Promise<KubeObject[]> {
    return this.all()
      .filter((pf) => pf.context === context && (!opts.namespaces.length || opts.namespaces.includes(pf.namespace)))
      .map((pf) => ({
        apiVersion: "kubexplorer/v1",
        kind: "PortForward",
        metadata: {
          name: pf.id,
          namespace: pf.namespace,
          uid: pf.id,
          creationTimestamp: pf.startedAt,
          resourceVersion: `${pf.status}${pf.localPort ?? ""}`,
        },
        portForward: { ...pf },
      }));
  }

  dispose(): void {
    for (const { child } of this.forwards.values()) child?.kill();
    this.forwards.clear();
  }
}
