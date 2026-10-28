// Network > Port Forwarding: port forwards started from KubeXplorer.

import { PORT_FORWARDS } from "../kube/virtualKinds";
import type { KubeObject } from "../kube/types";
import type { Cell } from "../shared/view";
import { defineResource } from "./descriptor";
import { link, since, text } from "./format";

const target = (o: KubeObject): Cell =>
  link(o.portForward.resource === "services" ? "Service" : "Pod", o.portForward.name, o.portForward.namespace);
const statusCell = (o: KubeObject): Cell =>
  o.portForward.status === "active"
    ? text("Active", "ok")
    : o.portForward.status === "starting"
      ? text("Starting", "info")
      : text("Error", "error", o.portForward.error);

export const portforwards = defineResource({
  id: "portforwards",
  events: false,
  kubectlName: PORT_FORWARDS,
  title: "Port Forwarding",
  kindName: "Port Forward",
  namespaced: true,
  showName: false,
  defaultSort: { col: "age", desc: false },
  columns: [
    { id: "target", title: "Name", grow: 2, value: target },
    { id: "kind", title: "Kind", grow: 0.6, value: (o) => (o.portForward.resource === "services" ? "Service" : "Pod") },
    {
      id: "local",
      title: "Local Port",
      grow: 0.6,
      value: (o) => (o.portForward.localPort ? text(`localhost:${o.portForward.localPort}`, "info") : ""),
      sort: (o) => o.portForward.localPort ?? 0,
    },
    {
      id: "remote",
      title: "Remote Port",
      grow: 0.6,
      value: (o) => String(o.portForward.remotePort),
      sort: (o) => o.portForward.remotePort,
    },
  ],
  endColumns: [{ id: "status", title: "Status", grow: 0.6, value: statusCell }],
  warning: (o) => (o.portForward.status === "error" ? o.portForward.error : undefined),
  actions: ["openBrowser"],
  commonActions: ["stop"],
  detailsTitle: (o) => `Port Forward: ${o.portForward.name}:${o.portForward.remotePort}`,
  header: (o) => [
    { name: "Target", value: target(o) },
    { name: "Namespace", value: link("Namespace", o.portForward.namespace) },
    { name: "Local", value: o.portForward.localPort ? `127.0.0.1:${o.portForward.localPort}` : "" },
    { name: "Remote Port", value: String(o.portForward.remotePort) },
    { name: "Status", value: statusCell(o) },
    ...(o.portForward.error ? [{ name: "Error", value: text(o.portForward.error, "error") }] : []),
    { name: "Started", value: since(o.portForward.startedAt, { suffix: " ago" }) },
  ],
});
