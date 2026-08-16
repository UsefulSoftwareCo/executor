import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";

import type {
  ExecutionEngine,
  ExecutionResult,
  PausedExecution,
  ResumeResponse,
} from "@executor-js/execution";
import { defaultMcpResource } from "@executor-js/host-mcp";
import { PAUSED_APPROVAL_TIMEOUT_MS } from "@executor-js/host-mcp/tool-server";
import { buildMcpServerV2 } from "@executor-js/host-mcp/tool-server-v2";
import { FormElicitation, ToolAddress } from "@executor-js/sdk";

import {
  McpAgentSessionDOBase,
  type BuiltMcpServer,
  type BuiltModernMcpRuntime,
  type McpSessionInit,
  type McpSessionProps,
  type ModernMcpServerRequestOptions,
  type SessionMeta,
} from "./agent-session-durable-object";
import {
  modernMcpExecutionOwnerRoute,
  type McpExecutionOwnerDirectory,
  type McpExecutionOwnerRecord,
  type McpExecutionOwnerRoute,
} from "./execution-owner-directory";

const REQUEST_STATE_KEY = "0123456789abcdef0123456789abcdef";
const EXECUTION_ID = "exec-modern-pause";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  alarm: number | undefined;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | readonly string[]): Promise<void> {
    if (typeof key === "string") {
      this.values.delete(key);
      return;
    }
    for (const entry of key) this.values.delete(entry);
  }

  async list<T>(options: { readonly prefix?: string } = {}): Promise<Map<string, T>> {
    return new Map(
      Array.from(this.values.entries())
        .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
        .map(([key, value]) => [key, value as T]),
    );
  }

  async setAlarm(time: number | Date): Promise<void> {
    this.alarm = typeof time === "number" ? time : time.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = undefined;
  }
}

class MemoryContext {
  readonly storage = new MemoryStorage();
  readonly id = {
    name: undefined,
    toString: () => "modern-do-id",
  };
  readonly waitUntilPromises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.waitUntilPromises.push(promise);
  }
}

class MemoryDirectory implements McpExecutionOwnerDirectory {
  readonly records = new Map<string, McpExecutionOwnerRecord>();

  put(record: McpExecutionOwnerRecord): Effect.Effect<void> {
    return Effect.sync(() => {
      this.records.set(record.executionId, record);
    });
  }

  get(executionId: string): Effect.Effect<McpExecutionOwnerRecord | null> {
    return Effect.sync(() => this.records.get(executionId) ?? null);
  }

  delete(executionId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.records.delete(executionId);
    });
  }
}

type Harness = {
  approvalResponses: Map<string, ResumeResponse>;
  approvalWaiters: Map<string, unknown>;
  beginPendingApprovalResume: (executionId: string) => Effect.Effect<void>;
  buildMcpServer: () => Effect.Effect<BuiltMcpServer>;
  buildModernMcpRuntime: () => Effect.Effect<BuiltModernMcpRuntime>;
  ctx: MemoryContext;
  dbHandle: { readonly end: () => void } | null;
  engine: ExecutionEngine<Cause.YieldableError> | null;
  executionOwnerDirectory: () => McpExecutionOwnerDirectory;
  finishPendingApprovalResume: (executionId: string) => Effect.Effect<void>;
  initialized: boolean;
  keepAlive: () => Promise<() => void>;
  lastActivityMs: number;
  modernHandler: null;
  modernPausedExecutionHooks: {
    readonly onExecutionPaused: (
      executionId: string,
      deadline: { readonly expiresAt: string; readonly ttlMs: number } | undefined,
    ) => Effect.Effect<void>;
    readonly onResumeStarted: (executionId: string) => Effect.Effect<void>;
    readonly onResumeSettled: (executionId: string) => Effect.Effect<void>;
  };
  modernRequestBodies: WeakMap<Request, unknown>;
  modernRequestPropagation: WeakMap<Request, undefined>;
  modernRequestStateSigningKey: () => string;
  modernRunningRequestCount: number;
  modernRuntime: BuiltModernMcpRuntime | null;
  modernRuntimePromise: Promise<unknown> | null;
  onStartPromise: Promise<void> | null;
  openSessionDb: () => { readonly end: () => void };
  pendingApprovalLeases: Map<string, unknown>;
  resolveSessionMeta: (token: McpSessionInit) => Effect.Effect<SessionMeta>;
  serveModernMcp: (
    request: Request,
    props: McpSessionProps,
    parsedBody: unknown,
  ) => Promise<Response>;
  server?: never;
  sessionMeta: SessionMeta | null;
  startPendingApprovalLease: (
    executionId: string,
    deadline: { readonly expiresAt: string; readonly ttlMs: number } | undefined,
    owner: McpExecutionOwnerRoute,
  ) => Effect.Effect<void>;
};

const makeEngine = (): {
  readonly engine: ExecutionEngine<Cause.YieldableError>;
  readonly resumeCalls: ResumeResponse[];
} => {
  const paused = new Map<string, PausedExecution>();
  const resumeCalls: ResumeResponse[] = [];
  const execution: PausedExecution = {
    id: EXECUTION_ID,
    elicitationContext: {
      address: ToolAddress.make("tools.test.org.main.confirm"),
      args: {},
      request: FormElicitation.make({ message: "Confirm?", requestedSchema: {} }),
    },
  };
  const engine: ExecutionEngine<Cause.YieldableError> = {
    execute: () => Effect.succeed({ result: "unused" }),
    executeWithPause: () =>
      Effect.sync(() => {
        paused.set(execution.id, execution);
        return { status: "paused" as const, execution };
      }),
    resume: (executionId, response) =>
      Effect.sync((): ExecutionResult | null => {
        if (!paused.delete(executionId)) return null;
        resumeCalls.push(response);
        return { status: "completed", result: { result: response.content?.approved } };
      }),
    isExecutionSettled: () => Effect.succeed(false),
    getPausedExecution: (executionId) => Effect.sync(() => paused.get(executionId) ?? null),
    pausedExecutionCount: () => Effect.sync(() => paused.size),
    hasPausedExecutions: () => Effect.sync(() => paused.size > 0),
    getDescription: Effect.succeed("test engine"),
  };
  return { engine, resumeCalls };
};

