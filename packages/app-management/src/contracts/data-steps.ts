import type { Effect } from "effect";
import { Schema } from "effect";

export const DataStepMode = Schema.Literals(["report", "apply"]);
export type DataStepMode = typeof DataStepMode.Type;

export interface DataStepItemProgress {
  readonly previous: string | undefined;
  readonly record: (outcome: string) => Effect.Effect<void, DataStepProgressUnrecorded>;
  readonly count: (outcomes: ReadonlyArray<string>) => Effect.Effect<number, DataStepUnavailable>;
}

export interface DataStepItem<R> {
  readonly id: string;
  readonly owner: string;
  readonly run: (
    mode: DataStepMode,
    progress: DataStepItemProgress,
  ) => Effect.Effect<string, never, R>;
}

export interface DataStep<R> {
  readonly name: string;
  readonly items: Effect.Effect<ReadonlyArray<DataStepItem<R>>, unknown, R>;
  readonly retry: ReadonlyArray<string>;
  readonly expected?: ReadonlyArray<string>;
  readonly reportsAfterApply?: boolean;
  readonly applyRun?: string;
  readonly exhausted?: {
    readonly passes: number;
    readonly outcomes: Readonly<Record<string, string>>;
  };
  readonly more?: Effect.Effect<boolean, never, R>;
}

export const dataStepPaused = "data-step:paused";

export type DataStepJournal = "private_hosted" | "private_local";

export const DataStepSummary = Schema.Struct({
  step: Schema.String,
  mode: DataStepMode,
  run: Schema.String,
  pass: Schema.Int,
  status: Schema.Literals(["complete", "retrying"]),
  retryAt: Schema.optionalKey(Schema.String),
  outcomes: Schema.Record(Schema.String, Schema.Int),
  owners: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Int)),
});
export type DataStepSummary = typeof DataStepSummary.Type;

export interface DataStepRun {
  readonly status: "complete" | "pending";
  readonly attempted: number;
  readonly failed: number;
}

export const dataStepLogPrefix = "Data step pass finished: ";

export class DataStepProgressUnrecorded extends Schema.TaggedError<DataStepProgressUnrecorded>()(
  "DataStepProgressUnrecorded",
  {},
) {}

export class DataStepUnavailable extends Schema.TaggedError<DataStepUnavailable>()(
  "DataStepUnavailable",
  { step: Schema.String },
) {}
