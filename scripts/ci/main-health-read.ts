/**
 * Main health's reads: every answer it takes from GitHub, decoded at the boundary. Each answer is
 * decoded through a schema that names exactly the fields the code uses, with their types and the
 * values GitHub documents for them; a value outside them (a missing field, a wrong type, an enum
 * value GitHub does not list, a run of another workflow, branch or event, a timestamp GitHub
 * stamped more than `skew` in the future, a held beta's `since` more than `sinceSkew` in the
 * future) fails the read. So does a list whose pages disagree with the count GitHub gives for it,
 * that holds an item twice, or whose runs are out of order, and a GraphQL answer that carries
 * `errors`. A failed read is `ReadFailed`: the run stops before its first write, so no
 * answer that is partial or malformed can read as nothing being wrong.
 *
 * Every request goes through `gh api`, one at a time, in the order the facts need them.
 */
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  clean,
  logsRead,
  stripControls,
  type BetaFact,
  type Commits,
  type FailedJob,
  type RunRef,
  type WorkflowFact,
} from "./main-health-decide.ts";

export class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", {
  message: Schema.String,
}) {}

/** A workflow whose runs decide a source: CI on main, or the Windows check. */
export interface Source {
  readonly workflow: string;
  readonly branch: string;
  readonly event: string;
  /** The run title that counts, when other runs share the workflow, branch and event. */
  readonly title?: string;
}

export interface Settings {
  /** `OWNER/NAME`. */
  readonly repository: string;
  /** `https://github.com`. */
  readonly server: string;
  readonly label: string;
  readonly marker: string;
  readonly ci: Source;
  readonly windows: Source;
  readonly beta: {
    readonly workflow: string;
    readonly branch: string;
    readonly artifact: string;
    /** The events Beta runs on (beta.yml's `on`): only a run for one of them uploads a decision. */
    readonly events: ReadonlyArray<string>;
  };
  /** Milliseconds since the epoch, read once for the whole run. */
  readonly now: number;
  /** A scratch directory of this run's own. */
  readonly temp: string;
}

/** How far back a red source looks for the last green run, in pages of 100 runs. */
const historyPages = 5;
/** How old a Beta decision may be and still count: a day less than beta.yml keeps the artifact. */
const betaWindow = 6 * 24 * 60 * 60 * 1000;
/** How far in the future a timestamp GitHub stamps may be, for clocks that differ a little. */
const skew = 5 * 60 * 1000;
/**
 * How far in the future a held beta's `since` may be: clock skew between the Beta runner that
 * computed it (from commit and npm publish times, all in its past) and the runner reading it, and
 * nothing more. Hosted runners keep their clocks synchronised to well under a second, so a minute
 * is ample for skew; a `since` further ahead was never a time in Beta's past, and fails the read.
 */
const sinceSkew = 60 * 1000;
const perPage = 100;
const stays = "The issue stays as it is until a run reads it.";

const failed = (message: string) => Effect.fail(new ReadFailed({ message }));

