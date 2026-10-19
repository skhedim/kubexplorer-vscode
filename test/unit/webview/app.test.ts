// @vitest-environment happy-dom
// The webview App, rendered in a simulated DOM.
import { beforeEach, describe, expect, it } from "vitest";
import type { HostMessage, WebviewMessage } from "../../../src/shared/protocol";
import type { ActionId, Details, Row } from "../../../src/shared/view";
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
      target: { kind: "list", resource: "pods" },
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
  it("edits a Secret value in place: revealed first, saved with Ctrl+Enter, kept through refreshes", () => {
    const { sent, receive } = setup();
    (document.querySelector(".row:not(.head)") as HTMLElement).click();
    const secretDetails: Details = {
      ...details("1m"),
      sections: [{ type: "items", items: [{ name: "password", value: "8 bytes", secretKey: "password" }] }],
    };
    receive({ type: "details", details: secretDetails });
    (document.querySelector('[data-action="edit-secret"]') as HTMLElement).click();
    expect(sent.at(-1)).toEqual({ type: "revealSecret", ref, key: "password" });
    receive({ type: "secretValue", uid: "u1", key: "password", value: "\nold" });

    const editor = () => document.querySelector<HTMLTextAreaElement>(".secret-editor")!;
    expect(editor().value).toBe("\nold");
    expect(document.activeElement).toBe(editor());
    editor().value = "new value";
    editor().dispatchEvent(new Event("input", { bubbles: true }));
    // A refresh of the details keeps the draft, and the focus.
    receive({ type: "details", details: { ...secretDetails, title: "Pod: web (refreshed)" } });
    expect(editor().value).toBe("new value");
    expect(document.activeElement).toBe(editor());

    editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "updateSecret", ref, key: "password", value: "new value" });
    expect(editor().disabled).toBe(true);
    receive({ type: "secretUpdated", key: "password", saved: true });
    expect(document.querySelector(".secret-editor")).toBeNull();
    expect(document.querySelector(".secret-value")?.textContent).toBe("new value");
  });

  it("cancels an edit with Escape without closing the drawer, and shows a failed save", () => {
    const { sent, receive } = setup();
    (document.querySelector(".row:not(.head)") as HTMLElement).click();
    receive({
      type: "details",
      details: { ...details("1m"), sections: [{ type: "items", items: [{ name: "token", value: "4 bytes", secretKey: "token" }] }] },
    });
    receive({ type: "secretValue", uid: "u1", key: "token", value: "abcd" });
    (document.querySelector('[data-action="edit-secret"]') as HTMLElement).click();
    (document.querySelector('[data-action="save-secret"]') as HTMLElement).click();
    expect(sent.at(-1)).toMatchObject({ type: "updateSecret", value: "abcd" });
    receive({ type: "secretUpdated", key: "token", saved: false, error: "Conflict" });
    expect(document.querySelector(".secret-item .tone-error")?.textContent).toBe("Conflict");
    document.querySelector(".secret-editor")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".secret-editor")).toBeNull();
    expect(document.querySelector(".drawer")).not.toBeNull();
  });

  it("offers no Secret editing on a read-only context", () => {
    const { receive } = setup();
    receive({ type: "protection", protection: "readOnly" });
    (document.querySelector(".row:not(.head)") as HTMLElement).click();
    receive({
      type: "details",
      details: { ...details("1m"), sections: [{ type: "items", items: [{ name: "token", value: "4 bytes", secretKey: "token" }] }] },
    });
    expect(document.querySelector('[data-action="edit-secret"]')).toBeNull();
    expect(document.querySelector('[data-action="toggle-secret"]')).not.toBeNull();
  });

  it("offers the actions every checked row supports, and sends them for all the checked rows", () => {
    const { sent, receive } = setup();
    const deployment = (name: string, actions: ActionId[]): Row => ({
      uid: name,
      ref: { resource: "deployments", namespace: "shop", name },
      cells: { name },
      sort: { name },
      search: name,
      actions,
    });
    receive({
      type: "rows",
      loading: false,
      rows: [deployment("web", ["logs", "scale", "restart", "delete"]), deployment("agent", ["logs", "restart", "delete"])],
    });
    const check = (uid: string) => (document.querySelector(`[data-action="check"][data-uid="${uid}"]`) as HTMLElement).click();
    check("web");
    check("agent");
    const bar = document.querySelector(".bulk-bar")!;
    expect(bar.textContent).toContain("2 selected");
    const buttons = [...bar.querySelectorAll<HTMLElement>("[data-action=bulk]")].map((b) => b.dataset.act);
    expect(buttons).toEqual(["restart", "delete"]);
    (bar.querySelector('[data-act="restart"]') as HTMLElement).click();
    expect(sent.at(-1)).toEqual({
      type: "bulkAction",
      action: "restart",
      refs: [
        { resource: "deployments", namespace: "shop", name: "web" },
        { resource: "deployments", namespace: "shop", name: "agent" },
      ],
    });
    // The selection stays, to chain another action; the close button clears it.
    expect(document.querySelector(".bulk-bar")).not.toBeNull();
    (document.querySelector('[data-action="uncheck-all"]') as HTMLElement).click();
    expect(document.querySelector(".bulk-bar")).toBeNull();
  });

  it("flags a protected context in the header and around the tab", () => {
    const { receive } = setup();
    expect(document.querySelector(".protected-pill")).toBeNull();
    receive({ type: "protection", protection: "confirm" });
    expect(document.querySelector(".protected-pill")?.textContent).toContain("Protected");
    expect(document.body.dataset.protection).toBe("confirm");
    receive({ type: "protection", protection: "readOnly" });
    expect(document.querySelector(".protected-pill")?.textContent).toContain("Read-only");
  });
});
