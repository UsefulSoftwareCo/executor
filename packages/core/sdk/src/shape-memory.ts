/**
 * Muscle memory for tool outputs — the persistence half of runtime shape
 * inference (see shape-inference.ts for the algorithm).
 *
 * Observed shapes live in the already-migrated `plugin_storage` table under a
 * reserved system plugin id: owner-scoped, tenant-partitioned, and untouched
 * by tool-catalog refresh (which deletes and recreates `tool` rows, so the
 * tool row itself is not a viable home). An in-memory read-through cache
 * keeps the hot path off the database: within one executor instance a tool's
 * shape is loaded at most once, and a write happens only when a new
 * observation actually changes the merged shape — after a few calls a stable
 * API stops producing writes entirely.
 *
 * `observe` never fails and is intended to be forked off the dispatch path;
 * `recall` degrades to "no memory" on any storage failure.
 */

import { Clock, Effect } from "effect";

import type { Owner } from "./ids";
import type { PluginStorageFacade } from "./plugin-storage";
import { observeShape, type ObservedShape } from "./shape-inference";

/** Reserved system namespace inside `plugin_storage`; not a real plugin. */
export const SHAPE_MEMORY_PLUGIN_ID = "executor.shape-memory";
const COLLECTION = "observed-output-shapes";

export type ShapeMemory = {
  /**
   * Fold one successful tool payload into the tool's remembered shape.
   * Structure only — values never leave this call. Never fails.
   */
  readonly observe: (address: string, owner: Owner, value: unknown) => Effect.Effect<void>;
  /** The remembered shape for an address, or null when nothing is known. */
  readonly recall: (address: string, owner: Owner) => Effect.Effect<ObservedShape | null>;
};

export const makeShapeMemory = (storage: PluginStorageFacade): ShapeMemory => {
  const cache = new Map<string, ObservedShape | null>();
  const persisted = new Map<string, string>();

  const cacheKey = (owner: Owner, address: string) => `${owner}:${address}`;

  const load = (address: string, owner: Owner): Effect.Effect<ObservedShape | null> =>
    Effect.gen(function* () {
      const key = cacheKey(owner, address);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const entry = yield* storage
        .getForOwner<ObservedShape>({ owner, collection: COLLECTION, key: address })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const record = entry?.data ?? null;
      cache.set(key, record);
      if (record !== null) persisted.set(key, JSON.stringify(record.schema));
      return record;
    });

  const observe = (address: string, owner: Owner, value: unknown): Effect.Effect<void> =>
    Effect.gen(function* () {
      const key = cacheKey(owner, address);
      const prior = yield* load(address, owner);
      const now = yield* Clock.currentTimeMillis;
      const next = observeShape(prior, value, now);
      cache.set(key, next);
      // Write only when the merged shape actually changed — observation
      // counters alone are bookkeeping, not worth a row write per call.
      const schemaJson = JSON.stringify(next.schema);
      if (persisted.get(key) === schemaJson) return;
      yield* storage
        .put({ owner, collection: COLLECTION, key: address, data: next })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      persisted.set(key, schemaJson);
    }).pipe(Effect.catchCause(() => Effect.void));

  return {
    observe,
    recall: (address, owner) =>
      load(address, owner).pipe(Effect.catchCause(() => Effect.succeed(null))),
  };
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
