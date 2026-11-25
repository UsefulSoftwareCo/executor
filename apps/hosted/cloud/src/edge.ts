import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { edgeForwardsFor, forwardsToV2 } from "./contracts/edge-paths.ts";
import { postHogBindings } from "./infrastructure/posthog.ts";
import { sentryBindings } from "./infrastructure/sentry.ts";
import { siteTelemetryBinding } from "./infrastructure/site-telemetry.ts";
import { Marketing } from "./infrastructure/marketing-worker.ts";
import { Edge } from "./infrastructure/edge-worker.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";
import { platformObservability } from "./infrastructure/telemetry.ts";

const SiteTelemetry = Schema.fromJsonString(
  Schema.Struct({
    analyticsProxy: Schema.NullOr(Schema.String),
    errorTunnel: Schema.NullOr(Schema.String),
  }),
);

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
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
      env: siteTelemetryBinding(
        (yield* postHogBindings).analyticsProxy,
        (yield* sentryBindings).errorTunnel,
      ),
      ...(yield* platformObservability),
    };
  }),
  Effect.gen(function* () {
    yield* Cloudflare.Workers.bindWorker(Marketing);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const environment = yield* Cloudflare.WorkerEnvironment;
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
