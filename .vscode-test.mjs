// @vscode/test-cli configuration (npm run test:integration).
// KUBECONFIG points to files that only hold the local kind clusters (written by dev-cluster/setup.sh and
// dev-cluster/fleet/setup.sh), so integration tests can never reach another cluster.
import { defineConfig } from "@vscode/test-cli";
import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export default defineConfig({
  files: "out-test/**/*.test.js",
  version: process.env.VSCODE_TEST_VERSION ?? "stable",
  extensionDevelopmentPath: ".",
  launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
  // The mini fleet (dev-cluster/fleet/setup.sh), when created, adds its kind clusters for the fleet tests.
  env: {
    KUBECONFIG: [resolve("test/.kubeconfig-kind"), resolve("test/.kubeconfig-fleet")].filter((f) => existsSync(f)).join(delimiter),
  },
  mocha: { ui: "bdd", timeout: 60_000 },
});
