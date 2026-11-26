import { Cache, Config, DateTime, Duration, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  DeployEventsFailed,
  DeployOutcome,
  DeployTrigger,
  deployCommit,
  deployEvent,
  exchange,
  runAttemptUrl,
  type DeployEvent,
} from "./deploy-events.ts";

const deployWorkflow = "deploy.yml";
const deployJob = "deploy";
const decideJob = "decide";
const deploySteps = ["Deploy analytics and the v2 stage", "Deploy the v2 stage"];
const rerunWindow = Duration.days(32);
const listSpan = Duration.days(7);
const listLimit = 1000;

export const githubGet = <S extends Schema.Top>(schema: S, path: string) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("GITHUB_TOKEN");
    const api = yield* Config.NonEmptyString("GITHUB_API_URL").pipe(
      Config.withDefault("https://api.github.com"),
    );
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(`${api.replace(/\/$/, "")}/${path}`).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      }),
    );
    return yield* exchange(
      `GitHub (${path})`,
      Effect.gen(function* () {
        const response = yield* client.execute(request);
        if (response.status !== 200)
          return yield* new DeployEventsFailed({
            message: `GitHub answered ${response.status} for ${path}`,
            retryable: response.status === 429 || response.status >= 500,
          });
        return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
      }),
    );
  });

const DeployRun = Schema.Struct({
  id: Schema.Number,
  run_attempt: Schema.Number,
  event: Schema.String,
  status: Schema.String,
  head_sha: Schema.String,
  created_at: Schema.DateTimeUtcFromString,
  updated_at: Schema.DateTimeUtcFromString,
});
export type DeployRun = typeof DeployRun.Type;

const DeployRuns = Schema.Struct({
  total_count: Schema.Number,
  workflow_runs: Schema.Array(DeployRun),
});
const Workflow = Schema.Struct({ created_at: Schema.DateTimeUtcFromString });
const Step = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.DateTimeUtcFromString),
  completed_at: Schema.NullOr(Schema.DateTimeUtcFromString),
});
const Jobs = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      created_at: Schema.DateTimeUtcFromString,
      started_at: Schema.NullOr(Schema.DateTimeUtcFromString),
      steps: Schema.optional(Schema.Array(Step)),
    }),
  ),
});

const runsPath = (repository: string) =>
  `repos/${repository}/actions/workflows/${deployWorkflow}/runs?branch=main&exclude_pull_requests=true`;

export const listSpanOf = (time: DateTime.Utc) => {
  const span = Duration.toMillis(listSpan);
  return DateTime.makeUnsafe(Math.floor(DateTime.toEpochMillis(time) / span) * span);
};
export const listSpansBetween = (from: DateTime.Utc, to: DateTime.Utc) => {
  const spans: Array<DateTime.Utc> = [];
  for (
    let start = listSpanOf(from);
    DateTime.isLessThanOrEqualTo(start, to);
    start = DateTime.addDuration(start, listSpan)
  )
    spans.push(start);
  return spans;
};

const searchTime = (time: DateTime.Utc) => DateTime.formatIso(time).replace(/\.\d{3}Z$/u, "Z");

const runsCreatedIn = (repository: string, start: DateTime.Utc) =>
  Effect.gen(function* () {
    const last = DateTime.subtract(DateTime.addDuration(start, listSpan), { seconds: 1 });
    const created = encodeURIComponent(`${searchTime(start)}..${searchTime(last)}`);
    const runs = new Map<number, DeployRun>();
    for (let page = 1; ; page++) {
      const { total_count, workflow_runs } = yield* githubGet(
        DeployRuns,
        `${runsPath(repository)}&created=${created}&per_page=100&page=${page}`,
      );
      if (total_count > listLimit)
        return yield* Effect.die(
          `GitHub holds ${total_count} Deploy runs created from ${searchTime(start)}, more than one query lists`,
        );
      for (const run of workflow_runs) runs.set(run.id, run);
      if (workflow_runs.length < 100) return [...runs.values()];
    }
  });

interface DeployStep {
  readonly startedAt: DateTime.Utc;
  readonly finishedAt: DateTime.Utc;
  readonly outcome: DeployOutcome;
}

export interface DeployAttempt extends DeployStep {
  readonly run: DeployRun;
  readonly number: number;
}

