// Documents opened in real editor tabs:
// - kubexplorer:/<context>/<resource>/<namespace|_>/<name>.yaml: the YAML of an object, as a file system.
//   Opening runs `kubectl get -o yaml`; saving (Ctrl+S) runs `kubectl replace`, after a confirmation.
// - kubexplorer-describe:/…: read-only `kubectl describe` output.
// - kubexplorer-view:/…: read-only text (Helm values, manifests…).

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import type { ResourceStore } from "../kube/store";
import { errorMessage, type Logger, type ObjectTarget } from "../kube/types";
import type { ResourceRegistry } from "../resources/registry";
import type { ResourceRef } from "../shared/view";
import { config } from "./config";

export const YAML_SCHEME = "kubexplorer";
export const DESCRIBE_SCHEME = "kubexplorer-describe";
export const VIEW_SCHEME = "kubexplorer-view";
const CLUSTER_SCOPED = "_";

export function resourceUri(scheme: string, context: string, ref: ResourceRef, extension: string): vscode.Uri {
  const parts = [context, ref.resource, ref.namespace ?? CLUSTER_SCOPED, `${ref.name}.${extension}`].map(encodeURIComponent);
  return vscode.Uri.from({ scheme, path: `/${parts.join("/")}` });
}

function parseResourceUri(uri: vscode.Uri): { context: string; ref: ResourceRef } {
  const [context, resource, namespace, file] = uri.path.slice(1).split("/").map(decodeURIComponent);
  if (!context || !resource || !namespace || !file) throw vscode.FileSystemError.FileNotFound(uri);
  return {
    context,
    ref: { resource, namespace: namespace === CLUSTER_SCOPED ? undefined : namespace, name: file.replace(/\.(yaml|txt)$/, "") },
  };
}

function objectTarget(registry: ResourceRegistry, uri: vscode.Uri): { context: string; ref: ResourceRef; target: ObjectTarget } {
  const { context, ref } = parseResourceUri(uri);
  const descriptor = registry.get(ref.resource);
  if (!descriptor) throw vscode.FileSystemError.FileNotFound(uri);
  return {
    context,
    ref,
    target: { kubectlName: descriptor.kubectlName, namespaced: descriptor.namespaced, namespace: ref.namespace, name: ref.name },
  };
}

export class ResourceFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly cache = new Map<string, { content: Uint8Array; mtime: number }>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly client: KubeClient,
    private readonly registry: ResourceRegistry,
    private readonly store: ResourceStore,
    private readonly log: Logger,
  ) {
    this.subscription = vscode.workspace.onDidCloseTextDocument((doc) => this.cache.delete(doc.uri.toString()));
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  // VS Code compares the mtime read when opening with the one returned when saving: it must stay
  // stable while the object is unchanged on the cluster, otherwise saving fails with "File Modified Since".
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (!this.cache.has(uri.toString())) await this.readFile(uri);
    const cached = this.cache.get(uri.toString())!;
    return { type: vscode.FileType.File, ctime: 0, mtime: cached.mtime, size: cached.content.byteLength };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { context, target } = objectTarget(this.registry, uri);
    try {
      const content = new TextEncoder().encode(await this.client.getYaml(context, target));
      const previous = this.cache.get(uri.toString());
      const unchanged = previous && Buffer.compare(previous.content, content) === 0;
      this.cache.set(uri.toString(), { content, mtime: unchanged ? previous.mtime : Date.now() });
      return content;
    } catch (err) {
      throw vscode.FileSystemError.Unavailable(errorMessage(err));
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { context, ref } = objectTarget(this.registry, uri);
    if (config.confirmApply()) {
      const apply = vscode.l10n.t("Apply");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("Apply your changes to {0}?", ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name),
        { modal: true, detail: vscode.l10n.t("Context: {0}\nThe object will be replaced (kubectl replace).", context) },
        apply,
      );
      // Throwing cancels the save: the document stays dirty and nothing is sent.
      if (choice !== apply) throw vscode.FileSystemError.NoPermissions(vscode.l10n.t("Apply cancelled"));
    }
    try {
      const output = (await this.client.replaceYaml(context, new TextDecoder().decode(content))).trim();
      this.log.info(`Applied on ${context}: ${output}`);
      vscode.window.setStatusBarMessage(`$(check) ${output || vscode.l10n.t("Applied")}`, 5000);
      this.store.refresh(context);
      // Read the object again: a fresh resourceVersion, ready for the next change.
      this.cache.delete(uri.toString());
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (err) {
      throw vscode.FileSystemError.Unavailable(errorMessage(err));
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions(vscode.l10n.t("Use the Delete action of KubeXplorer"));
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

export class DescribeProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly client: KubeClient,
    private readonly registry: ResourceRegistry,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { context, target } = objectTarget(this.registry, uri);
    try {
      return await this.client.describe(context, target);
    } catch (err) {
      return vscode.l10n.t("Error: {0}", errorMessage(err));
    }
  }
}

/** Read-only text documents (Helm values, manifests…), released when their tab is closed. */
export class ReadonlyDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docs = new Map<string, string>();
  private readonly subscription: vscode.Disposable;
  private serial = 0;

  constructor() {
    this.subscription = vscode.workspace.onDidCloseTextDocument((doc) => this.docs.delete(doc.uri.toString()));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  async show(title: string, content: string, language?: string): Promise<void> {
    // A unique path: VS Code would otherwise show a cached document with the same name.
    const uri = vscode.Uri.from({ scheme: VIEW_SCHEME, path: `/${++this.serial}/${title}` });
    this.docs.set(uri.toString(), content);
    const doc = await vscode.workspace.openTextDocument(uri);
    if (language) await vscode.languages.setTextDocumentLanguage(doc, language);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
