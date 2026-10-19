// Browser preview: the real webview and the real PanelController, on the demo cluster.
// The URL picks the tab: ?resource=pods (default), ?resource=overview, ?appearance=freelens, ?theme=light,
// ?protection=confirm or readOnly (a protected context).
// Usage charts use the synthetic demo metrics.

import { DEMO_CONTEXT, DemoClient } from "../src/kube/demo";
import { DemoMetrics } from "../src/kube/prometheus";
import { ResourceStore } from "../src/kube/store";
import { nullLogger } from "../src/kube/types";
import { PanelController } from "../src/panel/controller";
import { MetricsHistory, MetricsService } from "../src/panel/metrics";
import { menuTarget } from "../src/resources/menu";
import { ResourceRegistry } from "../src/resources/registry";
import type { Protection } from "../src/shared/protection";
import type { Appearance, HostMessage, WebviewMessage } from "../src/shared/protocol";
import { startWebview } from "../src/webview/index";

const params = new URLSearchParams(location.search);
const resource = params.get("resource") ?? "pods";
const appearance = (params.get("appearance") ?? "vscode") as Appearance;
const protection = (params.get("protection") ?? "none") as Protection;
document.body.dataset.appearance = appearance;
document.body.classList.add(params.get("theme") === "light" ? "vscode-light" : "vscode-dark");

const client = new DemoClient();
const registry = new ResourceRegistry();
const store = new ResourceStore(client, { pollIntervalMs: () => 5000 }, nullLogger);
const available = ["default", "frontend", "kube-public", "kube-system", "monitoring", "payments"];

/** Shows what VS Code would do (dialog, terminal…) at the bottom of the page. */
const hostLog = (message: string) => {
  const el = document.getElementById("host-log");
  if (el) el.textContent = message;
};

const controller = new PanelController({
  context: DEMO_CONTEXT,
  target: menuTarget(resource),
  registry,
  metrics: new MetricsService({ backend: new DemoMetrics(), client, registry, history: new MetricsHistory(), log: nullLogger }),
  store,
  client,
  log: nullLogger,
  appearance,
  protection,
  namespaces: { available, selected: [] },
  host: {
    post: (msg: HostMessage) => window.postMessage(msg, "*"),
    runAction: (_ctx, action, ref, container) =>
      hostLog(`action ${action} → ${ref.resource}/${ref.name}${container ? ` (${container})` : ""}`),
    rowMenu: (_ctx, ref, actions) => hostLog(`native quick pick: ${actions.join(", ")} for ${ref.name}`),
    bulkAction: (_ctx, action, refs) => hostLog(`native confirmation: ${action} ${refs.length} object(s)`),
    openResource: (_ctx, r) => (location.search = `?resource=${r}&appearance=${appearance}`),
    setNamespaces: (_ctx, namespaces) => controller.setNamespaceFilter({ available, selected: namespaces }),
    refresh: () => store.refresh(),
    copyText: (text) => hostLog(`copied ${text.length} characters`),
    updateSecret: async (_ctx, ref, key, value) => {
      hostLog(`kubectl replace: ${ref.name}, ${key} = ${value.length} characters`);
      return true;
    },
  },
});

startWebview({
  postMessage: (msg: WebviewMessage) => controller.onMessage(msg),
  getState: () => JSON.parse(sessionStorage.getItem(`state:${resource}`) ?? "null"),
  setState: (state: unknown) => sessionStorage.setItem(`state:${resource}`, JSON.stringify(state)),
});
controller.setVisible(true);
