import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ExecutionEngine, ExecutionResult, ResumeResponse } from "@executor-js/execution";
import { FormElicitation, ToolAddress } from "@executor-js/sdk";

import {
  makeInMemoryMcpSessionStore,
  McpEngineBuildError,
  type McpBuildServerOptions,
} from "./in-memory-session-store";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "./mcp-apps";
import { defaultMcpResource, type Principal } from "./seams";
import { buildMcpServer } from "./tool-server";

const TEST_PRINCIPAL: Principal = {
  accountId: "acct_test",
  organizationId: "org_test",
  organizationName: "Test Org",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: ["user"],
};

const TOOL_ADDRESS = ToolAddress.make("tools.test.org.main.approve");

const makeElicitingEngine = (): {
  readonly engine: ExecutionEngine;
  readonly resumedWith: () => ResumeResponse | undefined;
} => {
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
      id: "execution-legacy",
      elicitationContext: { address: TOOL_ADDRESS, args: {}, request },
    },
  };
  let resumedWith: ResumeResponse | undefined;
  return {
    engine: {
      execute: () => Effect.succeed({ result: "unused" }),
      executeWithPause: () => Effect.succeed(paused),
      resume: (_executionId, response) => {
        resumedWith = response;
        return Effect.succeed({
          status: "completed",
          result: { result: response.content?.value },
        });
      },
      isExecutionSettled: () => Effect.succeed(false),
      getPausedExecution: (executionId) =>
        Effect.succeed(executionId === paused.execution.id ? paused.execution : null),
      pausedExecutionCount: () => Effect.succeed(1),
      hasPausedExecutions: () => Effect.succeed(true),
      getDescription: Effect.succeed("store integration test executor"),
    },
    resumedWith: () => resumedWith,
  };
};

describe("in-memory MCP session store", () => {
  it("preserves native elicitation mode and supplies the session inputs", async () => {
    let buildOptions: McpBuildServerOptions | undefined;
    const sessions = makeInMemoryMcpSessionStore((_principal, options) => {
      buildOptions = options;
      return Effect.fail(new McpEngineBuildError({ cause: "stop after capturing options" }));
    });

    const result = await Effect.runPromise(
      sessions.store.dispatch({
        request: new Request("https://executor.test/mcp?elicitation_mode=native", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: { elicitation: { form: {} } },
              clientInfo: { name: "test-client", version: "1.0.0" },
            },
          }),
        }),
        principal: TEST_PRINCIPAL,
        resource: defaultMcpResource,
        sessionId: null,
        method: "POST",
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    expect(buildOptions?.elicitationMode).toEqual({ mode: "native" });
    expect(buildOptions).toMatchObject({
      appsEnabled: false,
      requestStatePrincipal: `${TEST_PRINCIPAL.accountId}\u0000${TEST_PRINCIPAL.organizationId}`,
      sessionful: true,
    });
    expect(buildOptions?.requestStateSigningKey).toBeInstanceOf(Uint8Array);
  });

  it("evicts a session that goes idle past the TTL and keeps a busy one", async () => {
    const { engine } = makeElicitingEngine();
    const sessions = makeInMemoryMcpSessionStore(
      (_principal, options) =>
        buildMcpServer({
          engine,
          ...options,
          loadAppShellHtml: async () => "<html></html>",
        }).pipe(Effect.map((mcpServer) => ({ mcpServer, engine }))),
      { sessionIdleTtlMs: 300 },
    );

    const open = async (): Promise<string> => {
      const response = (await Effect.runPromise(
        sessions.store.dispatch({
          request: new Request("https://executor.test/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "idle-test", version: "1.0.0" },
              },
            }),
          }),
          principal: TEST_PRINCIPAL,
          resource: defaultMcpResource,
          sessionId: null,
          method: "POST",
        }),
      )) as Response;
      expect(response.status).toBe(200);
      const sessionId = response.headers.get("mcp-session-id") ?? "";
      expect(sessionId).not.toBe("");
      return sessionId;
    };

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always close the store
    try {
      const idle = await open();
      const busy = await open();
      expect(sessions.sessionCount()).toBe(2);

      // Neither is stale yet, so a sweep now must not touch them.
      expect(await sessions.sweepIdleSessions()).toBe(0);
      expect(sessions.sessionCount()).toBe(2);

      // Let both age past the idle window, then keep working on one of them:
      // `forward` restamps that session and only that session.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await Effect.runPromise(
        sessions.store.dispatch({
          request: new Request("https://executor.test/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-session-id": busy,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
          }),
          principal: TEST_PRINCIPAL,
          resource: defaultMcpResource,
          sessionId: busy,
          method: "POST",
        }),
      );

      // The idle session is now well past the window and the busy one was just
      // restamped, so the sweep takes exactly one.
      expect(await sessions.sweepIdleSessions()).toBe(1);
      expect(sessions.sessionCount()).toBe(1);

      // The evicted id is gone; the store reports it the way the envelope 404s.
      const afterEviction = await Effect.runPromise(
        sessions.store.dispatch({
          request: new Request("https://executor.test/mcp", {
            method: "POST",
            headers: { "content-type": "application/json", "mcp-session-id": idle },
            body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
          }),
          principal: TEST_PRINCIPAL,
          resource: defaultMcpResource,
          sessionId: idle,
          method: "POST",
        }),
      );
      expect(afterEviction).toBe("not-found");
    } finally {
      await sessions.close();
    }
  });

  it("serves a legacy client with live Apps capabilities, elicitation, and reuse", async () => {
    const { engine, resumedWith } = makeElicitingEngine();
    const sessions = makeInMemoryMcpSessionStore((_principal, options) =>
      buildMcpServer({
        engine,
        ...options,
        loadAppShellHtml: async () => "<html></html>",
      }).pipe(Effect.map((mcpServer) => ({ mcpServer, engine }))),
    );
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const result = await Effect.runPromise(
        sessions.store.dispatch({
          request,
          principal: TEST_PRINCIPAL,
          resource: defaultMcpResource,
          sessionId: request.headers.get("mcp-session-id"),
          method: request.method,
        }),
      );
      return result instanceof Response
        ? result
        : new Response(result === "forbidden" ? "Forbidden" : "Not found", {
            status: result === "forbidden" ? 403 : 404,
          });
    };
    const transport = new StreamableHTTPClientTransport(
      new URL("https://executor.test/mcp?elicitation_mode=native"),
      { fetch },
    );
    const client = new Client(
      { name: "legacy-store-client", version: "1.0.0" },
      {
        capabilities: {
          elicitation: { form: {} },
          extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
        },
      },
    );
    let elicitationRequests = 0;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationRequests += 1;
      expect(request.params).toMatchObject({ message: "Which value?" });
      return { action: "accept" as const, content: { value: "approved" } };
    });

    await client.connect(transport);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always close the sessionful client and store
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain("execute");
      expect(tools.tools.map(({ name }) => name)).toContain("execute-action");

      const result = await client.callTool({
        name: "execute",
        arguments: { code: "await tools.test.approve()" },
      });
      expect(result.content).toEqual([{ type: "text", text: "approved" }]);
      expect(result.isError).toBeFalsy();
      expect(elicitationRequests).toBe(1);
      expect(resumedWith()).toEqual({ action: "accept", content: { value: "approved" } });
      expect(sessions.sessionCount()).toBe(1);
    } finally {
      await client.close();
      await sessions.close();
    }
  });
});
