// Flux actions on several clusters at once (Fleet tab): pick the clusters, confirm (a name to type when one of
// them is protected; read-only ones are left out), then run on a bounded number of clusters at a time, with a
// cancellable progress notification.

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import { errorMessage, type KubeObject, type Logger } from "../kube/types";
import type { FleetAction } from "../panel/fleetController";
import type { FleetScanner } from "../panel/fleetScanner";
import { isFailing, type MatrixRow } from "../resources/fleet";
import type { ResourceRegistry } from "../resources/registry";
import { forEachLimited } from "../shared/pool";
import { config } from "./config";
import type { ContextGuard } from "./protection";

export interface FleetActionsDeps {
  client: KubeClient;
  registry: ResourceRegistry;
  scanner: FleetScanner;
  guard: ContextGuard;
  log: Logger;
}

/** Flux needs a few seconds to act on a request: the clusters are scanned again after… */
const RESCAN_DELAY_MS = 5_000;

function verb(action: FleetAction): string {
  if (action === "suspend") return vscode.l10n.t("Suspend");
  if (action === "resume") return vscode.l10n.t("Resume");
  return vscode.l10n.t("Reconcile");
}

export class FleetActions {
  constructor(private readonly d: FleetActionsDeps) {}

  /** The clusters a row offers for an action, by scope; the first scope is the default one. */
  private scopes(action: FleetAction, row: MatrixRow): { label: string; detail?: string; contexts: string[] }[] {
    const cells = Object.entries(row.cells);
    const eligible = cells.filter(([, o]) => (action === "resume" ? o.state === "Suspended" : o.state !== "Suspended")).map(([c]) => c);
    const groupOf = new Map(this.d.scanner.list().map((s) => [s.context, s.group]));
    const groups = [...new Set(eligible.map((c) => groupOf.get(c) ?? ""))].filter(Boolean);
    const failing = cells.filter(([, o]) => isFailing(o)).map(([c]) => c);
    return [
      { label: vscode.l10n.t("Every cluster ({0})", eligible.length), contexts: eligible },
      ...(groups.length > 1
        ? groups.map((g) => {
            const contexts = eligible.filter((c) => groupOf.get(c) === g);
            return { label: vscode.l10n.t("Group {0} ({1})", g, contexts.length), contexts };
          })
        : []),
      ...(action === "reconcile" && failing.length ? [{ label: vscode.l10n.t("Not ready ({0})", failing.length), contexts: failing }] : []),
    ].filter((s) => s.contexts.length);
  }

  private async pickClusters(action: FleetAction, row: MatrixRow): Promise<string[] | undefined> {
    const scopes = this.scopes(action, row);
    const choose = vscode.l10n.t("Choose the clusters...");
    const pick = await vscode.window.showQuickPick(
      [...scopes.map((s) => ({ ...s, label: `$(server-environment) ${s.label}` })), { label: `$(checklist) ${choose}`, contexts: [] }],
      {
        title: vscode.l10n.t("{0} {1} {2}/{3}: on which clusters?", verb(action), row.kind, row.namespace, row.name),
      },
    );
    if (!pick) return undefined;
    if (pick.contexts.length) return pick.contexts;
    const all = scopes[0]?.contexts ?? [];
    const picks = await vscode.window.showQuickPick(
      all.map((context) => ({ label: context, description: row.cells[context]?.state, picked: false })),
      { title: vscode.l10n.t("Clusters"), canPickMany: true },
    );
    return picks?.map((p) => p.label);
  }

  /** Reconcile, suspend or resume a Flux object on the clusters the user picks. */
  async flux(action: FleetAction, row: MatrixRow): Promise<void> {
    if (!this.d.registry.get(row.resource)?.patches[action]) return;
    const picked = await this.pickClusters(action, row);
    if (!picked?.length) return;
    const readOnly = picked.filter((c) => this.d.guard.protection(c) === "readOnly");
    const contexts = picked.filter((c) => !readOnly.includes(c));
    if (!contexts.length) {
      void vscode.window.showErrorMessage(vscode.l10n.t("KubeXplorer: every chosen cluster is read-only (kubexplorer.protectedContexts)."));
      return;
    }
    const listed =
      contexts.slice(0, 10).join("\n") + (contexts.length > 10 ? `\n${vscode.l10n.t("… and {0} more", contexts.length - 10)}` : "");
    const skipped = readOnly.length ? `\n\n${vscode.l10n.t("Left out, read-only: {0}", readOnly.join(", "))}` : "";
    const confirmed = await this.d.guard.confirmMany(contexts, {
      question: vscode.l10n.t("{0} {1} {2}/{3} on {4} cluster(s)?", verb(action), row.kind, row.namespace, row.name, contexts.length),
      detail: `${listed}${skipped}`,
      verb: verb(action),
      expected: row.name,
      // Reconciling only asks Flux to do its job sooner.
      modal: action !== "reconcile",
    });
    if (!confirmed) return;
    await this.run(action, row, contexts);
  }

  /** Runs a confirmed action on clusters, a bounded number at a time; failures are gathered and reported. */
  async run(action: FleetAction, row: MatrixRow, contexts: string[]): Promise<{ ok: number; failures: string[] }> {
    const descriptor = this.d.registry.require(row.resource);
    const build = descriptor.patches[action];
    if (!build) throw new Error(`${row.kind} does not support ${action}`);
    const target = { kubectlName: descriptor.kubectlName, namespaced: descriptor.namespaced, namespace: row.namespace, name: row.name };
    const object: KubeObject = {
      apiVersion: row.apiVersion,
      kind: row.kind,
      metadata: { name: row.name, namespace: row.namespace, uid: "" },
    };
    const failures: string[] = [];
    let done = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${verb(action)} ${row.name}`, cancellable: true },
      (progress, token) =>
        forEachLimited(
          contexts,
          config.fleetConcurrency(),
          async (context) => {
            try {
              await this.d.client.patch(context, target, build(object, new Date().toISOString()));
            } catch (err) {
              failures.push(`${context}: ${errorMessage(err).split("\n")[0]}`);
            }
            progress.report({ increment: 100 / contexts.length, message: `${++done}/${contexts.length}` });
          },
          () => token.isCancellationRequested,
        ),
    );
    const ok = done - failures.length;
    this.d.log.info(
      `Fleet ${action} ${row.key}: ${ok}/${contexts.length} cluster(s)${failures.length ? `; failed: ${failures.join("; ")}` : ""}`,
    );
    if (failures.length) {
      const showLog = vscode.l10n.t("Show Log");
      void vscode.window
        .showWarningMessage(vscode.l10n.t("{0}: done on {1} cluster(s), failed on {2}.", verb(action), ok, failures.length), showLog)
        .then((choice) => choice === showLog && vscode.commands.executeCommand("kubexplorer.showLog"));
    } else vscode.window.setStatusBarMessage(`$(check) ${verb(action)} ${row.name}: ${vscode.l10n.t("{0} cluster(s)", ok)}`, 5000);
    setTimeout(() => void this.d.scanner.scan(contexts), RESCAN_DELAY_MS);
    return { ok, failures };
  }
}
