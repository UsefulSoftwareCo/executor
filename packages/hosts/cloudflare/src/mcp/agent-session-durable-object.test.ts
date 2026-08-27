// oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: the storage fake reproduces the plain Errors the Cloudflare runtime throws, and rejecting is the only way a DurableObjectStorage reports them
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

import { defaultMcpResource } from "@executor-js/host-mcp";
import type { ExecutionEngine, ExecutionResult, ResumeResponse } from "@executor-js/execution";

import {
  McpAgentSessionDOBase,
  type McpApprovalOwner,
  type McpSessionModelResumeResult,
  type SessionMeta,
} from "./agent-session-durable-object";

class MemoryStorage {
  private readonly data = new Map<string, unknown>();
  alarm: number | undefined;

  readonly sql = {
    exec: () => [],
  };

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async setAlarm(time: number | Date): Promise<void> {
    this.alarm = typeof time === "number" ? time : time.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = undefined;
  }

  async delete(key: string | readonly string[]): Promise<void> {
    if (typeof key === "string") {
      this.data.delete(key);
      return;
    }
    for (const entry of key) {
      this.data.delete(entry);
    }
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
  }

  async list<T>(
    options: { readonly prefix?: string; readonly limit?: number } = {},
  ): Promise<Map<string, T>> {
    const rows = new Map<string, T>();
    for (const [key, value] of this.data) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      rows.set(key, value as T);
      if (options.limit && rows.size >= options.limit) break;
    }
    return rows;
  }

  async blockConcurrencyWhile<T>(callback: () => T | Promise<T>): Promise<T> {
    return callback();
  }

  get id(): { readonly name: string } {
    return { name: "streamable-http:session-reconnect" };
  }

  get storage(): MemoryStorage {
    return this;
  }

  waitUntil(_promise: Promise<unknown>): void {}
}

type HarnessSession = {
  alarm: () => Promise<void>;
  ctx: MemoryStorage;
  dbHandle: { readonly end: () => void } | null;
  engine: ExecutionEngine<Cause.YieldableError> | null;
  getConnections?: () => Iterable<unknown>;
  getSessionId: () => string;
  initialized: boolean;
  lastActivityMs: number;
  maxPausedSessionIdleMs: () => number;
  onStart: () => Promise<void>;
  pendingApprovalLeases: Map<string, never>;
  props: Record<string, unknown>;
  runMcpAgentOnStart: () => Promise<void>;
  server?: McpServer;
  sessionMeta: SessionMeta;
  sessionTimeoutMs: () => number;
  resumeExecutionForModel: (
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
  ) => Promise<McpSessionModelResumeResult>;
  validateMcpSessionOwner: (identity: {
    readonly accountId: string;
    readonly organizationId: string;
  }) => Promise<"ok" | "not_found" | "forbidden" | "terminated">;
};

class StaleCloseTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  async start(): Promise<void> {}

  async close(): Promise<void> {}

  async send(_message: JSONRPCMessage): Promise<void> {}
}

class RestoredTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(_message: JSONRPCMessage): Promise<void> {}
}

const makeServer = () => new McpServer({ name: "executor-test", version: "1.0.0" });

const makeDeferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

type ResumeCall = {
  readonly executionId: string;
  readonly response: ResumeResponse;
};

const completed = (result: unknown): ExecutionResult => ({
  status: "completed",
  result: { result },
});

const makeEngine = (
  resultForResume: (executionId: string, response: ResumeResponse) => ExecutionResult | null = () =>
    completed("resume-result"),
): { readonly calls: ResumeCall[]; readonly engine: ExecutionEngine<Cause.YieldableError> } => {
  const calls: ResumeCall[] = [];
  return {
    calls,
    engine: {
      execute: () => Effect.succeed({ result: "execute-result" }),
      executeWithPause: () => Effect.succeed(completed("execute-result")),
      resume: (executionId, response) =>
        Effect.sync(() => {
          calls.push({ executionId, response });
          return resultForResume(executionId, response);
        }),
      getPausedExecution: () => Effect.succeed(null),
      pausedExecutionCount: () => Effect.succeed(0),
      hasPausedExecutions: () => Effect.succeed(false),
      getDescription: Effect.succeed("test engine"),
    },
  };
};

