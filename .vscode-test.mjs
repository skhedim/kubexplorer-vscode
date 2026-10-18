// @vscode/test-cli configuration (npm run test:integration).
// KUBECONFIG points to a file that only holds the local kind cluster (written by dev-cluster/setup.sh),
// so integration tests can never reach another cluster.
import { defineConfig } from "@vscode/test-cli";
import { resolve } from "node:path";

export default defineConfig({
  files: "out-test/**/*.test.js",
  version: process.env.VSCODE_TEST_VERSION ?? "stable",
  extensionDevelopmentPath: ".",
  launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
  env: { KUBECONFIG: resolve("test/.kubeconfig-kind") },
  mocha: { ui: "bdd", timeout: 60_000 },
});
