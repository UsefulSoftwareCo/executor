import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import {
  makeInMemoryMcpSessionStore,
  McpEngineBuildError,
  type McpBuildServer,
  type McpBuildServerOptions,
} from "./in-memory-session-store";
import { defaultMcpResource, type Principal } from "./seams";
import { createExecutorMcpServer } from "./tool-server";

const TEST_PRINCIPAL: Principal = {
  accountId: "acct_test",
  organizationId: "org_test",
  organizationName: "Test Org",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: ["user"],
};

it("preserves native elicitation mode when creating an in-memory MCP session", async () => {
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
});

// ---------------------------------------------------------------------------
// The pre-initialize guard, through the real store path.
//
// `store.dispatch` with no session id runs the guard and, when the guard
// declines, builds a real MCP server and drives a real streamable-HTTP
// transport. So these assert BOTH halves of the contract: the one answer the
// guard replaces, and the transport answers it must not shadow.
// ---------------------------------------------------------------------------

/** The headers a streamable-HTTP client must send on a POST; less is a 406/415. */
const MCP_POST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const;

/** No code ever runs here: these requests are answered before any tool call. */
const stubEngine: ExecutionEngine<never> = {
  execute: () => Effect.succeed({ result: "unused" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "unused" } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test executor"),
  shutdown: Effect.void,
};

/** A store whose sessions are real: a real MCP server on a real transport. */
const makeServingStore = () => {
  let builds = 0;
  const buildServer: McpBuildServer = () =>
    Effect.sync(() => {
      builds += 1;
    }).pipe(
      Effect.flatMap(() => createExecutorMcpServer({ engine: stubEngine })),
      Effect.map((mcpServer) => ({ mcpServer, engine: stubEngine })),
    );
  return { sessions: makeInMemoryMcpSessionStore(buildServer), buildCount: (): number => builds };
};

const dispatchPost = (
  sessions: ReturnType<typeof makeServingStore>["sessions"],
  body: unknown,
  headers: Record<string, string> = MCP_POST_HEADERS,
): Promise<Response> =>
  Effect.runPromise(
    sessions.store
      .dispatch({
        request: new Request("https://executor.test/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        principal: TEST_PRINCIPAL,
        resource: defaultMcpResource,
        sessionId: null,
        method: "POST",
      })
      .pipe(
        Effect.map((result) => {
          expect(result).toBeInstanceOf(Response);
          return result as Response;
        }),
      ),
  );

interface JsonRpcErrorBody {
  readonly error: { readonly code: number; readonly message: string };
}

describe("pre-initialize dispatch through the in-memory session store", () => {
  it("answers a valid unknown pre-session method with -32601 on a 200", async () => {
    const { sessions, buildCount } = makeServingStore();
    const response = await dispatchPost(sessions, {
      jsonrpc: "2.0",
      id: 7,
      method: "server/discover",
      params: {},
    });

    // 200, not the transport's 400: a per-request error the client survives.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
    // The guard short-circuits before any engine is built.
    expect(buildCount()).toBe(0);
    await sessions.close();
  });

  it("passes a pre-session notification to the transport", async () => {
    const { sessions, buildCount } = makeServingStore();
    const response = await dispatchPost(sessions, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // A notification carries no id, so the guard may not answer it at all;
    // whatever comes back is the transport's own answer.
    const body = (await response.json()) as JsonRpcErrorBody;
    expect(body.error.code).not.toBe(-32601);
    expect(body.error.code).toBe(-32000);
    expect(buildCount()).toBe(1);
    await sessions.close();
  });

  it("leaves a structurally invalid request to the transport's parse error", async () => {
    const { sessions } = makeServingStore();
    // A fractional id is not a JSON-RPC id, so this is not a request the guard
    // may report an unknown method for.
    const response = await dispatchPost(sessions, {
      jsonrpc: "2.0",
      id: 1.5,
      method: "server/discover",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonRpcErrorBody;
    expect(body.error.code).toBe(-32700);
    expect(body.error.code).not.toBe(-32601);
    await sessions.close();
  });

  it("leaves a wrong Content-Type to the transport's 415", async () => {
    const { sessions } = makeServingStore();
    const response = await dispatchPost(
      sessions,
      { jsonrpc: "2.0", id: 1, method: "server/discover" },
      { "content-type": "text/plain", accept: MCP_POST_HEADERS.accept },
    );

    expect(response.status).toBe(415);
    await sessions.close();
  });

  it("leaves an incomplete Accept to the transport's 406", async () => {
    const { sessions } = makeServingStore();
    const response = await dispatchPost(
      sessions,
      { jsonrpc: "2.0", id: 1, method: "server/discover" },
      { "content-type": "application/json", accept: "application/json" },
    );

    expect(response.status).toBe(406);
    await sessions.close();
  });
});
