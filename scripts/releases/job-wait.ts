import { Config, Console, Duration, Effect, Redacted, Schema } from "effect";
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

export class JobWaitFailed extends Schema.TaggedError<JobWaitFailed>()("JobWaitFailed", {
  message: Schema.String,
}) {}

class NotFinished extends Schema.TaggedError<NotFinished>()("NotFinished", {
  reason: Schema.String,
  retryAfter: Schema.optionalKey(Schema.Number),
}) {}

/**
 * The forms of HTTP-date a `retry-after` may carry (RFC 9110): the preferred IMF-fixdate
 * (`Sun, 06 Nov 1994 08:49:37 GMT`), and the obsolete RFC 850 and asctime forms.
 */
const httpDates = [
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u,
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/u,
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/u,
];

const retryAfterSeconds = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^[0-9]+$/u.test(trimmed)) return Number(trimmed);
  const form = httpDates.findIndex((date) => date.test(trimmed));
  if (form === -1) return undefined;
  const at = Date.parse(form === 2 ? `${trimmed} GMT` : trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
};

const apiMessage = (body: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
      ? parsed.message
      : undefined;
  } catch {
    return undefined;
  }
};

const attemptFrom = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.mapError(() => new JobWaitFailed({ message: `${name} cannot be read` })),
    Effect.flatMap((value) => {
      if (value._tag === "None") return Effect.succeed(undefined);
      const text = value.value;
      return /^[1-9][0-9]*$/u.test(text) && Number.isSafeInteger(Number(text))
        ? Effect.succeed(Number(text))
        : Effect.fail(
            new JobWaitFailed({
              message: `${name} must be a positive safe integer, not ${JSON.stringify(text)}`,
            }),
          );
    }),
  );

const spoken = (seconds: number) =>
  seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} s`;

export type JobWait = {
  readonly job: string;
  readonly caller?: string | undefined;
  readonly minutes: number;
  readonly ended: (conclusion: string, url: string | undefined) => string;
  readonly late: (reason: string, limit: string) => string;
  readonly succeeded: string;
};

const attemptSeconds = 30;
const pollSeconds = 10;

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

export const waitForJob = (options: JobWait) =>
  Effect.gen(function* () {
    const api = yield* Config.String("GITHUB_API_URL").pipe(
      Config.withDefault("https://api.github.com"),
    );
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const run = yield* Config.String("GITHUB_RUN_ID");
    const runAttempt =
      (yield* attemptFrom("GITHUB_RUN_ATTEMPT")) ??
      (yield* new JobWaitFailed({
        message: "GITHUB_RUN_ATTEMPT is not set: this must run in a GitHub Actions step",
      }));
    const token = yield* Config.Redacted("GH_TOKEN");
    const limit = yield* seconds("JOB_WAIT_LIMIT_SECONDS", options.minutes * 60);
    const attempt = yield* seconds("JOB_WAIT_ATTEMPT_SECONDS", attemptSeconds);
    const poll = yield* seconds("JOB_WAIT_POLL_SECONDS", pollSeconds);
    const http = yield* HttpClient.HttpClient;
    const url = `${api}/repos/${repository}/actions/runs/${run}/attempts/${runAttempt}/jobs?per_page=100`;

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
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          const message = apiMessage(body);
          const retryAfter = retryAfterSeconds(response.headers["retry-after"]);
          return yield* new NotFinished({
            reason: `the jobs API answered ${response.status}${message === undefined ? "" : `: ${message}`}`,
            ...(retryAfter === undefined ? {} : { retryAfter }),
          });
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
      const named = jobs.filter(
        (candidate) =>
          candidate.name === options.job ||
          (options.caller !== undefined && candidate.name === `${options.caller} / ${options.job}`),
      );
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
    const follow: Effect.Effect<void, JobWaitFailed> = Effect.suspend(() =>
      look.pipe(
        Effect.asVoid,
        Effect.catchTag("NotFinished", (error) => {
          last = error.reason;
          const pause = Math.max(poll, error.retryAfter ?? 0);
          return Console.log(`Waiting for the ${options.job} job: ${error.reason}`).pipe(
            Effect.andThen(Effect.sleep(Duration.seconds(pause))),
            Effect.andThen(follow),
          );
        }),
      ),
    );
    yield* follow.pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(limit),
        orElse: () =>
          Effect.fail(new JobWaitFailed({ message: options.late(last, spoken(limit)) })),
      }),
    );
    yield* Console.log(options.succeeded);
  });
