/** Serve the public site at the incoming edge, without initializing the application. */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { requestTiming } from "@executor-js/telemetry/http";
import { siteFiles, sitePages, matchesSitePattern } from "./contracts/site-paths.ts";
import { staticDocument } from "./implementation/homepage.ts";
import { Api } from "./infrastructure/api-worker.ts";
import { Marketing } from "./infrastructure/marketing-worker.ts";
import { cloudSite } from "./infrastructure/site.ts";
import { productionStage, stageName } from "./infrastructure/stage.ts";
import { cloudObservability } from "./infrastructure/telemetry.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";

const Binding = Schema.declare(
  (value): value is { readonly fetch: (request: Request) => Promise<Response> } =>
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function",
);

export default Marketing.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    const site = yield* cloudSite;
    return {
      main: import.meta.url,
      ...(Option.getOrUndefined(yield* stageName) === productionStage
        ? { name: "executor-next-marketing-v2" }
        : {}),
      workersDev: false,
      build: workerBuild("marketing"),
      ...(yield* cloudObservability),
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      // Only explicitly public paths below can read this binding. Dashboard files stay private.
      assets: {
        directory: site.outdir,
        hash: site.hash.output,
        htmlHandling: "none",
        notFoundHandling: "none",
        runWorkerFirst: true,
      },
    };
  }),
  Effect.gen(function* () {
    yield* Cloudflare.Workers.bindWorker(Api);
    return {
      fetch: Effect.gen(function* () {
        const environment = yield* Cloudflare.WorkerEnvironment;
        const api = yield* Schema.decodeUnknownEffect(Binding)(environment[Api.LogicalId]).pipe(
          Effect.orDie,
        );
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.originalUrl).pathname;
        const read = request.method === "GET" || request.method === "HEAD";
        if (read && path === "/") return yield* staticDocument("/index.html").pipe(requestTiming);
        if (
          read &&
          [...sitePages, ...siteFiles].some((pattern) => matchesSitePattern(pattern, path))
        ) {
          const response = yield* staticDocument().pipe(requestTiming);
          if (response.status !== 404) return response;
        }
        // Auth, Git, telemetry, skills and retained assets keep their application-owned handlers.
        const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
        return HttpServerResponse.fromWeb(yield* Effect.promise(() => api.fetch(web)));
      }),
    };
  }),
);
