/** Start the actual local entry with failing resources and inspect its retained diagnostic. */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Stream, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { randomBytes } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";

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
          ? [packagedEntry.value, "serve"]
          : ["apps/local/server/src/main.ts"];
        for (const stage of ["listen", "storage", "runtime"] as const) {
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-startup-" });
          const secret = randomBytes(32).toString("hex");
          if (stage !== "listen")
            yield* fs.writeFileString(
              `${directory}/${stage === "storage" ? "executor.pglite" : "workerd"}`,
              "synthetic invalid resource",
            );
          const child = yield* processes.spawn(
            ChildProcess.make("node", command, {
              extendEnv: false,
              env: {
                PATH: process.env.PATH ?? "",
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
});
