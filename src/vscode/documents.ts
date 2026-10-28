// Documents opened in real editor tabs:
// - kubexplorer:/<context>/<resource>/<namespace|_>/<name>.yaml: the YAML of an object, as a file system.
//   Opening runs `kubectl get -o yaml`; saving (Ctrl+S) opens the diff against the cluster under a confirmation,
//   then runs `kubectl replace`. "<name> (decoded).yaml": a Secret with its text values decoded, under stringData.
// - kubexplorer-describe:/…: read-only `kubectl describe` output.
// - kubexplorer-view:/…: read-only text (Helm values, manifests…).

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import { decodeSecretYaml } from "../kube/secretYaml";
import type { ResourceStore } from "../kube/store";
import { errorMessage, type Logger, type ObjectTarget } from "../kube/types";
import type { ResourceRegistry } from "../resources/registry";
import { diffStats } from "../shared/diff";
import type { ResourceRef } from "../shared/view";
import { config } from "./config";
import type { FluxGuard, FluxPlan } from "./fluxGuard";
import type { ContextGuard } from "./protection";

export const YAML_SCHEME = "kubexplorer";
export const DESCRIBE_SCHEME = "kubexplorer-describe";
export const VIEW_SCHEME = "kubexplorer-view";
const CLUSTER_SCOPED = "_";
/** How long to wait for VS Code to read a kept document again. */
const RELOAD_TIMEOUT_MS = 5_000;
/** Suffix of the decoded YAML of a Secret (object names cannot hold spaces nor parentheses). */
const DECODED = " (decoded)";

/** decoded: a Secret, with its values in clear (Edit Decoded Values). */
export function resourceUri(scheme: string, context: string, ref: ResourceRef, extension: string, decoded = false): vscode.Uri {
  // The file name is not encoded: it is the tab title, and object names hold no slash nor percent sign.
  const file = `${ref.name}${decoded ? DECODED : ""}.${extension}`;
  const parts = [context, ref.resource, ref.namespace ?? CLUSTER_SCOPED].map(encodeURIComponent);
  return vscode.Uri.from({ scheme, path: `/${[...parts, file].join("/")}` });
}

interface ParsedUri {
  context: string;
  ref: ResourceRef;
  decoded: boolean;
}

function parseResourceUri(uri: vscode.Uri): ParsedUri {
  const [context, resource, namespace, file] = uri.path.slice(1).split("/").map(decodeURIComponent);
  if (!context || !resource || !namespace || !file) throw vscode.FileSystemError.FileNotFound(uri);
  const name = file.replace(/\.(yaml|txt)$/, "");
  const decoded = resource === "secrets" && name.endsWith(DECODED);
  return {
    context,
    ref: {
      resource,
      namespace: namespace === CLUSTER_SCOPED ? undefined : namespace,
      name: decoded ? name.slice(0, -DECODED.length) : name,
    },
    decoded,
  };
}

function objectTarget(registry: ResourceRegistry, uri: vscode.Uri): ParsedUri & { target: ObjectTarget } {
  const parsed = parseResourceUri(uri);
  const { ref } = parsed;
  const descriptor = registry.get(ref.resource);
  if (!descriptor) throw vscode.FileSystemError.FileNotFound(uri);
  return {
    ...parsed,
    target: { kubectlName: descriptor.kubectlName, namespaced: descriptor.namespaced, namespace: ref.namespace, name: ref.name },
  };
}

