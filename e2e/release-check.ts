/**
 * Decide whether main needs the paced release check. `.github/workflows/release-check.yml` runs
 * this on every push to main and on an hourly backstop, and starts the check, a repository dispatch
 * of Executor releases, unless this writes `run=false`.
 *
 * The comparison runs from the last check that tested main, or will: the newest check, the
 * repository dispatch runs of Executor releases, that is queued, pacing or building, or that
 * finished having built, its pace job passed and its matrix ran. A cancelled check, or one whose
 * pace job failed or whose matrix did not run, tested nothing, so its commits stay in the
 * comparison. So a push with many commits, several pushes while a check waits, or a change that
 * came with a `[skip ci]` commit count every commit since the last tested one, not since the
 * previous push.
 *
 * The paths are what each release lane builds or runs, computed now from this checkout by
 * e2e/release-lanes.ts (`mainPushPaths`), so a file a release suite starts importing counts
 * without anyone editing a list. A renamed file counts by its old name too. File names come from
 * commits, so they are written quoted, with nothing in them read as Markdown or a workflow command.
 *
 * It writes `run=false` only when it is sure: no earlier check, a comparison GitHub cuts short or
 * cannot make, or any failure leaves `run` unwritten or `true`, and the workflow then starts the
 * check. Reads GitHub with `gh`, so e2e/tests/ci-selection.spec.ts drives it with a stub.
 *
 * The paced check builds Linux x64 and the image only. Windows has a decision of its own, written as
 * `windows`: the installed CLI suite on Windows, a narrowed build dispatched on the
 * `ci/windows-check` branch (`windowsBranch`). Its comparison runs from the last Windows check that
 * tested a commit, or will, by the same rule, never from the Linux check: a commit the Linux check
 * covered may still be one no Windows check has. It starts at most once every
 * WINDOWS_PACE_SECONDS; a decision inside that pace writes `windows=false` and keeps the base where
 * it was, so the first decision after the pace, a push or the hourly backstop, starts it for every
 * commit since. A failure leaves `windows` unwritten, and the workflow then starts it.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { runMain } from "./run-main.ts";
import { Config, Console, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { mainPushPaths, matchesAny, releaseSources } from "./release-lanes.ts";

class ReleaseCheckFailed extends Schema.TaggedError<ReleaseCheckFailed>()("ReleaseCheckFailed", {
  message: Schema.String,
}) {}

/** GitHub's comparison lists at most this many files. */
const compareFileLimit = 300;

/** The branch the Windows check is dispatched on, which release-check.yml sets to main's commit. */
export const windowsBranch = "ci/windows-check";
/** The Windows check's title (release-artifacts.yml's `run-name` for that narrowed build). */
export const windowsTitle = "Executor releases (build, cli on win32-x64)";

const Run = Schema.Struct({
  databaseId: Schema.Number,
  status: Schema.String,
  conclusion: Schema.String,
  headSha: Schema.String,
  url: Schema.String,
});
const Jobs = Schema.fromJsonString(
  Schema.Struct({
    jobs: Schema.Array(Schema.Struct({ name: Schema.String, conclusion: Schema.String })),
  }),
);
const WindowsRun = Schema.Struct({
  databaseId: Schema.Number,
  status: Schema.String,
  conclusion: Schema.String,
  headSha: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  displayTitle: Schema.String,
});
const Comparison = Schema.fromJsonString(
  Schema.Struct({ status: Schema.String, files: Schema.Array(Schema.String) }),
);

/**
 * A file name as JSON, which escapes quotes, newlines and every control character, with backticks
 * escaped too, so it cannot end a code span, start a line or form a workflow command.
 */
const quoted = (file: string) => `\`${JSON.stringify(file).replaceAll("`", "\\u0060")}\``;

const gh = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make("gh", args));
    const [output, error, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* new ReleaseCheckFailed({
        message: `gh ${args.join(" ")} failed: ${error.trim()}`,
      });
    return output;
  }).pipe(Effect.scoped);

runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const head = yield* Config.String("RELEASE_CHECK_HEAD");
    const output = yield* Config.String("GITHUB_OUTPUT");
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    const pace = yield* Config.Number("WINDOWS_PACE_SECONDS").pipe(Config.withDefault(14_400));
    const decide = (key: "run" | "windows", title: string, run: boolean, reason: string) =>
      Effect.gen(function* () {
        const report = `## ${title}\n\n${run ? "Runs" : "Skipped"}: ${reason}\n`;
        yield* Console.log(report);
        if (Option.isSome(summary))
          yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
        yield* fs.writeFileString(output, `${key}=${run}\n`, { flag: "a" });
      });
    const jobsOf = (run: { readonly databaseId: number }) =>
      gh(["run", "view", String(run.databaseId), "-R", repository, "--json", "jobs"]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Jobs)),
        Effect.map(
          ({ jobs }) =>
            (name: string) =>
              jobs.find((job) => job.name === name)?.conclusion,
        ),
      );
    /** Whether the changes since `base`, which `url` tests, hold a file a release lane reads. */
    const changedSince = (base: string, url: string) =>
      Effect.gen(function* () {
        const comparison = yield* gh([
          "api",
          `repos/${repository}/compare/${base}...${head}`,
          "--jq",
          "{status, files: [.files[] | .filename, (.previous_filename // empty)]}",
        ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Comparison)));
        if (comparison.status !== "ahead" && comparison.status !== "identical")
          return {
            run: true,
            reason: `main is ${comparison.status} of ${base}, which ${url} tested, so the changes since cannot be listed.`,
          };
        if (comparison.files.length >= compareFileLimit)
          return {
            run: true,
            reason: `GitHub lists at most ${compareFileLimit} changed files, and the changes since ${base} reach that.`,
          };
        const paths = mainPushPaths(yield* releaseSources);
        const relevant = [...new Set(comparison.files)].filter((file) => matchesAny(paths, file));
        return relevant.length === 0
          ? {
              run: false,
              reason: `no file a release lane builds or runs changed since ${base}, which ${url} tests.`,
            }
          : {
              run: true,
              reason: `since ${base}, which ${url} tests, these changed: ${relevant.slice(0, 10).map(quoted).join(", ")}${relevant.length > 10 ? ` and ${relevant.length - 10} more` : ""}.`,
            };
      });

    const runs = yield* gh([
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
      "databaseId,status,conclusion,headSha,url",
    ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Run)))));
    let base: typeof Run.Type | undefined;
    for (const run of runs) {
      if (run.conclusion === "cancelled") continue;
      if (run.status !== "completed") {
        base = run;
        break;
      }
      const conclusion = yield* jobsOf(run);
      if (conclusion("pace") === "success" && conclusion("metadata") !== "skipped") {
        base = run;
        break;
      }
    }
    const linux =
      base === undefined
        ? { run: true, reason: "no earlier check on main tested a commit." }
        : base.headSha === head
          ? { run: false, reason: `${base.url} tests this commit already.` }
          : yield* changedSince(base.headSha, base.url);
    yield* decide("run", "Release check", linux.run, linux.reason);

    // The Windows check: its own runs on its own branch, its own base and its own pace.
    const windowsRuns = (yield* gh([
      "run",
      "list",
      "-R",
      repository,
      "-w",
      "release-artifacts.yml",
      "-e",
      "workflow_dispatch",
      "-b",
      windowsBranch,
      "-L",
      "20",
      "--json",
      "databaseId,status,conclusion,headSha,url,createdAt,displayTitle",
    ]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(WindowsRun)))),
    )).filter((run) => run.displayTitle === windowsTitle && run.conclusion !== "cancelled");
    let windowsBase: typeof WindowsRun.Type | undefined;
    for (const run of windowsRuns) {
      if (run.status !== "completed" || (yield* jobsOf(run))("metadata") === "success") {
        windowsBase = run;
        break;
      }
    }
    const windows =
      windowsBase === undefined
        ? { run: true, reason: "no earlier Windows check tested a commit of main." }
        : windowsBase.headSha === head
          ? { run: false, reason: `${windowsBase.url} tests this commit already.` }
          : yield* changedSince(windowsBase.headSha, windowsBase.url);
    // The newest Windows check of any outcome but a cancellation sets the pace.
    const newest = windowsRuns[0];
    const now = Date.now();
    const next = newest === undefined ? 0 : Date.parse(newest.createdAt) + pace * 1000;
    if (windows.run && newest !== undefined && now < next)
      return yield* decide(
        "windows",
        "Windows check",
        false,
        `it is due, as ${windows.reason.replace(/\.$/, "")}, but ${newest.url} started less than ${pace} s ago, so the first decision after ${new Date(next).toISOString()} starts it, comparing from the same commit.`,
      );
    yield* decide("windows", "Windows check", windows.run, windows.reason);
  }).pipe(Effect.provide(NodeServices.layer)),
);
