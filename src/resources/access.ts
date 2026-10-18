// Access Control: Service Accounts, Roles, Bindings.

import type { PolicyRule, Subject } from "../kube/models";
import type { KubeObject } from "../kube/types";
import type { DetailItem } from "../shared/view";
import { defineResource } from "./descriptor";
import { mono } from "./format";

function subjects(o: KubeObject): string {
  return (o.subjects ?? []).map((s: Subject) => `${s.kind}:${s.namespace ? `${s.namespace}/` : ""}${s.name}`).join(", ");
}

function rules(o: KubeObject): DetailItem[] {
  return (o.rules ?? []).map((r: PolicyRule, i: number) => ({
    name: `Rule ${i + 1}`,
    value: mono(
      `${(r.verbs ?? []).join(",")} → ${[...(r.resources ?? []), ...(r.nonResourceURLs ?? [])].join(",")}${r.apiGroups?.length ? ` [${r.apiGroups.map((g: string) => g || "core").join(",")}]` : ""}`,
    ),
  }));
}

export const serviceaccounts = defineResource({
  id: "serviceaccounts",
  title: "Service Accounts",
  kindName: "ServiceAccount",
  namespaced: true,
});

export const clusterroles = defineResource({
  id: "clusterroles",
  kubectlName: "clusterroles.rbac.authorization.k8s.io",
  title: "Cluster Roles",
  kindName: "ClusterRole",
  namespaced: false,
  columns: [{ id: "rules", title: "Rules", grow: 0.4, value: (o) => String(o.rules?.length ?? 0), sort: (o) => o.rules?.length ?? 0 }],
  items: rules,
});

export const roles = defineResource({
  id: "roles",
  kubectlName: "roles.rbac.authorization.k8s.io",
  title: "Roles",
  kindName: "Role",
  namespaced: true,
  columns: [{ id: "rules", title: "Rules", grow: 0.4, value: (o) => String(o.rules?.length ?? 0), sort: (o) => o.rules?.length ?? 0 }],
  items: rules,
});

export const clusterrolebindings = defineResource({
  id: "clusterrolebindings",
  kubectlName: "clusterrolebindings.rbac.authorization.k8s.io",
  title: "Cluster Role Bindings",
  kindName: "ClusterRoleBinding",
  namespaced: false,
  columns: [
    { id: "role", title: "Role", grow: 1.2, value: (o) => `${o.roleRef?.kind}/${o.roleRef?.name}` },
    { id: "subjects", title: "Bindings", grow: 2, value: subjects },
  ],
});

export const rolebindings = defineResource({
  id: "rolebindings",
  kubectlName: "rolebindings.rbac.authorization.k8s.io",
  title: "Role Bindings",
  kindName: "RoleBinding",
  namespaced: true,
  columns: [
    { id: "role", title: "Role", grow: 1.2, value: (o) => `${o.roleRef?.kind}/${o.roleRef?.name}` },
    { id: "subjects", title: "Bindings", grow: 2, value: subjects },
  ],
});
