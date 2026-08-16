import { describe, expect, it } from "@effect/vitest";
import {
  Client,
  StreamableHTTPClientTransport,
  withInputRequired,
  type Request as McpRequest,
} from "@modelcontextprotocol/client";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import {
  createMcpHandler,
  isInputRequiredResult,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { Effect } from "effect";

import type { ExecutionEngine, ExecutionResult, ResumeResponse } from "@executor-js/execution";
import { defaultMcpResource, type McpResource } from "./seams";
import { FormElicitation, ToolAddress } from "@executor-js/sdk";

import {
  appsEnabledForClientCapabilities,
  buildMcpServer,
  mcpRequestStateBindingFromBody,
} from "./tool-server";
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from "./mcp-apps";

const REQUEST_STATE_KEY = new Uint8Array(32).fill(7);
const TOOL_ADDRESS = ToolAddress.make("tools.test.org.main.echo");
const APP_URI = "ui://executor/shell.html";

type TestServerConfig = {
  readonly engine: ExecutionEngine;
  readonly appsEnabled: boolean;
  readonly elicitationMode?: { readonly mode: "model" } | { readonly mode: "native" };
  readonly loadAppShellHtml?: () => Promise<string>;
  /** Evaluated per request, so a test can swap principals between rounds. */
  readonly requestStatePrincipal?: () => string;
  /** Evaluated per request, so a test can swap resources between rounds. */
  readonly requestStateResource?: () => McpResource;
};

const makeStubEngine = (
  overrides: {
    readonly executeWithPause?: ExecutionEngine["executeWithPause"];
    readonly resume?: ExecutionEngine["resume"];
    readonly getPausedExecution?: ExecutionEngine["getPausedExecution"];
  } = {},
): ExecutionEngine => ({
  execute: (code) => Effect.succeed({ result: `ran: ${code}` }),
  executeWithPause:
    overrides.executeWithPause ??
    ((code) => Effect.succeed({ status: "completed", result: { result: `ran: ${code}` } })),
  resume: overrides.resume ?? (() => Effect.succeed(null)),
  isExecutionSettled: () => Effect.succeed(false),
  getPausedExecution: overrides.getPausedExecution ?? (() => Effect.succeed(null)),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test executor"),
});

const withClient = async (
  config: TestServerConfig,
  run: (client: Client) => Promise<void>,
  options?: { readonly manualInputRequired?: boolean },
) => {
  const requestBodies = new WeakMap<Request, unknown>();
  const handler = createMcpHandler(
    (context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const requestStatePrincipal = config.requestStatePrincipal?.() ?? "principal-test";
          const requestStateResource = config.requestStateResource?.() ?? defaultMcpResource;
          const requestStateBinding = yield* Effect.promise(() =>
            mcpRequestStateBindingFromBody({
              body: context.requestInfo ? requestBodies.get(context.requestInfo) : undefined,
              principal: requestStatePrincipal,
              resource: requestStateResource,
            }),
          );
          return yield* buildMcpServer({
            ...config,
            requestStateSigningKey: REQUEST_STATE_KEY,
            requestStatePrincipal,
            ...(requestStateBinding === null ? {} : { requestStateBinding }),
          });
        }),
      ),
    { legacy: "reject" },
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://executor.test/mcp"), {
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      requestBodies.set(request, await request.clone().json());
      return handler.fetch(request, { parsedBody: requestBodies.get(request) });
    },
  });
  const client = new Client(
    { name: "executor-protocol-test", version: "1.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      ...(options?.manualInputRequired ? { inputRequired: { autoFulfill: false } } : {}),
    },
  );
  await client.connect(transport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test helper owns the client transport and in-process HTTP handler
  try {
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
};

const manualToolCall = (
  client: Client,
  params: Record<string, unknown>,
): Promise<InputRequiredResult | Awaited<ReturnType<Client["callTool"]>>> => {
  const request: McpRequest = { method: "tools/call", params };
  return client.request(request, withInputRequired(CallToolResultSchema), {
    allowInputRequired: true,
  });
};

describe("Executor MCP protocol assembly", () => {
  it("lists Executor tools and executes code end to end over the modern HTTP entry", async () => {
    await withClient({ engine: makeStubEngine(), appsEnabled: false }, async (client) => {
      const names = (await client.listTools()).tools.map(({ name }) => name);
      expect(names).toContain("execute");
      expect(names).toContain("skills");
      expect(names).toContain("resume");

      const result = await client.callTool({
        name: "execute",
        arguments: { code: "1 + 1" },
      });
      expect(result.content).toEqual([{ type: "text", text: "ran: 1 + 1" }]);
      expect(result.isError).toBeFalsy();
    });
  });

  it("registers app metadata and app-only tools only for apps-enabled requests", async () => {
    const inspect = async (appsEnabled: boolean) => {
      let observed:
        | {
            readonly names: readonly string[];
            readonly createMeta: Record<string, unknown> | undefined;
            readonly resourceCount: number;
          }
        | undefined;
      await withClient(
        {
          engine: makeStubEngine(),
          appsEnabled,
          loadAppShellHtml: async () => "<html></html>",
        },
        async (client) => {
          const tools = (await client.listTools()).tools;
          observed = {
            names: tools.map(({ name }) => name),
            createMeta: tools.find(({ name }) => name === "create-artifact")?._meta,
            resourceCount: (await client.listResources()).resources.length,
          };
        },
      );
      return observed;
    };

    const enabled = await inspect(true);
    expect(enabled?.names).toContain("execute-action");
    expect(enabled?.createMeta).toMatchObject({
      ui: { resourceUri: APP_URI, visibility: ["model"] },
      [RESOURCE_URI_META_KEY]: APP_URI,
    });
    expect(enabled?.resourceCount).toBe(1);

    const disabled = await inspect(false);
    expect(disabled?.names).not.toContain("execute-action");
    expect(disabled?.createMeta).toBeUndefined();
    expect(disabled?.resourceCount).toBe(0);
  });

  it("returns input_required and resumes native elicitation from signed requestState", async () => {
    const request = FormElicitation.make({
      message: "Which value?",
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    });
    const paused: Extract<ExecutionResult, { status: "paused" }> = {
      status: "paused",
      execution: {
        id: "execution-1",
        elicitationContext: { address: TOOL_ADDRESS, args: {}, request },
      },
    };
    let resumedWith: ResumeResponse | undefined;
    const engine = makeStubEngine({
      executeWithPause: () => Effect.succeed(paused),
      getPausedExecution: () => Effect.succeed(paused.execution),
      resume: (_executionId, response) => {
        resumedWith = response;
        return Effect.succeed({
          status: "completed",
          result: { result: response.content?.value },
        });
      },
    });

    await withClient(
      { engine, appsEnabled: false, elicitationMode: { mode: "native" } },
      async (client) => {
        const first = await manualToolCall(client, {
          name: "execute",
          arguments: { code: "await tools.test.echo()" },
        });
        expect(isInputRequiredResult(first)).toBe(true);
        if (!isInputRequiredResult(first)) return;
        expect(first.inputRequests?.elicitation).toMatchObject({
          method: "elicitation/create",
          params: { message: "Which value?" },
        });
        expect(typeof first.requestState).toBe("string");

        const completed = await manualToolCall(client, {
          name: "execute",
          arguments: { code: "await tools.test.echo()" },
          inputResponses: {
            elicitation: { action: "accept", content: { value: "approved" } },
          },
          requestState: first.requestState,
        });
        expect(isInputRequiredResult(completed)).toBe(false);
        expect(completed.content).toEqual([{ type: "text", text: "approved" }]);
        expect(resumedWith).toEqual({ action: "accept", content: { value: "approved" } });
      },
      { manualInputRequired: true },
    );
  });

  it("rejects a tampered native-elicitation requestState before resuming", async () => {
    const request = FormElicitation.make({
      message: "Confirm",
      requestedSchema: {},
    });
    const paused: Extract<ExecutionResult, { status: "paused" }> = {
      status: "paused",
      execution: {
        id: "execution-2",
        elicitationContext: { address: TOOL_ADDRESS, args: {}, request },
      },
    };
    let resumeCalls = 0;
    const engine = makeStubEngine({
      executeWithPause: () => Effect.succeed(paused),
      getPausedExecution: () => Effect.succeed(paused.execution),
      resume: () => {
        resumeCalls += 1;
        return Effect.succeed(null);
      },
    });

    await withClient(
      { engine, appsEnabled: false, elicitationMode: { mode: "native" } },
      async (client) => {
        const first = await manualToolCall(client, {
          name: "execute",
          arguments: { code: "await tools.test.echo()" },
        });
        expect(isInputRequiredResult(first)).toBe(true);
        if (!isInputRequiredResult(first) || !first.requestState) return;

        // Corrupt an interior character: changing the final one can only touch
        // discarded base64url padding bits, which lenient decoders (Bun) drop —
        // the decoded bytes would be identical and the signature would verify.
        const middle = Math.floor(first.requestState.length / 2);
        const swapped = first.requestState[middle] === "A" ? "B" : "A";
        const tampered = `${first.requestState.slice(0, middle)}${swapped}${first.requestState.slice(middle + 1)}`;
        await expect(
          manualToolCall(client, {
            name: "execute",
            arguments: { code: "await tools.test.echo()" },
            inputResponses: { elicitation: { action: "accept", content: {} } },
            requestState: tampered,
          }),
        ).rejects.toMatchObject({ code: -32602 });
        expect(resumeCalls).toBe(0);
      },
      { manualInputRequired: true },
    );
  });

  it("rejects a requestState echoed with a different principal, resource, or code", async () => {
    const request = FormElicitation.make({
      message: "Confirm",
      requestedSchema: {},
    });
    const paused: Extract<ExecutionResult, { status: "paused" }> = {
      status: "paused",
      execution: {
        id: "execution-3",
        elicitationContext: { address: TOOL_ADDRESS, args: {}, request },
      },
    };
    let resumeCalls = 0;
    const engine = makeStubEngine({
      executeWithPause: () => Effect.succeed(paused),
      getPausedExecution: () => Effect.succeed(paused.execution),
      resume: () => {
        resumeCalls += 1;
        return Effect.succeed(null);
      },
    });

    let principal = "user-a";
    let resource: McpResource = defaultMcpResource;
    await withClient(
      {
        engine,
        appsEnabled: false,
        elicitationMode: { mode: "native" },
        requestStatePrincipal: () => principal,
        requestStateResource: () => resource,
      },
      async (client) => {
        const first = await manualToolCall(client, {
          name: "execute",
          arguments: { code: "await tools.test.echo()" },
        });
        expect(isInputRequiredResult(first)).toBe(true);
        if (!isInputRequiredResult(first) || !first.requestState) return;

        principal = "user-b";
        await expect(
          manualToolCall(client, {
            name: "execute",
            arguments: { code: "await tools.test.echo()" },
            inputResponses: { elicitation: { action: "accept", content: {} } },
            requestState: first.requestState,
          }),
        ).rejects.toMatchObject({ code: -32602 });

        principal = "user-a";
        resource = { kind: "toolkit", slug: "other" };
        await expect(
          manualToolCall(client, {
            name: "execute",
            arguments: { code: "await tools.test.echo()" },
            inputResponses: { elicitation: { action: "accept", content: {} } },
            requestState: first.requestState,
          }),
        ).rejects.toMatchObject({ code: -32602 });

        resource = defaultMcpResource;
        await expect(
          manualToolCall(client, {
            name: "execute",
            arguments: { code: "await tools.test.different()" },
            inputResponses: { elicitation: { action: "accept", content: {} } },
            requestState: first.requestState,
          }),
        ).rejects.toMatchObject({ code: -32602 });
        expect(resumeCalls).toBe(0);
      },
      { manualInputRequired: true },
    );
  });

  it("derives request-scoped app support from the exact MCP Apps MIME capability", () => {
    expect(
      appsEnabledForClientCapabilities({
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] },
        },
      }),
    ).toBe(true);
    expect(
      appsEnabledForClientCapabilities({
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] },
        },
      }),
    ).toBe(false);
  });
});
