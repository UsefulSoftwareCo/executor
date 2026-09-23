import { AppSlug } from "@executor-js/sdk/core";
/** Cached protocol handlers must inherit each request, not the request which built them. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { defaultMcpLimits, McpExecutionResult, mcp, type McpBackend } from "@executor-js/mcp";
import { AppId, ApprovalRequestId, DeploymentId, OwnerId, ToolName } from "@executor-js/sdk/core";
import { telemetryLayer } from "@executor-js/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Layer, ManagedRuntime, RcMap, Schema } from "effect";
import { McpProtocol } from "effect/unstable/ai";
import { HttpRouter, HttpServer } from "effect/unstable/http";

const Span = Schema.Struct({
  name: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optionalKey(Schema.String),
});
const Batch = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(Span) })),
      }),
    ),
  }),
);
const app = AppId.make("app_trace_fixture");
const deployment = DeploymentId.make("dpl_trace_fixture");

for (const protocol of ["2025-11-25", "2026-07-28"]) {
  test(
    `cached MCP ${protocol} handlers follow fresh HTTP parents through execute and resume`,
    { timeout: 20_000 },
    async () => {
      const batches: string[] = [];
      const collector = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        batches.push(body);
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
      const address = collector.address();
      assert.ok(address !== null && typeof address !== "string");
      const calls: string[] = [];
      const backend: McpBackend<Error> = {
        listSkills: () => Effect.die("Unexpected skill listing"),
        readSkill: () => Effect.die("Unexpected skill read"),
        authorizeElicitation: () => Effect.void,
        listTargets: () => Effect.succeed([{ kind: "app" }]),
        listApps: () =>
          Effect.succeed([{ id: app, slug: AppSlug.make("fixture"), name: "Trace fixture" }]),
        listTools: () =>
          Effect.succeed({
            deployment,
            items: ["before", "guarded", "after"].map((name) => ({
              app,
              deployment,
              name: ToolName.make(name),
              description: name,
              inputSchema: { type: "object" },
            })),
          }),
        callTool: (input) =>
          Effect.sync(() => {
            if (input.tool === "guarded")
              return {
                status: "approval-required" as const,
                requestId: ApprovalRequestId.make("apr_trace_fixture"),
                expiresAt: Date.now() + 900_000,
                elicitation: {
                  mode: "form" as const,
                  message: "Approve?",
                  requestedSchema: { type: "object" as const, properties: {} },
                },
                invocation: {
                  app,
                  deployment,
                  owner: OwnerId.make("fixture"),
                  tool: input.tool,
                  input: {},
                  accounts: {},
                },
              };
            calls.push(input.tool);
            return { status: "completed" as const, value: input.tool };
          }).pipe(Effect.withSpan(`fixture.${input.tool}`)),
        resumeInvocation: () =>
          Effect.sync(() => {
            calls.push("approved");
            return { status: "completed" as const, value: "approved" };
          }).pipe(Effect.withSpan("fixture.approved")),
      };
      const runtime = ManagedRuntime.make(
        HttpRouter.serve(
          Layer.unwrap(
            Effect.gen(function* () {
              const sessions = yield* RcMap.make({
                lookup: () =>
                  Effect.gen(function* () {
                    return yield* mcp({
                      backend,
                      limits: defaultMcpLimits,
                      protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
                    }).pipe(
                      HttpRouter.toHttpEffect,
                      Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
                    );
                  }),
                idleTimeToLive: "1 minute",
              });
              return HttpRouter.add(
                "*",
                "/mcp",
                Effect.flatMap(RcMap.get(sessions, "fixture"), (handler) => handler),
              );
            }),
          ),
          { disableLogger: true },
        ).pipe(
          Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
          Layer.provide(
            telemetryLayer(
              {
                service: "mcp-trace-test",
                version: "test",
                environment: "test",
                traces: { url: `http://127.0.0.1:${address.port}/v1/traces` },
              },
              "event",
            ),
          ),
        ),
      );
      let client: Client | undefined;
      try {
        const server = await runtime.runPromise(HttpServer.HttpServer);
        assert.equal(server.address._tag, "InetAddressV4");
        if (server.address._tag !== "InetAddressV4") throw new Error("TCP listener required");
        const url = new URL(`http://127.0.0.1:${server.address.port}/mcp`);
        let parent: string | undefined = `00-${"11".repeat(16)}-${"22".repeat(8)}-01`;
        let id = 0;
        let invoke: (name: string, input: Record<string, unknown>) => Promise<unknown>;
        if (protocol === "2025-11-25") {
          client = new Client({ name: "trace-test", version: "1" });
          const transport = new StreamableHTTPClientTransport(url, {
            fetch: (input, init) => {
              const headers = new Headers(init?.headers);
              if (parent !== undefined) headers.set("traceparent", parent);
              return fetch(input, { ...init, headers });
            },
          });
          const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
          await client.connect(compatible);
          const connected = client;
          invoke = async (name, input) =>
            (await connected.callTool({ name, arguments: input })).structuredContent;
        } else {
          const request = async (method: string, params: Record<string, unknown>) => {
            const response = await fetch(url, {
              method: "POST",
              headers: {
                "Mcp-Protocol-Version": protocol,
                "Mcp-Method": method,
                ...("name" in params && typeof params.name === "string"
                  ? { "Mcp-Name": params.name }
                  : {}),
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...(parent === undefined ? {} : { traceparent: parent }),
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: ++id,
                method,
                params: {
                  ...params,
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": protocol,
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                },
              }),
            });
            assert.equal(
              response.status,
              200,
              response.status === 200
                ? "Expected a successful MCP response"
                : await response.text(),
            );
            return Schema.decodeUnknownSync(
              Schema.Struct({ result: Schema.Record(Schema.String, Schema.Unknown) }),
            )(await response.json()).result;
          };
          await request("server/discover", {});
          invoke = async (name, input) =>
            (await request("tools/call", { name, arguments: input })).structuredContent;
        }
        parent = `00-${"33".repeat(16)}-${"44".repeat(8)}-01`;
        const paused = Schema.decodeUnknownSync(McpExecutionResult)(
          await invoke("execute", {
            code: "await tools.fixture.before({}); await tools.fixture.guarded({}); return await tools.fixture.after({});",
          }),
        );
        assert.equal(paused.status, "approval-required");
        if (paused.status !== "approval-required") throw new Error("Expected approval");
        parent = `00-${"55".repeat(16)}-${"66".repeat(8)}-01`;
        const resumed = Schema.decodeUnknownSync(McpExecutionResult)(
          await invoke("resume", { requestId: paused.requestId, response: { action: "accept" } }),
        );
        assert.equal(resumed.status, "completed");
        if (resumed.status === "completed") {
          assert.ok(resumed.execution.ok);
          assert.equal(resumed.execution.value, "after");
        }
        assert.deepEqual(calls, ["before", "approved", "after"]);
        parent = undefined;
        await invoke("execute", { code: "return 42" });
        await invoke("execute", { code: "return 43" });
        // A final round trip lets the preceding response's scheduled HTTP span end
        // before disposing the exporter.
        await (await fetch(url)).body?.cancel();
        await client?.close();
        client = undefined;
        await runtime.dispose();
        const spans = batches.flatMap((body) =>
          Schema.decodeUnknownSync(Batch)(body).resourceSpans.flatMap((r) =>
            r.scopeSpans.flatMap((s) => s.spans),
          ),
        );
        for (const [name, trace] of [
          ["mcp.execute", "33"],
          ["fixture.before", "33"],
          ["fixture.guarded", "33"],
          ["mcp.resume", "55"],
          ["fixture.approved", "55"],
          ["fixture.after", "55"],
        ] as const) {
          assert.ok(
            spans.some((span) => span.name === name && span.traceId === trace.repeat(16)),
            `${name} must follow its active request`,
          );
        }
        assert.equal(
          spans.filter((span) => span.name === "mcp.tool.call" && span.traceId === "33".repeat(16))
            .length,
          2,
        );
        assert.equal(
          spans.filter((span) => span.name === "mcp.tool.call" && span.traceId === "55".repeat(16))
            .length,
          1,
        );
        assert.ok(
          spans.some((span) => span.name === "mcp.tool.resume" && span.traceId === "55".repeat(16)),
        );
        const executes = spans.filter((span) => span.name === "mcp.execute");
        assert.equal(executes.length, 3);
        assert.equal(
          new Set(executes.map((span) => span.traceId)).size,
          3,
          "calls without incoming context need independent traces",
        );
        for (const span of spans.filter(
          (span) => span.name === "mcp.execute" || span.name === "mcp.resume",
        )) {
          const rpc = spans.find((candidate) => candidate.spanId === span.parentSpanId);
          assert.equal(rpc?.name, `McpServer.@effect/mcp/${protocol}/tools/call`);
          const http = spans.find((candidate) => candidate.spanId === rpc?.parentSpanId);
          assert.equal(http?.name, "http.server POST");
          assert.equal(http?.traceId, span.traceId);
          if (span.traceId === "33".repeat(16)) assert.equal(http?.parentSpanId, "44".repeat(8));
          if (span.traceId === "55".repeat(16)) assert.equal(http?.parentSpanId, "66".repeat(8));
        }
      } finally {
        await client?.close();
        await runtime.dispose();
        await new Promise<void>((resolve) => collector.close(() => resolve()));
      }
    },
  );
}
