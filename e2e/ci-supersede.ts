import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class SupersedeFailed extends Schema.TaggedError<SupersedeFailed>()("SupersedeFailed", {
  message: Schema.String,
}) {}

const PullRequest = Schema.fromJsonString(
  Schema.Struct({ head: Schema.Struct({ sha: Schema.String, ref: Schema.String }) }),
);
const Run = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
  status: Schema.String,
  head_sha: Schema.String,
  workflow_id: Schema.Number,
  pull_requests: Schema.Array(Schema.Struct({ number: Schema.Number })),
});
const Runs = Schema.fromJsonString(Schema.Struct({ workflow_runs: Schema.Array(Run) }));

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
      return yield* new SupersedeFailed({
        message: `gh ${args.join(" ")} failed: ${error.trim()}`,
      });
    return output;
  }).pipe(Effect.scoped);

const read = <S extends Schema.Top>(schema: S, args: ReadonlyArray<string>, what: string) =>
  gh(args).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) =>
      error instanceof SupersedeFailed
        ? error
        : new SupersedeFailed({ message: `Could not read ${what}: ${String(error)}` }),
    ),
  );

NodeRuntime.runMain(
  Effect.gen(function* () {
    const repository = yield* Config.String("GITHUB_REPOSITORY");
    const runId = Number(yield* Config.String("GITHUB_RUN_ID"));
    const number = yield* Config.Number("CI_PULL_REQUEST");
    const headSha = yield* Config.String("CI_HEAD_SHA");
    const pull = yield* read(
      PullRequest,
      ["api", `repos/${repository}/pulls/${number}`],
      "the pull request",
    );
    if (pull.head.sha !== headSha) {
      yield* Console.log(
        `This run tests ${headSha}, but the pull request's head is now ${pull.head.sha}; its run cancels this one.`,
      );
      return;
    }
    const own = yield* read(
      Schema.fromJsonString(Run),
      ["api", `repos/${repository}/actions/runs/${runId}`],
      "this run",
    );
    const { workflow_runs: runs } = yield* read(
      Runs,
      [
        "api",
        `repos/${repository}/actions/workflows/${own.workflow_id}/runs?event=pull_request&branch=${encodeURIComponent(pull.head.ref)}&per_page=100`,
      ],
      "the pull request's runs",
    );
    const older = runs.filter(
      (run) =>
        run.id !== runId &&
        run.status !== "completed" &&
        run.head_sha !== headSha &&
        run.pull_requests.some((other) => other.number === number),
    );
    if (older.length === 0) yield* Console.log("No run of this pull request tests an older head.");
    for (const run of older) {
      yield* gh(["api", "-X", "POST", `repos/${repository}/actions/runs/${run.id}/cancel`]).pipe(
        Effect.andThen(Console.log(`Cancelled ${run.html_url}, which tests ${run.head_sha}.`)),
        Effect.catchTag("SupersedeFailed", (error) =>
          error.message.includes("HTTP 409")
            ? Console.log(`${run.html_url} finished before it could be cancelled.`)
            : Effect.fail(error),
        ),
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
