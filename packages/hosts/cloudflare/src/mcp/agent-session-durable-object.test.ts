// oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: the storage fake reproduces the plain Errors the Cloudflare runtime throws, and rejecting is the only way a DurableObjectStorage reports them
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Schema } from "effect";
import type * as Tracer from "effect/Tracer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

import { defaultMcpResource, type McpResource } from "@executor-js/host-mcp";
import type { ExecutionEngine, ExecutionResult, ResumeResponse } from "@executor-js/execution";
import { FormElicitation, ToolAddress } from "@executor-js/sdk";

import {
  McpAgentSessionDOBase,
  type McpApprovalOwner,
  type McpApprovalPrincipal,
  type McpSessionResumeApprovalResult,
  type McpSessionModelResumeResult,
  type SessionMeta,
} from "./agent-session-durable-object";
import {
  currentInFlightColdBuildCount,
  currentResidentRuntimeCount,
  EVICTION_REQUEST_GRACE_MS,
  markEvictionRequested,
  pickEvictionCandidate,
  registerResidentSession,
  releaseResidentSession,
  resetInFlightColdBuildCountForTest,
  resetResidentRuntimeCountForTest,
  resetResidentSessionRegistryForTest,
  residentSessionIdsForTest,
  touchResidentSession,
} from "./session-runtime-residency";

class MemoryStorage {
  private readonly data = new Map<string, unknown>();
  alarm: number | undefined;

  private idName: string | undefined = "streamable-http:session-reconnect";

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

  get id(): { readonly name: string | undefined } {
    return { name: this.idName };
  }

  /**
   * Model a Durable Object invocation the runtime does not give a
   * `ctx.id.name` — the shape an alarm fires in when it is running against an
   * alarm record that never carried one.
   */
  withoutIdName(): this {
    this.idName = undefined;
    return this;
  }

  /** Give this storage's Durable Object a distinct name, so multiple harness
   *  sessions in the same test resolve to distinct `sessionIdForTelemetry()`
   *  values instead of all colliding on the default. */
  withIdName(name: string): this {
    this.idName = name;
    return this;
  }

  get storage(): MemoryStorage {
    return this;
  }

  private readonly waitUntilPromises: Promise<unknown>[] = [];

  /**
   * `ctx.waitUntil` extends work past the response instead of blocking it —
   * cap eviction requests it. A real DO holds the runtime open until every
   * queued promise settles; this fake instead just remembers them so a test
   * can explicitly wait for the background work it cares about via
   * `drainWaitUntil`, rather than the two racing unpredictably.
   */
  waitUntil(promise: Promise<unknown>): void {
    this.waitUntilPromises.push(promise);
  }

  /** Test-only: await every `waitUntil`-queued promise queued so far,
   *  including ones queued BY those promises while draining (an eviction
   *  request settling can itself queue more background work). */
  async drainWaitUntil(): Promise<void> {
    while (this.waitUntilPromises.length > 0) {
      const pending = this.waitUntilPromises.splice(0, this.waitUntilPromises.length);
      await Promise.allSettled(pending);
    }
  }
}

type HarnessSession = {
  approvalResponses: Map<
    string,
    { readonly response: ResumeResponse; readonly orgWriteAccess: "allowed" | "denied" }
  >;
  approvalWaiters: Map<
    string,
    Deferred.Deferred<{
      readonly response: ResumeResponse;
      readonly orgWriteAccess: "allowed" | "denied";
    }>
  >;
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
  resumeExecutionForApproval: (
    executionId: string,
    identity: McpApprovalPrincipal,
    response: ResumeResponse,
  ) => Promise<McpSessionResumeApprovalResult>;
  waitForApprovalResponse: (executionId: string) => Effect.Effect<{
    readonly response: ResumeResponse;
    readonly orgWriteAccess: "allowed" | "denied";
  } | null>;
  validateMcpSessionOwner: (
    identity: {
      readonly accountId: string;
      readonly organizationId: string;
    },
    resource: McpResource,
  ) => Promise<"ok" | "not_found" | "forbidden" | "terminated">;
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

/** The DO's structured logs are JSON lines; assertions read them back. */
const decodeLogLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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
      // The fake forks nothing, so there is no sandbox fiber to end.
      shutdown: Effect.void,
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
    orgRoleModel: "organization",
    userId: "user-1",
    resource: defaultMcpResource,
  };
  const storage = new MemoryStorage();
  const server = makeServer();
  await server.connect(new StaleCloseTransport());

  const session = Object.create(McpAgentSessionDOBase.prototype) as HarnessSession;
  session.approvalResponses = new Map();
  session.approvalWaiters = new Map();
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

