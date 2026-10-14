/**
 * Serve self-host under Bun's coverage profiler, for E2E coverage runs.
 *
 * Bun profiles coverage only under `bun test`, and writes the report only when the test run ends on
 * its own: a `process.exit` loses it. So this is one test that serves until the runtime would exit,
 * and the exit instead ends the test. Run it as
 * `bun test --coverage --coverage-reporter=lcov --coverage-dir=<dir> --timeout=0 scripts/coverage-main.ts`.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { test } from "bun:test";
import { main } from "../src/main.ts";

test("self-host serves until it stops", async () => {
  const code = await new Promise<number>((resolve) => {
    process.exit = ((code?: number) => resolve(code ?? 0)) as typeof process.exit;
    BunRuntime.runMain(main);
  });
  process.exitCode = code;
});
