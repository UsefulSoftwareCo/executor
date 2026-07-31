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
