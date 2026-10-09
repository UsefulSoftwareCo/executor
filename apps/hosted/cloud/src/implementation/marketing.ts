/** Built marketing files for local development. The composition root owns their routes. */
import { Effect, FileSystem, Path } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/** Discover public files once; never resolve an arbitrary browser path directly on disk. */
export const marketingFiles = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.access(path.join(directory, "index.html"));
    const entries = (yield* fs.readDirectory(directory)).filter((name) => !name.startsWith("."));
    const paths: Array<HttpRouter.PathInput> = [];
    for (const name of entries) {
      if (name === "home" || name === "home.html") continue;
      const info = yield* fs.stat(path.join(directory, name));
      paths.push(info.type === "Directory" ? `/${name}/*` : `/${name}`);
      if (name.endsWith(".html")) paths.push(`/${name.slice(0, -5)}`);
    }
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
    const document = HttpServerResponse.file(path.join(directory, "index.html"), {
      contentType: "text/html",
    });
    const asset = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = yield* Effect.try(() =>
        decodeURIComponent(new URL(request.url, "http://localhost").pathname),
      );
      const relative = pathname.slice(1);
      const name = [relative, `${relative}.html`, `${relative.replace(/\/$/, "")}/index.html`].find(
        (name) => files.has(name),
      );
      if (name === undefined) return HttpServerResponse.empty({ status: 404 });
      return yield* HttpServerResponse.file(path.join(directory, name), {
        headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" },
      });
    }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))));
    return { paths, document, asset };
  });
