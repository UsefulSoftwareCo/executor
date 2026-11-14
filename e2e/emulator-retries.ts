/**
 * Harness calls to a hosted emulator that needed more than one attempt (`emulatorRequest` in
 * `support/emulators.ts`). Each one is saved as a file in the run's `report/emulator-retries/`,
 * passed scenarios included, so a job's summary can count them: a service that starts failing
 * shows here before it fails a run.
 *
 * A record holds what a failure text holds: the operation (method and path, no query), the
 * emulator's label with its capability elided, and each attempt's status, ray or how far the call
 * got. Never a URL, a header or a body.
 */
import { Effect, FileSystem, Path, Schema } from "effect";

/** Where a run keeps its records, under the run's evidence directory. */
export const emulatorRetryDirectory = "report/emulator-retries";

export const EmulatorRetry = Schema.Struct({
  /** The scenario that made the call; absent for a call the run made while setting up. */
  scenario: Schema.optional(Schema.String),
  operation: Schema.String,
  emulator: Schema.optional(Schema.String),
  /** Each failed attempt, in order, as its failure text describes it. */
  failures: Schema.Array(Schema.String),
  /** How the call ended: answered on a later attempt, found applied by reading back, or failed. */
  outcome: Schema.Literals(["answered", "found applied", "failed"]),
  attempts: Schema.Number,
  elapsedMs: Schema.Number,
});
export type EmulatorRetry = typeof EmulatorRetry.Type;

export interface EmulatorRetryCounts {
  readonly calls: number;
  readonly failed: number;
  /** Distinct scenarios with a retried call. */
  readonly scenarios: number;
  /** Retried calls the run made while setting up, outside any scenario. */
  readonly setup: number;
  /** The call that took the most attempts, then the longest. */
  readonly worst: EmulatorRetry | undefined;
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(EmulatorRetry));

/** Count every record under the directories, at any depth. A record that does not decode fails. */
export const countEmulatorRetries = (directories: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: Array<string> = [];
    for (const directory of directories)
      if (yield* fs.exists(directory))
        for (const file of yield* fs.readDirectory(directory, { recursive: true }))
          if (
            path.basename(path.dirname(file)) === path.basename(emulatorRetryDirectory) &&
            file.endsWith(".json")
          )
            files.push(path.join(directory, file));
    const records = yield* Effect.forEach(files, (file) =>
      fs.readFileString(file).pipe(Effect.flatMap(decode)),
    );
    const worst = records.reduce<EmulatorRetry | undefined>(
      (current, record) =>
        current === undefined ||
        record.attempts > current.attempts ||
        (record.attempts === current.attempts && record.elapsedMs > current.elapsedMs)
          ? record
          : current,
      undefined,
    );
    return {
      calls: records.length,
      failed: records.filter((record) => record.outcome === "failed").length,
      scenarios: new Set(records.flatMap((record) => record.scenario ?? [])).size,
      setup: records.filter((record) => record.scenario === undefined).length,
      worst,
    } satisfies EmulatorRetryCounts;
  });

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)} s`;

/** One line for a job or coverage summary, zero included, so a rise shows without reading logs. */
export const emulatorRetryLine = (counts: EmulatorRetryCounts) => {
  if (counts.calls === 0) return "Hosted emulator calls that needed a retry: 0.";
  const worst = counts.worst!;
  return [
    `Hosted emulator calls that needed a retry: ${counts.calls}`,
    ` (${counts.scenarios} ${counts.scenarios === 1 ? "scenario" : "scenarios"}`,
    counts.setup === 0 ? "" : `, ${counts.setup} while setting up`,
    `); ${counts.failed} still failed after retrying.`,
    ` Worst: ${worst.operation}${worst.emulator === undefined ? "" : ` on ${worst.emulator}`},`,
    ` ${worst.attempts} attempts over ${seconds(worst.elapsedMs)} (${worst.outcome};`,
    ` ${worst.failures.join("; ")}).`,
  ].join("");
};
