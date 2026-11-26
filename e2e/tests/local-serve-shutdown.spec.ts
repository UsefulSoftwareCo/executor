import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { freePort } from "../support/ports.ts";
import { localEntryCommand } from "../support/local-entry.ts";
import { throughPipe, type Reader } from "../support/pipe-readers.ts";

const LogLine = Schema.fromJsonString(Schema.Struct({ message: Schema.Unknown }));

const serveThrough = (
  args: ReadonlyArray<string>,
  setup: (
    directory: string,
    origin: string,
  ) => Effect.Effect<{ readonly reader: Reader; readonly env?: Readonly<Record<string, string>> }>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
      Config.option,
    );
    const entry = path.resolve(
      Option.isSome(packagedEntry) ? packagedEntry.value : "apps/local/server/src/bin.ts",
    );
    const registry = yield* Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(Config.option);
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-serve-stop-" });
    const port = yield* freePort;
    const { reader, env } = yield* setup(directory, `http://127.0.0.1:${port}`);
    const observed = yield* throughPipe(reader, localEntryCommand(entry, args), {
      HOME: directory,
      DO_NOT_TRACK: "1",
      EXECUTOR_NO_UPDATE_CHECK: "1",
      EXECUTOR_API_KEY: randomBytes(32).toString("hex"),
      EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      EXECUTOR_DATA_DIR: path.join(directory, "data"),
      EXECUTOR_PORT: String(port),
      EXECUTOR_ENVIRONMENT: "e2e",
      EXECUTOR_WORKER_BUNDLE: path.resolve(".local/test-runtime/host.json"),
      ...(Option.isSome(registry) ? { EXECUTOR_NPM_REGISTRY: registry.value } : {}),
      ...env,
    });
    const diagnostics = yield* fs
      .readFileString(path.join(directory, "data", "diagnostics", "executor-local.jsonl"))
      .pipe(Effect.orElseSucceed(() => ""));
    const logged = diagnostics
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => String(Schema.decodeUnknownSync(LogLine)(line).message));
    return { ...observed, logged };
  });

layer(TestLive, { excludeTestServices: true })("Local serve shutdown", (it) => {
  it.effect(
    scenarios.localServeStalledOutput.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const stopped = yield* serveThrough(["serve"], (_, origin) =>
            Effect.succeed({ reader: { mode: "stalled", origin } }),
          );
          yield* evidence.json("serve-sigterm.json", stopped);
          expect(stopped.pipeFullAtSignal).toBe(true);
          expect(stopped.logged).toContain("Local server ready");
          expect(stopped.logged).toContain("Local server stopped");
          expect(stopped.signal).toBeNull();
          expect(stopped.code).toBe(130);
          expect(stopped.millisecondsAfterSignal).toBeLessThan(5_000);
        }),
      ),
    { timeout: 180_000 },
  );
  it.effect(
    scenarios.localServeClosedOutput.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            evidence = yield* Evidence;
          const stderrClosed = serveThrough(["serve"], (_, origin) =>
            Effect.succeed({ reader: { mode: "late", origin, stream: "stderr", holdMs: 32_000 } }),
          );
          const stdoutClosed = serveThrough(["--standalone"], (directory) =>
            Effect.gen(function* () {
              const bin = path.join(directory, "bin"),
                gate = path.join(directory, "stdout-closed");
              yield* fs.makeDirectory(bin);
              for (const opener of ["open", "xdg-open"])
                yield* fs.writeFileString(
                  path.join(bin, opener),
                  `#!/bin/sh\ni=0\nwhile [ ! -e '${gate}' ] && [ $i -lt 1200 ]; do sleep 0.1; i=$((i + 1)); done\nexit 1\n`,
                  { mode: 0o755 },
                );
              return {
                reader: { mode: "late", stream: "stdout", gate, holdMs: 2_000 },
                env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
              } as const;
            }).pipe(Effect.orDie),
          );
          const [afterStderr, afterStdout] = yield* Effect.all(
            [stderrClosed, process.platform === "win32" ? Effect.undefined : stdoutClosed],
            { concurrency: 2 },
          );
          yield* evidence.json("serve-stderr-closed.json", afterStderr);
          if (afterStdout !== undefined)
            yield* evidence.json("browser-stdout-closed.json", afterStdout);
          expect(afterStderr.answeredAfterClose).toBe(true);
          expect(afterStderr.signal).toBeNull();
          expect(afterStderr.code).toBe(130);
          expect(afterStderr.millisecondsAfterSignal).toBeLessThan(5_000);
          if (afterStdout !== undefined) {
            expect(afterStdout.answeredAfterClose).toBe(true);
            expect(afterStdout.startedProcesses).toBeGreaterThan(0);
            expect(afterStdout.stoppedAfterExit).toBe(true);
            expect(afterStdout.logged).toContain("Local server stopped");
            expect(afterStdout.signal).toBeNull();
            expect(afterStdout.code).toBe(130);
            expect(afterStdout.millisecondsAfterSignal).toBeLessThan(5_000);
          }
        }),
      ),
    { timeout: 180_000 },
  );
});