const readDeployStep = (repository: string, runId: number, number: number) =>
  Effect.gen(function* () {
    const { jobs } = yield* githubGet(
      Jobs,
      `repos/${repository}/actions/runs/${runId}/attempts/${number}/jobs?per_page=100`,
    );
    const job = jobs.find((candidate) => candidate.name === deployJob);
    if (job === undefined) return Option.none<DeployStep>();
    if (job.started_at !== null && DateTime.isLessThan(job.started_at, job.created_at))
      return Option.none<DeployStep>();
    if ((job.steps ?? []).length === 0) return Option.none<DeployStep>();
    const step = job.steps?.find((candidate) => deploySteps.includes(candidate.name));
    if (step === undefined && job.conclusion !== null)
      return yield* Effect.die(
        `Run ${runId} attempt ${number}: the ${deployJob} job has no step named ${deploySteps.join(" or ")}; add its new name to deploySteps`,
      );
    if (step === undefined || step.status !== "completed") return Option.none<DeployStep>();
    if (step.started_at === null || step.completed_at === null)
      return yield* Effect.die(`Run ${runId} attempt ${number}: the deploy step has no times`);
    const ran = step.conclusion !== "skipped";
    const conclusion = ran ? step.conclusion : job.conclusion;
    if (conclusion === null) return Option.none<DeployStep>();
    const outcome = yield* Schema.decodeUnknownEffect(DeployOutcome)(conclusion);
    return Option.some<DeployStep>({
      startedAt: ran ? step.started_at : step.completed_at,
      finishedAt: step.completed_at,
      outcome,
    });
  });

export interface DeployStart {
  readonly run: DeployRun;
  readonly number: number;
  readonly startedAt: DateTime.Utc;
  readonly succeeded: boolean;
  readonly state: string;
}

const readDeployStart = (repository: string, runId: number, number: number) =>
  Effect.gen(function* () {
    const { jobs } = yield* githubGet(
      Jobs,
      `repos/${repository}/actions/runs/${runId}/attempts/${number}/jobs?per_page=100`,
    );
    const job = jobs.find((candidate) => candidate.name === deployJob);
    if (job === undefined) {
      const decide = jobs.find((candidate) => candidate.name === decideJob);
      if (decide === undefined) return Option.none<Omit<DeployStart, "run" | "number">>();
      return Option.some<Omit<DeployStart, "run" | "number">>({
        startedAt: decide.started_at ?? decide.created_at,
        succeeded: false,
        state: `unknown: the run has no job named ${deployJob}`,
      });
    }
    if (job.conclusion === "skipped" || job.started_at === null)
      return Option.none<Omit<DeployStart, "run" | "number">>();
    if (DateTime.isLessThan(job.started_at, job.created_at))
      return Option.none<Omit<DeployStart, "run" | "number">>();
    const step = job.steps?.find((candidate) => deploySteps.includes(candidate.name));
    return Option.some<Omit<DeployStart, "run" | "number">>({
      startedAt: job.started_at,
      succeeded: step?.status === "completed" && step.conclusion === "success",
      state:
        (job.steps ?? []).length === 0
          ? "started, with no step listed yet"
          : step === undefined
            ? `missing (no step named ${deploySteps.join(" or ")})`
            : (step.conclusion ?? step.status),
    });
  });

export const makeDeployHistory = (repository: string) =>
  Effect.gen(function* () {
    const workflow = yield* githubGet(
      Workflow,
      `repos/${repository}/actions/workflows/${deployWorkflow}`,
    );
    const spans = yield* Cache.make({
      capacity: 1000,
      lookup: (start: number) => runsCreatedIn(repository, DateTime.makeUnsafe(start)),
    });
    const steps = yield* Cache.make({
      capacity: 100_000,
      lookup: ([runId, number]: readonly [number, number]) =>
        readDeployStep(repository, runId, number),
    });
    const starts = yield* Cache.make({
      capacity: 100_000,
      lookup: ([runId, number]: readonly [number, number]) =>
        readDeployStart(repository, runId, number),
    });
    return {
      repository,
      since: workflow.created_at,
      runsCreatedIn: (start: DateTime.Utc) => Cache.get(spans, DateTime.toEpochMillis(start)),
      attempt: (run: DeployRun, number: number) =>
        Cache.get(steps, [run.id, number] as const).pipe(
          Effect.map(Option.map((step): DeployAttempt => ({ ...step, run, number }))),
        ),
      start: (run: DeployRun, number: number) =>
        Cache.get(starts, [run.id, number] as const).pipe(
          Effect.map(Option.map((start): DeployStart => ({ ...start, run, number }))),
        ),
      run: (runId: number) => githubGet(DeployRun, `repos/${repository}/actions/runs/${runId}`),
    };
  });
export type DeployHistory = Effect.Success<ReturnType<typeof makeDeployHistory>>;

export const lastDeployBefore = (history: DeployHistory, before: DateTime.Utc) =>
  Effect.gen(function* () {
    let last: DeployAttempt | undefined;
    for (let start = listSpanOf(before); ; start = DateTime.subtractDuration(start, listSpan)) {
      const end = DateTime.addDuration(start, listSpan);
      if (
        last !== undefined &&
        DateTime.isLessThanOrEqualTo(DateTime.addDuration(end, rerunWindow), last.finishedAt)
      )
        return last;
      if (DateTime.isLessThanOrEqualTo(end, history.since)) return last;
      const runs = (yield* history.runsCreatedIn(start))
        .filter((run) => DateTime.isLessThan(run.created_at, before))
        .toSorted((a, b) => DateTime.Order(b.updated_at, a.updated_at));
      for (const run of runs) {
        if (last !== undefined && DateTime.isLessThanOrEqualTo(run.updated_at, last.finishedAt))
          break;
        for (let number = run.run_attempt; number >= 1; number--) {
          const attempt = yield* history.attempt(run, number);
          if (Option.isNone(attempt) || !DateTime.isLessThan(attempt.value.finishedAt, before))
            continue;
          if (
            last !== undefined &&
            DateTime.isLessThanOrEqualTo(attempt.value.finishedAt, last.finishedAt)
          )
            break;
          if (attempt.value.outcome === "success") {
            last = attempt.value;
            break;
          }
        }
      }
    }
  });

