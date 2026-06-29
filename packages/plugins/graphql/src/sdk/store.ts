import { Effect, Option, Predicate, Schema } from "effect";

import {
  type Owner,
  type PluginStorageEntry,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import { OperationBinding } from "./types";

// ---------------------------------------------------------------------------
// Per-integration operation bindings.
//
// In v2 the integration's GraphQL operations are derived from introspection and
// are identical for every connection, so the plugin store keeps one set of
// operation bindings per integration slug — `invokeTool` reads them back to
// rebuild the request. Operations are catalog-level metadata, so they live under
// the shared `owner: "org"` partition.
// ---------------------------------------------------------------------------

const CATALOG_OWNER: Owner = "org";
const OPERATION_COLLECTION = "operation";

export interface StoredOperation {
  /** The tool's leaf name, e.g. `query.hello`. */
  readonly toolName: string;
  /** The owning integration slug. */
  readonly integration: string;
  readonly binding: OperationBinding;
}

const OperationBindingFromJsonString = Schema.fromJsonString(OperationBinding);
const decodeOperationBindingFromJsonString = Schema.decodeUnknownSync(
  OperationBindingFromJsonString,
);
const decodeOperationBinding = Schema.decodeUnknownSync(OperationBinding);
const encodeBinding = Schema.encodeSync(OperationBinding);

const decodeBinding = (value: unknown): OperationBinding => {
  if (typeof value === "string") return decodeOperationBindingFromJsonString(value);
  return decodeOperationBinding(value);
};

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const OperationStorage = Schema.Struct({
  toolName: Schema.String,
  integration: Schema.String,
  binding: Schema.Unknown,
});
const decodeOperationStorage = Schema.decodeUnknownOption(OperationStorage);

const operationKey = (integration: string, toolName: string): string =>
  `${integration}.${toolName}`;

const operationData = (operation: StoredOperation) => ({
  toolName: operation.toolName,
  integration: operation.integration,
  binding: toJsonRecord(encodeBinding(operation.binding)),
});

const rowToOperation = (row: PluginStorageEntry): StoredOperation | null => {
  const decoded = decodeOperationStorage(row.data);
  if (Option.isNone(decoded)) return null;
  const operation = decoded.value;
  return {
    toolName: operation.toolName,
    integration: operation.integration,
    binding: decodeBinding(operation.binding),
  };
};

/** Blob key for an introspection snapshot's content hash. Content-addressed
 *  so re-puts are idempotent and identical schemas share one blob per
 *  partition. */
export const introspectionBlobKey = (introspectionHash: string): string =>
  `introspection/${introspectionHash}`;

export interface GraphqlStore {
  /** Replace the stored operation bindings for an integration. */
  readonly replaceOperations: (
    integration: string,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, StorageFailure>;
  readonly getOperation: (
    integration: string,
    toolName: string,
  ) => Effect.Effect<StoredOperation | null, StorageFailure>;
  readonly listOperations: (
    integration: string,
  ) => Effect.Effect<readonly StoredOperation[], StorageFailure>;
  readonly removeOperations: (integration: string) => Effect.Effect<void, StorageFailure>;
  /** Persist an introspection JSON snapshot under its content hash. Org-owned
   *  and content-addressed; never removed on integration removal because
   *  another integration in the tenant may share the hash. */
  readonly putIntrospection: (
    introspectionHash: string,
    introspectionJson: string,
  ) => Effect.Effect<void, StorageFailure>;
  /** Load an introspection snapshot by content hash; null when absent. */
  readonly getIntrospection: (
    introspectionHash: string,
  ) => Effect.Effect<string | null, StorageFailure>;
}

export const makeDefaultGraphqlStore = ({ pluginStorage, blobs }: StorageDeps): GraphqlStore => {
  const listOperationRows = (integration: string) =>
    pluginStorage
      .list({
        collection: OPERATION_COLLECTION,
        keyPrefix: `${integration}.`,
      })
      .pipe(
        Effect.map((rows) =>
          rows.filter((row) => rowToOperation(row)?.integration === integration),
        ),
      );

  const removeOperations = (integration: string) =>
    Effect.gen(function* () {
      const rows = yield* listOperationRows(integration);
      for (const row of rows) {
        yield* pluginStorage.remove({
          owner: CATALOG_OWNER,
          collection: OPERATION_COLLECTION,
          key: row.key,
        });
      }
    });

  return {
    replaceOperations: (integration, operations) =>
      Effect.gen(function* () {
        yield* removeOperations(integration);
        for (const operation of operations) {
          yield* pluginStorage.put({
            owner: CATALOG_OWNER,
            collection: OPERATION_COLLECTION,
            key: operationKey(integration, operation.toolName),
            data: operationData(operation),
          });
        }
      }),

    getOperation: (integration, toolName) =>
      pluginStorage
        .get({ collection: OPERATION_COLLECTION, key: operationKey(integration, toolName) })
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperations: (integration) =>
      listOperationRows(integration).pipe(
        Effect.map((rows) => rows.map(rowToOperation).filter(Predicate.isNotNull)),
      ),

    removeOperations,

    putIntrospection: (introspectionHash, introspectionJson) =>
      blobs.put(introspectionBlobKey(introspectionHash), introspectionJson, {
        owner: CATALOG_OWNER,
      }),

    getIntrospection: (introspectionHash) => blobs.get(introspectionBlobKey(introspectionHash)),
  };
};
