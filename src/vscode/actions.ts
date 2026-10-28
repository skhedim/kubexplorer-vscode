// Actions on resources, with native VS Code interactions
// (modal confirmations, input boxes, quick picks, notifications, progress).
// ResourceActions dispatches them: the changes (patches, scale, restart, delete, bulk actions, Secret values) are here,
// the sessions (logs, shells, port forwards…) in sessionActions.ts, Helm in helmActions.ts.

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import type { HelmClient } from "../kube/helm";
import type { PortForwardManager } from "../kube/portForward";
import type { ResourceStore } from "../kube/store";
import { errorMessage, type KubeObject, type Logger, type ObjectTarget } from "../kube/types";
import type { ResourceRegistry } from "../resources/registry";
import { shortContextName } from "../shared/clusterNames";
import { encodeBase64 } from "../shared/encoding";
import type { RowMenuContext } from "../shared/protocol";
import type { ActionId, ResourceRef } from "../shared/view";
import { DESCRIBE_SCHEME, type ReadonlyDocuments, type ResourceFileSystem, resourceUri, YAML_SCHEME } from "./documents";
import type { FluxGuard, FluxPlan } from "./fluxGuard";
import { HelmActions } from "./helmActions";
import { display, listed, objectTarget, readObject } from "./objects";
import type { ContextGuard } from "./protection";
import { SessionActions } from "./sessionActions";
import type { Terminals } from "./terminals";

export interface ActionTarget {
  context: string;
  ref: ResourceRef;
  container?: string;
}

export interface ActionDeps {
  client: KubeClient;
  helm: HelmClient;
  portForwards: PortForwardManager;
  registry: ResourceRegistry;
  store: ResourceStore;
  terminals: Terminals;
  documents: ReadonlyDocuments;
  files: ResourceFileSystem;
  guard: ContextGuard;
  flux: FluxGuard;
  log: Logger;
}

/** Normalizes a command argument: a webview context menu, or an internal call. */
export function toTarget(arg: unknown): ActionTarget | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const a = arg as Partial<RowMenuContext & ActionTarget>;
  if (a.kubexplorerContext && a.kubexplorerResource && a.kubexplorerName) {
    return {
      context: a.kubexplorerContext,
      ref: { resource: a.kubexplorerResource, namespace: a.kubexplorerNamespace, name: a.kubexplorerName },
    };
  }
  if (a.context && a.ref) return { context: a.context, ref: a.ref, container: a.container };
  return undefined;
}

function actionLabel(action: ActionId, ref: ResourceRef): string {
  switch (action) {
    case "logs":
      return `$(output) ${vscode.l10n.t("Logs")}`;
    case "shell":
      return `$(terminal) ${vscode.l10n.t("Shell")}`;
    case "debug":
      return `$(debug) ${vscode.l10n.t("Debug...")}`;
    case "nodeShell":
      return `$(terminal-linux) ${vscode.l10n.t("Node Shell...")}`;
    case "portForward":
      return `$(plug) ${vscode.l10n.t("Forward Port...")}`;
    case "openBrowser":
      return `$(link-external) ${vscode.l10n.t("Open in Browser")}`;
    case "scale":
      return `$(arrow-both) ${vscode.l10n.t("Scale...")}`;
    case "restart":
      return `$(debug-restart) ${vscode.l10n.t("Restart")}`;
    case "trigger":
      return `$(play) ${vscode.l10n.t("Trigger Now")}`;
    case "reconcile":
      return `$(sync) ${vscode.l10n.t("Reconcile")}`;
    case "suspend":
      return `$(debug-pause) ${vscode.l10n.t("Suspend")}`;
    case "resume":
      return `$(debug-continue) ${vscode.l10n.t("Resume")}`;
    case "cordon":
      return `$(circle-slash) ${vscode.l10n.t("Cordon")}`;
    case "uncordon":
      return `$(pass) ${vscode.l10n.t("Uncordon")}`;
    case "drain":
      return `$(clear-all) ${vscode.l10n.t("Drain...")}`;
    case "rollback":
      return `$(discard) ${vscode.l10n.t("Rollback...")}`;
    case "values":
      return `$(symbol-property) ${vscode.l10n.t("Values")}`;
    case "manifest":
      return `$(file-code) ${vscode.l10n.t("Manifest")}`;
    case "install":
      return `$(cloud-download) ${vscode.l10n.t("Install...")}`;
    case "edit":
      return `$(edit) ${vscode.l10n.t("Edit YAML")}`;
    case "editDecoded":
      return `$(unlock) ${vscode.l10n.t("Edit Decoded Values")}`;
    case "describe":
      return `$(info) ${vscode.l10n.t("Describe")}`;
    case "copyName":
      return `$(copy) ${vscode.l10n.t("Copy Name")}`;
    case "stop":
      return `$(debug-stop) ${vscode.l10n.t("Stop")}`;
    case "delete":
      return `$(trash) ${ref.resource === "helmreleases" ? vscode.l10n.t("Uninstall...") : vscode.l10n.t("Delete...")}`;
  }
}

