import { recordRoute, traceHeaders } from "@executor-js/telemetry";
import { Random, RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Fetcher } from "@cloudflare/workers-types";
import { Cause, Effect, Exit, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { timingSafeEqual } from "node:crypto";
import { JobOutcome, jobFailedWith, type JobError } from "../contracts/job-outcome.ts";
import { previewActivity } from "./preview-activity.ts";
import { previewLifetime } from "./test-stage-expiry.ts";

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
  "tool-call-log",
]);
export type BackgroundJob = typeof BackgroundJob.Type;

export class BackgroundJobFailed extends Schema.TaggedError<BackgroundJobFailed>()(
  "BackgroundJobFailed",
  { job: BackgroundJob },
) {}

export const selfBinding = "ApiSelf";

const outcomeHeader = "executor-job-outcome";
const failureHeader = "executor-job-failure";

const outcomeHeaders = (outcome: JobOutcome): Record<string, string> =>
  outcome.outcome === "completed"
    ? { [outcomeHeader]: outcome.outcome }
    : { [outcomeHeader]: outcome.outcome, [failureHeader]: outcome.failure };

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

const unreported: JobOutcome = { outcome: "failed", failure: "Unreported" };

const outcomeAttributes = (outcome: JobOutcome): Record<string, string> =>
  outcome.outcome === "completed"
    ? { "executor.outcome": outcome.outcome }
    : { "executor.outcome": outcome.outcome, "executor.job.failure": outcome.failure };

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

export const cloudBackgroundJobs = Effect.gen(function* () {
  const environment = yield* Cloudflare.WorkerEnvironment;
  const secret = yield* (yield* Random("BackgroundJobSecret")).text;
  const lifetime = yield* previewLifetime;
  const activity = yield* previewActivity;
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
    schedule: (cron: string, ...jobs: ReadonlyArray<BackgroundJob>) =>
      Cloudflare.Workers.cron(cron, () =>
        Effect.forEach(jobs, dispatch, { concurrency: "unbounded", discard: true }),
      ),
    request,
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
          yield* recordRoute(`/api/internal/jobs/${job}`);
          if (
            (yield* lifetime.isBackgroundStopped) ||
            (job !== "site-assets" && (yield* activity.isIdle))
          )
            return HttpServerResponse.empty({ status: 204 });
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
