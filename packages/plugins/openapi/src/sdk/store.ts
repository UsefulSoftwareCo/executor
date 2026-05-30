import { Effect, Option, Predicate, Schema } from "effect";

import {
  type PluginStorageEntry,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import {
  ConfiguredHeaderBinding,
  OAuth2SourceConfig,
  OperationBinding,
  type ConfiguredHeaderValue,
} from "./types";
export {
  StoredSourceSchema,
  type StoredSourceSchemaType,
  headerBindingSlot,
  oauth2ClientIdSlot,
  oauth2ClientSecretSlot,
  oauth2ConnectionSlot,
  queryParamBindingSlot,
} from "./source-contracts";

export interface SourceConfig {
  readonly spec: string;
  readonly sourceUrl?: string;
  readonly googleDiscoveryUrls?: readonly string[];
  readonly baseUrl?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, ConfiguredHeaderValue>;
  readonly queryParams?: Record<string, ConfiguredHeaderValue>;
  readonly specFetchCredentials?: OpenApiSpecFetchCredentials;
  readonly oauth2?: OAuth2SourceConfig;
}

export interface OpenApiSpecFetchCredentials {
  readonly headers?: Record<string, ConfiguredHeaderValue>;
  readonly queryParams?: Record<string, ConfiguredHeaderValue>;
}

export interface StoredSource {
  readonly namespace: string;
  readonly scope: string;
  readonly name: string;
  readonly config: SourceConfig;
}

export interface StoredOperation {
  readonly toolId: string;
  readonly sourceId: string;
  readonly binding: OperationBinding;
}

const SOURCE_COLLECTION = "source";
const OPERATION_COLLECTION = "operation";

const encodeBinding = Schema.encodeSync(OperationBinding);
const decodeBinding = Schema.decodeUnknownSync(OperationBinding);
const decodeBindingJson = Schema.decodeUnknownSync(Schema.fromJsonString(OperationBinding));

const decodeOAuth2SourceConfigOption = Schema.decodeUnknownOption(OAuth2SourceConfig);
const decodeOAuth2SourceConfigJsonOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(OAuth2SourceConfig),
);
const encodeOAuth2SourceConfig = Schema.encodeSync(OAuth2SourceConfig);

const NullableString = Schema.NullOr(Schema.String);
const OptionalNullableString = Schema.optional(NullableString);
const ConfiguredHeaderBindingStorage = Schema.Struct({
  kind: Schema.Literal("binding"),
  slot: Schema.String,
  prefix: OptionalNullableString,
});
const ConfiguredHeaderValueStorage = Schema.Union([Schema.String, ConfiguredHeaderBindingStorage]);
const ConfiguredHeaderMapStorage = Schema.Record(Schema.String, ConfiguredHeaderValueStorage);
const SpecFetchCredentialsStorage = Schema.Struct({
  headers: Schema.optional(ConfiguredHeaderMapStorage),
  queryParams: Schema.optional(ConfiguredHeaderMapStorage),
});
const SourceConfigStorage = Schema.Struct({
  spec: Schema.String,
  sourceUrl: Schema.optional(Schema.String),
  googleDiscoveryUrls: Schema.optional(Schema.Array(Schema.String)),
  baseUrl: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(ConfiguredHeaderMapStorage),
  queryParams: Schema.optional(ConfiguredHeaderMapStorage),
  specFetchCredentials: Schema.optional(SpecFetchCredentialsStorage),
  oauth2: Schema.optional(Schema.Unknown),
});
const SourceStorage = Schema.Struct({
  namespace: Schema.String,
  scope: Schema.String,
  name: Schema.String,
  config: SourceConfigStorage,
});
const OperationStorage = Schema.Struct({
  toolId: Schema.String,
  sourceId: Schema.String,
  binding: Schema.Unknown,
});
const decodeSourceStorage = Schema.decodeUnknownOption(SourceStorage);
const decodeOperationStorage = Schema.decodeUnknownOption(OperationStorage);

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const normalizeStoredOAuth2 = (value: unknown): OAuth2SourceConfig | undefined => {
  if (value == null) return undefined;
  const sourceConfig =
    typeof value === "string"
      ? decodeOAuth2SourceConfigJsonOption(value)
      : decodeOAuth2SourceConfigOption(value);
  if (Option.isSome(sourceConfig)) return sourceConfig.value;
  return undefined;
};

