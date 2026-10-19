// Core types of the Kubernetes layer.
// Nothing under src/kube, src/resources, src/panel or src/shared imports "vscode": these modules are
// unit tested and reused by the browser preview.

/** A Kubernetes object as returned by `kubectl get -o json` (intentionally loose). */
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    /** Missing on some aggregated API objects (metrics.k8s.io). */
    uid: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { kind: string; name: string; controller?: boolean }[];
    [key: string]: unknown;
  };
  // spec/status/data differ per kind: each descriptor reads them defensively.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ContextInfo {
  name: string;
  cluster?: string;
  user?: string;
  namespace?: string;
  /** Current context of the kubeconfig. */
  current: boolean;
  demo?: boolean;
}

/** A resource type, as kubectl knows it (e.g. "pods", "ingresses.networking.k8s.io"). */
export interface KindTarget {
  kubectlName: string;
  namespaced: boolean;
}

export interface ObjectTarget extends KindTarget {
  namespace?: string;
  name: string;
}

export interface LogOptions {
  namespace: string;
  /** A pod; with `selector`, the name of the workload (e.g. "deployment/web"), for display. */
  pod: string;
  /** Label selector: the logs of every matching pod, like stern. */
  selector?: string;
  /** Undefined means every container, with prefixed lines. */
  container?: string;
  previous: boolean;
  follow: boolean;
  tailLines: number;
}

export interface Logger {
  trace(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const nullLogger: Logger = { trace() {}, info() {}, warn() {}, error() {} };

export interface Disposable {
  dispose(): void;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
