/**
 * Decide whether `.github/workflows/beta.yml` publishes a beta on this tick. It runs on every push
 * to `main`, on a 30-minute schedule GitHub delivers hours late, and on manual dispatch, from a
 * full checkout of `main`. A push and a scheduled tick decide alike; only a manual dispatch skips
 * the six hours and the retry back-off.
 *
 * npm is the record of what was published: the release workflow publishes the launcher only after
 * the Docker manifest and the public GitHub release, so a version npm lists is out. The version in
 * `apps/cli/package.json` is the one being released, and its `Release <version>` commit on main
 * marks the commits it contains.
 *
 * - While any "Executor releases" dispatch is queued or running, nothing happens: a release takes
 *   longer than a tick, and two publishing runs must never overlap.
 * - When npm lists the committed version, a new beta is due once main has commits after its
 *   release commit and npm published it at least six hours ago (`bump`). A manual dispatch skips
 *   the six hours.
 * - When npm lacks it, the version is published again rather than skipped, at most five failed
 *   attempts a day: once five publishing attempts (re-runs included) failed in the last 24 hours,
 *   no tick dispatches or re-runs another, a manual dispatch included. Attempts are selected by
 *   when they ran: the release runs created within GitHub's 30-day re-run window, and the
 *   attempts of each that ran in the last day, in at most ten requests a tick; when those cannot
 *   tell, it holds. An attempt that failed in a step that publishes
 *   anything (each step declares it, scripts/releases/publishing-steps.ts: the publish job, the
 *   image's architecture tags, the Bun runtime's release, and any failed job or step that cannot
 *   be told apart) may already
 *   have left something public for its source, so that run's failed jobs are re-run once from its
 *   own artifacts (`rerun`); after that, publication needs inspection (RELEASING.md). An attempt
 *   that failed before publishing is dispatched again on the next tick (`dispatch`). After two
 *   failures in a row, automatic ticks wait six hours since the last attempt, and until main has
 *   moved past it or a day has passed, unless CI passed on a main commit after the last
 *   attempt's: a failure in a test, fixed by a merge, is retried as soon as main is green again.
 *   A manual dispatch skips the back-off. Beta also ticks when CI finishes on a push to main, so
 *   a green main is seen at once.
 * - An attempt for the committed version that succeeded while npm still lacks it fails the tick:
 *   another run would succeed the same way, on every tick, with nothing red.
 *
 * - Neither a new beta (`bump`) nor another attempt (`dispatch`) starts while main's release
 *   matrix is red. The matrix runs are the checks, the repository dispatches of Executor releases
 *   that the Release check workflow starts after a push that changed what a release lane builds or
 *   runs, paced to one build every two hours, and the builds dispatched from main by hand. The
 *   newest finished one must have passed its `releases` job, which judges the matrix jobs alone. A
 *   run that tested nothing is skipped: a cancelled one, as a check that gave way to a newer one
 *   is, and a check whose `pace` job did not pass or whose matrix did not run. A failed one holds
 *   every beta until a later run passes, and when none has finished, betas hold until one does. A
 *   run still pacing or building holds nothing: the publishing run tests every platform on the
 *   commit it publishes, the checks' Linux x64 and image jobs among them, and publishes only when
 *   all of them pass. Checks list apart from builds and publications, so however many there are,
 *   they never push the publishing attempts out of the list the decision reads.
 *
 * Attempts are publishing runs only. A dispatch with channel `build` builds and tests without
 * publishing, so it neither counts as a failure nor as a success. It still blocks the tick while it
 * runs, since two release runs on main must not overlap.
 *
 * Writes `decision` (`none`, `bump`, `dispatch` or `rerun`), `version` and `run` to
 * `GITHUB_OUTPUT`, and `held` with `held_since` for Main health (scripts/ci/main-health.ts):
 *
 * - `held` when a hold (a skip with a warning) has kept a due beta back for more than `heldFor`,
 *   or at once when the daily bound on failed attempts holds it. `held_since` is when the beta
 *   became due, from what the tick already reads: the `Release <version>` commit while npm lacks
 *   the committed version, else six hours after npm published it or the first commit after it,
 *   whichever is later; empty when git has no such commit, which shows the hold at once.
 * - `clear` when npm lists the committed version and nothing holds the next beta.
 * - empty otherwise, which leaves the issue as it is: a release run running (a build dispatched to
 *   clear a red matrix included, while the matrix goes unread), a retry dispatched, a shorter
 *   hold, or a re-run. A stuck release passes through those between its holds, and the issue must
 *   neither close nor open again on each. Reads npm with `npm view`, the release runs with `gh run list`, `gh run view`
 * and `gh api`, and the history with `git`, so `e2e/tests/beta-due.spec.ts` drives it with stubs. It
 * changes nothing itself: beta.yml acts on its decision.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Config, Console, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { publishingFailures, releaseWorkflow } from "./publishing-steps.ts";

const hour = 60 * 60 * 1000;
/** The least time between two published betas. */
const gap = 6 * hour;
/** After two failed attempts in a row, the least time before the next one. */
const backOff = 6 * hour;
/** After two failed attempts in a row, retry this long after the last one even if main is still. */
const stale = 24 * hour;
/** At most this many failed publishing attempts a day retry early, on a newer green main. */
const dailyAttempts = 5;
/**
 * How long a hold may keep a due beta back before the red-main issue shows it. A healthy release
 * goes out within about an hour of being due; two failures in a row wait six hours before the
 * next attempt, so a hold past that is one that no retry is about to end.
 */
