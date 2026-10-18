// README screenshots, taken in a real VS Code (the one downloaded by @vscode/test-cli) driven by Playwright,
// against the development kind cluster only (dedicated KUBECONFIG).
//   npm run test:integration   (downloads VS Code once)
//   node scripts/vscode-screenshots.mjs
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "images");
mkdirSync(out, { recursive: true });

const install = readdirSync(join(root, ".vscode-test")).find((d) => d.startsWith("vscode-linux"));
if (!install) throw new Error("Run npm run test:integration first: it downloads VS Code into .vscode-test/");
const userData = mkdtempSync(join(tmpdir(), "kubexplorer-vscode-"));
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "window.commandCenter": false,
    "chat.commandCenter.enabled": false,
    "terminal.integrated.defaultProfile.linux": "bash",
  }),
);

const app = await electron.launch({
  executablePath: join(root, ".vscode-test", install, "code"),
  args: [
    `--extensionDevelopmentPath=${root}`,
    `--user-data-dir=${userData}`,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--new-window",
    "--disable-gpu",
  ],
  // Variables inherited from a parent VS Code (ELECTRON_RUN_AS_NODE, VSCODE_*) prevent the launch.
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ELECTRON_|VSCODE_)/.test(k))),
    KUBECONFIG: join(root, "test", ".kubeconfig-kind"),
  },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1600, height: 960 }).catch(() => undefined);
await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
await page.waitForTimeout(3000);

const shot = async (name) => {
  await page.waitForTimeout(1500);
  // Notifications specific to the test instance (disabled extensions…) would hide the UI.
  for (const close of await page.locator(".notifications-toasts .codicon-notifications-clear").all())
    await close.click().catch(() => undefined);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  docs/images/${name}.png`);
};
const webview = () => page.frameLocator("iframe.webview.ready").last().frameLocator("iframe#active-frame");
// Rows are matched on their exact text: their accessible name also includes inline actions.
const tree = (label) =>
  page
    .locator(".pane-body .monaco-list-row")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first();
const firstRow = () => webview().locator(".table .row:not(.head)").first();

try {
  await page.locator('.activitybar [aria-label^="KubeXplorer"]').first().click();
  await page.waitForSelector('.pane-body .monaco-list-row:has-text("Pods")', { timeout: 30_000 });

  await tree("Overview").click();
  await webview().locator(".overview-usage .gauge").first().waitFor({ timeout: 60_000 });
  await shot("overview");

  await tree("Pods").click();
  await firstRow().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500); // metrics
  await webview().locator('.row:has-text("fraud-scorer")').click();
  await webview().locator(".drawer .group-title").waitFor();
  await shot("pods");

  // Logs from the drawer: VS Code terminal.
  await webview().locator('.drawer-title [data-act="logs"]').click();
  await page.waitForSelector(".quick-input-widget:visible", { timeout: 10_000 });
  await page.keyboard.press("Enter");
  await page.waitForSelector(".terminal-wrapper", { timeout: 15_000 });
  await webview().locator('[data-action="close-drawer"]').click();
  // The native context menu reacts badly to synthetic clicks: keyboard navigation.
  await webview().locator('.row:has-text("payments-api") >> nth=0').click({ button: "right" });
  await page.getByRole("menuitem", { name: /Logs/ }).waitFor();
  await shot("logs-and-context-menu");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await tree("Workloads").click();
  await tree("Config").click();
  await tree("Secrets").click();
  await webview().locator('.row:has-text("payments-db")').click();
  await webview().locator('[data-action="toggle-secret"][data-key="password"]').click();
  await webview().locator(".secret-value").waitFor({ timeout: 10_000 });
  await shot("secrets");

  await tree("Config").click();
  await tree("Helm").click();
  await tree("Releases").click();
  await webview().locator('.row:has-text("shop-landing")').first().click();
  await webview().locator(".drawer .table").waitFor({ timeout: 30_000 });
  await shot("helm");
} catch (err) {
  await page.screenshot({ path: join(root, "screenshots", "error.png") }).catch(() => undefined);
  throw err;
} finally {
  await app.close();
}
