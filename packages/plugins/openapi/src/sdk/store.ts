import { Effect, Option, Schema } from "effect";

import {
  type FumaRow,
  type FumaTables,
  jsonColumn,
  nullableJsonColumn,
  nullableTextColumn,
  scopedExecutorTable,
  type StorageDeps,
  type StorageFailure,
  textColumn,
} from "@executor-js/sdk/core";

import {
  ConfiguredHeaderValue,
  ConfiguredHeaderBinding,
  OAuth2SourceConfig,
  OperationBinding,
} from "./types";

// ---------------------------------------------------------------------------
// Schema:
//   - openapi_source: one row per onboarded spec (baseUrl, oauth2, ...)
//   - openapi_operation: one row per operation binding keyed by tool id
// ---------------------------------------------------------------------------

// Each of the source-owned credential-structure child tables (`openapi_source_header`,
// `openapi_source_query_param`,
// `openapi_source_spec_fetch_header`,
// `openapi_source_spec_fetch_query_param`) shares the same column shape:
// id/scope_id/source_id/name plus a `kind` enum that discriminates a
// literal text value from a credential slot binding (with optional prefix).
// The fields are inlined per-table because FumaDB's table type
// narrowing relies on the literal types staying on the original
// declaration site.

export const openapiSchema = {
  openapi_source: scopedExecutorTable("openapi_source", {
    name: textColumn("name"),
    spec: textColumn("spec"),
    // Origin URL the spec was fetched from. Set when `addSpec` was
    // invoked with an http(s) URL; null when the caller passed raw
    // spec text. Drives `canRefresh` on the core source row and
    // is the address re-fetched on `refreshSource`.
    source_url: nullableTextColumn("source_url"),
    base_url: nullableTextColumn("base_url"),
    // OAuth2 stays JSON because it is one typed source-owned config object
    // carrying slot names, not concrete secret/connection ids.
    oauth2: nullableJsonColumn("oauth2"),
  }),
  openapi_operation: scopedExecutorTable("openapi_operation", {
    source_id: textColumn("source_id"),
    binding: jsonColumn("binding"),
  }),
  openapi_source_header: scopedExecutorTable("openapi_source_header", {
    source_id: textColumn("source_id"),
    name: textColumn("name"),
    kind: textColumn("kind"),
    text_value: nullableTextColumn("text_value"),
    slot_key: nullableTextColumn("slot_key"),
    prefix: nullableTextColumn("prefix"),
  }),
  openapi_source_query_param: scopedExecutorTable("openapi_source_query_param", {
    source_id: textColumn("source_id"),
    name: textColumn("name"),
    kind: textColumn("kind"),
    text_value: nullableTextColumn("text_value"),
    slot_key: nullableTextColumn("slot_key"),
    prefix: nullableTextColumn("prefix"),
  }),
  openapi_source_spec_fetch_header: scopedExecutorTable("openapi_source_spec_fetch_header", {
    source_id: textColumn("source_id"),
    name: textColumn("name"),
    kind: textColumn("kind"),
    text_value: nullableTextColumn("text_value"),
    slot_key: nullableTextColumn("slot_key"),
    prefix: nullableTextColumn("prefix"),
  }),
  openapi_source_spec_fetch_query_param: scopedExecutorTable(
    "openapi_source_spec_fetch_query_param",
    {
      source_id: textColumn("source_id"),
      name: textColumn("name"),
      kind: textColumn("kind"),
      text_value: nullableTextColumn("text_value"),
      slot_key: nullableTextColumn("slot_key"),
      prefix: nullableTextColumn("prefix"),
    },
  ),
} satisfies FumaTables;

export type OpenapiSchema = typeof openapiSchema;

// ---------------------------------------------------------------------------
// In-memory shapes
// ---------------------------------------------------------------------------

export interface SourceConfig {
  readonly spec: string;
  /** Origin URL when the spec was fetched from http(s). Absent for
   *  raw-text adds. Persisted so `refreshSource` can re-fetch. */
  readonly sourceUrl?: string;
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
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads choose scope explicitly in the FumaDB query. */
  readonly scope: string;
  readonly name: string;
  readonly config: SourceConfig;
}

// ---------------------------------------------------------------------------
// Schema-class mirror of StoredSource for the API layer, where we need
// an encodable/decodable shape for HTTP responses.
// ---------------------------------------------------------------------------

