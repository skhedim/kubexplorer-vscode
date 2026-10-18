// Real client: runs kubectl. Every call passes --context explicitly, so the current context of the
// kubeconfig is never relied upon nor modified.

import { execFile, spawn } from "node:child_process";
import type { ExecSpec, KubeClient, ListOptions, Stoppable, WatchEventType } from "./client";
import { JsonStreamParser } from "./jsonStream";
import type { ContextInfo, KindTarget, KubeObject, Logger, LogOptions, ObjectTarget } from "./types";

const MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Keeps the useful error lines only (kubectl often repeats the same line, prefixed by klog headers). */
export function cleanStderr(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.replace(/^E\d{4} [\d:.]+\s+\d+ \S+\] /, "").trim())
    .filter(Boolean);
  return [...new Set(lines)].slice(-3).join("\n");
}

export interface CommandOptions {
  input?: string;
  timeoutMs?: number;
}

/** Runs a CLI and resolves with its stdout; rejects with a cleaned-up stderr. */
export function runCommand(binary: string, args: string[], log: Logger, opts: CommandOptions = {}): Promise<string> {
  const started = Date.now();
  const display = `${binary} ${args.join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { maxBuffer: MAX_BUFFER, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (!err) {
          log.trace(`${display} (${Date.now() - started} ms)`);
          resolve(stdout);
          return;
        }
        const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
        const message = notFound
          ? `${binary} not found: install it or set its path in the settings`
          : cleanStderr(String(stderr)) || err.message;
        log.warn(`${display} failed: ${message}`);
        reject(new Error(message));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Spawns a long-running command and streams its stdout; `onEnd` is not called after `stop()`. */
function spawnStream(
  binary: string,
  args: string[],
  log: Logger,
  onData: (chunk: string) => void,
  onEnd: (error?: string) => void,
): Stoppable {
  log.trace(`${binary} ${args.join(" ")} (stream)`);
  const child = spawn(binary, args);
  let stderr = "";
  let stopped = false;
  child.stdout.setEncoding("utf8").on("data", onData);
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.on("error", (e) => !stopped && onEnd(e.message));
  child.on("close", (code) => !stopped && onEnd(code ? cleanStderr(stderr) || `${binary} exited with code ${code}` : undefined));
  return {
    stop: () => {
      stopped = true;
      child.kill();
    },
  };
}

function namespaceArgs(t: ObjectTarget): string[] {
  return t.namespaced && t.namespace ? ["-n", t.namespace] : [];
}

export class KubectlClient implements KubeClient {
  constructor(
    private readonly kubectlPath: () => string,
    private readonly log: Logger,
  ) {}

  private run(args: string[], opts?: CommandOptions): Promise<string> {
    return runCommand(this.kubectlPath(), args, this.log, opts);
  }

  async listContexts(): Promise<ContextInfo[]> {
    const config = JSON.parse(await this.run(["config", "view", "-o", "json"]));
    const current = config["current-context"];
    return (config.contexts ?? []).map(
      (c: { name: string; context?: { cluster?: string; user?: string; namespace?: string } }): ContextInfo => ({
        name: c.name,
        cluster: c.context?.cluster,
        user: c.context?.user,
        namespace: c.context?.namespace,
        current: c.name === current,
      }),
    );
  }

  private listArgs(context: string, kind: KindTarget, opts: ListOptions): string[] {
    const args = ["--context", context, "get", kind.kubectlName, "-o", "json"];
    if (kind.namespaced) args.push(...(opts.namespaces.length === 1 ? ["-n", opts.namespaces[0]] : ["--all-namespaces"]));
    if (opts.labelSelector) args.push("-l", opts.labelSelector);
    if (opts.fieldSelector) args.push("--field-selector", opts.fieldSelector);
    return args;
  }

  /** kubectl cannot filter on several namespaces: with more than one, everything is listed and filtered here. */
  private inNamespaces(kind: KindTarget, opts: ListOptions, o: KubeObject): boolean {
    return !kind.namespaced || opts.namespaces.length <= 1 || opts.namespaces.includes(o.metadata.namespace ?? "");
  }

  async list(context: string, kind: KindTarget, opts: ListOptions): Promise<KubeObject[]> {
    const items: KubeObject[] = JSON.parse(await this.run(this.listArgs(context, kind, opts))).items ?? [];
    return items.filter((o) => this.inNamespaces(kind, opts, o));
  }

  watch(
    context: string,
    kind: KindTarget,
    opts: ListOptions,
    onEvent: (type: WatchEventType, obj: KubeObject) => void,
    onEnd: (error?: string) => void,
  ): Stoppable {
    const parser = new JsonStreamParser((value) => {
      const event = value as { type?: string; object?: KubeObject };
      const { type, object } = event;
      if ((type === "ADDED" || type === "MODIFIED" || type === "DELETED") && object?.metadata && this.inNamespaces(kind, opts, object)) {
        onEvent(type, object);
      }
    });
    const args = [...this.listArgs(context, kind, opts), "--watch-only", "--output-watch-events"];
    return spawnStream(this.kubectlPath(), args, this.log, (chunk) => parser.push(chunk), onEnd);
  }

  getYaml(context: string, t: ObjectTarget): Promise<string> {
    // Without managed fields, the YAML stays readable and editable.
    return this.run(["--context", context, ...namespaceArgs(t), "get", t.kubectlName, t.name, "-o", "yaml", "--show-managed-fields=false"]);
  }

  replaceYaml(context: string, yaml: string): Promise<string> {
    return this.run(["--context", context, "replace", "-f", "-"], { input: yaml });
  }

  describe(context: string, t: ObjectTarget): Promise<string> {
    return this.run(["--context", context, ...namespaceArgs(t), "describe", t.kubectlName, t.name]);
  }

  async delete(context: string, t: ObjectTarget): Promise<void> {
    await this.run(["--context", context, ...namespaceArgs(t), "delete", t.kubectlName, t.name, "--wait=false"]);
  }

  async scale(context: string, t: ObjectTarget, replicas: number): Promise<void> {
    await this.run(["--context", context, ...namespaceArgs(t), "scale", `${t.kubectlName}/${t.name}`, `--replicas=${replicas}`]);
  }

  async restart(context: string, t: ObjectTarget): Promise<void> {
    await this.run(["--context", context, ...namespaceArgs(t), "rollout", "restart", `${t.kubectlName}/${t.name}`]);
  }

  async patch(context: string, t: ObjectTarget, patch: object): Promise<void> {
    await this.run([
      "--context",
      context,
      ...namespaceArgs(t),
      "patch",
      t.kubectlName,
      t.name,
      "--type",
      "merge",
      "-p",
      JSON.stringify(patch),
    ]);
  }

  getRaw(context: string, path: string): Promise<string> {
    return this.run(["--context", context, "get", "--raw", path], { timeoutMs: 15_000 });
  }

  async triggerCronJob(context: string, namespace: string, name: string): Promise<string> {
    const job = `${name}-manual-${Math.floor(Date.now() / 1000).toString(36)}`.slice(0, 63);
    await this.run(["--context", context, "-n", namespace, "create", "job", job, `--from=cronjob/${name}`]);
    return job;
  }

  streamLogs(context: string, o: LogOptions, onData: (chunk: string) => void, onEnd: (error?: string) => void): Stoppable {
    const args = ["--context", context, "-n", o.namespace, "logs", o.pod, `--tail=${o.tailLines}`, "--timestamps"];
    args.push(...(o.container ? ["-c", o.container] : ["--all-containers", "--prefix"]));
    if (o.previous) args.push("--previous");
    else if (o.follow) args.push("-f");
    return spawnStream(this.kubectlPath(), args, this.log, onData, onEnd);
  }

  execSpec(context: string, namespace: string, pod: string, container: string): ExecSpec {
    return {
      shellPath: this.kubectlPath(),
      shellArgs: [
        ...["--context", context, "-n", namespace, "exec", "-it", pod, "-c", container, "--"],
        ...["sh", "-c", "command -v bash >/dev/null && exec bash || exec sh"],
      ],
    };
  }
}
