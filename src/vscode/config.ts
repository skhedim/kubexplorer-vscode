import * as vscode from "vscode";
import type { Appearance } from "../shared/protocol";

const CONFIG_SECTION = "kubexplorer";

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/** Typed access to the `kubexplorer.*` settings (read on every call: changes apply immediately). */
export const config = {
  kubectlPath: (): string => settings().get<string>("kubectlPath") || "kubectl",
  helmPath: (): string => settings().get<string>("helmPath") || "helm",
  watch: (): boolean => settings().get<boolean>("watch", true),
  pollIntervalMs: (): number => Math.max(2, settings().get<number>("pollInterval", 5)) * 1000,
  reuseTab: (): boolean => settings().get<boolean>("reuseTab", true),
  appearance: (): Appearance => settings().get<Appearance>("appearance", "vscode"),
  confirmApply: (): boolean => settings().get<boolean>("confirmApply", true),
  logTailLines: (): number => settings().get<number>("logs.tailLines", 500),
  demoCluster: (): boolean => settings().get<boolean>("demoCluster", false),
  setDemoCluster: (enabled: boolean): Thenable<void> => settings().update("demoCluster", enabled, vscode.ConfigurationTarget.Global),
};