const heldFor = 6 * hour;
/** How many builds and publications the gate reads (`gh run list -L`). */
const runLimit = 30;
/**
 * GitHub re-runs a run only within 30 days of its first attempt, so a run created longer ago than
 * that and a day has no attempt in the last day.
 */
const rerunWindow = 30 * 24 * hour;
/** Runs a page of the release workflow's runs holds when the count reads them. */
const pageSize = 100;
/**
 * The most requests one tick spends counting failed attempts: pages of runs and earlier attempts.
 * The last month of release runs is one page (63 on 18 Nov 2026), and five failures are known
 * after at most four attempt reads.
 */
const countRequests = 10;
/** The titles of publishing runs (release-artifacts.yml's `run-name` for each channel). */
const publishingTitles = ["Executor releases (beta)", "Executor releases (latest)"];

class BetaGateFailed extends Schema.TaggedError<BetaGateFailed>()("BetaGateFailed", {
  message: Schema.String,
}) {}

const Package = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const Registry = Schema.fromJsonString(
  Schema.Struct({
    time: Schema.Record(Schema.String, Schema.String),
    "dist-tags": Schema.Record(Schema.String, Schema.String),
  }),
);

const Run = Schema.Struct({
  databaseId: Schema.Number,
  status: Schema.String,
  conclusion: Schema.String,
  headSha: Schema.String,
  createdAt: Schema.String,
  attempt: Schema.Number,
  url: Schema.String,
  displayTitle: Schema.String,
});
type Run = typeof Run.Type;

/**
 * A page of the release workflow's runs, each with when its latest attempt started and was last
 * updated (GitHub's `run_started_at` and `updated_at`): a re-run keeps the run's `createdAt`, so
 * only these date it.
 */
const RunsPage = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      ...Run.fields,
      startedAt: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
);

/** When one attempt of a run started and was last updated, read from its attempt. */
const AttemptTimes = Schema.fromJsonString(
  Schema.Struct({ startedAt: Schema.String, updatedAt: Schema.String }),
);

const Step = Schema.Struct({ name: Schema.String, conclusion: Schema.String });

/** The title Executor releases gives a build dispatched by hand (its `run-name`). */
const buildTitle = "Executor releases (build)";

const Jobs = Schema.fromJsonString(
  Schema.Struct({
    jobs: Schema.Array(
      Schema.Struct({ name: Schema.String, conclusion: Schema.String, steps: Schema.Array(Step) }),
    ),
  }),
);
type Jobs = typeof Jobs.Type;

/**
 * The metadata step of `release-artifacts.yml` that runs only when the dispatch publishes. The
 * publish job cannot tell: it is skipped both for a `build` dispatch and when a build job failed.
 */
const publishingStep = "Check the apps release is published unchanged";

