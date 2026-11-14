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
 * - When npm lacks it, the version is published again rather than skipped. An attempt that failed
 *   in its publish job may already have a public draft for its source, so that run's failed jobs
 *   are re-run once from its own artifacts (`rerun`); after that, publication needs inspection
 *   (RELEASING.md). An attempt that failed before publishing is dispatched again on the next tick
 *   (`dispatch`). After two failures in a row, automatic ticks wait six hours since the last
 *   attempt, and until main has moved past it or a day has passed: a broken main costs at most five
 *   publishing runs a day. A manual dispatch retries at once.
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
 * `GITHUB_OUTPUT`. Reads npm with `npm view`, the release runs with `gh run list` and `gh run
 * view`, and the history with `git`, so `e2e/tests/beta-due.spec.ts` drives it with stubs. It
 * changes nothing itself: beta.yml acts on its decision.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Config, Console, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const hour = 60 * 60 * 1000;
/** The least time between two published betas. */
const gap = 6 * hour;
/** After two failed attempts in a row, the least time before the next one. */
const backOff = 6 * hour;
/** After two failed attempts in a row, retry this long after the last one even if main is still. */
const stale = 24 * hour;

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
    if (!["push", "schedule", "workflow_dispatch"].includes(event))
      return yield* new BetaGateFailed({
        message: `beta.yml runs on push, schedule and workflow_dispatch, not ${event}.`,
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
      "30",
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
    const decide = Effect.gen(function* () {
      // Any build or publication: two must not run on main at once. A check, which publishes
      // nothing and may pace for two hours, is not in this list and holds no tick.
      const active = runs.find((run) => run.status !== "completed");
      if (active !== undefined) return wait(`A release run is ${active.status}: ${active.url}`);

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
      const publishJob = latest.jobs.jobs.find((job) => job.name === "publish");
      if (publishJob !== undefined && publishJob.conclusion !== "skipped") {
        if (last.attempt === 1)
          return {
            decision: "rerun",
            reason: `${last.url} built and tested executor@${version} but failed to publish it; re-running its failed jobs from its artifacts.`,
            warning: false,
            run: last,
          } satisfies Decision;
        return hold(
          `${last.url} failed to publish executor@${version} again after a re-run. It may hold a public draft, so a new run cannot replace it; inspect it (RELEASING.md, "Publish beta").`,
        );
      }
      const twice = attempts.length === 2 && attempts[1]?.run.conclusion !== "success";
      const since = now - Date.parse(last.createdAt);
      if (manual || !twice)
        return act(
          "dispatch",
          `executor@${version} is not on npm; ${last.url} failed, so it is published again.`,
        );
      const moved = head !== last.headSha && (yield* commitsSince(last.headSha)) !== "0";
      if (since >= backOff && (moved || since >= stale))
        return act(
          "dispatch",
          `executor@${version} is not on npm after two or more failed attempts in a row; the last, ${last.url}, started ${ago(since)}${moved ? " and main has moved since" : ""}.`,
        );
      return hold(
        `executor@${version} is not on npm after two or more failed attempts in a row; the last is ${last.url}, ${ago(since)}. The next attempt waits for six hours after it and for a new commit on main, or a day; dispatch this workflow to retry now.`,
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

    // An annotation, so a release that keeps failing is visible on the tick that skips it.
    yield* Console.log(`${result.warning ? "::warning::" : ""}${result.reason}`);
    yield* fs.writeFileString(
      output,
      [
        `decision=${result.decision}`,
        `version=${version}`,
        `run=${result.run?.databaseId ?? ""}`,
        `reason=${result.reason}`,
      ]
        .map((line) => `${line}\n`)
        .join(""),
      { flag: "a" },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
