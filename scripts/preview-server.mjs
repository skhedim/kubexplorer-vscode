// Serves the browser preview: the real webview and controller on the demo cluster.
//   npm run preview   then open http://localhost:5178/?resource=pods
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 5178);
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

/** Maps a URL path to a file under media/ (or the preview page), refusing anything outside. */
function resolvePath(urlPath) {
  if (urlPath === "/") return join(root, "dev", "preview.html");
  const file = normalize(join(root, "media", urlPath));
  return file.startsWith(join(root, "media") + sep) ? file : undefined;
}

export function startServer() {
  const server = createServer(async (req, res) => {
    const file = resolvePath(decodeURIComponent(new URL(req.url, "http://localhost").pathname));
    try {
      if (!file) throw new Error("forbidden");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
  console.log(`Preview: http://localhost:${port}/?resource=pods`);
}
