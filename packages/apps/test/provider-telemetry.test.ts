/** Real provider connections must keep operation phases in the invoking trace. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { buildSchema, graphql } from "graphql";
import { collectTelemetry } from "@executor-js/telemetry";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { mcpToolsEffect } from "../src/implementation/mcp.ts";
import { graphqlToolsEffect } from "../src/implementation/graphql.ts";
import { openapiToolsEffect } from "../src/implementation/openapi.ts";
import { stdioToolsEffect } from "../src/implementation/mcp-stdio.ts";
import { withRemoteMcp } from "../../../apps/local/server/test/fixtures/remote-mcp.ts";

const Export = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                traceId: Schema.String,
                spanId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
                attributes: Schema.Array(
                  Schema.Struct({
                    key: Schema.String,
                    value: Schema.Record(Schema.String, Schema.Json),
                  }),
                ),
                status: Schema.Struct({ code: Schema.Number }),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);
const spans = (traces: readonly string[]) =>
  traces.flatMap((body) =>
    Schema.decodeUnknownSync(Export)(body).resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );

for (const transport of ["json", "streaming", "legacy"] as const) {
  test(`MCP ${transport} discovery and later calls have distinct traces with connection, request and cleanup phases`, async () => {
    await withRemoteMcp(
      { streaming: transport === "streaming", legacy: transport === "legacy" },
      async ({ url, sessions }) => {
        const collected = await Effect.runPromise(
          collectTelemetry(
            Effect.gen(function* () {
              const tools = yield* mcpToolsEffect({ url }).pipe(Effect.withSpan("discovery"));
              const tool = tools.public;
              assert.ok(tool);
              yield* tool.run({}, { value: "hello" }).pipe(Effect.withSpan("invocation"));
            }),
          ),
        );
        // The peer observes SSE socket closure asynchronously, after the client closes.
        for (let attempt = 0; sessions.size !== 0 && attempt < 100; attempt++) await delay(10);
        assert.equal(sessions.size, 0);
        const records = spans(collected.telemetry.traces);
        const discovery = records.find((span) => span.name === "discovery");
        const invocation = records.find((span) => span.name === "invocation");
        assert.ok(discovery && invocation);
        assert.notEqual(discovery.traceId, invocation.traceId);
        for (const root of [discovery, invocation]) {
          const related = records.filter((span) => span.traceId === root.traceId);
          for (const name of [
            "provider.mcp.session",
            "provider.mcp.connect",
            "provider.mcp.request",
            "provider.mcp.close",
          ]) {
            assert.ok(
              related.some((span) => span.name === name),
              `Missing ${name}`,
            );
          }
          assert.ok(
            related
              .filter((span) => span.spanId !== root.spanId)
              .every((span) => related.some((parent) => parent.spanId === span.parentSpanId)),
            "Every phase has a parent in this invocation",
          );
        }
        const requests = records.filter(
          (span) => span.name === "provider.mcp.request" && span.traceId === discovery.traceId,
        );
        assert.equal(requests.length, 2, "Each catalog page has its own request duration");
        assert.equal(records.filter((span) => span.name === "provider.mcp.call").length, 1);
      },
    );
  });
}

test("cancelled MCP request keeps interrupted spans and closes its transport", async () => {
  const started = Deferred.makeUnsafe<void>();
  await withRemoteMcp(
    { hang: true, onCall: () => Deferred.doneUnsafe(started, Effect.void) },
    async ({ url, sessions }) => {
      const collected = await Effect.runPromise(
        collectTelemetry(
          Effect.scoped(
            Effect.gen(function* () {
              const tools = yield* mcpToolsEffect({ url });
              const tool = tools.public;
              assert.ok(tool);
              const fiber = yield* tool.run({}, { value: "hello" }).pipe(Effect.forkChild);
              yield* Deferred.await(started);
              yield* Fiber.interrupt(fiber);
            }),
          ).pipe(Effect.withSpan("cancelled.invocation")),
        ),
      );
      assert.equal(sessions.size, 0);
      const records = spans(collected.telemetry.traces);
      const call = records.find((span) => span.name === "provider.mcp.call");
      assert.ok(call);
      assert.ok(
        call.attributes.some(
          (attribute) =>
            attribute.key === "status.interrupted" && attribute.value.boolValue === true,
        ),
      );
      const request = records.find(
        (span) =>
          span.name === "provider.mcp.request" &&
          span.attributes.some((attribute) => attribute.value.stringValue === "tools/call"),
      );
      assert.ok(request);
      assert.equal(request.traceId, call.traceId);
      assert.ok(
        request.attributes.some(
          (attribute) =>
            attribute.key === "status.interrupted" && attribute.value.boolValue === true,
        ),
      );
      assert.ok(
        records.some((span) => span.name === "provider.mcp.close" && span.traceId === call.traceId),
      );
    },
  );
});

test("MCP tool error results retain protocol semantics and an explicit error attribute", async () => {
  await withRemoteMcp({}, async ({ url }) => {
    const collected = await Effect.runPromise(
      collectTelemetry(
        Effect.gen(function* () {
          const tools = yield* mcpToolsEffect({ url });
          const tool = tools.failure;
          assert.ok(tool);
          return yield* tool.run({}, {});
        }).pipe(Effect.withSpan("tool.error")),
      ),
    );
    assert.equal(collected.value.isError, true);
    assert.ok(
      spans(collected.telemetry.traces).some(
        (span) =>
          span.name === "provider.mcp.request" &&
          span.attributes.some(
            (attribute) =>
              attribute.key === "mcp.tool.is_error" && attribute.value.boolValue === true,
          ),
      ),
    );
  });
});

test("stdio instrumentation includes process initialization, paging, execution and close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-telemetry-"));
  try {
    const collected = await Effect.runPromise(
      collectTelemetry(
        Effect.gen(function* () {
          const tools = yield* stdioToolsEffect({
            command: process.execPath,
            args: [
              new URL("../../../apps/local/server/test/fixtures/stdio-mcp.ts", import.meta.url)
                .pathname,
              directory,
            ],
            env: {},
            timeoutMs: 3_000,
          });
          const tool = tools.public;
          assert.ok(tool);
          return yield* tool.run({}, { value: "hello" });
        }).pipe(Effect.withSpan("stdio.invocation")),
      ),
    );
    assert.deepEqual(collected.value.structuredContent?.account, "public");
    const records = spans(collected.telemetry.traces);
    for (const name of ["provider.mcp.session", "provider.mcp.connect", "provider.mcp.close"]) {
      assert.equal(records.filter((span) => span.name === name).length, 2);
    }
    assert.equal(new Set(records.map((span) => span.traceId)).size, 1);
    assert.equal(records.filter((span) => span.name === "provider.mcp.request").length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GraphQL and OpenAPI separate provider response reading and retain request failures", async () => {
  const schema = buildSchema("type Query { ping: String }");
  let failing = false;
  const peer = createServer(async (request, response) => {
    if (request.url === "/graphql") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ query: Schema.String })),
      )(body);
      const result = failing
        ? { errors: [{ message: "synthetic failure" }] }
        : await graphql({ schema, source: input.query, rootValue: { ping: "pong" } });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } else {
      response
        .writeHead(failing ? 503 : 200, { "content-type": "application/json" })
        .end('{"ping":"pong"}');
    }
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  try {
    const address = peer.address();
    assert.ok(address !== null && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const collected = await Effect.runPromise(
      collectTelemetry(
        Effect.gen(function* () {
          const graphql = yield* graphqlToolsEffect({ url: `${url}/graphql` });
          const openapi = yield* openapiToolsEffect({
            operations: [
              {
                name: "ping",
                description: "Ping",
                method: "GET",
                path: "/ping",
                baseUrl: url,
                parameters: [],
                body: "none",
                security: [],
                input: { type: "object" },
              },
            ],
            methods: {},
            oauth: [],
          });
          const graph = graphql.query_ping;
          const open = openapi.ping;
          assert.ok(graph && open);
          assert.equal(yield* graph.run({}, {}), "pong");
          assert.deepEqual(yield* open.run({}, {}), { ping: "pong" });
          failing = true;
          assert.equal((yield* graph.run({}, {}).pipe(Effect.flip)).reason, "execution");
          assert.equal((yield* open.run({}, {}).pipe(Effect.flip)).status, 503);
        }).pipe(
          Effect.withSpan("providers.invocation"),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        ),
      ),
    );
    const records = spans(collected.telemetry.traces);
    assert.equal(new Set(records.map((span) => span.traceId)).size, 1);
    assert.equal(records.filter((span) => span.name === "provider.http.response.read").length, 4);
    for (const name of ["provider.graphql.call", "provider.openapi.call"]) {
      const calls = records.filter((span) => span.name === name);
      assert.equal(calls.length, 2);
      assert.ok(calls.some((span) => span.status.code === 1));
      assert.ok(calls.some((span) => span.status.code === 2));
    }
  } finally {
    peer.closeAllConnections();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
  }
});