const normalizeConfiguredMap = (
  values: Readonly<Record<string, typeof ConfiguredHeaderValueStorage.Type>> | undefined,
): Record<string, ConfiguredHeaderValue> | undefined => {
  if (!values) return undefined;
  const normalized: Record<string, ConfiguredHeaderValue> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") {
      normalized[name] = value;
    } else {
      normalized[name] =
        value.prefix != null
          ? ConfiguredHeaderBinding.make({
              kind: "binding",
              slot: value.slot,
              prefix: value.prefix,
            })
          : ConfiguredHeaderBinding.make({
              kind: "binding",
              slot: value.slot,
            });
    }
  }
  return normalized;
};

const encodeSourceConfig = (config: SourceConfig): Record<string, unknown> => ({
  spec: config.spec,
  ...(config.sourceUrl ? { sourceUrl: config.sourceUrl } : {}),
  ...(config.googleDiscoveryUrls ? { googleDiscoveryUrls: config.googleDiscoveryUrls } : {}),
  ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  ...(config.namespace ? { namespace: config.namespace } : {}),
  ...(config.headers ? { headers: config.headers } : {}),
  ...(config.queryParams ? { queryParams: config.queryParams } : {}),
  ...(config.specFetchCredentials ? { specFetchCredentials: config.specFetchCredentials } : {}),
  ...(config.oauth2 ? { oauth2: toJsonRecord(encodeOAuth2SourceConfig(config.oauth2)) } : {}),
});

const rowToSource = (row: PluginStorageEntry): StoredSource | null => {
  const decoded = decodeSourceStorage(row.data);
  if (Option.isNone(decoded)) return null;
  const stored = decoded.value;
  const oauth2 = normalizeStoredOAuth2(stored.config.oauth2);
  return {
    namespace: stored.namespace,
    scope: stored.scope,
    name: stored.name,
    config: {
      spec: stored.config.spec,
      sourceUrl: stored.config.sourceUrl,
      googleDiscoveryUrls: stored.config.googleDiscoveryUrls,
      baseUrl: stored.config.baseUrl,
      namespace: stored.config.namespace,
      headers: normalizeConfiguredMap(stored.config.headers),
      queryParams: normalizeConfiguredMap(stored.config.queryParams),
      specFetchCredentials: stored.config.specFetchCredentials
        ? {
            headers: normalizeConfiguredMap(stored.config.specFetchCredentials.headers),
            queryParams: normalizeConfiguredMap(stored.config.specFetchCredentials.queryParams),
          }
        : undefined,
      oauth2,
    },
  };
};

const rowToOperation = (row: PluginStorageEntry): StoredOperation | null => {
  const decoded = decodeOperationStorage(row.data);
  if (Option.isNone(decoded)) return null;
  const operation = decoded.value;
  return {
    toolId: operation.toolId,
    sourceId: operation.sourceId,
    binding: decodeBinding(
      typeof operation.binding === "string"
        ? decodeBindingJson(operation.binding)
        : operation.binding,
    ),
  };
};

