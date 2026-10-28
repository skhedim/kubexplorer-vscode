// Where Flux takes what it deploys from: Git, Helm and OCI repositories, Helm charts, buckets, external artifacts and
// artifact generators.

import { link, mono, text } from "../format";
import { artifactItems, fluxKind, gitRef, type ObjectRef, refLink, secretLink, SOURCE, sourceText, valuesBlock } from "./kind";

function ociRef(ref: Record<string, string> | undefined): string {
  if (!ref) return "latest";
  return ref.digest ? `digest ${ref.digest}` : ref.semver ? `semver ${ref.semver}` : ref.tag ? `tag ${ref.tag}` : "latest";
}

export const fluxGitRepositories = fluxKind({
  id: "flux:gitrepositories",
  plural: "gitrepositories",
  group: SOURCE,
  kind: "GitRepository",
  title: "Git Repositories",
  columns: [
    { id: "url", title: "URL", grow: 1.6, value: (o) => o.spec?.url ?? "" },
    { id: "ref", title: "Target Ref", grow: 0.8, value: (o) => gitRef(o.spec?.ref) },
    { id: "revision", title: "Revision", grow: 1.2, value: (o) => mono(o.status?.artifact?.revision ?? "") },
  ],
  items: (o) => [
    { name: "URL", value: o.spec?.url ?? "" },
    { name: "Git Ref", value: gitRef(o.spec?.ref) },
    { name: "Authentication Provider", value: o.spec?.provider ?? "" },
    { name: "Git Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Verify Signatures", value: o.spec?.verify ? `${o.spec.verify.mode} (${o.spec.verify.secretRef?.name ?? ""})` : "" },
    { name: "Recurse Submodules", value: o.spec?.recurseSubmodules ? "Yes" : "" },
    ...valuesBlock("Source Ignore", o.spec?.ignore),
    ...artifactItems(o),
  ],
});

export const fluxHelmRepositories = fluxKind({
  id: "flux:helmrepositories",
  plural: "helmrepositories",
  group: SOURCE,
  kind: "HelmRepository",
  title: "Helm Repositories",
  columns: [
    { id: "url", title: "URL", grow: 1.8, value: (o) => o.spec?.url ?? "" },
    { id: "type", title: "Type", grow: 0.5, value: (o) => o.spec?.type ?? "default" },
  ],
  items: (o) => [
    { name: "URL", value: o.spec?.url ?? "" },
    { name: "Type", value: o.spec?.type ?? "default" },
    { name: "Authentication Provider", value: o.spec?.provider ?? "" },
    { name: "Authentication Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Pass Credentials", value: o.spec?.passCredentials ? "Yes" : "" },
    ...artifactItems(o),
  ],
});

export const fluxHelmCharts = fluxKind({
  id: "flux:helmcharts",
  plural: "helmcharts",
  group: SOURCE,
  kind: "HelmChart",
  title: "Helm Charts",
  columns: [
    { id: "chart", title: "Chart", grow: 1, value: (o) => o.spec?.chart ?? "" },
    { id: "version", title: "Version", grow: 0.6, value: (o) => o.spec?.version ?? "*" },
    { id: "sourceKind", title: "Source Kind", grow: 0.7, value: (o) => o.spec?.sourceRef?.kind ?? "" },
    { id: "sourceName", title: "Source Name", grow: 0.9, value: (o) => refLink(o, o.spec?.sourceRef, "HelmRepository", false) },
  ],
  items: (o) => [
    { name: "Chart", value: o.spec?.chart ?? "" },
    { name: "Version", value: o.spec?.version ?? "*" },
    { name: "Source", value: refLink(o, o.spec?.sourceRef, "HelmRepository") },
    { name: "Reconcile Strategy", value: o.spec?.reconcileStrategy ?? "" },
    { name: "Values Files", value: (o.spec?.valuesFiles ?? []).map(mono) },
    ...artifactItems(o),
  ],
});

