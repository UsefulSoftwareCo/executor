import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: vi.mock must come from vitest itself for mock hoisting to resolve
import { vi } from "vitest";
import { Cause, Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultMcpResource } from "@executor-js/host-mcp";
import {
  PAUSED_APPROVAL_TIMEOUT_MS,
  formatMcpExecutionOutcome,
} from "@executor-js/host-mcp/tool-server";
import type {
  ExecutionEngine,
  ExecutionResult,
  PausedExecutionDeadline,
  ResumeResponse,
} from "@executor-js/execution";

import {
  McpAgentSessionDOBase,
  type BuiltMcpServer,
  type McpApprovalOwner,
  type McpSessionInit,
  type McpSessionModelResumeResult,
  type SessionMeta,
} from "./agent-session-durable-object";
import {
  McpExecutionOwnerDirectoryDO,
  mcpExecutionOwnerDirectoryFromNamespace,
  mcpSessionDurableObjectName,
  type McpExecutionOwnerDirectory,
  type McpExecutionOwnerDirectoryNamespace,
  type McpExecutionOwnerRecord,
  type McpExecutionOwnerRoute,
} from "./execution-owner-directory";

vi.mock("agents/mcp", () => ({
  McpAgent: class {
    protected readonly ctx: DurableObjectState;

    constructor(ctx: DurableObjectState) {
      this.ctx = ctx;
    }

    getSessionId(): string {
      return this.ctx.id.toString();
    }

    keepAlive(): Promise<() => void> {
      return Promise.resolve(() => undefined);
    }

    getStreamRequestIds(): Promise<readonly (string | number)[]> {
      return Promise.resolve([]);
    }

    onConnect(): Promise<void> {
      return Promise.resolve();
    }

    alarm(): Promise<void> {
      return Promise.resolve();
    }

    destroy(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

class FakeStorage {
  private readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

class FakeDurableObjectState {
  readonly storage = new FakeStorage();
  readonly id: DurableObjectId;
  readonly ctx = this;
  private waitUntilPromises: Promise<unknown>[] = [];

  constructor(name: string) {
    this.id = {
      equals: (other: DurableObjectId) => other.toString() === name,
      name,
      toString: () => name,
    } as unknown as DurableObjectId;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.waitUntilPromises.push(promise);
  }

  async flushWaitUntil(): Promise<void> {
    while (this.waitUntilPromises.length > 0) {
      const pending = this.waitUntilPromises.splice(0);
      await Promise.all(pending);
    }
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

class InMemoryExecutionOwnerDirectoryNamespace implements McpExecutionOwnerDirectoryNamespace<string> {
  private readonly directories = new Map<string, McpExecutionOwnerDirectoryDO>();

  idFromName(name: string): string {
    return name;
  }

  get(id: string): McpExecutionOwnerDirectoryDO {
    let directory = this.directories.get(id);
    if (!directory) {
      directory = new McpExecutionOwnerDirectoryDO({
        storage: new FakeStorage(),
      } as unknown as DurableObjectState);
      this.directories.set(id, directory);
    }
    return directory;
  }
}

type TestDbHandle = {
  readonly end: () => void;
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
  resultForResume: (executionId: string, response: ResumeResponse) => ExecutionResult | null,
) => {
  const calls: ResumeCall[] = [];
  const resume = vi.fn((executionId: string, response: ResumeResponse) =>
    Effect.sync(() => {
      calls.push({ executionId, response });
      return resultForResume(executionId, response);
    }),
  );
  const engine: ExecutionEngine<Cause.YieldableError> = {
    execute: () => Effect.succeed({ result: "execute-result" }),
    executeWithPause: () => Effect.succeed(completed("execute-result")),
    resume,
    getPausedExecution: () => Effect.succeed(null),
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
    getDescription: Effect.succeed("test engine"),
  };
  return { calls, engine, resume };
};

const sessionMeta = (input?: Partial<SessionMeta>): SessionMeta => ({
  organizationId: "org_1",
  organizationName: "Test Org",
  userId: "acct_1",
  elicitationMode: "model",
  resource: defaultMcpResource,
  ...input,
});

const deadline = (): PausedExecutionDeadline => ({
  expiresAt: new Date(Date.now() + PAUSED_APPROVAL_TIMEOUT_MS).toISOString(),
  ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
});

const approval = {
  action: "accept",
  content: { approved: true },
} satisfies ResumeResponse;

type PendingApprovalLeaseSnapshot = {
  readonly timeout: ReturnType<typeof setTimeout> | null;
};

type PrivateRuntimeState = {
  engine: ExecutionEngine<Cause.YieldableError> | null;
  dbHandle: TestDbHandle | null;
  initialized: boolean;
  pendingApprovalLeases: Map<string, PendingApprovalLeaseSnapshot>;
};

class HarnessSession extends McpAgentSessionDOBase<Cloudflare.Env, TestDbHandle> {
  private readonly meta: SessionMeta;
  private readonly fakeState: FakeDurableObjectState;
  private readonly directory: McpExecutionOwnerDirectory | null;
  private readonly modelResumeForward: (
    owner: McpExecutionOwnerRoute,
    identity: McpApprovalOwner,
    executionId: string,
    response: ResumeResponse,
  ) => Effect.Effect<McpSessionModelResumeResult, unknown>;
  activeKeepAlives = 0;

  constructor(input: {
    readonly sessionId: string;
    readonly meta?: SessionMeta;
    readonly engine: ExecutionEngine<Cause.YieldableError>;
    readonly directoryNamespace: McpExecutionOwnerDirectoryNamespace<string>;
    readonly forwardModelResumeToOwner?: HarnessSession["modelResumeForward"];
  }) {
    const state = new FakeDurableObjectState(input.sessionId);
    super(state as unknown as DurableObjectState, {} as Cloudflare.Env);
    this.fakeState = state;
    this.meta = input.meta ?? sessionMeta();
    this.directory = mcpExecutionOwnerDirectoryFromNamespace(input.directoryNamespace);
    this.modelResumeForward =
      input.forwardModelResumeToOwner ??
      (() =>
        Effect.succeed({
          status: "execution_expired",
          ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
        }));
    this.installRuntime(input.engine);
  }

  protected override get sessionId(): string {
    return this.fakeState.id.toString();
  }

  protected override executionOwnerDirectory(): McpExecutionOwnerDirectory | null {
    return this.directory;
  }

  protected override forwardModelResumeToOwner(
    owner: McpExecutionOwnerRoute,
    identity: McpApprovalOwner,
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<McpSessionModelResumeResult, unknown> {
    return this.modelResumeForward(owner, identity, executionId, response);
  }

  protected override openSessionDb(): TestDbHandle {
    return { end: () => undefined };
  }

  protected override resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta> {
    return Effect.succeed(
      sessionMeta({ organizationId: token.organizationId, userId: token.userId }),
    );
  }

  protected override buildMcpServer(): Effect.Effect<BuiltMcpServer> {
    const runtime = this.runtimeState();
    return Effect.succeed({
      mcpServer: new McpServer({ name: "test", version: "1.0.0" }),
      engine: runtime.engine!,
    });
  }

  override keepAlive(): Promise<() => void> {
    this.activeKeepAlives += 1;
    return Promise.resolve(() => {
      this.activeKeepAlives -= 1;
    });
  }

  async storeSessionMeta(): Promise<void> {
    await this.fakeState.storage.put("session-meta", this.meta);
  }

  async startPause(executionId: string): Promise<void> {
    await Effect.runPromise(
      this.pausedExecutionHooks.onExecutionPaused?.(executionId, deadline()) ?? Effect.void,
    );
    await this.fakeState.flushWaitUntil();
  }

  async resumeViaModelTool(
    executionId: string,
    response: ResumeResponse,
  ): Promise<McpSessionModelResumeResult | null> {
    const local = await Effect.runPromise(
      this.runtimeState().engine!.resume(executionId, response),
    );
    if (local) return { status: "result", result: formatMcpExecutionOutcome(local) };
    return Effect.runPromise(this.modelResumeFallback(executionId, response));
  }

  pendingLease(executionId: string): PendingApprovalLeaseSnapshot | undefined {
    return this.runtimeState().pendingApprovalLeases.get(executionId);
  }

  pendingLeaseCount(): number {
    return this.runtimeState().pendingApprovalLeases.size;
  }

  private installRuntime(engine: ExecutionEngine<Cause.YieldableError>): void {
    const runtime = this.runtimeState();
    runtime.engine = engine;
    runtime.dbHandle = { end: () => undefined };
    runtime.initialized = true;
    this.server = new McpServer({ name: "test", version: "1.0.0" });
  }

  private runtimeState(): PrivateRuntimeState {
    return this as unknown as PrivateRuntimeState;
  }
}

const makeDirectory = () => {
  const namespace = new InMemoryExecutionOwnerDirectoryNamespace();
  const directory = mcpExecutionOwnerDirectoryFromNamespace(namespace);
  expect(directory).not.toBeNull();
  return { directory: directory!, namespace };
};

const putOwnerRecord = (
  directory: McpExecutionOwnerDirectory,
  input: Partial<McpExecutionOwnerRecord>,
) =>
  Effect.runPromise(
    directory.put({
      executionId: "exec_1",
      owner: { sessionId: "session-a" },
      accountId: "acct_1",
      organizationId: "org_1",
      expiresAt: new Date(Date.now() + PAUSED_APPROVAL_TIMEOUT_MS).toISOString(),
      ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
      ...input,
    }),
  );

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("mcpSessionDurableObjectName", () => {
  it("uses the Agents streamable-http durable object name", () => {
    expect(mcpSessionDurableObjectName("session_123")).toBe("streamable-http:session_123");
  });
});

describe("McpAgentSessionDOBase cross-session model resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("routes a session B resume through the real directory path to session A and releases A's lease", async () => {
    const { directory, namespace } = makeDirectory();
    const ownerEngine = makeEngine((executionId, response) =>
      executionId === "exec_owner" && response.action === "accept"
        ? completed("owner-result")
        : null,
    );
    const requesterEngine = makeEngine(() => null);
    const sessions = new Map<string, HarnessSession>();
    const sessionNamespace = {
      idFromName: (name: string) => name,
      get: (id: string) => sessions.get(id),
    };
    const forward = vi.fn(
      (
        owner: McpExecutionOwnerRoute,
        identity: McpApprovalOwner,
        executionId: string,
        response: ResumeResponse,
      ) =>
        Effect.promise(async () => {
          const session = sessionNamespace.get(
            sessionNamespace.idFromName(mcpSessionDurableObjectName(owner.sessionId)),
          );
          return session
            ? session.resumeExecutionForModel(executionId, identity, response)
            : {
                status: "execution_expired" as const,
                ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
              };
        }),
    );

    const sessionA = new HarnessSession({
      sessionId: "session-a",
      engine: ownerEngine.engine,
      directoryNamespace: namespace,
    });
    const sessionB = new HarnessSession({
      sessionId: "session-b",
      engine: requesterEngine.engine,
      directoryNamespace: namespace,
      forwardModelResumeToOwner: forward,
    });
    sessions.set(mcpSessionDurableObjectName("session-a"), sessionA);
    await sessionA.storeSessionMeta();
    await sessionB.storeSessionMeta();

    await sessionA.startPause("exec_owner");

    expect(await Effect.runPromise(directory.get("exec_owner"))).toMatchObject({
      executionId: "exec_owner",
      owner: { sessionId: "session-a" },
      accountId: "acct_1",
      organizationId: "org_1",
    });
    expect(sessionA.pendingLeaseCount()).toBe(1);
    expect(sessionA.pendingLease("exec_owner")?.timeout).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    const outcome = await sessionB.resumeViaModelTool("exec_owner", approval);
    await flushMicrotasks();

    expect(outcome).toMatchObject({
      status: "result",
      result: {
        structuredContent: {
          status: "completed",
          result: "owner-result",
        },
      },
    });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(requesterEngine.resume).toHaveBeenCalledTimes(1);
    expect(ownerEngine.resume).toHaveBeenCalledTimes(1);
    expect(ownerEngine.calls).toEqual([{ executionId: "exec_owner", response: approval }]);
    expect(sessionA.pendingLeaseCount()).toBe(0);
    expect(sessionA.activeKeepAlives).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await Effect.runPromise(directory.get("exec_owner"))).toBeNull();

    await vi.advanceTimersByTimeAsync(PAUSED_APPROVAL_TIMEOUT_MS + 1);
    await flushMicrotasks();

    expect(ownerEngine.resume).toHaveBeenCalledTimes(1);
    expect(ownerEngine.calls).toEqual([{ executionId: "exec_owner", response: approval }]);
  });

  it("rejects identity mismatch without invoking the owning session engine", async () => {
    const { directory, namespace } = makeDirectory();
    const ownerEngine = makeEngine(() => completed("should-not-run"));
    const requesterEngine = makeEngine(() => null);
    const forward = vi.fn(() =>
      Effect.succeed({
        status: "execution_expired" as const,
        ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
      }),
    );
    const sessionA = new HarnessSession({
      sessionId: "session-a",
      engine: ownerEngine.engine,
      directoryNamespace: namespace,
    });
    const sessionB = new HarnessSession({
      sessionId: "session-b",
      meta: sessionMeta({ organizationId: "org_other" }),
      engine: requesterEngine.engine,
      directoryNamespace: namespace,
      forwardModelResumeToOwner: forward,
    });
    await sessionA.storeSessionMeta();
    await sessionB.storeSessionMeta();
    await sessionA.startPause("exec_forbidden");

    const outcome = await sessionB.resumeViaModelTool("exec_forbidden", approval);

    expect(outcome).toEqual({ status: "execution_forbidden" });
    expect(forward).not.toHaveBeenCalled();
    expect(ownerEngine.resume).not.toHaveBeenCalled();
    expect(sessionA.pendingLeaseCount()).toBe(1);
    expect(await Effect.runPromise(directory.get("exec_forbidden"))).toMatchObject({
      executionId: "exec_forbidden",
      owner: { sessionId: "session-a" },
    });
  });

  it("times out a wedged owner session forward as execution_expired", async () => {
    const { directory, namespace } = makeDirectory();
    const requesterEngine = makeEngine(() => null);
    const forward = vi.fn(() => Effect.never);
    const sessionB = new HarnessSession({
      sessionId: "session-b",
      engine: requesterEngine.engine,
      directoryNamespace: namespace,
      forwardModelResumeToOwner: forward,
    });
    await sessionB.storeSessionMeta();
    await putOwnerRecord(directory, {
      executionId: "exec_timeout",
      owner: { sessionId: "session-a" },
    });

    const pending = sessionB.resumeViaModelTool("exec_timeout", approval);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({
      status: "execution_expired",
      ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
    });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(await Effect.runPromise(directory.get("exec_timeout"))).toBeNull();
  });

  it("does not recurse when the directory maps a local miss back to the same session", async () => {
    const { directory, namespace } = makeDirectory();
    const engine = makeEngine(() => null);
    const forward = vi.fn(() =>
      Effect.succeed({
        status: "result" as const,
        result: formatMcpExecutionOutcome(completed("should-not-forward")),
      }),
    );
    const sessionB = new HarnessSession({
      sessionId: "session-b",
      engine: engine.engine,
      directoryNamespace: namespace,
      forwardModelResumeToOwner: forward,
    });
    await sessionB.storeSessionMeta();
    await putOwnerRecord(directory, {
      executionId: "exec_self",
      owner: { sessionId: "session-b" },
    });

    const outcome = await sessionB.resumeViaModelTool("exec_self", approval);

    expect(outcome).toEqual({
      status: "execution_expired",
      ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
    });
    expect(engine.resume).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
    expect(await Effect.runPromise(directory.get("exec_self"))).toBeNull();
  });
});
