import { Effect, Option, Predicate, Schema } from "effect";

import {
  type PluginStorageEntry,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import { OperationBinding } from "./types";

// ---------------------------------------------------------------------------
// OpenAPI plugin store (v2). The catalog row (integration.config) owns the
// auth templates plus the spec's content hash; the resolved spec text itself
// lives in the plugin blob store under `spec/<hash>` (it's multi-MB and only
// a build input). This store keeps the per-operation invocation bindings
// (method / path / params), keyed by integration slug, so `invokeTool` can map
// a tool name back to its HTTP operation without re-parsing the spec on every
// call. There are NO credential bindings, slots, or StoredSource credential
// config here — those concepts are gone in v2.
//
// Operations are spec-derived (identical for every connection on an
// integration), so they live under the org owner (the integration catalog is
// tenant-level). The plugin storage facade partitions by owner; "org" keeps a
// single shared copy per integration.
// ---------------------------------------------------------------------------

const OPERATION_COLLECTION = "operation";
const SPEC_SOURCE_COLLECTION = "spec_source";
const STORE_OWNER = "org" as const;
const OPERATION_KEY_VERSION = "op";
const SPEC_SOURCE_KEY_VERSION = "src";

const encodeBinding = Schema.encodeSync(OperationBinding);
const decodeBinding = Schema.decodeUnknownSync(OperationBinding);
const decodeBindingJson = Schema.decodeUnknownSync(Schema.fromJsonString(OperationBinding));

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const OperationStorage = Schema.Struct({
  integration: Schema.String,
  toolName: Schema.String,
  binding: Schema.Unknown,
  // Resolved tool description (operation description / summary / method+path
  // fallback), persisted so the serve path can rebuild the tool def without
  // re-parsing the spec. Optional: legacy rows predate it and resolve via the
  // parse fallback.
  description: Schema.optional(Schema.String),
});
const decodeOperationStorage = Schema.decodeUnknownOption(OperationStorage);

export interface StoredOperation {
  /** The integration slug this operation belongs to. */
  readonly integration: string;
  /** The tool name (the `<tool>` address segment) this operation backs. */
  readonly toolName: string;
  readonly binding: OperationBinding;
  /** Resolved tool description, persisted alongside the binding so the serve
   *  path can rebuild the tool def without re-parsing the spec. */
  readonly description?: string;
}

const rowToOperation = (row: PluginStorageEntry): StoredOperation | null => {
  const decoded = decodeOperationStorage(row.data);
  if (Option.isNone(decoded)) return null;
  const operation = decoded.value;
  return {
    integration: operation.integration,
    toolName: operation.toolName,
    binding: decodeBinding(
      typeof operation.binding === "string"
        ? decodeBindingJson(operation.binding)
        : operation.binding,
    ),
    ...(operation.description !== undefined ? { description: operation.description } : {}),
  };
};

const stableKeyHash = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(36).padStart(13, "0");
};

const operationKey = (integration: string, toolName: string): string =>
  `${OPERATION_KEY_VERSION}.${stableKeyHash(integration)}.${stableKeyHash(toolName)}`;

const specSourceKey = (url: string): string => `${SPEC_SOURCE_KEY_VERSION}.${stableKeyHash(url)}`;

// What we remember about the last successful fetch of a spec URL: the content
// hash it resolved to (the blob address) plus the response's cache validators.
// `url` is stored in the row too so a key-hash collision can't serve another
// URL's spec.
const SpecSourceStorage = Schema.Struct({
  url: Schema.String,
  specHash: Schema.String,
  etag: Schema.optional(Schema.String),
  lastModified: Schema.optional(Schema.String),
  fetchedAt: Schema.Number,
});
const decodeSpecSourceStorage = Schema.decodeUnknownOption(SpecSourceStorage);

export interface SpecSourceEntry {
  /** The spec URL this entry describes. */
  readonly url: string;
  /** Content hash the URL last resolved to — the `spec/<hash>` blob address. */
  readonly specHash: string;
  /** Response `ETag`, replayed as `If-None-Match` on refresh. */
  readonly etag?: string;
  /** Response `Last-Modified`, replayed as `If-Modified-Since` on refresh. */
  readonly lastModified?: string;
  /** Epoch millis of the last fetch that produced (or revalidated) the entry. */
  readonly fetchedAt: number;
}

const legacyOperationKey = (integration: string, toolName: string): string =>
  `${integration}.${toolName}`;

/** Blob key for a spec's content hash. Content-addressed so re-puts are
 *  idempotent and identical specs share one blob per partition. */
export const specBlobKey = (specHash: string): string => `spec/${specHash}`;

/** Blob key for a spec's compiled `#/$defs/*` schemas, keyed by the same
 *  content hash as the spec. The serve path reads this instead of re-parsing
 *  the (potentially multi-MB) spec to rebuild the shared `definitions`. */
export const defsBlobKey = (specHash: string): string => `defs/${specHash}`;

