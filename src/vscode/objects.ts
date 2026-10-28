// How the actions name the objects in their dialogs, and read them from their cluster.

import * as vscode from "vscode";
import type { KubeClient } from "../kube/client";
import type { KubeObject, ObjectTarget } from "../kube/types";
import type { ResourceRegistry } from "../resources/registry";
import type { ResourceRef } from "../shared/view";

/** "namespace/name", or the name of a cluster-scoped object. */
export function display(ref: { namespace?: string; name: string }): string {
  return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

/** The objects of a bulk action, for a confirmation. */
export function listed(refs: ResourceRef[]): string {
  return refs.slice(0, 8).map(display).join("\n") + (refs.length > 8 ? `\n${vscode.l10n.t("… and {0} more", refs.length - 8)}` : "");
}

export function objectTarget(registry: ResourceRegistry, ref: ResourceRef): ObjectTarget {
  const descriptor = registry.require(ref.resource);
  return { kubectlName: descriptor.kubectlName, namespaced: descriptor.namespaced, namespace: ref.namespace, name: ref.name };
}

/** An object, read from its cluster; throws when it is gone. */
export async function readObject(client: KubeClient, registry: ResourceRegistry, context: string, ref: ResourceRef): Promise<KubeObject> {
  const descriptor = registry.require(ref.resource);
  const items = await client.list(context, descriptor, {
    namespaces: ref.namespace ? [ref.namespace] : [],
    fieldSelector: `metadata.name=${ref.name}`,
  });
  // Virtual lists (Helm, port forwards) ignore fieldSelector.
  const obj = items.find((o) => o.metadata.name === ref.name && (!descriptor.namespaced || o.metadata.namespace === ref.namespace));
  if (!obj) throw new Error(vscode.l10n.t("{0} {1} not found", descriptor.kindName, display(ref)));
  return obj;
}
