/**
 * Data steps: recorded, one-time data migrations that need the running host's services rather
 * than a database connection alone, such as editing app source in Git. Schema migrations create
 * their journal; hosts run pending steps after their schema is current. Local and self-host run
 * them at startup, before serving. Cloud runs them inside the new Worker after it deploys.
 */
import type { Effect } from "effect";
import { Schema } from "effect";

/**
 * `report` handles every item without writing and records each outcome, so an operator can review
 * what `apply` would do. `apply` writes, and completes the step once a pass has nothing to retry.
 */
export const DataStepMode = Schema.Literals(["report", "apply"]);
export type DataStepMode = typeof DataStepMode.Type;

/** One unit of a step's work. Reports identify it by its ID and owner ID only. */
export interface DataStepItem<R> {
  readonly id: string;
  readonly owner: string;
  /** Handle this item and name the outcome. Failures are outcomes; report mode never writes. */
  readonly run: (mode: DataStepMode) => Effect.Effect<string, never, R>;
}

export interface DataStep<R> {
  /** Stable journal key. Append new steps; never rename or change a step that has applied. */
  readonly name: string;
  /** Every item the step covers. Passes walk them in ID order. */
  readonly items: Effect.Effect<ReadonlyArray<DataStepItem<R>>, unknown, R>;
  /** Outcomes that a later pass revisits. The step is complete once a pass ends without them. */
  readonly retry: ReadonlyArray<string>;
  /**
   * Retry outcomes that are not failures, such as a concurrent edit the next pass retries. Their
   * items are revisited like any retry outcome but do not count as failed items.
   */
  readonly expected?: ReadonlyArray<string>;
  /**
   * Whether a report still walks the items after the step has applied, as an independent check
   * of its result under a new report label. Otherwise an applied step has nothing to report.
   */
  readonly reportsAfterApply?: boolean;
}

/** Which product's journal tables a host uses; each is created by that product's migrations. */
export type DataStepJournal = "private_hosted" | "private_local";

/** Per-outcome counts for the whole run and for each owner. IDs and counts only. */
export const DataStepSummary = Schema.Struct({
  step: Schema.String,
  mode: DataStepMode,
  run: Schema.String,
  pass: Schema.Int,
  /** `retrying`: some items ended with a retry outcome; a later run starts another pass. */
  status: Schema.Literals(["complete", "retrying"]),
  /**
   * When `retrying`, the earliest time a background run starts that pass, as an ISO timestamp.
   * Startup runs retry at the next start regardless.
   */
  retryAt: Schema.optionalKey(Schema.String),
  outcomes: Schema.Record(Schema.String, Schema.Int),
  owners: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Int)),
});
export type DataStepSummary = typeof DataStepSummary.Type;

/**
 * What one run of the pending steps did. `pending` when a step still has work: the deadline passed,
 * another process holds its lease, or its last pass left items to retry. `attempted` counts the
 * items the run handled and recorded, and `failed` those of them that ended with one of their
 * step's retry outcomes that is not `expected`, such as `failed` (but not a retried `conflict`). A run that only waited for a lease or a
 * backoff, or ran out of time, has no failed items.
 */
export interface DataStepRun {
  readonly status: "complete" | "pending";
  readonly attempted: number;
  readonly failed: number;
}

/** The prefix of the single log line each finished pass writes, followed by its JSON summary. */
export const dataStepLogPrefix = "Data step pass finished: ";

/** The journal or a step's item list could not be read. Startup stops; Cloud retries next tick. */
export class DataStepUnavailable extends Schema.TaggedError<DataStepUnavailable>()(
  "DataStepUnavailable",
  { step: Schema.String },
) {}