const approval = {
  action: "accept",
  content: { approved: true },
} satisfies ResumeResponse;

const makeHarnessSession = async (): Promise<HarnessSession> => {
  const sessionId = "session-reconnect";
  const sessionMeta: SessionMeta = {
    organizationId: "org-1",
    organizationName: "Org 1",
    userId: "user-1",
    resource: defaultMcpResource,
  };
  const storage = new MemoryStorage();
  const server = makeServer();
  await server.connect(new StaleCloseTransport());

  const session = Object.create(McpAgentSessionDOBase.prototype) as HarnessSession;
  session.ctx = storage;
  session.dbHandle = { end: () => undefined };
  session.engine = makeEngine().engine;
  session.getSessionId = () => sessionId;
  session.initialized = true;
  session.lastActivityMs = Date.now() - 10;
  session.maxPausedSessionIdleMs = () => 1_000;
  session.pendingApprovalLeases = new Map<string, never>();
  session.props = {};
  session.server = server;
  session.sessionMeta = sessionMeta;
  session.sessionTimeoutMs = () => 1;
  session.runMcpAgentOnStart = async () => {
    const restored = session.server ?? makeServer();
    session.server = restored;
    await restored.connect(new RestoredTransport());
    session.engine = makeEngine().engine;
    session.initialized = true;
  };

  return session;
};

// The negotiated MCP-Apps capability arrives once, at `initialize`, and lives
// in the rebuilt server's memory. These pin the storage round-trip that lets a
// cold-restored session rebuild with it instead of silently downgrading every
// artifact to a deep link.
describe("McpAgentSessionDOBase apps capability persistence", () => {
  type CapabilitySession = HarnessSession & {
    persistAppsEnabled: (appsEnabled: boolean) => Effect.Effect<void>;
    loadSessionMeta: () => Effect.Effect<SessionMeta | null>;
    resolveSessionMeta: (token: unknown) => Effect.Effect<SessionMeta>;
    resolveAndStoreSessionMeta: (token: unknown) => Effect.Effect<SessionMeta>;
  };

  const baseMeta: SessionMeta = {
    organizationId: "org-1",
    organizationName: "Org 1",
    userId: "user-1",
    resource: defaultMcpResource,
  };

  const makeCapabilitySession = async (
    stored: SessionMeta = baseMeta,
  ): Promise<{ session: CapabilitySession; storage: MemoryStorage }> => {
    const storage = new MemoryStorage();
    await storage.put("session-meta", stored);
    const session = Object.create(McpAgentSessionDOBase.prototype) as CapabilitySession;
    session.ctx = storage;
    session.getSessionId = () => "session-caps";
    return { session, storage };
  };

  it("persists the negotiated capability so a later restore can read it back", async () => {
    const { session, storage } = await makeCapabilitySession();

    await Effect.runPromise(session.persistAppsEnabled(true));

    expect(await storage.get<SessionMeta>("session-meta")).toMatchObject({
      organizationId: "org-1",
      appsEnabled: true,
    });
  });

  it("records a client that loses apps support just as durably", async () => {
    const { session, storage } = await makeCapabilitySession({ ...baseMeta, appsEnabled: true });

    await Effect.runPromise(session.persistAppsEnabled(false));

    expect(await storage.get<SessionMeta>("session-meta")).toMatchObject({ appsEnabled: false });
  });

  // `init` runs again on every cold restore and rebuilds meta from the bearer
  // token, which carries no capabilities. If that overwrite won, restoring the
  // session would erase the very bit meant to survive it.
  it("carries the stored capability through the re-resolve on cold restore", async () => {
    const { session, storage } = await makeCapabilitySession({ ...baseMeta, appsEnabled: true });
    // What the token resolves to: no `appsEnabled` anywhere in sight.
    session.resolveSessionMeta = () => Effect.succeed(baseMeta);

    const resolved = await Effect.runPromise(
      session.resolveAndStoreSessionMeta({ organizationId: "org-1", userId: "user-1" }),
    );

    expect(resolved.appsEnabled).toBe(true);
    expect(await storage.get<SessionMeta>("session-meta")).toMatchObject({ appsEnabled: true });
  });

  it("leaves a session with no negotiated capability untouched", async () => {
    const { session, storage } = await makeCapabilitySession();
    session.resolveSessionMeta = () => Effect.succeed(baseMeta);

    const resolved = await Effect.runPromise(
      session.resolveAndStoreSessionMeta({ organizationId: "org-1", userId: "user-1" }),
    );

    expect(resolved.appsEnabled).toBeUndefined();
    expect(await storage.get<SessionMeta>("session-meta")).not.toHaveProperty("appsEnabled");
  });

  // Persistence is best-effort observation of a capability, never a reason to
  // fail the session that was merely trying to render something.
  it("stays silent when there is no stored meta to merge into", async () => {
    const storage = new MemoryStorage();
    const session = Object.create(McpAgentSessionDOBase.prototype) as CapabilitySession;
    session.ctx = storage;
    session.getSessionId = () => "session-caps";

    await expect(Effect.runPromise(session.persistAppsEnabled(true))).resolves.toBeUndefined();
    expect(await storage.get<SessionMeta>("session-meta")).toBeUndefined();
  });
});

