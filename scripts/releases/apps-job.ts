/**
 * Wait for this Deploy run's `apps` job, which publishes the `apps` release or checks that npm
 * holds it unchanged, and fail unless it succeeded.
 *
 *   node scripts/releases/apps-job.ts
 *
 * The production deploy job runs beside the `apps` job so its setup overlaps. It must not go live
 * on a version npm does not serve, and it used to find out by asking npm from the moment it
 * started: before a new version was published, and with no word of a publish that failed. Waiting
 * for the `apps` job first means npm is asked only once the version can exist, and a failed,
 * cancelled or skipped `apps` job stops the deploy at once. `apps-published.ts --await` then checks
 * npm itself, as before.
 *
 * The waiting is `job-wait.ts`'s: it reads `GITHUB_API_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`,
 * `GITHUB_RUN_ATTEMPT` (set by GitHub in every step) and `GH_TOKEN` (the job's token with
 * `actions: read`), and takes only this attempt's jobs: a rerun of failed jobs sees the `apps` job
 * that already succeeded, and a rerun of all jobs waits for the new one. Doubt still there at the deadline stops the deploy with
 * a message naming it; nothing but this attempt's successful `apps` job lets it go on.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { waitForJob } from "./job-wait.ts";

/** The job this waits for, by its name in `.github/workflows/deploy.yml`. */
const jobName = "apps";

/**
 * 15 minutes of elapsed time, asked every 10 s with 30 s for each request, so this step fails with
 * its own message inside the deploy job's 30-minute time-out. Across 58 deploys on 12-13 November the job spent at most 1 minute before
 * this step and at most 7 minutes after the npm check that follows it, which then takes seconds.
 * An `apps` job that takes longer, waiting on a slow npm, still holds the deploy back; rerunning
 * the failed deploy job once it has finished costs seconds.
 */
const minutes = 15;

NodeRuntime.runMain(
  waitForJob({
    job: jobName,
    minutes,
    ended: (conclusion, url) =>
      `The ${jobName} job ended ${conclusion}, so npm may not serve this build's apps release; not deploying.${url === undefined ? "" : ` ${url}`}`,
    late: (reason) =>
      `The ${jobName} job did not finish within ${minutes} minutes (${reason}); not deploying. Rerun this job once it has.`,
    succeeded: `The ${jobName} job succeeded: it published this build's apps release or found it on npm unchanged.`,
  }).pipe(Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
