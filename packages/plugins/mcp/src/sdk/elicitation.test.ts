import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types";

import {
  AuthTemplateSlug,
  ConnectionName,
  createExecutor,
  FormElicitation,
  ElicitationResponse,
  IntegrationSlug,
  isToolResult,
  ToolAddress,
  type InvokeOptions,
  type Tool,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  typeCheckOutputTypeScript,
} from "@executor-js/sdk/testing";

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

const INTEG = IntegrationSlug.make("test_mcp");
const CONNECTION = ConnectionName.make("main");
const TEMPLATE = AuthTemplateSlug.make("none");

// ---------------------------------------------------------------------------
// Helper — register an MCP integration pointed at the test server and create
// an (open) connection so its tools are produced.
// ---------------------------------------------------------------------------

const makeTestExecutor = (serverUrl: string) =>
  createExecutor(
    makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
  ).pipe(
    Effect.tap((executor) =>
      Effect.gen(function* () {
        yield* executor.mcp.addServer({
          name: "test-mcp",
          endpoint: serverUrl,
          slug: String(INTEG),
        });
        yield* executor.connections.create({
          owner: "org",
          name: CONNECTION,
          integration: INTEG,
          template: TEMPLATE,
          value: "",
        });
      }),
    ),
  );

const findTool = (tools: readonly Tool[], name: string): Tool =>
  tools.find((t) => String(t.name) === name)!;

// ---------------------------------------------------------------------------
// Tests — everything goes through executor.execute()
// ---------------------------------------------------------------------------

describe("MCP elicitation (end-to-end)", () => {
  it.effect("form elicitation accepted → tool returns approved result", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);

      const tools = yield* executor.tools.list();
      const gatedEcho = findTool(tools, "gated_echo");

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

      const result = yield* executor.execute(gatedEcho.address, { value: "hello" }, options);

      expect(result).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "approved:hello" }] },
      });
      expect(elicitationMessages.length).toBeGreaterThanOrEqual(1);
      expect(elicitationMessages.some((m) => m.includes('Approve echo for "hello"?'))).toBe(true);
    }),
  );

  it.effect("form elicitation declined → tool returns denied result", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const gatedEcho = findTool(tools, "gated_echo");

      const result = yield* executor.execute(
        gatedEcho.address,
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
      const simpleEcho = findTool(tools, "simple_echo");

      const result = yield* executor.execute(
        simpleEcho.address,
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
      const simpleEcho = findTool(tools, "simple_echo");
      const schema = yield* executor.tools.schema(simpleEcho.address);

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

      const result = yield* executor.execute(
        simpleEcho.address,
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
      const structuredEcho = findTool(tools, "structured_echo");
      const schema = yield* executor.tools.schema(structuredEcho.address);

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

      const result = yield* executor.execute(
        structuredEcho.address,
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

  it.effect("connections.refresh keeps MCP outputSchema nested under structuredContent", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);

      yield* executor.connections.refresh({
        owner: "org",
        integration: INTEG,
        name: CONNECTION,
      });

      const address = ToolAddress.make("tools.test_mcp.org.main.structured_echo");
      const schema = yield* executor.tools.schema(address);
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

      const result = yield* executor.execute(
        address,
        { value: "plain" },
        { onElicitation: "accept-all" },
      );
      const data = expectToolResultOkData(result);
      expect(typeCheckOutputTypeScript(schema, data)).toEqual([]);
    }),
  );

  it.effect("addServer preserves the configured display name as the integration description", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));

      yield* executor.mcp.addServer({
        name: "Gmail",
        endpoint: server.url,
        slug: "gmail",
      });

      const integration = yield* executor.integrations.get(IntegrationSlug.make("gmail"));
      expect(integration?.description).toBe("Gmail");
    }),
  );

  it.effect("handler receives correct address, args, and FormElicitation schema", () =>
    Effect.gen(function* () {
      const server = yield* serveElicitationTestServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const gatedEcho = findTool(tools, "gated_echo");

      let capturedAddress: string | undefined;
      let capturedArgs: unknown;
      let capturedRequest: unknown;

      yield* executor.execute(
        gatedEcho.address,
        { value: "ctx-test" },
        {
          onElicitation: (ctx) => {
            capturedAddress = String(ctx.address);
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

      expect(capturedAddress).toBe(String(gatedEcho.address));
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

  // removed: "connection is reused across multiple tool calls" — v2 does not
  // cache MCP client connections across invocations (Hyperdrive request-scoped
  // rule; each invoke dials and closes its own connection). Session reuse is no
  // longer a property of the plugin, so the assertion no longer applies.
});