describe("McpAgentSessionDOBase transport restore", () => {
  it("preserves hibernated response streams when a cold isolate starts", async () => {
    const session = await makeHarnessSession();
    let closeCalls = 0;

    session.initialized = false;
    session.engine = null;
    session.dbHandle = null;
    delete session.server;
    session.getConnections = () => [
      {
        close: () => {
          closeCalls += 1;
        },
      },
    ];
    session.runMcpAgentOnStart = async () => {
      session.server = makeServer();
      session.engine = makeEngine().engine;
      session.initialized = true;
    };

    await session.onStart();

    expect(closeCalls).toBe(0);
    expect(session.initialized).toBe(true);
  });

  it("closes response streams when an in-memory runtime restarts", async () => {
    const session = await makeHarnessSession();
    let closeCalls = 0;

    session.getConnections = () => [
      {
        close: () => {
          closeCalls += 1;
        },
      },
    ];
    session.runMcpAgentOnStart = async () => {
      session.server = makeServer();
      session.engine = makeEngine().engine;
      session.initialized = true;
    };

    await session.onStart();

    expect(closeCalls).toBe(1);
    expect(session.initialized).toBe(true);
  });

  it("restores a same-session request after idle disposal leaves a stale server transport", async () => {
    const session = await makeHarnessSession();

    await session.alarm();

    await expect(
      session.validateMcpSessionOwner({ accountId: "user-1", organizationId: "org-1" }),
    ).resolves.toBe("ok");
  });

  it("single-flights concurrent same-session restore after idle disposal", async () => {
    const session = await makeHarnessSession();
    const firstRestoreEntered = makeDeferred();
    const finishRestore = makeDeferred();
    let onStartCalls = 0;
    let restoredServer: McpServer | undefined;

    session.runMcpAgentOnStart = async () => {
      onStartCalls += 1;
      const restored = session.server ?? makeServer();
      restoredServer ??= restored;
      session.server = restored;
      firstRestoreEntered.resolve();
      await finishRestore.promise;
      await restored.connect(new RestoredTransport());
      session.initialized = true;
    };

    await session.alarm();

    const first = session.validateMcpSessionOwner({
      accountId: "user-1",
      organizationId: "org-1",
    });
    const second = session.validateMcpSessionOwner({
      accountId: "user-1",
      organizationId: "org-1",
    });

    await firstRestoreEntered.promise;
    await Promise.resolve();
    finishRestore.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
    expect(onStartCalls).toBe(1);
    expect(session.server).toBe(restoredServer);
  });

  it("single-flights SDK onStart callers with same-session restore", async () => {
    const session = await makeHarnessSession();
    const firstStartEntered = makeDeferred();
    const finishStart = makeDeferred();
    let onStartCalls = 0;

    session.runMcpAgentOnStart = async () => {
      onStartCalls += 1;
      const restored = session.server ?? makeServer();
      session.server = restored;
      firstStartEntered.resolve();
      await finishStart.promise;
      await restored.connect(new RestoredTransport());
      session.initialized = true;
    };

    await session.alarm();

    const restore = session.validateMcpSessionOwner({
      accountId: "user-1",
      organizationId: "org-1",
    });
    const sdkStart = session.onStart();

    await firstStartEntered.promise;
    await Promise.resolve();
    finishStart.resolve();

    await expect(Promise.all([restore, sdkStart])).resolves.toEqual(["ok", undefined]);
    expect(onStartCalls).toBe(1);
  });

  it("single-flights model resume restore with SDK onStart", async () => {
    const session = await makeHarnessSession();
    const firstStartEntered = makeDeferred();
    const finishStart = makeDeferred();
    const restoredEngine = makeEngine(() => completed("model-result"));
    let onStartCalls = 0;

    session.runMcpAgentOnStart = async () => {
      onStartCalls += 1;
      const restored = session.server ?? makeServer();
      session.server = restored;
      firstStartEntered.resolve();
      await finishStart.promise;
      await restored.connect(new RestoredTransport());
      session.engine = restoredEngine.engine;
      session.initialized = true;
    };

    await session.alarm();

    const resume = session.resumeExecutionForModel(
      "exec-model",
      { accountId: "user-1", organizationId: "org-1" },
      approval,
    );
    const sdkStart = session.onStart();

    await firstStartEntered.promise;
    await Promise.resolve();
    finishStart.resolve();

    const [resumeResult] = await Promise.all([resume, sdkStart]);
    expect(resumeResult).toMatchObject({
      status: "result",
      result: {
        structuredContent: {
          status: "completed",
          result: "model-result",
        },
      },
    });
    expect(onStartCalls).toBe(1);
    expect(restoredEngine.calls).toEqual([{ executionId: "exec-model", response: approval }]);
  });
});

