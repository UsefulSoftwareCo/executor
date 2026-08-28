// Unit coverage for the patched agents DurableObjectEventStore (see
// patches/agents@0.17.3.patch). The store is the durable half of the MCP
// result-replay fix: a final tool response persisted here is the only copy a
// recovery GET can replay after the client's POST response body died, so
// trimStream must never evict it.
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { DurableObjectEventStore } from "agents/mcp";

type ListOptions = {
  readonly prefix?: string;
  readonly start?: string;
  readonly limit?: number;
  readonly reverse?: boolean;
};

/** Minimal in-memory stand-in for DurableObjectStorage's sorted KV surface. */
const makeFakeStorage = () => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    put: (key: string, value: unknown) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (keys: string | ReadonlyArray<string>) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) entries.delete(key);
      return Promise.resolve();
    },
    list: (options: ListOptions = {}) => {
      const keys = [...entries.keys()]
        .filter((key) => (options.prefix === undefined ? true : key.startsWith(options.prefix)))
        .filter((key) => (options.start === undefined ? true : key >= options.start))
        .sort();
      if (options.reverse === true) keys.reverse();
      const limited = options.limit === undefined ? keys : keys.slice(0, options.limit);
      return Promise.resolve(new Map(limited.map((key) => [key, entries.get(key)])));
    },
  };
};

const makeStore = () => {
  const storage = makeFakeStorage();
  // The store only touches put/list/delete; the fake covers exactly that.
  const store = new DurableObjectEventStore(storage as never);
  return { storage, store };
};

const eventKeys = (storage: ReturnType<typeof makeFakeStorage>): ReadonlyArray<string> =>
  [...storage.entries.keys()].sort();

describe("DurableObjectEventStore trimStream", () => {
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

  it("skips storing a message beyond DO storage's per-value cap, returning no replay id", async () => {
    // Real DO storage rejects any value over 128 KiB. This used to be
    // discovered inside storage.put — thrown BEFORE the live SSE write, so an
    // oversize response (the ~5MB ui:// shell document) was neither stored nor
    // delivered and the client hung on keepalives. The pinned contract now:
    // oversize messages skip persistence with a warning and resolve undefined,
    // and the caller delivers them live without a replay id.
    const { storage, store } = makeStore();
    const hugeResult = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }] },
    };

    const eventId = await store.storeEvent("post-stream", hugeResult);

    expect(eventId, "no replay id for an unstorable message").toBeUndefined();
    expect(eventKeys(storage), "nothing was persisted").toEqual([]);
    expect(warnings.length, "the skip is logged").toBeGreaterThan(0);
    expect(warnings.at(-1)).toContain("mcp_event_store_skipped_oversize");
    expect(warnings.at(-1)).toContain("post-stream");
  });

  it("does not advance the stream sequence when an oversize message is skipped", async () => {
    const { storage, store } = makeStore();
    await store.storeEvent("post-stream", {
      jsonrpc: "2.0" as const,
      method: "notifications/progress",
      params: { blob: "x".repeat(3 * 1024 * 1024) },
    });

    const eventId = await store.storeEvent("post-stream", {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { ok: true },
    });

    expect(eventId, "the next storable event takes the first sequence slot").toBe(
      "post-stream:0000000000000001",
    );
    expect(eventKeys(storage)).toEqual(["__mcp_event__:post-stream:0000000000000001"]);
  });

  it("evicts oldest events at the byte cap but never the newest", async () => {
    const { storage, store } = makeStore();
    // 100 KiB each: storable (under the 120 KiB per-value guard), but 25 of
    // them exceed the 2 MB per-stream byte cap.
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
    expect(remaining[remaining.length - 1], "the newest event is always retained").toBe(
      `__mcp_event__:post-stream:${total.toString(16).padStart(16, "0")}`,
    );
    expect(
      remaining.length,
      "older events were evicted to satisfy the 2MB stream cap",
    ).toBeLessThan(total);
    expect(warnings.length, "eviction logs a warning").toBeGreaterThan(0);
    expect(warnings.at(-1)).toContain("mcp_event_store_evicted");
    expect(warnings.at(-1)).toContain("post-stream");
  });

  it("evicts oldest events past the per-stream event-count cap", async () => {
    const { storage, store } = makeStore();
    const total = 70; // MAX_EVENTS_PER_STREAM is 64
    for (let index = 0; index < total; index += 1) {
      await store.storeEvent("chatty-stream", {
        jsonrpc: "2.0" as const,
        method: "notifications/progress",
        params: { index },
      });
    }

    const remaining = eventKeys(storage);
    expect(remaining.length, "stream is capped at 64 events").toBe(64);
    expect(remaining[remaining.length - 1], "the newest event survives the count cap").toBe(
      `__mcp_event__:chatty-stream:${total.toString(16).padStart(16, "0")}`,
    );
    expect(remaining[0], "the oldest surviving event is the one just inside the cap").toBe(
      `__mcp_event__:chatty-stream:${(total - 63).toString(16).padStart(16, "0")}`,
    );
  });

  it("leaves streams under both caps untouched", async () => {
    const { storage, store } = makeStore();
    await store.storeEvent("quiet-stream", {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { ok: true },
    });
    await store.storeEvent("quiet-stream", {
      jsonrpc: "2.0" as const,
      id: 2,
      result: { ok: true },
    });

    expect(eventKeys(storage)).toEqual([
      "__mcp_event__:quiet-stream:0000000000000001",
      "__mcp_event__:quiet-stream:0000000000000002",
    ]);
    expect(warnings).toEqual([]);
  });
});