// Values as GitHub documents them (REST "Workflow runs" and "Workflow jobs"). startup_failure is
// a run conclusion GitHub gives a run whose workflow could not start.
const RunStatus = Schema.Literals([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
const RunConclusion = Schema.Literals([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);
const JobConclusion = Schema.Literals([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
]);
const ActorType = Schema.Literals([
  "User",
  "Bot",
  "Organization",
  "Mannequin",
  "EnterpriseUserAccount",
]);
const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

/** The schemas of every answer, with what this run expects: its repository, sources and clock. */
const schemas = (settings: Settings) => {
  const repository = `${settings.server}/${settings.repository}`;
  /** A time no later than now and `allowed`, for clocks that differ a little. */
  const Time = (allowed: number) =>
    Schema.String.check(
      Schema.isPattern(iso),
      Schema.makeFilter((value: string) =>
        Number.isNaN(Date.parse(value))
          ? `${value} is not a time`
          : Date.parse(value) <= settings.now + allowed || `${value} is in the future`,
      ),
    );
  /** A time GitHub stamped, no later than now and `skew`. */
  const Stamp = Time(skew);
  const Run = (source: Source) =>
    Schema.Struct({
      id: Id,
      path: Schema.Literal(`.github/workflows/${source.workflow}`),
      event: Schema.Literal(source.event),
      head_branch: Schema.Literal(source.branch),
      status: RunStatus,
      conclusion: Schema.NullOr(RunConclusion),
      run_attempt: Id,
      created_at: Stamp,
      head_sha: Sha,
      html_url: Schema.String,
      display_title: Schema.String,
    }).check(
      Schema.makeFilter(
        (run) =>
          (run.status === "completed") === (run.conclusion !== null) ||
          `run ${run.id} is ${run.status} with conclusion ${run.conclusion}`,
      ),
      Schema.makeFilter(
        (run) =>
          run.html_url === `${repository}/actions/runs/${run.id}` ||
          `run ${run.id} names ${run.html_url} as its page`,
      ),
    );
  return {
    RunsPage: (source: Source) =>
      Schema.Struct({ total_count: Count, workflow_runs: Schema.Array(Run(source)) }),
    Attempt: (run: number, attempt: number) =>
      Schema.Struct({
        id: Schema.Literal(run),
        run_attempt: Schema.Literal(attempt),
        status: Schema.Literal("completed"),
        conclusion: RunConclusion,
      }),
    JobsPage: (run: number) =>
      Schema.Struct({
        total_count: Count,
        jobs: Schema.Array(
          Schema.Struct({
            id: Id,
            name: Schema.String,
            html_url: Schema.String,
            status: RunStatus,
            conclusion: Schema.NullOr(JobConclusion),
          }).check(
            Schema.makeFilter(
              (job) =>
                (job.status === "completed") === (job.conclusion !== null) ||
                `job ${job.id} is ${job.status} with conclusion ${job.conclusion}`,
            ),
            Schema.makeFilter(
              (job) =>
                job.html_url === `${repository}/actions/runs/${run}/job/${job.id}` ||
                `job ${job.id} names ${job.html_url} as its page`,
            ),
          ),
        ),
      }),
    Compare: Schema.Struct({
      total_commits: Count,
      commits: Schema.Array(
        Schema.Struct({ sha: Sha, commit: Schema.Struct({ message: Schema.String }) }),
      ),
    }).check(
      Schema.makeFilter(
        (compare) =>
          compare.commits.length === Math.min(compare.total_commits, 50) ||
          `${compare.commits.length} commits listed of ${compare.total_commits}`,
      ),
      Schema.makeFilter(
        (compare) =>
          new Set(compare.commits.map((commit) => commit.sha)).size === compare.commits.length ||
          "a commit is listed twice",
      ),
    ),
    ArtifactsPage: Schema.Struct({
      total_count: Count,
      artifacts: Schema.Array(
        Schema.Struct({
          id: Id,
          name: Schema.Literal(settings.beta.artifact),
          expired: Schema.Boolean,
          created_at: Stamp,
          workflow_run: Schema.Struct({
            id: Id,
            repository_id: Id,
            head_repository_id: Id,
            head_branch: Schema.String,
          }),
        }),
      ),
    }),
    /** The run that uploaded the newest decision: a Beta run on Beta's branch, for one of its events. */
    Producer: (run: number) =>
      Schema.Struct({
        id: Schema.Literal(run),
        path: Schema.Literal(`.github/workflows/${settings.beta.workflow}`),
        event: Schema.Literals(settings.beta.events),
        head_branch: Schema.Literal(settings.beta.branch),
        status: RunStatus,
      }),
    /** Exactly what beta.yml's "Record the held beta decision" step writes; decoded with no field more. */
    Decision: Schema.Struct({
      state: Schema.Literals(["held", "clear"]),
      reason: Schema.String,
      // When the beta became due: empty when that could not be read. Never in the future, beyond
      // `sinceSkew` (a minute) for the two runners' clocks; anything later fails the read.
      since: Schema.Union([Schema.Literal(""), Time(sinceSkew)]),
      run: Schema.String.check(
        Schema.isPattern(new RegExp(`^${escaped(repository)}/actions/runs/[0-9]+$`, "u")),
      ),
    }),
    /** A page of the open issues with the label. An answer that carries `errors` is refused, even an empty list. */
    IssuesPage: Schema.Struct({
      errors: Schema.optionalKey(Schema.Never),
      data: Schema.Struct({
        repository: Schema.Struct({
          issues: Schema.Struct({
            totalCount: Count,
            pageInfo: Schema.Struct({
              hasNextPage: Schema.Boolean,
              endCursor: Schema.NullOr(Schema.String),
            }),
            nodes: Schema.Array(
              Schema.Struct({
                number: Id,
                title: Schema.String,
                body: Schema.String,
                author: Schema.NullOr(
                  Schema.Struct({ __typename: ActorType, login: Schema.String }),
                ),
                labels: Schema.Struct({
                  totalCount: Count,
                  nodes: Schema.Array(Schema.Struct({ name: Schema.String })),
                }),
              }).check(
                Schema.makeFilter(
                  (issue) =>
                    new Set(issue.labels.nodes.map((label) => label.name)).size ===
                      issue.labels.nodes.length || `#${issue.number} lists a label twice`,
                ),
                Schema.makeFilter(
                  (issue) =>
                    issue.labels.nodes.length === issue.labels.totalCount ||
                    `#${issue.number} lists ${issue.labels.nodes.length} of its ${issue.labels.totalCount} labels`,
                ),
              ),
            ),
          }),
        }),
      }),
    }),
    Label: Schema.Struct({ name: Schema.Literal(settings.label) }),
  };
};

/** Runs `gh` with ARGS: its output as bytes, its error output and exit code. */
const gh = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("gh", args, { stdout: "pipe", stderr: "pipe" }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkUint8Array(child.stdout),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr: stderr.trim(), exitCode: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new ReadFailed({ message: `gh could not run: ${error.message}` })),
  );

/** The HTTP status of a failed `gh api`, when it names one. */
const statusOf = (stderr: string) => Number(/\(HTTP (\d{3})\)/u.exec(stderr)?.[1] ?? 0);

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** One answer of `gh api ARGS`, or a failed read. */
const answer = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* gh(["api", ...args]);
    if (result.exitCode !== 0)
      return yield* failed(`gh api ${args.join(" ")} failed: ${result.stderr}. ${stays}`);
    return result.stdout;
  });

