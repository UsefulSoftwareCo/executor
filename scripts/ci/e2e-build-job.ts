import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { waitForJob } from "../releases/job-wait.ts";

const minutes = 25;
const job = "e2e-build";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const caller = yield* Config.String("CALLER").pipe(Config.option);
    yield* waitForJob({
      job,
      caller: caller._tag === "Some" ? caller.value : undefined,
      minutes,
      ended: (conclusion, url) =>
        `The ${job} job ended ${conclusion}, so this job has no build of this commit to run scenarios against; this failure follows from that one. Rerun the ${job} job, then this one.${url === undefined ? "" : ` ${url}`}`,
      late: (reason, limit) =>
        `The ${job} job did not finish within ${limit} (${reason}). Rerun this job once it has.`,
      succeeded: `The ${job} job succeeded, and its build is fetched whole.`,
      artifact: { name: "e2e-build", into: ".local/e2e-build" },
    });
  }).pipe(Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
