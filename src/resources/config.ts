// Config : ConfigMaps, Secrets, quotas, autoscalers, PDB, classes, leases, webhooks.

import type { LimitRangeItem, Webhook } from "../kube/models";
import type { KubeObject } from "../kube/types";
import type { DetailItem } from "../shared/view";
import { defineResource } from "./descriptor";
import { formatAge, labelTags, link, mono, text } from "./format";

function keys(o: KubeObject): string {
  return Object.keys({ ...(o.data ?? {}), ...(o.binaryData ?? {}) }).join(", ");
}

export const configmaps = defineResource({
  id: "configmaps",
  title: "Config Maps",
  kindName: "ConfigMap",
  namespaced: true,
  columns: [{ id: "keys", title: "Keys", grow: 2, value: keys }],
  sections: (o) => [
    { type: "title", text: "Data" },
    { type: "items", items: Object.entries(o.data ?? {}).map(([k, v]): DetailItem => ({ name: k, value: mono(v), block: true })) },
  ],
});

/** Decoded size of a base64 value, without exposing its content. */
function decodedSize(b64: string): string {
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return `${bytes} bytes`;
}

export const secrets = defineResource({
  id: "secrets",
  title: "Secrets",
  kindName: "Secret",
  namespaced: true,
  columns: [
    { id: "keys", title: "Keys", grow: 1.5, value: keys },
    { id: "type", title: "Type", grow: 1, value: (o) => o.type ?? "" },
  ],
  actions: ["editDecoded"],
  items: (o) => [{ name: "Type", value: o.type ?? "" }],
  // Values are never part of the view model: only keys and sizes. The webview asks for one decoded
  // value when the user clicks its reveal button (see PanelController.revealSecret).
  sections: (o) => [
    { type: "title", text: "Data" },
    {
      type: "items",
      items: Object.entries(o.data ?? {}).map(([k, v]): DetailItem => ({
        name: k,
        value: text(decodedSize(String(v)), "muted"),
        secretKey: k,
      })),
    },
  ],
});

export const resourcequotas = defineResource({
  id: "resourcequotas",
  title: "Resource Quotas",
  kindName: "ResourceQuota",
  namespaced: true,
  items: (o) => Object.entries(o.spec?.hard ?? {}).map(([k, v]) => ({ name: k, value: `${o.status?.used?.[k] ?? 0} / ${v}` })),
});

export const limitranges = defineResource({
  id: "limitranges",
  title: "Limit Ranges",
  kindName: "LimitRange",
  namespaced: true,
  items: (o) =>
    (o.spec?.limits ?? []).map((l: LimitRangeItem) => ({
      name: l.type,
      value: mono(JSON.stringify({ default: l.default, defaultRequest: l.defaultRequest, max: l.max, min: l.min })),
    })),
});

export const horizontalpodautoscalers = defineResource({
  id: "horizontalpodautoscalers",
  kubectlName: "horizontalpodautoscalers.autoscaling",
  title: "Horizontal Pod Autoscalers",
  kindName: "HorizontalPodAutoscaler",
  namespaced: true,
  columns: [
    {
      id: "target",
      title: "Target",
      grow: 1.2,
      value: (o) =>
        link(o.spec?.scaleTargetRef?.kind ?? "", o.spec?.scaleTargetRef?.name, o.metadata.namespace, `${o.spec?.scaleTargetRef?.kind} `),
    },
    { id: "min", title: "Min Pods", grow: 0.5, value: (o) => String(o.spec?.minReplicas ?? 1), sort: (o) => o.spec?.minReplicas ?? 1 },
    { id: "max", title: "Max Pods", grow: 0.5, value: (o) => String(o.spec?.maxReplicas ?? 0), sort: (o) => o.spec?.maxReplicas ?? 0 },
    {
      id: "replicas",
      title: "Replicas",
      grow: 0.5,
      value: (o) => String(o.status?.currentReplicas ?? 0),
      sort: (o) => o.status?.currentReplicas ?? 0,
    },
  ],
});

export const poddisruptionbudgets = defineResource({
  id: "poddisruptionbudgets",
  title: "Pod Disruption Budgets",
  kindName: "PodDisruptionBudget",
  namespaced: true,
  columns: [
    { id: "minAvailable", title: "Min Available", grow: 0.6, value: (o) => String(o.spec?.minAvailable ?? "N/A") },
    { id: "maxUnavailable", title: "Max Unavailable", grow: 0.6, value: (o) => String(o.spec?.maxUnavailable ?? "N/A") },
    {
      id: "healthy",
      title: "Current Healthy",
      grow: 0.6,
      value: (o) =>
        text(
          `${o.status?.currentHealthy ?? 0}/${o.status?.desiredHealthy ?? 0}`,
          (o.status?.currentHealthy ?? 0) < (o.status?.desiredHealthy ?? 0) ? "warning" : undefined,
        ),
    },
  ],
  items: (o) => [{ name: "Selector", value: labelTags(o.spec?.selector?.matchLabels) }],
});

export const priorityclasses = defineResource({
  id: "priorityclasses",
  title: "Priority Classes",
  kindName: "PriorityClass",
  namespaced: false,
  columns: [
    { id: "value", title: "Value", grow: 0.6, value: (o) => String(o.value ?? 0), sort: (o) => o.value ?? 0 },
    { id: "global", title: "Global Default", grow: 0.6, value: (o) => (o.globalDefault ? "True" : "False") },
  ],
});

export const runtimeclasses = defineResource({
  id: "runtimeclasses",
  title: "Runtime Classes",
  kindName: "RuntimeClass",
  namespaced: false,
  columns: [{ id: "handler", title: "Handler", grow: 1, value: (o) => o.handler ?? "" }],
});

export const leases = defineResource({
  id: "leases",
  title: "Leases",
  kindName: "Lease",
  namespaced: true,
  columns: [
    { id: "holder", title: "Holder", grow: 2, value: (o) => o.spec?.holderIdentity ?? "" },
    {
      id: "renewed",
      title: "Renewed",
      grow: 0.5,
      value: (o) => formatAge(o.spec?.renewTime),
      sort: (o) => -Date.parse(o.spec?.renewTime ?? "0"),
    },
  ],
});

function webhookConfig(id: string, title: string, kindName: string) {
  return defineResource({
    id,
    title,
    kindName,
    namespaced: false,
    columns: [
      { id: "webhooks", title: "Webhooks", grow: 0.5, value: (o) => String(o.webhooks?.length ?? 0), sort: (o) => o.webhooks?.length ?? 0 },
    ],
    items: (o) =>
      (o.webhooks ?? []).map((w: Webhook) => ({
        name: w.name,
        value: mono(
          w.clientConfig?.service
            ? `${w.clientConfig.service.namespace}/${w.clientConfig.service.name}${w.clientConfig.service.path ?? ""}`
            : (w.clientConfig?.url ?? ""),
        ),
      })),
  });
}

export const mutatingwebhooks = webhookConfig("mutatingwebhookconfigurations", "Mutating Webhook Configs", "MutatingWebhookConfiguration");
export const validatingwebhooks = webhookConfig(
  "validatingwebhookconfigurations",
  "Validating Webhook Configs",
  "ValidatingWebhookConfiguration",
);
