import { Effect, FileSystem, Path, Schema } from "effect";

export const emulatorRetryDirectory = "report/emulator-retries";

export const EmulatorRetry = Schema.Struct({
  scenario: Schema.optional(Schema.String),
  operation: Schema.String,
  emulator: Schema.optional(Schema.String),
  failures: Schema.Array(Schema.String),
  outcome: Schema.Literals(["answered", "found applied", "failed"]),
  attempts: Schema.Number,
  elapsedMs: Schema.Number,
});
export type EmulatorRetry = typeof EmulatorRetry.Type;

export interface EmulatorRetryCounts {
  readonly calls: number;
  readonly failed: number;
  readonly scenarios: number;
  readonly setup: number;
  readonly worst: EmulatorRetry | undefined;
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(EmulatorRetry));

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
