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

export const desktopEvidenceBase = Config.String("EXECUTOR_E2E_DESKTOP_SCREENSHOTS").pipe(
  Config.withDefault(".local/desktop-recovery"),
);

export const closeDurationsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(yield* desktopEvidenceBase, "close-durations.jsonl");
});