// Every Cloudflare deploy resets live Durable Objects: workerd aborts whatever
// storage operation is in flight with "Durable Object reset because its code was
// updated." That is the guaranteed consequence of shipping, not a defect — but
// it lands on whichever write `init()` happens to be doing, and the last thing
// `init()` does is `markActivity`, which writes a timestamp and arms the idle
// alarm. Nothing about a session depends on that write succeeding: the in-memory
// clock is already set, and every later touch re-arms the alarm. Losing a fully
// built, working session over it — and paging for the privilege — is the bug.
describe("McpAgentSessionDOBase init survives a platform reset of its bookkeeping write", () => {
  const CODE_UPDATE_RESET = "Durable Object reset because its code was updated.";

  class ResettingStorage extends MemoryStorage {
    /** Storage keys whose `put` should fail, and with what. */
    readonly putFailures = new Map<string, () => Error>();
    setAlarmFailure: (() => Error) | null = null;

    override async put(key: string, value: unknown): Promise<void> {
      const failure = this.putFailures.get(key);
      if (failure) {
        this.putFailures.delete(key);
        throw failure();
      }
      await super.put(key, value);
    }

    override async setAlarm(time: number | Date): Promise<void> {
      if (this.setAlarmFailure) {
        const failure = this.setAlarmFailure;
        this.setAlarmFailure = null;
        throw failure();
      }
      await super.setAlarm(time);
    }
  }

  type InitSession = {
    ctx: ResettingStorage;
    captureCause: (cause: Cause.Cause<unknown>) => void;
    dbHandle: { readonly end: () => void } | null;
    engine: ExecutionEngine<Cause.YieldableError> | null;
    getSessionId: () => string;
    init: () => Promise<void>;
    initialized: boolean;
    lastActivityMs: number;
    pendingApprovalLeases: Map<string, never>;
    props: Record<string, unknown>;
    server?: McpServer;
    sessionTimeoutMs: () => number;
    buildMcpServer: () => Effect.Effect<{ mcpServer: McpServer; engine: unknown }>;
    openSessionDb: () => { readonly end: () => void };
    resolveSessionMeta: () => Effect.Effect<SessionMeta>;
    validateMcpSessionOwner: (identity: McpApprovalOwner) => Promise<string>;
  };

  const sessionMeta: SessionMeta = {
    organizationId: "org-1",
    organizationName: "Org 1",
    userId: "user-1",
    resource: defaultMcpResource,
  };

  const makeInitSession = (): {
    session: InitSession;
    storage: ResettingStorage;
    captured: Cause.Cause<unknown>[];
  } => {
    const storage = new ResettingStorage();
    const captured: Cause.Cause<unknown>[] = [];
    const session = Object.create(McpAgentSessionDOBase.prototype) as InitSession;
    session.ctx = storage;
    session.captureCause = (cause) => {
      captured.push(cause);
    };
    session.dbHandle = null;
    session.engine = null;
    session.getSessionId = () => "session-init";
    session.initialized = false;
    session.lastActivityMs = 0;
    session.pendingApprovalLeases = new Map<string, never>();
    session.props = { session: { organizationId: "org-1", userId: "user-1" } };
    session.sessionTimeoutMs = () => 60_000;
    session.resolveSessionMeta = () => Effect.succeed(sessionMeta);
    session.openSessionDb = () => ({ end: () => undefined });
    session.buildMcpServer = () =>
      Effect.succeed({ mcpServer: makeServer(), engine: makeEngine().engine });
    return { session, storage, captured };
  };

  it("keeps the session when a deploy resets the last-activity write", async () => {
    const { session, storage, captured } = makeInitSession();
    storage.putFailures.set("last-activity-ms", () => new Error(CODE_UPDATE_RESET));

    await expect(
      session.init(),
      "a healthy session is not torn down by a lost timestamp",
    ).resolves.toBeUndefined();

    expect(session.initialized, "the runtime stays installed").toBe(true);
    expect(session.engine, "the execution engine survives").not.toBeNull();
    expect(session.server, "the MCP server survives").toBeDefined();
    expect(captured, "a platform reset of bookkeeping is not paged as a defect").toEqual([]);
  });

  it("keeps the session when a deploy resets the idle-alarm write", async () => {
    const { session, storage, captured } = makeInitSession();
    storage.setAlarmFailure = () => new Error(CODE_UPDATE_RESET);

    await expect(session.init()).resolves.toBeUndefined();

    expect(session.initialized).toBe(true);
    expect(captured).toEqual([]);
  });

  // The alarm is the only durable consequence of a dropped markActivity, and it
  // must self-heal: the next request re-arms it. Otherwise "best effort" would
  // quietly mean "this session never times out".
  it("re-arms the idle alarm on the next touch after a lost bookkeeping write", async () => {
    const { session, storage } = makeInitSession();
    storage.setAlarmFailure = () => new Error(CODE_UPDATE_RESET);

    await session.init();
    expect(storage.alarm, "the write that failed left no alarm").toBeUndefined();

    await expect(
      session.validateMcpSessionOwner({ accountId: "user-1", organizationId: "org-1" }),
    ).resolves.toBe("ok");
    expect(storage.alarm, "the next request re-establishes the idle clock").toBeGreaterThan(0);
  });

  // Best-effort is scoped to the platform's own resets. A bookkeeping write that
  // fails for any other reason is still a defect and must still be reported —
  // otherwise this change trades a noisy bug for a silent one.
  it("still fails and reports when the bookkeeping write breaks for an unknown reason", async () => {
    const { session, storage, captured } = makeInitSession();
    storage.putFailures.set("last-activity-ms", () => new Error("quota exceeded for namespace"));

    await expect(session.init()).rejects.toThrow(/quota exceeded/);
    expect(captured.length, "an unrecognized failure is still captured").toBe(1);
  });

  // Session meta is not bookkeeping — ownership validation reads it back — so a
  // reset there must still fail init. What it must NOT do is escape as an
  // unclassified defect: the caller renders it as a retryable error, and the DO
  // stops paging for a condition every deploy guarantees.
  it("fails a meta write reset without paging, so the caller can render a retry", async () => {
    const { session, storage, captured } = makeInitSession();
    storage.putFailures.set("session-meta", () => new Error(CODE_UPDATE_RESET));

    await expect(session.init()).rejects.toThrow(/code was updated/);
    expect(captured, "a deploy reset is expected platform behaviour, not a defect").toEqual([]);
  });
});
