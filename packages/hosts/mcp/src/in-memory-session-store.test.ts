import { describe, expect, it } from "@effect/vitest";
import { Effect, type Cause } from "effect";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import type { ExecutionEngine } from "@executor-js/execution";
import { FormElicitation, ToolAddress, createExecutor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import {
  makeInMemoryMcpSessionStore,
  McpEngineBuildError,
  type McpBuildServer,
  type McpBuildServerOptions,
} from "./in-memory-session-store";
import { defaultMcpResource, type McpResource, type Principal } from "./seams";
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
type OpenSessionOptions = {
  readonly resource?: McpResource;
  readonly elicitationMode?: "browser" | "model" | "native";
  readonly principal?: Principal;
  readonly appTools?: boolean;
};

/** Open a session on `sessions` and return its minted id. */
const openSession = async (
  sessions: TestSessionStore,
  {
    resource = defaultMcpResource,
    elicitationMode = "model",
    principal = TEST_PRINCIPAL,
    appTools = false,
  }: OpenSessionOptions = {},
): Promise<string> => {
  const path = resource.kind === "default" ? "/mcp" : `/mcp/toolkits/${resource.slug}`;
  const response = (await Effect.runPromise(
    sessions.store.dispatch({
      request: new Request(`https://executor.test${path}?elicitation_mode=${elicitationMode}`, {
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
            capabilities: appTools
              ? { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } }
              : {},
            clientInfo: { name: "session-store-test", version: "1.0.0" },
          },
        }),
      }),
      principal,
      resource,
      sessionId: null,
      method: "POST",
    }),
  )) as Response;
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id") ?? "";
  expect(sessionId).not.toBe("");
  if (appTools) {
    await Effect.runPromise(
      sessions.store.dispatch({
        request: new Request(`https://executor.test${path}`, {
          method: "POST",
          headers: { ...MCP_POST_HEADERS, "mcp-session-id": sessionId },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        }),
        principal,
        resource,
        sessionId,
        method: "POST",
      }),
    );
  }
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
  const sessionId = await openSession(sessions, { principal: admin });
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
  const sessionId = await openSession(sessions, { principal: admin });
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
  const sessionId = await openSession(sessions, {
    principal: admin,
    elicitationMode: "browser",
  });

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

  it("shuts down the scoped executor and custom closer when an idle session is evicted", async () => {
    let executorClosed = 0;
    let customClosed = 0;
    const realExecutor = await Effect.runPromise(createExecutor(makeTestConfig()));
    const testExecutor = {
      ...realExecutor,
      close: () =>
        realExecutor.close().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              executorClosed += 1;
            }),
          ),
        ),
    };
    const engine = makeIdleTestEngine();
    const sessions = makeInMemoryMcpSessionStore(
      () =>
        createExecutorMcpServer({ engine }).pipe(
          Effect.map((mcpServer) => ({
            mcpServer,
            engine,
            executor: testExecutor,
            close: () => {
              customClosed += 1;
              return Promise.resolve();
            },
          })),
        ),
      { sessionIdleTtlMs: IDLE_TTL_MS },
    );

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always close the store
    try {
      await openSession(sessions);
      expect(sessions.sessionCount()).toBe(1);
      expect(executorClosed).toBe(0);
      expect(customClosed).toBe(0);

      // Advance clock past idle window and sweep.
      expect(await sessions.sweepIdleSessions(Date.now() + IDLE_TTL_MS + 1)).toBe(1);
      expect(sessions.sessionCount()).toBe(0);
      expect(executorClosed).toBe(1);
      expect(customClosed).toBe(1);
    } finally {
      await sessions.close();
    }
  });

  it("shuts down the scoped executor when sessions.close() is called", async () => {
    let executorClosed = 0;
    const realExecutor = await Effect.runPromise(createExecutor(makeTestConfig()));
    const testExecutor = {
      ...realExecutor,
      close: () =>
        realExecutor.close().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              executorClosed += 1;
            }),
          ),
        ),
    };
    const engine = makeIdleTestEngine();
    const sessions = makeInMemoryMcpSessionStore(
      () =>
        createExecutorMcpServer({ engine }).pipe(
          Effect.map((mcpServer) => ({
            mcpServer,
            engine,
            executor: testExecutor,
          })),
        ),
      { sessionIdleTtlMs: IDLE_TTL_MS },
    );

    await openSession(sessions);
    expect(sessions.sessionCount()).toBe(1);
    expect(executorClosed).toBe(0);

    await sessions.close();
    expect(executorClosed).toBe(1);
    expect(sessions.sessionCount()).toBe(0);
  });
});

