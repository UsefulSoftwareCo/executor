/**
 * How long each desktop close took in a run, one JSON line per close in `close-durations.jsonl`
 * beside the desktop evidence, so the margin under the close bound is measured. A failed job
 * uploads the file with the evidence; `e2e/desktop-close-durations.ts` prints it into every job's
 * log.
 */
import { Config, Effect, Path, Schema } from "effect";

export const CloseDuration = Schema.Struct({
  scenario: Schema.String,
  pid: Schema.optional(Schema.Number),
  seconds: Schema.Number,
  outcome: Schema.Literals(["exited", "already exited", "did not exit"]),
  boundSeconds: Schema.Number,
  at: Schema.String,
});
export type CloseDuration = typeof CloseDuration.Type;

/** EXECUTOR_E2E_DESKTOP_SCREENSHOTS, by default `.local/desktop-recovery`. */
export const desktopEvidenceBase = Config.String("EXECUTOR_E2E_DESKTOP_SCREENSHOTS").pipe(
  Config.withDefault(".local/desktop-recovery"),
);

export const closeDurationsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(yield* desktopEvidenceBase, "close-durations.jsonl");
});
