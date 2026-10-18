// Consistency of package.json: commands, menus and localized strings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_ACTIONS } from "../../src/shared/view";

const root = join(__dirname, "..", "..");
const manifestText = readFileSync(join(root, "package.json"), "utf8");
const manifest = JSON.parse(manifestText);
const nls = JSON.parse(readFileSync(join(root, "package.nls.json"), "utf8"));

describe("package.json", () => {
  it("declares a command and a context menu entry for every action", () => {
    const commands = new Set(manifest.contributes.commands.map((c: { command: string }) => c.command));
    const menu = new Set(manifest.contributes.menus["webview/context"].map((m: { command: string }) => m.command));
    for (const action of ALL_ACTIONS) {
      expect(commands.has(`kubexplorer.resource.${action}`), action).toBe(true);
      expect(menu.has(`kubexplorer.resource.${action}`), action).toBe(true);
    }
  });

  it("defines every %placeholder% in package.nls.json, and nothing more", () => {
    const used = new Set([...manifestText.matchAll(/"%([\w.]+)%"/g)].map((m) => m[1]));
    expect([...used].filter((key) => !(key in nls))).toEqual([]);
    expect(Object.keys(nls).filter((key) => !used.has(key))).toEqual([]);
  });

  it("hides argument-only commands from the command palette", () => {
    const hidden = new Set(
      manifest.contributes.menus.commandPalette
        .filter((m: { when: string }) => m.when === "false")
        .map((m: { command: string }) => m.command),
    );
    for (const action of ALL_ACTIONS) expect(hidden.has(`kubexplorer.resource.${action}`), action).toBe(true);
  });

  it("restricts executable paths in untrusted workspaces", () => {
    const restricted = manifest.capabilities.untrustedWorkspaces.restrictedConfigurations;
    expect(restricted).toEqual(["kubexplorer.kubectlPath", "kubexplorer.helmPath"]);
    for (const key of restricted) expect(manifest.contributes.configuration.properties[key].scope).toBe("machine-overridable");
  });
});