export const fluxBuckets = fluxKind({
  id: "flux:buckets",
  plural: "buckets",
  group: SOURCE,
  kind: "Bucket",
  title: "Buckets",
  columns: [
    { id: "provider", title: "Provider", grow: 0.6, value: (o) => o.spec?.provider ?? "generic" },
    { id: "bucket", title: "Bucket", grow: 1, value: (o) => o.spec?.bucketName ?? "" },
  ],
  items: (o) => [
    { name: "Provider", value: o.spec?.provider ?? "generic" },
    { name: "Bucket", value: o.spec?.bucketName ?? "" },
    { name: "Endpoint", value: o.spec?.endpoint ?? "" },
    { name: "Region", value: o.spec?.region ?? "" },
    { name: "Insecure Endpoint", value: o.spec?.insecure ? text("Yes", "warning") : "" },
    { name: "Authentication Credentials", value: secretLink(o, o.spec?.secretRef) },
    ...artifactItems(o),
  ],
});

export const fluxOciRepositories = fluxKind({
  id: "flux:ocirepositories",
  plural: "ocirepositories",
  group: SOURCE,
  kind: "OCIRepository",
  title: "OCI Repositories",
  columns: [
    { id: "url", title: "URL", grow: 1.8, value: (o) => o.spec?.url ?? "" },
    { id: "revision", title: "Revision", grow: 1, value: (o) => mono(o.status?.artifact?.revision ?? "") },
  ],
  items: (o) => [
    { name: "URL", value: o.spec?.url ?? "" },
    { name: "Reference", value: ociRef(o.spec?.ref) },
    { name: "Authentication Provider", value: o.spec?.provider ?? "" },
    { name: "Registry Login Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Image Pull Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    { name: "Insecure Container Registry", value: o.spec?.insecure ? text("Yes", "warning") : "" },
    {
      name: "Layer Selector",
      value: o.spec?.layerSelector ? `${o.spec.layerSelector.mediaType ?? ""} ${o.spec.layerSelector.operation ?? ""}`.trim() : "",
    },
    {
      name: "Verify",
      value: o.spec?.verify ? `${o.spec.verify.provider}${o.spec.verify.secretRef ? ` (${o.spec.verify.secretRef.name})` : ""}` : "",
    },
    ...artifactItems(o),
  ],
});

export const fluxExternalArtifacts = fluxKind({
  id: "flux:externalartifacts",
  plural: "externalartifacts",
  group: SOURCE,
  kind: "ExternalArtifact",
  title: "External Artifacts",
  suspend: "none",
  columns: [
    { id: "source", title: "Source", grow: 1, value: (o) => sourceText(o.spec?.sourceRef) },
    { id: "revision", title: "Revision", grow: 1.2, value: (o) => mono(o.status?.artifact?.revision ?? "") },
  ],
  items: (o) => [{ name: "Source", value: sourceText(o.spec?.sourceRef) }, ...artifactItems(o)],
});

export const fluxArtifactGenerators = fluxKind({
  id: "flux:artifactgenerators",
  plural: "artifactgenerators",
  group: "source.extensions.fluxcd.io",
  kind: "ArtifactGenerator",
  title: "Artifact Generators",
  suspend: "annotation",
  columns: [
    { id: "sources", title: "Sources", grow: 0.5, value: (o) => String(o.spec?.sources?.length ?? 0) },
    { id: "artifacts", title: "Artifacts", grow: 0.5, value: (o) => String(o.spec?.artifacts?.length ?? 0) },
  ],
  items: (o) => [
    {
      name: "Sources",
      value: (o.spec?.sources ?? []).map((s: ObjectRef & { alias?: string }) => `${s.alias ? `${s.alias}: ` : ""}${sourceText(s)}`),
    },
    { name: "Artifacts", value: (o.spec?.artifacts ?? []).map((a: { name: string }) => a.name) },
  ],
});