/** Verb of the actions performed by a merge patch (Flux, CronJobs, nodes), for confirmations. */
function patchVerb(action: ActionId): string {
  if (action === "suspend") return vscode.l10n.t("Suspend");
  if (action === "resume") return vscode.l10n.t("Resume");
  if (action === "cordon") return vscode.l10n.t("Cordon");
  if (action === "uncordon") return vscode.l10n.t("Uncordon");
  return vscode.l10n.t("Reconcile");
}

/** Patch actions that Flux undoes on the objects it applies: suspending a CronJob (cordoning a node is no Git matter). */
const FLUX_UNDONE: ReadonlySet<ActionId> = new Set<ActionId>(["suspend", "resume"]);

export class ResourceActions {
  private readonly sessions: SessionActions;
  private readonly helmActions: HelmActions;

  constructor(private readonly d: ActionDeps) {
    this.sessions = new SessionActions({ ...d, copyText: (text) => this.copyText(text) });
    this.helmActions = new HelmActions(d);
  }

  private objectTarget(ref: ResourceRef): ObjectTarget {
    return objectTarget(this.d.registry, ref);
  }

  private fetch(context: string, ref: ResourceRef): Promise<KubeObject> {
    return readObject(this.d.client, this.d.registry, context, ref);
  }

  /** Runs an action; errors are logged and notified, never propagated to the UI. */
  async run(action: ActionId, target: ActionTarget): Promise<void> {
    try {
      if (!this.d.guard.allows(target.context, action)) return;
      await this.dispatch(action, target);
    } catch (err) {
      this.reportError(`${action} ${target.ref.resource}/${display(target.ref)} (${target.context})`, err);
    }
  }

