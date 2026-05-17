import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  createExecutor,
  FormElicitation,
  ElicitationResponse,
  type InvokeOptions,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";
import { makeElicitationMcpServer, serveMcpServer } from "../testing";

const isFormElicitation = Schema.is(FormElicitation);

const serveElicitationTestServer = serveMcpServer(makeElicitationMcpServer);

// ---------------------------------------------------------------------------
// Helper — create executor with MCP plugin pointed at test server
// ---------------------------------------------------------------------------

const makeTestExecutor = (serverUrl: string) =>
  createExecutor(
    makeTestConfig({
      plugins: [mcpPlugin()] as const,
    }),
  ).pipe(
    Effect.tap((executor) =>
      executor.mcp.addSource({
        transport: "remote",
        scope: "test-scope",
        name: "test-mcp",
        endpoint: serverUrl,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests — everything goes through executor.tools.invoke()
// ---------------------------------------------------------------------------

describe("MCP elicitation (end-to-end)", () => {
  it.effect("form elicitation accepted → tool returns approved result", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);

      const tools = yield* executor.tools.list();
      const gatedEcho = tools.find((t) => t.name === "gated_echo");
      expect(gatedEcho).toBeDefined();

      const elicitationMessages: string[] = [];

      const options: InvokeOptions = {
        onElicitation: (ctx) => {
          if (isFormElicitation(ctx.request)) {
            elicitationMessages.push(ctx.request.message);
          }
          return Effect.succeed(
            ElicitationResponse.make({
              action: "accept",
              content: { approved: true },
            }),
          );
        },
      };

      const result = yield* executor.tools.invoke(gatedEcho!.id, { value: "hello" }, options);

      expect(result).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "approved:hello" }] },
      });
      // At least one elicitation should be the MCP server's form
      expect(elicitationMessages.length).toBeGreaterThanOrEqual(1);
      expect(elicitationMessages.some((m) => m.includes('Approve echo for "hello"?'))).toBe(true);
    }),
  );

  it.effect("form elicitation declined → tool returns denied result", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const gatedEcho = tools.find((t) => t.name === "gated_echo")!;

      // MCP tools have requiresApproval: false — only the MCP server's
      // mid-invocation elicitation reaches the handler, and we decline it.
      const result = yield* executor.tools.invoke(
        gatedEcho.id,
        { value: "nope" },
        {
          onElicitation: () => Effect.succeed(ElicitationResponse.make({ action: "decline" })),
        },
      );

      expect(result).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "denied:nope" }] },
      });
    }),
  );

  it.effect("tool without elicitation works normally", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const simpleEcho = tools.find((t) => t.name === "simple_echo")!;

      const result = yield* executor.tools.invoke(
        simpleEcho.id,
        { value: "plain" },
        { onElicitation: "accept-all" },
      );

      expect(result).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "plain" }] },
      });
    }),
  );

  it.effect("successful tool invocation preserves structured MCP result fields", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const structuredEcho = tools.find((t) => t.name === "structured_echo")!;

      const result = yield* executor.tools.invoke(
        structuredEcho.id,
        { value: "plain" },
        { onElicitation: "accept-all" },
      );

      expect(result).toMatchObject({
        ok: true,
        data: {
          content: [{ type: "text", text: "plain" }],
          structuredContent: { value: "plain", upper: "PLAIN" },
          _meta: { trace: "kept" },
        },
      });
    }),
  );

  it.effect("addSource preserves the configured display name over server metadata", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [mcpPlugin()] as const,
        }),
      );

      yield* executor.mcp.addSource({
        transport: "remote",
        scope: "test-scope",
        name: "Gmail",
        endpoint: server.url,
        namespace: "gmail",
      });

      const sources = yield* executor.sources.list();
      const source = sources.find((s) => s.id === "gmail");

      expect(source?.name).toBe("Gmail");
    }),
  );

  it.effect("handler receives correct toolId, args, and FormElicitation schema", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const gatedEcho = tools.find((t) => t.name === "gated_echo")!;

      let capturedToolId: string | undefined;
      let capturedArgs: unknown;
      let capturedRequest: unknown;

      yield* executor.tools.invoke(
        gatedEcho.id,
        { value: "ctx-test" },
        {
          onElicitation: (ctx) => {
            capturedToolId = ctx.toolId;
            capturedArgs = ctx.args;
            capturedRequest = ctx.request;
            return Effect.succeed(
              ElicitationResponse.make({
                action: "accept",
                content: { approved: true },
              }),
            );
          },
        },
      );

      expect(capturedToolId).toBe(gatedEcho.id);
      expect(capturedArgs).toEqual({ value: "ctx-test" });
      expect(isFormElicitation(capturedRequest)).toBe(true);

      const form = capturedRequest as FormElicitation;
      expect(form.message).toContain('Approve echo for "ctx-test"?');
      expect(form.requestedSchema).toEqual({
        type: "object",
        properties: {
          approved: { type: "boolean", title: "Approve" },
        },
        required: ["approved"],
      });
    }),
  );

  it.effect("connection is reused across multiple tool calls to the same source", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const simpleEcho = tools.find((t) => t.name === "simple_echo")!;
      const gatedEcho = tools.find((t) => t.name === "gated_echo")!;

      // addSource created 1 session during discovery
      expect(server.sessionCount()).toBeGreaterThanOrEqual(1);

      // First tool call — may create a new session (discovery used a
      // different connection that was closed)
      yield* executor.tools.invoke(
        simpleEcho.id,
        { value: "call-1" },
        { onElicitation: "accept-all" },
      );
      const sessionsAfterFirst = server.sessionCount();

      // Second call to a different tool on the same source — should reuse
      yield* executor.tools.invoke(
        simpleEcho.id,
        { value: "call-2" },
        { onElicitation: "accept-all" },
      );
      expect(server.sessionCount()).toBe(sessionsAfterFirst);

      // Third call to yet another tool on the same source — still reused
      yield* executor.tools.invoke(
        gatedEcho.id,
        { value: "call-3" },
        {
          onElicitation: () =>
            Effect.succeed(
              ElicitationResponse.make({
                action: "accept",
                content: { approved: true },
              }),
            ),
        },
      );
      expect(server.sessionCount()).toBe(sessionsAfterFirst);
    }),
  );
});
