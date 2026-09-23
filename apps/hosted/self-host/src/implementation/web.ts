/** Filesystem asset serving belongs to the Docker host, not the shared hosted API. */
import { Effect, FileSystem, Path, Result } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/** The dashboard carries the MCP consent page, so no other site may frame these documents. */
const antiFraming = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
};

/** Serve only retained build files and browser page fallbacks; missing API/assets remain 404s. */
export const dashboardFiles = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Fail startup with an actionable filesystem error if the dashboard was not built.
    yield* fs.access(path.join(directory, "index.html"));
    const names = yield* fs.readDirectory(directory, { recursive: true });
    const files = new Set(
      (yield* Effect.forEach(
        names,
        (name) =>
          fs
            .stat(path.join(directory, name))
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

    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const decoded = yield* Effect.try(() =>
        decodeURIComponent(new URL(request.url, "http://localhost").pathname),
      ).pipe(Effect.result);
      if (Result.isFailure(decoded)) return HttpServerResponse.empty({ status: 400 });
      const pathname = decoded.success;
      if (
        pathname === "/mcp" ||
        pathname.startsWith("/.well-known/") ||
        pathname === "/api" ||
        pathname.startsWith("/api/") ||
        pathname === "/health" ||
        pathname === "/openapi.json"
      ) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      if (files.has(relative))
        return yield* HttpServerResponse.file(path.join(directory, relative), {
          headers: {
            "cache-control": /^assets\/[^/]+-[\w-]{8}\.[a-z\d]+$/i.test(relative)
              ? "public, max-age=31536000, immutable"
              : "no-cache",
            "x-content-type-options": "nosniff",
            ...(relative.endsWith(".html") ? antiFraming : {}),
          },
        });
      if (
        pathname.startsWith("/assets/") ||
        path.extname(pathname) !== "" ||
        !request.headers.accept?.includes("text/html")
      ) {
        return HttpServerResponse.empty({ status: 404 });
      }
      return yield* HttpServerResponse.file(path.join(directory, "index.html"), {
        headers: {
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
          ...antiFraming,
        },
      });
    });
  });
