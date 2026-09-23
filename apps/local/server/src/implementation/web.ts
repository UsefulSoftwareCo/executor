/** Public static shell; every data read still goes through authenticated dashboard routes. */
import { Effect, Path, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

/** Serve the built SPA and its bundled assets from the local host. */
export const webFiles = Effect.gen(function* () {
  const path = yield* Path.Path;
  const directory = yield* path.fromFileUrl(new URL("../../../web/dist/", import.meta.url));
  const document = HttpServerResponse.file(path.join(directory, "index.html"), {
    contentType: "text/html",
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // The MCP consent page grants credentials on one click, and a same-site
      // loopback page on any other port would otherwise be able to frame it.
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text(
          "Dashboard files could not be loaded. Run bun run web:build from the repository root.",
          { status: 503 },
        ),
      ),
    ),
  );
  const favicon = HttpServerResponse.file(path.join(directory, "favicon.png"), {
    contentType: "image/png",
    headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" },
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))));
  const asset = Effect.gen(function* () {
    const { name } = yield* HttpRouter.schemaPathParams(
      Schema.Struct({
        name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/)),
      }),
    );
    return yield* HttpServerResponse.file(path.join(directory, "assets", name), {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))));
  return {
    document,
    favicon,
    asset,
    fallback: Effect.succeed(HttpServerResponse.empty({ status: 404 })),
  };
});