export interface OpenapiStore {
  readonly upsertSource: (
    input: StoredSource,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, StorageFailure>;
  readonly updateSourceMeta: (
    namespace: string,
    scope: string,
    patch: {
      readonly name?: string;
      readonly baseUrl?: string;
      readonly headers?: Record<string, ConfiguredHeaderValue>;
      readonly queryParams?: Record<string, ConfiguredHeaderValue>;
      readonly specFetchCredentials?: OpenApiSpecFetchCredentials;
      readonly oauth2?: OAuth2SourceConfig;
    },
  ) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredSource | null, StorageFailure>;
  readonly listSources: () => Effect.Effect<readonly StoredSource[], StorageFailure>;
  readonly getOperationByToolId: (
    toolId: string,
    scope: string,
  ) => Effect.Effect<StoredOperation | null, StorageFailure>;
  readonly listOperationsBySource: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<readonly StoredOperation[], StorageFailure>;
  readonly removeSource: (namespace: string, scope: string) => Effect.Effect<void, StorageFailure>;
}

export const makeDefaultOpenapiStore = ({ pluginStorage }: StorageDeps): OpenapiStore => {
  const sourceData = (source: StoredSource) => ({
    namespace: source.namespace,
    scope: source.scope,
    name: source.name,
    config: encodeSourceConfig(source.config),
  });

  const operationData = (operation: StoredOperation) => ({
    toolId: operation.toolId,
    sourceId: operation.sourceId,
    binding: toJsonRecord(encodeBinding(operation.binding)),
  });

  const listOperationRowsForSourceScope = (sourceId: string, scope: string) =>
    pluginStorage
      .list({
        collection: OPERATION_COLLECTION,
        keyPrefix: `${sourceId}.`,
      })
      .pipe(
        Effect.map((rows) =>
          rows.filter(
            (row) => String(row.scopeId) === scope && rowToOperation(row)?.sourceId === sourceId,
          ),
        ),
      );

  const removeOperationsForSourceScope = (sourceId: string, scope: string) =>
    Effect.gen(function* () {
      const rows = yield* listOperationRowsForSourceScope(sourceId, scope);
      for (const row of rows) {
        yield* pluginStorage.remove({
          scope,
          collection: OPERATION_COLLECTION,
          key: row.key,
        });
      }
    });

  const deleteSource = (namespace: string, scope: string) =>
    Effect.gen(function* () {
      yield* removeOperationsForSourceScope(namespace, scope);
      yield* pluginStorage.remove({
        scope,
        collection: SOURCE_COLLECTION,
        key: namespace,
      });
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace, input.scope);
        yield* pluginStorage.put({
          scope: input.scope,
          collection: SOURCE_COLLECTION,
          key: input.namespace,
          data: sourceData(input),
        });
        for (const operation of operations) {
          yield* pluginStorage.put({
            scope: input.scope,
            collection: OPERATION_COLLECTION,
            key: operation.toolId,
            data: operationData(operation),
          });
        }
      }),

    updateSourceMeta: (namespace, scope, patch) =>
      Effect.gen(function* () {
        const existing = yield* pluginStorage.getAtScope({
          scope,
          collection: SOURCE_COLLECTION,
          key: namespace,
        });
        if (!existing) return;
        const source = rowToSource(existing);
        if (!source) return;
        const next: StoredSource = {
          ...source,
          name: patch.name?.trim() || source.name,
          config: {
            ...source.config,
            ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
            ...(patch.headers !== undefined ? { headers: patch.headers } : {}),
            ...(patch.queryParams !== undefined ? { queryParams: patch.queryParams } : {}),
            ...(patch.specFetchCredentials !== undefined
              ? { specFetchCredentials: patch.specFetchCredentials }
              : {}),
            ...(patch.oauth2 !== undefined ? { oauth2: patch.oauth2 } : {}),
          },
        };
        yield* pluginStorage.put({
          scope,
          collection: SOURCE_COLLECTION,
          key: namespace,
          data: sourceData(next),
        });
      }),

    getSource: (namespace, scope) =>
      pluginStorage
        .getAtScope({ scope, collection: SOURCE_COLLECTION, key: namespace })
        .pipe(Effect.map((row) => (row ? rowToSource(row) : null))),

    listSources: () =>
      pluginStorage
        .list({ collection: SOURCE_COLLECTION })
        .pipe(Effect.map((rows) => rows.map(rowToSource).filter(Predicate.isNotNull))),

    getOperationByToolId: (toolId, scope) =>
      pluginStorage
        .getAtScope({ scope, collection: OPERATION_COLLECTION, key: toolId })
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperationsBySource: (sourceId, scope) =>
      listOperationRowsForSourceScope(sourceId, scope).pipe(
        Effect.map((rows) => rows.map(rowToOperation).filter(Predicate.isNotNull)),
      ),

    removeSource: (namespace, scope) => deleteSource(namespace, scope),
  };
};
