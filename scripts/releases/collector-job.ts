import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { waitForJob } from "./job-wait.ts";

const minutes = 25;

NodeRuntime.runMain(
  Effect.gen(function* () {
    const target = yield* Config.String("TARGET");
    const caller = yield* Config.String("CALLER").pipe(Config.option);
    const use = yield* Config.schema(Schema.Literals(["packaging", "scenarios"]), "COLLECTOR_USE");
    const job = `collector (${target})`;
    yield* waitForJob({
      job,
      caller: caller._tag === "Some" ? caller.value : undefined,
      minutes,
      ended: (conclusion, url) =>
        `The ${job} job ended ${conclusion}, so this job has no ${target} collector for its ${use}; this failure follows from that one. Rerun the ${job} job, then this one.${url === undefined ? "" : ` ${url}`}`,
      late: (reason, limit) =>
        `The ${job} job did not finish within ${limit} (${reason}). Rerun this job once it has.`,
      succeeded: `The ${job} job succeeded, and its build is fetched whole.`,
      artifact: { name: `collector-${target}`, into: "packages/telemetry/dist/collector" },
    });
  }).pipe(Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
