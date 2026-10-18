import type { ContextInfo, KindTarget, KubeObject, LogOptions, ObjectTarget } from "./types";

export interface ListOptions {
  /** Empty means every namespace. Ignored for cluster-scoped resources. */
  namespaces: string[];
  labelSelector?: string;
  fieldSelector?: string;
}

export interface Stoppable {
  stop(): void;
}

export type WatchEventType = "ADDED" | "MODIFIED" | "DELETED";

export interface ExecSpec {
  shellPath: string;
  shellArgs: string[];
}

/** Cluster access. Implemented with kubectl, and in memory for the demo cluster. */
export interface KubeClient {
  listContexts(): Promise<ContextInfo[]>;
  list(context: string, kind: KindTarget, opts: ListOptions): Promise<KubeObject[]>;
  getYaml(context: string, target: ObjectTarget): Promise<string>;
  /** Replaces an object with the given YAML (`kubectl replace`): conflicts are detected through resourceVersion. */
  replaceYaml(context: string, yaml: string): Promise<string>;
  describe(context: string, target: ObjectTarget): Promise<string>;
  delete(context: string, target: ObjectTarget): Promise<void>;
  scale(context: string, target: ObjectTarget, replicas: number): Promise<void>;
  restart(context: string, target: ObjectTarget): Promise<void>;
  /** Creates a Job from a CronJob and returns the Job name. */
  triggerCronJob(context: string, namespace: string, name: string): Promise<string>;
  streamLogs(context: string, opts: LogOptions, onData: (chunk: string) => void, onEnd: (error?: string) => void): Stoppable;
  /** Command to run in a terminal for an interactive shell; undefined when unsupported (demo). */
  execSpec(context: string, namespace: string, pod: string, container: string): ExecSpec | undefined;
  /**
   * Follows the changes of a list, without its initial state (combine with list()).
   * Returns undefined when unsupported for this context or kind: the caller polls instead.
   */
  watch?(
    context: string,
    kind: KindTarget,
    opts: ListOptions,
    onEvent: (type: WatchEventType, obj: KubeObject) => void,
    onEnd: (error?: string) => void,
  ): Stoppable | undefined;
}

/**
 * A "virtual" list, not served by `kubectl get` (Helm releases, port forwards).
 * Its objects are shaped like Kubernetes objects so that lists, details and the store work unchanged.
 */
export interface VirtualSource {
  list(context: string, opts: ListOptions): Promise<KubeObject[]>;
}