  async copyText(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`$(copy) ${vscode.l10n.t("Copied to the clipboard")}`, 3000);
  }

  private reportError(what: string, err: unknown): void {
    const message = errorMessage(err);
    this.d.log.error(`${what}: ${message}`);
    const showLog = vscode.l10n.t("Show Log");
    void vscode.window.showErrorMessage(vscode.l10n.t("KubeXplorer: {0}", message), showLog).then((choice) => {
      if (choice === showLog) void vscode.commands.executeCommand("kubexplorer.showLog");
    });
  }

  private async dispatch(action: ActionId, { context, ref, container }: ActionTarget): Promise<void> {
    switch (action) {
      case "logs":
        return this.sessions.logs(context, ref, container);
      case "shell":
        return this.sessions.shell(context, ref, container);
      case "debug":
        return this.sessions.debug(context, ref, container);
      case "nodeShell":
        return this.sessions.nodeShell(context, ref);
      case "drain":
        return this.sessions.drain(context, [ref]);
      case "portForward":
        return this.sessions.portForward(context, ref);
      case "openBrowser": {
        const pf = this.d.portForwards.get(ref.name);
        if (!pf?.localPort) throw new Error(vscode.l10n.t("This port forward is not active"));
        return this.sessions.openBrowser(pf.localPort);
      }
      case "stop":
        this.d.portForwards.stop(ref.name);
        return;
      case "edit":
      case "editDecoded": {
        const doc = await this.d.files.open(resourceUri(YAML_SCHEME, context, ref, "yaml", action === "editDecoded"));
        await vscode.languages.setTextDocumentLanguage(doc, "yaml");
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
      case "describe": {
        const doc = await vscode.workspace.openTextDocument(resourceUri(DESCRIBE_SCHEME, context, ref, "txt"));
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case "copyName":
        return this.copyText(ref.name);
      case "delete":
        return this.deleteRefs(context, [ref]);
      case "scale":
        return this.scale(context, ref);
      case "restart":
        return this.restart(context, ref);
      case "trigger": {
        const confirmed = await this.d.guard.confirm(context, {
          question: vscode.l10n.t("Create a Job from CronJob {0}?", display(ref)),
          detail: vscode.l10n.t("Context: {0}", context),
          verb: vscode.l10n.t("Trigger Now"),
          expected: ref.name,
          modal: false,
        });
        if (!confirmed) return;
        const job = await this.d.client.triggerCronJob(context, ref.namespace ?? "default", ref.name);
        void vscode.window.showInformationMessage(vscode.l10n.t("Job {0} created from {1}.", job, ref.name));
        this.d.store.refresh(context);
        return;
      }
      case "values":
        return this.helmActions.values(context, ref);
      case "manifest":
        return this.helmActions.manifest(context, ref);
      case "rollback":
        return this.helmActions.rollback(context, ref);
      case "install":
        return this.helmActions.install(context, ref);
      case "reconcile":
      case "suspend":
      case "resume":
      case "cordon":
      case "uncordon":
        return this.patchAction(action, context, ref);
    }
  }

  /** Actions performed by a merge patch of the descriptor (Flux reconcile, suspend and resume, CronJobs, nodes). */
  private async patchAction(action: ActionId, context: string, ref: ResourceRef): Promise<void> {
    const descriptor = this.d.registry.require(ref.resource);
    const flux = FLUX_UNDONE.has(action) ? await this.d.flux.check(context, [ref], patchVerb(action)) : undefined;
    if (FLUX_UNDONE.has(action) && !flux) return;
    const confirmed = await this.d.guard.confirm(context, {
      question: vscode.l10n.t("{0} {1} {2}?", patchVerb(action), descriptor.kindName, display(ref)),
      detail: vscode.l10n.t("Context: {0}", context),
      verb: patchVerb(action),
      expected: ref.name,
      modal: false,
    });
    if (!confirmed) return;
    await flux?.prepare();
    await this.patchOne(action, context, ref);
    const done: Partial<Record<ActionId, string>> = {
      reconcile: vscode.l10n.t("Reconciliation of {0} requested", display(ref)),
      suspend: vscode.l10n.t("{0} suspended", display(ref)),
      resume: vscode.l10n.t("{0} resumed", display(ref)),
      cordon: vscode.l10n.t("{0} cordoned: no new pod is scheduled on it", display(ref)),
      uncordon: vscode.l10n.t("{0} uncordoned", display(ref)),
    };
    vscode.window.setStatusBarMessage(`$(check) ${done[action] ?? display(ref)}`, 4000);
    this.d.store.refresh(context);
  }

  private async patchOne(action: ActionId, context: string, ref: ResourceRef): Promise<void> {
    const descriptor = this.d.registry.require(ref.resource);
    const build = descriptor.patches[action];
    if (!build) throw new Error(vscode.l10n.t("{0} does not support this action", descriptor.kindName));
    const obj = await this.fetch(context, ref);
    await this.d.client.patch(context, this.objectTarget(ref), build(obj, new Date().toISOString()));
  }

  // ---------------- Workloads ----------------

  private async scale(context: string, ref: ResourceRef): Promise<void> {
    const obj = await this.fetch(context, ref);
    const current: number = obj.spec?.replicas ?? 0;
    const kind = this.d.registry.require(ref.resource).kindName;
    const value = await vscode.window.showInputBox({
      title: vscode.l10n.t("Scale {0} {1}", kind, display(ref)),
      prompt: vscode.l10n.t("Number of replicas (currently {0}), context {1}", current, context),
      value: String(current),
      validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) <= 1000 ? undefined : vscode.l10n.t("An integer between 0 and 1000")),
    });
    if (value === undefined || Number(value) === current) return;
    const replicas = Number(value);
    const flux = await this.d.flux.check(context, [ref], vscode.l10n.t("Scale"), [obj]);
    if (!flux) return;
    const confirmed = await this.d.guard.confirm(context, {
      question: vscode.l10n.t("Scale {0} to {1} replicas?", display(ref), replicas),
      detail: replicas === 0 ? vscode.l10n.t("The workload will be unavailable.") : vscode.l10n.t("Context: {0}", context),
      verb: replicas === 0 ? vscode.l10n.t("Scale to 0") : vscode.l10n.t("Scale"),
      expected: ref.name,
      modal: replicas === 0,
    });
    if (!confirmed) return;
    await flux.prepare();
    await this.d.client.scale(context, this.objectTarget(ref), replicas);
    void vscode.window.showInformationMessage(vscode.l10n.t("{0}: {1} → {2} replica(s).", display(ref), current, replicas));
    this.d.store.refresh(context);
  }

  private async restart(context: string, ref: ResourceRef): Promise<void> {
    const kind = this.d.registry.require(ref.resource).kindName;
    const confirmed = await this.d.guard.confirm(context, {
      question: vscode.l10n.t("Restart {0} {1}?", kind, display(ref)),
      detail: vscode.l10n.t("Context: {0}\nSame as kubectl rollout restart.", context),
      verb: vscode.l10n.t("Restart"),
      expected: ref.name,
      modal: true,
    });
    if (!confirmed) return;
    await this.d.client.restart(context, this.objectTarget(ref));
    void vscode.window.showInformationMessage(vscode.l10n.t("{0} restarted.", display(ref)));
    this.d.store.refresh(context);
  }

  // ---------------- Bulk actions and deletion ----------------

  /** An action on the checked rows of a list (BULK_ACTIONS); errors are notified. */
  async runMany(context: string, action: ActionId, refs: ResourceRef[]): Promise<void> {
    if (refs.length <= 1) {
      if (refs.length) await this.run(action, { context, ref: refs[0] });
      return;
    }
    try {
      if (!this.d.guard.allows(context, action)) return;
      const kind = this.d.registry.require(refs[0].resource).kindName;
      switch (action) {
        case "delete":
          return await this.deleteRefs(context, refs);
        case "restart":
          return await this.runEach(
            context,
            refs,
            {
              question: vscode.l10n.t("Restart {0} objects of kind {1}?", refs.length, kind),
              verb: vscode.l10n.t("Restart"),
              note: vscode.l10n.t("Same as kubectl rollout restart."),
              modal: true,
            },
            (ref) => this.d.client.restart(context, this.objectTarget(ref)),
          );
        case "scale":
          return await this.scaleMany(context, refs, kind);
        case "reconcile":
        case "suspend":
        case "resume":
        case "cordon":
        case "uncordon": {
          const flux = FLUX_UNDONE.has(action) ? await this.d.flux.check(context, refs, patchVerb(action)) : undefined;
          if (FLUX_UNDONE.has(action) && !flux) return;
          return await this.runEach(
            context,
            refs,
            {
              question: vscode.l10n.t("{0} {1} objects of kind {2}?", patchVerb(action), refs.length, kind),
              verb: patchVerb(action),
              // Reconciling only asks Flux to do its job sooner.
              modal: action !== "reconcile",
              flux,
            },
            (ref) => this.patchOne(action, context, ref),
          );
        }
        case "drain":
          return await this.sessions.drain(context, refs);
        default:
          throw new Error(vscode.l10n.t("This action applies to one object at a time"));
      }
    } catch (err) {
      this.reportError(`${action} (${context})`, err);
    }
  }

  /**
   * Confirms then runs an operation on several objects (one at a time), and refreshes the lists.
   * On a protected context, the name to type is the one of the object, or of the cluster for several.
   */
  private async runEach(
    context: string,
    refs: ResourceRef[],
    c: { question: string; verb: string; note?: string; modal: boolean; flux?: FluxPlan },
    op: (ref: ResourceRef) => Promise<void>,
  ): Promise<void> {
    const confirmed = await this.d.guard.confirm(context, {
      question: c.question,
      detail: [listed(refs), "", vscode.l10n.t("Context: {0}", context), ...(c.note ? [c.note] : [])].join("\n"),
      verb: c.verb,
      expected: refs.length === 1 ? refs[0].name : shortContextName(context),
      modal: c.modal,
    });
    if (!confirmed) return;
    await c.flux?.prepare();
    const failures: string[] = [];
    for (const ref of refs) {
      try {
        await op(ref);
      } catch (err) {
        failures.push(`${display(ref)}: ${errorMessage(err)}`);
      }
    }
    this.d.store.refresh(context);
    if (failures.length) throw new Error(vscode.l10n.t("The action failed on some objects:\n{0}", failures.join("\n")));
    vscode.window.setStatusBarMessage(
      `$(check) ${c.verb}: ${refs.length === 1 ? display(refs[0]) : vscode.l10n.t("{0} objects", refs.length)}`,
      4000,
    );
  }

  private async scaleMany(context: string, refs: ResourceRef[], kind: string): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: vscode.l10n.t("Scale {0} objects of kind {1}", refs.length, kind),
      prompt: vscode.l10n.t("Number of replicas of each one, context {0}", context),
      validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) <= 1000 ? undefined : vscode.l10n.t("An integer between 0 and 1000")),
    });
    if (value === undefined) return;
    const replicas = Number(value);
    const flux = await this.d.flux.check(context, refs, vscode.l10n.t("Scale"));
    if (!flux) return;
    await this.runEach(
      context,
      refs,
      {
        question: vscode.l10n.t("Scale {0} objects of kind {1} to {2} replicas?", refs.length, kind, replicas),
        verb: replicas === 0 ? vscode.l10n.t("Scale to 0") : vscode.l10n.t("Scale"),
        note: replicas === 0 ? vscode.l10n.t("The workloads will be unavailable.") : undefined,
        modal: true,
        flux,
      },
      (ref) => this.d.client.scale(context, this.objectTarget(ref), replicas),
    );
  }

  private async deleteRefs(context: string, refs: ResourceRef[]): Promise<void> {
    const resource = refs[0].resource;
    if (resource === "portforwards") {
      refs.forEach((r) => this.d.portForwards.stop(r.name));
      return;
    }
    const helm = resource === "helmreleases";
    const kind = this.d.registry.require(resource).kindName;
    const verb = helm ? vscode.l10n.t("Uninstall") : vscode.l10n.t("Delete");
    // Flux applies it again at its next reconciliation.
    const flux = helm ? undefined : await this.d.flux.check(context, refs, verb);
    if (!helm && !flux) return;
    await this.runEach(
      context,
      refs,
      {
        question:
          refs.length === 1
            ? vscode.l10n.t("{0} {1} {2}?", verb, kind, display(refs[0]))
            : vscode.l10n.t("{0} {1} objects of kind {2}?", verb, refs.length, kind),
        verb,
        note: helm ? vscode.l10n.t("Every resource of the release will be deleted (helm uninstall).") : undefined,
        modal: true,
        flux,
      },
      (ref) =>
        helm ? this.d.helm.uninstall(context, ref.namespace ?? "default", ref.name) : this.d.client.delete(context, this.objectTarget(ref)),
    );
  }

  /**
   * Changes one value of a Secret (edited in the drawer). The whole Secret goes through kubectl replace on
   * stdin: the value never shows up in a command line, and a concurrent change fails on its resourceVersion.
   */
  async updateSecretValue(context: string, ref: ResourceRef, key: string, value: string): Promise<boolean> {
    if (this.d.guard.protection(context) === "readOnly") {
      this.d.guard.refuse(context);
      return false;
    }
    const current = await this.fetch(context, ref);
    const flux = await this.d.flux.check(context, [ref], vscode.l10n.t("Save"), [current]);
    if (!flux) return false;
    const confirmed = await this.d.guard.confirm(context, {
      question: vscode.l10n.t("Change {0} in Secret {1}?", key, display(ref)),
      detail: vscode.l10n.t("Context: {0}", context),
      verb: vscode.l10n.t("Save"),
      expected: ref.name,
      modal: false,
    });
    if (!confirmed) return false;
    await flux.prepare();
    // Read again: the latest resourceVersion, so that a concurrent change fails rather than being overwritten.
    const secret = await this.fetch(context, ref);
    const { managedFields: _, ...metadata } = secret.metadata;
    const updated = { ...secret, apiVersion: "v1", kind: "Secret", metadata, data: { ...secret.data, [key]: encodeBase64(value) } };
    await this.d.client.replaceYaml(context, JSON.stringify(updated));
    this.d.log.info(`Secret ${display(ref)} (${context}): ${key} updated`);
    vscode.window.setStatusBarMessage(`$(check) ${vscode.l10n.t("{0} updated in {1}", key, display(ref))}`, 4000);
    this.d.store.refresh(context);
    return true;
  }

  /** The ⋮ menu of a row: the same actions as the context menu, in a quick pick. */
  async rowMenu(context: string, ref: ResourceRef, actions: ActionId[]): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      actions.map((action) => ({ label: actionLabel(action, ref), action })),
      { title: `${this.d.registry.require(ref.resource).kindName} ${display(ref)}`, placeHolder: vscode.l10n.t("Action") },
    );
    if (pick) await this.run(pick.action, { context, ref });
  }
}
