/**
 * Wait for this CI run's `e2e-build` job, which runs `e2e:prepare` once for the run and uploads
 * what it built as `e2e-build`, and fail unless it succeeded.
 *
 *   CALLER=checks node scripts/ci/e2e-build-job.ts
 *
 * The E2E jobs that run scenarios on source start beside it, install their tools, and wait here
 * before they unpack its build, so they build nothing the run already built, and its time overlaps
 * their own setup. A build job that failed, was cancelled or was skipped stops the waiter at once.
 * The waiting is `job-wait.ts`'s (`GITHUB_API_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID` and
 * `GH_TOKEN` with `actions: read`).
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { waitForJob } from "../releases/job-wait.ts";

/**
 * 25 minutes of elapsed time, the collector job's bound (scripts/releases/collector-job.ts): the
 * build job's own 15-minute time-out counts only from when a runner takes it.
 */
const minutes = 25;
const job = "e2e-build";

NodeRuntime.runMain(
  Effect.gen(function* () {
    // CI's checks.yml runs as a called workflow, its jobs listed under the caller's (`checks`).
    const caller = yield* Config.String("CALLER").pipe(Config.option);
    yield* waitForJob({
      job,
      caller: caller._tag === "Some" ? caller.value : undefined,
      minutes,
      ended: (conclusion, url) =>
        `The ${job} job ended ${conclusion}, so this job has no build of this commit to run scenarios against; this failure follows from that one. Rerun the ${job} job, then this one.${url === undefined ? "" : ` ${url}`}`,
      late: (reason, limit) =>
        `The ${job} job did not finish within ${limit} (${reason}). Rerun this job once it has.`,
      succeeded: `The ${job} job succeeded; fetching its build.`,
    });
  }).pipe(Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
