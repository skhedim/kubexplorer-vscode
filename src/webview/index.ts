import { App, type VsCodeApi } from "./app";

declare function acquireVsCodeApi(): VsCodeApi;

export function startWebview(api: VsCodeApi): App {
  const app = new App(document.getElementById("app")!, api);
  app.start();
  return app;
}

// In VS Code, acquireVsCodeApi is injected by the host; the browser preview calls startWebview itself.
if (typeof acquireVsCodeApi === "function") startWebview(acquireVsCodeApi());
