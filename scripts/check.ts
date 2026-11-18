/**
 * `bun run check`: the repository's static checks, the list CI's `static` job and
 * `bun run pr:check` run. Each step is named and runs the command it ran when `check` was one `&&`
 * chain. They read the tree and write nothing to it, so they run at once; each one's output is
 * printed whole when it ends, with how it ended and how long it took. Any failed step fails the
 * run, after every step has finished, with a list of the failed ones.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Console, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Each step's name and the command it runs, in the order `check` ran them. */
const steps: ReadonlyArray<readonly [name: string, command: string]> = [
  ["conflict markers", "node scripts/check-conflict-markers.ts"],
  ["dependency patches", "bun run patches:check"],
  ["engine refusals", "node scripts/check-engine-refusals.ts"],
  ["exact versions", "bun run versions:check"],
  ["format", "bun run format:check"],
  ["lint", "bun run lint"],
  ["typecheck", "bun run typecheck"],
  ["host protocols", "bun run apps:protocols"],
  ["app telemetry", "bun run apps:telemetry"],
  ["API errors", "bun run api:errors"],
  ["auth rate limit", "bun run auth:rate-limit"],
  ["browser scripts", "node packages/apps/scripts/browser-scripts.mjs --check"],
  ["Executor skill texts", "node packages/app-templates/scripts/executor-intro.ts --check"],
  ["no tests outside e2e", "node scripts/check-no-unit-tests.ts"],
  ["storage versions", "node packages/sdk/scripts/check-storage-versions.ts"],
  ["local data steps", "node scripts/check-local-data-steps.ts"],
  ["e2e boundary", "node e2e/check-boundary.ts"],
];

const runStep = ([name, command]: readonly [string, string]) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const start = yield* Clock.currentTimeMillis;
    const child = yield* processes.spawn(
      ChildProcess.make("sh", ["-c", command], { stdin: "ignore", extendEnv: true }),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const seconds = ((yield* Clock.currentTimeMillis) - start) / 1000;
    const passed = Number(exitCode) === 0;
    yield* Console.log(
      `\n=== ${passed ? "pass" : "FAIL"}  ${name} (${seconds.toFixed(1)} s): ${command}\n${output.trimEnd()}`,
    );
    return { name, passed, seconds };
  }).pipe(Effect.scoped);

NodeRuntime.runMain(
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const results = yield* Effect.forEach(steps, runStep, { concurrency: "unbounded" });
    const seconds = ((yield* Clock.currentTimeMillis) - start) / 1000;
    const failed = results.filter((result) => !result.passed);
    yield* Console.log(
      `\n${results.length - failed.length} of ${results.length} checks passed in ${seconds.toFixed(1)} s; slowest: ${results
        .toSorted((a, b) => b.seconds - a.seconds)
        .slice(0, 3)
        .map((result) => `${result.name} ${result.seconds.toFixed(1)} s`)
        .join(", ")}.`,
    );
    if (failed.length > 0) {
      yield* Console.log(`Failed: ${failed.map((result) => result.name).join(", ")}.`);
      process.exitCode = 1;
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
