import { WorkerEnvironment } from "alchemy/Cloudflare";
import { Effect, Predicate, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { homepageResponse } from "./homepage-response.ts";

const StaticAssets = Schema.declare(
  (value): value is { readonly fetch: (request: Request) => Promise<Response> } =>
    Predicate.isObject(value) && "fetch" in value && typeof value.fetch === "function",
);

class HomepageUnavailable extends Schema.TaggedError<HomepageUnavailable>()(
  "HomepageUnavailable",
  {},
) {}

/** Read retained assets through this request’s native binding without opening the auth database. */
export const staticDocument = (entry?: string) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const assets = yield* Schema.decodeUnknownEffect(StaticAssets)(env.ASSETS).pipe(Effect.orDie);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const web = yield* HttpServerRequest.toWeb(request).pipe(
      Effect.mapError(() => new HomepageUnavailable()),
    );
    const url = entry === undefined ? new URL(web.url) : new URL(entry, web.url);
    const response = yield* Effect.tryPromise({
      try: () => assets.fetch(new Request(url, web)),
      catch: () => new HomepageUnavailable(),
    });
    return HttpServerResponse.fromWeb(response);
  }).pipe(
    Effect.catchTag("HomepageUnavailable", () =>
      Effect.succeed(
        HttpServerResponse.text("Unable to load this page.", {
          status: 503,
          headers: { "cache-control": "no-store" },
        }),
      ),
    ),
  );

/** Same fast split as the old site: cookie presence chooses the product, never access authority. */
export const homepage = <E, R>(
  cookiePrefix: string,
  dashboard: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => homepageResponse(cookiePrefix, staticDocument("/index.html"), dashboard);
