import { randomBytes, randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Queue, Schedule, Schema } from "effect";
import { appsManifest, withApps } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { startLocalProduct, workerdProcess } from "../support/local-workflow-engines.ts";
import { holdingRegistry } from "../support/holding-registry.ts";
import { stalledPackage } from "../support/npm-registry.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
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
          const killRuntime = workerdProcess(local.directory).pipe(
            Effect.flatMap((pid) => Effect.sync(() => process.kill(pid, "SIGKILL"))),
          );
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
          const killed =
            process.platform === "win32" ? { exitCode: expect.any(Number) } : { signal: "SIGKILL" };

          const { app } = yield* local.json(App, "POST", "/v1/apps/deploy", {
            owner: "runtime-restart-e2e",
            name: `Runtime restart ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, query, object, string, router, workflow } from "apps";
export default defineApp({}, {
  workflows: {
    hold: workflow({ input: object({}) }, async (ctx) => {
      await ctx.step.sleep("hold", "1 day");
      return null;
    }),
  },
  tools: router({
    held: query({ input: object({}), output: string() }, async () => (await fetch(${JSON.stringify(`${holding.origin}/held`)})).text()),
    ready: query({ input: object({}), output: string() }, async () => "ready"),
  }),
});`,
              },
              appsManifest,
            ],
          });

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
          const target = yield* Target;
          const ownCollector = <A, E>(read: Effect.Effect<A, E, Telemetry>) =>
            read.pipe(
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
              Effect.provide(Telemetry.layer),
              Effect.provideService(Target, { ...target, directory: local.directory }),
            );
          const lostSpan = yield* ownCollector(
            Telemetry.pipe(
              Effect.flatMap((telemetry) =>
                telemetry.spans("runtime.workerd.call", { app: app.id }),
              ),
              Effect.flatMap((spans) => {
                const span = spans.find(
                  (tags) => tags["executor.runtime.rpc.opened"] !== undefined,
                );
                return span === undefined
                  ? Effect.fail(new Error("The lost call's span has not reached the collector"))
                  : Effect.succeed(span);
              }),
            ),
          );
          expect(lostSpan).toMatchObject({
            "executor.runtime.failure": "disconnected",
            "executor.runtime.rpc.opened": "true",
          });
          expect(
            lostSpan["executor.runtime.host.restarts"] === "0"
              ? lostSpan["executor.runtime.host.restarted_ms"] === undefined
              : lostSpan["executor.runtime.host.restarts"] === "1" &&
                  lostSpan["executor.runtime.host.restarted_ms"] !== undefined,
            JSON.stringify(lostSpan),
          ).toBe(true);
          expect(Number(lostSpan["executor.runtime.rpc.sent"])).toBeGreaterThan(0);
          expect(lostSpan["executor.runtime.rpc.closed_ms"]).toBeDefined();
          expect(
            yield* local.json(Schema.Unknown, "POST", "/v1/tools/call", {
              app: app.id,
              tool: "ready",
              input: {},
            }),
          ).toMatchObject({ status: "completed", value: "ready" });

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

          const run = yield* local.json(
            Schema.Struct({ id: Schema.String }),
            "POST",
            `/v1/apps/${app.id}/workflow-runs`,
            { workflow: "hold", input: {}, key: randomUUID() },
          );
          const afterKill = (seen: number) =>
            fs.readFileString(log).pipe(
              Effect.map((text) => ({
                stopped: text.includes("stopped after 3 restarts within 60 seconds"),
                restarts: text
                  .split("\n")
                  .filter((line) => line.includes('"App runtime restarted"')).length,
              })),
              Effect.flatMap((state) =>
                state.stopped || state.restarts > seen
                  ? Effect.succeed(state)
                  : Effect.fail(new Error(`${state.restarts} restarts logged, not stopped`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
            );
          let state = { stopped: false, restarts: 2 };
          for (let kill = 0; kill < 8 && !state.stopped; kill++) {
            yield* killRuntime;
            state = yield* afterKill(state.restarts);
          }
          expect(state.stopped, "the runtime stopped replacing workerd").toBe(true);
          const traceId = randomBytes(16).toString("hex");
          const read = yield* local.request(
            "GET",
            `/v1/apps/${app.id}/workflow-runs/${run.id}`,
            undefined,
            { traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` },
          );
          yield* (yield* Evidence).json("status-read.json", {
            status: read.status,
            body: read.text,
            logged: state,
          });
          expect(read.status, read.text).toBe(500);
          expect(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Failure))(read.text),
          ).toMatchObject({ _tag: "WorkflowFailure", reason: "engine" });
          const readSpan = yield* ownCollector(
            Telemetry.pipe(
              Effect.flatMap((telemetry) => telemetry.query(traceId)),
              Effect.flatMap((trace) => {
                const span = trace.data.find(
                  ({ span }) => span.tags["executor.runtime.http.route"] === "/workflow",
                );
                return span === undefined
                  ? Effect.fail(new Error("The status read's span has not reached the collector"))
                  : Effect.succeed(span.span.tags);
              }),
            ),
          );
          expect(readSpan).toMatchObject({
            "executor.runtime.http.method": "POST",
            "executor.runtime.http.stage": "request",
            "executor.runtime.http.reason": "TransportError",
            "executor.runtime.host.restarts": String(state.restarts),
          });
          expect(readSpan["executor.runtime.http.code"]).toBeDefined();
          expect(readSpan["executor.runtime.host.restarted_ms"]).toBeDefined();
          expect(readSpan).toMatchObject({
            "executor.runtime.http.connect_attempts": "2",
            "executor.runtime.http.first_attempt.error_code": "ECONNREFUSED",
            "executor.runtime.http.connect_outcome": "failed",
          });

          const unsent = yield* local.request("POST", "/v1/tools/call", {
            app: app.id,
            tool: "ready",
            input: {},
          });
          expect(unsent.status, unsent.text).toBe(502);
          const unsentBody = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                _tag: Schema.String,
                reason: Schema.String,
                notSent: Schema.optionalKey(Schema.Boolean),
                mayHaveWritten: Schema.optionalKey(Schema.Boolean),
              }),
            ),
          )(unsent.text);
          expect(unsentBody).toMatchObject({
            _tag: "ToolCallFailed",
            reason:
              "Executor could not connect to the app runtime, so it did not send this tool call.",
            notSent: true,
          });
          expect(unsentBody).not.toHaveProperty("mayHaveWritten");
          const unsentSpan = yield* ownCollector(
            Telemetry.pipe(
              Effect.flatMap((telemetry) =>
                telemetry.spans("runtime.workerd.call", { app: app.id }),
              ),
              Effect.flatMap((spans) => {
                const span = spans.find(
                  (tags) => tags["executor.runtime.failure"] === "unreachable",
                );
                return span === undefined
                  ? Effect.fail(new Error("The unsent call's span has not reached the collector"))
                  : Effect.succeed(span);
              }),
            ),
          );
          expect(unsentSpan).toMatchObject({
            "executor.runtime.rpc.connect_attempts": "2",
            "executor.runtime.rpc.first_attempt.error_code": "ECONNREFUSED",
            "executor.runtime.rpc.connect_outcome": "failed",
            "executor.runtime.rpc.opened": "false",
            "executor.runtime.rpc.sent": "0",
          });
        }),
      ),
    180_000,
  );
});