export interface OpenapiStore {
  /** Replace all stored operations for an integration. */
  readonly putOperations: (
    integration: string,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, StorageFailure>;
  /** Append operations without clearing existing ones. The caller is
   *  responsible for `removeOperations` first when doing a full rebuild. Used
   *  by the streaming compile path, which persists operations chunk by chunk so
   *  a huge spec's bindings are never all materialized at once. */
  readonly appendOperations: (
    integration: string,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, StorageFailure>;
  /** Look up one operation by integration + tool name. */
  readonly getOperation: (
    integration: string,
    toolName: string,
  ) => Effect.Effect<StoredOperation | null, StorageFailure>;
  /** List every stored operation for an integration. */
  readonly listOperations: (
    integration: string,
  ) => Effect.Effect<readonly StoredOperation[], StorageFailure>;
  /** Drop all stored operations for an integration. */
  readonly removeOperations: (integration: string) => Effect.Effect<void, StorageFailure>;
  /** Persist resolved spec text under its content hash. Org-owned and
   *  content-addressed; never removed on integration removal because another
   *  integration in the tenant may share the hash. */
  readonly putSpec: (specHash: string, specText: string) => Effect.Effect<void, StorageFailure>;
  /** Load spec text by content hash; null when no blob exists. */
  readonly getSpec: (specHash: string) => Effect.Effect<string | null, StorageFailure>;
  /** Persist the compiled `#/$defs/*` JSON for a spec under its content hash.
   *  Content-addressed like the spec blob; lets the serve path serve the shared
   *  `definitions` without re-parsing the spec. */
  readonly putDefs: (specHash: string, defsJson: string) => Effect.Effect<void, StorageFailure>;
  /** Load the compiled `#/$defs/*` JSON by content hash; null when no blob
   *  exists (legacy rows added before the defs blob). */
  readonly getDefs: (specHash: string) => Effect.Effect<string | null, StorageFailure>;
  /** Look up what a spec URL last resolved to (content hash + cache
   *  validators). Null when the URL was never fetched (or the row predates the
   *  index). Org-owned like the spec blob: the fetch is unauthenticated, so the
   *  result is shareable tenant-wide. */
  readonly getSpecSource: (url: string) => Effect.Effect<SpecSourceEntry | null, StorageFailure>;
  /** Record a successful fetch (or revalidation) of a spec URL. */
  readonly putSpecSource: (entry: SpecSourceEntry) => Effect.Effect<void, StorageFailure>;
}

export const makeDefaultOpenapiStore = ({ pluginStorage, blobs }: StorageDeps): OpenapiStore => {
  const operationData = (operation: StoredOperation) => ({
    integration: operation.integration,
    toolName: operation.toolName,
    binding: toJsonRecord(encodeBinding(operation.binding)),
    ...(operation.description !== undefined ? { description: operation.description } : {}),
  });

  const listRows = (integration: string) =>
    pluginStorage
      .list({ collection: OPERATION_COLLECTION })
      .pipe(
        Effect.map((rows: readonly PluginStorageEntry[]) =>
          rows.filter((row) => rowToOperation(row)?.integration === integration),
        ),
      );

  const removeOperations = (integration: string) =>
    Effect.gen(function* () {
      const rows = yield* listRows(integration);
      yield* pluginStorage.removeMany({
        owner: STORE_OWNER,
        entries: rows.map((row) => ({ collection: OPERATION_COLLECTION, key: row.key })),
      });
    });

  const appendOperations = (integration: string, operations: readonly StoredOperation[]) =>
    pluginStorage.putMany({
      owner: STORE_OWNER,
      entries: operations.map((operation) => ({
        collection: OPERATION_COLLECTION,
        key: operationKey(integration, operation.toolName),
        data: operationData(operation),
      })),
    });

  return {
    putOperations: (integration, operations) =>
      Effect.gen(function* () {
        yield* removeOperations(integration);
        yield* appendOperations(integration, operations);
      }),

    appendOperations,

    getOperation: (integration, toolName) =>
      Effect.gen(function* () {
        const row = yield* pluginStorage.get({
          collection: OPERATION_COLLECTION,
          key: operationKey(integration, toolName),
        });
        if (row) return rowToOperation(row);
        const legacyKey = legacyOperationKey(integration, toolName);
        if (legacyKey.length > 255) return null;
        const legacyRow = yield* pluginStorage.get({
          collection: OPERATION_COLLECTION,
          key: legacyKey,
        });
        return legacyRow ? rowToOperation(legacyRow) : null;
      }),

    listOperations: (integration) =>
      listRows(integration).pipe(
        Effect.map((rows) => rows.map(rowToOperation).filter(Predicate.isNotNull)),
      ),

    removeOperations,

    putSpec: (specHash, specText) =>
      blobs.put(specBlobKey(specHash), specText, { owner: STORE_OWNER }),

    getSpec: (specHash) => blobs.get(specBlobKey(specHash)),

    putDefs: (specHash, defsJson) =>
      blobs.put(defsBlobKey(specHash), defsJson, { owner: STORE_OWNER }),

    getDefs: (specHash) => blobs.get(defsBlobKey(specHash)),

    getSpecSource: (url) =>
      Effect.gen(function* () {
        const row = yield* pluginStorage.get({
          collection: SPEC_SOURCE_COLLECTION,
          key: specSourceKey(url),
        });
        if (!row) return null;
        const decoded = decodeSpecSourceStorage(row.data);
        if (Option.isNone(decoded)) return null;
        // Guard against a stableKeyHash collision serving another URL's spec.
        if (decoded.value.url !== url) return null;
        return decoded.value;
      }),

    putSpecSource: (entry) =>
      pluginStorage
        .put({
          owner: STORE_OWNER,
          collection: SPEC_SOURCE_COLLECTION,
          key: specSourceKey(entry.url),
          data: {
            url: entry.url,
            specHash: entry.specHash,
            ...(entry.etag !== undefined ? { etag: entry.etag } : {}),
            ...(entry.lastModified !== undefined ? { lastModified: entry.lastModified } : {}),
            fetchedAt: entry.fetchedAt,
          },
        })
        .pipe(Effect.asVoid),
  };
};
