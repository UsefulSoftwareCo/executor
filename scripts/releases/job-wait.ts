import { createHash } from "node:crypto";
import { Config, Console, Duration, Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { unzipSync } from "fflate";

const Job = Schema.Struct({
  id: Schema.Number,
  run_attempt: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  started_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  html_url: Schema.optionalKey(Schema.String),
});

const Jobs = Schema.Struct({
  total_count: Schema.Number,
  jobs: Schema.Array(Job),
});

const Artifacts = Schema.Struct({
  total_count: Schema.Number,
  artifacts: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      size_in_bytes: Schema.Number,
      expired: Schema.Boolean,
      digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
      created_at: Schema.NullOr(Schema.String),
    }),
  ),
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
  readonly artifact?: { readonly name: string; readonly into: string } | undefined;
};

const attemptSeconds = 30;
const pollSeconds = 10;
const fetchSeconds = 300;
const mismatchedDownloads = 3;

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
    const fetchLimit = yield* seconds("JOB_WAIT_FETCH_SECONDS", fetchSeconds);
    const http = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const url = `${api}/repos/${repository}/actions/runs/${run}/attempts/${runAttempt}/jobs?per_page=100`;

    const request = (target: string, what: string) =>
      Effect.gen(function* () {
        const response = yield* http
          .execute(
            HttpClientRequest.get(target).pipe(
              HttpClientRequest.bearerToken(Redacted.value(token)),
              HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
            ),
          )
          .pipe(
            Effect.mapError(() => new NotFinished({ reason: `the ${what} API did not answer` })),
          );
        if (response.status !== 200) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          const message = apiMessage(body);
          const retryAfter = retryAfterSeconds(response.headers["retry-after"]);
          return yield* new NotFinished({
            reason: `the ${what} API answered ${response.status}${message === undefined ? "" : `: ${message}`}`,
            ...(retryAfter === undefined ? {} : { retryAfter }),
          });
        }
        return response;
      });
    const get = <S extends Schema.Top>(target: string, schema: S, what: string) =>
      request(target, what)
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError((error) =>
            error._tag === "NotFinished"
              ? error
              : new NotFinished({ reason: `the ${what} API answered unreadably` }),
          ),
        )
        .pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(attempt),
            orElse: () =>
              Effect.fail(
                new NotFinished({ reason: `the ${what} API did not answer within ${attempt} s` }),
              ),
          }),
        );
    const page = (number: number) =>
      get(number === 1 ? url : `${url}&page=${number}`, Jobs, "jobs");
    const mismatched = new Map<number, number>();
    const acquired = (
      artifact: { readonly name: string; readonly into: string },
      job: typeof Job.Type,
    ) =>
      Effect.gen(function* () {
        const name = artifact.name;
        const from = Date.parse(job.started_at ?? "");
        if (Number.isNaN(from))
          return yield* new NotFinished({
            reason: `the ${options.job} job succeeded, but run ${run} does not list when it started yet`,
          });
        const found = yield* get(
          `${api}/repos/${repository}/actions/runs/${run}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
          Artifacts,
          "artifacts",
        );
        const since = found.artifacts.filter(
          (each) =>
            each.name === name &&
            (each.created_at === null ? Number.NaN : Date.parse(each.created_at)) >= from,
        );
        const usable = since.filter(
          (each) =>
            !each.expired &&
            each.size_in_bytes > 0 &&
            /^sha256:[0-9a-f]{64}$/u.test(each.digest ?? ""),
        );
        if (
          found.total_count === found.artifacts.length &&
          since.length > 0 &&
          since.every((each) => each.expired)
        )
          return yield* new JobWaitFailed({
            message: `The ${options.job} job succeeded, but run ${run}'s artifact${since.length === 1 ? "" : "s"} named ${name} uploaded since it started (${since.map((each) => each.id).join(", ")}) expired, so this job cannot fetch its build. Rerun the ${options.job} job, then this one.`,
          });
        const chosen = usable[0];
        if (
          chosen === undefined ||
          usable.length !== 1 ||
          found.total_count !== found.artifacts.length
        )
          return yield* new NotFinished({
            reason: `the ${options.job} job succeeded, and run ${run} lists ${usable.length} usable artifacts named ${name} uploaded since it started yet`,
          });
        const response = yield* request(
          `${api}/repos/${repository}/actions/artifacts/${chosen.id}/zip`,
          `artifact ${chosen.id} download`,
        ).pipe(
          Effect.flatMap((answer) =>
            answer.arrayBuffer.pipe(
              Effect.mapError(
                () => new NotFinished({ reason: `artifact ${chosen.id}'s download broke off` }),
              ),
            ),
          ),
          Effect.timeoutOrElse({
            duration: Duration.seconds(fetchLimit),
            orElse: () =>
              Effect.fail(
                new NotFinished({
                  reason: `artifact ${chosen.id} did not download within ${fetchLimit} s`,
                }),
              ),
          }),
        );
        const bytes = new Uint8Array(response);
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (digest !== chosen.digest) {
          const times = (mismatched.get(chosen.id) ?? 0) + 1;
          mismatched.set(chosen.id, times);
          if (times >= mismatchedDownloads)
            return yield* new JobWaitFailed({
              message: `Artifact ${chosen.id} (${name}) downloaded ${times} times in a row as bytes whose SHA-256 is not the one listed for its ${chosen.size_in_bytes} bytes (the last ${bytes.length} bytes), so nothing was unpacked into ${artifact.into}. Rerun the ${options.job} job, then this one.`,
            });
          return yield* new NotFinished({
            reason: `artifact ${chosen.id} downloaded as ${bytes.length} bytes whose SHA-256 is not the one listed for its ${chosen.size_in_bytes} bytes`,
          });
        }
        mismatched.delete(chosen.id);
        const unreadable = new JobWaitFailed({
          message: `Artifact ${chosen.id} (${name}) matches its listed SHA-256 but is not a zip of plain relative paths, so it cannot be unpacked into ${artifact.into}.`,
        });
        const entries = yield* Effect.try({ try: () => unzipSync(bytes), catch: () => unreadable });
        const files = Object.entries(entries).filter(([entry]) => !entry.endsWith("/"));
        if (
          files.length === 0 ||
          files.some(
            ([entry]) =>
              entry.includes("\\") ||
              entry.split("/").some((part) => part === "" || part === "." || part === ".."),
          )
        )
          return yield* unreadable;
        const unwritable = (cause: unknown) =>
          new JobWaitFailed({
            message: `Artifact ${chosen.id} (${name}) could not be written into ${artifact.into}: ${String(cause)}`,
          });
        for (const [entry, data] of files) {
          const target = path.join(artifact.into, ...entry.split("/"));
          yield* fs
            .makeDirectory(path.dirname(target), { recursive: true })
            .pipe(Effect.mapError(unwritable));
          yield* fs.writeFile(target, data).pipe(Effect.mapError(unwritable));
        }
        yield* Console.log(
          `Fetched artifact ${chosen.id} (${name}, ${bytes.length} bytes, SHA-256 as listed) into ${artifact.into}: ${files.length} file${files.length === 1 ? "" : "s"}.`,
        );
      });

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
      if (options.artifact !== undefined) yield* acquired(options.artifact, job);
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