/** ANSWER as SCHEMA, or a failed read naming WHAT. */
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  bytes: Uint8Array,
  what: string,
  options?: { readonly onExcessProperty: "error" },
) =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(schema),
    options,
  )(text(bytes)).pipe(
    Effect.mapError(
      (error) =>
        new ReadFailed({
          message: `${what} is not an answer this script reads: ${error.message}. ${stays}`,
        }),
    ),
  );

/**
 * Checks page PAGE of a list against its count: the same count as every earlier page (`total`,
 * undefined on the first), exactly the items the count leaves for this page, and no item an
 * earlier page or this one already held. A page cut short or shifted by a change between two reads
 * would otherwise read as a list with nothing wrong in it.
 */
const checkPage = (
  what: string,
  page: number,
  count: number,
  total: number | undefined,
  ids: ReadonlyArray<number>,
  seen: Set<number>,
) =>
  Effect.gen(function* () {
    const expected = Math.max(Math.min(count - (page - 1) * perPage, perPage), 0);
    if ((total !== undefined && count !== total) || ids.length !== expected)
      return yield* failed(
        `Page ${page} of ${what} does not hold what its count says: ${JSON.stringify({ total_count: count, earlier: total ?? null, items: ids.length })}. The issue stays as it is until a run reads it whole.`,
      );
    for (const id of ids) {
      if (seen.has(id))
        return yield* failed(
          `Page ${page} of ${what} holds item ${id} twice, or an earlier page held it, so the list moved while it was read. The issue stays as it is until a run reads it whole.`,
        );
      seen.add(id);
    }
    return count;
  });

