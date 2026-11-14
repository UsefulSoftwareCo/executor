/**
 * Wait for another job of this workflow run to finish, and fail unless it succeeded.
 *
 * A job that needs another's result only part way through runs beside it instead of after it, and
 * waits at the step that needs it. It follows the job through GitHub's jobs API, not through what
 * the job leaves behind, so a job that failed, was cancelled or was skipped stops the waiter at once,
 * and a file it never wrote is never mistaken for "not yet".
 *
 * Doubt that is still there when the wait ends fails it, with a message naming the cause; the wait
 * never ends as a success on doubt, and never runs past its deadline. The wait has one deadline in
 * elapsed time, and each request to the API, its body included, has its own. During the wait, an
 * answer that leaves doubt is not an answer: a request that fails, times out or answers unreadably,
 * a job list that changes between its pages, a job not listed yet, or two jobs with the name seen
 * once are all asked again at the next poll. It fails at once only on what cannot change: the job
 * finished without success, or the same name listed twice on two consecutive consistent reads.
 *
 * It lists the jobs of this run's own attempt (`RUN_ATTEMPT`, which the workflow step passes as
 * `github.run_attempt`) and considers only jobs whose `run_attempt` is that attempt; a job of the
 * name from another attempt is never the answer, and is named in the "not yet" message. After
 * "re-run failed jobs", GitHub lists a job the new attempt did not run again as a new record with a
 * new id, this attempt's number and the original start and end times, so a rerun accepts the job
 * that already succeeded. After "re-run all jobs", the new attempt runs the job again; what the
 * listing shows in that attempt's first seconds has not been observed, but an earlier attempt's
 * record carries that attempt's number and so can never match.
 *
 * Reads `GITHUB_API_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `RUN_ATTEMPT` and `GH_TOKEN` (the
 * job's token with `actions: read`). `JOB_WAIT_LIMIT_SECONDS`, `JOB_WAIT_ATTEMPT_SECONDS` and
 * `JOB_WAIT_POLL_SECONDS` shorten the limits for tests.
 */
