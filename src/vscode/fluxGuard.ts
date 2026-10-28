// Changes on objects applied by Flux (resources/fluxOwner.ts): Flux undoes them at its next reconciliation. Before such
// a change, a warning says so and offers to suspend the Flux objects that apply them first, as `flux suspend` before a
// hotfix: they stay suspended until resumed (Resume, in their drawer).

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import { errorMessage, type KubeObject, type Logger } from "../kube/types";
import { type FluxOwner, fluxOwner, ownerLabel } from "../resources/fluxOwner";
import type { ResourceRegistry } from "../resources/registry";
import { forEachLimited } from "../shared/pool";
import type { ResourceRef } from "../shared/view";

export interface FluxGuardDeps {
  client: KubeClient;
  registry: ResourceRegistry;
  log: Logger;
}

/** What to do right before the change, once confirmed: nothing, or suspend the Flux objects that apply its targets. */
export interface FluxPlan {
  prepare(): Promise<void>;
}

const NOTHING: FluxPlan = { prepare: async () => {} };

/** Objects read at the same time (a bulk action may change many). */
const CONCURRENT_READS = 8;

function display(ref: { namespace?: string; name: string }): string {
  return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

export class FluxGuard {
  constructor(private readonly d: FluxGuardDeps) {}

  /** The objects, read from the cluster when not given; those that cannot be read are left out. */
  private async objects(context: string, refs: ResourceRef[]): Promise<KubeObject[]> {
    const found: KubeObject[] = [];
    await forEachLimited(refs, CONCURRENT_READS, async (ref) => {
      const desc = this.d.registry.get(ref.resource);
      if (!desc) return;
      try {
        const items = await this.d.client.list(context, desc, {
          namespaces: desc.namespaced && ref.namespace ? [ref.namespace] : [],
          fieldSelector: `metadata.name=${ref.name}`,
        });
        const obj = items.find((o) => o.metadata.name === ref.name);
        if (obj) found.push(obj);
      } catch (err) {
        this.d.log.warn(`Cannot read ${display(ref)} to know whether Flux manages it: ${errorMessage(err)}`);
      }
    });
    return found;
  }

  /**
   * Before a change of objects (`verb`, e.g. "Scale"): when Flux applies some of them, warns, and asks whether to go
   * on, to suspend their Flux objects first, or to cancel (undefined).
   */
  async check(context: string, refs: ResourceRef[], verb: string, known?: KubeObject[]): Promise<FluxPlan | undefined> {
    // Flux objects are no changes Flux undoes (their suspend field is no part of Git).
    if (!refs.length || refs.every((r) => r.resource.startsWith("flux:"))) return NOTHING;
    const objects = known ?? (await this.objects(context, refs));
    const managed = objects.filter((o) => fluxOwner(o));
    if (!managed.length) return NOTHING;
    const owners = [...new Map(managed.map((o) => fluxOwner(o)!).map((f) => [`${f.resource}/${f.namespace}/${f.name}`, f])).values()];
    const question =
      refs.length === 1
        ? vscode.l10n.t("{0} is managed by Flux", display(refs[0]))
        : managed.length === 1
          ? vscode.l10n.t("1 of these {0} objects is managed by Flux", refs.length)
          : vscode.l10n.t("{0} of these {1} objects are managed by Flux", managed.length, refs.length);
    const by = vscode.l10n.t("Applied by {0}.", owners.slice(0, 5).map(ownerLabel).join(", ") + (owners.length > 5 ? "…" : ""));
    const detail = [
      by,
      vscode.l10n.t(
        "Flux will undo this change at its next reconciliation. Make it in Git, or suspend the Flux object first (resume it once done).",
      ),
    ].join("\n\n");
    const anyway = vscode.l10n.t("{0} Anyway", verb);
    const suspend =
      owners.length === 1 ? vscode.l10n.t("Suspend {0}, then {1}", owners[0].kind, verb) : vscode.l10n.t("Suspend Them, then {0}", verb);
    const choice = await vscode.window.showWarningMessage(question, { modal: true, detail }, suspend, anyway);
    if (choice === anyway) return NOTHING;
    if (choice === suspend) return { prepare: () => this.suspend(context, owners) };
    return undefined;
  }

  private async suspend(context: string, owners: FluxOwner[]): Promise<void> {
    for (const owner of owners) {
      const desc = this.d.registry.require(owner.resource);
      const target = { kubectlName: desc.kubectlName, namespaced: true, namespace: owner.namespace, name: owner.name };
      const patch = desc.patches.suspend!(
        { metadata: { name: owner.name, namespace: owner.namespace, uid: "" } },
        new Date().toISOString(),
      );
      await this.d.client.patch(context, target, patch);
      this.d.log.info(`${ownerLabel(owner)} (${context}) suspended before a direct change`);
    }
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Suspended {0}: Flux leaves your change alone until you resume it.", owners.map(ownerLabel).join(", ")),
    );
  }
}
