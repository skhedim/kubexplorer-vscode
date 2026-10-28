// The state of a Flux object, from its conditions, like getConditionText of the Freelens Flux extension.

import type { KubeObject } from "../../kube/types";
import type { Cell, Tone } from "../../shared/view";

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

const CONDITION_PRIORITY: Record<string, number> = { ArtifactInStorage: 3, Released: 3, Synced: 4, Ready: 5 };

/** Newest first; on the same date, the most significant type first. */
export function sortConditions(conditions: Condition[]): Condition[] {
  const time = (c: Condition) => Date.parse(c.lastTransitionTime ?? "") || 0;
  return [...conditions].sort((a, b) => time(b) - time(a) || (CONDITION_PRIORITY[b.type] ?? 0) - (CONDITION_PRIORITY[a.type] ?? 0));
}

export const ANNOTATION_SUSPEND: Record<string, string> = {
  "fluxcd.controlplane.io": "fluxcd.controlplane.io/reconcile",
  "source.extensions.fluxcd.io": "source.extensions.fluxcd.io/reconcile",
};

export function apiGroup(o: KubeObject): string {
  return (o.apiVersion ?? "").split("/")[0];
}

/** Suspended through spec.suspend, or the reconcile annotation of the Flux Operator kinds. */
export function fluxSuspended(o: KubeObject): boolean {
  const annotation = ANNOTATION_SUSPEND[apiGroup(o)];
  return annotation ? o.metadata.annotations?.[annotation] === "disabled" : !!o.spec?.suspend;
}

export type FluxState = "Ready" | "Not Ready" | "Stalled" | "In Progress" | "Suspended" | "Unknown";

export function fluxState(o: KubeObject): FluxState {
  if (fluxSuspended(o)) return "Suspended";
  const conditions: Condition[] = o.status?.conditions ?? [];
  if (!conditions.length) return "Unknown";
  const ready = conditions.find((c) => c.type === "Ready");
  const reconciling = conditions.find((c) => c.type === "Reconciling" && c.status === "True");
  // Reconciling=True: a reconcile is in progress, even if Ready still reflects the previous one; but
  // ProgressingWithRetry means it failed and is retried later: as long as Ready is False, it is not ready.
  if (reconciling && !(reconciling.reason === "ProgressingWithRetry" && ready?.status === "False")) return "In Progress";
  if (ready) {
    if (ready.status === "True") return "Ready";
    if (conditions.some((c) => c.type === "Stalled" && c.status === "True")) return "Stalled";
    return ready.status === "False" ? "Not Ready" : "In Progress";
  }
  const last = sortConditions(conditions)[0];
  if (last.status === "False") return "Not Ready";
  return last.type === "Stalled" ? "Stalled" : "In Progress";
}

const STATE_TONE: Record<FluxState, Tone | undefined> = {
  Ready: "ok",
  "Not Ready": "error",
  Stalled: "error",
  "In Progress": "warning",
  Suspended: "info",
  Unknown: undefined,
};

export function stateCell(o: KubeObject): Cell {
  const state = fluxState(o);
  return { tags: [{ text: state, tone: STATE_TONE[state] }], solid: true };
}

export function statusMessage(o: KubeObject): string {
  const conditions: Condition[] = o.status?.conditions ?? [];
  return conditions.length ? (sortConditions(conditions)[0].message ?? "") : "";
}
