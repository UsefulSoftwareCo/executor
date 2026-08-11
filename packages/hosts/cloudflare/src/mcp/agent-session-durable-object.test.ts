import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

import { defaultMcpResource, type Principal } from "@executor-js/host-mcp";
import type { ModernMcpDispatcher } from "@executor-js/host-mcp/modern-tool-server";
import type { ExecutionEngine, ExecutionResult, ResumeResponse } from "@executor-js/execution";

import {
  McpAgentSessionDOBase,
  type McpApprovalOwner,
  type McpSessionInit,
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
  activeModernRequestCount: number;
  alarm: () => Promise<void>;
  beginModernRequest: () => Promise<() => void>;
  closeRuntime: () => Effect.Effect<void>;
  ctx: MemoryStorage;
  dbHandle: { readonly end: () => void } | null;
  engine: ExecutionEngine<Cause.YieldableError> | null;
  getConnections?: () => Iterable<unknown>;
  getSessionId: () => string;
  handleModernRequest: (
    request: Request,
    principal: Principal,
    token: McpSessionInit,
  ) => Promise<Response>;
  initialized: boolean;
  lastActivityMs: number;
  maxPausedSessionIdleMs: () => number;
  modernDispatcher: ModernMcpDispatcher | null;
  modernDispatcherPromise: Promise<ModernMcpDispatcher> | null;
  modernRequestDrainWaiters: Set<() => void>;
  onStart: () => Promise<void>;
  pendingApprovalLeases: Map<string, never>;
  props: Record<string, unknown>;
  runMcpAgentOnStart: () => Promise<void>;
  runningExecutionCount: () => Promise<number>;
  runtimeClosePromise: Promise<void> | null;
  server?: McpServer;
  sessionMeta: SessionMeta | null;
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

class GatedModernStorage extends MemoryStorage {
  readonly readEntered = makeDeferred();
  readonly releaseRead = makeDeferred();
  modernKeyReads = 0;

  override async get<T>(key: string): Promise<T | undefined> {
    if (key === "modern-request-state-key") {
      this.modernKeyReads += 1;
      this.readEntered.resolve();
      await this.releaseRead.promise;
    }
    return super.get<T>(key);
  }
}

class GatedSessionMetaStorage extends MemoryStorage {
  readonly readEntered = makeDeferred();
  readonly releaseRead = makeDeferred();

  override async get<T>(key: string): Promise<T | undefined> {
    if (key === "session-meta") {
      this.readEntered.resolve();
      await this.releaseRead.promise;
    }
    return super.get<T>(key);
  }
}

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

const makeHarnessSession = async (
  storage: MemoryStorage = new MemoryStorage(),
): Promise<HarnessSession> => {
  const sessionId = "session-reconnect";
  const sessionMeta: SessionMeta = {
    organizationId: "org-1",
    organizationName: "Org 1",
    userId: "user-1",
    resource: defaultMcpResource,
  };
  const server = makeServer();
  await server.connect(new StaleCloseTransport());

  const session = Object.create(McpAgentSessionDOBase.prototype) as HarnessSession;
  session.activeModernRequestCount = 0;
  session.ctx = storage;
  session.dbHandle = { end: () => undefined };
  session.engine = makeEngine().engine;
  session.getSessionId = () => sessionId;
  session.initialized = true;
  session.lastActivityMs = Date.now() - 10;
  session.maxPausedSessionIdleMs = () => 1_000;
  session.modernDispatcher = null;
  session.modernDispatcherPromise = null;
  session.modernRequestDrainWaiters = new Set();
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
  session.runtimeClosePromise = null;

  return session;
};

describe("McpAgentSessionDOBase modern dispatcher initialization", () => {
  type ModernDispatcherHarness = {
    ctx: MemoryStorage;
    modernDispatcher: ModernMcpDispatcher | null;
    modernDispatcherPromise: Promise<ModernMcpDispatcher> | null;
    runtimeClosePromise: Promise<void> | null;
    ensureModernDispatcher: (
      principal: Principal,
      token: McpSessionInit,
    ) => Promise<ModernMcpDispatcher>;
  };

  it("single-flights concurrent first requests onto one dispatcher", async () => {
    const storage = new GatedModernStorage();
    const session = Object.create(McpAgentSessionDOBase.prototype) as ModernDispatcherHarness;
    session.ctx = storage;
    session.modernDispatcher = null;
    session.modernDispatcherPromise = null;
    session.runtimeClosePromise = null;
    const principal: Principal = {
      accountId: "user-1",
      organizationId: "org-1",
      organizationName: "Org 1",
      email: "user-1@example.com",
      name: "User 1",
      avatarUrl: null,
      roles: [],
    };
    const token: McpSessionInit = {
      organizationId: "org-1",
      userId: "user-1",
      elicitationMode: "native",
      resource: defaultMcpResource,
    };

    const first = session.ensureModernDispatcher(principal, token);
    await storage.readEntered.promise;
    const second = session.ensureModernDispatcher(principal, token);
    expect(storage.modernKeyReads).toBe(1);

    storage.releaseRead.resolve();
    const [firstDispatcher, secondDispatcher] = await Promise.all([first, second]);
    expect(firstDispatcher).toBe(secondDispatcher);
    expect(session.modernDispatcher).toBe(firstDispatcher);
    expect(session.modernDispatcherPromise).toBeNull();
    await firstDispatcher.close();
  });
});

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
  it("re-checks a modern request lease before acting on an idle alarm snapshot", async () => {
    const session = await makeHarnessSession();
    session.lastActivityMs = Date.now() - 2_000;
    session.sessionTimeoutMs = () => 1_000;
    const originalEngine = session.engine;
    const countSnapshotEntered = makeDeferred();
    const releaseCountSnapshot = makeDeferred();
    session.runningExecutionCount = async () => {
      countSnapshotEntered.resolve();
      await releaseCountSnapshot.promise;
      return 0;
    };

    const alarm = session.alarm();
    await countSnapshotEntered.promise;
    const releaseRequest = await session.beginModernRequest();
    releaseCountSnapshot.resolve();

    await alarm;
    expect(session.initialized).toBe(true);
    expect(session.engine).toBe(originalEngine);
    expect(session.ctx.alarm).toBeGreaterThan(Date.now());
    releaseRequest();
  });

  it("lets a leased full modern request finish when shutdown starts before dispatcher init", async () => {
    const storage = new GatedSessionMetaStorage();
    const session = await makeHarnessSession(storage);
    const sessionMeta = session.sessionMeta;
    expect(sessionMeta).not.toBeNull();
    await storage.put("session-meta", sessionMeta);
    session.sessionMeta = null;
    const principal: Principal = {
      accountId: "user-1",
      organizationId: "org-1",
      organizationName: "Org 1",
      email: "user-1@example.com",
      name: "User 1",
      avatarUrl: null,
      roles: [],
    };
    const token: McpSessionInit = {
      organizationId: "org-1",
      userId: "user-1",
      elicitationMode: "native",
      resource: defaultMcpResource,
    };
    const request = session.handleModernRequest(
      new Request("https://executor.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-method": "server/discover",
          "mcp-name": "server",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
      principal,
      token,
    );
    await storage.readEntered.promise;
    const close = Effect.runPromise(session.closeRuntime());
    await Promise.resolve();
    expect(session.runtimeClosePromise).not.toBeNull();

    storage.releaseRead.resolve();
    const [response] = await Promise.all([request, close]);
    expect(response.status).toBe(200);
    expect(session.runtimeClosePromise).toBeNull();
    expect(session.initialized).toBe(false);
    expect(session.modernDispatcher).toBeNull();
  });

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
