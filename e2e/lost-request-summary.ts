import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option } from "effect";
import {
  lostRequestLines,
  lostRequestsUncounted,
  readLostRequests,
  repeatTotals,
} from "./lost-requests.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [status, ...directories] = process.argv.slice(2);
    if (status === undefined || directories.length === 0)
      return yield* Effect.die(
        "Usage: node e2e/lost-request-summary.ts <job status> <directory>...",
      );
    const read = yield* readLostRequests(directories).pipe(Effect.option);
    const totals = Option.isNone(read) ? undefined : repeatTotals(read.value);
    const passedWithRepeats =
      status === "success" && totals !== undefined && totals.requests > 0
        ? ` This job passed only after sending ${totals.requests} stage ${totals.requests === 1 ? "request" : "requests"} again (${totals.repeats} ${totals.repeats === 1 ? "repeat" : "repeats"}, ${(totals.waitedMs / 1000).toFixed(1)} s of waiting in all): nothing of them had been written to a connection.`
        : "";
    const report = `## Lost stage requests\n\n${Option.isNone(read) ? lostRequestsUncounted : lostRequestLines(read.value)}${passedWithRepeats}\n`;
    yield* Console.log(report);
    if (passedWithRepeats !== "")
      yield* Console.log(`::warning title=Stage requests sent again::${passedWithRepeats.trim()}`);
    if (Option.isNone(read))
      yield* Console.log(
        `::warning title=Lost stage requests not counted::${lostRequestsUncounted}`,
      );
    else {
      const lost = read.value.length - (totals?.requests ?? 0);
      if (lost > 0)
        yield* Console.log(
          `::warning title=Lost stage requests::${lost} stage ${lost === 1 ? "request was" : "requests were"} lost in transport.`,
        );
    }
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    if (Option.isSome(summary)) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