/** Every item of a REST list read to its end, each page checked against its count. */
const readAll = <I extends { readonly id: number }>(
  path: string,
  page: (
    bytes: Uint8Array,
    what: string,
  ) => Effect.Effect<{ readonly count: number; readonly items: ReadonlyArray<I> }, ReadFailed>,
) =>
  Effect.gen(function* () {
    const items: Array<I> = [];
    const seen = new Set<number>();
    let total: number | undefined;
    for (let number = 1; ; number++) {
      const what = `Page ${number} of ${path}`;
      const read = yield* page(
        yield* answer([
          `${path}${path.includes("?") ? "&" : "?"}per_page=${perPage}&page=${number}`,
        ]),
        what,
      );
      total = yield* checkPage(
        path,
        number,
        read.count,
        total,
        read.items.map((item) => item.id),
        seen,
      );
      items.push(...read.items);
      if (number * perPage >= total) return items;
    }
  });

/** A run that counts, with the attempt that decides it and how that attempt ended. */
interface Decided extends RunRef {
  readonly createdAt: number;
  readonly attempt: number;
  readonly conclusion: string;
}

/** A cancelled or skipped attempt is no result. */
const isVoid = (conclusion: string) => conclusion === "cancelled" || conclusion === "skipped";

/**
 * The one order runs are ranked in: newer `created_at` first, then the higher id first among runs
 * created at the same time. GitHub lists a workflow's runs newest first, which the reader checks
 * (a run listed after an older one is a failed read), but promises no order among runs that share
 * a timestamp, and those can fall either side of a page's end. So the id half of the key is never
 * read from the order GitHub serves: it is applied only by sorting, and only to runs whose whole
 * timestamp has been read (see `workflow`), so what is decided does not depend on that order.
 */
const byTime = (a: { readonly createdAt: number }, b: { readonly createdAt: number }) =>
  b.createdAt - a.createdAt;
const newestFirst = (a: Decided, b: Decided) => byTime(a, b) || b.id - a.id;

