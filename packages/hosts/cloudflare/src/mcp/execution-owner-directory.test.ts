import { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  McpExecutionOwnerDirectoryDO,
  mcpExecutionOwnerDirectoryFromNamespace,
  type McpExecutionOwnerDirectoryNamespace,
  type McpExecutionOwnerRecord,
} from "./execution-owner-directory";

class FakeStorage implements DurableObjectStorage {
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

  async list<T = unknown>(): Promise<Map<string, T>> {
    return new Map([...this.values.entries()].map(([key, value]) => [key, value as T]));
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
    this.alarmAt = null;
  }

  transaction<T>(_closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    return Promise.resolve(undefined as T);
  }

  transactionSync<T>(_closure: () => T): T {
    return undefined as T;
  }

  async sync(): Promise<void> {}

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
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

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

class FakeDurableObjectState implements DurableObjectState {
  readonly id: DurableObjectId;
  readonly props: unknown = undefined;
  readonly facets = {} as DurableObjectState["facets"];
  readonly ctx = this;
  private readonly waitUntilPromises: Promise<unknown>[] = [];

  constructor(
    name: string,
    readonly storage: FakeStorage,
  ) {
    const id: Pick<DurableObjectId, "equals" | "name" | "toString"> = {
      equals: (other: DurableObjectId) => other.toString() === name,
      name,
      toString: () => name,
    };
    this.id = id as DurableObjectId;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.waitUntilPromises.push(promise);
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

  abort(_reason?: string): void {}
}

const makeDirectory = () => {
  const storage = new FakeStorage();
  const directory = new McpExecutionOwnerDirectoryDO(
    new FakeDurableObjectState("execution-owner", storage),
    {},
  );
  return { directory, storage };
};

class FakeDirectoryNamespace implements McpExecutionOwnerDirectoryNamespace<string> {
  private readonly directories = new Map<string, McpExecutionOwnerDirectoryDO>();

  idFromName(name: string): string {
    return name;
  }

  get(id: string): unknown {
    let directory = this.directories.get(id);
    if (!directory) {
      directory = makeDirectory().directory;
      this.directories.set(id, directory);
    }
    if (!(directory instanceof DurableObject)) return {};
    return {
      put: (entry: McpExecutionOwnerRecord) => directory.put(entry),
      get: (executionId: string) => directory.get(executionId),
      delete: (executionId: string) => directory.delete(executionId),
    };
  }
}

const record = (input?: Partial<McpExecutionOwnerRecord>): McpExecutionOwnerRecord => ({
  executionId: "exec_1",
  owner: { sessionId: "session_a" },
  accountId: "acct_1",
  organizationId: "org_1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ttlMs: 60_000,
  ...input,
});

describe("McpExecutionOwnerDirectoryDO", () => {
  it("exports a DurableObject subclass for RPC method dispatch", () => {
    expect(Object.getPrototypeOf(McpExecutionOwnerDirectoryDO)).toBe(DurableObject);
    expect(makeDirectory().directory).toBeInstanceOf(DurableObject);
  });

  it("stores and reads an unexpired execution owner record", async () => {
    const { directory, storage } = makeDirectory();
    const entry = record();

    await directory.put(entry);

    expect(await directory.get("exec_1")).toEqual(entry);
    expect(storage.alarmAt).toBe(Date.parse(entry.expiresAt));
  });

  it("treats expired records as absent and deletes them", async () => {
    const { directory, storage } = makeDirectory();
    const entry = record({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await directory.put(entry);

    expect(await directory.get("exec_1")).toBeNull();
    expect(await storage.get("owner")).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
  });

  it("alarm deletes the owner record", async () => {
    const { directory, storage } = makeDirectory();
    await directory.put(record());

    await directory.alarm();

    expect(await storage.get("owner")).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
  });

  it("stores, reads, and deletes records through the namespace RPC path", async () => {
    const directory = mcpExecutionOwnerDirectoryFromNamespace(new FakeDirectoryNamespace());
    const entry = record({ executionId: "exec_rpc" });

    expect(directory).not.toBeNull();
    await Effect.runPromise(directory!.put(entry));

    expect(await Effect.runPromise(directory!.get("exec_rpc"))).toEqual(entry);

    await Effect.runPromise(directory!.delete("exec_rpc"));

    expect(await Effect.runPromise(directory!.get("exec_rpc"))).toBeNull();
  });
});
