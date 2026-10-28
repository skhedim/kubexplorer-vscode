// Image automation: image repositories, image policies and image update automations.

import type { KubeObject } from "../../kube/types";
import { labelTags, link, mono, since } from "../format";
import { fluxKind, gitRef, IMAGE, objectLink, refLink, secretLink } from "./kind";

export const fluxImageRepositories = fluxKind({
  id: "flux:imagerepositories",
  plural: "imagerepositories",
  group: IMAGE,
  kind: "ImageRepository",
  title: "Image Repositories",
  columns: [
    { id: "image", title: "Image", grow: 1.6, value: (o) => o.spec?.image ?? "" },
    {
      id: "tags",
      title: "Tags",
      grow: 0.4,
      value: (o) => String(o.status?.lastScanResult?.tagCount ?? ""),
      sort: (o) => o.status?.lastScanResult?.tagCount ?? 0,
    },
  ],
  items: (o) => [
    { name: "Image", value: mono(o.spec?.image ?? "") },
    { name: "Exclusion", value: (o.spec?.exclusionList ?? []).map(mono) },
    { name: "Authentication Provider", value: o.spec?.provider ?? "" },
    { name: "Image Registry Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Service Account", value: link("ServiceAccount", o.spec?.serviceAccountName, o.metadata.namespace) },
    { name: "Scan Time", value: since(o.status?.lastScanResult?.scanTime, { suffix: " ago" }) },
    { name: "Tag Count", value: String(o.status?.lastScanResult?.tagCount ?? "") },
    { name: "Latest Tags", value: { tags: (o.status?.lastScanResult?.latestTags ?? []).map((t: string) => ({ text: t })) } },
  ],
});

function latestImage(o: KubeObject): string {
  const ref = o.status?.latestRef;
  return ref ? `${ref.name}:${ref.tag}` : (o.status?.latestImage ?? "");
}

function imagePolicy(p: Record<string, Record<string, string>> | undefined): string {
  if (!p) return "";
  if (p.semver) return `SemVer ${p.semver.range}`;
  if (p.alphabetical) return `Alphabetical (${p.alphabetical.order ?? "asc"})`;
  if (p.numerical) return `Numerical (${p.numerical.order ?? "asc"})`;
  return "";
}

export const fluxImagePolicies = fluxKind({
  id: "flux:imagepolicies",
  plural: "imagepolicies",
  group: IMAGE,
  kind: "ImagePolicy",
  title: "Image Policies",
  columns: [
    {
      id: "repository",
      title: "Repository",
      grow: 1,
      value: (o) =>
        objectLink(
          "ImageRepository",
          o.spec?.imageRepositoryRef?.name,
          o.spec?.imageRepositoryRef?.namespace ?? o.metadata.namespace,
          IMAGE,
        ),
    },
    { id: "latest", title: "Latest Tag", grow: 0.8, value: (o) => o.status?.latestRef?.tag ?? latestImage(o).split(":").pop() ?? "" },
  ],
  items: (o) => [
    {
      name: "Image Repository",
      value: objectLink(
        "ImageRepository",
        o.spec?.imageRepositoryRef?.name,
        o.spec?.imageRepositoryRef?.namespace ?? o.metadata.namespace,
        IMAGE,
      ),
    },
    { name: "Policy", value: imagePolicy(o.spec?.policy) },
    {
      name: "Filter Tags",
      value: o.spec?.filterTags
        ? mono(`${o.spec.filterTags.pattern}${o.spec.filterTags.extract ? ` → ${o.spec.filterTags.extract}` : ""}`)
        : "",
    },
    { name: "Digest Reflection Policy", value: o.spec?.digestReflectionPolicy ?? "" },
    { name: "Latest Image", value: mono(latestImage(o)) },
    {
      name: "Previous Image",
      value: o.status?.observedPreviousRef ? mono(`${o.status.observedPreviousRef.name}:${o.status.observedPreviousRef.tag}`) : "",
    },
  ],
});

export const fluxImageUpdateAutomations = fluxKind({
  id: "flux:imageupdateautomations",
  plural: "imageupdateautomations",
  group: IMAGE,
  kind: "ImageUpdateAutomation",
  title: "Image Update Automations",
  columns: [
    {
      id: "lastRun",
      title: "Last Run",
      grow: 0.6,
      value: (o) => since(o.status?.lastAutomationRunTime),
      sort: (o) => -Date.parse(o.status?.lastAutomationRunTime ?? "0"),
    },
  ],
  items: (o) => [
    { name: "Git Repository", value: refLink(o, o.spec?.sourceRef, "GitRepository") },
    { name: "Git Ref", value: gitRef(o.spec?.git?.checkout?.ref) },
    {
      name: "Commit Author",
      value: o.spec?.git?.commit?.author ? `${o.spec.git.commit.author.name} <${o.spec.git.commit.author.email}>` : "",
    },
    { name: "Push Branch", value: o.spec?.git?.push?.branch ?? "" },
    { name: "Push Refspec", value: o.spec?.git?.push?.refspec ?? "" },
    { name: "Update Strategy", value: o.spec?.update ? `${o.spec.update.strategy ?? "Setters"} ${o.spec.update.path ?? ""}`.trim() : "" },
    { name: "Policy Selector", value: labelTags(o.spec?.policySelector?.matchLabels) },
    { name: "Last Run", value: since(o.status?.lastAutomationRunTime, { suffix: " ago" }) },
    { name: "Last Push Commit", value: mono(o.status?.lastPushCommit ?? "") },
    { name: "Last Push", value: since(o.status?.lastPushTime, { suffix: " ago" }) },
    ...(o.spec?.git?.commit?.messageTemplate ? [{ name: "Message Template", value: o.spec.git.commit.messageTemplate, block: true }] : []),
  ],
});
