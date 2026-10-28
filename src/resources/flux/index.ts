// Flux (https://fluxcd.io), following the Freelens Flux extension: one list per kind with its status,
// details with the source, inventory, history, conditions and events, Reconcile / Suspend / Resume
// actions, and an overview page. Every kind is optional: it is shown only when its CRD is installed.
// status.ts: the state of an object; kind.ts: what every kind shares; the other modules: the kinds, by family.

import type { ResourceDescriptor } from "../descriptor";
import type { Tone } from "../../shared/view";
import { eventColumns, eventRows, type OverviewPage } from "../overview";
import { fluxHelmReleases, fluxKustomizations } from "./deploy";
import { fluxImagePolicies, fluxImageRepositories, fluxImageUpdateAutomations } from "./image";
import { fluxAlerts, fluxProviders, fluxReceivers } from "./notification";
import { fluxInstances, fluxReports, fluxResourceSetInputProviders, fluxResourceSets } from "./operator";
import {
  fluxArtifactGenerators,
  fluxBuckets,
  fluxExternalArtifacts,
  fluxGitRepositories,
  fluxHelmCharts,
  fluxHelmRepositories,
  fluxOciRepositories,
} from "./sources";
import { type FluxState, fluxState } from "./status";

export { fluxKustomizations } from "./deploy";
export { inventoryEntries } from "./kind";
export { type FluxState, fluxState } from "./status";

export const FLUX_KINDS: ResourceDescriptor[] = [
  fluxInstances,
  fluxReports,
  fluxResourceSets,
  fluxResourceSetInputProviders,
  fluxKustomizations,
  fluxHelmReleases,
  fluxGitRepositories,
  fluxHelmRepositories,
  fluxHelmCharts,
  fluxBuckets,
  fluxOciRepositories,
  fluxExternalArtifacts,
  fluxArtifactGenerators,
  fluxImageRepositories,
  fluxImagePolicies,
  fluxImageUpdateAutomations,
  fluxAlerts,
  fluxProviders,
  fluxReceivers,
];

// ---------- Overview ----------

/** The kinds charted on the overview, in the order of the Freelens extension. */
const CHARTED = [
  fluxKustomizations,
  fluxHelmReleases,
  fluxGitRepositories,
  fluxHelmRepositories,
  fluxHelmCharts,
  fluxBuckets,
  fluxOciRepositories,
  fluxExternalArtifacts,
  fluxArtifactGenerators,
  fluxImageRepositories,
  fluxImagePolicies,
  fluxImageUpdateAutomations,
  fluxResourceSets,
  fluxResourceSetInputProviders,
];

const SLICES: { state: FluxState; label: string; tone: Tone }[] = [
  { state: "Ready", label: "Ready", tone: "ok" },
  { state: "In Progress", label: "In Progress", tone: "warning" },
  { state: "Not Ready", label: "Not Ready", tone: "error" },
  { state: "Stalled", label: "Stalled", tone: "error" },
  { state: "Suspended", label: "Suspended", tone: "info" },
  { state: "Unknown", label: "Unknown", tone: "muted" },
];

export const fluxOverview: OverviewPage = {
  id: "flux",
  title: "Flux",
  resources: [...CHARTED.map((d) => d.id), "events"],
  build({ lists, missing }) {
    const charted = CHARTED.filter((d) => lists[d.id]);
    const donuts = charted.map((d) => {
      const counts = new Map<FluxState, number>();
      for (const o of lists[d.id]!) counts.set(fluxState(o), (counts.get(fluxState(o)) ?? 0) + 1);
      return {
        title: d.title,
        resource: d.id,
        slices: SLICES.filter((s) => counts.get(s.state)).map((s) => ({ label: s.label, value: counts.get(s.state)!, tone: s.tone })),
      };
    });
    const events = eventRows(lists.events ?? [], (e) => (e.involvedObject?.apiVersion ?? "").includes("fluxcd.io"));
    return {
      donuts,
      tables: [{ title: "Flux Events", icon: "history", columns: eventColumns, rows: events, empty: "No Flux event" }],
      empty: CHARTED.every((d) => missing?.has(d.id)) ? "Flux is not installed on this cluster." : undefined,
    };
  },
};
