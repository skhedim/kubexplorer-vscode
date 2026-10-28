// Notifications: alerts, providers and receivers.

import { mono, text } from "../format";
import { fluxKind, NOTIFICATION, type ObjectRef, objectLink, refLink, secretLink } from "./kind";
import { fluxSuspended } from "./status";

export const fluxAlerts = fluxKind({
  id: "flux:alerts",
  plural: "alerts",
  group: NOTIFICATION,
  kind: "Alert",
  title: "Alerts",
  status: false,
  columns: [{ id: "severity", title: "Severity", grow: 0.5, value: (o) => o.spec?.eventSeverity ?? "info" }],
  items: (o) => [
    { name: "Resumed", value: fluxSuspended(o) ? text("No (suspended)", "info") : "Yes" },
    { name: "Event Severity", value: o.spec?.eventSeverity ?? "info" },
    { name: "Provider", value: objectLink("Provider", o.spec?.providerRef?.name, o.metadata.namespace, NOTIFICATION) },
    {
      name: "Event Sources",
      value: (o.spec?.eventSources ?? []).map((s: ObjectRef) =>
        s.name === "*" ? `${s.kind} *${s.namespace ? ` in ${s.namespace}` : ""}` : refLink(o, s, s.kind ?? ""),
      ),
    },
    { name: "Inclusions", value: (o.spec?.inclusionList ?? []).map(mono) },
    { name: "Exclusions", value: (o.spec?.exclusionList ?? []).map(mono) },
    { name: "Summary", value: o.spec?.summary ?? "" },
  ],
});

export const fluxProviders = fluxKind({
  id: "flux:providers",
  plural: "providers",
  group: NOTIFICATION,
  kind: "Provider",
  title: "Providers",
  status: false,
  columns: [
    { id: "type", title: "Type", grow: 0.6, value: (o) => o.spec?.type ?? "" },
    { id: "channel", title: "Channel", grow: 0.8, value: (o) => o.spec?.channel ?? "" },
  ],
  items: (o) => [
    { name: "Resumed", value: fluxSuspended(o) ? text("No (suspended)", "info") : "Yes" },
    { name: "Type", value: o.spec?.type ?? "" },
    { name: "Channel", value: o.spec?.channel ?? "" },
    { name: "Username", value: o.spec?.username ?? "" },
    { name: "Address", value: o.spec?.address ?? "" },
    { name: "Timeout", value: o.spec?.timeout ?? "" },
    { name: "Proxy", value: o.spec?.proxy ?? "" },
    { name: "Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "TLS Certificate", value: secretLink(o, o.spec?.certSecretRef) },
  ],
});

export const fluxReceivers = fluxKind({
  id: "flux:receivers",
  plural: "receivers",
  group: NOTIFICATION,
  kind: "Receiver",
  title: "Receivers",
  columns: [{ id: "type", title: "Type", grow: 0.6, value: (o) => o.spec?.type ?? "" }],
  items: (o) => [
    { name: "Type", value: o.spec?.type ?? "" },
    { name: "Events", value: { tags: (o.spec?.events ?? []).map((e: string) => ({ text: e })) } },
    { name: "Resources", value: (o.spec?.resources ?? []).map((r: ObjectRef) => refLink(o, r, r.kind ?? "")) },
    { name: "Credentials", value: secretLink(o, o.spec?.secretRef) },
    { name: "Webhook Path", value: mono(o.status?.webhookPath ?? "") },
  ],
});
