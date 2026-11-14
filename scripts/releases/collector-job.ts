/**
 * Wait for this release run's `collector (<target>)` job, which builds the Rust telemetry collector
 * for one target or restores that build from the cache and uploads it as `collector-<target>`, and
 * fail unless it succeeded.
 *
 *   TARGET=linux-x64 node scripts/releases/collector-job.ts
 *
 * Every job that packages the CLI runtime (`local`, `checks`, `cli`, `recovery`) starts with the
 * run, beside the collector jobs, and waits here before it downloads its target's build: a cache
 * miss or a Windows runner's queue then delays only that target's packaging, and only by what is
 * left of it. A collector job that failed, was cancelled or was skipped stops the waiter at once,
 * and `releases` names it. The waiting is `job-wait.ts`'s (`GITHUB_API_URL`, `GITHUB_REPOSITORY`,
 * `GITHUB_RUN_ID` and `GH_TOKEN` with `actions: read`).
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { waitForJob } from "./job-wait.ts";

/**
 * 25 minutes of elapsed time, asked every 10 s. A cold build took at most 101 s on 13 November,
 * and a Windows collector job waited up to 3.5 minutes for a runner first. The collector job's
 * own 20-minute time-out counts only from when a runner takes it, not its time in the queue, so a
 * long queue can still reach this limit first; the waiter then fails with its own message, naming
 * what it last saw.
 */
const minutes = 25;

NodeRuntime.runMain(
  Effect.gen(function* () {
    const target = yield* Config.String("TARGET");
    const job = `collector (${target})`;
    yield* waitForJob({
      job,
      minutes,
      ended: (conclusion, url) =>
        `The ${job} job ended ${conclusion}, so this run has no ${target} collector to package.${url === undefined ? "" : ` ${url}`}`,
      late: (reason, limit) =>
        `The ${job} job did not finish within ${limit} (${reason}). Rerun this job once it has.`,
      succeeded: `The ${job} job succeeded; fetching its build.`,
    });
  }).pipe(Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
