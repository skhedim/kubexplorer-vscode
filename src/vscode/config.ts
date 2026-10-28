import * as vscode from "vscode";
import type { FleetGroups } from "../resources/fleet";
import type { ProtectionMode } from "../shared/protection";
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
  prometheus: (): string => settings().get<string>("prometheus", ""),
  protectedContexts: (): string[] => settings().get<string[]>("protectedContexts", ["*prod*"]),
  protectedContextsMode: (): ProtectionMode => settings().get<ProtectionMode>("protectedContextsMode", "confirm"),
  debugImage: (): string => settings().get<string>("debug.image") || "busybox:1.37",
  fleetGroups: (): FleetGroups => settings().get<FleetGroups>("fleet.groups", { prod: ["*prod*"], dev: ["*dev*"] }),
  fleetContexts: (): string[] => settings().get<string[]>("fleet.contexts", ["*"]),
  fleetConcurrency: (): number => Math.min(32, Math.max(1, settings().get<number>("fleet.concurrency", 8))),
  fleetRefreshIntervalMs: (): number => Math.max(30, settings().get<number>("fleet.refreshInterval", 120)) * 1000,
  fleetDriftGraceMs: (): number => Math.max(0, settings().get<number>("fleet.driftGrace", 10)) * 60_000,
  setDemoCluster: (enabled: boolean): Thenable<void> => settings().update("demoCluster", enabled, vscode.ConfigurationTarget.Global),
};
