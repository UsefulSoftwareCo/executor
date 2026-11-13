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
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { mainPushPaths, matchesAny, releaseSources } from "./release-lanes.ts";

class ReleaseCheckFailed extends Schema.TaggedError<ReleaseCheckFailed>()("ReleaseCheckFailed", {
  message: Schema.String,
}) {}

/** GitHub's comparison lists at most this many files. */
const compareFileLimit = 300;

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

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const head = yield* Config.String("RELEASE_CHECK_HEAD");
    const output = yield* Config.String("GITHUB_OUTPUT");
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    const decide = (run: boolean, reason: string) =>
      Effect.gen(function* () {
        const report = `## Release check\n\n${run ? "Runs" : "Skipped"}: ${reason}\n`;
        yield* Console.log(report);
        if (Option.isSome(summary))
          yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
        yield* fs.writeFileString(output, `run=${run}\n`, { flag: "a" });
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
      const jobs = (yield* gh([
        "run",
        "view",
        String(run.databaseId),
        "-R",
        repository,
        "--json",
        "jobs",
      ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Jobs)))).jobs;
      const conclusion = (name: string) => jobs.find((job) => job.name === name)?.conclusion;
      if (conclusion("pace") === "success" && conclusion("metadata") !== "skipped") {
        base = run;
        break;
      }
    }
    if (base === undefined) return yield* decide(true, "no earlier check on main tested a commit.");
    if (base.headSha === head)
      return yield* decide(false, `${base.url} tests this commit already.`);

    const comparison = yield* gh([
      "api",
      `repos/${repository}/compare/${base.headSha}...${head}`,
      "--jq",
      "{status, files: [.files[] | .filename, (.previous_filename // empty)]}",
    ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Comparison)));
    if (comparison.status !== "ahead" && comparison.status !== "identical")
      return yield* decide(
        true,
        `main is ${comparison.status} of ${base.headSha}, which ${base.url} tested, so the changes since cannot be listed.`,
      );
    if (comparison.files.length >= compareFileLimit)
      return yield* decide(
        true,
        `GitHub lists at most ${compareFileLimit} changed files, and the changes since ${base.headSha} reach that.`,
      );
    const paths = mainPushPaths(yield* releaseSources);
    const relevant = [...new Set(comparison.files)].filter((file) => matchesAny(paths, file));
    return yield* relevant.length === 0
      ? decide(
          false,
          `no file a release lane builds or runs changed since ${base.headSha}, which ${base.url} tests.`,
        )
      : decide(
          true,
          `since ${base.headSha}, which ${base.url} tests, these changed: ${relevant.slice(0, 10).map(quoted).join(", ")}${relevant.length > 10 ? ` and ${relevant.length - 10} more` : ""}.`,
        );
  }).pipe(Effect.provide(NodeServices.layer)),
);