export const StoredSourceSchema = Schema.Struct({
  namespace: Schema.String,
  scope: Schema.String,
  name: Schema.String,
  config: Schema.Struct({
    spec: Schema.optional(Schema.String),
    sourceUrl: Schema.optional(Schema.String),
    baseUrl: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    headers: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
    queryParams: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
    specFetchCredentials: Schema.optional(
      Schema.Struct({
        headers: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
        queryParams: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
      }),
    ),
    // Canonical source-owned OAuth config. Concrete client credentials
    // and connection ids live in OpenAPI-owned scoped binding rows.
    oauth2: Schema.optional(OAuth2SourceConfig),
  }),
}).annotate({ identifier: "OpenApiStoredSource" });
export type StoredSourceSchema = typeof StoredSourceSchema.Type;

export type StoredSourceSchemaType = typeof StoredSourceSchema.Type;

export interface StoredOperation {
  readonly toolId: string;
  readonly sourceId: string;
  readonly binding: OperationBinding;
}

// ---------------------------------------------------------------------------
// Schema encode/decode — OperationBinding has Option fields, so we must use
// Schema.encode/decode rather than plain JSON to round-trip correctly.
// ---------------------------------------------------------------------------

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

const ChildStorageRow = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["text", "binding"]),
  text_value: OptionalNullableString,
  slot_key: OptionalNullableString,
  prefix: OptionalNullableString,
});
const decodeChildStorageRowOption = Schema.decodeUnknownOption(ChildStorageRow);

const SourceStorageRow = Schema.Struct({
  id: Schema.String,
  scope_id: Schema.String,
  name: Schema.String,
  spec: Schema.String,
  source_url: OptionalNullableString,
  base_url: OptionalNullableString,
  oauth2: Schema.optional(Schema.Unknown),
});
const decodeSourceStorageRow = Schema.decodeUnknownSync(SourceStorageRow);

const OperationStorageRow = Schema.Struct({
  id: Schema.String,
  source_id: Schema.String,
  binding: Schema.Unknown,
});
const decodeOperationStorageRow = Schema.decodeUnknownSync(OperationStorageRow);

type OpenapiSourceRow = FumaRow<OpenapiSchema["openapi_source"]>;
type OpenapiOperationRow = FumaRow<OpenapiSchema["openapi_operation"]>;

const openapiCredentialChildTables = [
  "openapi_source_header",
  "openapi_source_query_param",
  "openapi_source_spec_fetch_header",
  "openapi_source_spec_fetch_query_param",
] as const satisfies readonly (keyof OpenapiSchema)[];

// Collapse a structural credential map into the flat child-table column
// shape used by openapi_source_header, openapi_source_query_param, and
// the two openapi_source_spec_fetch_* tables. Returns one record per entry.
const valueMapToChildRows = (
  sourceId: string,
  scope: string,
  values: Record<string, ConfiguredHeaderValue> | undefined,
) => {
  if (!values) return [];
  return Object.entries(values).map(([name, value]) => {
    const id = JSON.stringify([sourceId, name]);
    if (typeof value === "string") {
      return {
        id,
        scope_id: scope,
        source_id: sourceId,
        name,
        kind: "text",
        text_value: value,
        slot_key: null,
        prefix: null,
      };
    }
    return {
      id,
      scope_id: scope,
      source_id: sourceId,
      name,
      kind: "binding",
      text_value: null,
      slot_key: value.slot,
      prefix: value.prefix ?? null,
    };
  });
};

const childRowsToValueMap = (
  rows: readonly Record<string, unknown>[],
): Record<string, ConfiguredHeaderValue> => {
  const out: Record<string, ConfiguredHeaderValue> = {};
  for (const row of rows) {
    const decoded = decodeChildStorageRowOption(row);
    if (Option.isSome(decoded)) {
      const child = decoded.value;
      if (child.kind === "binding" && child.slot_key != null) {
        out[child.name] =
          child.prefix != null
            ? ConfiguredHeaderBinding.make({
                kind: "binding",
                slot: child.slot_key,
                prefix: child.prefix,
              })
            : ConfiguredHeaderBinding.make({
                kind: "binding",
                slot: child.slot_key,
              });
      } else if (child.kind === "text" && child.text_value != null) {
        out[child.name] = child.text_value;
      }
    }
  }
  return out;
};

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const slugifySlotPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

export const headerBindingSlot = (headerName: string): string =>
  `header:${slugifySlotPart(headerName)}`;

export const queryParamBindingSlot = (name: string): string =>
  `query_param:${slugifySlotPart(name)}`;

export const oauth2ClientIdSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:client-id`;

export const oauth2ClientSecretSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:client-secret`;

