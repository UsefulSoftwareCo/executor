/**
 * How one attempt of a Deploy run becomes a deploy event (`deploy-events.ts`), read from GitHub's
 * Actions API. The recorder (`scripts/deploy-event.ts`) and the backfill
 * (`scripts/deploy-events-backfill.ts`) both build every event with `deployEventOf`, so they give
 * the same event for the same run attempt.
 *
 * The event's window and outcome are its deploy step's own. Its commits are those after the commit
 * of the deploy before it (`lastDeployBefore`): the attempt, of any run, whose deploy step last
 * succeeded before this attempt's deploy step finished.
 */
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
/** The deploy step's names over the workflow's history, newest first. */
const deploySteps = ["Deploy analytics and the v2 stage", "Deploy the v2 stage"];
/**
 * GitHub reruns a run only within 30 days of its creation. A rerun can wait in the queue for up to a
 * day and the deploy job stops after 30 minutes, so every deploy step of a run finishes within 32
 * days of the run's creation.
 */
const rerunWindow = Duration.days(32);
/** GitHub lists at most 1,000 runs for a filtered query, so runs are read a week at a time. */
const listSpan = Duration.days(7);
const listLimit = 1000;

/** Reads one GitHub REST resource with `GITHUB_TOKEN`. */
export const githubGet = <S extends Schema.Top>(schema: S, path: string) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("GITHUB_TOKEN");
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(`https://api.github.com/${path}`).pipe(
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
  /** The latest attempt. */
  run_attempt: Schema.Number,
  event: Schema.String,
  head_sha: Schema.String,
  created_at: Schema.DateTimeUtcFromString,
  /** Changes whenever an attempt starts or finishes. */
  updated_at: Schema.DateTimeUtcFromString,
});
/** A run of the Deploy workflow on `main`. */
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

/** The span `listSpan` long that holds `time`. Spans are fixed, so every reader lists the same ones. */
export const listSpanOf = (time: DateTime.Utc) => {
  const span = Duration.toMillis(listSpan);
  return DateTime.makeUnsafe(Math.floor(DateTime.toEpochMillis(time) / span) * span);
};
/** The spans from the one that holds `from` to the one that holds `to`. */
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

/** GitHub's search syntax takes whole seconds. */
const searchTime = (time: DateTime.Utc) => DateTime.formatIso(time).replace(/\.\d{3}Z$/u, "Z");

/** Every Deploy run on `main` created in the span that starts at `start`. */
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
      // A run created while this reads moves the pages down; the map drops the repeat.
      for (const run of workflow_runs) runs.set(run.id, run);
      if (workflow_runs.length < 100) return [...runs.values()];
    }
  });

/** What one attempt's deploy step did. */
interface DeployStep {
  readonly startedAt: DateTime.Utc;
  readonly finishedAt: DateTime.Utc;
  readonly outcome: DeployOutcome;
}

/** One attempt of a Deploy run that reached its deploy step. */
export interface DeployAttempt extends DeployStep {
  readonly run: DeployRun;
  readonly number: number;
}

/**
 * The deploy step of one run attempt, or nothing when the attempt has none of its own: the run was
 * cancelled before its job started, or the step has not finished.
 */
const readDeployStep = (repository: string, runId: number, number: number) =>
  Effect.gen(function* () {
    const { jobs } = yield* githubGet(
      Jobs,
      `repos/${repository}/actions/runs/${runId}/attempts/${number}/jobs?per_page=100`,
    );
    const job = jobs.find((candidate) => candidate.name === deployJob);
    if (job === undefined) return Option.none<DeployStep>();
    // Rerunning failed jobs copies the others into the new attempt with their old steps. Such a job
    // started before it was created, and deployed nothing in this attempt.
    if (job.started_at !== null && DateTime.isLessThan(job.started_at, job.created_at))
      return Option.none<DeployStep>();
    // A job skipped or cancelled before it ran any step (a failed dependency, a newer push) has no
    // steps and deployed nothing.
    if ((job.steps ?? []).length === 0) return Option.none<DeployStep>();
    const step = job.steps?.find((candidate) => deploySteps.includes(candidate.name));
    // A job that ran without a step of a known name means the step was renamed: fail loudly, so the
    // recorder does not pass while recording nothing for every deploy.
    if (step === undefined && job.conclusion !== null)
      return yield* Effect.die(
        `Run ${runId} attempt ${number}: the ${deployJob} job has no step named ${deploySteps.join(" or ")}; add its new name to deploySteps`,
      );
    if (step === undefined || step.status !== "completed") return Option.none<DeployStep>();
    if (step.started_at === null || step.completed_at === null)
      return yield* Effect.die(`Run ${runId} attempt ${number}: the deploy step has no times`);
    // A skipped deploy step, as when the build failed first, leaves an empty window and takes the
    // job's outcome, which exists once the job finishes.
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

/** The Deploy workflow's runs and attempts, each read from GitHub once. */
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
    return {
      repository,
      /** When the Deploy workflow was created; no run is older. */
      since: workflow.created_at,
      /** The runs created in the span that starts at `start` (`listSpanOf`). */
      runsCreatedIn: (start: DateTime.Utc) => Cache.get(spans, DateTime.toEpochMillis(start)),
      attempt: (run: DeployRun, number: number) =>
        Cache.get(steps, [run.id, number] as const).pipe(
          Effect.map(Option.map((step): DeployAttempt => ({ ...step, run, number }))),
        ),
      run: (runId: number) => githubGet(DeployRun, `repos/${repository}/actions/runs/${runId}`),
    };
  });
export type DeployHistory = Effect.Success<ReturnType<typeof makeDeployHistory>>;

/**
 * The deploy production ran before `before`: of every attempt of every run, the one whose deploy
 * step succeeded last before then, by when the step finished. That counts earlier attempts of the
 * same run, and a rerun of an older run that finished after a newer run's deploy.
 */
export const lastDeployBefore = (history: DeployHistory, before: DateTime.Utc) =>
  Effect.gen(function* () {
    let last: DeployAttempt | undefined;
    for (let start = listSpanOf(before); ; start = DateTime.subtractDuration(start, listSpan)) {
      const end = DateTime.addDuration(start, listSpan);
      // Runs created before `end` finished every step before `end` plus the rerun window.
      if (
        last !== undefined &&
        DateTime.isLessThanOrEqualTo(DateTime.addDuration(end, rerunWindow), last.finishedAt)
      )
        return last;
      if (DateTime.isLessThanOrEqualTo(end, history.since)) return last;
      // A step that finished before `before` belongs to a run created before it. A run's
      // `updated_at` is no earlier than any of its steps, so runs updated before `last` cannot beat it.
      const runs = (yield* history.runsCreatedIn(start))
        .filter((run) => DateTime.isLessThan(run.created_at, before))
        .toSorted((a, b) => DateTime.Order(b.updated_at, a.updated_at));
      for (const run of runs) {
        if (last !== undefined && DateTime.isLessThanOrEqualTo(run.updated_at, last.finishedAt))
          break;
        // A run's attempts run one after another, so the latest that qualifies is its best.
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

/** A commit as GitHub's REST API returns it, on its own or in a comparison. */
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

/**
 * What a deploy of `sha` ships after production ran `base`: the commits after `base` up to `sha`,
 * oldest first. It is the deployed commit alone when there is no `base`, when `base` is `sha`, or
 * when `sha` does not follow `base`, as when an older run is rerun.
 */
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

/** The event of one attempt of a Deploy run, or nothing when the attempt has no deploy step. */
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
