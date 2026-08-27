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
import { observeShape, type InferredShape, type ObservedShape } from "./shape-inference";

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

// ---------------------------------------------------------------------------
// Placeholder slots — partial serving inside a DECLARED schema.
//
// Some plugins must declare an output schema even when the upstream said
// nothing about the payload: the MCP plugin's CallToolResult envelope is
// genuinely declared (content blocks, isError), but its `structuredContent`
// slot is a synthesized "some object" placeholder whenever the server
// declared no output schema. A plugin marks such a slot with
// `SHAPE_SLOT_KEY: true` (typically at projection time), and serving splices
// the observed shape's counterpart into exactly that slot, keeping the
// declared structure around it.
// ---------------------------------------------------------------------------

/** Vendor-extension marker a plugin puts on a placeholder subschema. */
export const SHAPE_SLOT_KEY = "x-executor-shape-slot";

const OBSERVED_SLOT_DESCRIPTION = "Observed from live responses; fields may be incomplete.";

/** Slot scanning/splicing depth bound — marked slots live near the root. */
const MAX_SLOT_DEPTH = 8;

type SchemaNode = Record<string, unknown>;

const isSchemaNode = (value: unknown): value is SchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasShapeSlots = (schema: unknown, depth = 0): boolean => {
  if (!isSchemaNode(schema) || depth >= MAX_SLOT_DEPTH) return false;
  if (schema[SHAPE_SLOT_KEY] === true) return true;
  const properties = schema["properties"];
  if (
    isSchemaNode(properties) &&
    Object.values(properties).some((child) => hasShapeSlots(child, depth + 1))
  ) {
    return true;
  }
  return hasShapeSlots(schema["items"], depth + 1);
};

const isInformativeShape = (shape: InferredShape): boolean =>
  shape.type !== undefined || shape.anyOf !== undefined;

/**
 * Replace marked placeholder slots in a declared schema with the observed
 * shape's counterpart at the same path (descending `properties` by name and
 * `items`). Slots with no informative observed counterpart keep their
 * declared placeholder; markers are stripped either way so they never reach
 * schema consumers. `filled` reports how many slots actually got a shape.
 */
export const spliceObservedSlots = (
  declared: unknown,
  observed: InferredShape | null,
): { readonly schema: unknown; readonly filled: number } => {
  let filled = 0;
  const walk = (node: unknown, shape: InferredShape | null, depth: number): unknown => {
    if (!isSchemaNode(node) || depth >= MAX_SLOT_DEPTH) return node;
    if (node[SHAPE_SLOT_KEY] === true) {
      const { [SHAPE_SLOT_KEY]: _slot, ...placeholder } = node;
      if (shape !== null && isInformativeShape(shape)) {
        filled += 1;
        return { ...shape, description: OBSERVED_SLOT_DESCRIPTION };
      }
      return placeholder;
    }
    let next: SchemaNode = node;
    const properties = node["properties"];
    if (isSchemaNode(properties)) {
      const walkedProperties: Record<string, unknown> = {};
      let changed = false;
      for (const [key, child] of Object.entries(properties)) {
        const counterpart = shape?.type === "object" ? (shape.properties?.[key] ?? null) : null;
        const walked = walk(child, counterpart, depth + 1);
        walkedProperties[key] = walked;
        if (walked !== child) changed = true;
      }
      if (changed) next = { ...next, properties: walkedProperties };
    }
    const items = node["items"];
    if (items !== undefined) {
      const counterpart = shape?.type === "array" ? (shape.items ?? null) : null;
      const walked = walk(items, counterpart, depth + 1);
      if (walked !== items) next = { ...next, items: walked };
    }
    return next;
  };
  const schema = walk(declared, observed, 0);
  return { schema, filled };
};
