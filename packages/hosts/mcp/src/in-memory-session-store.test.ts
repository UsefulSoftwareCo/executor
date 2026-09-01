import { describe, expect, it } from "@effect/vitest";
import { Effect, type Cause } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";
import { FormElicitation, ToolAddress, createExecutor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

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
  orgRoleModel: "organization",
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
  return {
    engine,
    started,
    release: () => openGate(),
    shutdowns: () => shutdowns,
  };
};

// A long TTL keeps the sweep's own timer out of the way; the assertions drive
// `sweepIdleSessions` directly with an explicit instant instead of sleeping
// through a real window, so the test is deterministic rather than timing-raced.
const IDLE_TTL_MS = 60_000;

type TestSessionStore = ReturnType<typeof makeInMemoryMcpSessionStore>;

/** Open a session on `sessions` and return its minted id. */
const openSession = async (
  sessions: TestSessionStore,
  principal: Principal = TEST_PRINCIPAL,
  requestUrl = "https://executor.test/mcp",
): Promise<string> => {
  const response = (await Effect.runPromise(
    sessions.store.dispatch({
      request: new Request(requestUrl, {
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
      principal,
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

it("keeps overlapping warm-session workspace writes bound to their request roles", async () => {
  const executor = await Effect.runPromise(
    createExecutor({ ...makeTestConfig(), orgWrites: "request" }),
  );
  const started = new Map<string, () => void>();
  const startedPromises = ["member", "admin"].map(
    (name) =>
      new Promise<void>((resolve) => {
        started.set(name, resolve);
      }),
  );
  let releaseWrites: () => void = () => {};
  const writeGate = new Promise<void>((resolve) => {
    releaseWrites = resolve;
  });
  const writePolicy = (pattern: string) =>
    Effect.promise(async () => {
      started.get(pattern)?.();
      await writeGate;
    }).pipe(
      Effect.andThen(executor.policies.create({ owner: "org", pattern, action: "block" })),
      Effect.map((policy) => ({ result: policy.pattern })),
    );
  const engine: ExecutionEngine<Cause.YieldableError> = {
    ...makeIdleTestEngine(),
    execute: writePolicy,
    executeWithPause: (code) =>
      writePolicy(code).pipe(Effect.map((result) => ({ status: "completed" as const, result }))),
  };
  const sessions = makeInMemoryMcpSessionStore(() =>
    createExecutorMcpServer({ engine }).pipe(Effect.map((mcpServer) => ({ mcpServer, engine }))),
  );
  const admin = { ...TEST_PRINCIPAL, orgRole: "admin" as const };
  const sessionId = await openSession(sessions, admin);
  const call = (id: number, role: "admin" | "member") =>
    Effect.runPromise(
      sessions.store.dispatch({
        request: new Request("https://executor.test/mcp", {
          method: "POST",
          headers: { ...MCP_POST_HEADERS, "mcp-session-id": sessionId },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "execute", arguments: { code: role } },
          }),
        }),
        principal: { ...admin, orgRole: role },
        resource: defaultMcpResource,
        sessionId,
        method: "POST",
      }),
    ) as Promise<Response>;

  // Start the demoted member first, then let a stale admin request overlap it.
  // A session-global cell ends this interleaving at "allowed" and incorrectly
  // lets both sinks commit; request-local bindings keep the member denied.
  const memberCall = call(2, "member");
  await startedPromises[0];
  const adminCall = call(3, "admin");
  await startedPromises[1];
  releaseWrites();

  const [memberResponse, adminResponse] = await Promise.all([memberCall, adminCall]);
  const memberBody = (await memberResponse.json()) as {
    result?: { isError?: boolean };
  };
  const adminBody = (await adminResponse.json()) as {
    result?: { isError?: boolean };
  };
  expect(memberBody.result?.isError).toBe(true);
  expect(adminBody.result?.isError).not.toBe(true);
  const policies = await Effect.runPromise(executor.policies.list());
  expect(policies.map((policy) => policy.pattern)).toEqual(["admin"]);

  await sessions.close();
  await Effect.runPromise(executor.close());
});

it("binds a paused workspace write to the resuming principal after demotion", async () => {
  const executor = await Effect.runPromise(
    createExecutor({ ...makeTestConfig(), orgWrites: "request" }),
  );
  const executionId = "exec_resume_demotion";
  const pattern = "paused-resume-demotion.*";
  const engine: ExecutionEngine<Cause.YieldableError> = {
    ...makeIdleTestEngine(),
    executeWithPause: () =>
      Effect.succeed({
        status: "paused",
        execution: {
          id: executionId,
          elicitationContext: {
            address: ToolAddress.make("executor.coreTools.policies.create"),
            args: { owner: "org", pattern, action: "block" },
            request: FormElicitation.make({
              message: "Approve?",
              requestedSchema: {},
            }),
          },
        },
      }),
    resume: () =>
      executor.policies.create({ owner: "org", pattern, action: "block" }).pipe(
        Effect.map((policy) => ({
          status: "completed",
          result: { result: policy },
        })),
      ),
  };
  const sessions = makeInMemoryMcpSessionStore(() =>
    createExecutorMcpServer({ engine }).pipe(Effect.map((mcpServer) => ({ mcpServer, engine }))),
  );
  const admin = { ...TEST_PRINCIPAL, orgRole: "admin" as const };
  const sessionId = await openSession(sessions, admin);
  const call = (id: number, principal: Principal, name: "execute" | "resume", args: unknown) =>
    Effect.runPromise(
      sessions.store.dispatch({
        request: new Request("https://executor.test/mcp", {
          method: "POST",
          headers: { ...MCP_POST_HEADERS, "mcp-session-id": sessionId },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        principal,
        resource: defaultMcpResource,
        sessionId,
        method: "POST",
      }),
    ) as Promise<Response>;

  const paused = await call(2, admin, "execute", {
    code: "create workspace policy",
  });
  expect(paused.status).toBe(200);
  const demoted = { ...admin, orgRole: "member" as const };
  const resumed = await call(3, demoted, "resume", {
    executionId,
    action: "accept",
  });
  const body = (await resumed.json()) as { result?: { isError?: boolean } };
  expect(body.result?.isError).toBe(true);
  expect(await Effect.runPromise(executor.policies.list())).toEqual([]);

  await sessions.close();
  await Effect.runPromise(executor.close());
});

it("uses the browser approver's demoted role after an admin starts waiting", async () => {
  const executor = await Effect.runPromise(
    createExecutor({ ...makeTestConfig({ coreTools: {} }), orgWrites: "request" }),
  );
  const executionId = "exec_browser_resume_demotion";
  const pattern = "browser-resume-demotion.*";
  const pausedExecution = {
    id: executionId,
    elicitationContext: {
      address: ToolAddress.make("executor.coreTools.policies.create"),
      args: { owner: "org", pattern, action: "block" },
      request: FormElicitation.make({ message: "Approve?", requestedSchema: {} }),
    },
  };
  const engine: ExecutionEngine<Cause.YieldableError> = {
    ...makeIdleTestEngine(),
    executeWithPause: () =>
      Effect.succeed({ status: "paused" as const, execution: pausedExecution }),
    getPausedExecution: (id) => Effect.succeed(id === executionId ? pausedExecution : null),
    resume: (id) =>
      id === executionId
        ? executor.policies.create({ owner: "org", pattern, action: "block" }).pipe(
            Effect.map((policy) => ({
              status: "completed" as const,
              result: { result: policy },
            })),
          )
        : Effect.succeed(null),
  };
  const sessions = makeInMemoryMcpSessionStore((_principal, options) =>
    createExecutorMcpServer({ engine, ...options }).pipe(
      Effect.map((mcpServer) => ({ mcpServer, engine })),
    ),
  );
  const admin = { ...TEST_PRINCIPAL, orgRole: "admin" as const };
  const member = { ...admin, orgRole: "member" as const };
  const sessionId = await openSession(
    sessions,
    admin,
    "https://executor.test/mcp?elicitation_mode=browser",
  );

  const call = (id: number, name: "execute" | "resume", args: unknown) =>
    Effect.runPromise(
      sessions.store.dispatch({
        request: new Request("https://executor.test/mcp", {
          method: "POST",
          headers: { ...MCP_POST_HEADERS, "mcp-session-id": sessionId },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        principal: admin,
        resource: defaultMcpResource,
        sessionId,
        method: "POST",
      }),
    ) as Promise<Response>;

  const pausedResponse = await call(2, "execute", { code: "create workspace policy" });
  const pausedBody = (await pausedResponse.json()) as {
    result?: { structuredContent?: { executionId?: string } };
  };
  const pausedExecutionId = pausedBody.result?.structuredContent?.executionId;
  expect(pausedExecutionId).toBe(executionId);
  if (!pausedExecutionId) return;

  const firstResume = call(3, "resume", { executionId: pausedExecutionId });
  await Promise.resolve();
  await Promise.resolve();

  const approvalResponse = await sessions.handleApprovalRequest(
    new Request(
      `https://executor.test/api/mcp-sessions/${sessionId}/executions/${pausedExecutionId}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "accept", content: {} }),
      },
    ),
    member,
  );
  expect(approvalResponse?.status).toBe(200);

  const resumeBody = (await (await firstResume).json()) as {
    result?: { isError?: boolean };
  };
  expect(resumeBody.result?.isError).toBe(true);
  expect(await Effect.runPromise(executor.policies.list())).toEqual([]);

  await sessions.close();
  await Effect.runPromise(executor.close());
});

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
  return {
    sessions: makeInMemoryMcpSessionStore(buildServer),
    buildCount: (): number => builds,
  };
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
