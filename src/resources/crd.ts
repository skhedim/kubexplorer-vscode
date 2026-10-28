// Custom Resources: the CRD list and a descriptor generated for each CRD.

import type { CrdVersion } from "../kube/models";
import type { KubeObject } from "../kube/types";
import type { Cell } from "../shared/view";
import { type ColumnSpec, defineResource, type ResourceDescriptor } from "./descriptor";
import { mono, since } from "./format";

export const customresourcedefinitions = defineResource({
  id: "customresourcedefinitions",
  kubectlName: "customresourcedefinitions.apiextensions.k8s.io",
  title: "Definitions",
  kindName: "CustomResourceDefinition",
  namespaced: false,
  nameGrow: 2.5,
  columns: [
    { id: "group", title: "Group", grow: 1.2, value: (o) => o.spec?.group ?? "" },
    { id: "version", title: "Version", grow: 0.5, value: (o) => (o.spec?.versions ?? []).find((v: CrdVersion) => v.storage)?.name ?? "" },
    { id: "scope", title: "Scope", grow: 0.6, value: (o) => o.spec?.scope ?? "" },
  ],
  items: (o) => [
    { name: "Group", value: o.spec?.group ?? "" },
    { name: "Kind", value: o.spec?.names?.kind ?? "" },
    { name: "Plural", value: o.spec?.names?.plural ?? "" },
    { name: "Scope", value: o.spec?.scope ?? "" },
    {
      name: "Versions",
      value: (o.spec?.versions ?? []).map((v: CrdVersion) => `${v.name}${v.served ? "" : " (not served)"}${v.storage ? " (storage)" : ""}`),
    },
  ],
});

/** Evaluates a simple printer column JSONPath (".spec.foo", ".status.conditions[0].type"). */
export function evalJsonPath(obj: unknown, path: string): unknown {
  const parts = path
    .replace(/^\{?\.?/, "")
    .replace(/\}$/, "")
    .split(/\.|\[(\d+)\]/)
    .filter((p) => p !== undefined && p !== "");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

interface PrinterColumn {
  name: string;
  type: string;
  jsonPath: string;
  priority?: number;
}

/** Registry identifier of a CRD: "crd:<plural>.<group>". */
export function crdResourceId(crd: KubeObject): string {
  return `crd:${crd.spec.names.plural}.${crd.spec.group}`;
}

export function crdDescriptor(crd: KubeObject): ResourceDescriptor {
  const version = (crd.spec.versions ?? []).find((v: CrdVersion) => v.storage) ?? crd.spec.versions?.[0];
  const printer: PrinterColumn[] = (version?.additionalPrinterColumns ?? []).filter((c: PrinterColumn) => !c.priority && c.name !== "Age");
  const columns: ColumnSpec[] = printer.map((c, i) => ({
    id: `pc${i}`,
    title: c.name,
    grow: 0.8,
    value: (o): Cell => {
      const v = evalJsonPath(o, c.jsonPath);
      if (v === undefined || v === null) return "";
      if (c.type === "date") return since(String(v));
      return typeof v === "object" ? mono(JSON.stringify(v)) : String(v);
    },
  }));
  return defineResource({
    id: crdResourceId(crd),
    kubectlName: `${crd.spec.names.plural}.${crd.spec.group}`,
    title: crd.spec.names.kind,
    kindName: crd.spec.names.kind,
    namespaced: crd.spec.scope === "Namespaced",
    columns,
  });
}
