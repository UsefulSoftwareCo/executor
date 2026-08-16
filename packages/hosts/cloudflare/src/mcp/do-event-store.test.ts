import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { DurableObjectMcpEventStore } from "./do-event-store";

type ListOptions = {
  readonly prefix?: string;
  readonly start?: string;
  readonly startAfter?: string;
  readonly limit?: number;
  readonly reverse?: boolean;
};

const makeFakeStorage = () => {
  const entries = new Map<string, unknown>();
  let failWrites = false;
  return {
    entries,
    failWrites: () => {
      failWrites = true;
    },
    put: async (key: string, value: unknown) => {
      if (failWrites) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: simulate the Promise-based Durable Object storage API rejecting
        throw new Error("storage unavailable");
      }
      entries.set(key, value);
    },
    delete: (keys: string | ReadonlyArray<string>) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) entries.delete(key);
      return Promise.resolve(true);
    },
    list: (options: ListOptions = {}) => {
      const keys = [...entries.keys()]
        .filter((key) => (options.prefix === undefined ? true : key.startsWith(options.prefix)))
        .filter((key) => (options.start === undefined ? true : key >= options.start))
        .filter((key) => (options.startAfter === undefined ? true : key > options.startAfter))
        .sort();
      if (options.reverse === true) keys.reverse();
      const limited = options.limit === undefined ? keys : keys.slice(0, options.limit);
      return Promise.resolve(new Map(limited.map((key) => [key, entries.get(key)])));
    },
  };
};

const makeStore = () => {
  const storage = makeFakeStorage();
  const store = new DurableObjectMcpEventStore(storage as never);
  return { storage, store };
};

const eventKeys = (storage: ReturnType<typeof makeFakeStorage>): ReadonlyArray<string> =>
  [...storage.entries.keys()].sort();

describe("DurableObjectMcpEventStore", () => {
  let warnings: string[] = [];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((line: string) => {
      warnings.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves an oversize event live-only without touching Durable Object storage", async () => {
    const { storage, store } = makeStore();
    const eventId = await store.storeEvent("post-stream", {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }] },
    });

    expect(eventId).toBe("post-stream:0000000000000001");
    expect(eventKeys(storage)).toEqual([]);
    expect(warnings.at(-1)).toContain("mcp_event_store_skipped_oversize");
  });

  it("does not reject the send path when Durable Object storage fails", async () => {
    const { storage, store } = makeStore();
    storage.failWrites();

    await expect(
      store.storeEvent("post-stream", { jsonrpc: "2.0", id: 1, result: { ok: true } }),
    ).resolves.toBe("post-stream:0000000000000001");
    expect(warnings.at(-1)).toContain("mcp_event_store_put_failed");
  });

  it("replays stored events strictly after the client's last event", async () => {
    const { store } = makeStore();
    const first = await store.storeEvent("post-stream", {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progress: 1 },
    });
    const second = await store.storeEvent("post-stream", {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    const replayed: string[] = [];

    const streamId = await store.replayEventsAfter(first, {
      send: (eventId) => {
        replayed.push(eventId);
        return Promise.resolve();
      },
    });

    expect(streamId).toBe("post-stream");
    expect(replayed).toEqual([second]);
  });

  it("evicts oldest events at the byte cap but never the newest", async () => {
    const { storage, store } = makeStore();
    const bigMessage = (marker: string) => ({
      jsonrpc: "2.0" as const,
      method: "notifications/progress",
      params: { marker, blob: "y".repeat(100 * 1024) },
    });

    const total = 25;
    for (let index = 0; index < total; index += 1) {
      await store.storeEvent("post-stream", bigMessage(`msg-${index}`));
    }

    const remaining = eventKeys(storage);
    expect(remaining.at(-1)).toBe(
      `executor:mcp:v2:event:post-stream:${total.toString(16).padStart(16, "0")}`,
    );
    expect(remaining.length).toBeLessThan(total);
    expect(warnings.at(-1)).toContain("mcp_event_store_evicted");
  });

  it("retains only the newest 64 events from a chatty stream", async () => {
    const { storage, store } = makeStore();
    const total = 70;
    for (let index = 0; index < total; index += 1) {
      await store.storeEvent("chatty-stream", {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progress: index },
      });
    }

    const remaining = eventKeys(storage);
    expect(remaining).toHaveLength(64);
    expect(remaining[0]).toBe(
      `executor:mcp:v2:event:chatty-stream:${(total - 63).toString(16).padStart(16, "0")}`,
    );
    expect(remaining.at(-1)).toBe(
      `executor:mcp:v2:event:chatty-stream:${total.toString(16).padStart(16, "0")}`,
    );
  });
});
