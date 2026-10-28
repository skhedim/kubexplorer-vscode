// Real client: runs kubectl. Every call passes --context explicitly, so the current context of the
// kubeconfig is never relied upon nor modified.
// With an ApiReader (a kubectl proxy per cluster), lists, watches and raw GETs go over HTTP instead of a kubectl
// process each; a cluster whose proxy cannot start falls back to kubectl processes.

import { execFile, spawn } from "node:child_process";
import { type ApiReader, inNamespaces, needsFallback } from "./api";
import type {
  ExecSpec,
  InformHandlers,
  Informing,
  KubeClient,
  ListOptions,
  ManyResult,
  NamedKind,
  Stoppable,
  WatchEventType,
} from "./client";
import { Informer } from "./informer";
import { JsonStreamParser } from "./jsonStream";
import type { ContextInfo, KindTarget, KubeObject, Logger, LogOptions, ObjectTarget } from "./types";

const MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
/** listMany reads remote clusters: an unreachable one must not hold a slot for long. */
const REQUEST_TIMEOUT = "20s";
const MANY_TIMEOUT_MS = 25_000;

/** Sorts the items of a combined list by requested kind (Kind, then API group when two kinds share a Kind). */
export function groupByKind(items: KubeObject[], kinds: NamedKind[]): Record<string, KubeObject[]> {
  const out: Record<string, KubeObject[]> = Object.fromEntries(kinds.map((k) => [k.kubectlName, []]));
  for (const item of items) {
    const group = item.apiVersion?.includes("/") ? item.apiVersion.split("/")[0] : "";
    const candidates = kinds.filter((k) => k.kindName === item.kind);
    const kind = candidates.length > 1 ? candidates.find((k) => k.kubectlName.split(".").slice(1).join(".") === group) : candidates[0];
    if (kind) out[kind.kubectlName].push(item);
  }
  return out;
}

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
    private readonly api?: ApiReader,
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

  async list(context: string, kind: KindTarget, opts: ListOptions): Promise<KubeObject[]> {
    if (this.api) {
      try {
        return (await this.api.list(context, kind, opts)).items;
      } catch (err) {
        if (!needsFallback(err)) throw err;
      }
    }
    const items: KubeObject[] = JSON.parse(await this.run(this.listArgs(context, kind, opts))).items ?? [];
    return items.filter((o) => inNamespaces(kind, opts, o));
  }

  inform(context: string, kind: KindTarget, opts: ListOptions, handlers: InformHandlers): Informing | undefined {
    const api = this.api;
    if (!api) return undefined;
    const informer = new Informer(
      {
        list: () => api.list(context, kind, opts),
        watch: (resourceVersion, timeoutSeconds, onEvent, onEnd) =>
          api.watch(context, kind, opts, resourceVersion, timeoutSeconds, onEvent, onEnd),
      },
      // Several namespaces: the watch covers them all, the others are left out here.
      { ...handlers, event: (type, obj) => inNamespaces(kind, opts, obj) && handlers.event(type, obj) },
    );
    informer.start();
    return informer;
  }

  async listMany(context: string, kinds: NamedKind[], opts: { namespace?: string } = {}): Promise<ManyResult> {
    const missing: string[] = [];
    let wanted = [...kinds];
    while (wanted.length) {
      const args = [
        "--context",
        context,
        "get",
        wanted.map((k) => k.kubectlName).join(","),
        "-o",
        "json",
        `--request-timeout=${REQUEST_TIMEOUT}`,
      ];
      args.push(...(opts.namespace ? ["-n", opts.namespace] : ["--all-namespaces"]));
      try {
        const items: KubeObject[] = JSON.parse(await this.run(args, { timeoutMs: MANY_TIMEOUT_MS })).items ?? [];
        return { items: groupByKind(items, wanted), missing };
      } catch (err) {
        // One kind the cluster does not serve fails the whole request: drop it and ask again.
        const type = /doesn't have a resource type "([^"]+)"/.exec(err instanceof Error ? err.message : "")?.[1];
        const unknown = type && wanted.find((k) => k.kubectlName === type || k.kubectlName.split(".")[0] === type);
        if (!unknown) throw err;
        missing.push(unknown.kubectlName);
        wanted = wanted.filter((k) => k !== unknown);
      }
    }
    return { items: {}, missing };
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
      if ((type === "ADDED" || type === "MODIFIED" || type === "DELETED") && object?.metadata && inNamespaces(kind, opts, object)) {
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

  async getRaw(context: string, path: string): Promise<string> {
    if (this.api) {
      try {
        return await this.api.getRaw(context, path);
      } catch (err) {
        if (!needsFallback(err)) throw err;
      }
    }
    return this.run(["--context", context, "get", "--raw", path], { timeoutMs: 15_000 });
  }

  async triggerCronJob(context: string, namespace: string, name: string): Promise<string> {
    const job = `${name}-manual-${Math.floor(Date.now() / 1000).toString(36)}`.slice(0, 63);
    await this.run(["--context", context, "-n", namespace, "create", "job", job, `--from=cronjob/${name}`]);
    return job;
  }

  streamLogs(context: string, o: LogOptions, onData: (chunk: string) => void, onEnd: (error?: string) => void): Stoppable {
    return spawnStream(this.kubectlPath(), logArgs(context, o), this.log, onData, onEnd);
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

  debugSpec(context: string, namespace: string, pod: string, container: string, image: string): ExecSpec {
    return { shellPath: this.kubectlPath(), shellArgs: debugArgs(context, namespace, pod, container, image) };
  }
}

/** Concurrent log streams of a workload (pods × containers), beyond the kubectl default of 5. */
const MAX_LOG_REQUESTS = 50;

export function logArgs(context: string, o: LogOptions): string[] {
  const args = ["--context", context, "-n", o.namespace, "logs"];
  // Lines of several pods are prefixed with [pod/name/container].
  if (o.selector) args.push("-l", o.selector, "--prefix", `--max-log-requests=${MAX_LOG_REQUESTS}`);
  else args.push(o.pod);
  args.push(`--tail=${o.tailLines}`, "--timestamps");
  if (o.container) args.push("-c", o.container);
  else args.push("--all-containers", ...(o.selector ? [] : ["--prefix"]));
  if (o.previous) args.push("--previous");
  else if (o.follow) args.push("-f");
  return args;
}

/** `kubectl debug`: an ephemeral container sharing the process namespace of `container`, attached to the terminal. */
export function debugArgs(context: string, namespace: string, pod: string, container: string, image: string): string[] {
  return ["--context", context, "-n", namespace, "debug", pod, "-it", `--image=${image}`, `--target=${container}`];
}
