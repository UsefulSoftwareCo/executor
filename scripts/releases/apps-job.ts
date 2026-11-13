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
 * Reads `GITHUB_API_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID` and `GH_TOKEN` (the job's token with
 * `actions: read`). `filter=latest` lists each job's latest attempt, so a rerun of failed jobs sees
 * the `apps` job that already succeeded.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/** The job this waits for, by its name in `.github/workflows/deploy.yml`. */
const jobName = "apps";

/**
 * Every 10 s for 15 minutes, so this step fails with its own message inside the deploy job's
 * 30-minute time-out. Across 58 deploys on 12-13 November the job spent at most 1 minute before
 * this step and at most 7 minutes after the npm check that follows it, which then takes seconds.
 * An `apps` job that takes longer, waiting on a slow npm, still holds the deploy back; rerunning
 * the failed deploy job once it has finished costs seconds.
 */
const minutes = 15;
const poll = Schedule.spaced(10_000);
const polls = (minutes * 60) / 10;

const Jobs = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      html_url: Schema.optionalKey(Schema.String),
    }),
  ),
});

class AppsJobFailed extends Schema.TaggedError<AppsJobFailed>()("AppsJobFailed", {
  message: Schema.String,
}) {}

/** The `apps` job has not finished, or the API could not say: ask again. */
class NotFinished extends Schema.TaggedError<NotFinished>()("NotFinished", {
  reason: Schema.String,
}) {}

NodeRuntime.runMain(
  Effect.gen(function* () {
    const api = yield* Config.String("GITHUB_API_URL").pipe(
      Config.withDefault("https://api.github.com"),
    );
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const run = yield* Config.String("GITHUB_RUN_ID");
    const token = yield* Config.Redacted("GH_TOKEN");
    const http = yield* HttpClient.HttpClient;
    const url = `${api}/repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=100`;
    const look = Effect.gen(function* () {
      const response = yield* http
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
          ),
        )
        .pipe(Effect.mapError(() => new NotFinished({ reason: "the jobs API did not answer" })));
      if (response.status !== 200) {
        yield* response.text.pipe(Effect.ignore);
        return yield* new NotFinished({ reason: `the jobs API answered ${response.status}` });
      }
      const { jobs } = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Jobs)),
        Effect.mapError(() => new NotFinished({ reason: "the jobs API answered unreadably" })),
      );
      const job = jobs.find((candidate) => candidate.name === jobName);
      if (job === undefined)
        return yield* new NotFinished({ reason: `run ${run} lists no ${jobName} job yet` });
      if (job.status !== "completed")
        return yield* new NotFinished({ reason: `the ${jobName} job is ${job.status}` });
      if (job.conclusion !== "success")
        return yield* new AppsJobFailed({
          message: `The ${jobName} job ended ${job.conclusion ?? "without a conclusion"}, so npm may not serve this build's apps release; not deploying.${job.html_url === undefined ? "" : ` ${job.html_url}`}`,
        });
      return job;
    });
    yield* look.pipe(
      Effect.tapError((error) =>
        error._tag === "NotFinished"
          ? Console.log(`Waiting for the ${jobName} job: ${error.reason}`)
          : Effect.void,
      ),
      Effect.retry({
        while: (error) => error._tag === "NotFinished",
        schedule: poll,
        times: polls,
      }),
      Effect.catchTag("NotFinished", (error) =>
        Effect.fail(
          new AppsJobFailed({
            message: `The ${jobName} job did not finish within ${minutes} minutes (${error.reason}); not deploying. Rerun this job once it has.`,
          }),
        ),
      ),
    );
    yield* Console.log(
      `The ${jobName} job succeeded: it published this build's apps release or found it on npm unchanged.`,
    );
  }).pipe(Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
