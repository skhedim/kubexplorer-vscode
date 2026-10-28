// What Flux deploys: Kustomizations and Helm releases.

import type { KubeObject } from "../../kube/types";
import { formatDate, link, mono, text } from "../format";
import { col, dependsOnItem, fluxKind, inventorySection, objectLink, refLink, secretLink, SOURCE, valuesBlock, yesNo } from "./kind";

const lastHistory = (o: KubeObject) => o.status?.history?.[0];

/** Kustomization and HelmRelease of the reconcile chain. */
export const fluxKustomizations = fluxKind({
  id: "flux:kustomizations",
  plural: "kustomizations",
  group: "kustomize.toolkit.fluxcd.io",
  kind: "Kustomization",
  title: "Kustomizations",
  columns: [
    { id: "source", title: "Source", grow: 1, value: (o) => refLink(o, o.spec?.sourceRef, "GitRepository", false) },
    { id: "revision", title: "Revision", grow: 1.2, value: (o) => mono(o.status?.lastAppliedRevision ?? "") },
  ],
  items: (o) => [
    { name: "Source", value: refLink(o, o.spec?.sourceRef, "GitRepository") },
    { name: "Path", value: mono(o.spec?.path ?? "./") },
    { name: "Target Namespace", value: link("Namespace", o.spec?.targetNamespace) },
    { name: "Prune", value: yesNo(o.spec?.prune) },
    { name: "Wait", value: yesNo(o.spec?.wait) },
    { name: "Force", value: o.spec?.force ? "Yes" : "" },
    { name: "Retry Interval", value: o.spec?.retryInterval ?? "" },
    { name: "Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    { name: "Kube Config", value: secretLink(o, o.spec?.kubeConfig?.secretRef) },
    {
      name: "Decryption",
      value: o.spec?.decryption ? `${o.spec.decryption.provider} (${o.spec.decryption.secretRef?.name ?? "no secret"})` : "",
    },
    { name: "Last Applied Revision", value: mono(o.status?.lastAppliedRevision ?? "") },
    { name: "Last Attempted Revision", value: mono(o.status?.lastAttemptedRevision ?? "") },
    ...dependsOnItem(o, "Kustomization"),
    ...valuesBlock("Post Build Substitutions", o.spec?.postBuild?.substitute),
  ],
  sections: inventorySection,
});

export const fluxHelmReleases = fluxKind({
  id: "flux:helmreleases",
  plural: "helmreleases",
  group: "helm.toolkit.fluxcd.io",
  kind: "HelmRelease",
  title: "Helm Releases",
  columns: [
    {
      id: "source",
      title: "Source",
      grow: 1,
      value: (o) =>
        o.spec?.chartRef
          ? refLink(o, o.spec.chartRef, "OCIRepository", false)
          : refLink(o, o.spec?.chart?.spec?.sourceRef, "HelmRepository", false),
    },
    { id: "chartVersion", title: "Chart Version", grow: 0.7, value: (o) => lastHistory(o)?.chartVersion ?? "" },
    { id: "appVersion", title: "App Version", grow: 0.7, value: (o) => lastHistory(o)?.appVersion ?? "" },
  ],
  items: (o) => [
    {
      name: "Release Name",
      value: o.spec?.releaseName ?? `${o.spec?.targetNamespace ? `${o.spec.targetNamespace}-` : ""}${o.metadata.name}`,
    },
    {
      name: "Source",
      value: o.spec?.chartRef ? refLink(o, o.spec.chartRef, "OCIRepository") : refLink(o, o.spec?.chart?.spec?.sourceRef, "HelmRepository"),
    },
    { name: "Chart", value: o.spec?.chart?.spec?.chart ?? lastHistory(o)?.chartName ?? "" },
    { name: "Chart Version", value: lastHistory(o)?.chartVersion ?? o.spec?.chart?.spec?.version ?? "" },
    { name: "App Version", value: lastHistory(o)?.appVersion ?? "" },
    { name: "Helm Chart", value: objectLink("HelmChart", o.status?.helmChart?.split("/")[1], o.status?.helmChart?.split("/")[0], SOURCE) },
    { name: "Target Namespace", value: link("Namespace", o.spec?.targetNamespace) },
    { name: "Storage Namespace", value: link("Namespace", o.spec?.storageNamespace) },
    { name: "Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    { name: "Max History", value: o.spec?.maxHistory !== undefined ? String(o.spec.maxHistory) : "" },
    { name: "Drift Detection", value: o.spec?.driftDetection?.mode ?? "" },
    { name: "Install CRDs", value: o.spec?.install?.crds ?? "" },
    { name: "Upgrade CRDs", value: o.spec?.upgrade?.crds ?? "" },
    { name: "Last Attempted Revision", value: mono(o.status?.lastAttemptedRevision ?? "") },
    ...dependsOnItem(o, "HelmRelease"),
    ...valuesBlock("Values", o.spec?.values),
  ],
  sections: (o) => {
    const history: Record<string, string | number>[] = o.status?.history ?? [];
    if (!history.length) return [];
    return [
      { type: "title", text: "History" },
      {
        type: "grid",
        columns: [
          col("version", "Revision", 0.4),
          col("chart", "Chart Version", 0.8),
          col("app", "App Version", 0.7),
          col("status", "Status", 0.7),
          col("deployed", "Last Deployed", 1),
        ],
        rows: history.map((h) => [
          String(h.version ?? ""),
          `${h.chartName ?? ""} ${h.chartVersion ?? ""}`.trim(),
          String(h.appVersion ?? ""),
          text(String(h.status ?? ""), h.status === "deployed" ? "ok" : h.status === "failed" ? "error" : undefined),
          text(formatDate(String(h.lastDeployed ?? "")), undefined, String(h.lastDeployed ?? "")),
        ]),
        empty: "No release",
      },
    ];
  },
});