/** A completed publishing run and its jobs. */
interface Attempt {
  readonly run: Run;
  readonly jobs: Jobs;
}

interface Decision {
  readonly decision: "none" | "bump" | "dispatch" | "rerun";
  readonly reason: string;
  /** Skipped for a reason someone should see, such as a release that keeps failing. */
  readonly warning: boolean;
  /** Held by the daily bound on failed attempts, which the red-main issue shows at once. */
  readonly exhausted?: boolean;
  /** Waiting on a release run, so the tick read nothing that could clear a held beta. */
  readonly pending?: boolean;
  /** The run to re-run, for `rerun`. */
  readonly run?: Run;
}

const wait = (reason: string): Decision => ({ decision: "none", reason, warning: false });
const hold = (reason: string): Decision => ({ decision: "none", reason, warning: true });
const act = (decision: "bump" | "dispatch", reason: string): Decision => ({
  decision,
  reason,
  warning: false,
});

const command = (name: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(name, args, { stdout: "pipe", stderr: "pipe" }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: Number(exitCode) };
  }).pipe(Effect.scoped);

const succeed = (name: string, args: ReadonlyArray<string>) =>
  command(name, args).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new BetaGateFailed({
              message: `${name} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`,
            }),
          ),
    ),
  );

const ago = (milliseconds: number) =>
  `${Math.floor(milliseconds / hour)}h${String(Math.floor((milliseconds % hour) / 60_000)).padStart(2, "0")}m ago`;

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const output = yield* Config.String("GITHUB_OUTPUT");
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const event = yield* Config.String("GITHUB_EVENT_NAME");
    if (!["push", "schedule", "workflow_dispatch", "workflow_run"].includes(event))
      return yield* new BetaGateFailed({
        message: `beta.yml runs on push, schedule, workflow_dispatch and workflow_run, not ${event}.`,
      });
    /** A person asked for this tick, so it skips the six hours and the retry back-off. */
    const manual = event === "workflow_dispatch";
    const now = yield* Clock.currentTimeMillis;

    const readVersion = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Package)),
        Effect.map((manifest) => manifest.version),
      );
    const version = yield* readVersion("apps/cli/package.json");
    const apps = yield* readVersion("packages/apps/package.json");
    if (!/^2\.0\.0-beta\.\d+$/.test(version))
      return yield* new BetaGateFailed({
        message: `Betas only follow 2.0.0-beta.N, and main records ${version}.`,
      });

    /** Builds and publications only: checks are repository dispatches, listed apart. */
    const runs = yield* succeed("gh", [
      "run",
      "list",
      "-R",
      repository,
      "-w",
      "release-artifacts.yml",
      "-e",
      "workflow_dispatch",
      "-b",
      "main",
      "-L",
      String(runLimit),
      "--json",
      "databaseId,status,conclusion,headSha,createdAt,attempt,url,displayTitle",
    ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Run)))));
    const registry = yield* succeed("npm", [
      "view",
      "executor",
      "time",
      "dist-tags",
      "--json",
    ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Registry)));
    const appsRegistry = yield* succeed("npm", [
      "view",
      "apps",
      "time",
      "dist-tags",
      "--json",
    ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Registry)));
    const head = yield* succeed("git", ["rev-parse", "HEAD"]);
    /**
     * Commits on main after `from`, without the `Refresh bun.lock [skip ci]` commits that
     * `lock-repair.sh` pushes: a lock refresh follows the merge that left the lock stale, and on its
     * own it neither makes a beta due nor moves main for the retry back-off.
     */
    const commitsSince = (from: string) =>
      succeed("git", [
        "rev-list",
        "--count",
        "-E",
        "--invert-grep",
        "--grep=^Refresh bun\\.lock \\[skip ci\\]$",
        `${from}..HEAD`,
      ]);
    /** The `Release <version>` commit on main, or "" when main has none. */
    const releaseCommit = succeed("git", [
      "log",
      "-1",
      "--format=%H",
      "-E",
      `--grep=^Release ${version.replaceAll(".", "\\.")}( |$)`,
      "HEAD",
    ]);

    /** Each release run's jobs, read once. */
    const jobsRead = new Map<number, Jobs>();
    const jobsOf = (run: Run) =>
      Effect.gen(function* () {
        const known = jobsRead.get(run.databaseId);
        if (known !== undefined) return known;
        const jobs = yield* succeed("gh", [
          "run",
          "view",
          String(run.databaseId),
          "-R",
          repository,
          "--json",
          "jobs",
        ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Jobs)));
        jobsRead.set(run.databaseId, jobs);
        return jobs;
      });
    const inLastDay = (...times: ReadonlyArray<string>) =>
      times.some((time) => now - Date.parse(time) < stale);
    /**
     * How many publishing attempts failed in the last day, selected by when they ran, not by
     * their place in a list: every run of the release workflow created within GitHub's re-run
     * window, newest first, a page at a time, and of each publishing run whose latest attempt ran
     * in the last day, the attempts that did. A run on its third attempt failed three times, or
     * twice and then once more, since only a finished attempt is re-run, so each earlier attempt
     * counts as failed whatever ended it, and a re-run never makes room. Reading stops once five
     * are known. It spends at most `countRequests`; when they run out first, `known` is false.
     */
    const failedInLastDay = Effect.gen(function* () {
      let requests = 0;
      let failed = 0;
      const unknown = () => ({ failed, known: false });
      const known = () => ({ failed, known: true });
      for (let page = 1; ; page++) {
        if (failed >= dailyAttempts) return known();
        if (requests >= countRequests) return unknown();
        requests++;
        const listed = yield* succeed("gh", [
          "api",
          `repos/${repository}/actions/workflows/${releaseWorkflow}/runs?event=workflow_dispatch&branch=main&per_page=${pageSize}&page=${page}`,
          "--jq",
          '[.workflow_runs[] | {databaseId: .id, status, conclusion: (.conclusion // ""), headSha: .head_sha, createdAt: .created_at, startedAt: .run_started_at, updatedAt: .updated_at, attempt: .run_attempt, url: .html_url, displayTitle: .display_title}] | @json',
        ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RunsPage)));
        for (const run of listed) {
          // Newest first: no run from here on can have an attempt in the last day.
          if (now - Date.parse(run.createdAt) >= rerunWindow + stale) return known();
          if (!publishingTitles.includes(run.displayTitle)) continue;
          if (
            run.status === "completed" &&
            run.conclusion !== "success" &&
            run.conclusion !== "cancelled" &&
            inLastDay(run.startedAt, run.updatedAt)
          )
            failed++;
          // Every earlier attempt ended before the latest started, so none ran in the last day
          // unless the latest started in it.
          if (run.attempt === 1 || !inLastDay(run.startedAt)) continue;
          if (inLastDay(run.createdAt)) {
            // Created in the last day, so every earlier attempt ran in it.
            failed += run.attempt - 1;
            continue;
          }
          // Earlier attempts, newest first, one request each: once one ran before the last day,
          // so did every attempt before it.
          for (let attempt = run.attempt - 1; attempt >= 1 && failed < dailyAttempts; attempt--) {
            if (requests >= countRequests) return unknown();
            requests++;
            const times = yield* succeed("gh", [
              "api",
              `repos/${repository}/actions/runs/${run.databaseId}/attempts/${attempt}`,
              "--jq",
              "{startedAt: .run_started_at, updatedAt: .updated_at} | @json",
            ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AttemptTimes)));
            if (!inLastDay(times.startedAt, times.updatedAt)) break;
            failed++;
          }
        }
        if (listed.length < pageSize) return known();
      }
    });
    const decide = Effect.gen(function* () {
      // Any build or publication: two must not run on main at once. A check, which publishes
      // nothing and may pace for two hours, is not in this list and holds no tick.
      const active = runs.find((run) => run.status !== "completed");
      if (active !== undefined)
        return { ...wait(`A release run is ${active.status}: ${active.url}`), pending: true };

      const published = registry.time[version];
      if (published !== undefined) {
        if (registry["dist-tags"].beta !== version)
          return yield* new BetaGateFailed({
            message: `npm lists executor@${version}, but its beta tag names ${registry["dist-tags"].beta}. Inspect the last release before publishing another.`,
          });
        const release = yield* releaseCommit;
        if (release !== "" && (yield* commitsSince(release)) === "0")
          return wait(`No commits on main since ${version}.`);
        const age = now - Date.parse(published);
        if (!manual && age < gap)
          return wait(
            `executor@${version} was published ${ago(age)}; the next beta waits six hours.`,
          );
        return act("bump", `main has commits after ${version}, published ${ago(age)}.`);
      }

      // npm lacks the committed version: publish it again rather than skip it. The decision needs
      // at most the last two publishing runs, read newest first, each with one `gh run view`.
      const attempts: Array<Attempt> = [];
      for (const run of runs) {
        const jobs = yield* jobsOf(run);
        const metadata = jobs.jobs.find((job) => job.name === "metadata");
        const step = metadata?.steps.find((candidate) => candidate.name === publishingStep);
        if (metadata?.conclusion === "success" && step === undefined)
          return yield* new BetaGateFailed({
            message: `${run.url} has no "${publishingStep}" step in its metadata job, so the gate cannot tell whether it published. Update publishingStep in scripts/releases/beta-due.ts.`,
          });
        // A run whose metadata job did not finish may have been a publishing attempt; it counts.
        if (metadata?.conclusion === "success" && step?.conclusion === "skipped") continue;
        attempts.push({ run, jobs });
        if (run.conclusion === "success" || attempts.length === 2) break;
      }
      const latest = attempts[0];
      if (latest === undefined) return act("dispatch", `executor@${version} is not on npm yet.`);
      const last = latest.run;
      if (last.conclusion === "success") {
        // Either the previous version's run, before this version's bump dispatched, or a run for
        // this version that published somewhere other than npm or skipped publishing.
        const release = yield* releaseCommit;
        if (release === "")
          return yield* new BetaGateFailed({
            message: `main has no "Release ${version}" commit, so the gate cannot tell whether ${last.url} released it.`,
          });
        const contains = yield* command("git", [
          "merge-base",
          "--is-ancestor",
          release,
          last.headSha,
        ]);
        if (contains.exitCode > 1)
          return yield* new BetaGateFailed({
            message: `git merge-base --is-ancestor ${release} ${last.headSha} exited ${contains.exitCode}: ${contains.stderr}`,
          });
        if (contains.exitCode === 0)
          return yield* new BetaGateFailed({
            message: `${last.url} concluded success for executor@${version}, but npm does not list it. Another run would do the same, so the gate stops until someone inspects that run's publish job and the registry. After fixing the cause, dispatch Executor releases with channel beta (RELEASING.md, "Publish beta").`,
          });
        return act("dispatch", `executor@${version} is not on npm yet.`);
      }
      // The daily bound holds on every path that starts or re-runs an attempt, a manual dispatch
      // of Beta included: at most five failed publishing attempts a day.
      const counted = yield* failedInLastDay;
      if (counted.failed >= dailyAttempts || !counted.known)
        return {
          ...hold(
            `executor@${version} is not on npm, and ${counted.failed >= dailyAttempts ? `at least ${counted.failed} publishing attempts failed in the last day` : `how many publishing attempts failed in the last day could not be counted within ${countRequests} requests, so it holds`}; at most ${dailyAttempts} a day are started, so the next waits until fewer than ${dailyAttempts} fall in the last 24 hours. The last is ${last.url}. To publish now, inspect the failures and dispatch Executor releases with channel beta by hand (RELEASING.md, "Publish beta").`,
          ),
          exhausted: counted.failed >= dailyAttempts,
        };
      const failedToday = counted.failed;
      // A failure in a step that publishes anything, in the publish job or any other (the image's
      // architecture tags are pushed in the docker job), may have left something public: the run's
      // failed jobs are re-run once from its artifacts, and then it holds. Judged by the failed
      // step, not by the job's name (scripts/releases/publishing-steps.ts).
      const publishJob = latest.jobs.jobs.find((job) => job.name === "publish");
      const publishing = [
        ...(publishJob !== undefined && publishJob.conclusion !== "skipped" ? ["publish"] : []),
        ...publishingFailures(latest.jobs.jobs, {
          [releaseWorkflow]: yield* fs.readFileString(`.github/workflows/${releaseWorkflow}`),
          "bun-runtime.yml": yield* fs.readFileString(".github/workflows/bun-runtime.yml"),
        }),
      ];
      if (publishing.length > 0) {
        const where = [...new Set(publishing)].join("; ");
        if (last.attempt === 1)
          return {
            decision: "rerun",
            reason: `${last.url} failed in a step that publishes executor@${version} (${where}); re-running its failed jobs from its artifacts.`,
            warning: false,
            run: last,
          } satisfies Decision;
        return hold(
          `${last.url} failed to publish executor@${version} again after a re-run (${where}). It may hold a public draft or tag, so a new run cannot replace it; inspect it (RELEASING.md, "Publish beta").`,
        );
      }
      const twice = attempts.length === 2 && attempts[1]?.run.conclusion !== "success";
      const since = now - Date.parse(last.createdAt);
      if (manual || !twice)
        return act(
          "dispatch",
          `executor@${version} is not on npm; ${last.url} failed before publishing, so it is published again (${failedToday} of ${dailyAttempts} attempts today failed).`,
        );
      const moved = head !== last.headSha && (yield* commitsSince(last.headSha)) !== "0";
      if (since >= backOff && (moved || since >= stale))
        return act(
          "dispatch",
          `executor@${version} is not on npm after two or more failed attempts in a row; the last, ${last.url}, started ${ago(since)}${moved ? " and main has moved since" : ""} (${failedToday} of ${dailyAttempts} attempts today failed).`,
        );
      // A failure before publishing is retried as soon as CI passed on a main commit after the
      // attempt's, which a fix makes, within the daily bound above.
      if (moved) {
        const green = (yield* succeed("gh", [
          "run",
          "list",
          "-R",
          repository,
          "-w",
          "ci.yml",
          "-b",
          "main",
          "-e",
          "push",
          "-s",
          "success",
          "-L",
          "1",
          "--json",
          "headSha,url",
        ]).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Array(Schema.Struct({ headSha: Schema.String, url: Schema.String })),
              ),
            ),
          ),
        ))[0];
        const after =
          green === undefined || green.headSha === last.headSha
            ? false
            : (yield* command("git", ["merge-base", "--is-ancestor", last.headSha, green.headSha]))
                .exitCode === 0;
        if (green !== undefined && after)
          return act(
            "dispatch",
            `executor@${version} is not on npm after two or more failed attempts in a row; the last, ${last.url}, failed before publishing, and CI passed on ${green.headSha.slice(0, 9)} after it (${green.url}), so it is published again (${failedToday} of ${dailyAttempts} attempts today failed).`,
          );
      }
      return hold(
        `executor@${version} is not on npm after two or more failed attempts in a row; the last is ${last.url}, ${ago(since)}. The next attempt waits for CI to pass on a newer main commit (at most ${dailyAttempts} failed attempts a day), or for six hours after it and a new commit on main, or a day; dispatch this workflow to retry now.`,
      );
    });

    /**
     * Why main's release matrix does not allow publishing, or undefined when it does: the newest
     * finished check or build on main must have passed its `releases` job, which judges the matrix
     * jobs alone; the `report` job cannot make it red. Skipped, since they tested nothing: a
     * cancelled run, and a check whose `pace` job did not pass or whose matrix did not run. A push
     * that changed nothing a
     * release lane reads starts no check, so it neither holds a beta nor lets one through. A run
     * still pacing or building holds nothing: the publishing run tests every platform on the
     * commit it publishes before it publishes.
     */
    const matrixGate = Effect.gen(function* () {
      const checks = yield* succeed("gh", [
        "run",
        "list",
        "-R",
        repository,
        "-w",
        "release-artifacts.yml",
        "-e",
        "repository_dispatch",
        "-b",
        "main",
        "-L",
        "100",
        "--json",
        "databaseId,status,conclusion,headSha,createdAt,attempt,url,displayTitle",
      ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Run)))));
      const candidates = [
        ...checks.map((run) => ({ run, check: true })),
        ...runs
          .filter((run) => run.displayTitle === buildTitle)
          .map((run) => ({ run, check: false })),
      ].sort((a, b) => Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt));
      /** Finished checks and builds newer than the deciding one that tested nothing. */
      const untested: Array<Run> = [];
      let latest: { readonly run: Run; readonly passed: boolean } | undefined;
      for (const { run, check } of candidates) {
        if (run.status !== "completed") continue;
        if (run.conclusion === "cancelled") {
          untested.push(run);
          continue;
        }
        const jobs = (yield* jobsOf(run)).jobs;
        const conclusion = (name: string) => jobs.find((job) => job.name === name)?.conclusion;
        if (check && (conclusion("pace") !== "success" || conclusion("metadata") === "skipped")) {
          untested.push(run);
          continue;
        }
        const releases = jobs.find((job) => job.name === "releases");
        if (releases === undefined)
          return yield* new BetaGateFailed({
            message: `${run.url} has no releases job, so the gate cannot tell how its matrix ended. Update matrixGate in scripts/releases/beta-due.ts.`,
          });
        latest = { run, passed: releases.conclusion === "success" };
        break;
      }
      const dispatchBuild =
        "dispatch Executor releases from main with channel build (gh workflow run release-artifacts.yml --ref main -f channel=build)";
      if (latest === undefined)
        return hold(
          `No release matrix run on main has finished testing among the last ${checks.length} checks and the builds, so no beta can show it passed. To start one, ${dispatchBuild}${untested[0] === undefined ? "" : `, or re-run ${untested[0].url}, which tested nothing`}.`,
        );
      if (!latest.passed)
        return hold(
          `The newest finished release matrix run on main, ${latest.run.url}, failed its releases job on ${latest.run.headSha}. No beta publishes until a later run passes: fix the cause, then ${dispatchBuild}, or merge the fix. Its issue is labelled release-matrix-red.`,
        );
      return undefined;
    });

    const decided: Decision = yield* decide;
    const gated =
      decided.decision === "bump" || decided.decision === "dispatch"
        ? ((yield* matrixGate) ?? decided)
        : decided;
    // New apps pin the apps release this host ships, so the release refuses a version npm lacks.
    const result =
      (gated.decision === "bump" || gated.decision === "dispatch") &&
      appsRegistry.time[apps] === undefined
        ? hold(`apps@${apps} is not on npm yet; the deploy from main publishes it.`)
        : gated;

    /** When the held beta became due, as `held_since` documents above, or undefined. */
    const dueSince = Effect.gen(function* () {
      const release = yield* releaseCommit;
      const published = registry.time[version];
      if (published === undefined) {
        if (release === "") return undefined;
        return Date.parse(yield* succeed("git", ["log", "-1", "--format=%cI", release]));
      }
      const afterPublished = Date.parse(published) + gap;
      if (release === "") return afterPublished;
      const first = (yield* succeed("git", [
        "log",
        "--reverse",
        "--format=%cI",
        "-E",
        "--invert-grep",
        "--grep=^Refresh bun\\.lock \\[skip ci\\]$",
        `${release}..HEAD`,
      ])).split("\n")[0];
      return first === undefined || first === ""
        ? afterPublished
        : Math.max(afterPublished, Date.parse(first));
    });
    const held = result.warning
      ? yield* Effect.gen(function* () {
          const since = yield* dueSince;
          const shown = result.exhausted === true || since === undefined || now - since > heldFor;
          return { state: shown ? "held" : "", since };
        })
      : {
          state: registry.time[version] !== undefined && result.pending !== true ? "clear" : "",
          since: undefined,
        };

    // An annotation, so a release that keeps failing is visible on the tick that skips it.
    yield* Console.log(`${result.warning ? "::warning::" : ""}${result.reason}`);
    yield* fs.writeFileString(
      output,
      [
        `decision=${result.decision}`,
        `version=${version}`,
        `run=${result.run?.databaseId ?? ""}`,
        `reason=${result.reason}`,
        `held=${held.state}`,
        `held_since=${held.since === undefined ? "" : new Date(held.since).toISOString()}`,
      ]
        .map((line) => `${line}\n`)
        .join(""),
      { flag: "a" },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
