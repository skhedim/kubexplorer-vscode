// Actions on resources, with native VS Code interactions
// (modal confirmations, input boxes, quick picks, notifications, progress).

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import type { HelmClient } from "../kube/helm";
import { type ForwardedResource, type PortForward, type PortForwardManager, suggestLocalPort } from "../kube/portForward";
import type { ResourceStore } from "../kube/store";
import { errorMessage, type KubeObject, type Logger, type ObjectTarget } from "../kube/types";
import type { ResourceRegistry } from "../resources/registry";
import type { RowMenuContext } from "../shared/protocol";
import type { ActionId, ResourceRef } from "../shared/view";
import { config } from "./config";
import { DESCRIBE_SCHEME, type ReadonlyDocuments, resourceUri, YAML_SCHEME } from "./documents";
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

function display(ref: ResourceRef): string {
  return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

const PORT_PATTERN = /^\d+$/;
const isPort = (s: string) => PORT_PATTERN.test(s) && Number(s) > 0 && Number(s) < 65_536;
const RELEASE_NAME = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/;
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export class ResourceActions {
  constructor(private readonly d: ActionDeps) {}

  private objectTarget(ref: ResourceRef): ObjectTarget {
    const descriptor = this.d.registry.require(ref.resource);
    return { kubectlName: descriptor.kubectlName, namespaced: descriptor.namespaced, namespace: ref.namespace, name: ref.name };
  }

  private async fetch(context: string, ref: ResourceRef): Promise<KubeObject> {
    const descriptor = this.d.registry.require(ref.resource);
    const items = await this.d.client.list(context, descriptor, {
      namespaces: ref.namespace ? [ref.namespace] : [],
      fieldSelector: `metadata.name=${ref.name}`,
    });
    // Virtual lists (Helm, port forwards) ignore fieldSelector.
    const obj = items.find((o) => o.metadata.name === ref.name && (!descriptor.namespaced || o.metadata.namespace === ref.namespace));
    if (!obj) throw new Error(vscode.l10n.t("{0} {1} not found", descriptor.kindName, display(ref)));
    return obj;
  }

  /** Runs an action; errors are logged and notified, never propagated to the UI. */
  async run(action: ActionId, target: ActionTarget): Promise<void> {
    try {
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
        return this.logs(context, ref, container);
      case "shell":
        return this.shell(context, ref, container);
      case "portForward":
        return this.portForward(context, ref);
      case "openBrowser": {
        const pf = this.d.portForwards.get(ref.name);
        if (!pf?.localPort) throw new Error(vscode.l10n.t("This port forward is not active"));
        return this.openBrowser(pf.localPort);
      }
      case "stop":
        this.d.portForwards.stop(ref.name);
        return;
      case "edit": {
        const doc = await vscode.workspace.openTextDocument(resourceUri(YAML_SCHEME, context, ref, "yaml"));
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
        const job = await this.d.client.triggerCronJob(context, ref.namespace ?? "default", ref.name);
        void vscode.window.showInformationMessage(vscode.l10n.t("Job {0} created from {1}.", job, ref.name));
        this.d.store.refresh(context);
        return;
      }
      case "values":
        return this.values(context, ref);
      case "manifest": {
        const manifest = await this.d.helm.manifest(context, ref.namespace ?? "default", ref.name);
        return this.d.documents.show(`${ref.name}-manifest.yaml`, manifest, "yaml");
      }
      case "rollback":
        return this.rollback(context, ref);
      case "install":
        return this.install(context, ref);
    }
  }

  // ---------------- Pods: containers, logs, shell ----------------

  /** Picks a container; null means "all containers" (when allowed), undefined means cancelled. */
  private async pickContainer(pod: KubeObject, allowAll: boolean, preset?: string): Promise<string | null | undefined> {
    if (preset) return preset;
    const containers: { name: string; init?: boolean }[] = [
      ...(pod.spec?.initContainers ?? []).map((c: { name: string }) => ({ name: c.name, init: true })),
      ...(pod.spec?.containers ?? []),
    ];
    if (containers.length === 1) return containers[0].name;
    const items = [
      ...(allowAll ? [{ label: `$(list-flat) ${vscode.l10n.t("All containers")}`, value: null as string | null }] : []),
      ...containers
        .filter((c) => allowAll || !c.init)
        .map((c) => ({ label: `$(symbol-misc) ${c.name}`, description: c.init ? "init" : undefined, value: c.name as string | null })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Container of {0}", pod.metadata.name),
      placeHolder: vscode.l10n.t("Pick a container"),
    });
    return pick ? pick.value : undefined;
  }

  private async logs(context: string, ref: ResourceRef, preset?: string): Promise<void> {
    const pod = await this.fetch(context, ref);
    const container = await this.pickContainer(pod, true, preset);
    if (container === undefined) return;
    const restarts = (pod.status?.containerStatuses ?? []).find((s: { name: string }) => s.name === container)?.restartCount ?? 0;
    let previous = false;
    if (container && restarts > 0) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: `$(play) ${vscode.l10n.t("Current container")}`, value: false },
          {
            label: `$(history) ${vscode.l10n.t("Previous container")}`,
            description: vscode.l10n.t("{0} restart(s)", restarts),
            value: true,
          },
        ],
        { title: vscode.l10n.t("Which logs?") },
      );
      if (!pick) return;
      previous = pick.value;
    }
    this.d.terminals.showLogs(context, {
      namespace: ref.namespace ?? "default",
      pod: ref.name,
      container: container ?? undefined,
      previous,
      follow: true,
      tailLines: config.logTailLines(),
    });
  }

  private async shell(context: string, ref: ResourceRef, preset?: string): Promise<void> {
    const pod = await this.fetch(context, ref);
    const container = await this.pickContainer(pod, false, preset);
    if (!container) return;
    if (!this.d.terminals.showShell(context, ref.namespace ?? "default", ref.name, container)) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Shells are not available on the demo cluster."));
    }
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
    if (replicas === 0) {
      const scaleDown = vscode.l10n.t("Scale to 0");
      const ok = await vscode.window.showWarningMessage(
        vscode.l10n.t("Scale {0} to 0 replicas?", display(ref)),
        { modal: true, detail: vscode.l10n.t("The workload will be unavailable.") },
        scaleDown,
      );
      if (ok !== scaleDown) return;
    }
    await this.d.client.scale(context, this.objectTarget(ref), replicas);
    void vscode.window.showInformationMessage(vscode.l10n.t("{0}: {1} → {2} replica(s).", display(ref), current, replicas));
    this.d.store.refresh(context);
  }

  private async restart(context: string, ref: ResourceRef): Promise<void> {
    const kind = this.d.registry.require(ref.resource).kindName;
    const restart = vscode.l10n.t("Restart");
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t("Restart {0} {1}?", kind, display(ref)),
      { modal: true, detail: vscode.l10n.t("Context: {0}\nSame as kubectl rollout restart.", context) },
      restart,
    );
    if (ok !== restart) return;
    await this.d.client.restart(context, this.objectTarget(ref));
    void vscode.window.showInformationMessage(vscode.l10n.t("{0} restarted.", display(ref)));
    this.d.store.refresh(context);
  }

  // ---------------- Port forwarding ----------------

  private async portForward(context: string, ref: ResourceRef): Promise<void> {
    const obj = await this.fetch(context, ref);
    const resource: ForwardedResource = ref.resource === "services" ? "services" : "pods";
    const ports: { port: number; label: string }[] =
      resource === "services"
        ? (obj.spec?.ports ?? []).map((p: { port: number; name?: string; targetPort?: number | string; protocol?: string }) => ({
            port: p.port,
            label: `${p.port}${p.name ? ` (${p.name})` : ""} → ${p.targetPort ?? p.port}/${p.protocol ?? "TCP"}`,
          }))
        : (obj.spec?.containers ?? []).flatMap((c: { name: string; ports?: { containerPort: number; name?: string }[] }) =>
            (c.ports ?? []).map((p) => ({ port: p.containerPort, label: `${p.containerPort}${p.name ? ` (${p.name})` : ""} — ${c.name}` })),
          );
    const pick = await vscode.window.showQuickPick(
      [
        ...ports.map((p) => ({ label: `$(plug) ${p.label}`, port: p.port })),
        { label: `$(edit) ${vscode.l10n.t("Other port...")}`, port: 0 },
      ],
      {
        title: vscode.l10n.t("Forward a port of {0}", display(ref)),
        placeHolder: ports.length ? vscode.l10n.t("Remote port") : vscode.l10n.t("No declared port: enter one"),
      },
    );
    if (!pick) return;
    let remote = pick.port;
    if (!remote) {
      const value = await vscode.window.showInputBox({
        title: vscode.l10n.t("Remote port"),
        validateInput: (s) => (isPort(s) ? undefined : vscode.l10n.t("A port between 1 and 65535")),
      });
      if (!value) return;
      remote = Number(value);
    }
    const local = await vscode.window.showInputBox({
      title: vscode.l10n.t("Local port for {0}:{1}", display(ref), remote),
      prompt: vscode.l10n.t("Leave empty to let kubectl pick a free port"),
      value: String(suggestLocalPort(remote)),
      validateInput: (s) => (s === "" || isPort(s) ? undefined : vscode.l10n.t("A port between 1 and 65535, or empty")),
    });
    if (local === undefined) return;
    const pf = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Forwarding {0}:{1}...", display(ref), remote) },
      () => this.d.portForwards.start(context, ref.namespace ?? "default", resource, ref.name, remote, local ? Number(local) : 0),
    );
    void this.announce(pf);
  }

  private async announce(pf: PortForward): Promise<void> {
    const url = `http://localhost:${pf.localPort}`;
    const open = vscode.l10n.t("Open in Browser");
    const copy = vscode.l10n.t("Copy URL");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t("{0}:{1} is available at {2}", `${pf.namespace}/${pf.name}`, pf.remotePort, url),
      open,
      copy,
    );
    if (choice === open) await this.openBrowser(pf.localPort!);
    if (choice === copy) await this.copyText(url);
  }

  private async openBrowser(port: number): Promise<void> {
    // asExternalUri: in WSL or remote sessions, VS Code exposes the port on the client machine.
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${port}`));
    await vscode.env.openExternal(uri);
  }

  // ---------------- Helm ----------------

  private async values(context: string, ref: ResourceRef): Promise<void> {
    if (ref.resource === "helmcharts") {
      const chart = await this.fetch(context, ref);
      const values = await this.d.helm.showChart(ref.name, "values", chart.helm.version);
      return this.d.documents.show(`${ref.name.replace("/", "-")}-${chart.helm.version}-values.yaml`, values, "yaml");
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: `$(person) ${vscode.l10n.t("User-supplied values")}`, description: "helm get values", all: false },
        { label: `$(list-tree) ${vscode.l10n.t("All computed values")}`, description: "helm get values --all", all: true },
      ],
      { title: vscode.l10n.t("Values of {0}", display(ref)) },
    );
    if (!pick) return;
    const values = await this.d.helm.values(context, ref.namespace ?? "default", ref.name, pick.all);
    return this.d.documents.show(`${ref.name}-values${pick.all ? "-all" : ""}.yaml`, values, "yaml");
  }

  private async rollback(context: string, ref: ResourceRef): Promise<void> {
    const namespace = ref.namespace ?? "default";
    const history = await this.d.helm.history(context, namespace, ref.name);
    const current = history.at(-1)?.revision;
    const pick = await vscode.window.showQuickPick(
      [...history]
        .reverse()
        .filter((h) => h.revision !== current)
        .map((h) => ({
          label: `$(history) ${vscode.l10n.t("Revision {0}", h.revision)}`,
          description: `${h.chart} · ${h.status}`,
          detail: `${h.description} — ${new Date(h.updated).toLocaleString()}`,
          revision: h.revision,
        })),
      {
        title: vscode.l10n.t("Roll back {0} (current revision: {1})", display(ref), current ?? "?"),
        placeHolder: vscode.l10n.t("Target revision"),
      },
    );
    if (!pick) return;
    const rollback = vscode.l10n.t("Roll Back");
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t("Roll {0} back to revision {1}?", display(ref), pick.revision),
      { modal: true, detail: vscode.l10n.t("Context: {0}\nhelm rollback creates a new revision.", context) },
      rollback,
    );
    if (ok !== rollback) return;
    await this.d.helm.rollback(context, namespace, ref.name, pick.revision);
    void vscode.window.showInformationMessage(vscode.l10n.t("{0} rolled back to revision {1}.", display(ref), pick.revision));
    this.d.store.refresh(context);
  }

  private async install(context: string, ref: ResourceRef): Promise<void> {
    const chart = await this.fetch(context, ref);
    const release = await vscode.window.showInputBox({
      title: vscode.l10n.t("Install {0} {1}", ref.name, chart.helm.version),
      prompt: vscode.l10n.t("Release name"),
      value: chart.helm.chart,
      validateInput: (s) =>
        RELEASE_NAME.test(s) ? undefined : vscode.l10n.t("Lowercase letters, digits and dashes, 53 characters at most"),
    });
    if (!release) return;
    const namespace = await vscode.window.showInputBox({
      title: vscode.l10n.t("Namespace"),
      value: "default",
      validateInput: (s) => (NAMESPACE_NAME.test(s) ? undefined : vscode.l10n.t("Invalid namespace name")),
    });
    if (!namespace) return;
    const valuesPick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${vscode.l10n.t("Default values of the chart")}`, file: false },
        { label: `$(file) ${vscode.l10n.t("Pick a values.yaml file...")}`, file: true },
      ],
      { title: vscode.l10n.t("Values") },
    );
    if (!valuesPick) return;
    let valuesFile: string | undefined;
    if (valuesPick.file) {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { YAML: ["yaml", "yml"] }, title: "values.yaml" });
      if (!files?.length) return;
      valuesFile = files[0].fsPath;
    }
    const installLabel = vscode.l10n.t("Install");
    const detail = [
      vscode.l10n.t("Namespace: {0}", namespace),
      vscode.l10n.t("Context: {0}", context),
      valuesFile ? vscode.l10n.t("Values: {0}", valuesFile) : "",
    ]
      .filter(Boolean)
      .join("\n");
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t('Install {0} {1} as "{2}"?', ref.name, chart.helm.version, release),
      { modal: true, detail },
      installLabel,
    );
    if (ok !== installLabel) return;
    const output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Installing {0}...", release) },
      () => this.d.helm.install(context, namespace, release, ref.name, chart.helm.version, valuesFile),
    );
    this.d.log.info(output);
    this.d.store.refresh(context);
    const showReleases = vscode.l10n.t("Show Releases");
    const choice = await vscode.window.showInformationMessage(vscode.l10n.t("{0} installed in {1}.", release, namespace), showReleases);
    if (choice === showReleases) await vscode.commands.executeCommand("kubexplorer.openResource", "helmreleases");
  }

  // ---------------- Deletion ----------------

  /** Deletes (in bulk) after a confirmation; errors are notified. */
  async deleteMany(context: string, refs: ResourceRef[]): Promise<void> {
    if (!refs.length) return;
    try {
      await this.deleteRefs(context, refs);
    } catch (err) {
      this.reportError(`delete (${context})`, err);
    }
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
    const listed =
      refs.slice(0, 8).map(display).join("\n") + (refs.length > 8 ? `\n${vscode.l10n.t("… and {0} more", refs.length - 8)}` : "");
    const question =
      refs.length === 1
        ? vscode.l10n.t("{0} {1} {2}?", verb, kind, display(refs[0]))
        : vscode.l10n.t("{0} {1} objects of kind {2}?", verb, refs.length, kind);
    let detail = `${listed}\n\n${vscode.l10n.t("Context: {0}", context)}`;
    if (helm) detail += `\n${vscode.l10n.t("Every resource of the release will be deleted (helm uninstall).")}`;
    const ok = await vscode.window.showWarningMessage(question, { modal: true, detail }, verb);
    if (ok !== verb) return;
    const failures: string[] = [];
    for (const ref of refs) {
      try {
        if (helm) await this.d.helm.uninstall(context, ref.namespace ?? "default", ref.name);
        else await this.d.client.delete(context, this.objectTarget(ref));
      } catch (err) {
        failures.push(`${display(ref)}: ${errorMessage(err)}`);
      }
    }
    this.d.store.refresh(context);
    if (failures.length) throw new Error(vscode.l10n.t("Some objects could not be deleted:\n{0}", failures.join("\n")));
    vscode.window.setStatusBarMessage(`$(trash) ${refs.length === 1 ? display(refs[0]) : vscode.l10n.t("{0} objects", refs.length)}`, 4000);
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
