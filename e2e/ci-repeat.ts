/**
 * Tell whether this pull request run repeats one that already finished: `node e2e/ci-repeat.ts`.
 *
 * A stack push that moves a layer's base and head together makes GitHub send that layer's
 * `synchronize` event twice, with the same payload, so two CI runs start on one head within a
 * second. They cannot cancel each other: a cancelled run fails the required checks, and GitHub
 * decides a check reported twice on a commit by the newer check suite (notes/ci.md, "The main
 * ruleset"). So `ci.yml` queues them by head commit, and the second starts once the first has
 * finished. This finds that first run, and the second reports its result instead of testing the
 * same merge again, which took as long as the first run.
 *
 * A run repeats another when that run of the same workflow finished on the same head, for a
 * `pull_request` event, and tested the same thing: its `select` job uploaded the record this run's
 * did (`CI_TESTED`, an artifact named for the pull request and a hash of the merge tree and the
 * description, which picks the suites). Its `checks / select` must have succeeded, so a failure
 * there (a missing e2e block, a missing deployed-stage line) is decided again on today's
 * description. Its `checks / check` and `checks / e2e` must each have passed or failed, and a run
 * that failed overall must have failed in one of them: a repeat skips the other jobs, and a
 * skipped job of the newer run would cover the older run's failure of it in the pull request's
 * checks. Anything else, including a re-run of this run, no record and any failure to read, tests
 * in full. It writes `of`, `check` and `e2e` to `GITHUB_OUTPUT` only for a repeat; `check` and `e2e`
 * read the repeated run's results again when they run.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class RepeatUnknown extends Schema.TaggedError<RepeatUnknown>()("RepeatUnknown", {
  message: Schema.String,
}) {}

/** The required checks a repeat reports (apps/hosted/cloud/alchemy.github-ruleset.ts). */
const requiredChecks = { check: "checks / check", e2e: "checks / e2e" } as const;
/** The job that records what a run tests and chooses its suites. */
const selectJob = "checks / select";

const Run = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  event: Schema.String,
  head_sha: Schema.String,
  workflow_id: Schema.Number,
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

/** Runs `gh` with the job's token and returns what it prints. */
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

/** The finished run this run repeats, with its required checks' conclusions, or none. */
const repeated = Effect.gen(function* () {
  const repository = yield* Config.String("GITHUB_REPOSITORY");
  const runId = Number(yield* Config.String("GITHUB_RUN_ID"));
  const attempt = Number(yield* Config.String("GITHUB_RUN_ATTEMPT"));
  const headSha = yield* Config.String("CI_HEAD_SHA");
  const tested = yield* Config.String("CI_TESTED").pipe(Config.withDefault(""));
  if (attempt !== 1) {
    yield* Console.log(`This is attempt ${attempt} of the run: a re-run tests in full.`);
    return Option.none();
  }
  if (tested === "") {
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
    const why =
      select !== "success"
        ? `its select was ${select}`
        : !decided(check) || !decided(e2e)
          ? `its checks did not decide (check: ${check}, e2e: ${e2e})`
          : run.conclusion === "failure" && check === "success" && e2e === "success"
            ? "it failed in a job outside its required checks, which a repeat would skip"
            : undefined;
    if (why !== undefined) {
      yield* Console.log(
        `${run.html_url} tested the same pull request, merge tree and description, but ${why}; this run tests in full.`,
      );
      return Option.none();
    }
    return Option.some({ run, check, e2e });
  }
  yield* Console.log(
    "No finished run tested the same pull request, merge tree and description; this run tests in full.",
  );
  return Option.none();
});

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found = yield* repeated.pipe(
      // Not knowing is not a repeat: the run tests in full.
      Effect.catchCause((cause) =>
        Console.log(
          `Could not tell whether this run repeats another (${String(cause).split("\n")[0]}); it tests in full.`,
        ).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isNone(found)) return;
    const { run, check, e2e } = found.value;
    yield* Console.log(
      `This run repeats ${run.html_url}, which tested the same pull request, merge tree and description: check ${check}, e2e ${e2e}. Its check and e2e report that run's results instead of testing again.`,
    );
    const output = yield* Config.String("GITHUB_OUTPUT").pipe(Config.option);
    if (Option.isSome(output))
      yield* fs.writeFileString(output.value, `of=${run.id}\ncheck=${check}\ne2e=${e2e}\n`, {
        flag: "a",
      });
  }).pipe(Effect.provide(NodeServices.layer)),
);