import { Config, Console, Duration, Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

const Job = Schema.Struct({
  id: Schema.Number,
  run_attempt: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.optionalKey(Schema.String),
});

const Jobs = Schema.Struct({
  total_count: Schema.Number,
  jobs: Schema.Array(Job),
});

/** The job ended without success, the answer left doubt, or the deadline passed. */
export class JobWaitFailed extends Schema.TaggedError<JobWaitFailed>()("JobWaitFailed", {
  message: Schema.String,
}) {}

/** The job has not finished, or the API could not say: ask again, within the deadline. */
class NotFinished extends Schema.TaggedError<NotFinished>()("NotFinished", {
  reason: Schema.String,
}) {}

/** How to wait for one job and what to say about it. */
export type JobWait = {
  /** The job's name as the jobs API lists it, such as `apps` or `collector (linux-x64)`. */
  readonly job: string;
  /** How long to wait in all, in minutes of elapsed time. */
  readonly minutes: number;
  /** The failure for a job that ended `conclusion`; `url` is its page, when the API gave one. */
  readonly ended: (conclusion: string, url: string | undefined) => string;
  /** The failure for a job still unfinished at the deadline; `reason` is the last answer. */
  readonly late: (reason: string) => string;
  /** What to print once it succeeded. */
  readonly succeeded: string;
};

/** How long one request may take, its body included, before it counts as unanswered. */
const attemptSeconds = 30;
/** How long to wait between two looks. */
const pollSeconds = 10;

/** A positive number of seconds from `name`, or `fallback`; anything else fails the wait. */
const seconds = (name: string, fallback: number) =>
  Config.Number(name).pipe(
    Config.withDefault(fallback),
    Effect.mapError(() => new JobWaitFailed({ message: `${name} must be a number of seconds` })),
    Effect.flatMap((value) =>
      Number.isFinite(value) && value > 0
        ? Effect.succeed(value)
        : Effect.fail(
            new JobWaitFailed({ message: `${name} must be a positive number of seconds` }),
          ),
    ),
  );

/**
 * Follows `options.job` in this run until it completes. Succeeds when it succeeded; fails with
 * {@link JobWaitFailed} as soon as it completes otherwise or an answer leaves doubt, and after
 * `options.minutes` of elapsed time otherwise.
 */
export const waitForJob = (options: JobWait) =>
  Effect.gen(function* () {
    const api = yield* Config.String("GITHUB_API_URL").pipe(
      Config.withDefault("https://api.github.com"),
    );
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const run = yield* Config.String("GITHUB_RUN_ID");
    const runAttempt = yield* Config.String("RUN_ATTEMPT").pipe(
      Effect.mapError(
        () =>
          new JobWaitFailed({
            message: "RUN_ATTEMPT is not set: pass the step's github.run_attempt",
          }),
      ),
      Effect.flatMap((value) =>
        // Checked after converting too: a value past 2^53 would be asked for as a different number.
        /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value))
          ? Effect.succeed(Number(value))
          : Effect.fail(
              new JobWaitFailed({
                message: `RUN_ATTEMPT must be a positive safe integer, not ${JSON.stringify(value)}`,
              }),
            ),
      ),
    );
    const token = yield* Config.Redacted("GH_TOKEN");
    const limit = yield* seconds("JOB_WAIT_LIMIT_SECONDS", options.minutes * 60);
    const attempt = yield* seconds("JOB_WAIT_ATTEMPT_SECONDS", attemptSeconds);
    const poll = yield* seconds("JOB_WAIT_POLL_SECONDS", pollSeconds);
    const http = yield* HttpClient.HttpClient;
    const url = `${api}/repos/${repository}/actions/runs/${run}/attempts/${runAttempt}/jobs?per_page=100`;

    /** One page of the job list: one request, its body included, within `attempt` seconds. */
    const page = (number: number) =>
      Effect.gen(function* () {
        const response = yield* http
          .execute(
            HttpClientRequest.get(number === 1 ? url : `${url}&page=${number}`).pipe(
              HttpClientRequest.bearerToken(Redacted.value(token)),
              HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
            ),
          )
          .pipe(Effect.mapError(() => new NotFinished({ reason: "the jobs API did not answer" })));
        if (response.status !== 200) {
          // Read and dropped inside this attempt's time limit, so a body that never ends cannot
          // hold the wait.
          yield* response.text.pipe(Effect.ignore);
          return yield* new NotFinished({ reason: `the jobs API answered ${response.status}` });
        }
        return yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Jobs)),
          Effect.mapError(() => new NotFinished({ reason: "the jobs API answered unreadably" })),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(attempt),
          orElse: () =>
            Effect.fail(
              new NotFinished({ reason: `the jobs API did not answer within ${attempt} s` }),
            ),
        }),
      );

    /** Whether the last consistent read listed the job twice. */
    let duplicatedBefore = false;
    const look = Effect.gen(function* () {
      const first = yield* page(1);
      const jobs = [...first.jobs];
      const changed = new NotFinished({
        reason: `run ${run}'s job list changed while it was read`,
      });
      for (let number = 2; jobs.length < first.total_count; number++) {
        const next = yield* page(number);
        if (next.total_count !== first.total_count || next.jobs.length === 0) return yield* changed;
        jobs.push(...next.jobs);
      }
      if (
        new Set(jobs.map((job) => job.id)).size !== jobs.length ||
        jobs.length !== first.total_count
      )
        return yield* changed;
      // A consistent read. Only this attempt's records count; another attempt's is never the answer.
      const named = jobs.filter((candidate) => candidate.name === options.job);
      const matches = named.filter((candidate) => candidate.run_attempt === runAttempt);
      const others = named.filter((candidate) => candidate.run_attempt !== runAttempt);
      const duplicated = matches.length > 1;
      const twice = duplicated && duplicatedBefore;
      duplicatedBefore = duplicated;
      if (twice)
        return yield* new JobWaitFailed({
          message: `Run ${run} lists ${matches.length} jobs named ${options.job} in attempt ${runAttempt} on two reads in a row; cannot tell which to wait for.`,
        });
      if (duplicated)
        return yield* new NotFinished({
          reason: `run ${run} lists ${matches.length} jobs named ${options.job} in attempt ${runAttempt}`,
        });
      const job = matches[0];
      if (job === undefined)
        return yield* new NotFinished({
          reason:
            others.length === 0
              ? `run ${run} lists no ${options.job} job yet`
              : `run ${run} lists a job named ${options.job} from attempt ${[...new Set(others.map((other) => other.run_attempt))].join(", ")}, but none from this attempt, ${runAttempt}`,
        });
      if (job.status !== "completed")
        return yield* new NotFinished({ reason: `the ${options.job} job is ${job.status}` });
      if (job.conclusion !== "success")
        return yield* new JobWaitFailed({
          message: options.ended(job.conclusion ?? "without a conclusion", job.html_url),
        });
      return job;
    });

    let last = "no answer yet";
    yield* look.pipe(
      Effect.tapError((error) =>
        error._tag === "NotFinished"
          ? Effect.andThen(
              Effect.sync(() => {
                last = error.reason;
              }),
              Console.log(`Waiting for the ${options.job} job: ${error.reason}`),
            )
          : Effect.void,
      ),
      Effect.retry({
        while: (error) => error._tag === "NotFinished",
        schedule: Schedule.spaced(Duration.seconds(poll)),
      }),
      Effect.timeoutOrElse({
        duration: Duration.seconds(limit),
        orElse: () => Effect.fail(new JobWaitFailed({ message: options.late(last) })),
      }),
      Effect.catchTag("NotFinished", (error) =>
        Effect.fail(new JobWaitFailed({ message: options.late(error.reason) })),
      ),
    );
    yield* Console.log(options.succeeded);
  });