const makeHarness = () => {
  const ctx = new MemoryContext();
  const directory = new MemoryDirectory();
  const { engine, resumeCalls } = makeEngine();
  const session = Object.create(McpAgentSessionDOBase.prototype) as Harness;
  session.ctx = ctx;
  session.engine = null;
  session.dbHandle = null;
  session.sessionMeta = null;
  session.modernRuntime = null;
  session.modernRuntimePromise = null;
  session.modernHandler = null;
  session.modernRunningRequestCount = 0;
  session.modernRequestBodies = new WeakMap();
  session.modernRequestPropagation = new WeakMap();
  session.initialized = false;
  session.onStartPromise = null;
  session.lastActivityMs = 0;
  session.approvalResponses = new Map();
  session.approvalWaiters = new Map();
  session.pendingApprovalLeases = new Map();
  session.openSessionDb = () => ({ end: () => undefined });
  session.keepAlive = () => Promise.resolve(() => undefined);
  session.executionOwnerDirectory = () => directory;
  session.modernRequestStateSigningKey = () => REQUEST_STATE_KEY;
  session.resolveSessionMeta = (token) =>
    Effect.succeed({
      organizationId: token.organizationId,
      organizationName: "Test Org",
      userId: token.userId,
      resource: token.resource,
      elicitationMode: token.elicitationMode,
      artifactsEnabled: token.artifactsEnabled,
      webOrigin: token.webOrigin,
    });
  session.buildMcpServer = () => Effect.die("legacy build is not used by this harness");
  session.modernPausedExecutionHooks = {
    onExecutionPaused: (executionId, deadline) =>
      session.startPendingApprovalLease(
        executionId,
        deadline,
        modernMcpExecutionOwnerRoute(ctx.id.toString()),
      ),
    onResumeStarted: (executionId) => session.beginPendingApprovalResume(executionId),
    onResumeSettled: (executionId) => session.finishPendingApprovalResume(executionId),
  };
  session.buildModernMcpRuntime = () =>
    Effect.succeed({
      engine,
      buildServer: (options: ModernMcpServerRequestOptions) =>
        buildMcpServerV2({
          engine,
          elicitationMode: { mode: "native" },
          pausedExecutionHooks: session.modernPausedExecutionHooks,
          pausedExecutionLeaseMs: PAUSED_APPROVAL_TIMEOUT_MS,
          ...options,
        }),
    });
  return { session, directory, resumeCalls };
};

const requestBody = (input?: { readonly requestState?: string }) => ({
  jsonrpc: "2.0",
  id: input?.requestState ? 2 : 1,
  method: "tools/call",
  params: {
    name: "execute",
    arguments: { code: "await tools.test.confirm()" },
    ...(input?.requestState
      ? {
          requestState: input.requestState,
          inputResponses: {
            elicitation: { action: "accept", content: { approved: true } },
          },
        }
      : {}),
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
    },
  },
});

const requestFor = (body: ReturnType<typeof requestBody>): Request =>
  new Request("https://executor.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "execute",
      "x-executor-mcp-account-id": "acct_1",
      "x-executor-mcp-organization-id": "org_1",
      "x-executor-mcp-resource-key": "default",
    },
    body: JSON.stringify(body),
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestStateFromResponse = (value: unknown): string | null => {
  if (!isRecord(value) || !isRecord(value.result)) return null;
  return typeof value.result.requestState === "string" ? value.result.requestState : null;
};

describe("McpAgentSessionDOBase modern entry", () => {
  it("serves a pause, registers modern ownership, and resumes in the same DO", async () => {
    const { session, directory, resumeCalls } = makeHarness();
    const props: McpSessionProps = {
      session: {
        organizationId: "org_1",
        userId: "acct_1",
        elicitationMode: "native",
        resource: defaultMcpResource,
        webOrigin: "https://executor.test",
      },
    };

    const firstBody = requestBody();
    const first = await session.serveModernMcp(requestFor(firstBody), props, firstBody);
    const firstPayload: unknown = await first.json();
    const requestState = requestStateFromResponse(firstPayload);

    expect(first.status).toBe(200);
    expect(requestState).not.toBeNull();
    expect(directory.records.get(EXECUTION_ID)).toMatchObject({
      executionId: EXECUTION_ID,
      owner: { sessionId: "modern:modern-do-id" },
      accountId: "acct_1",
      organizationId: "org_1",
      ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
    });
    if (!requestState) return;

    const secondBody = requestBody({ requestState });
    const second = await session.serveModernMcp(requestFor(secondBody), props, secondBody);
    const secondText = JSON.stringify(await second.json());

    expect(second.status).toBe(200);
    expect(secondText).toContain("true");
    expect(resumeCalls).toEqual([{ action: "accept", content: { approved: true } }]);
    expect(directory.records.has(EXECUTION_ID)).toBe(false);
  });
});
