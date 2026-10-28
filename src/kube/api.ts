// Reads the Kubernetes API over HTTP, through a transport to each cluster (a kubectl proxy, see proxy.ts): lists
// page by page like kubectl (500 objects at a time), watches from a resourceVersion, raw GETs.
// The path of a kind comes from its kubectl name ("deployments", "kustomizations.kustomize.toolkit.fluxcd.io") and
// the preferred version of its group, read from the cluster (GET /apis) and cached a few minutes.
// Browser-safe (the transport is injected), unit tested with a fake transport.

import type { ListOptions, Stoppable } from "./client";
import type { KindTarget, KubeObject } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status (410: resourceVersion expired, 405: watch not allowed…). */
    readonly status?: number,
    /** Kubernetes reason, or FALLBACK when this way to the cluster cannot serve the request. */
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** The request cannot go through the API (its proxy cannot start, a kind it cannot place): use kubectl instead. */
export const FALLBACK = "KubectlFallback";

export function needsFallback(err: unknown): boolean {
  return err instanceof ApiError && err.reason === FALLBACK;
}

export interface ApiTransport {
  /** GET of a path of the API of a cluster: the body of the response. Rejects with an ApiError. */
  get(context: string, path: string, opts?: { timeoutMs?: number; accept?: string }): Promise<string>;
  /**
   * GET of a stream (watch): its lines as they arrive. onEnd is called once, without an error when the server ended
   * the stream; never after stop(). idleTimeoutMs: ends with an error when nothing arrives for that long.
   */
  stream(
    context: string,
    path: string,
    onLine: (line: string) => void,
    onEnd: (error?: ApiError) => void,
    opts?: { idleTimeoutMs?: number; accept?: string },
  ): Stoppable;
}

/** The metadata of the objects only (KindTarget.metadataOnly), in a list and in a watch. */
const METADATA_LIST = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json";
const METADATA = "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1,application/json";

/** A change of a watch; BOOKMARK only moves the resourceVersion on. */
export type ApiWatchEvent = "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK";

/** Groups of the kinds named by their plural alone ("" for the core group). Other kinds are named "<plural>.<group>". */
const BUILT_IN_GROUPS: Record<string, string> = {
  pods: "",
  services: "",
  endpoints: "",
  configmaps: "",
  secrets: "",
  namespaces: "",
  nodes: "",
  events: "",
  serviceaccounts: "",
  resourcequotas: "",
  limitranges: "",
  persistentvolumeclaims: "",
  persistentvolumes: "",
  replicationcontrollers: "",
  podtemplates: "",
  deployments: "apps",
  statefulsets: "apps",
  daemonsets: "apps",
  replicasets: "apps",
  controllerrevisions: "apps",
  jobs: "batch",
  cronjobs: "batch",
  poddisruptionbudgets: "policy",
  priorityclasses: "scheduling.k8s.io",
  runtimeclasses: "node.k8s.io",
  leases: "coordination.k8s.io",
  mutatingwebhookconfigurations: "admissionregistration.k8s.io",
  validatingwebhookconfigurations: "admissionregistration.k8s.io",
};

const PAGE_SIZE = 500;
/** Preferred versions of the groups of a cluster are read again after… */
const GROUPS_TTL_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 60_000;

/** The plural and group of a kind, from its kubectl name. */
export function splitKubectlName(kubectlName: string): { resource: string; group: string } | undefined {
  const dot = kubectlName.indexOf(".");
  if (dot > 0) return { resource: kubectlName.slice(0, dot), group: kubectlName.slice(dot + 1) };
  const group = BUILT_IN_GROUPS[kubectlName];
  return group === undefined ? undefined : { resource: kubectlName, group };
}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** kubectl reads one namespace or all of them: with several, every namespace is read and the others are left out. */
export function inNamespaces(kind: KindTarget, opts: ListOptions, o: KubeObject): boolean {
  return !kind.namespaced || opts.namespaces.length <= 1 || opts.namespaces.includes(o.metadata.namespace ?? "");
}

export class ApiReader {
  private readonly groups = new Map<string, { at: number; versions: Promise<Map<string, string>> }>();

  constructor(
    private readonly transport: ApiTransport,
    private readonly now: () => number = Date.now,
  ) {}

  /** Preferred version of every group served by a cluster (GET /apis), cached. */
  private versions(context: string): Promise<Map<string, string>> {
    const hit = this.groups.get(context);
    if (hit && this.now() - hit.at < GROUPS_TTL_MS) return hit.versions;
    const versions = this.transport.get(context, "/apis").then((body) => {
      const list = JSON.parse(body) as { groups?: { name: string; preferredVersion?: { version: string } }[] };
      return new Map((list.groups ?? []).flatMap((g) => (g.preferredVersion ? [[g.name, g.preferredVersion.version] as const] : [])));
    });
    this.groups.set(context, { at: this.now(), versions });
    // A failure is not cached.
    versions.catch(() => this.groups.get(context)?.versions === versions && this.groups.delete(context));
    return versions;
  }

  /** Forgets the groups of a cluster (e.g. a CRD was installed). */
  invalidate(context?: string): void {
    if (context) this.groups.delete(context);
    else this.groups.clear();
  }

