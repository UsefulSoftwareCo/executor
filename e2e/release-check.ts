import * as NodeServices from "@effect/platform-node/NodeServices";
import { runMain } from "./run-main.ts";
import { Config, Console, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { mainPushPaths, matchesAny, releaseSources } from "./release-lanes.ts";

class ReleaseCheckFailed extends Schema.TaggedError<ReleaseCheckFailed>()("ReleaseCheckFailed", {
  message: Schema.String,
}) {}

const compareFileLimit = 300;

export const windowsBranch = "ci/windows-check";
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