function display(ref: ResourceRef): string {
  return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

/** Closes the diff editors whose left side is `original`. */
async function closeDiff(original: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.toString() === original.toString());
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

export class ResourceFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly cache = new Map<string, { content: Uint8Array; mtime: number }>();
  /**
   * Documents being saved by apply(), after their review (writeFile does not ask again), with what to do first
   * (suspend the Flux objects that apply the object).
   */
  private readonly approved = new Map<string, FluxPlan>();
  /** Why each document is being saved (onWillSaveTextDocument): writeFile tells auto saves from explicit ones. */
  private readonly saveReasons = new Map<string, vscode.TextDocumentSaveReason>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly client: KubeClient,
    private readonly registry: ResourceRegistry,
    private readonly store: ResourceStore,
    private readonly documents: ReadonlyDocuments,
    private readonly guard: ContextGuard,
    private readonly flux: FluxGuard,
    private readonly log: Logger,
  ) {
    this.subscriptions = [
      vscode.workspace.onDidCloseTextDocument((doc) => this.cache.delete(doc.uri.toString())),
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.scheme === YAML_SCHEME) this.saveReasons.set(e.document.uri.toString(), e.reason);
      }),
    ];
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  // VS Code compares the mtime read when opening with the one returned when saving: it must stay
  // stable while the object is unchanged on the cluster, otherwise saving fails with "File Modified Since".
  // A read-only context (kubexplorer.protectedContexts) opens read-only editors.
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (!this.cache.has(uri.toString())) await this.readFile(uri);
    const cached = this.cache.get(uri.toString())!;
    const readOnly = this.guard.protection(parseResourceUri(uri).context) === "readOnly";
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: cached.mtime,
      size: cached.content.byteLength,
      permissions: readOnly ? vscode.FilePermission.Readonly : undefined,
    };
  }

  /** The YAML of the object on the cluster, decoded for a decoded Secret. */
  private async fetch(uri: vscode.Uri): Promise<string> {
    const { context, target, decoded } = objectTarget(this.registry, uri);
    const yaml = await this.client.getYaml(context, target);
    return decoded ? decodeSecretYaml(yaml) : yaml;
  }

  /**
   * Opens the YAML of an object. VS Code keeps a document for a while after its tab is closed, without asking the
   * file system again: unless it holds unsaved changes, such a document is read again from the cluster first.
   */
  async open(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const kept = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (kept && !kept.isDirty && (await this.fetch(uri)) !== kept.getText()) {
      const reloaded = new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          subscription.dispose();
          resolve();
        };
        const subscription = vscode.workspace.onDidChangeTextDocument((e) => e.document === kept && done());
        const timer = setTimeout(done, RELOAD_TIMEOUT_MS);
      });
      this.cache.delete(uri.toString());
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      await reloaded;
    }
    return vscode.workspace.openTextDocument(uri);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const content = new TextEncoder().encode(await this.fetch(uri));
      const previous = this.cache.get(uri.toString());
      const unchanged = previous && Buffer.compare(previous.content, content) === 0;
      this.cache.set(uri.toString(), { content, mtime: unchanged ? previous.mtime : Date.now() });
      return content;
    } catch (err) {
      throw vscode.FileSystemError.Unavailable(errorMessage(err));
    }
  }

  /**
   * Saves a document after a review: the diff against the cluster opens right away, under a dialog to apply
   * or cancel (Ctrl+S and the Apply button of kubexplorer:/ editors). Cancelling leaves the document dirty,
   * without an error.
   */
  async apply(document: vscode.TextDocument): Promise<void> {
    const { context, ref } = objectTarget(this.registry, document.uri);
    if (!document.isDirty) return;
    if (this.guard.protection(context) === "readOnly") return this.guard.refuse(context);
    const flux = await this.review(document.uri, context, ref, document.getText());
    if (!flux) {
      vscode.window.setStatusBarMessage(`$(close) ${vscode.l10n.t("Changes not applied")}`, 4000);
      return;
    }
    const key = document.uri.toString();
    this.approved.set(key, flux);
    try {
      await document.save();
    } finally {
      this.approved.delete(key);
    }
  }

  private needsConfirmation(context: string): boolean {
    return config.confirmApply() || this.guard.protection(context) === "confirm";
  }

  /**
   * Before applying: a warning when Flux applies the object (always: a change it undoes is worth knowing, whatever
   * kubexplorer.confirmApply), then the review of the changes (when confirmations are on). Undefined when cancelled.
   */
  private async review(uri: vscode.Uri, context: string, ref: ResourceRef, edited: string): Promise<FluxPlan | undefined> {
    const flux = await this.flux.check(context, [ref], vscode.l10n.t("Apply"));
    if (!flux) return undefined;
    if (this.needsConfirmation(context) && !(await this.confirmChanges(uri, context, ref, edited))) return undefined;
    return flux;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { context, ref } = objectTarget(this.registry, uri);
    const edited = new TextDecoder().decode(content);
    const key = uri.toString();
    const reason = this.saveReasons.get(key);
    this.saveReasons.delete(key);
    let plan = this.approved.get(key);
    const approved = !!plan;
    // Throwing cancels the save: the document stays dirty and nothing is sent.
    if (this.guard.protection(context) === "readOnly")
      throw vscode.FileSystemError.NoPermissions(vscode.l10n.t("{0} is read-only (kubexplorer.protectedContexts)", context));
    // Auto save (files.autoSave: after a delay, or when the editor loses focus) never reaches the cluster: it would
    // apply half-typed YAML, or ask for a review at every pause. Only explicit saves apply (Ctrl+S, File > Save).
    if (!approved && reason !== undefined && reason !== vscode.TextDocumentSaveReason.Manual)
      throw vscode.FileSystemError.NoPermissions(
        vscode.l10n.t("Auto save does not apply changes to the cluster: press Ctrl+S to review and apply them"),
      );
    // Explicit saves that do not go through apply() (File > Save, Save All) are reviewed here.
    plan ??= await this.review(uri, context, ref, edited);
    if (!plan) throw vscode.FileSystemError.NoPermissions(vscode.l10n.t("Changes not applied"));
    try {
      await plan.prepare();
      const output = (await this.client.replaceYaml(context, edited)).trim();
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

  /**
   * Opens the diff between the object on the cluster and the edited document, then asks to apply: a dialog over
   * the diff, or the name to type on a protected context. The diff closes once answered.
   */
  private async confirmChanges(uri: vscode.Uri, context: string, ref: ResourceRef, edited: string): Promise<boolean> {
    let live: string | undefined;
    try {
      live = await this.fetch(uri);
    } catch (err) {
      this.log.warn(`Cannot read ${display(ref)} to compare it: ${errorMessage(err)}`);
    }
    const left = live === undefined ? undefined : this.documents.register(`${ref.name} (cluster).yaml`, live);
    if (left) await vscode.commands.executeCommand("vscode.diff", left, uri, vscode.l10n.t("{0}: cluster ↔ your changes", ref.name));
    try {
      const stats = live === undefined ? undefined : diffStats(live, edited);
      return await this.guard.confirm(context, {
        question: vscode.l10n.t("Apply your changes to {0}?", display(ref)),
        detail: [
          vscode.l10n.t("Context: {0}", context),
          stats ? vscode.l10n.t("{0} line(s) removed, {1} added: see the diff.", stats.removed, stats.added) : "",
          vscode.l10n.t("The object will be replaced (kubectl replace)."),
        ]
          .filter(Boolean)
          .join("\n"),
        verb: vscode.l10n.t("Apply"),
        expected: ref.name,
        modal: true,
      });
    } finally {
      if (left) await closeDiff(left);
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
    this.subscriptions.forEach((s) => s.dispose());
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

  /** A read-only document, to open (e.g. one side of a diff). */
  register(title: string, content: string): vscode.Uri {
    // A unique path: VS Code would otherwise show a cached document with the same name.
    const uri = vscode.Uri.from({ scheme: VIEW_SCHEME, path: `/${++this.serial}/${title}` });
    this.docs.set(uri.toString(), content);
    return uri;
  }

  async show(title: string, content: string, language?: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(this.register(title, content));
    if (language) await vscode.languages.setTextDocumentLanguage(doc, language);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
