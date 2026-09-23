import { McpError } from "apps/mcp";
import { Effect } from "effect";
import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonSchema, ValidationError, ProviderError } from "apps";
import { mcpToolsEffect } from "apps/mcp/effect";
import { withRemoteMcp } from "./fixtures/remote-mcp.ts";

for (const transport of ["json", "streaming", "legacy"] as const) {
  test(`MCP ${transport} discovers all pages, calls once and closes its sessions`, async () => {
    await withRemoteMcp(
      { streaming: transport === "streaming", legacy: transport === "legacy" },
      async ({ url, calls }) => {
        const tools = await Effect.runPromise(mcpToolsEffect({ url, timeoutMs: 3_000 }));
        assert.deepEqual(Object.keys(tools), ["public", "failure"]);
        assert.ok(tools.public);
        assert.deepEqual(await Effect.runPromise(tools.public.run({}, { value: "hello" })), {
          content: [{ type: "text", text: "public" }],
          structuredContent: { account: "public" },
          _meta: { fixture: true },
        });
        assert.deepEqual(calls, ["public:public"]);
      },
    );
  });
}

test("MCP rejects cursor loops and sanitizes authentication errors", async () => {
  await withRemoteMcp({ cursorLoop: true }, async ({ url, sessions }) => {
    await assert.rejects(
      () => Effect.runPromise(mcpToolsEffect({ url })),
      (error: unknown) => error instanceof McpError && error.reason === "invalid_response",
    );
    assert.equal(sessions.size, 0);
  });
  for (const legacy of [false, true])
    await withRemoteMcp({ unauthorized: true, legacy }, async ({ url }) => {
      await assert.rejects(
        () =>
          Effect.runPromise(
            mcpToolsEffect({ url, headers: { Authorization: "Bearer synthetic-secret" } }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.reason, "unauthorized");
          assert.equal(error.status, 401);
          assert.ok(!JSON.stringify(error).includes("secret"));
          return true;
        },
      );
    });
});

test("MCP aborts an in-flight call without retrying and cleans up the session", async () => {
  const controller = new AbortController();
  await withRemoteMcp(
    { hang: true, onCall: () => controller.abort() },
    async ({ url, calls, sessions }) => {
      const tools = await Effect.runPromise(
        mcpToolsEffect({ url, signal: controller.signal, timeoutMs: 3_000 }),
      );
      const tool = tools.public;
      assert.ok(tool);
      await assert.rejects(() => Effect.runPromise(tool.run({}, { value: "hello" })));
      assert.deepEqual(calls, ["public:public"]);
      assert.equal(sessions.size, 0);
    },
  );
});

test("legacy JavaScript patterns do not block MCP discovery and still validate calls", async () => {
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { value: { type: "string", pattern: "^\\[[0-9]+]$" } },
    required: ["value"],
  };
  await withRemoteMcp({ inputSchema }, async ({ url, calls }) => {
    const tools = await Effect.runPromise(mcpToolsEffect({ url }));
    assert.deepEqual(Object.keys(tools), ["public", "failure"]);
    const tool = tools.public;
    assert.ok(tool);
    await Effect.runPromise(tool.run({}, { value: "[123]" }));
    await assert.rejects(() => Effect.runPromise(tool.run({}, { value: "invalid" })), {
      _tag: "McpError",
      reason: "invalid_input",
    });
    assert.deepEqual(calls, ["public:public"]);
  });
});

test("pattern compatibility preserves Unicode behavior and rejects invalid syntax", () => {
  for (const $schema of [
    "https://json-schema.org/draft/2020-12/schema",
    "http://json-schema.org/draft-07/schema#",
  ]) {
    const schema = jsonSchema({
      $schema,
      type: "object",
      properties: {
        legacy: { type: "string", pattern: "^\\[[0-9]+]$" },
        unicode: { type: "string", pattern: "^.$" },
      },
      required: ["legacy", "unicode"],
    });
    assert.deepEqual(schema.parse({ legacy: "[123]", unicode: "😀" }), {
      legacy: "[123]",
      unicode: "😀",
    });
    assert.throws(() => schema.parse({ legacy: "invalid", unicode: "a" }), ValidationError);
    assert.throws(() => schema.parse({ legacy: "[123]", unicode: "ab" }), ValidationError);
    assert.throws(
      () => jsonSchema({ $schema, type: "string", pattern: "(" }).parse("test"),
      ValidationError,
    );
  }
});

test("unsupported MCP schemas remain discoverable and cannot trigger an upstream call", async () => {
  const unsupported = { type: "object", $ref: "#/$defs/missing" };
  for (const options of [
    { inputSchema: unsupported },
    { outputSchema: unsupported },
    { outputSchema: { type: "object", properties: { account: { type: "string", pattern: "(" } } } },
  ]) {
    await withRemoteMcp(options, async ({ url, calls, sessions }) => {
      const tools = await Effect.runPromise(mcpToolsEffect({ url }));
      assert.deepEqual(Object.keys(tools), ["public", "failure"]);
      const tool = tools.public;
      assert.ok(tool);
      assert.ok(tools.failure);
      await assert.rejects(() => Effect.runPromise(tool.run({}, { value: "hello" })), McpError);
      assert.deepEqual(calls, []);
      // An unsupported schema on another tool does not block this valid one.
      assert.equal((await Effect.runPromise(tools.failure.run({}, {}))).isError, true);
      assert.deepEqual(calls, ["public:failure"]);
      assert.equal(sessions.size, 0);
    });
  }
});

test("lazy MCP output validation still rejects bad results and preserves tool errors", async () => {
  for (const isError of [false, true]) {
    await withRemoteMcp(
      { structuredContent: { account: 123 }, isError },
      async ({ url, calls }) => {
        const tools = await Effect.runPromise(mcpToolsEffect({ url }));
        const tool = tools.public;
        assert.ok(tool);
        if (isError)
          assert.equal((await Effect.runPromise(tool.run({}, { value: "hello" }))).isError, true);
        else
          await assert.rejects(() => Effect.runPromise(tool.run({}, { value: "hello" })), {
            _tag: "McpError",
            reason: "invalid_response",
          });
        assert.deepEqual(calls, ["public:public"]);
      },
    );
  }
});
