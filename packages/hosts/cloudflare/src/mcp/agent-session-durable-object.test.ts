import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ExecutionEngine } from "@executor-js/execution";
import { defaultMcpResource } from "@executor-js/host-mcp";
import { buildMcpServerV2, mcpRequestStatePrincipal } from "@executor-js/host-mcp/tool-server-v2";

import { withVerifiedIdentityHeaders } from "./do-headers";
import {
  McpAgentSessionDOBase,
  type BuiltMcpServer,
  type McpSessionInit,
  type SessionMeta,
} from "./agent-session-durable-object";

const SESSION_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ACCOUNT_ID = "acct_test";
const ORGANIZATION_ID = "org_test";
const REQUEST_STATE_KEY = "0123456789abcdef0123456789abcdef";

class MemoryStorage implements DurableObjectStorage, DurableObjectTransaction {
  private readonly values = new Map<string, unknown>();
  readonly sql = {} as DurableObjectStorage["sql"];
  readonly kv = {} as DurableObjectStorage["kv"];
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      return new Map(keyOrKeys.map((key) => [key, this.values.get(key) as T]));
    }
    return this.values.get(keyOrKeys) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void>;
  async put<T>(entries: Record<string, T> | Map<string, T>): Promise<void>;
  async put<T>(
    keyOrEntries: string | Record<string, T> | Map<string, T>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, value);
      return;
    }
    const entries =
      keyOrEntries instanceof Map ? keyOrEntries.entries() : Object.entries(keyOrEntries);
    for (const [key, entry] of entries) this.values.set(key, entry);
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (!Array.isArray(keyOrKeys)) return this.values.delete(keyOrKeys);
    let deleted = 0;
    for (const key of keyOrKeys) {
      if (this.values.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async list<T = unknown>(options: DurableObjectListOptions = {}): Promise<Map<string, T>> {
    let keys = [...this.values.keys()]
      .filter((key) => (options.prefix === undefined ? true : key.startsWith(options.prefix)))
      .filter((key) => (options.start === undefined ? true : key >= options.start))
      .filter((key) => (options.startAfter === undefined ? true : key > options.startAfter))
      .sort();
    if (options.reverse) keys = keys.reverse();
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    return new Map(keys.map((key) => [key, this.values.get(key) as T]));
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
    this.alarmAt = null;
  }

  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    return closure(this);
  }

  rollback(): void {}

  transactionSync<T>(closure: () => T): T {
    return closure();
  }

  async sync(): Promise<void> {}

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  async getCurrentBookmark(): Promise<string> {
    return "test-bookmark";
  }

  async getBookmarkForTime(_timestamp: number | Date): Promise<string> {
    return "test-bookmark";
  }

  onNextSessionRestoreBookmark(_bookmark: string): Promise<string> {
    return Promise.resolve("test-bookmark");
  }
}

class MemoryDurableObjectState implements DurableObjectState {
  readonly id: DurableObjectId;
  readonly props: unknown = undefined;
  readonly facets = {} as DurableObjectState["facets"];
  readonly storage: MemoryStorage;
  private waitUntilPromises: Promise<unknown>[] = [];
  abortedWith: string | undefined;

  constructor(storage = new MemoryStorage()) {
    this.storage = storage;
    const id: Pick<DurableObjectId, "equals" | "toString"> = {
      equals: (other) => other.toString() === SESSION_ID,
      toString: () => SESSION_ID,
    };
    this.id = id as DurableObjectId;
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

  acceptWebSocket(_ws: WebSocket, _tags?: string[]): void {}
  getWebSockets(_tag?: string): WebSocket[] {
    return [];
  }
  getTags(_ws: WebSocket): string[] {
    return [];
  }
  setWebSocketAutoResponse(_pair?: WebSocketRequestResponsePair): void {}
  getWebSocketAutoResponse(): WebSocketRequestResponsePair | null {
    return null;
  }
  getWebSocketAutoResponseTimestamp(_ws: WebSocket): Date | null {
    return null;
  }
  setHibernatableWebSocketEventTimeout(_timeoutMs?: number): void {}
  getHibernatableWebSocketEventTimeout(): number | null {
    return null;
  }
  abort(reason?: string): void {
    this.abortedWith = reason;
  }
}

const engine: ExecutionEngine<Cause.YieldableError> = {
  execute: (code) => Effect.succeed({ result: code }),
  executeWithPause: (code) =>
    Effect.succeed({ status: "completed" as const, result: { result: code } }),
  resume: () => Effect.succeed(null),
  isExecutionSettled: () => Effect.succeed(false),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test Durable Object executor"),
};

class HarnessSession extends McpAgentSessionDOBase<Cloudflare.Env, { readonly end: () => void }> {
  constructor(
    ctx: DurableObjectState,
    env: Cloudflare.Env,
    private readonly sessionEngine: ExecutionEngine<Cause.YieldableError> = engine,
  ) {
    super(ctx, env);
  }

