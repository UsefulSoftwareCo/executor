/** Start the actual local entry with failing or missing resources and inspect its retained diagnostic. */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Layer, Option, Stream, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, SessionClients } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startManagedServer } from "../support/managed-server.ts";
import { freePort } from "../support/ports.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { localEntryCommand } from "../support/local-entry.ts";

layer(TestLive, { excludeTestServices: true })("Local startup diagnostics", (it) => {
  it.effect(scenarios.localStartupObservability.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const target = yield* Target,
          evidence = yield* Evidence;
        const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
          Config.option,
        );
        const command = Option.isSome(packagedEntry)
          ? localEntryCommand(packagedEntry.value, ["serve"])
          : { command: "node", args: ["apps/local/server/src/main.ts"] };
        for (const stage of ["listen", "storage", "runtime"] as const) {
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-startup-" });
          const secret = randomBytes(32).toString("hex");
          if (stage !== "listen")
            yield* fs.writeFileString(
              `${directory}/${stage === "storage" ? "executor.pglite" : "workerd"}`,
              "synthetic invalid resource",
            );
          const child = yield* processes.spawn(
            ChildProcess.make(command.command, command.args, {
              extendEnv: false,
              env: {
                PATH: process.env.PATH ?? "",
                // Release scenarios never send product analytics, even from a build with a baked key.
                DO_NOT_TRACK: "1",
                EXECUTOR_API_KEY: secret,
                EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
                EXECUTOR_DATA_DIR: directory,
                EXECUTOR_PORT: stage === "listen" ? new URL(target.metadata.origin).port : "0",
              },
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "3 seconds",
            }),
          );
          const [code] = yield* Effect.all([
            child.exitCode,
            child.stdout.pipe(Stream.merge(child.stderr), Stream.decodeText, Stream.mkString),
          ]).pipe(Effect.timeout("30 seconds"));
          expect(Number(code)).not.toBe(0);
          const logs = yield* fs.readFileString(`${directory}/diagnostics/executor-local.jsonl`);
          const Log = Schema.fromJsonString(
            Schema.Struct({
              message: Schema.String,
              annotations: Schema.Record(Schema.String, Schema.Unknown),
            }),
          );
          const failure = logs
            .trim()
            .split("\n")
            .map((line) => Schema.decodeUnknownSync(Log)(line))
            .find((log) => log.message === "Local server startup failed");
          expect(failure?.annotations["startup.stage"]).toBe(stage);
          if (stage === "listen") expect(failure?.annotations["error.code"]).toBe("EADDRINUSE");
          expect(logs).not.toContain(secret);
          expect(logs).not.toContain("synthetic invalid resource");
          yield* evidence.json(`startup-${stage}.json`, { logs });
        }
      }),
    ),
  );

  it.effect(scenarios.localWithoutTelemetryCollector.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          evidence = yield* Evidence,
          target = yield* Target;
        const directory = yield* fs.makeTempDirectory({
          directory: target.directory,
          prefix: "no-collector-",
        });
        const origin = `http://127.0.0.1:${yield* freePort}`;
        yield* startManagedServer(
          { ...target, directory, metadata: { ...target.metadata, origin, target: "local" } },
          "product",
          { EXECUTOR_MOTEL_BUNDLE: `${directory}/not-built` },
        );
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        expect((yield* api.request(yield* api.session(), "GET", "/auth/session")).status).toBe(200);
        // A collector restarted every 3 seconds, or an export waiting 3 seconds for one, would
        // have logged by now.
        yield* Effect.sleep("7 seconds");
        const messages = (yield* fs.readFileString(`${directory}/server.log`))
          .split("\n")
          .flatMap((line) => {
            const parsed = Schema.decodeUnknownOption(
              Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
            )(line);
            return Option.isSome(parsed) ? [parsed.value.message] : [];
          });
        yield* evidence.json("no-collector.json", { messages });
        expect(messages.filter((message) => message.includes("is not built at"))).toHaveLength(1);
        expect(messages).not.toContain("Local telemetry collector failed");
        expect(messages).not.toContain("Telemetry export failed");
      }),
    ),
  );
});
