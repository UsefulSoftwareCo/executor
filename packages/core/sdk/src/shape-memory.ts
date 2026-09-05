/**
 * Muscle memory for tool outputs — the persistence half of runtime shape
 * inference (see shape-inference.ts for the algorithm).
 *
 * Observed shapes live in the already-migrated `plugin_storage` table under a
 * reserved system plugin id: owner-scoped, tenant-partitioned, and untouched
 * by tool-catalog refresh (which deletes and recreates `tool` rows, so the
 * tool row itself is not a viable home). An in-memory read-through cache
 * keeps the hot path off the database: within one executor instance a tool's
 * shape is loaded at most once, and a write happens only when the merged
 * shape changed, on an observation-count milestone, or when the persisted
 * record's freshness is stale — so a stable API converges to rare
 * freshness-only writes instead of a write per call.
 *
 * Records carry the `contract` (result encoding) they were observed under:
 * a recall with a different contract returns nothing and the next
 * observation starts a fresh record, so a data-contract migration
 * invalidates stale shapes without a deletion pass. Records also expire —
 * a shape not reinforced within `EXPIRY_MS` is not served, because a
 * confidently wrong type is worse than `unknown`.
 *
 * `observe` never fails; `recall` degrades to "no memory" on any storage
 * failure.
 */

import { Clock, Effect } from "effect";

import type { Owner } from "./ids";
import type { PluginStorageFacade } from "./plugin-storage";
import { observeShape, type ObservedShape } from "./shape-inference";
import type { ToolResultEncoding } from "./tool-result-normalization";

/** Reserved system namespace inside `plugin_storage`; not a real plugin. */
export const SHAPE_MEMORY_PLUGIN_ID = "executor.shape-memory";
const COLLECTION = "observed-output-shapes";

/** A shape not reinforced for this long stops being served and restarts on
 *  the next observation. */
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
/** Persist observation-count/freshness bookkeeping at most this often when
 *  the schema itself is stable. */
const FRESHNESS_WRITE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** ... and always on these observation-count milestones. */
const OBSERVATION_WRITE_MILESTONE = 25;

/** Persisted record: ObservedShape plus the result contract it was learned
 *  under. Records written before contracts existed default to "direct". */
type StoredShape = ObservedShape & { readonly contract?: ToolResultEncoding };

export type ShapeMemory = {
  /**
   * Fold one successful tool payload into the tool's remembered shape.
   * Structure only — values never leave this call. Never fails.
   */
  readonly observe: (
    address: string,
    owner: Owner,
    contract: ToolResultEncoding,
    value: unknown,
  ) => Effect.Effect<void>;
  /** The remembered shape for an address under a contract, or null. */
  readonly recall: (
    address: string,
    owner: Owner,
    contract: ToolResultEncoding,
  ) => Effect.Effect<ObservedShape | null>;
};

export const makeShapeMemory = (storage: PluginStorageFacade): ShapeMemory => {
  const cache = new Map<string, StoredShape | null>();
  const persistedSchema = new Map<string, string>();
  const persistedAt = new Map<string, number>();

  const cacheKey = (owner: Owner, address: string) => `${owner}:${address}`;

  const storedContract = (record: StoredShape): ToolResultEncoding => record.contract ?? "direct";

  const load = (address: string, owner: Owner): Effect.Effect<StoredShape | null> =>
    Effect.gen(function* () {
      const key = cacheKey(owner, address);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const entry = yield* storage
        .getForOwner<StoredShape>({ owner, collection: COLLECTION, key: address })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const record = entry?.data ?? null;
      cache.set(key, record);
      if (record !== null) {
        persistedSchema.set(key, JSON.stringify(record.schema));
        persistedAt.set(key, record.updatedAt);
      }
      return record;
    });

  const usable = (
    record: StoredShape | null,
    contract: ToolResultEncoding,
    now: number,
  ): ObservedShape | null =>
    record !== null && storedContract(record) === contract && now - record.updatedAt <= EXPIRY_MS
      ? record
      : null;

  const observe = (
    address: string,
    owner: Owner,
    contract: ToolResultEncoding,
    value: unknown,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const key = cacheKey(owner, address);
      const stored = yield* load(address, owner);
      const now = yield* Clock.currentTimeMillis;
      // A contract mismatch or expiry means the record describes data this
      // tool no longer returns — restart rather than merge into it.
      const prior = usable(stored, contract, now);
      const next: StoredShape = { ...observeShape(prior, value, now), contract };
      cache.set(key, next);
      const schemaJson = JSON.stringify(next.schema);
      const lastWrite = persistedAt.get(key) ?? 0;
      const shouldWrite =
        persistedSchema.get(key) !== schemaJson ||
        stored === null ||
        prior === null ||
        next.observations % OBSERVATION_WRITE_MILESTONE === 0 ||
        now - lastWrite >= FRESHNESS_WRITE_INTERVAL_MS;
      if (!shouldWrite) return;
      // Advance the persisted-state bookkeeping only on a successful write:
      // otherwise a transient storage failure would silence retries for the
      // whole freshness interval while nothing is actually stored.
      const wrote = yield* storage
        .put({ owner, collection: COLLECTION, key: address, data: next })
        .pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );
      if (!wrote) return;
      persistedSchema.set(key, schemaJson);
      persistedAt.set(key, now);
    }).pipe(Effect.catchCause(() => Effect.void));

  const recall = (
    address: string,
    owner: Owner,
    contract: ToolResultEncoding,
  ): Effect.Effect<ObservedShape | null> =>
    Effect.gen(function* () {
      const stored = yield* load(address, owner);
      const now = yield* Clock.currentTimeMillis;
      return usable(stored, contract, now);
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));

  return { observe, recall };
};

/**
 * Render a remembered shape as the JSON Schema served in place of a missing
 * declared output schema. The description marks provenance so a reader (and
 * the schema view) can tell an observed shape from an author-declared one.
 */
export const observedShapeToJsonSchema = (record: ObservedShape): unknown => ({
  ...record.schema,
  description: `Observed from ${record.observations} live response${record.observations === 1 ? "" : "s"}; fields may be incomplete.`,
});
