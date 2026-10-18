// Renders media/icon.svg to media/icon.png (128x128, required by the Marketplace: SVG icons are not allowed).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const media = join(dirname(fileURLToPath(import.meta.url)), "..", "media");
const svg = readFileSync(join(media, "icon.svg"), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
await page.setContent(
  `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", '<svg width="128" height="128" ')}</body></html>`,
);
await page.locator("svg").screenshot({ path: join(media, "icon.png"), omitBackground: true });
await browser.close();
console.log("media/icon.png written");
