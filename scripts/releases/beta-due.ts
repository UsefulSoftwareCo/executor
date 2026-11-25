import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Config, Console, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { publishingFailures, releaseWorkflow } from "./publishing-steps.ts";

const hour = 60 * 60 * 1000;
const gap = 6 * hour;
const backOff = 6 * hour;
const stale = 24 * hour;
const dailyAttempts = 5;
const heldFor = 6 * hour;
const runLimit = 30;
const rerunWindow = 30 * 24 * hour;
const pageSize = 100;
const countRequests = 10;
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

const RunsPage = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      ...Run.fields,
      startedAt: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
);

const AttemptTimes = Schema.fromJsonString(
  Schema.Struct({ startedAt: Schema.String, updatedAt: Schema.String }),
);

const Step = Schema.Struct({ name: Schema.String, conclusion: Schema.String });

const buildTitle = "Executor releases (build)";

const Jobs = Schema.fromJsonString(
  Schema.Struct({
    jobs: Schema.Array(
      Schema.Struct({ name: Schema.String, conclusion: Schema.String, steps: Schema.Array(Step) }),
    ),
  }),
);
type Jobs = typeof Jobs.Type;

const publishingStep = "Check the apps release is published unchanged";

interface Attempt {
  readonly run: Run;
  readonly jobs: Jobs;
}

interface Decision {
  readonly decision: "none" | "bump" | "dispatch" | "rerun";
  readonly reason: string;
  readonly warning: boolean;
  readonly exhausted?: boolean;
  readonly pending?: boolean;
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
    const commitsSince = (from: string) =>
      succeed("git", [
        "rev-list",
        "--count",
        "-E",
        "--invert-grep",
        "--grep=^Refresh bun\\.lock \\[skip ci\\]$",
        `${from}..HEAD`,
      ]);
    const releaseCommit = succeed("git", [
      "log",
      "-1",
      "--format=%H",
      "-E",
      `--grep=^Release ${version.replaceAll(".", "\\.")}( |$)`,
      "HEAD",
    ]);

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
          if (now - Date.parse(run.createdAt) >= rerunWindow + stale) return known();
          if (!publishingTitles.includes(run.displayTitle)) continue;
          if (
            run.status === "completed" &&
            run.conclusion !== "success" &&
            run.conclusion !== "cancelled" &&
            inLastDay(run.startedAt, run.updatedAt)
          )
            failed++;
          if (run.attempt === 1 || !inLastDay(run.startedAt)) continue;
          if (inLastDay(run.createdAt)) {
            failed += run.attempt - 1;
            continue;
          }
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

      const attempts: Array<Attempt> = [];
      for (const run of runs) {
        const jobs = yield* jobsOf(run);
        const metadata = jobs.jobs.find((job) => job.name === "metadata");
        const step = metadata?.steps.find((candidate) => candidate.name === publishingStep);
        if (metadata?.conclusion === "success" && step === undefined)
          return yield* new BetaGateFailed({
            message: `${run.url} has no "${publishingStep}" step in its metadata job, so the gate cannot tell whether it published. Update publishingStep in scripts/releases/beta-due.ts.`,
          });
        if (metadata?.conclusion === "success" && step?.conclusion === "skipped") continue;
        attempts.push({ run, jobs });
        if (run.conclusion === "success" || attempts.length === 2) break;
      }
      const latest = attempts[0];
      if (latest === undefined) return act("dispatch", `executor@${version} is not on npm yet.`);
      const last = latest.run;
      if (last.conclusion === "success") {
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
      const counted = yield* failedInLastDay;
      if (counted.failed >= dailyAttempts || !counted.known)
        return {
          ...hold(
            `executor@${version} is not on npm, and ${counted.failed >= dailyAttempts ? `at least ${counted.failed} publishing attempts failed in the last day` : `how many publishing attempts failed in the last day could not be counted within ${countRequests} requests, so it holds`}; at most ${dailyAttempts} a day are started, so the next waits until fewer than ${dailyAttempts} fall in the last 24 hours. The last is ${last.url}. To publish now, inspect the failures and dispatch Executor releases with channel beta by hand (RELEASING.md, "Publish beta").`,
          ),
          exhausted: counted.failed >= dailyAttempts,
        };
      const failedToday = counted.failed;
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
    const result =
      (gated.decision === "bump" || gated.decision === "dispatch") &&
      appsRegistry.time[apps] === undefined
        ? hold(`apps@${apps} is not on npm yet; the deploy from main publishes it.`)
        : gated;

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
