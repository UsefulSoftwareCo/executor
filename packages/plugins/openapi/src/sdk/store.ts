import { Effect, Option, Predicate, Schema } from "effect";

import {
  type PluginStorageEntry,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import { OperationBinding } from "./types";

// ---------------------------------------------------------------------------
// OpenAPI plugin store (v2). The catalog row (integration.config) owns the spec
// + auth templates; this store keeps only the per-operation invocation bindings
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
const STORE_OWNER = "org" as const;

const encodeBinding = Schema.encodeSync(OperationBinding);
const decodeBinding = Schema.decodeUnknownSync(OperationBinding);
const decodeBindingJson = Schema.decodeUnknownSync(Schema.fromJsonString(OperationBinding));

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const OperationStorage = Schema.Struct({
  integration: Schema.String,
  toolName: Schema.String,
  binding: Schema.Unknown,
});
const decodeOperationStorage = Schema.decodeUnknownOption(OperationStorage);

export interface StoredOperation {
  /** The integration slug this operation belongs to. */
  readonly integration: string;
  /** The tool name (the `<tool>` address segment) this operation backs. */
  readonly toolName: string;
  readonly binding: OperationBinding;
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
  };
};

const operationKey = (integration: string, toolName: string): string =>
  `${integration}.${toolName}`;

export interface OpenapiStore {
  /** Replace all stored operations for an integration. */
  readonly putOperations: (
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
}

export const makeDefaultOpenapiStore = ({ pluginStorage }: StorageDeps): OpenapiStore => {
  const operationData = (operation: StoredOperation) => ({
    integration: operation.integration,
    toolName: operation.toolName,
    binding: toJsonRecord(encodeBinding(operation.binding)),
  });

  const listRows = (integration: string) =>
    pluginStorage
      .list({ collection: OPERATION_COLLECTION, keyPrefix: `${integration}.` })
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

  return {
    putOperations: (integration, operations) =>
      Effect.gen(function* () {
        yield* removeOperations(integration);
        yield* pluginStorage.putMany({
          owner: STORE_OWNER,
          entries: operations.map((operation) => ({
            collection: OPERATION_COLLECTION,
            key: operationKey(integration, operation.toolName),
            data: operationData(operation),
          })),
        });
      }),

    getOperation: (integration, toolName) =>
      pluginStorage
        .get({ collection: OPERATION_COLLECTION, key: operationKey(integration, toolName) })
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperations: (integration) =>
      listRows(integration).pipe(
        Effect.map((rows) => rows.map(rowToOperation).filter(Predicate.isNotNull)),
      ),

    removeOperations,
  };
};