export const oauth2ConnectionSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:connection`;

const normalizeStoredOAuth2 = (value: unknown): OAuth2SourceConfig | undefined => {
  if (value == null) return undefined;
  const sourceConfig =
    typeof value === "string"
      ? decodeOAuth2SourceConfigJsonOption(value)
      : decodeOAuth2SourceConfigOption(value);
  if (Option.isSome(sourceConfig)) {
    return sourceConfig.value;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

// Every read/write that targets a single row pins BOTH the natural id
// (namespace, toolId, sessionId) AND the owning `scope_id`. Scope is a
// normal FumaDB predicate here, not hidden behavior.
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

  // ---------------------------------------------------------------------
  // Query params and spec-fetch credentials are source-owned structural
  // rows only. Secret/connection ownership and usages live in core
  // `credential_binding`.
}

// ---------------------------------------------------------------------------
// Default store implementation
// ---------------------------------------------------------------------------

export const makeDefaultOpenapiStore = ({
  fuma,
  scopes,
}: StorageDeps<OpenapiSchema>): OpenapiStore => {
  const scopeIds = scopes.map((scope) => String(scope.id));

  const loadChildValueMap = (
    tableName: (typeof openapiCredentialChildTables)[number],
    sourceId: string,
    scope: string,
  ) =>
    fuma
      .use(`${tableName}.findMany`, (db) =>
        db.findMany(tableName, {
          where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)),
        }),
      )
      .pipe(Effect.map(childRowsToValueMap));

  const rowToSource = (row: OpenapiSourceRow): Effect.Effect<StoredSource, StorageFailure> =>
    Effect.gen(function* () {
      const sourceRow = decodeSourceStorageRow(row);
      const sourceId = sourceRow.id;
      const scope = sourceRow.scope_id;
      const oauth2 = normalizeStoredOAuth2(sourceRow.oauth2);

      const headers = yield* loadChildValueMap("openapi_source_header", sourceId, scope);
      const queryParams = yield* loadChildValueMap("openapi_source_query_param", sourceId, scope);
      const specFetchHeaders = yield* loadChildValueMap(
        "openapi_source_spec_fetch_header",
        sourceId,
        scope,
      );
      const specFetchQueryParams = yield* loadChildValueMap(
        "openapi_source_spec_fetch_query_param",
        sourceId,
        scope,
      );
      const specFetchCredentials: OpenApiSpecFetchCredentials | undefined =
        Object.keys(specFetchHeaders).length === 0 && Object.keys(specFetchQueryParams).length === 0
          ? undefined
          : {
              ...(Object.keys(specFetchHeaders).length > 0 ? { headers: specFetchHeaders } : {}),
              ...(Object.keys(specFetchQueryParams).length > 0
                ? { queryParams: specFetchQueryParams }
                : {}),
            };

      return {
        namespace: sourceId,
        scope,
        name: sourceRow.name,
        config: {
          spec: sourceRow.spec,
          sourceUrl: sourceRow.source_url ?? undefined,
          baseUrl: sourceRow.base_url ?? undefined,
          headers,
          queryParams,
          specFetchCredentials,
          oauth2,
        },
      };
    });

  const rowToOperation = (row: OpenapiOperationRow): StoredOperation => {
    const operationRow = decodeOperationStorageRow(row);
    return {
      toolId: operationRow.id,
      sourceId: operationRow.source_id,
      binding: decodeBinding(
        typeof operationRow.binding === "string"
          ? decodeBindingJson(operationRow.binding)
          : operationRow.binding,
      ),
    };
  };

  // Replace the rows of one child table for a source: delete then bulk
  // insert. Single helper so upsertSource and updateSourceMeta both
  // funnel through the same write path.
  const replaceChildRows = (
    tableName: (typeof openapiCredentialChildTables)[number],
    sourceId: string,
    scope: string,
    values: Record<string, ConfiguredHeaderValue> | undefined,
  ) =>
    Effect.gen(function* () {
      yield* fuma.use(`${tableName}.deleteMany`, (db) =>
        db.deleteMany(tableName, {
          where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)),
        }),
      );
      const rows = valueMapToChildRows(sourceId, scope, values);
      if (rows.length === 0) return;
      yield* fuma.use(`${tableName}.createMany`, (db) => db.createMany(tableName, rows));
    });

  const deleteSource = (namespace: string, scope: string) =>
    Effect.gen(function* () {
      yield* fuma.use("openapi_operation.deleteMany", (db) =>
        db.deleteMany("openapi_operation", {
          where: (b) => b.and(b("source_id", "=", namespace), b("scope_id", "=", scope)),
        }),
      );
      // Drop every child table's rows for this source/scope.
      for (const tableName of openapiCredentialChildTables) {
        yield* fuma.use(`${tableName}.deleteMany`, (db) =>
          db.deleteMany(tableName, {
            where: (b) => b.and(b("source_id", "=", namespace), b("scope_id", "=", scope)),
          }),
        );
      }
      yield* fuma.use("openapi_source.deleteMany", (db) =>
        db.deleteMany("openapi_source", {
          where: (b) => b.and(b("id", "=", namespace), b("scope_id", "=", scope)),
        }),
      );
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace, input.scope);
        yield* fuma.use("openapi_source.createMany", (db) =>
          db.createMany("openapi_source", [
            {
              id: input.namespace,
              scope_id: input.scope,
              name: input.name,
              spec: input.config.spec,
              source_url: input.config.sourceUrl ?? null,
              base_url: input.config.baseUrl ?? null,
              oauth2: input.config.oauth2
                ? toJsonRecord(encodeOAuth2SourceConfig(input.config.oauth2))
                : null,
            },
          ]),
        );
        yield* replaceChildRows(
          "openapi_source_header",
          input.namespace,
          input.scope,
          input.config.headers,
        );
        yield* replaceChildRows(
          "openapi_source_query_param",
          input.namespace,
          input.scope,
          input.config.queryParams,
        );
        yield* replaceChildRows(
          "openapi_source_spec_fetch_header",
          input.namespace,
          input.scope,
          input.config.specFetchCredentials?.headers,
        );
        yield* replaceChildRows(
          "openapi_source_spec_fetch_query_param",
          input.namespace,
          input.scope,
          input.config.specFetchCredentials?.queryParams,
        );
        if (operations.length > 0) {
          yield* fuma.use("openapi_operation.createMany", (db) =>
            db.createMany(
              "openapi_operation",
              operations.map((op) => ({
                id: op.toolId,
                scope_id: input.scope,
                source_id: op.sourceId,
                binding: toJsonRecord(encodeBinding(op.binding)),
              })),
            ),
          );
        }
      }),

    updateSourceMeta: (namespace, scope, patch) =>
      Effect.gen(function* () {
        const existingRow = yield* fuma.use("openapi_source.findFirst", (db) =>
          db.findFirst("openapi_source", {
            where: (b) => b.and(b("id", "=", namespace), b("scope_id", "=", scope)),
          }),
        );
        if (!existingRow) return;
        const existing = yield* rowToSource(existingRow);

        const nextName = patch.name?.trim() || existing.name;
        const nextBaseUrl = patch.baseUrl !== undefined ? patch.baseUrl : existing.config.baseUrl;
        const nextOAuth2 = patch.oauth2 !== undefined ? patch.oauth2 : existing.config.oauth2;

        yield* fuma.use("openapi_source.updateMany", (db) =>
          db.updateMany("openapi_source", {
            where: (b) => b.and(b("id", "=", namespace), b("scope_id", "=", scope)),
            set: {
              name: nextName,
              base_url: nextBaseUrl ?? null,
              oauth2: nextOAuth2 ? toJsonRecord(encodeOAuth2SourceConfig(nextOAuth2)) : null,
            },
          }),
        );
        if (patch.headers !== undefined) {
          yield* replaceChildRows("openapi_source_header", namespace, scope, patch.headers);
        }
        if (patch.queryParams !== undefined) {
          yield* replaceChildRows(
            "openapi_source_query_param",
            namespace,
            scope,
            patch.queryParams,
          );
        }
      }),

    getSource: (namespace, scope) =>
      Effect.gen(function* () {
        const row = yield* fuma.use("openapi_source.findFirst", (db) =>
          db.findFirst("openapi_source", {
            where: (b) => b.and(b("id", "=", namespace), b("scope_id", "=", scope)),
          }),
        );
        if (!row) return null;
        return yield* rowToSource(row);
      }),

    listSources: () =>
      Effect.gen(function* () {
        const rows = yield* fuma.use("openapi_source.findMany", (db) =>
          db.findMany("openapi_source", {
            where: (b) =>
              scopeIds.length === 1
                ? b("scope_id", "=", scopeIds[0]!)
                : b("scope_id", "in", [...scopeIds]),
          }),
        );
        return yield* Effect.forEach(rows, rowToSource, {
          concurrency: "unbounded",
        });
      }),

    getOperationByToolId: (toolId, scope) =>
      fuma
        .use("openapi_operation.findFirst", (db) =>
          db.findFirst("openapi_operation", {
            where: (b) => b.and(b("id", "=", toolId), b("scope_id", "=", scope)),
          }),
        )
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperationsBySource: (sourceId, scope) =>
      fuma
        .use("openapi_operation.findMany", (db) =>
          db.findMany("openapi_operation", {
            where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)),
          }),
        )
        .pipe(Effect.map((rows) => rows.map(rowToOperation))),

    removeSource: (namespace, scope) => deleteSource(namespace, scope),
  };
};