it("records a demoted browser approver's current role in a waiting decision", async () => {
  const session = await makeHarnessSession();
  const executionId = "exec-browser-demotion";
  session.engine = {
    ...makeEngine().engine,
    getPausedExecution: (id) =>
      Effect.succeed(
        id === executionId
          ? {
              id,
              elicitationContext: {
                address: ToolAddress.make("executor.coreTools.policies.create"),
                args: {},
                request: FormElicitation.make({ message: "Approve?", requestedSchema: {} }),
              },
            }
          : null,
      ),
  };

  const waiting = Effect.runPromise(session.waitForApprovalResponse(executionId));
  await Promise.resolve();
  const result = await session.resumeExecutionForApproval(
    executionId,
    { accountId: "user-1", organizationId: "org-1", orgRole: "member" },
    approval,
  );

  expect(result.status).toBe("ok");
  await expect(waiting).resolves.toEqual({ response: approval, orgWriteAccess: "denied" });
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
    orgRoleModel: "organization",
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

  it("loads persisted pre-role-model metadata through the fail-closed arm", async () => {
    const legacyStored = {
      organizationId: "org-1",
      organizationName: "Org 1",
      userId: "user-1",
      orgRole: "admin",
      resource: defaultMcpResource,
    } as const;
    const { session } = await makeCapabilitySession(legacyStored);

    const loaded = await Effect.runPromise(session.loadSessionMeta());

    expect(loaded).toMatchObject({
      organizationId: "org-1",
      orgRoleModel: "organization",
      resource: defaultMcpResource,
    });
    expect(loaded).not.toHaveProperty("orgRole");
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

// A cold restore used to re-resolve the org identity through the host's backing
// store (on cloud: a brand-new Postgres connection) BEFORE it ever looked at
// the meta this DO had already persisted for the very session it is restoring.
// A transient failure of that lookup killed `init` and the restore with it —
// for a row the DO was already holding. The DO's own storage is the
// authoritative copy of the org identity of a session it already minted, so it
// is offered to the host first; the host still rebuilds everything the CONNECT
// carries (resource, elicitation mode, capability flags) from the token.
describe("McpAgentSessionDOBase cold-restore meta reuse", () => {
  type RestoreSession = {
    ctx: MemoryStorage;
    getSessionId: () => string;
    loadSessionMeta: () => Effect.Effect<SessionMeta | null>;
    resolveSessionMeta: (
      token: unknown,
      storedMeta: SessionMeta | null,
    ) => Effect.Effect<SessionMeta>;
    resolveAndStoreSessionMeta: (token: unknown) => Effect.Effect<SessionMeta>;
  };

  const storedMeta: SessionMeta = {
    organizationId: "org-1",
    organizationName: "Org One",
    organizationSlug: "org-one",
    orgRoleModel: "organization",
    userId: "user-1",
    resource: defaultMcpResource,
  };

  const token = {
    organizationId: "org-1",
    orgRoleModel: "organization" as const,
    userId: "user-1",
    elicitationMode: "model" as const,
    resource: defaultMcpResource,
  };

  const makeRestoreSession = async (
    stored: SessionMeta | null,
  ): Promise<{ session: RestoreSession; storage: MemoryStorage }> => {
    const storage = new MemoryStorage();
    if (stored) await storage.put("session-meta", stored);
    const session = Object.create(McpAgentSessionDOBase.prototype) as RestoreSession;
    session.ctx = storage;
    session.getSessionId = () => "session-restore";
    return { session, storage };
  };

  // The host stands in for cloud with an unreachable database: it can only
  // answer when the DO hands it what it already knows.
  const hostWithUnreachableStore =
    (seen: { storedMeta: SessionMeta | null; calls: number }) =>
    (tokenIn: unknown, stored: SessionMeta | null): Effect.Effect<SessionMeta> => {
      seen.calls += 1;
      seen.storedMeta = stored;
      if (!stored) return Effect.die("organization lookup: CONNECT_TIMEOUT");
      const t = tokenIn as { readonly userId: string; readonly organizationId: string };
      return Effect.succeed({
        organizationId: t.organizationId,
        organizationName: stored.organizationName,
        organizationSlug: stored.organizationSlug,
        orgRoleModel: stored.orgRoleModel,
        userId: t.userId,
        resource: defaultMcpResource,
      } satisfies SessionMeta);
    };

  it("restores from its own stored meta when the backing store is unreachable", async () => {
    const { session } = await makeRestoreSession(storedMeta);
    const seen = { storedMeta: null as SessionMeta | null, calls: 0 };
    session.resolveSessionMeta = hostWithUnreachableStore(seen);

    const resolved = await Effect.runPromise(session.resolveAndStoreSessionMeta(token));

    expect(seen.calls).toBe(1);
    expect(seen.storedMeta).toMatchObject({ organizationId: "org-1", organizationName: "Org One" });
    expect(resolved.organizationName).toBe("Org One");
    expect(resolved.organizationSlug).toBe("org-one");
  });

  // Stored meta is only a shortcut for the SAME organization. A session id
  // reused across orgs must never inherit the previous org's identity.
  it("offers nothing when the stored meta belongs to another organization", async () => {
    const { session } = await makeRestoreSession({ ...storedMeta, organizationId: "org-other" });
    const seen = { storedMeta: null as SessionMeta | null, calls: 0 };
    session.resolveSessionMeta = hostWithUnreachableStore(seen);

    const exit = await Effect.runPromiseExit(session.resolveAndStoreSessionMeta(token));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(seen.storedMeta).toBeNull();
  });

  // A brand-new session has nothing stored; the host must resolve from scratch.
  it("offers nothing on a first init", async () => {
    const { session } = await makeRestoreSession(null);
    const seen = { storedMeta: null as SessionMeta | null, calls: 0 };
    session.resolveSessionMeta = (tokenIn, stored) => {
      seen.calls += 1;
      seen.storedMeta = stored;
      const t = tokenIn as { readonly userId: string; readonly organizationId: string };
      return Effect.succeed({
        organizationId: t.organizationId,
        organizationName: "Freshly Resolved",
        orgRoleModel: "organization",
        userId: t.userId,
        resource: defaultMcpResource,
      } satisfies SessionMeta);
    };

    const resolved = await Effect.runPromise(session.resolveAndStoreSessionMeta(token));

    expect(seen.storedMeta).toBeNull();
    expect(resolved.organizationName).toBe("Freshly Resolved");
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
      session.validateMcpSessionOwner(
        { accountId: "user-1", organizationId: "org-1" },
        defaultMcpResource,
      ),
    ).resolves.toBe("ok");
  });

  it("rejects the same owner on a different MCP resource", async () => {
    const session = await makeHarnessSession();
    const identity = { accountId: "user-1", organizationId: "org-1" };

    await expect(session.validateMcpSessionOwner(identity, defaultMcpResource)).resolves.toBe("ok");
    await expect(
      session.validateMcpSessionOwner(identity, {
        kind: "toolkit",
        slug: "other-toolkit",
      }),
    ).resolves.toBe("forbidden");
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

    const first = session.validateMcpSessionOwner(
      {
        accountId: "user-1",
        organizationId: "org-1",
      },
      defaultMcpResource,
    );
    const second = session.validateMcpSessionOwner(
      {
        accountId: "user-1",
        organizationId: "org-1",
      },
      defaultMcpResource,
    );

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

    const restore = session.validateMcpSessionOwner(
      {
        accountId: "user-1",
        organizationId: "org-1",
      },
      defaultMcpResource,
    );
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
    validateMcpSessionOwner: (identity: McpApprovalOwner, resource: McpResource) => Promise<string>;
  };

  const sessionMeta: SessionMeta = {
    organizationId: "org-1",
    organizationName: "Org 1",
    orgRoleModel: "organization",
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
      session.validateMcpSessionOwner(
        { accountId: "user-1", organizationId: "org-1" },
        defaultMcpResource,
      ),
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

// PartyServer answers "what is this DO's name" from three sources and does not
// consult them in one place: the `name` getter reads `ctx.id.name` and an
// in-memory field hydrated during initialization, while the durable `__ps_name`
// record is read only BY that initialization. The alarm entry point makes most
// of its decisions itself and delegates to `super.alarm()` on one branch only,
// so it never runs that hydration — an alarm could read the durable record,
// conclude the session was addressable, and then die reading the session id for
// a LOG LINE about the decision it had just made.
//
// This cannot be provoked through the dev stack, which addresses every Durable
// Object by name, so the shape is pinned here instead: an unnamed `ctx.id`, a
// faithful stand-in for PartyServer's throwing getter, and the alarm driven end
// to end.
describe("McpAgentSessionDOBase alarm name resolution", () => {
  type NameSession = HarnessSession & {
    /** Installed by {@link installPartyServerName}, as PartyServer installs it. */
    readonly name: string;
    sessionIdForTelemetry: () => string;
  };

  const storedName = "streamable-http:session-stale-alarm";

  const restoreConsole: Array<() => void> = [];
  afterEach(() => {
    while (restoreConsole.length > 0) restoreConsole.pop()?.();
  });

  // Stand-in for PartyServer's `name` getter and the agents SDK's
  // `getSessionId`: `ctx.id.name`, else the in-memory field, else the throw.
  // `inMemoryName` stays absent by default because the alarm path is exactly
  // the one that never runs the initialization which would populate it.
  const installPartyServerName = (
    session: NameSession,
    options: { readonly inMemoryName?: string } = {},
  ): void => {
    Object.defineProperty(session, "name", {
      configurable: true,
      get: () => {
        const ctxName = session.ctx.id.name;
        if (ctxName !== undefined) return ctxName;
        if (options.inMemoryName !== undefined) return options.inMemoryName;
        throw new Error(
          "Attempting to read .name on McpSessionDOSqlite, but this.ctx.id.name is not set and no __ps_name fallback record is available.",
        );
      },
    });
    session.getSessionId = () => {
      const [, sessionId] = session.name.split(":");
      if (!sessionId) throw new Error("Invalid session id.");
      return sessionId;
    };
  };

  const makeUnnamedSession = async (
    options: { readonly storeName?: boolean } = {},
  ): Promise<{ session: NameSession; storage: MemoryStorage; logs: string[] }> => {
    const storage = new MemoryStorage().withoutIdName();
    if (options.storeName ?? true) await storage.put("__ps_name", storedName);

    const session = (await makeHarnessSession()) as NameSession;
    session.ctx = storage;
    session.lastActivityMs = Date.now() - 10;
    session.sessionTimeoutMs = () => 1;
    installPartyServerName(session);

    const logs: string[] = [];
    const info = console.info;
    const warn = console.warn;
    console.info = (line: unknown) => logs.push(String(line));
    console.warn = (line: unknown) => logs.push(String(line));
    restoreConsole.push(() => {
      console.info = info;
      console.warn = warn;
    });

    return { session, storage, logs };
  };

  const parsed = (logs: readonly string[]): readonly unknown[] =>
    logs.map((line) => decodeLogLine(line));

  it("disposes the right session when only the durable record carries the name", async () => {
    const { session, storage, logs } = await makeUnnamedSession();

    await expect(
      session.alarm(),
      "an alarm whose guard found a name must not die on the next read of that name",
    ).resolves.toBeUndefined();

    expect(
      parsed(logs),
      "the session the stored record names is the one reported as disposed",
    ).toContainEqual(
      expect.objectContaining({
        event: "mcp_session_idle_runtime_dispose",
        sessionId: "session-stale-alarm",
      }),
    );
    expect(session.initialized, "the idle runtime is torn down").toBe(false);
    expect(session.engine, "the execution engine is released").toBeNull();
    expect(storage.alarm, "the idle alarm is cleared").toBeUndefined();
    expect(await storage.get("last-activity-ms"), "the idle clock is cleared").toBeUndefined();
  });

  // The lease branches log BEFORE they act, so a throwing read there loses the
  // extension itself and not merely the line: the alarm dies and the session is
  // left pinned without making progress.
  it("extends a paused lease from the durable record instead of dying on its log", async () => {
    const { session, storage, logs } = await makeUnnamedSession();
    session.maxPausedSessionIdleMs = () => 1_000_000;
    session.engine = {
      ...(session.engine as ExecutionEngine<Cause.YieldableError>),
      pausedExecutionCount: () => Effect.succeed(1),
    };

    await expect(session.alarm()).resolves.toBeUndefined();

    expect(parsed(logs)).toContainEqual(
      expect.objectContaining({
        event: "mcp_session_paused_lease_extension",
        sessionId: "session-stale-alarm",
      }),
    );
    expect(storage.alarm, "the lease is actually extended").toBeGreaterThan(0);
    expect(session.initialized, "a leased session keeps its runtime").toBe(true);
  });

  it("completes and cleans up when no source has a name at all", async () => {
    const { session, storage, logs } = await makeUnnamedSession({ storeName: false });
    await storage.setAlarm(Date.now());

    await expect(
      session.alarm(),
      "an unaddressable session exits rather than throwing into an endless alarm retry",
    ).resolves.toBeUndefined();

    expect(parsed(logs)).toContainEqual(
      expect.objectContaining({ event: "mcp_session_unaddressable_alarm_cleanup" }),
    );
    expect(storage.alarm, "the alarm does not retry forever").toBeUndefined();
    expect(session.initialized, "the runtime it cannot address is released").toBe(false);
  });

  it("never throws on an observational read of the session id", async () => {
    const { session } = await makeUnnamedSession({ storeName: false });

    expect(() => session.sessionIdForTelemetry()).not.toThrow();
    expect(session.sessionIdForTelemetry(), "a placeholder keeps the log shape stable").toBe(
      "unresolved",
    );
  });
});

// The isolate-wide residency gauge used to be purely observational. These pin
// the enforcing half: past the soft cap, `init` evicts the least-recently
// -active EVICTABLE session to make room, at most one per init, and never
// blocks or fails an init over it even when nothing can be evicted.
//
// `residentRuntimeCount`/the resident-session registry are isolate (module)
// scope, exactly like production — so every test here resets them, both
// before (in case an earlier describe block in this file leaked residents by
// calling `init()` without ever disposing) and after (so it does not leak
// into whatever runs next).
describe("McpAgentSessionDOBase residency cap eviction", () => {
  type ResidencySession = {
    ctx: MemoryStorage;
    captureCause: (cause: Cause.Cause<unknown>) => void;
    dbHandle: { readonly end: () => void } | null;
    engine: ExecutionEngine<Cause.YieldableError> | null;
    getConnections: () => Iterable<unknown>;
    getSessionId: () => string;
    init: () => Promise<void>;
    // Re-exposed for the harness only, same idiom as `evictResidentRuntimeForCap`
    // below: the `AbortController` backing the CURRENTLY in-flight `init`
    // call's root fiber, so a test can interrupt it deterministically at a
    // chosen suspension point instead of only exercising the failure/defect
    // path.
    initAbortController: AbortController | null;
    // Same idiom, for the disposal path — see `disposeAbortController`'s doc
    // comment on the class.
    disposeAbortController: AbortController | null;
    initialized: boolean;
    lastActivityMs: number;
    pendingApprovalLeases: Map<string, never>;
    props: Record<string, unknown>;
    residentRuntimeSoftCap: () => number;
    server?: McpServer;
    sessionIdForTelemetry: () => string;
    sessionTimeoutMs: () => number;
    withTelemetry: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
    buildMcpServer: () => Effect.Effect<{
      mcpServer: McpServer;
      engine: ExecutionEngine<Cause.YieldableError>;
    }>;
    openSessionDb: () => { readonly end: () => void } | Promise<{ readonly end: () => void }>;
    resolveSessionMeta: () => Effect.Effect<SessionMeta>;
    supportsCapEviction: () => boolean;
    requestSelfEviction: () => Promise<void>;
    // Re-exposed for the harness only (private on the real class, same idiom
    // as `resolveAndStoreSessionMeta` above): the candidate side of eviction,
    // wired below to stand in for a landed self-addressed stub call.
    evictResidentRuntimeForCap: () => Promise<void>;
  };

  const residencySessionMeta = (organizationId: string): SessionMeta => ({
    organizationId,
    organizationName: "Org 1",
    orgRoleModel: "organization",
    userId: "user-1",
    resource: defaultMcpResource,
  });

  /**
   * A session harness built to actually run `init()`, the entry point that
   * builds (and, on cold restore, rebuilds) a resident runtime.
   *
   * `requestSelfEviction` stands in for what, in production, is a real
   * self-addressed Durable Object stub call — `mcpSessionStub(...).requestCapEviction()`
   * — landing back on this same instance and invoking `requestCapEviction`,
   * which runs `evictResidentRuntimeForCap` in the (correctly-scoped) IoContext
   * that call created. This harness has no Durable Object stub machinery to
   * exercise that routing with, so it wires straight to this session's OWN
   * `evictResidentRuntimeForCap` instead: it is the candidate-side handler
   * that matters for these tests (does the re-check + teardown behave
   * correctly), not the RPC transport that gets a request there — that
   * transport is covered by the e2e idle-disposal run against real workerd,
   * not here. `supportsCapEviction` defaults to `true` so a harness session is
   * an eviction candidate unless a test deliberately opts out.
   */
  const makeResidencySession = (input: {
    readonly id: string;
    readonly cap?: number;
    readonly hasActiveStream?: boolean;
    readonly pausedExecutionCount?: number;
    readonly supportsCapEviction?: boolean;
  }): { readonly session: ResidencySession; readonly storage: MemoryStorage } => {
    const storage = new MemoryStorage().withIdName(`streamable-http:${input.id}`);
    const session = Object.create(McpAgentSessionDOBase.prototype) as ResidencySession;
    session.ctx = storage;
    session.captureCause = () => undefined;
    session.dbHandle = null;
    session.engine = null;
    session.getConnections = () => (input.hasActiveStream ? [{ close: () => undefined }] : []);
    session.getSessionId = () => input.id;
    session.initialized = false;
    session.lastActivityMs = 0;
    session.pendingApprovalLeases = new Map<string, never>();
    session.props = { session: { organizationId: input.id, userId: "user-1" } };
    session.sessionTimeoutMs = () => 60_000;
    session.residentRuntimeSoftCap = () => input.cap ?? 32;
    session.resolveSessionMeta = () => Effect.succeed(residencySessionMeta(input.id));
    session.openSessionDb = () => ({ end: () => undefined });
    session.buildMcpServer = () =>
      Effect.succeed({
        mcpServer: makeServer(),
        engine: {
          ...makeEngine().engine,
          pausedExecutionCount: () => Effect.succeed(input.pausedExecutionCount ?? 0),
        },
      });
    session.supportsCapEviction = () => input.supportsCapEviction ?? true;
    session.requestSelfEviction = () => session.evictResidentRuntimeForCap();
    return { session, storage };
  };

  /** A tracer that records every span + its attributes, to assert on the
   *  `mcp.isolate.cap_overflow` attribute the `McpSessionDO.init` span
   *  carries when nothing was evictable. */
  const makeRecordingTracer = (): {
    readonly tracer: Tracer.Tracer;
    readonly spans: ReadonlyArray<{
      readonly name: string;
      readonly attributes: ReadonlyMap<string, unknown>;
    }>;
  } => {
    const spans: Array<{ name: string; attributes: Map<string, unknown> }> = [];
    const tracer: Tracer.Tracer = {
      span: (options) => {
        const attributes = new Map<string, unknown>();
        spans.push({ name: options.name, attributes });
        let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
        return {
          _tag: "Span",
          name: options.name,
          spanId: `span-${spans.length}`,
          traceId: "trace-1",
          parent: options.parent,
          annotations: options.annotations,
          get status() {
            return status;
          },
          attributes,
          links: options.links,
          sampled: options.sampled,
          kind: options.kind,
          end: (endTime, exit) => {
            status = { _tag: "Ended", startTime: options.startTime, endTime, exit };
          },
          attribute: (key, value) => {
            attributes.set(key, value);
          },
          event: () => undefined,
          addLinks: () => undefined,
        };
      },
    };
    return { tracer, spans };
  };

  beforeEach(() => {
    // Earlier describe blocks in this file build sessions via `init()` too,
    // without ever disposing them (that is out of scope for what they test) —
    // so without this, residency here would start from whatever they left
    // behind rather than zero.
    resetResidentRuntimeCountForTest();
    resetResidentSessionRegistryForTest();
    resetInFlightColdBuildCountForTest();
  });

  afterEach(() => {
    resetResidentRuntimeCountForTest();
    resetResidentSessionRegistryForTest();
    resetInFlightColdBuildCountForTest();
  });

  it("evicts the least-recently-active evictable session once the cap is reached, and the newer session survives", async () => {
    const { session: sessionA } = makeResidencySession({ id: "session-cap-a", cap: 2 });
    const { session: sessionB } = makeResidencySession({ id: "session-cap-b", cap: 2 });
    const { session: sessionC, storage: storageC } = makeResidencySession({
      id: "session-cap-c",
      cap: 2,
    });

    await sessionA.init();
    await sessionB.init();
    expect(currentResidentRuntimeCount(), "two sessions resident, right at the cap").toBe(2);

    // Force a deterministic LRU order: real-clock timestamps from two `init`
    // calls a tick apart are not reliable enough to assert on.
    touchResidentSession("session-cap-a", Date.now() - 10_000);
    touchResidentSession("session-cap-b", Date.now());

    await sessionC.init();
    // `evictForCapIfNeeded` fires the eviction REQUEST via `ctx.waitUntil` and
    // returns without waiting for it, so `sessionC.init()` resolving proves
    // nothing about whether session A has actually been torn down yet — only
    // draining session C's queued background work does.
    await storageC.drainWaitUntil();

    expect(sessionA.initialized, "the least-recently-active session was evicted").toBe(false);
    expect(sessionA.engine, "its engine was released").toBeNull();
    expect(sessionB.initialized, "the newer session survives untouched").toBe(true);
    expect(sessionC.initialized, "the session that triggered eviction still built").toBe(true);
    expect(currentResidentRuntimeCount(), "one evicted, two resident").toBe(2);
  });

  it("proceeds with init and records overflow when nothing resident is currently evictable", async () => {
    const { tracer, spans } = makeRecordingTracer();
    const { session: sessionBusy } = makeResidencySession({
      id: "session-busy",
      cap: 1,
      hasActiveStream: true,
    });
    const { session: sessionNew } = makeResidencySession({ id: "session-new", cap: 1 });
    sessionNew.withTelemetry = (effect) => Effect.withTracer(effect, tracer);

    await sessionBusy.init();
    expect(currentResidentRuntimeCount()).toBe(1);

    await sessionNew.init();

    expect(sessionBusy.initialized, "a streaming session is never evicted").toBe(true);
    expect(sessionNew.initialized, "init proceeds despite the cap").toBe(true);
    expect(
      currentResidentRuntimeCount(),
      "the soft cap is exceeded rather than blocking init",
    ).toBe(2);

    const initSpan = spans.find((span) => span.name === "McpSessionDO.init");
    expect(initSpan?.attributes.get("mcp.isolate.cap_overflow")).toBe(true);
  });

  it("cold-restores on the next request after being evicted for the cap", async () => {
    const { session: sessionA } = makeResidencySession({ id: "session-restore-a", cap: 1 });
    const { session: sessionB, storage: storageB } = makeResidencySession({
      id: "session-restore-b",
      cap: 1,
    });

    await sessionA.init();
    await sessionB.init();
    await storageB.drainWaitUntil();
    expect(sessionA.initialized, "evicted to make room under the cap").toBe(false);

    await sessionA.init();

    expect(sessionA.initialized, "a later request rebuilds the evicted session").toBe(true);
    expect(sessionA.engine, "a fresh engine is installed").not.toBeNull();
    expect(sessionA.server, "a fresh server is installed").toBeDefined();
  });

  // Two different sessions' `init`s can both pick the SAME LRU candidate
  // before either eviction request lands — nothing serializes the picks. The
  // candidate must survive that safely: its own re-check plus `closeRuntime`'s
  // idempotency is what the base class's doc comments claim makes a repeat
  // request a no-op rather than a double-teardown. Requests here run
  // sequentially rather than raced, deliberately: the guarantee under test is
  // that a SECOND request against an already-evicted (or being-evicted)
  // candidate is a safe no-op, not a claim about ordering within a genuine
  // race — the same style already used by the "releasing twice" test below.
  it("treats a repeat eviction request against the same candidate as a safe no-op", async () => {
    const { session: candidate } = makeResidencySession({ id: "session-double-evict" });
    await candidate.init();
    expect(candidate.initialized).toBe(true);

    await candidate.requestSelfEviction();

    expect(candidate.initialized, "the first request tears the candidate down").toBe(false);
    expect(candidate.engine).toBeNull();
    expect(currentResidentRuntimeCount()).toBe(0);

    // A repeat request — the shape two overlapping evictor `init`s produce, or
    // one that was merely slow to land after the candidate already tore
    // itself down some other way — must also be a no-op, not a crash or a
    // second decrement of the (already-zero) resident count.
    await expect(
      candidate.requestSelfEviction(),
      "a repeat request against an already-evicted candidate does not throw",
    ).resolves.toBeUndefined();
    expect(candidate.initialized).toBe(false);
    expect(
      currentResidentRuntimeCount(),
      "the resident count is not decremented a second time",
    ).toBe(0);
  });

  // `residentRuntimeCount` only moves once a build actually FINISHES, so N
  // overlapping cold inits admitted at the same moment each read it, see
  // themselves still under the cap, and none of them evicts — residency then
  // blows past the cap by N once every build lands. `evictForCapIfNeeded`
  // closes that gap with an in-flight reservation counter: this pins that a
  // second concurrent admission sees the first's still-building reservation
  // and evicts, instead of also passing the count-only check for free.
  it("reserves an in-flight cold-build slot at admission, so a second concurrent admission at the cap evicts instead of passing the check for free", async () => {
    const { session: sessionA } = makeResidencySession({ id: "session-inflight-a", cap: 2 });
    await sessionA.init();
    expect(currentResidentRuntimeCount(), "one session resident, one below the cap").toBe(1);

    const buildEntered = makeDeferred();
    const buildGate = makeDeferred();
    const { session: sessionB } = makeResidencySession({ id: "session-inflight-b", cap: 2 });
    sessionB.buildMcpServer = () =>
      Effect.gen(function* () {
        buildEntered.resolve();
        yield* Effect.promise(() => buildGate.promise);
        return { mcpServer: makeServer(), engine: makeEngine().engine };
      });

    const initB = sessionB.init();
    // Deterministic: wait for sessionB's admission to actually be inside its
    // (gated) build — holding its in-flight reservation — instead of guessing
    // a number of microtask ticks.
    await buildEntered.promise;
    expect(currentInFlightColdBuildCount(), "sessionB's admission reserved a cold-build slot").toBe(
      1,
    );

    const { session: sessionC, storage: storageC } = makeResidencySession({
      id: "session-inflight-c",
      cap: 2,
    });
    await sessionC.init();
    await storageC.drainWaitUntil();

    // sessionB is not yet counted-as-resident — its build is still gated — so
    // sessionA is the only session actually registered as resident right now
    // and the only thing `pickEvictionCandidate` can choose. Its eviction is
    // what proves sessionC's admission saw sessionB's in-flight reservation
    // and treated the isolate as already at the cap.
    expect(
      sessionA.initialized,
      "evicted because the in-flight reservation counted against the cap",
    ).toBe(false);
    expect(sessionC.initialized, "the admission that triggered eviction still built").toBe(true);

    buildGate.resolve();
    await initB;
    expect(sessionB.initialized, "sessionB's gated build eventually completes").toBe(true);
    expect(
      currentInFlightColdBuildCount(),
      "the reservation was released once the build landed",
    ).toBe(0);
  });

  it("releases the in-flight cold-build reservation when the build fails, instead of leaking residual cap pressure", async () => {
    const { session: sessionA } = makeResidencySession({ id: "session-inflight-fail-a", cap: 2 });
    await sessionA.init();
    expect(currentResidentRuntimeCount()).toBe(1);

    const { session: sessionFailing } = makeResidencySession({
      id: "session-inflight-fail-b",
      cap: 2,
    });
    sessionFailing.buildMcpServer = () => Effect.die(new Error("cold build boundary failure"));

    await expect(sessionFailing.init()).rejects.toThrow(/cold build boundary failure/);
    expect(
      currentInFlightColdBuildCount(),
      "the reservation was released on the build's failure path, not leaked",
    ).toBe(0);
    expect(sessionFailing.initialized, "the failed build never became resident").toBe(false);

    const { session: sessionC, storage: storageC } = makeResidencySession({
      id: "session-inflight-fail-c",
      cap: 2,
    });
    await sessionC.init();
    await storageC.drainWaitUntil();

    expect(
      sessionA.initialized,
      "no residual in-flight pressure from the failed build, so sessionC's admission stays under the cap",
    ).toBe(true);
    expect(
      currentResidentRuntimeCount(),
      "sessionA and sessionC both resident, under the cap",
    ).toBe(2);
  });

  // The reservation used to be released only by an `Effect.ensuring` scoped to
  // the build block that starts right after `evictForCapIfNeeded` admits —
  // leaving a gap between the admission itself and that narrower wrap's own
  // coverage beginning. An interrupt landing in that gap leaked the
  // reservation permanently: nothing ever decremented it, so the isolate's
  // in-flight counter drifted up forever and every later admission saw false
  // cap pressure. The fix moves the release to a single `Effect.ensuring`
  // around init's entire program, so there is no window between acquiring the
  // reservation and being covered by its release. This interrupts `init`
  // itself (via the `AbortController` `initAbortController` exposes for
  // exactly this) while it is genuinely suspended opening the session db
  // handle — the first async step after admission — rather than merely
  // failing the build, which the pre-existing test above already covers.
  it("releases the in-flight cold-build reservation when init is interrupted after cap admission, before the build finishes", async () => {
    const { session: sessionA } = makeResidencySession({ id: "session-interrupt-a", cap: 2 });
    await sessionA.init();
    expect(currentResidentRuntimeCount(), "one session resident, one below the cap").toBe(1);

    const dbHandleEntered = makeDeferred();
    const dbHandleGate = makeDeferred();
    const { session: sessionB } = makeResidencySession({ id: "session-interrupt-b", cap: 2 });
    sessionB.openSessionDb = () => {
      dbHandleEntered.resolve();
      // Never resolves — the interrupt below is what ends this suspension,
      // not the gate. `dbHandleGate.promise` only carries a `void` payload;
      // `.then` produces the right shape without a cast, and without ever
      // actually resolving — the callback here never runs.
      return dbHandleGate.promise.then(() => ({ end: () => undefined }));
    };

    const initPromise = sessionB.init();
    // Deterministic: wait for sessionB's admission to have actually reserved
    // a slot and for its build to be genuinely suspended opening the db
    // handle, instead of guessing a number of microtask ticks.
    await dbHandleEntered.promise;
    expect(
      currentInFlightColdBuildCount(),
      "admission reserved a slot before the build's own db-handle open resolves",
    ).toBe(1);

    sessionB.initAbortController?.abort();

    await expect(
      initPromise,
      "an interrupted init rejects rather than silently resolving",
    ).rejects.toThrow();
    expect(
      currentInFlightColdBuildCount(),
      "the reservation was released by init's outer ensuring instead of leaking",
    ).toBe(0);
    expect(sessionB.initialized, "the interrupted build never became resident").toBe(false);

    // The reservation not leaking is what lets a later admission still see
    // the isolate as under the cap.
    const { session: sessionC, storage: storageC } = makeResidencySession({
      id: "session-interrupt-c",
      cap: 2,
    });
    await sessionC.init();
    await storageC.drainWaitUntil();

    expect(
      sessionA.initialized,
      "no residual in-flight pressure from the interrupted init, so sessionC's admission stays under the cap",
    ).toBe(true);
    expect(
      currentResidentRuntimeCount(),
      "sessionA and sessionC both resident, under the cap",
    ).toBe(2);
  });

  // `initialized` used to stay `true` across the async closes inside
  // `closeRuntime` (`server.close()`, `dbHandle.end()`), so a request landing
  // mid-teardown took `init`'s early-return path and ran against a
  // deleted server / null engine. `disposingRuntime` closes that: `init`
  // awaits any in-progress disposal before deciding whether to rebuild.
  it("a request landing mid-disposal awaits the in-progress teardown, then rebuilds and serves — never racing the closes", async () => {
    const { session } = makeResidencySession({ id: "session-mid-disposal" });
    await session.init();
    expect(session.initialized).toBe(true);
    const originalEngine = session.engine;

    const closeEntered = makeDeferred();
    const closeGate = makeDeferred();
    let closeCalls = 0;
    const server = makeServer();
    server.close = () => {
      closeCalls += 1;
      closeEntered.resolve();
      return closeGate.promise;
    };
    session.server = server;

    const disposal = session.evictResidentRuntimeForCap();
    // Deterministic: wait for disposal to actually be mid-teardown (inside
    // `server.close()`), instead of guessing a number of microtask ticks.
    await closeEntered.promise;

    const rebuild = session.init();
    let rebuildSettled = false;
    void rebuild.then(() => {
      rebuildSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      rebuildSettled,
      "init awaits the in-progress disposal instead of racing its still-pending close",
    ).toBe(false);

    closeGate.resolve();
    await disposal;
    await rebuild;

    expect(closeCalls, "the runtime was closed exactly once").toBe(1);
    expect(session.initialized, "the request that landed mid-disposal rebuilt and is serving").toBe(
      true,
    );
    expect(
      session.engine,
      "a fresh engine was installed, not the one that was mid-teardown",
    ).not.toBe(originalEngine);
  });

  // The `Effect.ensuring` that resolves `disposingRuntime` used to sit outside
  // any interruptibility guard, so an interrupt landing while `closeRuntime`
  // was genuinely suspended (mid `server.close()`, same seam as the test
  // above) still ran that `ensuring` and resolved `disposingRuntime`
  // immediately — before `dbHandle.end()`, the engine clear, or the residency
  // release ever ran. A concurrently waiting `init` would see the gate open
  // and rebuild against that half-released state. Wrapping the teardown body
  // in `Effect.uninterruptible` makes the interrupt request wait until the
  // body — including the still-gated `server.close()` — actually finishes,
  // so `disposingRuntime` cannot resolve early. This interrupts the disposal
  // itself (via `disposeAbortController`, exposed for exactly this) instead
  // of just failing a step, which the double-close test above doesn't cover.
  it("keeps a waiting init blocked when the disposal is interrupted mid-teardown, until the uninterruptible teardown actually finishes", async () => {
    const { session } = makeResidencySession({ id: "session-interrupted-disposal" });
    await session.init();
    expect(session.initialized).toBe(true);
    const originalEngine = session.engine;

    const closeEntered = makeDeferred();
    const closeGate = makeDeferred();
    let closeCalls = 0;
    const server = makeServer();
    server.close = () => {
      closeCalls += 1;
      closeEntered.resolve();
      return closeGate.promise;
    };
    session.server = server;

    const disposal = session.evictResidentRuntimeForCap();
    // Deterministic: wait for disposal to actually be mid-teardown (inside
    // `server.close()`), instead of guessing a number of microtask ticks.
    await closeEntered.promise;

    // A concurrent init is the observable proof: it only proceeds once
    // `disposingRuntime` resolves, so it stays pending for exactly as long as
    // the teardown is genuinely still running.
    const rebuild = session.init();
    let rebuildSettled = false;
    void rebuild.then(() => {
      rebuildSettled = true;
    });

    // Interrupt the disposal fiber while it is still suspended inside the
    // gated `server.close()`. On the old (interruptible) code this would let
    // the outer `Effect.ensuring` resolve `disposingRuntime` right here,
    // before `closeGate` ever resolves — letting `rebuild` proceed against a
    // still-open server / un-cleared engine.
    session.disposeAbortController?.abort();
    // Interrupt delivery hops through more than a couple of microtasks (it is
    // not itself under test here), so give it a real macrotask tick before
    // asserting anything stayed blocked — a few `Promise.resolve()`s alone
    // are not enough ticks for the abort to even be delivered, uninterruptible
    // or not, and would make this assertion true vacuously either way.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      rebuildSettled,
      "the interrupt must not resolve disposingRuntime early — the teardown is still genuinely suspended inside server.close()",
    ).toBe(false);
    expect(
      session.engine,
      "the interrupt must not let the engine be cleared before server.close() actually returns",
    ).toBe(originalEngine);

    closeGate.resolve();
    // The interrupt may still surface once the now-uninterruptible body has
    // actually finished; only completeness of the teardown itself — not the
    // outer promise's resolve/reject outcome — is under test here.
    try {
      await disposal;
    } catch {
      // Expected: the interrupt requested above can still land once the
      // uninterruptible teardown finishes.
    }
    await rebuild;

    expect(closeCalls, "server.close was actually called, not skipped").toBe(1);
    expect(
      session.initialized,
      "the request that was waiting on the interrupted disposal rebuilt and is serving",
    ).toBe(true);
    expect(
      session.engine,
      "a fresh engine was installed once the teardown genuinely finished, not the one that was mid-teardown",
    ).not.toBe(originalEngine);
  });

  it("does not double-close when two disposal triggers land concurrently (idle alarm and a cap eviction landing together)", async () => {
    const { session } = makeResidencySession({ id: "session-concurrent-dispose" });
    await session.init();

    const closeGate = makeDeferred();
    let closeCalls = 0;
    const server = makeServer();
    server.close = () => {
      closeCalls += 1;
      return closeGate.promise;
    };
    session.server = server;

    const first = session.evictResidentRuntimeForCap();
    const second = session.evictResidentRuntimeForCap();

    closeGate.resolve();
    await Promise.all([first, second]);

    expect(
      closeCalls,
      "the runtime was closed exactly once even though two disposals overlapped",
    ).toBe(1);
    expect(session.initialized).toBe(false);
    expect(currentResidentRuntimeCount(), "released exactly once").toBe(0);
  });

  describe("resident session registry release", () => {
    it("is idempotent", () => {
      registerResidentSession({
        sessionId: "idempotent-release",
        lastActivityMs: Date.now(),
        canEvict: () => true,
        dispose: async () => undefined,
      });

      expect(() => releaseResidentSession("idempotent-release")).not.toThrow();
      expect(
        () => releaseResidentSession("idempotent-release"),
        "releasing twice is a no-op",
      ).not.toThrow();
      expect(residentSessionIdsForTest()).not.toContain("idempotent-release");
      expect(pickEvictionCandidate()).toBeUndefined();
    });

    // The eviction REQUEST is fire-and-forget (`ctx.waitUntil`), so the
    // evictor's `init` has no synchronous failure to react to any more — it
    // cannot tell a request that failed from one still in flight. The new
    // failure story: optimistically LEAVE the registry entry (only the
    // candidate's own successful teardown removes it, since as far as the
    // evictor knows the candidate might still be actually resident), and mark
    // it recently-requested so a following pick skips it rather than
    // re-requesting the same stuck candidate forever.
    it("keeps the registry slot when the candidate's own eviction request fails, without touching the resident count", async () => {
      const { session: sessionFailing } = makeResidencySession({
        id: "session-failing",
        cap: 1,
      });
      // Simulate the REQUEST itself failing — the self-addressed stub call
      // never lands (the production analogue: `mcpSessionStub(...).requestCapEviction()`
      // rejects), never even reaching the candidate's own re-check.
      // oxlint-disable-next-line executor/no-promise-reject -- test double: simulates a rejected self-eviction stub call, not application error modeling.
      sessionFailing.requestSelfEviction = () => Promise.reject(new Error("stub unreachable"));
      const { session: sessionB, storage: storageB } = makeResidencySession({
        id: "session-b-after-failure",
        cap: 1,
      });

      await sessionFailing.init();
      await sessionB.init();
      await storageB.drainWaitUntil();

      expect(
        sessionFailing.initialized,
        "a failed eviction REQUEST never runs the candidate's own teardown",
      ).toBe(true);
      expect(sessionB.initialized, "the triggering init is never blocked by the failure").toBe(
        true,
      );
      expect(
        currentResidentRuntimeCount(),
        "the failing candidate's own runtime is still actually resident",
      ).toBe(2);
      expect(
        residentSessionIdsForTest(),
        "the registry slot is kept — only the candidate's own successful teardown removes it",
      ).toContain("session-failing");
      expect(
        pickEvictionCandidate()?.sessionId,
        "marked recently-requested, so the next pick does not re-target the same stuck candidate",
      ).not.toBe("session-failing");
    });

    it("skips an entry with a recent pending eviction request, and picks the next evictable one instead", () => {
      const now = Date.now();
      registerResidentSession({
        sessionId: "recently-requested",
        lastActivityMs: now - 10_000,
        canEvict: () => true,
        dispose: async () => undefined,
      });
      registerResidentSession({
        sessionId: "next-candidate",
        lastActivityMs: now - 5_000,
        canEvict: () => true,
        dispose: async () => undefined,
      });
      markEvictionRequested("recently-requested", now);

      expect(pickEvictionCandidate(now)?.sessionId).toBe("next-candidate");
    });

    it("picks a previously-requested entry again once the grace period elapses", () => {
      const now = Date.now();
      registerResidentSession({
        sessionId: "stale-request",
        lastActivityMs: now - 10_000,
        canEvict: () => true,
        dispose: async () => undefined,
      });
      markEvictionRequested("stale-request", now - EVICTION_REQUEST_GRACE_MS - 1);

      expect(pickEvictionCandidate(now)?.sessionId).toBe("stale-request");
    });

    it("marking an eviction request on an entry that no longer exists is a no-op", () => {
      expect(() => markEvictionRequested("never-registered")).not.toThrow();
    });
  });
});
