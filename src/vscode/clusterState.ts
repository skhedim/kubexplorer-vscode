// Global state: known contexts, active cluster, selected namespaces per context.
// Persisted in globalState to survive restarts.

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import { type ContextInfo, errorMessage, type Logger } from "../kube/types";
import type { NamespaceFilter } from "../shared/protocol";

const ACTIVE_KEY = "kubexplorer.activeContext";
const namespacesKey = (context: string) => `kubexplorer.namespaces.${context}`;
const NAMESPACES_KIND = { kubectlName: "namespaces", namespaced: false };

export class ClusterState implements vscode.Disposable {
  private readonly contextsEmitter = new vscode.EventEmitter<void>();
  private readonly activeEmitter = new vscode.EventEmitter<string | undefined>();
  private readonly namespacesEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeContexts = this.contextsEmitter.event;
  readonly onDidChangeActive = this.activeEmitter.event;
  /** Fired with the context whose filter (or available namespaces) changed. */
  readonly onDidChangeNamespaces = this.namespacesEmitter.event;

  private _contexts: ContextInfo[] = [];
  private _contextsError?: string;
  private readonly available = new Map<string, string[]>();
  private readonly loadingNamespaces = new Map<string, Promise<void>>();

  constructor(
    private readonly memento: vscode.Memento,
    private readonly client: KubeClient,
    private readonly log: Logger,
  ) {}

  get contexts(): ContextInfo[] {
    return this._contexts;
  }

  get contextsError(): string | undefined {
    return this._contextsError;
  }

  get active(): string | undefined {
    return this.memento.get<string>(ACTIVE_KEY);
  }

  async reloadContexts(): Promise<void> {
    try {
      this._contexts = await this.client.listContexts();
      this._contextsError = undefined;
    } catch (err) {
      this._contexts = [];
      this._contextsError = errorMessage(err);
    }
    // The active context left the kubeconfig, or was never chosen: fall back to the current context.
    const active = this.active;
    if (!active || !this._contexts.some((c) => c.name === active)) {
      await this.setActive(this._contexts.find((c) => c.current)?.name ?? this._contexts[0]?.name);
    }
    this.contextsEmitter.fire();
    this.updateContextKey();
  }

  async setActive(context: string | undefined): Promise<void> {
    if (context === this.active) return;
    await this.memento.update(ACTIVE_KEY, context);
    this.log.info(`Active cluster: ${context ?? "(none)"}`);
    this.updateContextKey();
    this.activeEmitter.fire(context);
    if (context) void this.loadNamespaces(context);
  }

  selectedNamespaces(context: string): string[] {
    return this.memento.get<string[]>(namespacesKey(context), []);
  }

  async setNamespaces(context: string, namespaces: string[]): Promise<void> {
    await this.memento.update(namespacesKey(context), [...new Set(namespaces)].sort());
    this.namespacesEmitter.fire(context);
  }

  filter(context: string): NamespaceFilter {
    return { available: this.available.get(context) ?? [], selected: this.selectedNamespaces(context) };
  }

  /** Loads the namespaces of a cluster (once, then again on explicit refresh). */
  loadNamespaces(context: string, force = false): Promise<void> {
    if (!force && this.available.has(context)) return Promise.resolve();
    const pending = this.loadingNamespaces.get(context);
    if (pending) return pending;
    const load = this.client
      .list(context, NAMESPACES_KIND, { namespaces: [] })
      .then((items) => {
        this.available.set(context, items.map((i) => i.metadata.name).sort());
        this.namespacesEmitter.fire(context);
      })
      .catch((err) => this.log.warn(`Cannot list the namespaces of ${context}: ${errorMessage(err)}`))
      .finally(() => this.loadingNamespaces.delete(context));
    this.loadingNamespaces.set(context, load);
    return load;
  }

  private updateContextKey(): void {
    void vscode.commands.executeCommand("setContext", "kubexplorer.hasActiveContext", !!this.active);
  }

  dispose(): void {
    this.contextsEmitter.dispose();
    this.activeEmitter.dispose();
    this.namespacesEmitter.dispose();
  }
}
