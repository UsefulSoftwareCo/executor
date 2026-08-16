import type { EventId, EventStore, JSONRPCMessage, StreamId } from "@modelcontextprotocol/server";

const EVENT_KEY_PREFIX = "executor:mcp:v2:event:";
const SEQUENCE_WIDTH = 16;
const REPLAY_LIMIT = 1_000;
const DELETE_CHUNK_SIZE = 128;

/** Maximum number of replayable events retained for one SDK response stream. */
export const MAX_EVENTS_PER_MCP_STREAM = 64;

/** Maximum approximate JSON bytes retained for one SDK response stream. */
export const MAX_BYTES_PER_MCP_STREAM = 2 * 1024 * 1024;

/**
 * Conservative payload ceiling below Durable Object storage's 128 KiB
 * per-value limit. Larger events remain live-deliverable but are not persisted.
 */
export const MAX_STORABLE_MCP_EVENT_BYTES = 120 * 1024;

type McpEventStorage = Pick<DurableObjectStorage, "delete" | "list" | "put">;

type StoredEntry = {
  readonly key: string;
  readonly bytes: number;
};

const eventPrefix = (streamId: StreamId): string => `${EVENT_KEY_PREFIX}${streamId}:`;

const eventIdFromKey = (key: string): EventId => key.slice(EVENT_KEY_PREFIX.length);

const streamIdFromEventId = (eventId: EventId): StreamId | undefined => {
  const separator = eventId.lastIndexOf(":");
  return separator > 0 ? eventId.slice(0, separator) : undefined;
};

const messageBytes = (message: JSONRPCMessage): number | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- serialization boundary: an unstringifiable SDK payload is live-only
  try {
    return new TextEncoder().encode(JSON.stringify(message)).byteLength;
  } catch {
    return null;
  }
};

const logStoreWarning = (event: string, fields: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ event, ...fields }));
};

/**
 * MCP replay storage backed by one session Durable Object's KV store.
 *
 * Writes are deliberately best-effort: storage limits or outages never escape
 * into the transport's send path. Every call still returns a monotonic event
 * ID so the SDK can deliver the message live; an event whose persistence failed
 * simply has no replayable payload behind that ID.
 */
export class DurableObjectMcpEventStore implements EventStore {
  private readonly sequenceByStream = new Map<StreamId, number>();
  private readonly sequenceLoads = new Map<StreamId, Promise<void>>();

  constructor(private readonly storage: McpEventStorage) {}

  private async ensureSequenceLoaded(streamId: StreamId): Promise<void> {
    if (this.sequenceByStream.has(streamId)) return;
    const existing = this.sequenceLoads.get(streamId);
    if (existing) return existing;

    const loading = (async () => {
      let sequence = 0;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- storage boundary: sequence recovery is best-effort and falls back to this isolate's monotonic counter
      try {
        const rows = await this.storage.list<unknown>({
          prefix: eventPrefix(streamId),
          reverse: true,
          limit: 1,
        });
        const newestKey = rows.keys().next().value;
        if (typeof newestKey === "string") {
          const encoded = newestKey.slice(eventPrefix(streamId).length);
          const parsed = Number.parseInt(encoded, 16);
          if (Number.isSafeInteger(parsed) && parsed >= 0) sequence = parsed;
        }
      } catch {
        logStoreWarning("mcp_event_store_list_failed", {
          operation: "load_sequence",
          streamId,
        });
      }
      this.sequenceByStream.set(streamId, sequence);
    })();
    this.sequenceLoads.set(streamId, loading);
    await loading;
    this.sequenceLoads.delete(streamId);
  }

  private nextEventId(streamId: StreamId): EventId {
    const sequence = (this.sequenceByStream.get(streamId) ?? 0) + 1;
    this.sequenceByStream.set(streamId, sequence);
    return `${streamId}:${sequence.toString(16).padStart(SEQUENCE_WIDTH, "0")}`;
  }

  private async trimStream(streamId: StreamId): Promise<void> {
    const rows = await this.storage.list<JSONRPCMessage>({
      prefix: eventPrefix(streamId),
      limit: REPLAY_LIMIT,
    });
    let totalBytes = 0;
    const entries: StoredEntry[] = Array.from(rows, ([key, message]) => {
      const bytes = messageBytes(message) ?? MAX_BYTES_PER_MCP_STREAM;
      totalBytes += bytes;
      return { key, bytes };
    });
    const deleteKeys: string[] = [];

    while (
      entries.length > 1 &&
      (entries.length > MAX_EVENTS_PER_MCP_STREAM || totalBytes > MAX_BYTES_PER_MCP_STREAM)
    ) {
      const evicted = entries.shift();
      if (!evicted) break;
      deleteKeys.push(evicted.key);
      totalBytes -= evicted.bytes;
    }

    if (deleteKeys.length === 0) return;
    logStoreWarning("mcp_event_store_evicted", {
      streamId,
      evictedCount: deleteKeys.length,
      remainingCount: entries.length,
      remainingBytes: totalBytes,
    });
    for (let index = 0; index < deleteKeys.length; index += DELETE_CHUNK_SIZE) {
      await this.storage.delete(deleteKeys.slice(index, index + DELETE_CHUNK_SIZE));
    }
  }

  /** Store one event if it fits, returning its live-delivery ID in all cases. */
  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    await this.ensureSequenceLoaded(streamId);
    const eventId = this.nextEventId(streamId);
    const bytes = messageBytes(message);
    if (bytes === null || bytes > MAX_STORABLE_MCP_EVENT_BYTES) {
      logStoreWarning("mcp_event_store_skipped_oversize", {
        streamId,
        messageBytes: bytes,
        limit: MAX_STORABLE_MCP_EVENT_BYTES,
      });
      return eventId;
    }

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- storage boundary: persistence must never prevent the transport's subsequent live write
    try {
      await this.storage.put(`${EVENT_KEY_PREFIX}${eventId}`, message);
      await this.trimStream(streamId);
    } catch {
      logStoreWarning("mcp_event_store_put_failed", {
        streamId,
      });
    }
    return eventId;
  }

  /** Resolve the stream encoded into an Executor event ID. */
  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(streamIdFromEventId(eventId));
  }

  /** Replay persisted events after the supplied ID, in storage-key order. */
  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { readonly send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const streamId = streamIdFromEventId(lastEventId);
    if (!streamId) return "";
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- storage/replay boundary: a failed replay is logged and leaves the live session usable
    try {
      const rows = await this.storage.list<JSONRPCMessage>({
        prefix: eventPrefix(streamId),
        startAfter: `${EVENT_KEY_PREFIX}${lastEventId}`,
        limit: REPLAY_LIMIT,
      });
      for (const [key, message] of rows) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- client replay callback failures must not prevent later stored events from being offered
        try {
          await send(eventIdFromKey(key), message);
        } catch {}
      }
    } catch {
      logStoreWarning("mcp_event_store_list_failed", {
        operation: "replay",
        streamId,
      });
    }
    return streamId;
  }
}
