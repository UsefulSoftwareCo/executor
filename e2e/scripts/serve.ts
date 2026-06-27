// Static server for sanitized e2e evidence. Only explicit publication
// artifacts are reachable. Token-bearing CLI homes, MCP configs, telemetry
// databases, temp files, and arbitrary run-directory contents stay private.
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

import {
  publishedArtifactFor,
  sanitizePublishedCast,
  sanitizePublishedJson,
  sanitizePublishedText,
  type PublishedArtifact,
} from "../src/published-artifacts";
import {
  LANE_PROVENANCE_FILE,
  visualEvidencePublicationDecision,
} from "../src/evidence-provenance";

const ROOT = fileURLToPath(new URL("../runs/", import.meta.url));
const PINNED = process.env.PORT !== undefined;
const PREFERRED = Number(process.env.PORT ?? 8901);
const INCLUDE_RAW_TRACE = process.env.E2E_VIEWER_INCLUDE_RAW_TRACE === "1";
const TRUSTED_PROJECT = process.env.E2E_PROJECT ?? process.env.E2E_TARGET ?? "";
const MAX_SANITIZED_BYTES = 20 * 1024 * 1024;
const COMPRESSIBLE = new Set<PublishedArtifact["kind"]>(["static", "json", "text"]);

const notFound = (response: ServerResponse): void => {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
};

const unsafePath = (file: string): boolean => {
  const root = realpathSync(ROOT);
  const actual = realpathSync(file);
  return actual !== root && !actual.startsWith(`${root}${sep}`);
};

const requestedPath = (requestUrl: string): string | undefined => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(new URL(requestUrl, "http://viewer.invalid").pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return undefined;
  const normalized = decoded.replace(/^\/+|\/+$/g, "");
  if (normalized === "") return "index.html";
  if (normalized === "trace-viewer") return "trace-viewer/index.html";
  const resolved = resolve(ROOT, normalized);
  if (resolved !== resolve(ROOT) && !resolved.startsWith(`${resolve(ROOT)}${sep}`))
    return undefined;
  return relative(ROOT, resolved).split(sep).join("/");
};

const securityHeaders = (response: ServerResponse): void => {
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
};

const sanitizedContents = (
  relativePath: string,
  artifact: PublishedArtifact,
  file: string,
): Buffer | undefined => {
  const size = statSync(file).size;
  if (size > MAX_SANITIZED_BYTES) return undefined;
  const raw = readFileSync(file, "utf8");
  if (artifact.kind === "json") {
    return Buffer.from(
      sanitizePublishedJson(relativePath, raw, { includeRawTrace: INCLUDE_RAW_TRACE }),
    );
  }
  if (relativePath.endsWith("/terminal.cast")) {
    return Buffer.from(sanitizePublishedCast(raw));
  }
  return Buffer.from(sanitizePublishedText(raw));
};

const visualEvidenceIsSynthetic = (file: string, target: string): boolean => {
  try {
    const result: unknown = JSON.parse(readFileSync(join(dirname(file), "result.json"), "utf8"));
    const provenance: unknown = JSON.parse(
      readFileSync(join(dirname(file), LANE_PROVENANCE_FILE), "utf8"),
    );
    return visualEvidencePublicationDecision(result, provenance, target, TRUSTED_PROJECT).publish;
  } catch {
    return false;
  }
};

const sendBuffer = (
  response: ServerResponse,
  requestMethod: string | undefined,
  artifact: PublishedArtifact,
  contents: Buffer,
  acceptsGzip: boolean,
): void => {
  if (acceptsGzip && COMPRESSIBLE.has(artifact.kind)) {
    response.writeHead(200, {
      "content-type": artifact.mime,
      "content-encoding": "gzip",
      vary: "accept-encoding",
    });
    if (requestMethod === "HEAD") response.end();
    else Readable.from([contents]).pipe(createGzip()).pipe(response);
    return;
  }
  response.writeHead(200, {
    "content-type": artifact.mime,
    "content-length": contents.byteLength,
  });
  response.end(requestMethod === "HEAD" ? undefined : contents);
};

