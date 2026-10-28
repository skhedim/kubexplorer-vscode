import type { ContextInfo, KindTarget, KubeObject, LogOptions, ObjectTarget } from "./types";

export interface ListOptions {
  /** Empty means every namespace. Ignored for cluster-scoped resources. */
  namespaces: string[];
  labelSelector?: string;
  fieldSelector?: string;
}

/** A kind read by listMany, with its Kind to sort the items of the combined list. */
export interface NamedKind extends KindTarget {
  kindName: string;
}

export interface ManyResult {
  /** Items per kubectlName. */
  items: Record<string, KubeObject[]>;
  /** Kinds the cluster does not serve (CRD not installed). */
  missing: string[];
}

export interface Stoppable {
  stop(): void;
}

export type WatchEventType = "ADDED" | "MODIFIED" | "DELETED";

/** What an informer reports about the list it follows (see KubeClient.inform). */
export interface InformHandlers {
  /** The whole list: first, then whenever the watch could not go on from where it was (resourceVersion expired). */
  sync(items: KubeObject[]): void;
  event(type: WatchEventType, obj: KubeObject): void;
  /** Followed in real time, or not (yet, or any more: error tells why, and it tries again by itself). */
  status(live: boolean, error?: string): void;
  /** It cannot follow this list: the caller lists it with kubectl, or polls it when it cannot be watched at all. */
  unsupported(reason: { watch: boolean; message: string }): void;
}

export interface Informing extends Stoppable {
  /** Lists again now. */
  resync(): void;
}

export interface ExecSpec {
  shellPath: string;
  shellArgs: string[];
}

/** Cluster access. Implemented with kubectl, and in memory for the demo cluster. */
export interface KubeClient {
  listContexts(): Promise<ContextInfo[]>;
  list(context: string, kind: KindTarget, opts: ListOptions): Promise<KubeObject[]>;
  /**
   * Lists several kinds in every namespace (or one) with a single request per cluster (`kubectl get a,b,c`): the
   * cheap way to look at many clusters. Kinds the cluster does not serve are reported, not failed.
   */
  listMany(context: string, kinds: NamedKind[], opts?: { namespace?: string }): Promise<ManyResult>;
  getYaml(context: string, target: ObjectTarget): Promise<string>;
  /** Replaces an object with the given YAML (`kubectl replace`): conflicts are detected through resourceVersion. */
  replaceYaml(context: string, yaml: string): Promise<string>;
  describe(context: string, target: ObjectTarget): Promise<string>;
  delete(context: string, target: ObjectTarget): Promise<void>;
  scale(context: string, target: ObjectTarget, replicas: number): Promise<void>;
  restart(context: string, target: ObjectTarget): Promise<void>;
  /** JSON merge patch (`kubectl patch --type merge`). */
  patch(context: string, target: ObjectTarget, patch: object): Promise<void>;
  /** GET of an API path (`kubectl get --raw`), e.g. through a service proxy. */
  getRaw(context: string, path: string): Promise<string>;
  /** Creates a Job from a CronJob and returns the Job name. */
  triggerCronJob(context: string, namespace: string, name: string): Promise<string>;
  streamLogs(context: string, opts: LogOptions, onData: (chunk: string) => void, onEnd: (error?: string) => void): Stoppable;
  /** Command to run in a terminal for an interactive shell; undefined when unsupported (demo). */
  execSpec(context: string, namespace: string, pod: string, container: string): ExecSpec | undefined;
  /** Command to run in a terminal for an ephemeral debug container (`kubectl debug`); undefined when unsupported. */
  debugSpec(context: string, namespace: string, pod: string, container: string, image: string): ExecSpec | undefined;
  /**
   * Follows a list: its full state, then its changes, over a single connection per cluster (kubectl proxy).
   * Undefined when unsupported for this context or kind: the caller uses list() and watch() instead.
   */
  inform?(context: string, kind: KindTarget, opts: ListOptions, handlers: InformHandlers): Informing | undefined;
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
