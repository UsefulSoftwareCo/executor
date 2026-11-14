/**
 * How a background job's run ended. Most jobs handle their own failure, so their route answers
 * 204 and no caller retries; the run reports the failure here instead, and the trigger's
 * `job.dispatch` span records it (`infrastructure/background-jobs.ts`).
 */
import { Cause, Effect, Predicate, Schema } from "effect";

/**
 * The tags of the errors Cloud's jobs fail with. The route's and {@link handledJob}'s types require
 * every error a job can fail with to have one of them.
 */
const JobErrorTag = Schema.Literals([
  "BillingUnavailable",
  "DataStepUnavailable",
  "EmailDeliveryFailed",
  "GrantExpiryUnavailable",
  "GroupsUnavailable",
  "OrganizationRemovalUnavailable",
  "ProvisioningFailed",
  "R2Error",
  "SchemaError",
  "SiteAssetsUnavailable",
  "SqlError",
  "StorageError",
  "TimeoutError",
  "WelcomeEmailUnavailable",
  "WorkflowFailure",
]);

/** An error a job may fail with. */
export interface JobError {
  readonly _tag: typeof JobErrorTag.Type;
}

/**
 * Every failure a run can report: a listed error tag, or a fixed kind. Closed, so neither the
 * route's answer nor telemetry can carry any other value, such as an arbitrary defect's tag.
 */
export const JobFailure = Schema.Literals([
  ...JobErrorTag.literals,
  // A defect without a listed tag.
  "Defect",
  // The run, or its dispatch, was interrupted before it finished.
  "Interrupted",
  // A failure without a listed tag.
  "UnrecognizedFailure",
  // The dispatch got no outcome from the route: the job did not run, or did not finish.
  "Unreported",
  // A data step item ended with an outcome its step retries (`@executor-js/app-management`).
  "DataStepItemFailed",
]);
export type JobFailure = typeof JobFailure.Type;

export const JobOutcome = Schema.Union([
  /** The run did all of its work. */
  Schema.Struct({ outcome: Schema.Literal("completed") }),
  /**
   * `failed`: the run stopped, or every unit of its work failed. `partial`: some units failed and
   * the others finished. `failure` names the first failure.
   */
  Schema.Struct({ outcome: Schema.Literals(["partial", "failed"]), failure: JobFailure }),
]);
export type JobOutcome = typeof JobOutcome.Type;

const isJobErrorTag = Schema.is(JobErrorTag);

/**
 * The listed tag of `error` (see `@executor-js/telemetry/recorded-failure`), or `fallback`: never
 * a message, a field or an unlisted tag.
 */
const failureOf = (error: unknown, fallback: "UnrecognizedFailure" | "Defect"): JobFailure =>
  Predicate.hasProperty(error, "_tag") && isJobErrorTag(error._tag) ? error._tag : fallback;

export const jobCompleted: JobOutcome = { outcome: "completed" };

/** The run stopped on `error`, which its job handled. */
export const jobFailed = (error: JobError): JobOutcome => ({
  outcome: "failed",
  failure: failureOf(error, "UnrecognizedFailure"),
});

/** The run stopped on `cause`: a failure, a defect, or only an interruption. */
export const jobFailedWith = (cause: Cause.Cause<unknown>): JobOutcome => {
  const reason = cause.reasons.find((reason) => !Cause.isInterruptReason(reason));
  return {
    outcome: "failed",
    failure:
      reason === undefined
        ? "Interrupted"
        : Cause.isFailReason(reason)
          ? failureOf(reason.error, "UnrecognizedFailure")
          : failureOf(reason.defect, "Defect"),
  };
};

/** A run over `attempted` units of work, of which `failed` failed, the first with `failure`. */
export const jobUnitCounts = (
  attempted: number,
  failed: number,
  failure: JobFailure,
): JobOutcome =>
  failed === 0 ? jobCompleted : { outcome: failed < attempted ? "partial" : "failed", failure };

/** A run over `attempted` units of work, of which those in `failures` failed. */
export const jobUnits = (attempted: number, failures: ReadonlyArray<JobError>): JobOutcome => {
  const [first] = failures;
  return first === undefined
    ? jobCompleted
    : jobUnitCounts(attempted, failures.length, failureOf(first, "UnrecognizedFailure"));
};

/**
 * A job that handles its own failure: `handled` logs it and the route still answers 204, so no
 * caller retries. The run reports the failure as its outcome.
 */
export const handledJob =
  (handled: Effect.Effect<void>) =>
  <E extends JobError, R>(
    job: Effect.Effect<JobOutcome, E, R>,
  ): Effect.Effect<JobOutcome, never, R> =>
    job.pipe(Effect.catch((error) => handled.pipe(Effect.as(jobFailed(error)))));