export const reads = (settings: Settings) => {
  const S = schemas(settings);
  const repo = `repos/${settings.repository}`;

  /**
   * The attempt of a listed run that counts, or undefined when the run counts for nothing. Take the
   * run's latest completed attempt; a later attempt still running does not count yet.
   *
   * - It succeeded: green. It failed (any conclusion but success, cancelled or skipped): red.
   * - It was cancelled or skipped: that is no result on its own, and it never hides an earlier
   *   failure. The latest attempt before it that was neither decides only if it failed. If it
   *   succeeded, or every attempt was cancelled or skipped, the run counts for nothing: it is not
   *   green, since its latest completed attempt did not succeed, and older runs decide.
   * - No attempt has completed (a first attempt still running): nothing.
   *
   * So for a run of two attempts:
   *
   *   attempt 1   attempt 2   counts as
   *   success     running     green, attempt 1
   *   success     success     green, attempt 2
   *   success     failed      red, attempt 2
   *   success     cancelled   nothing
   *   failed      running     red, attempt 1
   *   failed      success     green, attempt 2
   *   failed      failed      red, attempt 2
   *   failed      cancelled   red, attempt 1
   *   cancelled   running     nothing
   *   cancelled   success     green, attempt 2
   *   cancelled   failed      red, attempt 2
   *   cancelled   cancelled   nothing
   *   running     (none)      nothing
   *
   * Earlier attempts are read one by one (runs/ID/attempts/N), newest first, only as far as the
   * rule needs; each must be that run's attempt, completed, with a conclusion.
   */
  const decidingAttempt = (run: {
    readonly id: number;
    readonly status: string;
    readonly conclusion: string | null;
    readonly run_attempt: number;
    readonly created_at: string;
    readonly head_sha: string;
    readonly html_url: string;
  }) =>
    Effect.gen(function* () {
      const decided = (attempt: number, conclusion: string): Decided => ({
        id: run.id,
        url: run.html_url,
        sha: run.head_sha,
        createdAt: Date.parse(run.created_at),
        attempt,
        conclusion,
      });
      let hidden = false;
      if (run.status === "completed" && run.conclusion !== null) {
        if (!isVoid(run.conclusion)) return decided(run.run_attempt, run.conclusion);
        hidden = true;
      }
      for (let attempt = run.run_attempt - 1; attempt >= 1; attempt--) {
        const earlier = yield* decode(
          S.Attempt(run.id, attempt),
          yield* answer([`${repo}/actions/runs/${run.id}/attempts/${attempt}`]),
          `Attempt ${attempt} of run ${run.id}`,
        );
        if (isVoid(earlier.conclusion)) {
          hidden = true;
          continue;
        }
        if (hidden && earlier.conclusion === "success") return undefined;
        return decided(attempt, earlier.conclusion);
      }
      return undefined;
    });

  /**
   * A red run's failed jobs, by job id. The first `logsRead` have the scenarios their logs list in
   * Vitest's summary or, for a job stopped before it, its live reporter. A log GitHub no longer has
   * (404 or 410) is said to be gone; any other failure to read one fails the read.
   */
  const failedJobs = (run: Decided) =>
    Effect.gen(function* () {
      const jobs = yield* readAll(
        `${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs`,
        (bytes, what) =>
          decode(S.JobsPage(run.id), bytes, what).pipe(
            Effect.map((page) => ({ count: page.total_count, items: page.jobs })),
          ),
      );
      const out: Array<FailedJob> = [];
      for (const job of [...jobs]
        .sort((a, b) => a.id - b.id)
        .filter((each) => each.conclusion === "failure" || each.conclusion === "timed_out")) {
        const name = clean(job.name);
        if (out.length >= logsRead) {
          out.push({ name, url: job.html_url, log: "unread", scenarios: [] });
          continue;
        }
        // gh prints no response that holds terminal escape sequences unless told to, and a job's
        // log holds its colored output.
        const result = yield* gh([
          "api",
          "--allow-escape-sequences",
          `${repo}/actions/jobs/${job.id}/logs`,
        ]);
        if (result.exitCode !== 0) {
          if ([404, 410].includes(statusOf(result.stderr))) {
            out.push({ name, url: job.html_url, log: "gone", scenarios: [] });
            continue;
          }
          return yield* failed(
            `${result.stderr}\nThe log of ${job.html_url} could not be read, so the issue stays as it is until a run can read it.`,
          );
        }
        out.push({ name, url: job.html_url, log: "read", scenarios: scenarios(result.stdout) });
      }
      return out;
    });

  /**
   * The commits from the last green run to the first red one: GitHub says how many there are, and
   * the first 50 are listed. Commits GitHub cannot compare (404) are said to be gone.
   */
  const commits = (green: RunRef, first: RunRef) =>
    Effect.gen(function* () {
      const path = `${repo}/compare/${green.sha}...${first.sha}?per_page=50&page=1`;
      const result = yield* gh(["api", path]);
      if (result.exitCode !== 0) {
        if (statusOf(result.stderr) === 404)
          return { gone: true, total: 0, commits: [] } satisfies Commits;
        return yield* failed(`gh api ${path} failed: ${result.stderr}. ${stays}`);
      }
      const compare = yield* decode(
        S.Compare,
        result.stdout,
        `The compare of ${green.sha}...${first.sha}`,
      );
      return {
        gone: false,
        total: compare.total_commits,
        commits: compare.commits.map((commit) => ({
          sha: commit.sha.slice(0, 9),
          subject: commit.commit.message.split("\n")[0]!,
        })),
      } satisfies Commits;
    });

  /**
   * A workflow's fact, from its runs: read a page at a time, newest first, each page checked and
   * each run decoded, until the newest run that counts decides: green at once, red once the last
   * green run before it is read, the list ends or `historyPages` pages are read. Unknown only when
   * the whole list was read and no run counts; `historyPages` pages without one is a failed read,
   * since what the runs past them say is not known.
   *
   * A decision rests on one run: the green run, for green and for red's last green (or the newest
   * red run, while no green one is read). It stands only once every run created at that run's
   * time has been read, since one of them, with a higher id, ranks above it (`newestFirst`): so
   * while that run's time is the time of the last run listed so far, cancelled and other runs
   * included, the next page is read, until a run older than it is listed or the list ends. A tie
   * still not read whole after `historyPages` pages is a failed read.
   */
  const workflow = (source: Source) =>
    Effect.gen(function* () {
      const path = `${repo}/actions/workflows/${source.workflow}/runs?branch=${source.branch}&event=${source.event}`;
      const decided: Array<Decided> = [];
      const seen = new Set<number>();
      let total: number | undefined;
      let previous: number | undefined;
      /** What the runs read so far decide, and the run that decision rests on. */
      const latest = (): {
        readonly health: "none" | "green" | "red" | "open";
        readonly rests?: Decided;
      } => {
        const sorted = [...decided].sort(newestFirst);
        const newest = sorted[0];
        if (newest === undefined) return { health: "none" };
        if (newest.conclusion === "success") return { health: "green", rests: newest };
        const green = sorted.find((run) => run.conclusion === "success");
        return green === undefined
          ? { health: "open", rests: newest }
          : { health: "red", rests: green };
      };
      for (let page = 1; ; page++) {
        const runs = yield* decode(
          S.RunsPage(source),
          yield* answer([`${path}&per_page=${perPage}&page=${page}`]),
          `Page ${page} of ${path}`,
        );
        total = yield* checkPage(
          path,
          page,
          runs.total_count,
          total,
          runs.workflow_runs.map((run) => run.id),
          seen,
        );
        for (const run of runs.workflow_runs) {
          const created = Date.parse(run.created_at);
          if (previous !== undefined && byTime({ createdAt: previous }, { createdAt: created }) > 0)
            return yield* failed(
              `Page ${page} of ${path} lists run ${run.id} after an older one, so the list is not newest first. ${stays}`,
            );
          previous = created;
        }
        for (const run of runs.workflow_runs) {
          if (source.title !== undefined && run.display_title !== source.title) continue;
          if (run.status !== "completed" && run.run_attempt === 1) continue;
          const counted = yield* decidingAttempt(run);
          if (counted !== undefined) decided.push(counted);
        }
        if (page * perPage >= total) break;
        const state = latest();
        // Every run listed later is no newer than the last one listed so far.
        const whole = state.rests !== undefined && state.rests.createdAt > previous!;
        if ((state.health === "green" || state.health === "red") && whole) break;
        if (page === historyPages) {
          if (state.health === "none")
            return yield* failed(
              `None of the newest ${page * perPage} runs at ${path} counts yet, so what that workflow says is not known. The issue stays as it is.`,
            );
          if (!whole)
            return yield* failed(
              `Run ${state.rests!.id} at ${path} decides, but runs created at its time continue past the ${page * perPage} runs read, and one of them may rank above it. The issue stays as it is.`,
            );
          break;
        }
      }
      const sorted = decided.sort(newestFirst);
      const newest = sorted[0];
      if (newest === undefined) return { health: "unknown" } satisfies WorkflowFact;
      if (newest.conclusion === "success")
        return { health: "good", latest: ref(newest) } satisfies WorkflowFact;
      const greenAt = sorted.findIndex((run) => run.conclusion === "success");
      const green = greenAt === -1 ? undefined : sorted[greenAt]!;
      const first = greenAt === -1 ? sorted.at(-1)! : sorted[greenAt - 1]!;
      const jobs = yield* failedJobs(newest);
      return {
        health: "bad",
        latest: ref(newest),
        first: ref(first),
        green: green === undefined ? undefined : ref(green),
        read: sorted.length,
        jobs,
        commits:
          green === undefined
            ? { gone: false, total: 0, commits: [] }
            : yield* commits(green, first),
      } satisfies WorkflowFact;
    });

  /**
   * The held beta: the decision in the newest artifact named `beta.artifact` that a run on Beta's
   * branch in this repository uploaded in the last `betaWindow`, or unknown when there is none.
   * Artifacts of other branches or of forks are not Beta's decisions and are passed over. The
   * newest one must be readable: expired, from another workflow or event, not downloadable, or
   * holding anything but one decision as beta.yml writes it is a failed read, and an older
   * decision never stands in for it.
   */
  const beta = Effect.gen(function* () {
    const path = `${repo}/actions/artifacts?name=${settings.beta.artifact}`;
    const artifacts = yield* readAll(path, (bytes, what) =>
      decode(S.ArtifactsPage, bytes, what).pipe(
        Effect.map((page) => ({ count: page.total_count, items: page.artifacts })),
      ),
    );
    const beta = artifacts
      .filter(
        (artifact) =>
          artifact.workflow_run.head_branch === settings.beta.branch &&
          artifact.workflow_run.head_repository_id === artifact.workflow_run.repository_id,
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    const counted = beta.filter(
      (artifact) => settings.now - Date.parse(artifact.created_at) <= betaWindow,
    );
    const newest = counted.at(-1);
    if (newest === undefined) {
      const old = beta.at(-1);
      return {
        health: "unknown",
        newest:
          old === undefined ? undefined : { createdAt: old.created_at, run: old.workflow_run.id },
      } satisfies BetaFact;
    }
    if (newest.expired)
      return yield* failed(
        `The newest ${settings.beta.artifact} artifact, ${newest.id} from ${newest.created_at}, has expired, so Beta's latest decision cannot be read; an older one does not stand in for it. The issue stays as it is.`,
      );
    yield* decode(
      S.Producer(newest.workflow_run.id),
      yield* answer([`${repo}/actions/runs/${newest.workflow_run.id}`]),
      `Run ${newest.workflow_run.id}, which uploaded artifact ${newest.id} (only ${settings.beta.workflow} on ${settings.beta.branch} uploads it),`,
    );
    // gh refuses to print a response holding an escape byte unless told to, and a zip's bytes can.
    const zip = yield* answer([
      "--allow-escape-sequences",
      `${repo}/actions/artifacts/${newest.id}/zip`,
    ]);
    const decision = yield* decode(
      S.Decision,
      yield* unzipped(zip, `${settings.beta.artifact}.json`, newest.id),
      `Artifact ${newest.id}, which does not hold one decision as ${settings.beta.workflow} writes it,`,
      { onExcessProperty: "error" },
    );
    return decision.state === "held"
      ? ({
          health: "bad",
          reason: decision.reason,
          since: decision.since,
          run: decision.run,
        } satisfies BetaFact)
      : ({ health: "good", run: decision.run } satisfies BetaFact);
  });

  /** The one file NAME of a zip, or a failed read when it holds anything else. */
  const unzipped = (zip: Uint8Array, name: string, id: number) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${settings.temp}/artifact-${id}.zip`;
      yield* fs
        .writeFile(file, zip)
        .pipe(Effect.mapError((error) => new ReadFailed({ message: error.message })));
      const unzip = (args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* processes.spawn(
            ChildProcess.make("unzip", args, { stdout: "pipe", stderr: "pipe" }),
          );
          const [stdout, exitCode] = yield* Effect.all(
            [Stream.mkUint8Array(child.stdout), child.exitCode],
            {
              concurrency: "unbounded",
            },
          );
          return { stdout, exitCode: Number(exitCode) };
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            (error) => new ReadFailed({ message: `unzip could not run: ${error.message}` }),
          ),
        );
      const listed = yield* unzip(["-Z1", file]);
      if (listed.exitCode !== 0 || text(listed.stdout).trim() !== name)
        return yield* failed(`Artifact ${id} holds other than the one file ${name}. ${stays}`);
      const content = yield* unzip(["-p", file, name]);
      if (content.exitCode !== 0)
        return yield* failed(`Artifact ${id}'s ${name} could not be read. ${stays}`);
      return content.stdout;
    });

  /**
   * The open issues that are this script's, lowest number first: the label, opened by the
   * github-actions app's bot (GraphQL names it `github-actions`, of type Bot), and the marker in the
   * body. Read through GraphQL, whose issue list says how many issues match (REST's does not), 100 a
   * page: every page must report the same count and hold exactly what it leaves for that page, say
   * whether another follows as the count does, and hold no issue twice.
   */
  const owned = Effect.gen(function* () {
    const query = `query($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, states: OPEN, labels: [$label], orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { number title body author { __typename login } labels(first: 100) { totalCount nodes { name } } }
    }
  }
}`;
    const [owner, name] = settings.repository.split("/") as [string, string];
    const issues: Array<{
      readonly number: number;
      readonly title: string;
      readonly body: string;
      readonly bot: boolean;
      readonly labelled: boolean;
    }> = [];
    const seen = new Set<number>();
    let total: number | undefined;
    let after: string | undefined;
    for (let page = 1; ; page++) {
      const what = `Page ${page} of the open issues labelled ${settings.label}`;
      const read = (yield* decode(
        S.IssuesPage,
        yield* answer([
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-f",
          `label=${settings.label}`,
          ...(after === undefined ? [] : ["-f", `after=${after}`]),
        ]),
        what,
      )).data.repository.issues;
      const before = issues.length;
      total = yield* checkPage(
        `the open issues labelled ${settings.label}`,
        page,
        read.totalCount,
        total,
        read.nodes.map((issue) => issue.number),
        seen,
      );
      const more = before + read.nodes.length < total;
      if (read.pageInfo.hasNextPage !== more || (more && read.pageInfo.endCursor === null))
        return yield* failed(
          `${what} says ${read.pageInfo.hasNextPage ? "more" : "no more"} follow, where its count says otherwise. ${stays}`,
        );
      for (const issue of read.nodes)
        issues.push({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          bot: issue.author?.__typename === "Bot" && issue.author.login === "github-actions",
          labelled: issue.labels.nodes.some((label) => label.name === settings.label),
        });
      if (!more) break;
      after = read.pageInfo.endCursor!;
    }
    return issues
      .filter((issue) => issue.bot && issue.labelled && issue.body.includes(settings.marker))
      .sort((a, b) => a.number - b.number)
      .map(({ number, title, body }) => ({ number, title, body }));
  });

  /** Whether the label exists: only a 404 means it does not. */
  const labelExists = Effect.gen(function* () {
    const result = yield* gh(["api", `${repo}/labels/${settings.label}`]);
    if (result.exitCode !== 0) {
      if (statusOf(result.stderr) === 404) return false;
      return yield* failed(
        `gh api ${repo}/labels/${settings.label} failed: ${result.stderr}. Nothing was written.`,
      );
    }
    yield* decode(S.Label, result.stdout, `The label ${settings.label}`);
    return true;
  });

  return {
    ci: workflow(settings.ci),
    windows: workflow(settings.windows),
    beta,
    owned,
    labelExists,
  };
};

