/** Persist real child stderr and exit diagnostics without recording its protocol stream. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Logger, Redacted } from "effect";
import { rotatingJsonLogger } from "@executor-js/telemetry/files";
import { startBackend } from "../src/implementation/backend.ts";

test("desktop retains failed backend startup diagnostics", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const entry = `${directory}/backend.mjs`;
        yield* fs.writeFileString(
          entry,
          'process.stderr.write("backend startup sentinel\\n", () => { process.exitCode = 42 })',
        );
        const result = yield* Effect.scoped(
          startBackend({
            executable: process.execPath,
            entry,
            cwd: directory,
            directory,
            collectorBundle: directory,
            development: false,
            token: Redacted.make("ab".repeat(32)),
          }).pipe(
            Effect.result,
            Effect.provide(Logger.layer([rotatingJsonLogger(directory, "desktop")])),
          ),
        );
        assert.equal(result._tag, "Failure");
        const text = yield* fs.readFileString(`${directory}/desktop.jsonl`);
        assert.match(text, /backend startup sentinel/);
        assert.match(text, /exitCode.*42/);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
