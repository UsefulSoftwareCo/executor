import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import {
  makeInMemoryMcpSessionStore,
  McpEngineBuildError,
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

/** A do-nothing engine: the eviction test drives session lifetime, not tools. */
const makeIdleTestEngine = (): ExecutionEngine => ({
  execute: () => Effect.succeed({ result: "unused" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "unused" } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("idle-eviction test executor"),
  shutdown: Effect.void,
});

// A long TTL keeps the sweep's own timer out of the way; the assertions drive
// `sweepIdleSessions` directly with an explicit instant instead of sleeping
// through a real window, so the test is deterministic rather than timing-raced.
const IDLE_TTL_MS = 60_000;

it("evicts a session that goes idle past the TTL and keeps a busy one", async () => {
  const engine = makeIdleTestEngine();
  const sessions = makeInMemoryMcpSessionStore(
    () =>
      createExecutorMcpServer({ engine }).pipe(Effect.map((mcpServer) => ({ mcpServer, engine }))),
    { sessionIdleTtlMs: IDLE_TTL_MS },
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

  const call = (sessionId: string, id: number) =>
    Effect.runPromise(
      sessions.store.dispatch({
        request: new Request("https://executor.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
        }),
        principal: TEST_PRINCIPAL,
        resource: defaultMcpResource,
        sessionId,
        method: "POST",
      }),
    );

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always close the store
  try {
    const idle = await open();
    const busy = await open();
    expect(sessions.sessionCount()).toBe(2);

    // Neither is stale yet, so a sweep at the current instant takes nothing.
    expect(await sessions.sweepIdleSessions()).toBe(0);
    expect(sessions.sessionCount()).toBe(2);

    // Let the wall clock advance so the two sessions' stamps are separable,
    // then keep working on one of them: `forward` restamps that one and only
    // that one.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const restampedAt = Date.now();
    await call(busy, 2);

    // Sweep one TTL after the restamp, less a millisecond: `busy` was stamped
    // at or after `restampedAt` so it cannot have aged a full TTL, while `idle`
    // was stamped at least 25ms earlier and must have. Exactly one goes.
    expect(await sessions.sweepIdleSessions(restampedAt + IDLE_TTL_MS - 1)).toBe(1);
    expect(sessions.sessionCount()).toBe(1);

    // The evicted id is gone; the store reports it the way the envelope 404s.
    expect(await call(idle, 3)).toBe("not-found");
    // The busy one still serves.
    expect(await call(busy, 4)).toBeInstanceOf(Response);
  } finally {
    await sessions.close();
  }
});
