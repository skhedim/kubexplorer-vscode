// @vitest-environment happy-dom
// The webview App, rendered in a simulated DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let app: App | undefined;

function setup() {
  document.body.innerHTML = `<div id="app"></div>`;
  const sent: WebviewMessage[] = [];
  let state: unknown;
  app = new App(document.getElementById("app")!, {
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

const podRow = (i: number, cells: Row["cells"] = {}): Row => ({
  uid: `u${i}`,
  ref: { resource: "pods", namespace: "default", name: `pod-${i}` },
  cells: { name: `pod-${i}`, ...cells },
  sort: { name: `pod-${i}` },
  search: `pod-${i}`,
  actions: ["logs"],
});

const renderedNames = () => [...document.querySelectorAll(".row:not(.head) .col-name")].map((c) => c.textContent);

describe("webview App", () => {
  beforeEach(() => (document.body.innerHTML = ""));
  afterEach(() => {
    app?.dispose();
    vi.useRealTimers();
  });

  it("renders only the rows in view of a long list, and the others as it scrolls", async () => {
    const { receive } = setup();
    receive({ type: "rows", loading: false, rows: Array.from({ length: 5000 }, (_, i) => podRow(i)) });
    const rendered = document.querySelectorAll(".row:not(.head)");
    // Without a layout, the view is 1000 px high: 36 rows of 28 px, and 10 more below.
    expect(rendered.length).toBe(46);
    expect(document.querySelector(".table")?.getAttribute("aria-rowcount")).toBe("5001");
    const body = document.getElementById("r-body")!;
    body.scrollTop = 28 * 3000;
    body.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(r));
    const first = document.querySelector(".row:not(.head)")!;
    // Sorted by name: pod-2689 is the 2,991st (natural order), 10 rows above those in view.
    expect(first.getAttribute("aria-rowindex")).toBe("2992");
    expect(document.querySelectorAll(".row:not(.head)").length).toBe(56);
  });

  it("keeps rows of equal value in place as they change, sorted by name", () => {
    const { receive } = setup();
    const inNs = (i: number, ns: string) => ({
      ...podRow(i),
      cells: { name: `pod-${i}`, namespace: ns },
      sort: { name: `pod-${i}`, namespace: ns },
    });
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
        columns: [
          { id: "name", title: "Name" },
          { id: "namespace", title: "Namespace" },
        ],
        hasWarnings: false,
        defaultSort: { col: "namespace", desc: false },
      },
    });
    receive({ type: "rows", loading: false, rows: [inNs(3, "b"), inNs(1, "a"), inNs(2, "a"), inNs(4, "b")] });
    (document.querySelector('[data-action="sort"][data-col="namespace"]') as HTMLElement).click();
    expect(renderedNames()).toEqual(["pod-1", "pod-2", "pod-3", "pod-4"]);
    receive({ type: "rowsPatch", loading: false, upsert: [{ ...inNs(1, "a"), search: "changed" }], remove: [] });
    expect(renderedNames()).toEqual(["pod-1", "pod-2", "pod-3", "pod-4"]);
    receive({ type: "rowsPatch", loading: false, upsert: [inNs(0, "b")], remove: ["u4"] });
    expect(renderedNames()).toEqual(["pod-1", "pod-2", "pod-0", "pod-3"]);
  });

  it("applies the changes of the rows sent by the extension", () => {
    const { receive } = setup();
    receive({ type: "rows", loading: false, rows: [podRow(1), podRow(2), podRow(3)] });
    receive({ type: "rowsPatch", loading: false, upsert: [podRow(2, { name: "pod-2 (changed)" }), podRow(4)], remove: ["u1"] });
    expect(renderedNames()).toEqual(["pod-2 (changed)", "pod-3", "pod-4"]);
    expect(document.querySelector(".count")?.textContent).toBe("3 items");
  });

  it("computes the ages when rendering, and keeps them current", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-28T12:00:00Z"));
    const { receive } = setup();
    const age = (row: Row) => ({ ...row, cells: { ...row.cells, age: { since: "2026-10-28T11:51:00Z" } } });
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
        columns: [
          { id: "name", title: "Name" },
          { id: "age", title: "Age" },
        ],
        hasWarnings: false,
        defaultSort: { col: "name", desc: false },
      },
    });
    receive({ type: "rows", loading: false, rows: [age(podRow(1))] });
    const cell = () => document.querySelector(".row:not(.head) .col-age")!;
    expect(cell().textContent).toBe("9m");
    expect(cell().querySelector("[title]")?.getAttribute("title")).toBe("2026-10-28T11:51:00Z");
    vi.advanceTimersByTime(60_000);
    expect(cell().textContent).toBe("10m");
  });

  it("moves the selection with the arrow keys, scrolling the list to it", () => {
    const { sent, receive } = setup();
    receive({ type: "rows", loading: false, rows: Array.from({ length: 200 }, (_, i) => podRow(i)) });
    (document.querySelector(".row:not(.head)") as HTMLElement).click();
    expect(sent.at(-1)).toEqual({ type: "showDetails", ref: podRow(0).ref });
    for (let i = 0; i < 40; i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    // Natural order: pod-0, pod-1, …, pod-40.
    expect(sent.at(-1)).toEqual({ type: "showDetails", ref: podRow(40).ref });
    // Row 40 ends at 41 × 28 px: the list scrolled so that it is in view (1000 px high).
    expect(document.getElementById("r-body")!.scrollTop).toBe(41 * 28 - 1000);
  });

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
