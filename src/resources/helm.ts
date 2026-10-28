// Helm: Releases and Charts (virtual lists served by the helm binary).

import { HELM_CHARTS, HELM_RELEASES } from "../kube/virtualKinds";
import type { KubeObject } from "../kube/types";
import type { Cell, Row, Tone } from "../shared/view";
import { defineResource } from "./descriptor";
import { formatDate, link, mono, since, text } from "./format";

function releaseStatusTone(status: string): Tone {
  if (status === "deployed") return "ok";
  if (status === "failed") return "error";
  if (status.startsWith("pending")) return "warning";
  if (status === "superseded" || status === "uninstalled") return "muted";
  return "info";
}

const statusCell = (o: KubeObject): Cell => text(o.helm.status, releaseStatusTone(o.helm.status));

/**
 * Helm lists cannot be watched: they are polled, at most once a minute. `helm list` decodes every release Secret of
 * the cluster, and the charts of the repositories change only with `helm repo update`. An action on a release
 * refreshes the list right away.
 */
const HELM_POLL_MS = 60_000;

export const helmreleases = defineResource({
  id: "helmreleases",
  events: false,
  kubectlName: HELM_RELEASES,
  title: "Releases",
  minPollIntervalMs: HELM_POLL_MS,
  kindName: "Release",
  namespaced: true,
  ageTitle: "Updated",
  columns: [
    { id: "chart", title: "Chart", grow: 1.2, value: (o) => o.helm.chartName },
    { id: "revision", title: "Revision", grow: 0.5, value: (o) => String(o.helm.revision), sort: (o) => o.helm.revision },
    { id: "version", title: "Version", grow: 0.6, value: (o) => o.helm.chartVersion },
    { id: "appVersion", title: "App Version", grow: 0.6, value: (o) => o.helm.appVersion },
  ],
  endColumns: [{ id: "status", title: "Status", grow: 0.6, value: statusCell }],
  warning: (o) => (o.helm.status === "failed" ? "The last deployment failed" : undefined),
  actions: ["values", "manifest", "rollback"],
  commonActions: ["copyName", "delete"],
  detailsTitle: (o) => `Release: ${o.metadata.name}`,
  header: (o) => [
    { name: "Name", value: o.metadata.name },
    { name: "Namespace", value: link("Namespace", o.metadata.namespace) },
    { name: "Chart", value: mono(o.helm.chart) },
    { name: "Revision", value: String(o.helm.revision) },
    { name: "App Version", value: o.helm.appVersion },
    { name: "Status", value: statusCell(o) },
    { name: "Updated", value: since(o.metadata.creationTimestamp, { suffix: ` ago (${formatDate(o.metadata.creationTimestamp)})` }) },
  ],
  sections: async (o, ctx) => {
    if (!ctx.helm) return [];
    const ns = o.metadata.namespace ?? "default";
    const [notes, history] = await Promise.all([
      ctx.helm.notes(ctx.context, ns, o.metadata.name).catch(() => ""),
      ctx.helm.history(ctx.context, ns, o.metadata.name),
    ]);
    const rows: Row[] = [...history].reverse().map((h) => ({
      uid: `${o.metadata.uid}#${h.revision}`,
      ref: { resource: "helmreleases", namespace: ns, name: o.metadata.name },
      cells: {
        revision: String(h.revision),
        status: text(h.status, releaseStatusTone(h.status)),
        chart: h.chart,
        appVersion: h.app_version,
        description: text(h.description, h.status === "failed" ? "error" : undefined, h.description),
        updated: since(h.updated),
      },
      sort: {},
      search: "",
      actions: [],
    }));
    return [
      ...(notes.trim()
        ? [
            { type: "title" as const, text: "Notes" },
            { type: "items" as const, items: [{ name: "NOTES.txt", value: mono(notes.trim()), block: true }] },
          ]
        : []),
      { type: "title", text: "History" },
      {
        type: "table",
        empty: "No revision",
        columns: [
          { id: "revision", title: "Rev.", grow: 0.3 },
          { id: "status", title: "Status", grow: 0.9 },
          { id: "chart", title: "Chart", grow: 1 },
          { id: "appVersion", title: "App", grow: 0.5 },
          { id: "description", title: "Description", grow: 1.6 },
          { id: "updated", title: "Updated", grow: 0.4 },
        ],
        rows,
      },
    ];
  },
});

export const helmcharts = defineResource({
  id: "helmcharts",
  events: false,
  kubectlName: HELM_CHARTS,
  title: "Charts",
  minPollIntervalMs: HELM_POLL_MS,
  kindName: "Chart",
  namespaced: false,
  showAge: false,
  nameGrow: 1.4,
  columns: [
    { id: "description", title: "Description", grow: 3, value: (o) => text(o.helm.description, undefined, o.helm.description) },
    { id: "version", title: "Version", grow: 0.5, value: (o) => o.helm.version },
    { id: "appVersion", title: "App Version", grow: 0.5, value: (o) => o.helm.appVersion },
    { id: "repo", title: "Repository", grow: 0.7, value: (o) => o.helm.repo },
  ],
  actions: ["install", "values"],
  commonActions: ["copyName"],
  detailsTitle: (o) => `Chart: ${o.metadata.name}`,
  header: (o) => [
    { name: "Name", value: o.helm.chart },
    { name: "Repository", value: o.helm.repo },
    { name: "Version", value: o.helm.version },
    { name: "App Version", value: o.helm.appVersion },
    { name: "Description", value: o.helm.description },
  ],
  sections: async (o, ctx) => {
    if (!ctx.helm) return [];
    const chart = await ctx.helm.showChart(o.metadata.name, "chart", o.helm.version).catch((e: Error) => `Error: ${e.message}`);
    return [
      { type: "title", text: "Chart.yaml" },
      { type: "items", items: [{ name: "Chart.yaml", value: mono(chart.trim()), block: true }] },
    ];
  },
});
