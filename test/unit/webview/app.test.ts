// @vitest-environment happy-dom
// The webview App, rendered in a simulated DOM.
import { beforeEach, describe, expect, it } from "vitest";
import type { HostMessage, WebviewMessage } from "../../../src/shared/protocol";
import type { Details } from "../../../src/shared/view";
import { App } from "../../../src/webview/app";

const ref = { resource: "pods", namespace: "default", name: "web" };

function details(age: string): Details {
  return {
    uid: "u1",
    ref,
    kindName: "Pod",
    title: "Pod: web",
    actions: ["logs", "delete"],
    sections: [{ type: "items", items: [{ name: "Created", value: `${age} ago` }] }],
  };
}

function setup() {
  document.body.innerHTML = `<div id="app"></div>`;
  const sent: WebviewMessage[] = [];
  let state: unknown;
  const app = new App(document.getElementById("app")!, {
    postMessage: (m) => sent.push(m),
    getState: () => state,
    setState: (s) => (state = s),
  });
  app.start();
  const receive = (msg: HostMessage) => window.dispatchEvent(new MessageEvent("message", { data: msg }));
  receive({
    type: "init",
    appearance: "vscode",
    view: {
      mode: "list",
      context: "c",
      resource: "pods",
      title: "Pods",
      kindName: "Pod",
      namespaced: true,
      columns: [{ id: "name", title: "Name" }],
      hasWarnings: false,
      defaultSort: { col: "name", desc: false },
    },
  });
  receive({
    type: "rows",
    loading: false,
    rows: [{ uid: "u1", ref, cells: { name: "web" }, sort: { name: "web" }, search: "web", actions: ["logs"] }],
  });
  return { sent, receive };
}

describe("webview App", () => {
  beforeEach(() => (document.body.innerHTML = ""));

  it("updates the drawer in place instead of recreating it (no blinking)", () => {
    const { receive } = setup();
    (document.querySelector(".row:not(.head)") as HTMLElement).click();
    receive({ type: "details", details: details("9m") });
    const drawer = document.querySelector(".drawer");
    expect(drawer?.textContent).toContain("9m ago");

    receive({ type: "details", details: details("10m") });
    expect(document.querySelector(".drawer")).toBe(drawer);
    expect(drawer?.textContent).toContain("10m ago");
  });

  it("asks for a Secret value only when its eye button is clicked", () => {
    const { sent, receive } = setup();
    (document.querySelector(".row:not(.head)") as HTMLElement).click();
    receive({
      type: "details",
      details: { ...details("1m"), sections: [{ type: "items", items: [{ name: "password", value: "8 bytes", secretKey: "password" }] }] },
    });
    expect(document.querySelector(".secret-mask")).not.toBeNull();
    expect(sent.some((m) => m.type === "revealSecret")).toBe(false);

    (document.querySelector('[data-action="toggle-secret"]') as HTMLElement).click();
    expect(sent.at(-1)).toEqual({ type: "revealSecret", ref, key: "password" });
    receive({ type: "secretValue", uid: "u1", key: "password", value: "s3cr3t" });
    expect(document.querySelector(".secret-value")?.textContent).toBe("s3cr3t");
  });
});
