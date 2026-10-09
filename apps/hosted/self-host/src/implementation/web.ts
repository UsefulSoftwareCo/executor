/** Dashboard serving for both self-host runtimes. Only file access differs between them. */
import { dashboardDocument } from "@executor-js/dashboard-start/document";
import { hostedDocumentContext } from "@executor-js/hosted-server/document";
import { singleResourceOrigin } from "@executor-js/mcp-auth/grants";
import { Config, Effect, FileSystem, Path, Result } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

/** The renderer is loaded on the first page request; API-only processes never load React. */
const document = dashboardDocument({
  server: Effect.promise(() => import("@executor-js/hosted-self-host-web/server")).pipe(
    Effect.map((module) => module.default),
  ),
  // Self-host serves its MCP and API resources on its single origin.
  context: (api) =>
    Config.String("BETTER_AUTH_URL").pipe(
      Effect.flatMap((origin) => hostedDocumentContext(singleResourceOrigin(origin))(api)),
    ),
});

/** Hashed build output never changes; everything else revalidates. */
export const fileHeaders = (relative: string) => ({
  "cache-control": /^assets\/[^/]+-[\w-]{8}\.[a-z\d]+$/i.test(relative)
    ? "public, max-age=31536000, immutable"
    : "no-cache",
  "x-content-type-options": "nosniff",
});

/**
 * Serve retained browser files and render pages; missing API paths and assets remain 404s.
 * `files` is the build's manifest, so a directory listing can never become a public page.
 */
export const dashboardRoutes = <E, R>(
  files: ReadonlySet<string>,
  file: (relative: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const decoded = yield* Effect.try(() =>
      decodeURIComponent(new URL(request.url, "http://localhost").pathname),
    ).pipe(Effect.result);
    if (Result.isFailure(decoded)) return HttpServerResponse.empty({ status: 400 });
    const pathname = decoded.success;
    if (
      /^\/(api|\.well-known)(\/|$)/.test(pathname) ||
      pathname === "/mcp" ||
      pathname === "/health" ||
      pathname === "/openapi.json"
    )
      return HttpServerResponse.empty({ status: 404 });
    const relative = pathname.slice(1);
    if (files.has(relative)) return yield* file(relative);
    // Any other address is a page. The router answers an unknown one with its not-found page
    // and a 404 status, for a browser or any other client.
    if (relative.startsWith("assets/") || relative.includes("."))
      return HttpServerResponse.empty({ status: 404 });
    return yield* document;
  });

/** Native development and HTTP tests read the build from disk. */
export const dashboardFiles = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = path.join(directory, "client");
    // Fail startup with an actionable filesystem error if the dashboard was not built.
    yield* fs.access(path.join(directory, "server", "server.js"));
    const names = yield* fs.readDirectory(client, { recursive: true });
    const files = new Set(
      (yield* Effect.forEach(
        names,
        (name) =>
          fs
            .stat(path.join(client, name))
            .pipe(
              Effect.map((info) =>
                info.type === "File" && !name.split(path.sep).some((part) => part.startsWith("."))
                  ? [name.split(path.sep).join("/")]
                  : [],
              ),
            ),
        { concurrency: 16 },
      )).flat(),
    );
    return dashboardRoutes(files, (relative) =>
      HttpServerResponse.file(path.join(client, relative), { headers: fileHeaders(relative) }),
    );
  });