const sendFile = (
  response: ServerResponse,
  requestMethod: string | undefined,
  rangeHeader: string | undefined,
  artifact: PublishedArtifact,
  file: string,
): void => {
  const size = statSync(file).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader ?? "");
  if (range) {
    const start = Number(range[1]);
    const requestedEnd = range[2] ? Number(range[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size) {
      response.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    const end = Math.min(requestedEnd, size - 1);
    if (end < start) {
      response.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    response.writeHead(206, {
      "content-type": artifact.mime,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
    });
    if (requestMethod === "HEAD") response.end();
    else createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, {
    "content-type": artifact.mime,
    "content-length": size,
    "accept-ranges": "bytes",
  });
  if (requestMethod === "HEAD") response.end();
  else createReadStream(file).pipe(response);
};

const server = createServer((request, response) => {
  securityHeaders(response);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }

  const path = requestedPath(request.url ?? "/");
  const artifact = path
    ? publishedArtifactFor(path, { includeRawTrace: INCLUDE_RAW_TRACE })
    : undefined;
  if (!path || !artifact) {
    notFound(response);
    return;
  }

  const file = join(ROOT, ...path.split("/"));
  if (
    !existsSync(file) ||
    lstatSync(file).isSymbolicLink() ||
    !statSync(file).isFile() ||
    unsafePath(file)
  ) {
    notFound(response);
    return;
  }

  const immutable = path.startsWith("assets/") || path.startsWith("trace-viewer/");
  response.setHeader(
    "cache-control",
    immutable ? "public, max-age=31536000, immutable" : "private, no-store",
  );

  if (artifact.kind === "json" || artifact.kind === "text") {
    try {
      const contents = sanitizedContents(path, artifact, file);
      if (!contents) {
        response
          .writeHead(413, { "content-type": "text/plain; charset=utf-8" })
          .end("artifact too large to sanitize");
        return;
      }
      sendBuffer(
        response,
        request.method,
        artifact,
        contents,
        /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? "")),
      );
    } catch {
      response
        .writeHead(422, { "content-type": "text/plain; charset=utf-8" })
        .end("artifact could not be sanitized");
    }
    return;
  }

  if (artifact.unredactedVisual && !visualEvidenceIsSynthetic(file, path.split("/")[0] ?? "")) {
    response
      .writeHead(403, { "content-type": "text/plain; charset=utf-8" })
      .end("visual evidence lacks matching synthetic-only lane provenance");
    return;
  }

  sendFile(response, request.method, request.headers.range, artifact, file);
});

// Host omitted intentionally: the viewer remains reachable over the tailnet.
// A pinned port fails loudly; an unpinned preference walks to a free port.
const MAX_WALK = 50;
const listen = (port: number, attempt = 0): void => {
  const onError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") throw error;
    if (PINNED) {
      console.error(`e2e viewer: PORT=${port} is in use; free it or pick another port.`);
      process.exit(1);
    }
    if (attempt >= MAX_WALK) {
      console.error(`e2e viewer: no free port found in ${PREFERRED}..${PREFERRED + MAX_WALK}.`);
      process.exit(1);
    }
    console.warn(`e2e viewer: port ${port} in use, trying ${port + 1}`);
    listen(port + 1, attempt + 1);
  };
  server.once("error", onError);
  server.listen(port, () => {
    server.off("error", onError);
    const actual = (server.address() as AddressInfo).port;
    console.log(`e2e viewer: http://localhost:${actual}/`);
    if (!INCLUDE_RAW_TRACE) {
      console.log(
        "e2e viewer: raw trace.zip files are private; set E2E_VIEWER_INCLUDE_RAW_TRACE=1 for trusted local use",
      );
    }
  });
};

listen(PREFERRED);
