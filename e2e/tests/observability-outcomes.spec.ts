/** Observe real API/MCP outcomes after app execution and collector ingestion. */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { mcpOutcomeFixture } from "../support/mcp-outcome-fixture.ts";
import { WorkflowRun } from "../support/workflow-app.ts";
import { Target } from "../support/platform.ts";
import { awaitSentryEvents, traceEvents } from "../support/sentry-events.ts";

const Analytics = Schema.fromJsonString(
  Schema.Struct({
    batch: Schema.Array(
      Schema.Struct({
        event: Schema.String,
        properties: Schema.Record(Schema.String, Schema.Json),
      }),
    ),
  }),
);

layer(HostedLive, { excludeTestServices: true })("Observability outcomes", (it) => {
  it.effect(scenarios.observabilityOutcomes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const telemetry = yield* Telemetry,
          target = yield* Target,
          fs = yield* FileSystem.FileSystem;
        expect(target.metadata.mode).toBe("managed");
        const upstream = yield* mcpOutcomeFixture;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Observation ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "package.json",
              content: JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.30.0" } }),
            },
            {
              path: "index.ts",
              content: `import { defineApp, query, mutation, workflow, object } from "apps";
import { mcpOperations } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => {
  const remote = await mcpOperations({ url: ${JSON.stringify(`${upstream}/mcp`)} });
  return { ...remote, queries: {
    lookalike: query({ input: object({}) }, async () => ({ isError: true, content: [] })),
    bulk: query({ input: object({}) }, async ({ fetch }) => {
      for (let index = 0; index < 340; index++) await (await fetch(${JSON.stringify(`${upstream}/ping`)})).text();
      return { requests: 340 };
    }),
  }, workflows: { observed: workflow({ input: object({}) }, async (ctx) => ctx.step.do("observed-step", async () => "done")) }, mutations: { crash: mutation({ input: object({}) }, async () => { throw new Error("private-fixture-message"); }) } };
});`,
            },
          ],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const latestTrace = () =>
          evidence.requests.pipe(
            Effect.map((requests) => {
              const id = requests.at(-1)?.traceId;
              if (id === undefined) throw new Error("The request trace was not recorded");
              return id;
            }),
          );
        const waitFor = (id: string, name: string, providerSpans?: number) =>
          telemetry.query(id).pipe(
            Effect.flatMap((result) =>
              result.data.some(({ span }) => span.operationName === name) &&
              (providerSpans === undefined ||
                result.data.filter(({ span }) => span.operationName === "provider.http.request")
                  .length === providerSpans)
                ? Effect.succeed(result)
                : Effect.fail(new Error(`Missing delivered ${name} span`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
          );
        for (const [tool, failed] of [
          ["queries.failure", true],
          ["queries.lookalike", false],
        ] as const) {
          const called = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { tool, input: {} },
          );
          expect(called.status).toBe(200);
          expect(called.body).toMatchObject({ isError: true });
          const id = yield* latestTrace();
          const trace = yield* waitFor(id, "sdk.tools.call");
          expect(
            trace.data.find(({ span }) => span.operationName === "sdk.tools.call")?.span.status,
          ).toBe(failed ? "error" : "ok");
          yield* evidence.json(`${tool}-trace.json`, trace);
          if (target.metadata.target === "cloud") {
            const events = yield* fs.readFileString(`${target.directory}/analytics.ndjson`).pipe(
              Effect.map((text) =>
                text
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .flatMap((line) => Schema.decodeUnknownSync(Analytics)(line).batch),
              ),
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                until: (events) =>
                  events.some(
                    (event) =>
                      event.event === "tool_execution_completed" &&
                      event.properties.app_id === app.id &&
                      event.properties.tool_name === tool,
                  ),
              }),
              Effect.timeout("10 seconds"),
            );
            const event = events.find(
              (event) =>
                event.event === "tool_execution_completed" &&
                event.properties.app_id === app.id &&
                event.properties.tool_name === tool,
            );
            expect(event?.properties).toMatchObject({
              ok: !failed,
              outcome: failed ? "failure" : "success",
              trace_id: id,
              organization_id: actors.organization.id,
            });
            expect(event?.properties.operation_id).toEqual(expect.any(String));
            yield* evidence.json(`${tool}-analytics.json`, event);
          }
        }
        const bulk = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          { tool: "queries.bulk", input: {} },
        );
        expect(bulk.status).toBe(200);
        expect(bulk.body).toEqual({ requests: 340 });
        // App and host spans arrive in separate export batches. Wait for the complete trace.
        const bulkTrace = yield* waitFor(yield* latestTrace(), "sdk.tools.call", 340);
        expect(
          bulkTrace.data.filter(({ span }) => span.operationName === "provider.http.request"),
        ).toHaveLength(340);
        yield* evidence.json("large-invocation.json", bulkTrace);
        const failure = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          { tool: "mutations.crash", input: {} },
        );
        expect(failure.status).toBeGreaterThanOrEqual(500);
        const failureTrace = yield* latestTrace();
        if (target.metadata.target === "cloud") {
          const events = traceEvents(
            yield* awaitSentryEvents((events) => traceEvents(events, failureTrace).length > 0),
            failureTrace,
          );
          expect(events).toHaveLength(1);
          expect(events[0]?.user?.id).toEqual(expect.any(String));
          expect(events[0]?.tags?.organization_id).toBe(actors.organization.id);
          expect(JSON.stringify(events)).not.toContain("private-fixture-message");
          yield* evidence.json("typed-api-error.json", events);
        }
        if (target.metadata.target === "cloud") {
          const started = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/workflow-runs`,
            { workflow: "observed", input: {} },
          );
          expect(started.status).toBe(200);
          const run = yield* body(WorkflowRun, started);
          const initiation = yield* waitFor(yield* latestTrace(), "workflow.start");
          expect(
            initiation.data.find(({ span }) => span.operationName === "workflow.start")?.span.tags[
              "executor.run.id"
            ],
          ).toBe(run.id);
          yield* evidence.json("workflow-initiation-trace.json", initiation);
          const event = yield* fs.readFileString(`${target.directory}/analytics.ndjson`).pipe(
            Effect.map((text) =>
              text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => Schema.decodeUnknownSync(Analytics)(line).batch)
                .find(
                  (event) =>
                    event.event === "workflow_attempt_completed" &&
                    event.properties.run_id === run.id,
                ),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (event) => event !== undefined,
            }),
            Effect.timeout("40 seconds"),
          );
          expect(event?.properties).toMatchObject({ ok: true, outcome: "success" });
          const id = yield* Schema.decodeUnknownEffect(Schema.String)(event?.properties.trace_id);
          const trace = yield* waitFor(id, "workflow.attempt");
          for (const name of ["workflow.run", "workflow.step", "runtime.cloud.workflow"])
            expect(
              trace.data.some(({ span }) => span.operationName === name),
              name,
            ).toBe(true);
          const step = trace.data.find(({ span }) => span.operationName === "workflow.step");
          expect(step?.span.tags).toMatchObject({
            "executor.run.id": run.id,
            "executor.attempt.id": expect.any(String),
          });
          yield* evidence.json("workflow-trace.json", trace);
        }
        const key = yield* body(
          Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Observation fixture",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* (yield* McpClient).connect(
          Redacted.make(Redacted.value(key.key)),
          "observability",
          { organization: actors.organization.id },
        );
        const syntax = yield* client.use("A syntax error remains an MCP result", (client, signal) =>
          client.callTool({ name: "execute", arguments: { code: "return (" } }, undefined, {
            signal,
          }),
        );
        expect(syntax.structuredContent).toMatchObject({
          status: "completed",
          execution: { ok: false },
        });
        const syntaxTrace = yield* waitFor(yield* latestTrace(), "mcp.execute");
        expect(
          syntaxTrace.data.find(({ span }) => span.operationName === "mcp.execute")?.span,
        ).toMatchObject({
          status: "error",
          tags: { "executor.outcome": "failed", "error.type": "ParseError" },
        });
        yield* evidence.json("mcp-syntax-error.json", syntaxTrace);
        const traceId = randomUUID().replaceAll("-", "");
        const unsampled = yield* actors.owner.send("GET", `${prefix}/inventory`, undefined, {
          traceparent: `00-${traceId}-1234567890abcdef-00`,
        });
        expect(unsampled.status).toBe(200);
        yield* evidence.json(
          "unsampled-request.json",
          yield* waitFor(traceId, "product.operation"),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
