import { Cause, Effect, Predicate, Schema } from "effect";

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

export interface JobError {
  readonly _tag: typeof JobErrorTag.Type;
}

export const JobFailure = Schema.Literals([
  ...JobErrorTag.literals,
  "Defect",
  "Interrupted",
  "UnrecognizedFailure",
  "Unreported",
  "DataStepItemFailed",
]);
export type JobFailure = typeof JobFailure.Type;

export const JobOutcome = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("completed") }),
  Schema.Struct({ outcome: Schema.Literals(["partial", "failed"]), failure: JobFailure }),
]);
export type JobOutcome = typeof JobOutcome.Type;

const isJobErrorTag = Schema.is(JobErrorTag);

const failureOf = (error: unknown, fallback: "UnrecognizedFailure" | "Defect"): JobFailure =>
  Predicate.hasProperty(error, "_tag") && isJobErrorTag(error._tag) ? error._tag : fallback;

export const jobCompleted: JobOutcome = { outcome: "completed" };

export const jobFailed = (error: JobError): JobOutcome => ({
  outcome: "failed",
  failure: failureOf(error, "UnrecognizedFailure"),
});

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

export const jobUnitCounts = (
  attempted: number,
  failed: number,
  failure: JobFailure,
): JobOutcome =>
  failed === 0 ? jobCompleted : { outcome: failed < attempted ? "partial" : "failed", failure };

export const jobUnits = (attempted: number, failures: ReadonlyArray<JobError>): JobOutcome => {
  const [first] = failures;
  return first === undefined
    ? jobCompleted
    : jobUnitCounts(attempted, failures.length, failureOf(first, "UnrecognizedFailure"));
};

export const handledJob =
  (handled: Effect.Effect<void>) =>
  <E extends JobError, R>(
    job: Effect.Effect<JobOutcome, E, R>,
  ): Effect.Effect<JobOutcome, never, R> =>
    job.pipe(Effect.catch((error) => handled.pipe(Effect.as(jobFailed(error)))));