describe("cross-session model resume boundaries and lifetime", () => {
  type FixtureOptions = {
    readonly latchResume?: boolean;
    readonly appTools?: boolean;
    readonly resumeEffect?: () => ReturnType<ExecutionEngine<Cause.YieldableError>["resume"]>;
  };
  type ResumeOptions = {
    readonly resource?: McpResource;
    readonly requestId?: number;
    readonly principal?: Principal;
    readonly executionId?: string;
    readonly toolName?: "resume" | "execute-action-resume";
  };

  const executionId = "exec_cross_session";
  const pausedExecution = {
    id: executionId,
    elicitationContext: {
      address: ToolAddress.make("executor.coreTools.policies.create"),
      args: { owner: "org", pattern: "cross-session.*", action: "block" },
      request: FormElicitation.make({ message: "Approve?", requestedSchema: {} }),
    },
  };
  const completed = {
    status: "completed" as const,
    result: { result: "owner-resumed" },
  };

  const fixture = (options: FixtureOptions = {}) => {
    let built = 0;
    let paused = true;
    let settled = false;
    let resuming = false;
    let resumeCalls = 0;
    let ownerShutdowns = 0;
    const started = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const ownerEngine: ExecutionEngine<Cause.YieldableError> = {
      ...makeIdleTestEngine(),
      getPausedExecution: (id) =>
        Effect.sync(() => (id === executionId && paused ? pausedExecution : null)),
      isExecutionSettled: (id) => Effect.sync(() => id === executionId && settled),
      resume: (id) =>
        Effect.gen(function* () {
          if (id !== executionId) return null;
          if (settled) return completed;
          paused = false;
          if (!resuming) {
            resumeCalls += 1;
            resuming = true;
          } else joined.resolve();
          started.resolve();
          if (options.latchResume) yield* Effect.promise(() => gate.promise);
          if (options.resumeEffect) return yield* options.resumeEffect();
          settled = true;
          return completed;
        }),
      shutdown: Effect.sync(() => {
        ownerShutdowns += 1;
      }),
    };
    const sessions = makeInMemoryMcpSessionStore(
      (_principal, buildOptions) => {
        const engine = ++built === 1 ? ownerEngine : makeIdleTestEngine();
        return createExecutorMcpServer({
          engine,
          ...(options.appTools ? { loadAppShellHtml: async () => "<html/>" } : {}),
          ...(buildOptions ?? {}),
        }).pipe(Effect.map((mcpServer) => ({ mcpServer, engine })));
      },
      { sessionIdleTtlMs: IDLE_TTL_MS, sessionSweepIntervalMs: IDLE_TTL_MS },
    );
    return {
      sessions,
      started: started.promise,
      joined: joined.promise,
      release: gate.resolve,
      resumeCalls: () => resumeCalls,
      ownerShutdowns: () => ownerShutdowns,
    };
  };

  const resume = async (
    sessions: TestSessionStore,
    sessionId: string,
    {
      resource = defaultMcpResource,
      requestId = 2,
      principal = TEST_PRINCIPAL,
      executionId: requestedExecutionId = executionId,
      toolName = "resume",
    }: ResumeOptions = {},
  ) => {
    const path = resource.kind === "default" ? "/mcp" : `/mcp/toolkits/${resource.slug}`;
    const response = await Effect.runPromise(
      sessions.store.dispatch({
        request: new Request(`https://executor.test${path}`, {
          method: "POST",
          headers: { ...MCP_POST_HEADERS, "mcp-session-id": sessionId },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method: "tools/call",
            params: {
              name: toolName,
              arguments: { executionId: requestedExecutionId, action: "accept", content: "{}" },
            },
          }),
        }),
        principal,
        resource,
        sessionId,
        method: "POST",
      }),
    );
    expect(response).toBeInstanceOf(Response);
    const body = (await (response as Response).json()) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    return body.result ?? {};
  };

  const withFixture = (
    run: (value: ReturnType<typeof fixture>) => Promise<void>,
    options: FixtureOptions = {},
  ) => {
    const value = fixture(options);
    return Effect.runPromise(
      Effect.promise(() => run(value)).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            value.release();
            await value.sessions.close();
          }),
        ),
      ),
    );
  };

  const boundaries: ReadonlyArray<{
    readonly name: string;
    readonly owner?: OpenSessionOptions;
    readonly requester?: OpenSessionOptions;
  }> = [
    {
      name: "MCP resource",
      requester: { resource: { kind: "toolkit", slug: "restricted" } },
    },
    { name: "approval mode", owner: { elicitationMode: "browser" } },
    {
      name: "account",
      requester: { principal: { ...TEST_PRINCIPAL, accountId: "acct_other" } },
    },
    {
      name: "organization",
      requester: { principal: { ...TEST_PRINCIPAL, organizationId: "org_other" } },
    },
  ];

  it.each(boundaries)("does not cross the $name boundary", ({ owner, requester = {} }) =>
    withFixture(async (f) => {
      await openSession(f.sessions, owner);
      const next = await openSession(f.sessions, requester);
      const result = await resume(f.sessions, next, requester);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "execution_forbidden" });
      expect(f.resumeCalls()).toBe(0);
    }),
  );

  it.each(["browser", "native"] as const)(
    "does not let %s-mode app tools resume another session's model pause",
    (elicitationMode) =>
      withFixture(
        async (f) => {
          await openSession(f.sessions);
          const next = await openSession(f.sessions, { elicitationMode, appTools: true });
          const result = await resume(f.sessions, next, { toolName: "execute-action-resume" });
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({ status: "execution_not_found" });
          expect(f.resumeCalls()).toBe(0);
        },
        { appTools: true },
      ),
  );

  it("keeps the owning session alive while another session resumes its execution", () =>
    withFixture(
      async (f) => {
        await openSession(f.sessions);
        const next = await openSession(f.sessions);
        const pending = resume(f.sessions, next);
        await f.started;
        expect(await f.sessions.sweepIdleSessions(Date.now() + IDLE_TTL_MS + 1000)).toBe(0);
        expect(f.ownerShutdowns()).toBe(0);
        f.release();
        await pending;
      },
      { latchResume: true },
    ));

  it("replays a settled resume across another fresh session without repeating side effects", () =>
    withFixture(async (f) => {
      await openSession(f.sessions);
      const next = await openSession(f.sessions);
      expect((await resume(f.sessions, next)).structuredContent).toMatchObject({
        status: "completed",
      });
      const retry = await openSession(f.sessions);
      const replay = await resume(f.sessions, retry, { requestId: 3 });
      expect(replay.isError).toBeFalsy();
      expect(replay.structuredContent).toMatchObject({
        status: "completed",
        result: "owner-resumed",
      });
      expect(f.resumeCalls()).toBe(1);
    }));

  it("joins an in-flight resume from another fresh session", () =>
    withFixture(
      async (f) => {
        await openSession(f.sessions);
        const first = resume(f.sessions, await openSession(f.sessions));
        await f.started;
        const retry = resume(f.sessions, await openSession(f.sessions));
        // The pause has been consumed but its continuation is still running.
        const joined = await Promise.race([f.joined.then(() => true), retry.then(() => false)]);
        expect(joined).toBe(true);
        f.release();
        const [initial, repeated] = await Promise.all([first, retry]);
        expect(initial.structuredContent).toMatchObject({ status: "completed" });
        expect(repeated.structuredContent).toMatchObject({
          status: "completed",
          result: "owner-resumed",
        });
        expect(f.resumeCalls()).toBe(1);
      },
      { latchResume: true },
    ));

  it("reports a missing id without resuming a different execution", () =>
    withFixture(async (f) => {
      await openSession(f.sessions);
      const next = await openSession(f.sessions);
      const result = await resume(f.sessions, next, { executionId: "exec_unknown" });
      expect(result.structuredContent).toMatchObject({ status: "execution_not_found" });
      expect(f.resumeCalls()).toBe(0);
    }));

  it("does not resurrect an execution after its owner session is disposed", () =>
    withFixture(async (f) => {
      const owner = await openSession(f.sessions);
      const next = await openSession(f.sessions);
      await Effect.runPromise(f.sessions.store.dispose(owner));
      const result = await resume(f.sessions, next);
      expect(result.structuredContent).toMatchObject({ status: "execution_not_found" });
      expect(f.resumeCalls()).toBe(0);
    }));

  it("returns an opaque execution failure rather than recovery instructions for a missing pause", () =>
    withFixture(
      async (f) => {
        await openSession(f.sessions);
        const result = await resume(f.sessions, await openSession(f.sessions));
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ status: "error" });
        expect(result.structuredContent?.error).toMatch(/Internal tool error/);
        expect(JSON.stringify(result)).not.toContain("sensitive continuation detail");
        expect(JSON.stringify(result)).not.toContain("run the execute tool again");
      },
      { resumeEffect: () => Effect.die("sensitive continuation detail") },
    ));

  it("uses the current resuming request's role after both sessions were initialized as admin", async () => {
    const executor = await Effect.runPromise(
      createExecutor({ ...makeTestConfig(), orgWrites: "request" }),
    );
    await Effect.runPromise(
      Effect.promise(() =>
        withFixture(
          async (f) => {
            const admin: Principal = { ...TEST_PRINCIPAL, orgRole: "admin" };
            await openSession(f.sessions, { principal: admin });
            const next = await openSession(f.sessions, { principal: admin });
            const result = await resume(f.sessions, next, {
              principal: { ...admin, orgRole: "member" },
            });
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({ status: "error" });
            expect(await Effect.runPromise(executor.policies.list())).toEqual([]);
          },
          {
            resumeEffect: () =>
              executor.policies
                .create({
                  owner: "org",
                  pattern: "cross-session-demotion.*",
                  action: "block",
                })
                .pipe(
                  Effect.map((policy) => ({
                    status: "completed" as const,
                    result: { result: policy },
                  })),
                ),
          },
        ),
      ).pipe(Effect.ensuring(executor.close().pipe(Effect.orDie))),
    );
  });
});
