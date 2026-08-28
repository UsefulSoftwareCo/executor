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

/**
 * An engine whose `execute` parks until the test releases it, so a request can
 * be held inside `transport.handleRequest` while the sweep runs. `shutdowns`
 * counts `engine.shutdown` runs — the disposal step that ends the detached
 * sandbox fibers, and which dropping the engine reference does not do.
 */
const makeLatchedTestEngine = (): {
  readonly engine: ExecutionEngine;
  readonly started: Promise<void>;
  readonly release: () => void;
  readonly shutdowns: () => number;
} => {
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let shutdowns = 0;
  const park = <A>(value: A): Effect.Effect<A> =>
    Effect.promise(async () => {
      signalStarted();
      await gate;
      return value;
    });
  const engine: ExecutionEngine = {
    ...makeIdleTestEngine(),
    execute: () => park({ result: "released" }),
    executeWithPause: () => park({ status: "completed", result: { result: "released" } }),
    shutdown: Effect.sync(() => {
      shutdowns += 1;
    }),
  };
  return { engine, started, release: () => openGate(), shutdowns: () => shutdowns };
};

// A long TTL keeps the sweep's own timer out of the way; the assertions drive
// `sweepIdleSessions` directly with an explicit instant instead of sleeping
// through a real window, so the test is deterministic rather than timing-raced.
const IDLE_TTL_MS = 60_000;

type TestSessionStore = ReturnType<typeof makeInMemoryMcpSessionStore>;

/** Open a session on `sessions` and return its minted id. */
const openSession = async (sessions: TestSessionStore): Promise<string> => {
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

it("evicts a session that goes idle past the TTL and keeps a busy one", async () => {
  const engine = makeIdleTestEngine();
  const sessions = makeInMemoryMcpSessionStore(
    () =>
      createExecutorMcpServer({ engine }).pipe(Effect.map((mcpServer) => ({ mcpServer, engine }))),
    { sessionIdleTtlMs: IDLE_TTL_MS },
  );

  const open = (): Promise<string> => openSession(sessions);

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

it("never evicts a session while one of its requests is still in flight", async () => {
  const latched = makeLatchedTestEngine();
  const sessions = makeInMemoryMcpSessionStore(
    () =>
      createExecutorMcpServer({ engine: latched.engine }).pipe(
        Effect.map((mcpServer) => ({ mcpServer, engine: latched.engine })),
      ),
    { sessionIdleTtlMs: IDLE_TTL_MS },
  );

  const callExecute = (sessionId: string): Promise<unknown> =>
    Effect.runPromise(
      sessions.store.dispatch({
        request: new Request("https://executor.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "execute", arguments: { code: "return 1" } },
          }),
        }),
        principal: TEST_PRINCIPAL,
        resource: defaultMcpResource,
        sessionId,
        method: "POST",
      }),
    );

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always release the latch and close the store
  try {
    const sessionId = await openSession(sessions);

    // Start a call and park it inside the engine. `forward` stamps last-seen
    // BEFORE it awaits the transport, so from here on the stamp only ages — a
    // request slower than the TTL is indistinguishable from an abandoned
    // session unless the store also counts what is in flight.
    const startedAt = Date.now();
    const inFlight = callExecute(sessionId);
    await latched.started;

    // Sweep a full TTL past the moment the call began. Without the in-flight
    // counter this evicts the session and closes the transport, the server, and
    // the engine underneath the request that is still using them.
    expect(await sessions.sweepIdleSessions(startedAt + IDLE_TTL_MS)).toBe(0);
    expect(sessions.sessionCount()).toBe(1);
    expect(latched.shutdowns()).toBe(0);

    // The parked request still completes, on the transport it started on.
    latched.release();
    const response = await inFlight;
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(200);

    // And the reprieve is only for the duration of the call: the session is
    // restamped as it ends, so the next idle window still reclaims it — engine
    // shutdown included, which is what ends the detached sandbox fibers.
    expect(await sessions.sweepIdleSessions(Date.now() + IDLE_TTL_MS)).toBe(1);
    expect(sessions.sessionCount()).toBe(0);
    expect(latched.shutdowns()).toBe(1);
  } finally {
    latched.release();
    await sessions.close();
  }
});