const ref = (run: Decided): RunRef => ({ id: run.id, url: run.url, sha: run.sha });

/**
 * The failed scenarios a job's log names, as Vitest's summary lists them (`FAIL  file > title`),
 * or for a job stopped before its summary, as its live reporter marked them (`× file > title`):
 * at most 20, each once, in order. Timestamps and terminal controls are gone from the text.
 */
const scenarios = (bytes: Uint8Array) => {
  const lines = stripControls(
    text(bytes)
      .split("\n")
      .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z ?/u, ""))
      .join("\n"),
  ).split("\n");
  const found = (marker: RegExp, strip: (line: string) => string) =>
    [...new Set(lines.filter((line) => marker.test(line)).map((line) => clean(strip(line))))]
      .sort()
      .slice(0, 20);
  const summary = found(/^\s*FAIL\s+.*\.(spec|test)\.[cm]?[jt]sx? > /u, (line) =>
    line.replace(/^\s*FAIL\s+/u, ""),
  );
  if (summary.length > 0) return summary;
  return found(/^\s*[×✗]\s+.*\.(spec|test)\.[cm]?[jt]sx? > /u, (line) =>
    line.replace(/^\s*[×✗]\s+/u, "").replace(/\s+[0-9]+ms$/u, ""),
  );
};
