// Screenshots of the browser preview (real webview and controller, demo cluster) with headless Chromium.
// Output: screenshots/preview-*.png. Fails when the page reports a JavaScript error.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startServer } from "./preview-server.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "screenshots");
mkdirSync(out, { recursive: true });

const server = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `preview-${name}.png`) });
  console.log(`  preview-${name}.png`);
};
const open = async (query) => {
  await page.goto(`http://localhost:5178/?${query}`);
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`http://localhost:5178/?${query}`);
  await page.waitForSelector(".table .row:not(.head), .overview-statuses");
  await page.evaluate(() => document.fonts.ready);
};

try {
  await open("resource=pods");
  await shot("pods");
  await page.click('.row:has-text("fraud-scorer")');
  await page.waitForSelector(".drawer .group-title");
  await shot("pod-details");

  await open("resource=secrets");
  await page.click('.row:has-text("payments-db")');
  await page.click('[data-action="toggle-secret"][data-key="password"]');
  await page.waitForSelector(".secret-value");
  await shot("secret-revealed");

  await open("resource=overview");
  await shot("overview");

  await open("resource=deployments&appearance=freelens");
  await page.click('.row:has-text("web-app")');
  await page.waitForSelector(".drawer .table");
  await shot("freelens-appearance");

  await open("resource=pods&theme=light");
  await shot("light-theme");
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  console.error(`JavaScript errors in the page:\n${errors.join("\n")}`);
  process.exit(1);
}
