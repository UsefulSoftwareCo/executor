import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Path, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { testCredential } from "../support/os-credential.ts";
import { freePort } from "../support/ports.ts";
import { scenarios } from "../test-plan.ts";

const Record = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
  state: Schema.Literals(["pending", "ready"]),
});

it.live(scenarios.localBootstrap.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const http = yield* HttpClient.HttpClient;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-keyring-e2e-" });
      const entry = path.resolve(yield* Config.String("EXECUTOR_E2E_LOCAL_ENTRY"));
      const port = yield* freePort;
      const env = {
        ...Object.fromEntries(
          [
            "PATH",
            "HOME",
            "USERPROFILE",
            "SystemRoot",
            "APPDATA",
            "LOCALAPPDATA",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
          ].flatMap((key) => {
            const value = process.env[key];
            return value === undefined ? [] : [[key, value] as const];
          }),
        ),
        EXECUTOR_DATA_DIR: directory,
        EXECUTOR_PORT: String(port),
        EXECUTOR_ENVIRONMENT: "e2e",
      };
      const readRecord = fs
        .readFileString(path.join(directory, "installation.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Record))));
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (yield* fs.exists(path.join(directory, "installation.json"))) {
            const record = yield* readRecord;
            const credential = yield* testCredential(record.id);
            if ((yield* credential.fingerprint) !== undefined) yield* credential.remove;
          }
        }).pipe(Effect.orDie),
      );
      const start = Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(
            ChildProcess.make("node", [entry, "serve"], {
              cwd: directory,
              env,
              extendEnv: false,
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
              forceKillAfter: 5_000,
            }),
          );
          yield* child.stdout.pipe(Stream.runDrain, Effect.forkScoped);
          yield* child.stderr.pipe(Stream.runDrain, Effect.forkScoped);
          const ready = http.get(`http://127.0.0.1:${port}/auth/session`).pipe(
            Effect.flatMap((response) => response.json),
            Effect.timeout(2_000),
            Effect.retry({ schedule: Schedule.spaced(200), times: 200 }),
          );
          const exited = child.exitCode.pipe(
            Effect.flatMap(() => Effect.fail(new Error("Packaged CLI exited before readiness"))),
          );
          expect(yield* Effect.raceFirst(ready, exited)).toEqual({ authenticated: false });
        }),
      );
      yield* start;
      const installation = yield* readRecord;
      expect(installation.state).toBe("ready");
      const credential = yield* testCredential(installation.id);
      const first = yield* credential.fingerprint;
      expect(typeof first === "string" && first.length === 64).toBe(true);
      yield* start;
      expect((yield* readRecord).id).toBe(installation.id);
      expect((yield* credential.fingerprint) === first).toBe(true);

      // Delete only this test's generated OS entry, then check refusal through the actual CLI.
      yield* credential.remove;
      const child = yield* processes.spawn(
        ChildProcess.make("node", [entry, "serve"], {
          cwd: directory,
          env,
          extendEnv: false,
          stdout: "ignore",
          stderr: "pipe",
        }),
      );
      const [code, message] = yield* Effect.all(
        [child.exitCode, child.stderr.pipe(Stream.decodeText, Stream.mkString)],
        { concurrency: 2 },
      );
      expect(Number(code)).toBe(1);
      expect(message).toContain("OS credential is missing");
      expect((yield* readRecord).id).toBe(installation.id);
      expect((yield* credential.fingerprint) === undefined).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);
