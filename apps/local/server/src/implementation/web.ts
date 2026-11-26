import { dashboardDocument, withSameSiteReload } from "@executor-js/dashboard-start/document";
import { Effect, Path, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

export const webFiles = Effect.gen(function* () {
  const path = yield* Path.Path;
  const directory = yield* path.fromFileUrl(new URL("../../../web/dist/client/", import.meta.url));
  const document = withSameSiteReload(
    dashboardDocument({
      server: Effect.promise(() => import("@executor-js/local-web/server")).pipe(
        Effect.map((module) => module.default),
      ),
      context: () => Effect.succeed({}),
      headers: { "referrer-policy": "no-referrer" },
    }),
  );
  const favicon = HttpServerResponse.file(path.join(directory, "favicon.png"), {
    contentType: "image/png",
    headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" },
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))));
  const asset = Effect.gen(function* () {
    const { name } = yield* HttpRouter.schemaPathParams(
      Schema.Struct({
        name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/u)),
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
