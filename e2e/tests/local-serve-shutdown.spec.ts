/** The real local server while nothing reads its output, or after its reader goes away. */
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

/**
 * Start the server with these arguments under one of the pipe readers and return what the reader
 * saw, with the messages the server logged. `setup` chooses the reader for the server's origin and
 * adds to its environment, given the server's own temporary directory.
 */
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
    // Startup deploys the bundled Executor app, which pins this checkout's apps release.
    const registry = yield* Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(Config.option);
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-serve-stop-" });
    const port = yield* freePort;
    const { reader, env } = yield* setup(directory, `http://127.0.0.1:${port}`);
    const observed = yield* throughPipe(reader, localEntryCommand(entry, args), {
      HOME: directory,
      // Release scenarios never send product analytics, even from a build with a baked key.
      DO_NOT_TRACK: "1",
      // Scenarios never reach the public registry.
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
    // Every log line also goes to the data directory's diagnostics, which shutdown writes last.
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
          // serve logs on stderr, here into a pipe already full, and prints its connection link on
          // stdout only after logging that it is ready. Shutdown waited for the logs it could not
          // write until something read the pipe, so SIGTERM never finished.
          const stopped = yield* serveThrough(["serve"], (_, origin) =>
            Effect.succeed({ reader: { mode: "stalled", origin } }),
          );
          yield* evidence.json("serve-sigterm.json", stopped);
          expect(stopped.pipeFullAtSignal).toBe(true);
          // Its shutdown finished: the last log of the product's scope reached the diagnostics.
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
          // A closed stdout or stderr pipe ended the server with exit code 0, so its clients lost
          // it. Each reader closes one pipe once the server answers, and the server then writes
          // that stream again with output it always prints.
          //
          // `serve` logs a runtime sample on stderr every 30 seconds.
          const stderrClosed = serveThrough(["serve"], (_, origin) =>
            Effect.succeed({ reader: { mode: "late", origin, stream: "stderr", holdMs: 32_000 } }),
          );
          // `executor --standalone` serves in the foreground. It opens the connection link in a
          // browser and, when the opener fails, prints on stdout to open it by hand. The stand-in
          // opener fails once the reader has closed stdout. Windows opens links through rundll32,
          // which has no stand-in. Its private server picks its own port, which it prints.
          const stdoutClosed = serveThrough(["--standalone"], (directory) =>
            Effect.gen(function* () {
              const bin = path.join(directory, "bin"),
                gate = path.join(directory, "stdout-closed");
              yield* fs.makeDirectory(bin);
              for (const opener of ["open", "xdg-open"])
                yield* fs.writeFileString(
                  path.join(bin, opener),
                  // Gives up after two minutes if the reader never closes stdout.
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
            // The private server's log stays in its own process. Its port refused connections
            // once it stopped, and its shutdown reached the shared diagnostics.
            expect(afterStdout.refusedAfterExit).toBe(true);
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
