// The actions that open a session on what runs: logs, shells, debug containers, node shells and drains (in terminals),
// and port forwards. Dispatched by ResourceActions.

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import { type ForwardedResource, type PortForward, type PortForwardManager, suggestLocalPort } from "../kube/portForward";
import type { KubeObject } from "../kube/types";
import { selectorString } from "../resources/format";
import type { ResourceRegistry } from "../resources/registry";
import { shortContextName } from "../shared/clusterNames";
import type { ResourceRef } from "../shared/view";
import { config } from "./config";
import { display, listed, readObject } from "./objects";
import type { ContextGuard } from "./protection";
import type { Terminals } from "./terminals";

export interface SessionDeps {
  client: KubeClient;
  registry: ResourceRegistry;
  portForwards: PortForwardManager;
  terminals: Terminals;
  guard: ContextGuard;
  copyText(text: string): Promise<void>;
}

/** Images offered for debug containers, after the one of the settings. */
const DEBUG_IMAGES = ["busybox:1.37", "nicolaka/netshoot"];

const PORT_PATTERN = /^\d+$/;
const isPort = (s: string) => PORT_PATTERN.test(s) && Number(s) > 0 && Number(s) < 65_536;

export class SessionActions {
  constructor(private readonly d: SessionDeps) {}

  private fetch(context: string, ref: ResourceRef): Promise<KubeObject> {
    return readObject(this.d.client, this.d.registry, context, ref);
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

  async logs(context: string, ref: ResourceRef, preset?: string): Promise<void> {
    if (ref.resource !== "pods") return this.workloadLogs(context, ref, preset);
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

  /** The logs of every pod of a workload, like stern: kubectl logs -l <selector> --prefix. */
  private async workloadLogs(context: string, ref: ResourceRef, preset?: string): Promise<void> {
    const obj = await this.fetch(context, ref);
    const kind = this.d.registry.require(ref.resource).kindName;
    const selector = selectorString(obj.spec?.selector?.matchLabels);
    if (!selector) throw new Error(vscode.l10n.t("{0} {1} has no label selector", kind, display(ref)));
    const template: KubeObject = { metadata: obj.metadata, spec: obj.spec?.template?.spec };
    const container = await this.pickContainer(template, true, preset);
    if (container === undefined) return;
    this.d.terminals.showLogs(context, {
      namespace: ref.namespace ?? "default",
      pod: `${kind.toLowerCase()}/${ref.name}`,
      selector,
      container: container ?? undefined,
      previous: false,
      follow: true,
      tailLines: config.logTailLines(),
    });
  }

  /** An ephemeral container (kubectl debug), sharing the processes of a container of the pod. */
  async debug(context: string, ref: ResourceRef, preset?: string): Promise<void> {
    const pod = await this.fetch(context, ref);
    const container = await this.pickContainer(pod, false, preset);
    if (!container) return;
    const images = [...new Set([config.debugImage(), ...DEBUG_IMAGES])];
    const pick = await vscode.window.showQuickPick(
      [
        ...images.map((image) => ({ label: `$(package) ${image}`, image })),
        { label: `$(edit) ${vscode.l10n.t("Other image...")}`, image: "" },
      ],
      {
        title: vscode.l10n.t("Debug container for {0}", `${ref.name} › ${container}`),
        placeHolder: vscode.l10n.t("Image of the ephemeral container"),
      },
    );
    if (!pick) return;
    let image = pick.image;
    if (!image) {
      const value = await vscode.window.showInputBox({
        title: vscode.l10n.t("Image of the ephemeral container"),
        placeHolder: "registry/image:tag",
        validateInput: (v) => (/^\S+$/.test(v.trim()) ? undefined : vscode.l10n.t("An image reference")),
      });
      if (!value) return;
      image = value.trim();
    }
    const confirmed = await this.d.guard.confirm(context, {
      question: vscode.l10n.t("Add a debug container to {0}?", display(ref)),
      detail: vscode.l10n.t("Image {0}, sharing the processes of {1}. Context: {2}", image, container, context),
      verb: vscode.l10n.t("Debug"),
      expected: ref.name,
      modal: false,
    });
    if (!confirmed) return;
    if (!this.d.terminals.showDebug(context, ref.namespace ?? "default", ref.name, container, image)) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Debug containers are not available on the demo cluster."));
    }
  }

  /** A root shell on a node: a privileged pod in its namespaces (nsenter), deleted when the shell exits. */
  async nodeShell(context: string, ref: ResourceRef): Promise<void> {
    const image = config.debugImage();
    const confirmed = await this.d.guard.confirm(context, {
      question: vscode.l10n.t("Open a root shell on node {0}?", ref.name),
      detail: vscode.l10n.t(
        "A privileged pod of image {0}, in kube-system, enters the namespaces of the node; it is deleted when you exit the shell. Context: {1}",
        image,
        context,
      ),
      verb: vscode.l10n.t("Open Shell"),
      expected: ref.name,
      modal: true,
    });
    if (!confirmed) return;
    if (!this.d.terminals.showNodeShell(context, ref.name, image))
      void vscode.window.showInformationMessage(vscode.l10n.t("Node shells are not available on the demo cluster."));
  }

  /** kubectl drain, in a terminal: it can take minutes (disruption budgets), and stops with Ctrl+C. */
  async drain(context: string, refs: ResourceRef[]): Promise<void> {
    const nodes = refs.map((r) => r.name);
    const confirmed = await this.d.guard.confirm(context, {
      question: nodes.length === 1 ? vscode.l10n.t("Drain node {0}?", nodes[0]) : vscode.l10n.t("Drain {0} nodes?", nodes.length),
      detail: [
        ...(nodes.length > 1 ? [listed(refs), ""] : []),
        vscode.l10n.t(
          "Cordons, then evicts every pod but those of DaemonSets (the data of emptyDir volumes is lost); disruption budgets are respected. Follow it in the terminal.",
        ),
        vscode.l10n.t("Context: {0}", context),
      ].join("\n"),
      verb: vscode.l10n.t("Drain"),
      expected: nodes.length === 1 ? nodes[0] : shortContextName(context),
      modal: true,
    });
    if (!confirmed) return;
    if (!this.d.terminals.showDrain(context, nodes))
      void vscode.window.showInformationMessage(vscode.l10n.t("Draining is not available on the demo cluster."));
  }

  async shell(context: string, ref: ResourceRef, preset?: string): Promise<void> {
    const pod = await this.fetch(context, ref);
    const container = await this.pickContainer(pod, false, preset);
    if (!container) return;
    if (!this.d.terminals.showShell(context, ref.namespace ?? "default", ref.name, container)) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Shells are not available on the demo cluster."));
    }
  }

  // ---------------- Port forwarding ----------------

  async portForward(context: string, ref: ResourceRef): Promise<void> {
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
    if (choice === copy) await this.d.copyText(url);
  }

  async openBrowser(port: number): Promise<void> {
    // asExternalUri: in WSL or remote sessions, VS Code exposes the port on the client machine.
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${port}`));
    await vscode.env.openExternal(uri);
  }
}
