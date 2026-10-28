// The actions on Helm charts and releases: values, manifest, rollback and install. Dispatched by ResourceActions.

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import type { HelmClient } from "../kube/helm";
import type { ResourceStore } from "../kube/store";
import type { KubeObject, Logger } from "../kube/types";
import type { ResourceRegistry } from "../resources/registry";
import type { ResourceRef } from "../shared/view";
import type { ReadonlyDocuments } from "./documents";
import { display, readObject } from "./objects";
import type { ContextGuard } from "./protection";

export interface HelmActionDeps {
  client: KubeClient;
  helm: HelmClient;
  registry: ResourceRegistry;
  store: ResourceStore;
  documents: ReadonlyDocuments;
  guard: ContextGuard;
  log: Logger;
}

const RELEASE_NAME = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/;
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export class HelmActions {
  constructor(private readonly d: HelmActionDeps) {}

  private fetch(context: string, ref: ResourceRef): Promise<KubeObject> {
    return readObject(this.d.client, this.d.registry, context, ref);
  }

  async manifest(context: string, ref: ResourceRef): Promise<void> {
    const manifest = await this.d.helm.manifest(context, ref.namespace ?? "default", ref.name);
    return this.d.documents.show(`${ref.name}-manifest.yaml`, manifest, "yaml");
  }

  async values(context: string, ref: ResourceRef): Promise<void> {
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

  async rollback(context: string, ref: ResourceRef): Promise<void> {
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
    const confirmed = await this.d.guard.confirm(context, {
      question: vscode.l10n.t("Roll {0} back to revision {1}?", display(ref), pick.revision),
      detail: vscode.l10n.t("Context: {0}\nhelm rollback creates a new revision.", context),
      verb: vscode.l10n.t("Roll Back"),
      expected: ref.name,
      modal: true,
    });
    if (!confirmed) return;
    await this.d.helm.rollback(context, namespace, ref.name, pick.revision);
    void vscode.window.showInformationMessage(vscode.l10n.t("{0} rolled back to revision {1}.", display(ref), pick.revision));
    this.d.store.refresh(context);
  }

  async install(context: string, ref: ResourceRef): Promise<void> {
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
    const confirmed = await this.d.guard.confirm(context, {
      question: vscode.l10n.t('Install {0} {1} as "{2}"?', ref.name, chart.helm.version, release),
      detail,
      verb: installLabel,
      expected: release,
      modal: true,
    });
    if (!confirmed) return;
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
}
