// Bundles the extension (Node.js, CommonJS), the webview and the browser preview (IIFE) with esbuild.
//   node scripts/build.mjs [--watch] [--production] [--tests]
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const production = args.has("--production");

// Runtime assets copied from node_modules: codicons (native VS Code icons) and Roboto (Freelens appearance).
mkdirSync(join(root, "media", "fonts"), { recursive: true });
mkdirSync(join(root, "media", "codicons"), { recursive: true });
for (const weight of [400, 500, 700]) {
  cpSync(
    join(root, "node_modules/@fontsource/roboto/files", `roboto-latin-${weight}-normal.woff2`),
    join(root, "media", "fonts", `roboto-${weight}.woff2`),
  );
}
for (const file of ["codicon.css", "codicon.ttf"]) {
  cpSync(join(root, "node_modules/@vscode/codicons/dist", file), join(root, "media", "codicons", file));
}

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: "info" };
const browser = { ...common, platform: "browser", format: "iife", target: "es2022" };

const targets = [
  {
    ...common,
    entryPoints: [join(root, "src/extension.ts")],
    outfile: join(root, "dist/extension.js"),
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  { ...browser, entryPoints: [join(root, "src/webview/index.ts")], outfile: join(root, "media/dist/webview.js") },
];

if (!production) {
  // The real webview and controller on the demo cluster, to work on the design in a browser.
  targets.push({ ...browser, entryPoints: [join(root, "dev/preview.ts")], outfile: join(root, "media/dist/preview.js") });
}

if (args.has("--tests")) {
  const dir = join(root, "test/integration");
  targets.push({
    ...common,
    sourcemap: true,
    entryPoints: readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => join(dir, f)),
    outdir: join(root, "out-test"),
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode", "mocha"],
  });
}

if (args.has("--watch")) {
  for (const target of targets) await (await context(target)).watch();
} else {
  await Promise.all(targets.map((target) => build(target)));
}
