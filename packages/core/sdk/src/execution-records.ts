// ---------------------------------------------------------------------------
// ExecutionRecordStore — durable "this execution existed" tombstones.
//
// A paused execution normally lives as a suspended fiber inside one engine
// instance (see the header comment in pending-approval.ts for the same
// constraint). When the daemon restarts (launchd KeepAlive makes this
// routine on the local install), every fiber is gone: `executor resume` for
// a pre-restart execution reads as "not found", silently discarding work the
// agent believes is still pending. Tombstones close that gap WITHOUT fiber
// serialization: each execution writes a lightweight record (id, status,
// updatedAt — no args, no results, no secrets) at start/pause/complete, and
// a boot sweep marks every non-terminal record `interrupted`. Resume of an
// interrupted execution is an explicit, honest outcome — "re-trigger the
// action" — never a silent NotFound and never a silent re-run.
//
// Records live in the existing owner-scoped `blob` table under a fixed
// namespace suffix, exactly like pending-approval records, so the partition
// IS the ownership check: another caller's executor reads a different
// namespace and simply does not see the record.
//
// Sweep enumerability: BlobStore has no list operation, and the old
// process's in-memory execution registry is unrecoverable at boot — so the
// store keeps its OWN index of live (running|paused) ids in a second
// namespace, updated on every put and consumed by the sweep. This is what
// makes `sweepInterrupted` honest: it reads the live set, marks each id
// interrupted, and clears the set.
// ---------------------------------------------------------------------------

import { Effect, Option, Schema } from "effect";

import type { BlobStore } from "./blob";
import type { StorageError } from "./fuma-runtime";

/** Lifecycle states persisted in the tombstone. */
// Schema.Literals (array form) — in effect@4.0.0-beta.59 the multi-arg
// Schema.Literal("a","b",...) decodes ONLY its first member; the array form
// decodes the full set. The repo's resume endpoint uses the same array form.
export const ExecutionRecordStatus = Schema.Literals([
  "running",
  "paused",
  "interrupted",
  "completed",
]);
export type ExecutionRecordStatus = typeof ExecutionRecordStatus.Type;

/**
 * The durable record for one execution.
 *
 * Deliberately minimal: id + status + updatedAt only. Arguments, results,
 * and secrets never touch the tombstone (spec: no secret leakage).
 */
export const ExecutionRecord = Schema.Struct({
  executionId: Schema.String,
  status: ExecutionRecordStatus,
  /** Epoch ms of the last lifecycle transition. */
  updatedAt: Schema.Number,
});
export type ExecutionRecord = typeof ExecutionRecord.Type;

// Encode is plain JSON.stringify (repo convention, shape-memory.ts): the
// record type is already narrow at the call sites. Decode validates the
// parsed value against the schema — corrupt JSON reads as absent.
const encodeExecutionRecord = (record: ExecutionRecord): string => JSON.stringify(record);
const decodeRecordValue = Schema.decodeUnknownOption(ExecutionRecord);
// oxlint-disable executor/no-try-catch-or-throw,executor/no-json-parse -- boundary: untrusted persisted blob text; a corrupt record reads as absent (never surfaced), so a fallible parse collapsing to none is the contract
const decodeExecutionRecord = (raw: string): Option.Option<ExecutionRecord> => {
  try {
    return decodeRecordValue(JSON.parse(raw));
  } catch {
    return Option.none();
  }
};
// oxlint-enable executor/no-try-catch-or-throw,executor/no-json-parse

// The live-id index: a JSON array of executionIds currently running|paused,
// stored under a single fixed key. Concurrency: blob writes are serialized by
// the storage adapter; a put is read-modify-write on this array. The boot
// sweep runs while no new executions can start (the daemon has not yet
// accepted work), so the read-modify-write is uncontended in practice.
const LIVE_INDEX_KEY = "live";
const encodeLiveIds = (ids: readonly string[]): string => JSON.stringify(ids);
// oxlint-disable executor/no-try-catch-or-throw,executor/no-json-parse -- boundary: untrusted persisted index text; a corrupt index reads as empty (sweep finds nothing), so a fallible parse collapsing to [] is the contract
const decodeLiveIds = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
// oxlint-enable executor/no-try-catch-or-throw,executor/no-json-parse

