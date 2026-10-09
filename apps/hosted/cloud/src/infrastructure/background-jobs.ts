/**
 * Placement applies only to fetch handlers, so Cron Triggers run wherever Cloudflare starts them,
 * often far from the database. A trigger therefore only asks the API Worker's own fetch handler,
 * through a service binding to itself, to run its job. The placed handler does the database work,
 * and any Durable Object or Workflow the job first contacts is created beside it.
 */
import { recordRoute, traceHeaders } from "@executor-js/telemetry";
import { Random, RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Fetcher } from "@cloudflare/workers-types";
import { Effect, Exit, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { timingSafeEqual } from "node:crypto";
import { previewLifetime } from "./test-stage-expiry.ts";

/** Every job a Cron Trigger starts. */
export const BackgroundJob = Schema.Literals([
  "organization-removal",
  "provisioning",
  "data-steps",
  "repository-recovery",
  "schedule-wake",
  "site-assets",
  "app-domain-heartbeat",
  "welcome-emails",
  "workflow-reconcile",
  "billing-reconcile",
  "agent-grant-expiry",
]);
export type BackgroundJob = typeof BackgroundJob.Type;

export class BackgroundJobFailed extends Schema.TaggedError<BackgroundJobFailed>()(
  "BackgroundJobFailed",
  { job: BackgroundJob },
) {}

/** The API Worker's service binding to itself, declared in its `env`. */
export const selfBinding = "ApiSelf";

const NativeFetcher = Schema.declare(
  (value): value is Pick<Fetcher, "fetch"> =>
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function",
);

/** Resolve the binding and the dispatch key during Worker initialization. */
export const cloudBackgroundJobs = Effect.gen(function* () {
  const environment = yield* Cloudflare.WorkerEnvironment;
  // Only the API Worker reads it: the route below is also reachable from the public origin.
  const secret = yield* (yield* Random("BackgroundJobSecret")).text;
  const lifetime = yield* previewLifetime;
  const authorization = Effect.map(secret, (value) => `Bearer ${Redacted.value(value)}`);

  const request = (job: BackgroundJob) =>
    Effect.gen(function* () {
      const self = yield* Schema.decodeUnknownEffect(NativeFetcher)(environment[selfBinding]);
      const headers = { ...(yield* traceHeaders), authorization: yield* authorization };
      const response = yield* Effect.tryPromise(async () => {
        const response = await self.fetch(`https://api.internal/api/internal/jobs/${job}`, {
          method: "POST",
          headers,
        });
        await response.body?.cancel();
        return response;
      });
      yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
      if (response.status !== 204) return yield* new BackgroundJobFailed({ job });
    }).pipe(
      Effect.mapError(() => new BackgroundJobFailed({ job })),
      Effect.withSpan("job.dispatch", { attributes: { "executor.job": job } }),
      Effect.provide(RuntimeContext.phantom),
      lifetime.background,
    );
  const dispatch = (job: BackgroundJob) =>
    request(job).pipe(
      Effect.catchCause(() => Effect.logError("Background job dispatch failed", { job })),
    );

  return {
    /** Start a job from a Cron Trigger; the trigger's invocation waits for the job to finish. */
    schedule: (cron: string, ...jobs: ReadonlyArray<BackgroundJob>) =>
      Cloudflare.Workers.cron(cron, () =>
        Effect.forEach(jobs, dispatch, { concurrency: "unbounded", discard: true }),
      ),
    /**
     * Run a job in the placed handler from code that is not placed, such as a workflow step or a
     * Durable Object, and wait for it. Fails unless the job finished.
     */
    request,
    /** The placed route that runs one job and answers when it has finished: 204, or 500 if it failed. */
    route: <E, R>(run: (job: BackgroundJob) => Effect.Effect<void, E, R>) =>
      HttpRouter.add(
        "POST",
        "/api/internal/jobs/:job",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const expected = Buffer.from(yield* authorization);
          const supplied = Buffer.from(request.headers.authorization ?? "");
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
            return HttpServerResponse.empty({ status: 404 });
          const { job } = yield* HttpRouter.schemaPathParams(Schema.Struct({ job: BackgroundJob }));
          // Job names are Executor's own, so the path keeps the job the route ran.
          yield* recordRoute(`/api/internal/jobs/${job}`);
          const ran = yield* run(job).pipe(lifetime.background, Effect.exit);
          return HttpServerResponse.empty({ status: Exit.isSuccess(ran) ? 204 : 500 });
        }).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          ),
        ),
      ),
  };
});
