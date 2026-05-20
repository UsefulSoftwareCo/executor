import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types";

import {
  createExecutor,
  FormElicitation,
  ElicitationResponse,
  isToolResult,
  type InvokeOptions,
} from "@executor-js/sdk";
import { makeTestConfig, typeCheckOutputTypeScript } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";
import { makeElicitationMcpServer, serveMcpServer } from "../testing";

const isFormElicitation = Schema.is(FormElicitation);

const serveElicitationTestServer = serveMcpServer(makeElicitationMcpServer);

const schemaValidator = new CfWorkerJsonSchemaValidator({ shortcircuit: false });

const expectMatchesOutputSchema = (outputSchema: unknown, value: unknown): void => {
  expect(outputSchema).toBeDefined();
  const result = schemaValidator.getValidator(outputSchema as JsonSchemaType)(value);
  expect(result).toEqual({
    valid: true,
    data: value,
    errorMessage: undefined,
  });
};

const expectToolResultOkData = (result: unknown): unknown => {
  expect(isToolResult(result)).toBe(true);
  expect(result).toMatchObject({ ok: true });
  return (result as { readonly ok: true; readonly data: unknown }).data;
};

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

  it.effect("registered tools without MCP outputSchema still describe CallToolResult", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const simpleEcho = tools.find((t) => t.name === "simple_echo")!;
      const schema = yield* executor.tools.schema(simpleEcho.id);

      expect(schema?.outputSchema).toMatchObject({
        type: "object",
        properties: {
          content: { type: "array" },
          structuredContent: {},
          isError: { const: false },
          _meta: { type: "object" },
        },
        required: ["content"],
      });
      const outputSchema = schema?.outputSchema as {
        readonly properties: {
          readonly content: {
            readonly items: {
              readonly anyOf: readonly unknown[];
            };
          };
        };
      };
      expect(outputSchema.properties.content.items.anyOf).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              type: { const: "text", type: "string" },
              text: { type: "string" },
            }),
            required: ["type", "text"],
          }),
        ]),
      );
      expect(schema?.outputTypeScript).toContain('type: "text"');
      expect(schema?.outputTypeScript).toContain("structuredContent?: { [k: string]: unknown; }");

      const result = yield* executor.tools.invoke(
        simpleEcho.id,
        { value: "plain" },
        { onElicitation: "accept-all" },
      );

      const data = expectToolResultOkData(result);
      expectMatchesOutputSchema(schema?.outputSchema, data);
      expect(typeCheckOutputTypeScript(schema, data)).toEqual([]);
    }),
  );

  it.effect("successful tool invocation preserves structured MCP result fields", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const structuredEcho = tools.find((t) => t.name === "structured_echo")!;
      const schema = yield* executor.tools.schema(structuredEcho.id);

      expect(schema?.outputSchema).toMatchObject({
        type: "object",
        properties: {
          content: { type: "array" },
          structuredContent: {
            type: "object",
            properties: {
              value: { type: "string" },
              upper: { type: "string" },
            },
          },
          _meta: { type: "object" },
        },
        required: ["content", "structuredContent"],
      });
      expect(schema?.outputTypeScript).toContain("structuredContent");
      expect(schema?.outputTypeScript).toContain("value: string");

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
      const data = expectToolResultOkData(result);
      expectMatchesOutputSchema(schema?.outputSchema, data);
      expect(typeCheckOutputTypeScript(schema, data)).toEqual([]);
    }),
  );

  it.effect("refreshSource keeps MCP outputSchema nested under structuredContent", () =>
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
        name: "test-mcp",
        namespace: "schema_refresh",
        endpoint: server.url,
      });
      yield* executor.mcp.refreshSource("schema_refresh", "test-scope");

      const schema = yield* executor.tools.schema("schema_refresh.structured_echo");
      expect(schema?.outputSchema).toMatchObject({
        type: "object",
        properties: {
          content: { type: "array" },
          structuredContent: {
            type: "object",
            properties: {
              value: { type: "string" },
              upper: { type: "string" },
            },
          },
        },
        required: ["content", "structuredContent"],
      });
      expect(schema?.outputTypeScript).toContain("structuredContent");
      expect(schema?.outputTypeScript).toContain("upper: string");

      const result = yield* executor.tools.invoke(
        "schema_refresh.structured_echo",
        { value: "plain" },
        { onElicitation: "accept-all" },
      );
      const data = expectToolResultOkData(result);
      expect(typeCheckOutputTypeScript(schema, data)).toEqual([]);
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
