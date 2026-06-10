// Static server for runs/ — the review URL. Supports range requests so the
// session videos seek/stream, gzips text assets, and marks vite's hashed
// /assets/ as immutable so Monaco/React chunks download once, ever.
// `bun e2e/scripts/serve.ts` → http://host:8901
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const ROOT = fileURLToPath(new URL("../runs/", import.meta.url));
const PORT = Number(process.env.PORT ?? 8901);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ts": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
};

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".map", ".svg", ".json", ".ts"]);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (path === "" || path === ".") path = "index.html";
  let file = join(ROOT, path);
  // Directory request → its index.html (the page itself fixes a missing
  // trailing slash client-side; a server redirect would drop the /runs mount).
  if (file.startsWith(ROOT) && existsSync(file) && statSync(file).isDirectory()) {
    file = join(file, "index.html");
  }
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  const size = statSync(file).size;
  const ext = extname(file);
  const type = MIME[ext] ?? "application/octet-stream";
  // trace.playwright.dev fetches trace.zip from the user's browser — allow it.
  res.setHeader("access-control-allow-origin", "*");
  // Vite content-hashes /assets/ filenames → cache forever. Everything else
  // (run data, index.html) must revalidate so fresh runs show up.
  res.setHeader(
    "cache-control",
    path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  );
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, {
      "content-type": type,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  const wantsGzip =
    COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  if (wantsGzip) {
    res.writeHead(200, {
      "content-type": type,
      "content-encoding": "gzip",
      vary: "accept-encoding",
    });
    createReadStream(file).pipe(createGzip()).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`e2e viewer → http://localhost:${PORT}/`));
