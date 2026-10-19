// Routes every call to the demo client or to kubectl depending on the target context,
// and serves virtual lists (Helm, port forwards) from their own sources.

import type { ExecSpec, KubeClient, ListOptions, ManyResult, NamedKind, Stoppable, VirtualSource, WatchEventType } from "./client";
import { DEMO_CONTEXT, DemoClient } from "./demo";
import { type ContextInfo, errorMessage, type KindTarget, type KubeObject, type Logger, type LogOptions, type ObjectTarget } from "./types";

export interface RoutingOptions {
  demoEnabled: () => boolean;
  watchEnabled: () => boolean;
  /** Virtual lists, keyed by kubectlName (e.g. "helm:releases"). */
  virtualSources?: Record<string, VirtualSource>;
}

export class RoutingClient implements KubeClient {
  private demoClient?: DemoClient;

  constructor(
    private readonly real: KubeClient,
    private readonly opts: RoutingOptions,
    private readonly log: Logger,
  ) {}

  private demo(): DemoClient {
    return (this.demoClient ??= new DemoClient());
  }

  private pick(context: string): KubeClient {
    return context === DEMO_CONTEXT ? this.demo() : this.real;
  }

  async listContexts(): Promise<ContextInfo[]> {
    let contexts: ContextInfo[] = [];
    try {
      contexts = await this.real.listContexts();
    } catch (err) {
      this.log.error(`Cannot read the kubeconfig: ${errorMessage(err)}`);
      if (!this.opts.demoEnabled()) throw err;
    }
    return this.opts.demoEnabled() ? [...contexts, ...(await this.demo().listContexts())] : contexts;
  }

  list(context: string, kind: KindTarget, opts: ListOptions): Promise<KubeObject[]> {
    const source = this.opts.virtualSources?.[kind.kubectlName];
    return source ? source.list(context, opts) : this.pick(context).list(context, kind, opts);
  }

  listMany(context: string, kinds: NamedKind[], opts?: { namespace?: string }): Promise<ManyResult> {
    return this.pick(context).listMany(context, kinds, opts);
  }

  watch(
    context: string,
    kind: KindTarget,
    opts: ListOptions,
    onEvent: (type: WatchEventType, obj: KubeObject) => void,
    onEnd: (error?: string) => void,
  ): Stoppable | undefined {
    // No watch for virtual lists nor the demo cluster: the store polls them.
    if (!this.opts.watchEnabled() || this.opts.virtualSources?.[kind.kubectlName] || context === DEMO_CONTEXT) return undefined;
    return this.real.watch?.(context, kind, opts, onEvent, onEnd);
  }

  getYaml(context: string, t: ObjectTarget): Promise<string> {
    return this.pick(context).getYaml(context, t);
  }

  replaceYaml(context: string, yaml: string): Promise<string> {
    return this.pick(context).replaceYaml(context, yaml);
  }

  describe(context: string, t: ObjectTarget): Promise<string> {
    return this.pick(context).describe(context, t);
  }

  delete(context: string, t: ObjectTarget): Promise<void> {
    return this.pick(context).delete(context, t);
  }

  scale(context: string, t: ObjectTarget, replicas: number): Promise<void> {
    return this.pick(context).scale(context, t, replicas);
  }

  restart(context: string, t: ObjectTarget): Promise<void> {
    return this.pick(context).restart(context, t);
  }

  patch(context: string, t: ObjectTarget, patch: object): Promise<void> {
    return this.pick(context).patch(context, t, patch);
  }

  getRaw(context: string, path: string): Promise<string> {
    return this.pick(context).getRaw(context, path);
  }

  triggerCronJob(context: string, namespace: string, name: string): Promise<string> {
    return this.pick(context).triggerCronJob(context, namespace, name);
  }

  streamLogs(context: string, o: LogOptions, onData: (chunk: string) => void, onEnd: (error?: string) => void): Stoppable {
    return this.pick(context).streamLogs(context, o, onData, onEnd);
  }

  execSpec(context: string, namespace: string, pod: string, container: string): ExecSpec | undefined {
    return this.pick(context).execSpec(context, namespace, pod, container);
  }

  debugSpec(context: string, namespace: string, pod: string, container: string, image: string): ExecSpec | undefined {
    return this.pick(context).debugSpec(context, namespace, pod, container, image);
  }
}
