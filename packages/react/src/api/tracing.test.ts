import { describe, expect, it } from "@effect/vitest";
import { FetchHttpClient } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { makeBrowserTracingLayer } from "./tracing";

/** `Fetch` is a Context.Reference defaulting to `globalThis.fetch`, so a stub
 *  layer overrides it without discharging any requirement. */
const stubFetch = (onRequest: (request: Request) => void): Layer.Layer<never> =>
  Layer.succeed(FetchHttpClient.Fetch)(((input: RequestInfo | URL, init?: RequestInit) => {
    onRequest(input instanceof Request ? input : new Request(String(input), init));
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof globalThis.fetch);

// The browser client exports its spans itself — no cloud span processor runs
// in the page — so the scrub is asserted on the serialized OTLP payload the
// exporter posts to /v1/traces.
describe("browser tracing layer", () => {
  it.effect("the exported payload carries no query values, userinfo, or fragments", () => {
    const SECRET = "synthetic-browser-canary";
    const seen: Array<Request> = [];
    return Effect.gen(function* () {
      yield* Effect.void.pipe(
        Effect.withSpan("canary.request", {
          attributes: {
            "url.full": `https://svc:${SECRET}-userinfo@api.test/graphql?owner=${SECRET}-query#access_token=${SECRET}-fragment`,
            "url.query": `owner=${SECRET}-query`,
          },
        }),
      );
      yield* Effect.fail(
        `Transport: fetch failed (GET https://u:${SECRET}-err@api.test/graphql?key=${SECRET}-errq)`,
      ).pipe(Effect.withSpan("canary.failure"), Effect.exit);
    }).pipe(
      Effect.provide(
        makeBrowserTracingLayer("http://page.test/v1/traces").pipe(
          Layer.provide(stubFetch((request) => seen.push(request))),
        ),
      ),
      Effect.scoped,
      Effect.andThen(
        Effect.promise(async () => {
          const body = await seen[0]?.text();
          expect(body).toBeDefined();
          // Non-vacuous: both spans made it onto the wire with host and path.
          expect(body).toContain("canary.request");
          expect(body).toContain("canary.failure");
          expect(body).toContain("/graphql");
          expect(body).not.toContain(SECRET);
          // No exported url.full keeps a query string.
          expect(body).not.toContain("graphql?");
        }),
      ),
    );
  });
});
