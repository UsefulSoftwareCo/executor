/**
 * Adds a job's count of stage requests lost before any response to its summary, zero included:
 * `node e2e/lost-request-summary.ts <job status> <directory>...`. A job that passed only because a
 * lost request was sent again says so. The records come from `support/lost-connections.ts`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option } from "effect";
import { lostRequestLines, readLostRequests } from "./lost-requests.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [status, ...directories] = process.argv.slice(2);
    if (status === undefined || directories.length === 0)
      return yield* Effect.die(
        "Usage: node e2e/lost-request-summary.ts <job status> <directory>...",
      );
    // A summary never turns a job red: a record it cannot read is reported, not failed on.
    const read = yield* readLostRequests(directories).pipe(Effect.option);
    if (Option.isNone(read)) {
      yield* Console.log("The stage requests lost before any response could not be counted.");
      return;
    }
    const records = read.value;
    const answered = records.filter((record) => record.outcome === "sent again: answered").length;
    const passedWithResends =
      status === "success" && answered > 0
        ? ` This job passed with ${answered} stage ${answered === 1 ? "request" : "requests"} sent again after a lost reused connection.`
        : "";
    const report = `## Lost stage requests\n\n${lostRequestLines(records)}${passedWithResends}\n`;
    yield* Console.log(report);
    if (records.length > 0)
      yield* Console.log(
        `::warning title=Lost stage requests::${records.length} stage ${records.length === 1 ? "request was" : "requests were"} lost before any response; ${answered} answered when sent again.`,
      );
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    if (Option.isSome(summary)) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
