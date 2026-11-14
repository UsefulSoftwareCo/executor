/**
 * Local and desktop run every app in one workerd process. When it exits on its own, as when V8
 * runs out of heap, the runtime starts a replacement on the same ports, and every call and build
 * in flight loses its connection. The product log records each replacement, a lost call says its
 * connection was lost, and a lost build tells its deployer the same instead of a class name.
 */
import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Queue, Schedule, Schema } from "effect";
import { appsManifest, withApps } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startLocalProduct, workerdProcess } from "../support/local-workflow-engines.ts";
import { holdingRegistry } from "../support/holding-registry.ts";
import { stalledPackage } from "../support/npm-registry.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
/** A refused request's error body. */
const Failure = Schema.Struct({
  _tag: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  stage: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
const Restart = Schema.Struct({
  message: Schema.Literal("App runtime restarted"),
  level: Schema.String,
  annotations: Schema.Struct({
    restarts: Schema.Number,
    exitCode: Schema.optionalKey(Schema.Number),
    signal: Schema.optionalKey(Schema.String),
  }),
});

layer(TestLive, { excludeTestServices: true })("Local app runtime restart", (it) => {
  it.effect(
    scenarios.localAppRuntimeRestart.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const holding = yield* holdingRegistry;
          const local = yield* startLocalProduct({ EXECUTOR_NPM_REGISTRY: holding.origin });
          const log = `${local.directory}/server.log`;
          const arrival = (name: string) =>
            Queue.take(holding.arrived).pipe(
              Effect.repeat({ until: (url) => url.toLowerCase().includes(name) }),
              Effect.timeout("30 seconds"),
            );
          /** Kill the product's workerd, as V8 aborting on heap exhaustion does. */
          const killRuntime = workerdProcess(local.directory).pipe(
            Effect.flatMap((pid) => Effect.sync(() => process.kill(pid, "SIGKILL"))),
          );
          /** The product log's runtime replacements, once it has recorded `count` of them. */
          const restarts = (count: number) =>
            fs.readFileString(log).pipe(
              Effect.map((text) =>
                text
                  .split("\n")
                  .filter((line) => line.includes('"App runtime restarted"'))
                  .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Restart))(line)),
              ),
              Effect.flatMap((lines) =>
                lines.length >= count
                  ? Effect.succeed(lines)
                  : Effect.fail(new Error(`${lines.length} of ${count} restarts logged`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
            );
          // The exit a kill gives: a signal on POSIX, Windows' termination code elsewhere.
          const killed =
            process.platform === "win32" ? { exitCode: expect.any(Number) } : { signal: "SIGKILL" };

          const { app } = yield* local.json(App, "POST", "/v1/apps/deploy", {
            owner: "runtime-restart-e2e",
            name: `Runtime restart ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, {
  tools: router({
    held: query({ input: object({}), output: string() }, async () => (await fetch(${JSON.stringify(`${holding.origin}/held`)})).text()),
    ready: query({ input: object({}), output: string() }, async () => "ready"),
  }),
});`,
              },
              appsManifest,
            ],
          });

          // A call whose tool is waiting inside workerd when workerd exits.
          const call = yield* local
            .request("POST", "/v1/tools/call", { app: app.id, tool: "held", input: {} })
            .pipe(Effect.forkScoped);
          yield* arrival("/held");
          yield* killRuntime;
          const lost = yield* Fiber.join(call);
          expect(lost.status, lost.text).toBe(502);
          expect(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Failure))(lost.text),
          ).toMatchObject({
            _tag: "ToolCallFailed",
            reason:
              "Executor did not receive a usable result from this tool call. The runtime’s error matches this cause, which Executor has not confirmed: The connection to the app's Worker was lost.",
          });
          const [first] = yield* restarts(1);
          expect(first).toMatchObject({ level: "WARN", annotations: { restarts: 1, ...killed } });
          // The replacement serves the next call.
          expect(
            yield* local.json(Schema.Unknown, "POST", "/v1/tools/call", {
              app: app.id,
              tool: "ready",
              input: {},
            }),
          ).toMatchObject({ status: "completed", value: "ready" });

          // A build whose compiler is waiting on the registry when workerd exits.
          const build = yield* local
            .request("POST", "/v1/apps/deploy", {
              owner: "runtime-restart-e2e",
              name: `Runtime restart build ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, query, object, router } from "apps";
import stalled from "${stalledPackage}";
export default defineApp({}, { tools: router({
  stalled: query({ input: object({}) }, async () => String(stalled)),
}) });`,
                },
                {
                  path: "package.json",
                  content: JSON.stringify({
                    type: "module",
                    dependencies: withApps({ [stalledPackage]: "1.0.0" }),
                  }),
                },
              ],
            })
            .pipe(Effect.forkScoped);
          yield* arrival("stalled-package");
          yield* killRuntime;
          const failed = yield* Fiber.join(build);
          expect(failed.status, failed.text).toBe(422);
          expect(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Failure))(failed.text),
          ).toMatchObject({
            _tag: "VersionBuildFailed",
            stage: "compile",
            message:
              "App build failed at the compile stage: The connection to the app's Worker was lost",
          });
          const [, second] = yield* restarts(2);
          expect(second).toMatchObject({ level: "WARN", annotations: { restarts: 2, ...killed } });
        }),
      ),
    180_000,
  );
});
