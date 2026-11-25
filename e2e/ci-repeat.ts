import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class RepeatUnknown extends Schema.TaggedError<RepeatUnknown>()("RepeatUnknown", {
  message: Schema.String,
}) {}

const requiredChecks = { check: "checks / check", e2e: "checks / e2e" } as const;
const selectJob = "checks / select";
const siteJob = "checks / site";

const Run = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  event: Schema.String,
  head_sha: Schema.String,
  workflow_id: Schema.Number,
  run_attempt: Schema.Number,
});
const Runs = Schema.fromJsonString(Schema.Struct({ workflow_runs: Schema.Array(Run) }));
const Artifacts = Schema.fromJsonString(
  Schema.Struct({ artifacts: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);
const Jobs = Schema.fromJsonString(
  Schema.Struct({
    jobs: Schema.Array(
      Schema.Struct({ name: Schema.String, conclusion: Schema.NullOr(Schema.String) }),
    ),
  }),
);

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
      return yield* new RepeatUnknown({ message: `gh ${args.join(" ")} failed: ${error.trim()}` });
    return output;
  }).pipe(Effect.scoped);

const read = <S extends Schema.Top>(schema: S, path: string) =>
  gh(["api", path]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) =>
      error instanceof RepeatUnknown
        ? error
        : new RepeatUnknown({ message: `Could not read ${path}: ${String(error)}` }),
    ),
  );

const repeated = Effect.gen(function* () {
  const repository = yield* Config.String("GITHUB_REPOSITORY");
  const runId = Number(yield* Config.String("GITHUB_RUN_ID"));
  const attempt = Number(yield* Config.String("GITHUB_RUN_ATTEMPT"));
  const headSha = yield* Config.String("CI_HEAD_SHA");
  const tested = yield* Config.String("CI_TESTED").pipe(Config.withDefault(""));
  const sized = yield* Config.String("CI_SIZED").pipe(Config.withDefault(""));
  if (attempt !== 1) {
    yield* Console.log(`This is attempt ${attempt} of the run: a re-run tests in full.`);
    return Option.none();
  }
  if (tested === "" || sized === "") {
    yield* Console.log("This run recorded nothing to compare: it tests in full.");
    return Option.none();
  }
  const own = yield* read(Schema.fromJsonString(Run), `repos/${repository}/actions/runs/${runId}`);
  const { workflow_runs: runs } = yield* read(
    Runs,
    `repos/${repository}/actions/workflows/${own.workflow_id}/runs?event=pull_request&head_sha=${headSha}&per_page=100`,
  );
  const finished = runs
    .filter(
      (run) =>
        run.id !== runId &&
        run.event === "pull_request" &&
        run.head_sha === headSha &&
        run.status === "completed" &&
        (run.conclusion === "success" || run.conclusion === "failure"),
    )
    .toSorted((a, b) => b.id - a.id);
  for (const run of finished) {
    const { artifacts } = yield* read(
      Artifacts,
      `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    if (!artifacts.some((artifact) => artifact.name === tested)) continue;
    const { jobs } = yield* read(
      Jobs,
      `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
    );
    const conclusion = (name: string) =>
      jobs.find((job) => job.name === name)?.conclusion ?? "missing";
    const check = conclusion(requiredChecks.check);
    const e2e = conclusion(requiredChecks.e2e);
    const select = conclusion(selectJob);
    const decided = (result: string) => result === "success" || result === "failure";
    const site = conclusion(siteJob);
    const why =
      run.run_attempt !== 1
        ? `it was run again (attempt ${run.run_attempt}), so its jobs may have read a later description than its select did`
        : select !== "success"
          ? `its select was ${select}`
          : decided(site) && !artifacts.some((artifact) => artifact.name === sized)
            ? "its size gate read other worker-growth blocks than this run's select did"
            : !decided(check) || !decided(e2e)
              ? `its checks did not decide (check: ${check}, e2e: ${e2e})`
              : check !== "success" || e2e !== "success"
                ? `its checks failed (check: ${check}, e2e: ${e2e}), and only a pass is handed on: a failure is tested again`
                : run.conclusion !== "success"
                  ? "it failed in a job outside its required checks, which a repeat would skip"
                  : undefined;
    if (why !== undefined) {
      yield* Console.log(
        `${run.html_url} tested the same pull request, merge tree, base and selection (e2e/ci-key.ts), but ${why}; this run tests in full.`,
      );
      return Option.none();
    }
    return Option.some({ run, check, e2e });
  }
  yield* Console.log(
    "No finished run tested the same pull request, merge tree, base and selection; this run tests in full.",
  );
  return Option.none();
});

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found = yield* repeated.pipe(
      Effect.catchCause((cause) =>
        Console.log(
          `Could not tell whether this run repeats another (${String(cause).split("\n")[0]}); it tests in full.`,
        ).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isNone(found)) return;
    const { run, check, e2e } = found.value;
    yield* Console.log(
      `This run repeats ${run.html_url}, which tested the same pull request, merge tree, base and selection: check ${check}, e2e ${e2e}. Its check and e2e report that run's results instead of testing again.`,
    );
    const output = yield* Config.String("GITHUB_OUTPUT").pipe(Config.option);
    if (Option.isSome(output))
      yield* fs.writeFileString(output.value, `of=${run.id}\ncheck=${check}\ne2e=${e2e}\n`, {
        flag: "a",
      });
  }).pipe(Effect.provide(NodeServices.layer)),
);
