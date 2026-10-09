/**
 * A test stage's edge: it plays v1's edge on `executor.sh` for `edge.<slug>.<test domain>`. It
 * forwards exactly the requests v1 forwards to the marketing Worker through a service binding, keeping
 * the original URL, and answers every other path as v1 would own it. It forwards; it never
 * redirects, because clients check that issuer metadata comes from the issuer's own origin.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { edgeForwardsFor, forwardsToV2 } from "./contracts/edge-paths.ts";
import { postHogBindings } from "./infrastructure/posthog.ts";
import { sentryBindings } from "./infrastructure/sentry.ts";
import { siteTelemetryBinding } from "./infrastructure/site-telemetry.ts";
import { Marketing } from "./infrastructure/marketing-worker.ts";
import { Edge } from "./infrastructure/edge-worker.ts";
import { testStageEdgeRoutes } from "./infrastructure/role-hosts.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";

/** The stage's telemetry paths (`site-telemetry.ts`), which v1 lists for production. */
const SiteTelemetry = Schema.fromJsonString(
  Schema.Struct({
    analyticsProxy: Schema.NullOr(Schema.String),
    errorTunnel: Schema.NullOr(Schema.String),
  }),
);

/** The service binding's runtime shape: a plain fetch, as v1's binding to v2 uses. */
interface ServiceBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

export default Edge.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      workersDev: false,
      build: workerBuild("edge"),
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: siteTelemetryBinding(
        (yield* postHogBindings).analyticsProxy,
        (yield* sentryBindings).errorTunnel,
      ),
      ...(yield* testStageEdgeRoutes),
    };
  }),
  Effect.gen(function* () {
    // Use the same unplaced public-site entry as production's v1 edge.
    yield* Cloudflare.Workers.bindWorker(Marketing);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const environment = yield* Cloudflare.WorkerEnvironment;
        // SAFETY: the Worker's `env` prop above binds EXECUTOR_SITE_TELEMETRY; it is decoded here.
        const telemetry = yield* Schema.decodeUnknownEffect(SiteTelemetry)(
          (environment as unknown as Record<string, unknown>).EXECUTOR_SITE_TELEMETRY,
        ).pipe(Effect.orDie);
        const forwards = edgeForwardsFor({
          analyticsProxy: Option.fromNullishOr(telemetry.analyticsProxy),
          errorTunnel: Option.fromNullishOr(telemetry.errorTunnel),
        });
        if (!forwardsToV2(forwards, new URL(request.originalUrl)))
          return HttpServerResponse.text("Executor v1 serves this path.", {
            status: 404,
            headers: { "cache-control": "no-store" },
          });
        // SAFETY: `bindWorker(Marketing)` above registers this service binding.
        const binding = (environment as unknown as Record<string, ServiceBinding | undefined>)[
          Marketing.LogicalId
        ];
        if (binding === undefined)
          return yield* Effect.die(new Error("The edge has no binding to the marketing Worker"));
        const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
        const response = yield* Effect.promise(() => binding.fetch(web));
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }),
);
