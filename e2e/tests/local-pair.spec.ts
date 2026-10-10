/** Run the real `executor pair` against a server the scenario starts with its own data directory. */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Path, Schedule, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { freePort } from "../support/ports.ts";

layer(TestLive, { excludeTestServices: true })("Local pair", (it) => {
  it.effect(scenarios.localPair.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path,
          processes = yield* ChildProcessSpawner.ChildProcessSpawner,
          http = yield* HttpClient.HttpClient,
          evidence = yield* Evidence;
        const entry = path.resolve(
          yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
            Config.withDefault("apps/local/server/src/bin.ts"),
          ),
        );
        const command = (subcommand: string, directory: string, port: number) =>
          ChildProcess.make("node", [entry, subcommand], {
            extendEnv: false,
            env: {
              PATH: process.env.PATH ?? "",
              // Release scenarios never send product analytics, even from a build with a baked key.
              DO_NOT_TRACK: "1",
              EXECUTOR_ENVIRONMENT: "e2e",
              // Keys stay in keys.json so no run touches the machine's OS credential store.
              EXECUTOR_KEY_STORAGE: "file",
              EXECUTOR_WORKER_BUNDLE: path.resolve(".local/test-runtime/host.json"),
              EXECUTOR_DATA_DIR: directory,
              EXECUTOR_PORT: String(port),
            },
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "3 seconds",
          });
        const pair = (directory: string, port: number) =>
          evidence.step(
            `executor pair (${path.basename(directory)}, port ${port})`,
            Effect.scoped(
              Effect.gen(function* () {
                const child = yield* processes.spawn(command("pair", directory, port));
                const [code, stdout, stderr] = yield* Effect.all(
                  [
                    child.exitCode,
                    child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                    child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                  ],
                  { concurrency: 3 },
                ).pipe(Effect.timeout("30 seconds"));
                return { code: Number(code), stdout, stderr };
              }),
            ),
          );

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-pair-" });
        const running = path.join(root, "running");
        const port = yield* freePort;
        const server = yield* processes.spawn(command("serve", running, port));
        yield* server.stdout.pipe(Stream.runDrain, Effect.forkScoped);
        yield* server.stderr.pipe(Stream.runDrain, Effect.forkScoped);
        const ready = http.get(`http://127.0.0.1:${port}/auth/session`).pipe(
          Effect.flatMap((response) => response.json),
          Effect.timeout("2 seconds"),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
        );
        const exited = server.exitCode.pipe(
          Effect.flatMap(() => Effect.fail(new Error("executor serve exited before readiness"))),
        );
        expect(yield* Effect.raceFirst(ready, exited)).toEqual({ authenticated: false });

        // The running server's own directory pairs.
        const paired = yield* pair(running, port);
        expect(paired.code, paired.stderr).toBe(0);
        expect(paired.stdout).toContain(`http://127.0.0.1:${port}/`);

        // A directory without saved keys is refused, and not even the directory is created.
        const other = path.join(root, "other");
        const refused = yield* pair(other, port);
        yield* evidence.json("no-saved-keys.json", refused);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("has no saved keys");
        expect(yield* fs.exists(other)).toBe(false);

        // A port with no server says so instead of blaming the keys.
        const silent = yield* pair(running, yield* freePort);
        yield* evidence.json("no-server.json", silent);
        expect(silent.code).toBe(1);
        expect(silent.stderr).toContain("No Executor server answered on 127.0.0.1:");
      }),
    ),
  );
});