export const newestDeployStart = (history: DeployHistory, now: DateTime.Utc, except: number) =>
  Effect.gen(function* () {
    let newest: DeployStart | undefined;
    for (let start = listSpanOf(now); ; start = DateTime.subtractDuration(start, listSpan)) {
      const end = DateTime.addDuration(start, listSpan);
      if (
        newest !== undefined &&
        DateTime.isLessThanOrEqualTo(DateTime.addDuration(end, rerunWindow), newest.startedAt)
      )
        return newest;
      if (DateTime.isLessThanOrEqualTo(end, history.since)) return newest;
      for (const run of yield* history.runsCreatedIn(start)) {
        if (run.id === except) continue;
        if (
          newest !== undefined &&
          run.status === "completed" &&
          DateTime.isLessThanOrEqualTo(run.updated_at, newest.startedAt)
        )
          continue;
        for (let number = run.run_attempt; number >= 1; number--) {
          const attempt = yield* history.start(run, number);
          if (
            Option.isSome(attempt) &&
            (newest === undefined || DateTime.isLessThan(newest.startedAt, attempt.value.startedAt))
          )
            newest = attempt.value;
        }
      }
    }
  });

export const lostRequest = (
  history: DeployHistory,
  base: DeployStart,
  now: DateTime.Utc,
  except: number,
) =>
  Effect.gen(function* () {
    const from = DateTime.subtractDuration(base.startedAt, rerunWindow);
    for (const start of listSpansBetween(from, now).toReversed())
      for (const run of yield* history.runsCreatedIn(start)) {
        if (run.id === except || run.status !== "completed") continue;
        if (!DateTime.isLessThan(base.startedAt, run.updated_at)) continue;
        const attempts =
          run.event === "workflow_dispatch" && DateTime.isLessThan(base.startedAt, run.created_at)
            ? Array.from({ length: run.run_attempt }, (_, index) => index + 1)
            : run.run_attempt > 1
              ? [run.run_attempt]
              : [];
        if (attempts.length === 0) continue;
        const started = yield* Effect.forEach(attempts, (number) => history.start(run, number));
        if (started.every(Option.isNone))
          return {
            run,
            number: run.run_attempt,
            kind: attempts.length === 1 && run.run_attempt > 1 ? "re-run" : "manual dispatch",
          } as const;
      }
    return undefined;
  });

const GitHubCommit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({ message: Schema.String }),
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});
const fromGitHubCommit = (commit: typeof GitHubCommit.Type) =>
  deployCommit(commit.sha, commit.commit.message, commit.author?.login ?? null);
const Comparison = Schema.Struct({
  status: Schema.String,
  total_commits: Schema.Number,
  commits: Schema.Array(GitHubCommit),
});

const deployedCommits = (repository: string, base: string | undefined, sha: string) =>
  Effect.gen(function* () {
    if (base !== undefined && base !== sha) {
      const path = `repos/${repository}/compare/${base}...${sha}?per_page=100`;
      const first = yield* githubGet(Comparison, `${path}&page=1`);
      if (first.status === "ahead") {
        const commits = [...first.commits];
        for (let page = 2; commits.length < first.total_commits; page++) {
          const next = yield* githubGet(Comparison, `${path}&page=${page}`);
          if (next.commits.length === 0) break;
          commits.push(...next.commits);
        }
        return commits.map(fromGitHubCommit);
      }
    }
    const commit = yield* githubGet(GitHubCommit, `repos/${repository}/commits/${sha}`);
    return [fromGitHubCommit(commit)];
  });

export const deployEventOf = (history: DeployHistory, run: DeployRun, number: number) =>
  Effect.gen(function* () {
    const attempt = yield* history.attempt(run, number);
    if (Option.isNone(attempt)) return Option.none<DeployEvent>();
    const { startedAt, finishedAt, outcome } = attempt.value;
    const trigger = yield* Schema.decodeUnknownEffect(DeployTrigger)(run.event);
    const last = yield* lastDeployBefore(history, finishedAt);
    const commits = yield* deployedCommits(history.repository, last?.run.head_sha, run.head_sha);
    return Option.some(
      deployEvent({
        sha: run.head_sha,
        startedAt: DateTime.formatIso(startedAt),
        finishedAt: DateTime.formatIso(finishedAt),
        outcome,
        runId: run.id,
        runAttempt: number,
        runUrl: runAttemptUrl(history.repository, run.id, number),
        trigger,
        commits,
      }),
    );
  });
