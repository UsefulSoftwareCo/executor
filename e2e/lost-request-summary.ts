/**
 * Adds a job's count of stage requests lost in transport to its summary, zero included:
 * `node e2e/lost-request-summary.ts <job status> <directory>...`. The records come from
 * `support/lost-connections.ts`; nothing is sent again, so each is a request that failed. When the
 * records cannot be read the summary says so in words a reader cannot take for a zero.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option } from "effect";
import { lostRequestLines, lostRequestsUncounted, readLostRequests } from "./lost-requests.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [status, ...directories] = process.argv.slice(2);
    if (status === undefined || directories.length === 0)
      return yield* Effect.die(
        "Usage: node e2e/lost-request-summary.ts <job status> <directory>...",
      );
    // A summary never turns a job red: a record it cannot read is reported, not failed on.
    const read = yield* readLostRequests(directories).pipe(Effect.option);
    const report = `## Lost stage requests\n\n${Option.isNone(read) ? lostRequestsUncounted : lostRequestLines(read.value)}\n`;
    yield* Console.log(report);
    if (Option.isNone(read))
      yield* Console.log(
        `::warning title=Lost stage requests not counted::${lostRequestsUncounted}`,
      );
    else if (read.value.length > 0)
      yield* Console.log(
        `::warning title=Lost stage requests::${read.value.length} stage ${read.value.length === 1 ? "request was" : "requests were"} lost in transport.`,
      );
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    if (Option.isSome(summary)) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
