import { AppSlug } from "@executor-js/sdk/core";
/** Native approval delivery through real HTTP streams and the official MCP client. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitRequestSchema,
  type ClientCapabilities,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ApprovalRequestId,
  AppId,
  DeploymentId,
  OwnerId,
  ToolName,
  type ToolPending,
} from "@executor-js/sdk/core";
import { defaultMcpLimits, McpExecutionResult, mcp, type McpBackend } from "@executor-js/mcp";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { McpProtocol } from "effect/unstable/ai";
import { HttpRouter, HttpServer } from "effect/unstable/http";

const app = AppId.make("app_native_test");
const deployment = DeploymentId.make("dpl_native_test");
const owner = OwnerId.make("native-test");
const code =
  'const before = await tools.fixture.before({}); const a = await tools.fixture.guarded({value: "a"}); const b = await tools.fixture.guarded({value: "b"}); return {before, a, b, after: await tools.fixture.after({})};';
const guarded = 'return await tools.fixture.guarded({value: "original"});';
const form = { elicitation: { form: {} } } satisfies ClientCapabilities;

async function withHost(
  run: (host: {
    connect: (
      mode: string,
      capabilities?: ClientCapabilities,
    ) => Promise<{ client: Client; transport: StreamableHTTPClientTransport }>;
    url: URL;
    ledger: string[];
    requests: Array<typeof ToolPending.Type>;
  }) => Promise<void>,
  options: {
    ttlMs?: number;
    timeoutMs?: number;
    protocols?: Parameters<typeof mcp>[0]["protocols"];
  } = {},
) {
  const ledger: string[] = [];
  const requests: Array<typeof ToolPending.Type> = [];
  const pending = new Map<ApprovalRequestId, typeof ToolPending.Type>();
  const backend: McpBackend<Error> = {
    listSkills: () => Effect.die("Unexpected skill listing"),
    readSkill: () => Effect.die("Unexpected skill read"),
    authorizeElicitation: () => Effect.void,
    listTargets: () => Effect.succeed([{ kind: "app" }]),
    listApps: () => Effect.succeed([{ id: app, slug: AppSlug.make("fixture"), name: "Fixture" }]),
    listTools: () =>
      Effect.succeed({
        deployment,
        items: ["before", "guarded", "after"].map((name) => ({
          app,
          deployment,
          name: ToolName.make(name),
          description: name,
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        })),
      }),
    callTool: (input) =>
      Effect.sync(() => {
        if (input.tool !== "guarded") {
          ledger.push(input.tool);
          return { status: "completed" as const, value: input.tool };
        }
        const request: typeof ToolPending.Type = {
          status: "approval-required",
          requestId: ApprovalRequestId.make(`apr_${requests.length + 1}`),
          expiresAt: Date.now() + (options.ttlMs ?? 60_000),
          invocation: {
            app,
            deployment,
            owner,
            tool: input.tool,
            input: input.input ?? {},
            accounts: {},
          },
          elicitation: {
            mode: "form",
            message: `Approve ${JSON.stringify(input.input)}?`,
            requestedSchema: { type: "object", properties: {} },
          },
        };
        requests.push(request);
        pending.set(request.requestId, request);
        return request;
      }),
    resumeInvocation: (request, response) =>
      Effect.sync(() => {
        if (!pending.delete(request.requestId))
          return { status: "already-consumed" as const, requestId: request.requestId };
        if (response.action === "decline")
          return { status: "denied" as const, requestId: request.requestId };
        if (response.action === "cancel")
          return { status: "cancelled" as const, requestId: request.requestId };
        ledger.push("approved");
        return { status: "completed" as const, value: request.invocation.input };
      }),
  };
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(
      mcp({
        backend,
        limits: { ...defaultMcpLimits, timeoutMs: options.timeoutMs ?? 3000 },
        protocols: options.protocols ?? [
          McpProtocol.v2026_07_28,
          McpProtocol.v2025_11_25,
          McpProtocol.v2025_06_18,
        ],
      }),
      { disableLogger: true },
    ).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      Layer.provide(NodeServices.layer),
    ),
  );
  const clients: Client[] = [];
  try {
    const server = await runtime.runPromise(HttpServer.HttpServer);
    if (server.address._tag !== "InetAddressV4") throw new Error("TCP required");
    const url = new URL(`http://127.0.0.1:${server.address.port}/mcp`);
    await run({
      url,
      ledger,
      requests,
      connect: async (mode, capabilities = {}) => {
        const endpoint = new URL(url);
        if (mode) endpoint.searchParams.set("elicitation_mode", mode);
        const client = new Client({ name: "native-approval-test", version: "1" }, { capabilities });
        clients.push(client);
        const transport = new StreamableHTTPClientTransport(endpoint);
        const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
        await client.connect(compatible);
        return { client, transport };
      },
    });
  } finally {
    for (const client of clients) await client.close();
    await runtime.dispose();
  }
}

const execute = async (client: Client, source = guarded) =>
  client.callTool({ name: "execute", arguments: { code: source } });
const decode = Schema.decodeUnknownSync(McpExecutionResult);

test(
  "native query mode prompts twice in the same execute, excludes human wait, and hides resume",
  { timeout: 10_000 },
  async () => {
    await withHost(
      async ({ connect, ledger }) => {
        const { client } = await connect("native", form);
        assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
          "execute",
          "skills",
        ]);
        let prompts = 0;
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          assert.equal(request.method, "elicitation/create");
          assert.equal(request.params.mode, "form");
          assert.deepEqual(request.params.requestedSchema, { type: "object", properties: {} });
          assert.deepEqual(ledger, prompts === 0 ? ["before"] : ["before", "approved"]);
          prompts++;
          if (prompts === 1) await new Promise((resolve) => setTimeout(resolve, 750));
          return { action: "accept", content: {} };
        });
        const response = await execute(client, code);
        assert.notEqual(response.isError, true, JSON.stringify(response));
        const result = decode(response.structuredContent);
        assert.equal(result.status, "completed");
        if (result.status !== "completed" || !result.execution.ok)
          throw new Error(JSON.stringify(result));
        assert.deepEqual(result.execution.value, {
          before: "before",
          a: { value: "a" },
          b: { value: "b" },
          after: "after",
        });
        assert.equal(prompts, 2);
        assert.deepEqual(ledger, ["before", "approved", "approved", "after"]);
        const unavailable = await client
          .callTool({
            name: "resume",
            arguments: { requestId: "apr_1", response: { action: "accept" } },
          })
          .catch(() => null);
        assert.ok(unavailable === null || unavailable.isError);
      },
      { timeoutMs: 500 },
    );
  },
);

test("model is the default even for clients with native capability; query modes isolate sessions", async () => {
  await withHost(async ({ connect, url, ledger }) => {
    const { client, transport } = await connect("", form);
    client.setRequestHandler(ElicitRequestSchema, async () => {
      throw new Error("Model mode must not prompt");
    });
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "resume"));
    const pending = decode((await execute(client)).structuredContent);
    assert.equal(pending.status, "approval-required");
    if (pending.status !== "approval-required") throw new Error("Expected pause");
    assert.ok(transport.sessionId);
    const switched = new URL(url);
    switched.searchParams.set("elicitation_mode", "native");
    const response = await fetch(switched, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": transport.sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 55, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 404);
    await response.body?.cancel();
    const completed = decode(
      (
        await client.callTool({
          name: "resume",
          arguments: { requestId: pending.requestId, response: { action: "accept", content: {} } },
        })
      ).structuredContent,
    );
    assert.equal(completed.status, "completed");
    assert.deepEqual(ledger, ["approved"]);
    const { client: explicit } = await connect("model", form);
    assert.ok((await explicit.listTools()).tools.some((tool) => tool.name === "resume"));
  });
});

test("June 2025 native clients can advertise the original empty elicitation capability", async () => {
  await withHost(
    async ({ connect, ledger }) => {
      const { client } = await connect("native", { elicitation: {} });
      client.setRequestHandler(ElicitRequestSchema, async () => ({
        action: "accept",
        content: {},
      }));
      const result = decode((await execute(client)).structuredContent);
      assert.equal(result.status, "completed");
      if (result.status !== "completed" || !result.execution.ok)
        throw new Error(JSON.stringify(result));
      assert.deepEqual(result.execution.value, { value: "original" });
      assert.deepEqual(ledger, ["approved"]);
    },
    { protocols: [McpProtocol.v2025_06_18] },
  );
});

test("concurrent native executions receive their own client decisions", async () => {
  await withHost(async ({ connect, ledger }) => {
    const { client } = await connect("native", form);
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.message.includes("approved-call")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { action: "accept", content: {} };
      }
      return { action: "decline" };
    });
    const [accepted, declined] = await Promise.all(
      ["approved-call", "declined-call"].map(async (value) =>
        decode(
          (
            await execute(
              client,
              `return await tools.fixture.guarded({value: ${JSON.stringify(value)}});`,
            )
          ).structuredContent,
        ),
      ),
    );
    assert.ok(accepted?.status === "completed" && accepted.execution.ok);
    assert.deepEqual(accepted.execution.value, { value: "approved-call" });
    assert.ok(declined?.status === "completed" && !declined.execution.ok);
    assert.equal(declined.execution.error.message, "ApprovalDenied");
    assert.deepEqual(ledger, ["approved"]);
  });
});

for (const action of ["decline", "cancel"] as const)
  test(`native ${action} fails the guarded call without running it`, async () => {
    await withHost(async ({ connect, ledger }) => {
      const { client } = await connect("native", form);
      client.setRequestHandler(ElicitRequestSchema, async () => ({ action }));
      const result = decode(
        (
          await execute(
            client,
            `${guarded.replace("return ", "")} return await tools.fixture.after({});`,
          )
        ).structuredContent,
      );
      assert.equal(result.status, "completed");
      if (result.status !== "completed" || result.execution.ok)
        throw new Error(JSON.stringify(result));
      assert.equal(
        result.execution.error.message,
        action === "decline" ? "ApprovalDenied" : "ApprovalCancelled",
      );
      assert.deepEqual(ledger, []);
    });
  });

test("native mode refuses clients without form support before any program side effects", async () => {
  for (const capabilities of [{}, { elicitation: { url: {} } }] satisfies ClientCapabilities[])
    await withHost(async ({ connect, ledger, requests }) => {
      const { client } = await connect("native", capabilities);
      const result = await execute(client, code);
      assert.equal(result.isError, true);
      assert.match(
        JSON.stringify(result),
        /requires an MCP client and protocol with form elicitation support/,
      );
      assert.deepEqual(ledger, []);
      assert.equal(requests.length, 0);
    });
});

test("native delivery errors and malformed answers never become approval or user cancellation", async () => {
  for (const invalid of [false, true])
    await withHost(async ({ connect, ledger }) => {
      const { client } = await connect("native", form);
      client.setRequestHandler(ElicitRequestSchema, async (): Promise<ElicitResult> => {
        if (!invalid) throw new Error("synthetic-private-client-failure");
        return { action: "accept", content: { value: "replacement" } };
      });
      const result = await execute(client);
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes("synthetic-private-client-failure"));
      assert.deepEqual(ledger, []);
      // A failed prompt does not poison this session or a later independent program.
      client.setRequestHandler(ElicitRequestSchema, async () => ({
        action: "accept",
        content: {},
      }));
      const next = decode((await execute(client)).structuredContent);
      assert.equal(next.status, "completed");
      assert.deepEqual(ledger, ["approved"]);
    });
});

test("an unanswered native prompt expires without running the guarded tool", async () => {
  await withHost(
    async ({ connect, ledger }) => {
      const { client } = await connect("native", form);
      client.setRequestHandler(ElicitRequestSchema, async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { action: "accept", content: {} };
      });
      const result = await execute(client);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /expired/);
      assert.deepEqual(ledger, []);
    },
    { ttlMs: 50 },
  );
});

test("native negotiation rejects July discovery so modern clients can initialize a supported revision", async () => {
  await withHost(async ({ connect, url, ledger }) => {
    const invalid = await fetch(`${url}?elicitation_mode=unsupported`, { method: "POST" });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /elicitation_mode/);
    const discover = (endpoint: string) =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": form,
            },
          },
        }),
      });
    const native = await discover(`${url}?elicitation_mode=native`);
    assert.equal(native.status, 400);
    await native.body?.cancel();
    const model = await discover(url.href);
    assert.equal(model.status, 200);
    assert.match(await model.text(), /2026-07-28/);
    assert.deepEqual(ledger, []);
    // Claude Code's v2 runtime follows its rejected discovery probe with
    // ordinary initialization and advertises the original empty capability.
    const { client } = await connect("native", { elicitation: {} });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: {} }));
    const result = decode((await execute(client)).structuredContent);
    assert.ok(result.status === "completed" && result.execution.ok);
    assert.deepEqual(ledger, ["approved"]);
  });
});

test("a host offering only July retains model mode and explicitly rejects native mode", async () => {
  await withHost(
    async ({ url, ledger }) => {
      const native = await fetch(`${url}?elicitation_mode=native`, { method: "POST" });
      assert.equal(native.status, 400);
      assert.match(await native.text(), /host protocol/);
      const model = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "execute",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: "return 1" },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      assert.equal(model.status, 200);
      assert.match(await model.text(), /"ok":true/);
      assert.deepEqual(ledger, []);
    },
    { protocols: [McpProtocol.v2026_07_28] },
  );
});