  protected override openSessionDb(): { readonly end: () => void } {
    return { end: () => undefined };
  }

  protected override resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta> {
    return Effect.succeed({
      organizationId: token.organizationId,
      organizationName: "Test Org",
      userId: token.userId,
      elicitationMode: token.elicitationMode,
      artifactsEnabled: token.artifactsEnabled,
      resource: token.resource,
      webOrigin: token.webOrigin,
    });
  }

  protected override buildMcpServer(sessionMeta: SessionMeta): Effect.Effect<BuiltMcpServer> {
    const elicitationMode = sessionMeta.elicitationMode ?? "model";
    return buildMcpServerV2({
      engine: this.sessionEngine,
      appsEnabled: false,
      restoredAppsEnabled: sessionMeta.appsEnabled,
      onAppsEnabledChange: (appsEnabled) => this.persistAppsEnabled(appsEnabled),
      requestStateSigningKey: REQUEST_STATE_KEY,
      requestStatePrincipal: mcpRequestStatePrincipal({
        accountId: sessionMeta.userId,
        organizationId: sessionMeta.organizationId,
      }),
      sessionful: true,
      elicitationMode:
        elicitationMode === "browser"
          ? { mode: "browser", approvalUrl: () => "https://executor.test/approve" }
          : { mode: elicitationMode },
    }).pipe(Effect.map((mcpServer) => ({ mcpServer, engine: this.sessionEngine })));
  }
}

const verifiedRequest = (request: Request): Request =>
  withVerifiedIdentityHeaders(
    request,
    { accountId: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
    defaultMcpResource,
  );

const makeClientHarness = (state = new MemoryDurableObjectState()) => {
  let session = new HarnessSession(state, {} as Cloudflare.Env);
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return session.fetch(verifiedRequest(request));
  };
  const transport = new StreamableHTTPClientTransport(
    new URL("https://executor.test/mcp?elicitation_mode=model"),
    { fetch },
  );
  const client = new Client({ name: "legacy-do-client", version: "1.0.0" });
  return {
    client,
    state,
    transport,
    evict: () => {
      session = new HarnessSession(state, {} as Cloudflare.Env);
    },
  };
};

describe("McpAgentSessionDOBase SDK v2 session serving", () => {
  it("serves and reuses a legacy v1 SDK client through the Durable Object", async () => {
    const harness = makeClientHarness();
    await harness.client.connect(harness.transport);

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always release the MCP client's streamed transport after assertions
    try {
      const tools = await harness.client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain("execute");

      const result = await harness.client.callTool({
        name: "execute",
        arguments: { code: "return 42" },
      });
      expect(result.content).toEqual([{ type: "text", text: "return 42" }]);
      expect(harness.transport.sessionId).toBe(SESSION_ID);
    } finally {
      await harness.client.close();
    }
  });

  it("cold-restores the same v1 session without replaying initialize", async () => {
    const harness = makeClientHarness();
    await harness.client.connect(harness.transport);

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always release the MCP client's streamed transport after assertions
    try {
      await harness.client.listTools();
      harness.evict();
      const tools = await harness.client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain("execute");
    } finally {
      await harness.client.close();
    }
  });

  it("primes a slow legacy tool stream and replays its result after disconnect", async () => {
    let startExecution = (): void => undefined;
    const executionStarted = new Promise<void>((resolve) => {
      startExecution = resolve;
    });
    let finishExecution = (): void => undefined;
    const executionResult = new Promise<{ readonly result: string }>((resolve) => {
      finishExecution = () => resolve({ result: "slow result" });
    });
    const slowEngine: ExecutionEngine<Cause.YieldableError> = {
      ...engine,
      execute: () =>
        Effect.promise(() => {
          startExecution();
          return executionResult;
        }),
      executeWithPause: () =>
        Effect.promise(() => {
          startExecution();
          return executionResult;
        }).pipe(Effect.map((result) => ({ status: "completed" as const, result }))),
    };
    const state = new MemoryDurableObjectState();
    const session = new HarnessSession(state, {} as Cloudflare.Env, slowEngine);
    const post = (body: unknown, sessionId?: string): Request =>
      verifiedRequest(
        new Request("https://executor.test/mcp?elicitation_mode=model", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...(sessionId
              ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }
              : {}),
          },
          body: JSON.stringify(body),
        }),
      );

    const initialize = await session.fetch(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-reconnect-test", version: "1.0.0" },
        },
      }),
    );
    expect(initialize.headers.get("mcp-session-id")).toBe(SESSION_ID);
    await initialize.text();
    await session.fetch(
      post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, SESSION_ID),
    );

    const toolResponse = await session.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "execute", arguments: { code: "return slow" } },
        },
        SESSION_ID,
      ),
    );
    const reader = toolResponse.body?.getReader();
    const first = await reader?.read();
    const primingFrame = new TextDecoder().decode(first?.value);
    expect(primingFrame).toContain("event: mcp-priming");
    const eventId = /^id: (.+)$/m.exec(primingFrame)?.[1];
    const replayEventId = eventId ?? "";
    expect(replayEventId).not.toBe("");
    await reader?.cancel("simulated network drop");

    await executionStarted;
    finishExecution();
    await Promise.resolve();
    await Promise.resolve();

    const replay = await session.fetch(
      verifiedRequest(
        new Request("https://executor.test/mcp", {
          method: "GET",
          headers: {
            accept: "text/event-stream",
            "mcp-session-id": SESSION_ID,
            "mcp-protocol-version": "2025-06-18",
            "last-event-id": replayEventId,
          },
        }),
      ),
    );
    const replayBody = await replay.text();
    expect(replayBody).toContain("slow result");
    expect(replayBody).toContain(`id: ${replayEventId.slice(0, replayEventId.lastIndexOf(":"))}:`);
  });

  it("persists v2 metadata and rejects a different principal", async () => {
    const harness = makeClientHarness();
    await harness.client.connect(harness.transport);

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always release the MCP client's streamed transport after assertions
    try {
      const stored = await harness.state.storage.get<SessionMeta>("executor:mcp:v2:session-meta");
      expect(stored).toMatchObject({
        organizationId: ORGANIZATION_ID,
        userId: ACCOUNT_ID,
        elicitationMode: "model",
        appsEnabled: false,
      });
      expect(stored?.createdAtMs).toEqual(expect.any(Number));

      const session = new HarnessSession(harness.state, {} as Cloudflare.Env);
      await expect(
        session.validateMcpSessionOwner({
          accountId: "acct_other",
          organizationId: ORGANIZATION_ID,
        }),
      ).resolves.toBe("forbidden");
    } finally {
      await harness.client.close();
    }
  });

  it("returns a clean 404 for storage created by the pre-v2 Agent stack", async () => {
    const state = new MemoryDurableObjectState();
    await state.storage.put("session-meta", {
      organizationId: ORGANIZATION_ID,
      organizationName: "Old Agent Org",
      userId: ACCOUNT_ID,
      resource: defaultMcpResource,
    } satisfies SessionMeta);
    const session = new HarnessSession(state, {} as Cloudflare.Env);
    const request = verifiedRequest(
      new Request("https://executor.test/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": SESSION_ID,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    const response = await session.fetch(request);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32001, message: "Session not found" },
    });
  });
});
