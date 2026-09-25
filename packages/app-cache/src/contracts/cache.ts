/** Serializable cache protocol. Hosts bind the application and build namespace separately. */
import { Schema, type Effect } from "effect";

/** Expected cache failures never include keys, values or upstream exception text. */
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  reason: Schema.Literals(["unavailable", "storage", "invalid", "capacity", "timeout"]),
}) {}

/** Bounded defaults shared by loaders and persistent adapters. */
export const cacheLimits = {
  keyBytes: 8_192,
  entryBytes: 2_000_000,
  batchBytes: 8_000_000,
  batchEntries: 128,
  totalBytes: 128_000_000,
  totalEntries: 100_000,
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  loadTimeoutMs: 90_000,
  leaseMs: 120_000,
} as const;

const Key = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
/** Stored values carry a version independent of their freshness clock. */
export const CacheEntry = Schema.Struct({
  value: Schema.Json,
  version: Schema.String,
  freshUntil: Time,
  staleUntil: Time,
});
/** Decoded cache value envelope. */
export type CacheEntry = typeof CacheEntry.Type;

/** Publication requires the lease acquired against the previously observed version. */
export const CacheCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("read"), keys: Schema.Array(Key) }),
  Schema.Struct({
    operation: Schema.Literal("claim"),
    key: Key,
    version: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    operation: Schema.Literal("publish"),
    key: Key,
    lease: Schema.String,
    entry: CacheEntry,
  }),
  Schema.Struct({ operation: Schema.Literal("release"), key: Key, lease: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("write"),
    entries: Schema.Array(Schema.Struct({ key: Key, entry: CacheEntry })),
  }),
  Schema.Struct({ operation: Schema.Literal("invalidate"), key: Key }),
]);
/** Parsed host command; namespaces cannot be selected by app code. */
export type CacheCommand = typeof CacheCommand.Type;
/** Replies remain JSON across Worker RPC and are decoded by each caller. */
export type CacheTransport = (command: CacheCommand) => Effect.Effect<Schema.Json, CacheError>;

/** Safe protocol envelope used at process boundaries. */
export const CacheReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: CacheError }),
]);
