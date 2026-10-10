/** Serializable cache protocol. Hosts bind the application and build namespace separately. */
import { Option, Schema, type Effect } from "effect";

/** Expected cache failures never include keys, values or upstream exception text. */
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  reason: Schema.Literals(["unavailable", "storage", "invalid", "capacity", "timeout"]),
  /** Which of `cacheLimits` the request exceeded, when one did. */
  limit: Schema.optionalKey(
    Schema.Literals([
      "keyBytes",
      "entryBytes",
      "batchBytes",
      "batchEntries",
      "totalBytes",
      "totalEntries",
    ]),
  ),
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
  /**
   * A loader's lease lapses this long after its host last renewed it. Hosts renew every
   * `renewMs` while the invocation that claimed it runs, so a stalled or lost holder frees the
   * key well inside an MCP execute budget.
   */
  leaseMs: 15_000,
  renewMs: 5_000,
  /** The longest a caller waits on another loader before loading for itself without publishing. */
  waitMs: 10_000,
  /** Bound for one command to a host store; a lost reply fails instead of holding its caller. */
  commandTimeoutMs: 10_000,
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
/** The current entry, and a lease when this caller now owns its load. */
export const CacheAcquired = Schema.Struct({
  entry: Schema.NullOr(CacheEntry),
  lease: Schema.NullOr(Schema.String),
});

/**
 * Publication requires the lease acquired against the previously observed version.
 * `acquire` reads one entry and claims its load in the same transaction, so a cache
 * miss costs one round trip. `read` and `claim` remain for builds retained before it.
 */
export const CacheCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("read"), keys: Schema.Array(Key) }),
  Schema.Struct({
    operation: Schema.Literal("acquire"),
    key: Key,
    /** Claim even a fresh entry, as an explicit refresh does. */
    refresh: Schema.Boolean,
    /** Claim only while the entry still has this version. Absent accepts the current one. */
    version: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
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
  /** Extend a lease its holder still owns. Replies false once the lease lapsed or was replaced. */
  Schema.Struct({ operation: Schema.Literal("renew"), key: Key, lease: Schema.String }),
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

/**
 * Whether a command replaced or removed retained data: a published refresh, a direct write or an
 * invalidation. Hosts report these so results evaluated from the earlier data are not reused.
 */
export const changesCache = (command: unknown) => {
  const operation = Schema.decodeUnknownOption(CacheCommand)(command);
  return (
    Option.isSome(operation) &&
    (operation.value.operation === "publish" ||
      operation.value.operation === "write" ||
      operation.value.operation === "invalidate")
  );
};

/** Safe protocol envelope used at process boundaries. */
export const CacheReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: CacheError }),
]);