  /** Path of the objects of a kind, in a namespace or all of them. */
  async collectionPath(context: string, kind: KindTarget, namespace?: string): Promise<string> {
    const split = splitKubectlName(kind.kubectlName);
    if (!split) throw new ApiError(`${kind.kubectlName}: unknown API group`, undefined, FALLBACK);
    let base = "/api/v1";
    if (split.group) {
      let version = (await this.versions(context)).get(split.group);
      // Installed since the groups were read?
      if (!version) {
        this.invalidate(context);
        version = (await this.versions(context)).get(split.group);
      }
      if (!version) throw new ApiError(`the server doesn't have a resource type "${kind.kubectlName}"`, 404, "NotFound");
      base = `/apis/${split.group}/${version}`;
    }
    const ns = kind.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : "";
    return `${base}${ns}/${split.resource}`;
  }

  private listPath(context: string, kind: KindTarget, opts: ListOptions): Promise<string> {
    return this.collectionPath(context, kind, kind.namespaced && opts.namespaces.length === 1 ? opts.namespaces[0] : undefined);
  }

  /** Every object of a kind, page by page, with the resourceVersion of the list (to watch from it). */
  async list(context: string, kind: KindTarget, opts: ListOptions): Promise<{ items: KubeObject[]; resourceVersion?: string }> {
    const path = await this.listPath(context, kind, opts);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.pages(context, kind, opts, path);
      } catch (err) {
        // A list that takes too long outlives its continue token: start it again, once.
        if (attempt === 0 && err instanceof ApiError && err.status === 410) continue;
        throw err;
      }
    }
  }

  private async pages(context: string, kind: KindTarget, opts: ListOptions, path: string) {
    const items: KubeObject[] = [];
    let resourceVersion: string | undefined;
    let next: string | undefined;
    do {
      const body = await this.transport.get(
        context,
        `${path}${query({ labelSelector: opts.labelSelector, fieldSelector: opts.fieldSelector, limit: String(PAGE_SIZE), continue: next })}`,
        { timeoutMs: LIST_TIMEOUT_MS, accept: kind.metadataOnly ? METADATA_LIST : undefined },
      );
      const list = JSON.parse(body) as {
        apiVersion?: string;
        kind?: string;
        items?: KubeObject[];
        metadata?: { resourceVersion?: string; continue?: string };
      };
      // Items of a list carry no apiVersion nor kind (kubectl adds them): the code relies on them.
      const itemKind = list.kind?.replace(/List$/, "");
      for (const item of list.items ?? []) {
        item.apiVersion ??= list.apiVersion;
        item.kind ??= itemKind;
        if (inNamespaces(kind, opts, item)) items.push(item);
      }
      resourceVersion = list.metadata?.resourceVersion;
      next = list.metadata?.continue || undefined;
    } while (next);
    return { items, resourceVersion };
  }

  /**
   * Follows the changes of a kind from a resourceVersion. onEnd: once, without an error when the server ended the
   * watch (after timeoutSeconds); with status 410 when the resourceVersion expired (list again).
   */
  watch(
    context: string,
    kind: KindTarget,
    opts: ListOptions,
    resourceVersion: string,
    timeoutSeconds: number,
    onEvent: (type: ApiWatchEvent, obj: KubeObject) => void,
    onEnd: (error?: ApiError) => void,
  ): Stoppable {
    let stream: Stoppable | undefined;
    let stopped = false;
    const end = (error?: ApiError) => {
      if (stopped) return;
      stopped = true;
      stream?.stop();
      onEnd(error);
    };
    this.listPath(context, kind, opts).then(
      (path) => {
        if (stopped) return;
        const params = {
          watch: "1",
          allowWatchBookmarks: "true",
          resourceVersion,
          timeoutSeconds: String(timeoutSeconds),
          labelSelector: opts.labelSelector,
          fieldSelector: opts.fieldSelector,
        };
        stream = this.transport.stream(
          context,
          `${path}${query(params)}`,
          (line) => {
            let event: { type?: string; object?: KubeObject & { code?: number; reason?: string; message?: string } };
            try {
              event = JSON.parse(line);
            } catch {
              return; // A broken line: the next list (on any trouble) catches up.
            }
            const { type, object } = event;
            if (type === "ERROR") end(new ApiError(object?.message ?? "watch error", object?.code, object?.reason));
            else if ((type === "ADDED" || type === "MODIFIED" || type === "DELETED" || type === "BOOKMARK") && object?.metadata)
              onEvent(type, object);
          },
          (error) => end(error),
          // The server ends the watch after timeoutSeconds (bookmarks come in between): silence beyond means a dead link.
          { idleTimeoutMs: (timeoutSeconds + 60) * 1000, accept: kind.metadataOnly ? METADATA : undefined },
        );
      },
      (err: unknown) => end(err instanceof ApiError ? err : new ApiError(String(err))),
    );
    return { stop: () => ((stopped = true), stream?.stop()) };
  }

  getRaw(context: string, path: string): Promise<string> {
    return this.transport.get(context, path, { timeoutMs: 15_000 });
  }
}
