// Network : Services, Endpoints, Ingresses, Ingress Classes, Network Policies.

import type { EndpointSubset, IngressRule, IngressTls, LoadBalancerIngress, ServicePort } from "../kube/models";
import type { KubeObject } from "../kube/types";
import { defineResource } from "./descriptor";
import { labelTags, mono } from "./format";
import { podsSection } from "./workloads";

function servicePorts(o: KubeObject): string {
  return (o.spec?.ports ?? []).map((p: ServicePort) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`).join(", ");
}

function externalIps(o: KubeObject): string {
  const lb = (o.status?.loadBalancer?.ingress ?? []).map((i: LoadBalancerIngress) => i.ip ?? i.hostname);
  return [...lb, ...(o.spec?.externalIPs ?? [])].join(", ") || (o.spec?.type === "ExternalName" ? (o.spec?.externalName ?? "") : "-");
}

export const services = defineResource({
  id: "services",
  title: "Services",
  kindName: "Service",
  namespaced: true,
  actions: ["portForward"],
  columns: [
    { id: "type", title: "Type", grow: 0.6, value: (o) => o.spec?.type ?? "" },
    { id: "clusterIp", title: "Cluster IP", grow: 0.8, value: (o) => o.spec?.clusterIP ?? "" },
    { id: "ports", title: "Ports", grow: 1, value: servicePorts },
    { id: "externalIp", title: "External IP", grow: 0.8, value: externalIps },
    { id: "selector", title: "Selector", grow: 1.4, value: (o) => labelTags(o.spec?.selector), sort: false },
  ],
  items: (o) => [
    { name: "Selector", value: labelTags(o.spec?.selector) },
    { name: "Type", value: o.spec?.type ?? "" },
    { name: "Session Affinity", value: o.spec?.sessionAffinity ?? "" },
    { name: "Cluster IP", value: o.spec?.clusterIP ?? "" },
    { name: "External IPs", value: externalIps(o) },
    {
      name: "Ports",
      value: (o.spec?.ports ?? []).map((p: ServicePort) =>
        mono(`${p.name ? `${p.name}: ` : ""}${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"} → ${p.targetPort}`),
      ),
    },
  ],
  sections: (o, ctx) => podsSection(ctx, o.metadata.namespace, o.spec?.selector),
});

export const endpoints = defineResource({
  id: "endpoints",
  title: "Endpoints",
  kindName: "Endpoints",
  namespaced: true,
  columns: [
    {
      id: "endpoints",
      title: "Endpoints",
      grow: 3,
      value: (o) =>
        (o.subsets ?? [])
          .flatMap((s: EndpointSubset) =>
            (s.addresses ?? []).flatMap((a) =>
              (s.ports?.length ? s.ports : [{}]).map((p: { port?: number }) => `${a.ip}${p.port ? `:${p.port}` : ""}`),
            ),
          )
          .join(", "),
    },
  ],
});

export const ingresses = defineResource({
  id: "ingresses",
  kubectlName: "ingresses.networking.k8s.io",
  title: "Ingresses",
  kindName: "Ingress",
  namespaced: true,
  columns: [
    {
      id: "lb",
      title: "LoadBalancers",
      grow: 0.8,
      value: (o) => (o.status?.loadBalancer?.ingress ?? []).map((i: LoadBalancerIngress) => i.ip ?? i.hostname).join(", "),
    },
    {
      id: "rules",
      title: "Rules",
      grow: 2,
      value: (o) =>
        (o.spec?.rules ?? [])
          .flatMap((r: IngressRule) =>
            (r.http?.paths ?? []).map(
              (p) =>
                `${r.host ?? "*"}${p.path ?? "/"} → ${p.backend?.service?.name ?? "?"}:${p.backend?.service?.port?.number ?? p.backend?.service?.port?.name ?? ""}`,
            ),
          )
          .join(", "),
    },
  ],
  items: (o) => [
    { name: "Ingress Class", value: o.spec?.ingressClassName ?? "" },
    { name: "TLS", value: (o.spec?.tls ?? []).map((t: IngressTls) => `${(t.hosts ?? []).join(", ")} (${t.secretName})`) },
  ],
});

export const ingressclasses = defineResource({
  id: "ingressclasses",
  kubectlName: "ingressclasses.networking.k8s.io",
  title: "Ingress Classes",
  kindName: "IngressClass",
  namespaced: false,
  columns: [{ id: "controller", title: "Controller", grow: 2, value: (o) => o.spec?.controller ?? "" }],
});

export const networkpolicies = defineResource({
  id: "networkpolicies",
  kubectlName: "networkpolicies.networking.k8s.io",
  title: "Network Policies",
  kindName: "NetworkPolicy",
  namespaced: true,
  columns: [{ id: "types", title: "Policy Types", grow: 1, value: (o) => (o.spec?.policyTypes ?? []).join(", ") }],
  items: (o) => [{ name: "Pod Selector", value: labelTags(o.spec?.podSelector?.matchLabels) }],
});
