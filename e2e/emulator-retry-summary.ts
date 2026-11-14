/**
 * Adds a job's count of hosted emulator calls that needed a retry to its summary, zero included:
 * `node e2e/emulator-retry-summary.ts <job status> <directory>...`. A job that passed only after
 * retrying says so. The records come from `emulatorRequest` (`e2e/emulator-retries.ts`).
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option } from "effect";
import { countEmulatorRetries, emulatorRetryLine } from "./emulator-retries.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [status, ...directories] = process.argv.slice(2);
    if (status === undefined || directories.length === 0)
      return yield* Effect.die(
        "Usage: node e2e/emulator-retry-summary.ts <job status> <directory>...",
      );
    // A summary never turns a job red: a record it cannot read is reported, not failed on.
    const counted = yield* countEmulatorRetries(directories).pipe(Effect.option);
    if (Option.isNone(counted)) {
      yield* Console.log("The hosted emulator calls that needed a retry could not be counted.");
      return;
    }
    const counts = counted.value;
    const passedWithRetries =
      status === "success" && counts.calls > 0
        ? ` This job passed with ${counts.calls} hosted emulator ${counts.calls === 1 ? "call" : "calls"} that needed a retry.`
        : "";
    const report = `## Hosted emulators\n\n${emulatorRetryLine(counts)}${passedWithRetries}\n`;
    yield* Console.log(report);
    // Where people look: an annotation on the run, not only a line in the summary.
    if (passedWithRetries !== "")
      yield* Console.log(`::warning title=Hosted emulators::${passedWithRetries.trim()}`);
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    if (Option.isSome(summary)) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
