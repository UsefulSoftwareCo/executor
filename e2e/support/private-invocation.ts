/** Suite-owned separate driver process. The driver imports no application implementation. */
import { Config, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Evidence } from "./evidence.ts";
import { Target } from "./platform.ts";

export const privateInvocationConformance = Effect.gen(function* () {
  const manifest = yield* Config.string("EXECUTOR_PRIVATE_INVOCATION_FIXTURE");
  const target = yield* Target;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const evidence = yield* Evidence;
  const child = yield* processes.spawn(
    ChildProcess.make(
      "node",
      [
        "e2e/private-invocation-driver.ts",
        "--fixture",
        manifest,
        "--evidence",
        `${target.directory}/private-invocation-evidence`,
      ],
      { env: { PATH: process.env.PATH ?? "" }, extendEnv: false },
    ),
  );
  const [exit, stdout, stderr] = yield* Effect.all(
    [
      child.exitCode,
      child.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (a, b) => a + b,
        ),
      ),
      child.stderr.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (a, b) => a + b,
        ),
      ),
    ],
    { concurrency: 3 },
  ).pipe(Effect.timeout("90 seconds"));
  yield* evidence.json("private-invocation-driver.json", { exit, stdout, stderr });
  if (exit !== 0)
    return yield* Effect.fail(
      new Error(
        "Private invocation conformance did not execute successfully; see fixture prerequisites/evidence",
      ),
    );
});
