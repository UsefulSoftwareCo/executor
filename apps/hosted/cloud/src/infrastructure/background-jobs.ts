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
import { Cause, Effect, Exit, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { timingSafeEqual } from "node:crypto";
import { JobOutcome, jobFailedWith, type JobError } from "../contracts/job-outcome.ts";
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
  "personal-data-reporting",
]);
export type BackgroundJob = typeof BackgroundJob.Type;

export class BackgroundJobFailed extends Schema.TaggedError<BackgroundJobFailed>()(
  "BackgroundJobFailed",
  { job: BackgroundJob },
) {}

/** The API Worker's service binding to itself, declared in its `env`. */
export const selfBinding = "ApiSelf";

/** The job route's answer reports how the run ended; only {@link cloudBackgroundJobs} reads it. */
const outcomeHeader = "executor-job-outcome";
const failureHeader = "executor-job-failure";

const outcomeHeaders = (outcome: JobOutcome): Record<string, string> =>
  outcome.outcome === "completed"
    ? { [outcomeHeader]: outcome.outcome }
    : { [outcomeHeader]: outcome.outcome, [failureHeader]: outcome.failure };

/**
 * The route's report, if it sent one. A report this version cannot read, such as a failure kind a
 * newer route added, still counts: as a failed run with an unrecognized failure.
 */
const reportedOutcome = (headers: {
  readonly get: (name: string) => string | null;
}): Option.Option<JobOutcome> => {
  const outcome = headers.get(outcomeHeader);
  if (outcome === null) return Option.none();
  return Option.some(
    Option.getOrElse(
      Schema.decodeUnknownOption(JobOutcome)({
        outcome,
        failure: headers.get(failureHeader) ?? undefined,
      }),
      (): JobOutcome => ({ outcome: "failed", failure: "UnrecognizedFailure" }),
    ),
  );
};

/** A request that failed without the route's report: the job did not run, or did not finish. */
const unreported: JobOutcome = { outcome: "failed", failure: "Unreported" };

/** `executor.outcome` and, unless the run completed, `executor.job.failure`. */
const outcomeAttributes = (outcome: JobOutcome): Record<string, string> =>
  outcome.outcome === "completed"
    ? { "executor.outcome": outcome.outcome }
    : { "executor.outcome": outcome.outcome, "executor.job.failure": outcome.failure };

/**
 * A dispatch that ends without reading the route's report records why: its request failed
 * (`Unreported`), it hit a defect (`Defect`), or it was interrupted (`Interrupted`), such as when
 * its invocation is cancelled while the job runs. An outcome the span already records is kept.
 */
const recordUnreported = (cause: Cause.Cause<unknown>) =>
  Effect.currentSpan.pipe(
    Effect.flatMap((span) =>
      span.attributes.has("executor.outcome")
        ? Effect.void
        : Effect.annotateCurrentSpan(
            outcomeAttributes({
              outcome: "failed",
              failure: Cause.hasFails(cause)
                ? "Unreported"
                : Cause.hasDies(cause)
                  ? "Defect"
                  : "Interrupted",
            }),
          ),
    ),
    Effect.ignore,
  );

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
      // The route reports how the run ended, including a failure the job handled itself and
      // answered 204 for. `executor.outcome: failed` marks this span as failed without failing
      // the request, so a caller that retries until the job finishes retries exactly as before.
      const outcome = reportedOutcome(response.headers);
      yield* Effect.annotateCurrentSpan({
        "http.response.status_code": response.status,
        ...(Option.isSome(outcome)
          ? outcomeAttributes(outcome.value)
          : response.status === 204
            ? {}
            : outcomeAttributes(unreported)),
      });
      if (response.status !== 204) return yield* new BackgroundJobFailed({ job });
    }).pipe(
      Effect.mapError(() => new BackgroundJobFailed({ job })),
      // Inside the span, so it records before the span ends. The exit itself is unchanged.
      Effect.onExit((exit) => (Exit.isFailure(exit) ? recordUnreported(exit.cause) : Effect.void)),
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
    /**
     * The placed route that runs one job and answers when it has finished: 204, or 500 if it
     * failed. A job that handles its own failure answers 204; the answer reports its outcome.
     */
    route: <E extends JobError, R>(run: (job: BackgroundJob) => Effect.Effect<JobOutcome, E, R>) =>
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
          // A stopped preview runs no job.
          if (yield* lifetime.isBackgroundStopped) return HttpServerResponse.empty({ status: 204 });
          const ran = yield* Effect.exit(run(job));
          return HttpServerResponse.empty({
            status: Exit.isSuccess(ran) ? 204 : 500,
            headers: outcomeHeaders(Exit.isSuccess(ran) ? ran.value : jobFailedWith(ran.cause)),
          });
        }).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          ),
        ),
      ),
  };
});
