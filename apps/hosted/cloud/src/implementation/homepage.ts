import { WorkerEnvironment } from "alchemy/Cloudflare";
import { Effect, Predicate, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { experimentHomepage, type HeroFlagEvaluator } from "./hero-experiment.ts";
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
export const homepage = (cookiePrefix: string, evaluate: HeroFlagEvaluator) =>
  homepageResponse(
    cookiePrefix,
    experimentHomepage(staticDocument, evaluate),
    // The generated `_headers` file denies framing for every dashboard path, but
    // `runWorkerFirst` lists "/", and Cloudflare does not apply `_headers` to a
    // response the Worker produces. This is the one dashboard document the asset
    // server never serves, so it carries the same denial here.
    staticDocument("/dashboard.html").pipe(
      Effect.map((response) =>
        response.pipe(
          HttpServerResponse.setHeader("content-security-policy", "frame-ancestors 'none'"),
          HttpServerResponse.setHeader("x-frame-options", "DENY"),
        ),
      ),
    ),
  );
