import { McpError } from "apps/mcp";
/** Upstream form forwarding across real MCP transports, including caller isolation and bounded cleanup. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpToolsEffect } from "apps/mcp/effect";
import { stdioToolsEffect } from "../../../../packages/apps/src/implementation/mcp-stdio.ts";
import { ElicitationFailed, type Elicit } from "apps";
import { Effect, Schema } from "effect";
import { withElicitingMcp } from "./fixtures/eliciting-mcp.ts";

const accepting: Elicit = async (request) => ({
  action: "accept",
  content: { answer: request.message },
  _meta: { persist: "session" },
});

for (const legacy of [false, true])
  test(
    `upstream ${legacy ? "SSE" : "HTTP"} forms preserve metadata, wait budgets and one invocation`,
    { timeout: 15_000 },
    async () => {
      await withElicitingMcp(
        { legacy, legacyForm: true },
        async ({ url, events, sessions, capabilities }) => {
          const tools = await Effect.runPromise(mcpToolsEffect({ url, timeoutMs: 500 }));
          const tool = tools.ask;
          assert.ok(tool);
          const markers = new Set<unknown>();
          const result = await Effect.runPromise(
            tool.run(
              {
                elicit: async (request) => {
                  assert.equal(request.mode, "form");
                  assert.equal(request._meta?.origin, "https://fixture.example");
                  assert.deepEqual(request._meta?.persist, ["session", "always"]);
                  markers.add(request._meta?.marker);
                  await new Promise((resolve) => setTimeout(resolve, 600));
                  return accepting(request);
                },
              },
              { value: "shared" },
            ),
          );
          assert.equal(markers.size, 1);
          assert.deepEqual(result.structuredContent?.responses, [
            { action: "accept", content: { answer: "shared:1" }, _meta: { persist: "session" } },
            { action: "accept", content: { answer: "shared:2" }, _meta: { persist: "session" } },
          ]);
          assert.deepEqual(events, [
            "list",
            "call:shared",
            "answer:accept",
            "answer:accept",
            "done:shared",
          ]);
          assert.equal(capabilities[0]?.elicitation, undefined);
          assert.deepEqual(capabilities[1]?.elicitation, { form: {} });
          const deadline = Date.now() + 1000;
          while (sessions.size > 0 && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(sessions.size, 0);
        },
      );
    },
  );

test("decline and cancel return upstream; missing delivery and invalid answers cannot become acceptance", async () => {
  await withElicitingMcp({}, async ({ url, events }) => {
    const tool = (await Effect.runPromise(mcpToolsEffect({ url }))).ask;
    assert.ok(tool);
    for (const action of ["decline", "cancel"] as const) {
      const result: import("apps/mcp").McpToolResult = await Effect.runPromise(
        tool.run({ elicit: async () => ({ action }) }, {}),
      );
      assert.deepEqual(result.structuredContent?.responses, [{ action }]);
    }
    await assert.rejects(
      () => Effect.runPromise(tool.run({}, {})),
      (error: unknown) => error instanceof ElicitationFailed && error.reason === "unavailable",
    );
    await assert.rejects(
      () =>
        Effect.runPromise(
          tool.run({ elicit: async () => ({ action: "accept", content: { answer: 123 } }) }, {}),
        ),
      (error: unknown) => error instanceof ElicitationFailed && error.reason === "invalid-response",
    );
    assert.equal(events.filter((event) => event.startsWith("call:")).length, 4);
    assert.equal(events.includes("answer:accept"), false);
  });
});

test("concurrent calls retain their own delivery handlers", async () => {
  await withElicitingMcp({}, async ({ url }) => {
    const tool = (await Effect.runPromise(mcpToolsEffect({ url }))).ask;
    assert.ok(tool);
    const results = await Promise.all(
      ["one", "two"].map((value) =>
        Effect.runPromise(
          tool.run(
            {
              elicit: async (request) => {
                assert.ok(request.message.startsWith(value));
                return { action: "accept", content: { answer: value } };
              },
            },
            { value },
          ),
        ),
      ),
    );
    for (const [index, result] of results.entries())
      assert.equal(result.structuredContent?.value, index === 0 ? "one" : "two");
  });
});

test("discovery and URL-mode requests never prompt, and active timeouts still close sessions", async () => {
  await withElicitingMcp(
    { promptDuringDiscovery: true, urlMode: true },
    async ({ url, events }) => {
      const tool = (await Effect.runPromise(mcpToolsEffect({ url }))).ask;
      assert.ok(tool);
      assert.ok(events.includes("discovery-prompt-rejected"));
      const result = await Effect.runPromise(
        tool.run(
          {
            elicit: async () => {
              throw new Error("URL mode must not reach delivery");
            },
          },
          {},
        ),
      );
      assert.equal(result.isError, true);
    },
  );
  await withElicitingMcp({ hang: true, questions: 1 }, async ({ url, sessions }) => {
    const tool = (await Effect.runPromise(mcpToolsEffect({ url, timeoutMs: 200 }))).ask;
    assert.ok(tool);
    await assert.rejects(
      () => Effect.runPromise(tool.run({ elicit: accepting }, {})),
      (error: unknown) => error instanceof McpError && error.reason === "timeout",
    );
    const deadline = Date.now() + 1000;
    while (sessions.size > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sessions.size, 0);
  });
});

test(
  "stdio forwards two forms within one process and closes it after acceptance or cancellation",
  { timeout: 15_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "upstream-input-"));
    const journal = join(directory, "events.jsonl");
    try {
      const tools = await Effect.runPromise(
        stdioToolsEffect({
          command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/eliciting-stdio.ts", import.meta.url)), journal],
          env: {},
          timeoutMs: 1500,
        }),
      );
      const tool = tools.ask;
      assert.ok(tool);
      const result = await Effect.runPromise(
        tool.run(
          {
            elicit: async (request) => {
              await new Promise((resolve) => setTimeout(resolve, 1600));
              return accepting(request);
            },
          },
          {},
        ),
      );
      assert.equal(result.structuredContent?.responses instanceof Array, true);
      const cancelled = await Effect.runPromise(
        tool.run({ elicit: async () => ({ action: "cancel" }) }, {}),
      );
      assert.deepEqual(cancelled.structuredContent?.responses, [{ action: "cancel" }]);
      const controller = new AbortController();
      const interruptible = (
        await Effect.runPromise(
          stdioToolsEffect({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("./fixtures/eliciting-stdio.ts", import.meta.url)),
              journal,
            ],
            env: {},
            timeoutMs: 1500,
          }),
        )
      ).ask;
      assert.ok(interruptible);
      await assert.rejects(() =>
        Effect.runPromise(
          interruptible.run(
            {
              elicit: async () => {
                controller.abort();
                return { action: "accept", content: { answer: "must not arrive" } };
              },
            },
            {},
          ),
          { signal: controller.signal },
        ),
      );
      const events = (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, event: Schema.String })),
          )(line),
        );
      const calls = events.filter(({ event }) => event.startsWith("call:"));
      assert.equal(calls.length, 3);
      assert.equal(
        events.filter(({ pid, event }) => pid === calls.at(-1)?.pid && event.startsWith("answer:"))
          .length,
        0,
      );
      for (const pid of new Set(events.map(({ pid }) => pid)))
        assert.throws(() => process.kill(pid, 0));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "call connections remain bounded before HTTP or SSE initialization completes",
  { timeout: 5000 },
  async () => {
    for (const legacy of [false, true]) {
      let stall = false;
      await withElicitingMcp({ legacy, stallConnections: () => stall }, async ({ url, events }) => {
        const tool = (await Effect.runPromise(mcpToolsEffect({ url, timeoutMs: 150 }))).ask;
        assert.ok(tool);
        stall = true;
        await assert.rejects(
          () => Effect.runPromise(tool.run({}, {})),
          (error: unknown) => error instanceof McpError && error.reason === "timeout",
        );
        assert.equal(
          events.some((event) => event.startsWith("call:")),
          false,
        );
      });
    }
  },
);
