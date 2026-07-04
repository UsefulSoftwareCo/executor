import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

import { defaultMcpResource } from "@executor-js/host-mcp";

import { McpAgentSessionDOBase, type SessionMeta } from "./agent-session-durable-object";

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
  engine: { readonly pausedExecutionCount: () => Effect.Effect<number> } | null;
  getSessionId: () => string;
  initialized: boolean;
  lastActivityMs: number;
  maxPausedSessionIdleMs: () => number;
  onStart: () => Promise<void>;
  pendingApprovalLeases: Map<string, never>;
  props: Record<string, unknown>;
  server?: McpServer;
  sessionMeta: SessionMeta;
  sessionTimeoutMs: () => number;
  validateMcpSessionOwner: (identity: {
    readonly accountId: string;
    readonly organizationId: string;
  }) => Promise<"ok" | "not_found" | "forbidden">;
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
  session.engine = { pausedExecutionCount: () => Effect.succeed(0) };
  session.getSessionId = () => sessionId;
  session.initialized = true;
  session.lastActivityMs = Date.now() - 10;
  session.maxPausedSessionIdleMs = () => 1_000;
  session.pendingApprovalLeases = new Map<string, never>();
  session.props = {};
  session.server = server;
  session.sessionMeta = sessionMeta;
  session.sessionTimeoutMs = () => 1;
  session.onStart = async () => {
    const restored = session.server ?? makeServer();
    session.server = restored;
    await restored.connect(new RestoredTransport());
    session.initialized = true;
  };

  return session;
};

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

    session.onStart = async () => {
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
});