/**
 * Durable store for execution tombstones, scoped to one owner partition.
 *
 * `get` is a strict read: an unparseable record reads as absent (corrupt
 * records are treated as gone, never surfaced). `sweepInterrupted` marks
 * every non-terminal record `interrupted` in one pass and reports how many
 * were swept — `completed` is immutable.
 */
export interface ExecutionRecordStore {
  readonly put: (record: ExecutionRecord) => Effect.Effect<void, StorageError>;
  readonly get: (executionId: string) => Effect.Effect<ExecutionRecord | null, StorageError>;
  /** Mark every non-terminal record `interrupted`; returns the count swept. */
  readonly sweepInterrupted: () => Effect.Effect<{ readonly interrupted: number }, StorageError>;
}

/**
 * Bind a `BlobStore` to one owner partition as an execution-record store.
 *
 * The namespace is the owner partition plus a fixed suffix, matching how
 * plugin blobs namespace themselves — the same-query ownership rule the
 * pending-approval store uses.
 */
export const makeExecutionRecordStore = (
  blobs: BlobStore,
  partition: string,
  now: () => number = Date.now,
): ExecutionRecordStore => {
  const namespace = `${partition}/@execution-records`;
  const liveNamespace = `${partition}/@execution-records-live`;

  /** Add or remove an id from the live index. */
  const updateLiveIndex = (executionId: string, add: boolean) =>
    Effect.gen(function* () {
      const raw = yield* blobs.get(liveNamespace, LIVE_INDEX_KEY);
      const live = decodeLiveIds(raw ?? "[]");
      const next = add
        ? live.includes(executionId)
          ? live
          : [...live, executionId]
        : live.filter((id) => id !== executionId);
      yield* blobs.put(liveNamespace, LIVE_INDEX_KEY, encodeLiveIds(next));
    });

  return {
    put: (record) =>
      Effect.gen(function* () {
        yield* blobs.put(namespace, record.executionId, encodeExecutionRecord(record));
        // Maintain the live index: running|paused ids are enumerated by the
        // sweep; terminal ids leave the index (their records remain for
        // get()).
        if (record.status === "running" || record.status === "paused") {
          yield* updateLiveIndex(record.executionId, true);
        } else {
          yield* updateLiveIndex(record.executionId, false);
        }
      }),

    get: (executionId) =>
      Effect.gen(function* () {
        const raw = yield* blobs.get(namespace, executionId);
        if (raw === null) return null;
        const decoded = decodeExecutionRecord(raw);
        if (Option.isNone(decoded)) return null;
        return decoded.value;
      }),

    sweepInterrupted: () =>
      Effect.gen(function* () {
        const raw = yield* blobs.get(liveNamespace, LIVE_INDEX_KEY);
        const live = decodeLiveIds(raw ?? "[]");
        let interrupted = 0;
        for (const executionId of live) {
          const recordRaw = yield* blobs.get(namespace, executionId);
          if (recordRaw === null) continue;
          const decoded = decodeExecutionRecord(recordRaw);
          if (Option.isSome(decoded)) {
            const record = decoded.value;
            if (record.status === "running" || record.status === "paused") {
              yield* blobs.put(
                namespace,
                executionId,
                encodeExecutionRecord({ ...record, status: "interrupted", updatedAt: now() }),
              );
              interrupted += 1;
            }
          }
        }
        // The live index is consumed by the sweep; nothing is live anymore
        // from the previous process's perspective. New executions repopulate
        // it on their first put.
        yield* blobs.put(liveNamespace, LIVE_INDEX_KEY, encodeLiveIds([]));
        return { interrupted };
      }),
  };
};
