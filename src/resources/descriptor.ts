// Declarative descriptor of a resource type: columns, details and actions.
// Adding a type = calling defineResource() and registering the result in registry.ts.

import type { HelmClient } from "../kube/helm";
import type { KindTarget, KubeObject } from "../kube/types";
import type { MetricsScope } from "./charts";
import type { ActionId, Cell, ColumnDef, DetailItem, Details, DetailSection, Row } from "../shared/view";
import { cellText, formatAge, metadataItems } from "./format";

/**
 * Objects of other lists the rendering depends on (e.g. pod metrics), indexed by "namespace/name".
 * Provided by the controller, which subscribes to the lists declared in `related`.
 */
export interface RowContext {
  related: Record<string, Map<string, KubeObject>>;
}

const emptyRowContext: RowContext = { related: {} };

function relatedKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? ""}/${name}`;
}

/** The object related to `o` in the `resource` list (same namespace and name). */
export function relatedOf(rc: RowContext | undefined, resource: string, o: KubeObject): KubeObject | undefined {
  return rc?.related[resource]?.get(relatedKey(o.metadata.namespace, o.metadata.name));
}

export function indexRelated(items: KubeObject[]): Map<string, KubeObject> {
  return new Map(items.map((o) => [relatedKey(o.metadata.namespace, o.metadata.name), o]));
}

export interface ColumnSpec {
  id: string;
  title: string;
  grow?: number;
  width?: number;
  value(o: KubeObject, rc: RowContext): Cell;
  /** Sort key; when missing, the cell text is used. false = not sortable. */
  sort?: ((o: KubeObject, rc: RowContext) => string | number) | false;
}

/** What a descriptor needs to build details that depend on other objects. */
export interface DetailContext {
  context: string;
  list(resource: string, opts: { namespaces: string[]; labelSelector?: string; fieldSelector?: string }): Promise<KubeObject[]>;
  /** Renders rows of another kind (e.g. the pods of a Deployment) with the compact columns of that kind. */
  rowsOf(resource: string, items: KubeObject[]): { columns: ColumnDef[]; rows: Row[] };
  /** Current related lists (metrics…), for the details. */
  rowContext?: RowContext;
  helm?: HelmClient;
}

export interface ResourceDescriptor extends KindTarget {
  id: string;
  title: string;
  kindName: string;
  columns: ColumnDef[];
  compactColumns: ColumnDef[];
  hasWarnings: boolean;
  defaultSort: { col: string; desc: boolean };
  /** Lists the rows depend on (registry identifiers). */
  related: string[];
  toRow(o: KubeObject, rc?: RowContext): Row;
  toCompactRow(o: KubeObject, rc?: RowContext): Row;
  details(o: KubeObject, ctx: DetailContext): Promise<Details>;
  actions: ActionId[];
  /** A CRD-based kind that may not be installed: menus and overview pages skip it when its CRD is missing. */
  optional: boolean;
  /** Actions performed by a merge patch (e.g. Flux reconcile), built from the object and the current time. */
  patches: Partial<Record<ActionId, (o: KubeObject, now: string) => object>>;
  /** What the usage charts of an object cover (the pod itself, the pods of a workload, a node). */
  metrics?(o: KubeObject, ctx: DetailContext): Promise<MetricsScope | undefined>;
}

export interface ResourceSpec {
  id: string;
  kubectlName?: string;
  title: string;
  kindName: string;
  namespaced: boolean;
  /** Columns between Namespace and Age. */
  columns?: ColumnSpec[];
  /** Columns after Age (e.g. the Status of pods, like in Freelens). */
  endColumns?: ColumnSpec[];
  /** Subset of columns (ids) used by tables nested in a drawer. */
  compact?: string[];
  showName?: boolean;
  nameGrow?: number;
  /** Title of the Age column (e.g. "Updated" for Helm releases). */
  ageTitle?: string;
  /** false: no Age column (objects without a date, e.g. Helm charts). */
  showAge?: boolean;
  warning?(o: KubeObject): string | undefined;
  /** Kind-specific actions, listed before the common ones. */
  actions?: ActionId[];
  /** Common actions; edit, describe, copyName and delete by default (Kubernetes objects). */
  commonActions?: ActionId[];
  /** Hides an action for one object (e.g. Resume on an object that is not suspended). */
  hideAction?(o: KubeObject, action: ActionId): boolean;
  patches?: ResourceDescriptor["patches"];
  optional?: boolean;
  /** Usage charts at the top of the drawer. */
  metrics?(o: KubeObject, ctx: DetailContext): Promise<MetricsScope | undefined>;
  related?: string[];
  /** See KindTarget.minPollIntervalMs. */
  minPollIntervalMs?: number;
  defaultSort?: { col: string; desc: boolean };
  /** Replaces the Kubernetes metadata at the top of the drawer (virtual objects: Helm, port forwards). */
  header?(o: KubeObject): DetailItem[];
  detailsTitle?(o: KubeObject): string;
  /** Extra rows of the main block, after the metadata. */
  items?(o: KubeObject, rc: RowContext): DetailItem[];
  /** Sections after the main block (containers, related pods…). */
  sections?(o: KubeObject, ctx: DetailContext): DetailSection[] | Promise<DetailSection[]>;
}

const COMMON_ACTIONS: ActionId[] = ["edit", "describe", "copyName", "delete"];

export function defineResource(spec: ResourceSpec): ResourceDescriptor {
  const all: ColumnSpec[] = [];
  if (spec.showName !== false) all.push({ id: "name", title: "Name", grow: spec.nameGrow ?? 2, value: (o) => o.metadata.name });
  if (spec.warning) all.push({ id: "warning", title: "", width: 32, value: () => "", sort: false });
  if (spec.namespaced) all.push({ id: "namespace", title: "Namespace", grow: 1, value: (o) => o.metadata.namespace ?? "" });
  all.push(...(spec.columns ?? []));
  if (spec.showAge !== false)
    all.push({
      id: "age",
      title: spec.ageTitle ?? "Age",
      grow: 0.5,
      value: (o) => ({ text: formatAge(o.metadata.creationTimestamp), title: o.metadata.creationTimestamp }),
      // Sorted by creation date (the most recent has the smallest age).
      sort: (o) => -Date.parse(o.metadata.creationTimestamp ?? "0"),
    });
  all.push(...(spec.endColumns ?? []));

  const toDef = (c: ColumnSpec): ColumnDef => ({ id: c.id, title: c.title, grow: c.grow, width: c.width, sortable: c.sort !== false });
  const compactSpecs = spec.compact
    ? all.filter((c) => spec.compact!.includes(c.id))
    : all.filter((c) => c.id !== "namespace" && c.id !== "warning");
  const actions = [...(spec.actions ?? []), ...(spec.commonActions ?? COMMON_ACTIONS)];
  const actionsOf = (o: KubeObject) => (spec.hideAction ? actions.filter((a) => !spec.hideAction!(o, a)) : actions);

  function build(o: KubeObject, specs: ColumnSpec[], rc: RowContext = emptyRowContext): Row {
    const cells: Record<string, Cell> = {};
    const sort: Record<string, string | number> = {};
    for (const c of specs) {
      const cell = c.value(o, rc);
      cells[c.id] = cell;
      if (c.sort !== false) sort[c.id] = c.sort ? c.sort(o, rc) : cellText(cell);
    }
    const ref = { resource: spec.id, namespace: o.metadata.namespace, name: o.metadata.name };
    return {
      uid: o.metadata.uid,
      ref,
      cells,
      sort,
      search: [o.metadata.name, o.metadata.namespace, ...Object.values(o.metadata.labels ?? {}), ...Object.values(cells).map(cellText)]
        .join(" ")
        .toLowerCase(),
      warning: spec.warning?.(o),
      actions: actionsOf(o),
    };
  }

  return {
    id: spec.id,
    kubectlName: spec.kubectlName ?? spec.id,
    namespaced: spec.namespaced,
    minPollIntervalMs: spec.minPollIntervalMs,
    title: spec.title,
    kindName: spec.kindName,
    columns: all.map(toDef),
    compactColumns: compactSpecs.map(toDef),
    hasWarnings: !!spec.warning,
    defaultSort: spec.defaultSort ?? { col: spec.showName === false ? "age" : "name", desc: false },
    related: spec.related ?? [],
    actions,
    optional: !!spec.optional,
    patches: spec.patches ?? {},
    metrics: spec.metrics,
    toRow: (o, rc) => build(o, all, rc),
    toCompactRow: (o, rc) => build(o, compactSpecs, rc),
    async details(o, ctx) {
      const rc = ctx.rowContext ?? emptyRowContext;
      const head = spec.header ? spec.header(o) : metadataItems(o);
      const sections: DetailSection[] = [
        ...(spec.metrics ? [{ type: "metrics" } as const] : []),
        { type: "items", items: [...head, ...(spec.items?.(o, rc) ?? [])] },
      ];
      if (spec.sections) sections.push(...(await spec.sections(o, ctx)));
      return {
        uid: o.metadata.uid,
        ref: { resource: spec.id, namespace: o.metadata.namespace, name: o.metadata.name },
        kindName: spec.kindName,
        title: spec.detailsTitle?.(o) ?? `${spec.kindName}: ${o.metadata.name}`,
        actions: actionsOf(o),
        sections,
      };
    },
  };
}
