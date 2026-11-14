/**
 * Global setup for the desktop configs: start each run with no recorded closes, and once every
 * scenario has finished print each desktop close's duration and the slowest one in the job's
 * log, which every run keeps, a passing one included.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { CloseDuration, closeDurationsFile } from "./support/desktop-close-durations.ts";

const reset = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* closeDurationsFile, { force: true });
});

const report = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* closeDurationsFile;
  const text = (yield* fs.readFileString(file).pipe(Effect.option)).pipe(
    Option.getOrElse(() => ""),
  );
  const closes = text
    .split("\n")
    .flatMap((line) =>
      Option.toArray(Schema.decodeUnknownOption(Schema.fromJsonString(CloseDuration))(line)),
    );
  if (closes.length === 0) return yield* Console.log("Desktop closes: none recorded.");
  const exited = closes.filter((close) => close.outcome !== "did not exit");
  const slowest = exited.reduce<CloseDuration | undefined>(
    (slow, close) => (slow === undefined || close.seconds > slow.seconds ? close : slow),
    undefined,
  );
  const hung = closes.length - exited.length;
  yield* Console.log(
    [
      `Desktop closes (${process.platform}): ${closes.length}, bound ${closes[0]?.boundSeconds} s. ` +
        (slowest === undefined
          ? "None exited."
          : `Slowest that exited: ${slowest.seconds.toFixed(3)} s in ${slowest.scenario}.`) +
        ` Did not exit within the bound: ${hung}.`,
      ...closes.map(
        (close) =>
          `  desktop close ${close.seconds.toFixed(3)} s ${close.outcome}: ${close.scenario}`,
      ),
    ].join("\n"),
  );
});

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | NodeServices.NodeServices>,
) => {
  // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- Vitest's globalSetup and its teardown must return a Promise
  return Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
};

/** Vitest's global setup. Returns the teardown, which runs after every test file has finished. */
export default function setup() {
  return run(reset).then(() => () => run(report.pipe(Effect.ignore)));
}
