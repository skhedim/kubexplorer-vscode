// README screenshots, taken in a real VS Code (the one downloaded by @vscode/test-cli) driven by Playwright,
// against the development kind cluster only (dedicated KUBECONFIG).
//   npm run test:integration   (downloads VS Code once)
//   node scripts/vscode-screenshots.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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
    // The kind cluster, and the mini fleet when created (dev-cluster/fleet/setup.sh).
    KUBECONFIG: [join(root, "test", ".kubeconfig-kind"), join(root, "test", ".kubeconfig-fleet")]
      .filter((f) => existsSync(f))
      .join(delimiter),
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
/** A row of the main list: the list renders the rows in view only, so it is scrolled until the row shows up. */
const listRow = async (text) => {
  const body = webview().locator("#r-body");
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = webview().locator(`.table.virtual .row:has-text("${text}")`).first();
    if (await row.count()) return row;
    await body.evaluate((el) => (el.scrollTop += el.clientHeight * 0.8));
    await page.waitForTimeout(150);
  }
  throw new Error(`No row ${text} in the list`);
};
/** An entry of a section of the Resources view (several sections have an "Overview"). */
const child = async (parent, label) => {
  const rows = page.locator(".pane-body .monaco-list-row");
  // The children show up once the section is expanded.
  for (let attempt = 0; attempt < 20; attempt++) {
    const texts = (await rows.allTextContents()).map((t) => t.trim());
    const start = texts.indexOf(parent);
    const i = texts.findIndex((t, j) => j > start && t === label);
    if (start >= 0 && i >= 0) return rows.nth(i);
    await page.waitForTimeout(250);
  }
  throw new Error(`${parent} > ${label} is not in the Resources view`);
};
/** Moves the mouse over the chart of the drawer, to show its tooltip. */
const hoverChart = async () => {
  await webview().locator(".drawer .chart-svg .line").first().waitFor({ timeout: 60_000 });
  const box = await webview().locator(".drawer .chart-svg").boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
};

try {
  await page.locator('.activitybar [aria-label^="KubeXplorer"]').first().click();
  await page.waitForSelector('.pane-body .monaco-list-row:has-text("Pods")', { timeout: 30_000 });

  await tree("Cluster").click();
  await webview().locator(".overview-usage .gauge").first().waitFor({ timeout: 60_000 });
  await shot("overview");

  await tree("Diagnostics").click();
  await webview().locator(".overview-table .row:not(.head)").first().waitFor({ timeout: 60_000 });
  await shot("diagnostics");

  await tree("Pods").click();
  await firstRow().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500); // metrics
  await (await listRow("prometheus-server")).click();
  await webview().locator(".drawer .group-title").first().waitFor();
  await hoverChart();
  await shot("pods");

  // Logs from the drawer: VS Code terminal.
  await webview().locator('.drawer-title [data-act="logs"]').click();
  // A quick pick asks which logs only for a container that restarted.
  await page
    .waitForSelector(".quick-input-widget:visible", { timeout: 3_000 })
    .then(() => page.keyboard.press("Enter"))
    .catch(() => undefined);
  await page.waitForSelector(".terminal-wrapper", { timeout: 15_000 });
  await webview().locator('[data-action="close-drawer"]').click();
  // The native context menu reacts badly to synthetic clicks: keyboard navigation.
  await (await listRow("payments-api")).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Logs/ }).waitFor();
  await shot("logs-and-context-menu");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Closes the panel of the logs terminal.
  await page.keyboard.press("Control+J");

  await tree("Workloads").click();
  await tree("Config").click();
  await tree("Secrets").click();
  await (await listRow("payments-db")).click();
  await webview().locator('[data-action="toggle-secret"][data-key="password"]').click();
  await webview().locator(".secret-value").waitFor({ timeout: 10_000 });
  await shot("secrets");

  await tree("Config").click();
  await tree("Helm").click();
  await tree("Releases").click();
  await (await listRow("shop-landing")).click();
  await webview().locator(".drawer .table").waitFor({ timeout: 30_000 });
  await shot("helm");
  await tree("Helm").click();

  // Integrations: dev-cluster/setup.sh --addons installs Flux and a simulated Karpenter.
  await tree("Flux").click();
  await (await child("Flux", "Overview")).click();
  await webview().locator(".overview-statuses .workload").first().waitFor({ timeout: 60_000 });
  await shot("flux-overview");
  await (await child("Flux", "Kustomizations")).click();
  await firstRow().waitFor({ timeout: 30_000 });
  await webview().locator('.table.virtual .row:has(.col-name :text-is("podinfo"))').first().click();
  await webview().locator(".drawer .table.grid").first().waitFor({ timeout: 30_000 });
  await shot("flux-kustomizations");
  await tree("Flux").click();

  await tree("Karpenter").click();
  await (await child("Karpenter", "Overview")).click();
  await webview().locator(".overview-cards .overview-card").first().waitFor({ timeout: 60_000 });
  await shot("karpenter");
  await (await child("Karpenter", "Node Pools")).click();
  await (await listRow("default")).click();
  await webview().locator(".drawer .table").first().waitFor({ timeout: 30_000 });
  await shot("karpenter-nodepool");

  // The Fleet tab, on the mini fleet.
  if (existsSync(join(root, "test", ".kubeconfig-fleet"))) {
    await page.keyboard.press("F1");
    await page.keyboard.type("KubeXplorer: Open Fleet");
    await page.keyboard.press("Enter");
    await webview().locator('.overview-table .row:not(.head):has-text("kind-fleet-prod-1")').waitFor({ timeout: 90_000 });
    await webview().locator(".count:not(:has(.spinner))").waitFor({ timeout: 90_000 });
    await shot("fleet");
    await webview().locator('[data-action="fleet-tab"][data-tab="flux"]').click();
    await webview().locator('.overview-table .row:has-text("GitRepository podinfo")').first().click();
    await webview().locator(".drawer .table.grid").waitFor({ timeout: 30_000 });
    await shot("fleet-flux");
  }
} catch (err) {
  await page.screenshot({ path: join(root, "screenshots", "error.png") }).catch(() => undefined);
  throw err;
} finally {
  await app.close();
}
