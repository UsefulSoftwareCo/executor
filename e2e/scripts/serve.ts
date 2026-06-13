// Static server for runs/ — the review URL. Supports range requests so the
// session videos seek/stream, gzips text assets, and marks vite's hashed
// /assets/ as immutable so Monaco/React chunks download once, ever.
// `bun e2e/scripts/serve.ts` → prints the bound URL (default port 8901, but
// it walks forward to the next free port if that's taken, so two worktrees —
// or a leaked previous viewer — never wedge each other). `PORT=…` pins a port
// explicitly and fails loudly if it's busy (the strictPort rule from
// src/ports.ts). The SPA itself is port- and mount-agnostic (relative assets +
// hash routing), so any port the server lands on just works in the browser.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const ROOT = fileURLToPath(new URL("../runs/", import.meta.url));
// Explicit PORT pins (and fails visibly if busy); otherwise 8901 is just a
// starting preference we walk forward from.
const PINNED = process.env.PORT !== undefined;
const PREFERRED = Number(process.env.PORT ?? 8901);

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

const server = createServer((req, res) => {
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
});

// Host omitted → bind every interface (reachable over the tailnet). On a busy
// port: a pinned PORT is a hard error (predictable, matches --strictPort); an
// unpinned default walks forward to the next free port instead of crashing.
const MAX_WALK = 50;
const listen = (port: number, attempt = 0): void => {
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    if (PINNED) {
      console.error(`e2e viewer: PORT=${port} is in use — free it or pick another port.`);
      process.exit(1);
    }
    if (attempt >= MAX_WALK) {
      console.error(`e2e viewer: no free port found in ${PREFERRED}..${PREFERRED + MAX_WALK}.`);
      process.exit(1);
    }
    console.warn(`e2e viewer: port ${port} in use, trying ${port + 1}…`);
    listen(port + 1, attempt + 1);
  });
  server.listen(port, () => {
    const actual = (server.address() as AddressInfo).port;
    console.log(`e2e viewer → http://localhost:${actual}/`);
  });
};

listen(PREFERRED);
