import { Effect, Schema } from "effect";

import {
  ConfiguredCredentialBinding,
  defineSchema,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import {
  OperationBinding,
  type ConfiguredGraphqlCredentialValue,
  type GraphqlSourceAuth,
} from "./types";

// ---------------------------------------------------------------------------
// Schema — four tables:
//   - graphql_source: endpoint + auth structure + display name per source.
//     Auth carries a connection slot; concrete per-user/per-workspace
//     connection ids live in core credential_binding rows.
//   - graphql_source_header / graphql_source_query_param: one row per
//     header/param entry. `kind` discriminates literal text from a
//     credential slot binding. PK is `(scope_id, id)` where id is a JSON
//     tuple `[source_id,name]` so user-provided separators cannot collide.
//   - graphql_operation: per-tool OperationBinding blob. Operation
//     bindings don't reference secrets/connections, so they stay as
//     JSON — that's a legit JSON case (the binding shape is plugin-
//     internal opaque data).
// ---------------------------------------------------------------------------

export const graphqlSchema = defineSchema({
  graphql_source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      endpoint: { type: "string", required: true },
      auth_kind: {
        type: ["none", "oauth2"],
        required: true,
        defaultValue: "none",
      },
      auth_connection_slot: {
        type: "string",
        required: false,
      },
    },
  },
  graphql_source_header: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      kind: {
        type: ["text", "binding"],
        required: true,
      },
      text_value: { type: "string", required: false },
      slot_key: { type: "string", required: false },
      prefix: { type: "string", required: false },
    },
  },
  graphql_source_query_param: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      kind: {
        type: ["text", "binding"],
        required: true,
      },
      text_value: { type: "string", required: false },
      slot_key: { type: "string", required: false },
      prefix: { type: "string", required: false },
    },
  },
  graphql_operation: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      binding: { type: "json", required: true },
    },
  },
});

export type GraphqlSchema = typeof graphqlSchema;

// ---------------------------------------------------------------------------
// In-memory value shapes
// ---------------------------------------------------------------------------

export interface StoredGraphqlSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads return whichever scope's row the adapter's
   *  fall-through walk surfaced first. */
  readonly scope: string;
  readonly name: string;
  readonly endpoint: string;
  readonly headers: Record<string, ConfiguredGraphqlCredentialValue>;
  readonly queryParams: Record<string, ConfiguredGraphqlCredentialValue>;
  readonly auth: GraphqlSourceAuth;
}

export interface StoredOperation {
  readonly toolId: string;
  readonly sourceId: string;
  readonly binding: OperationBinding;
}

const OperationBindingFromJsonString = Schema.fromJsonString(OperationBinding);
const decodeOperationBindingFromJsonString = Schema.decodeUnknownSync(
  OperationBindingFromJsonString,
);
const decodeOperationBinding = Schema.decodeUnknownSync(OperationBinding);

const decodeBinding = (value: unknown): OperationBinding => {
  if (typeof value === "string") {
    return decodeOperationBindingFromJsonString(value);
  }
  return decodeOperationBinding(value);
};

const encodeBinding = Schema.encodeSync(OperationBinding);

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const SourceRow = Schema.Struct({
  id: Schema.String,
  scope_id: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  auth_kind: Schema.Literals(["none", "oauth2"]),
  auth_connection_slot: Schema.NullOr(Schema.String).pipe(Schema.optionalKey),
});

const ChildValueRow = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["text", "binding"]),
  text_value: Schema.NullOr(Schema.String).pipe(Schema.optionalKey),
  slot_key: Schema.NullOr(Schema.String).pipe(Schema.optionalKey),
  prefix: Schema.NullOr(Schema.String).pipe(Schema.optionalKey),
});

const OperationRow = Schema.Struct({
  id: Schema.String,
  source_id: Schema.String,
  binding: Schema.Unknown,
});

const decodeSourceRow = Schema.decodeUnknownSync(SourceRow);
const decodeChildValueRow = Schema.decodeUnknownSync(ChildValueRow);
const decodeOperationRow = Schema.decodeUnknownSync(OperationRow);

// Header / query-param rows: collapse the flat columns back into a source
// structure map keyed by header/param name. Concrete credential values are
// resolved through core credential_binding rows at invocation time.
const rowsToValueMap = (
  rows: readonly Record<string, unknown>[],
): Record<string, ConfiguredGraphqlCredentialValue> => {
  const out: Record<string, ConfiguredGraphqlCredentialValue> = {};
  for (const rawRow of rows) {
    const row = decodeChildValueRow(rawRow);
    const name = row.name;
    if (row.kind === "binding" && typeof row.slot_key === "string") {
      out[name] =
        typeof row.prefix === "string"
          ? new ConfiguredCredentialBinding({
              kind: "binding",
              slot: row.slot_key,
              prefix: row.prefix,
            })
          : new ConfiguredCredentialBinding({
              kind: "binding",
              slot: row.slot_key,
            });
    } else if (row.kind === "text" && typeof row.text_value === "string") {
      out[name] = row.text_value;
    }
  }
  return out;
};

// Encode one entry of a source credential map into a child row. Used by the
// writer for both `graphql_source_header` and `graphql_source_query_param`.
// Returns a `Record<string, unknown>` so the result is structurally assignable
// to the typed adapter's `RowInput` shape.
const valueToChildRow = (
  sourceId: string,
  scope: string,
  name: string,
  value: ConfiguredGraphqlCredentialValue,
): Record<string, unknown> => {
  const id = JSON.stringify([sourceId, name]);
  if (typeof value === "string") {
    return {
      id,
      scope_id: scope,
      source_id: sourceId,
      name,
      kind: "text",
      text_value: value,
    };
  }
  return {
    id,
    scope_id: scope,
    source_id: sourceId,
    name,
    kind: "binding",
    slot_key: value.slot,
    prefix: value.prefix,
  };
};

const rowToAuth = (row: typeof SourceRow.Type): GraphqlSourceAuth => {
  if (row.auth_kind === "oauth2" && typeof row.auth_connection_slot === "string") {
    return { kind: "oauth2", connectionSlot: row.auth_connection_slot };
  }
  return { kind: "none" };
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

// Every read/write that targets a single row pins BOTH the natural id
// (namespace, toolId) AND the owning `scope_id`. The store runs behind
// the scoped adapter (which auto-injects `scope_id IN (stack)`), so a
// bare `{id}` filter resolves to any matching row in the stack in
// adapter-iteration order. For shadowed rows (same id at multiple
// scopes — e.g. an org-level GraphQL source with a per-user override),
// that's a scope-isolation bug: updates and deletes can land on the
// wrong scope's row. Callers thread the resolved scope in (typically
// `path.scopeId` for HTTP, `toolRow.scope_id` / `input.scope` for
// invokeTool/lifecycle) so every keyed mutation targets exactly one
// row.
export interface GraphqlStore {
  readonly upsertSource: (
    input: StoredGraphqlSource,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, StorageFailure>;

  readonly updateSourceMeta: (
    namespace: string,
    scope: string,
    patch: {
      readonly name?: string;
      readonly endpoint?: string;
      readonly headers?: Record<string, ConfiguredGraphqlCredentialValue>;
      readonly queryParams?: Record<string, ConfiguredGraphqlCredentialValue>;
      readonly auth?: GraphqlSourceAuth;
    },
  ) => Effect.Effect<void, StorageFailure>;

  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredGraphqlSource | null, StorageFailure>;

  readonly listSources: () => Effect.Effect<readonly StoredGraphqlSource[], StorageFailure>;

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

// ---------------------------------------------------------------------------
// Default store implementation
// ---------------------------------------------------------------------------

export const makeDefaultGraphqlStore = ({
  adapter: db,
}: StorageDeps<GraphqlSchema>): GraphqlStore => {
  const loadHeaders = (sourceId: string, scope: string) =>
    db
      .findMany({
        model: "graphql_source_header",
        where: [
          { field: "source_id", value: sourceId },
          { field: "scope_id", value: scope },
        ],
      })
      .pipe(Effect.map(rowsToValueMap));

  const loadQueryParams = (sourceId: string, scope: string) =>
    db
      .findMany({
        model: "graphql_source_query_param",
        where: [
          { field: "source_id", value: sourceId },
          { field: "scope_id", value: scope },
        ],
      })
      .pipe(Effect.map(rowsToValueMap));

  const rowToSourceWithChildren = (
    row: Record<string, unknown>,
  ): Effect.Effect<StoredGraphqlSource, StorageFailure> =>
    Effect.gen(function* () {
      const source = decodeSourceRow(row);
      const sourceId = source.id;
      const scope = source.scope_id;
      const headers = yield* loadHeaders(sourceId, scope);
      const queryParams = yield* loadQueryParams(sourceId, scope);
      return {
        namespace: sourceId,
        scope,
        name: source.name,
        endpoint: source.endpoint,
        headers,
        queryParams,
        auth: rowToAuth(source),
      };
    });

  const rowToOperation = (row: Record<string, unknown>): StoredOperation => {
    const operation = decodeOperationRow(row);
    return {
      toolId: operation.id,
      sourceId: operation.source_id,
      binding: decodeBinding(operation.binding),
    };
  };

  // Replace child rows for a source by deleting then bulk-inserting. Used
  // by both upsertSource (full rewrite) and updateSourceMeta (partial
  // patch when headers/queryParams is supplied).
  const replaceChildren = (
    model: "graphql_source_header" | "graphql_source_query_param",
    sourceId: string,
    scope: string,
    values: Record<string, ConfiguredGraphqlCredentialValue>,
  ) =>
    Effect.gen(function* () {
      yield* db.deleteMany({
        model,
        where: [
          { field: "source_id", value: sourceId },
          { field: "scope_id", value: scope },
        ],
      });
      const entries = Object.entries(values);
      if (entries.length === 0) return;
      yield* db.createMany({
        model,
        data: entries.map(([name, value]) => valueToChildRow(sourceId, scope, name, value)),
        forceAllowId: true,
      });
    });

  const deleteSource = (namespace: string, scope: string) =>
    Effect.gen(function* () {
      yield* db.deleteMany({
        model: "graphql_operation",
        where: [
          { field: "source_id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
      yield* db.deleteMany({
        model: "graphql_source_header",
        where: [
          { field: "source_id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
      yield* db.deleteMany({
        model: "graphql_source_query_param",
        where: [
          { field: "source_id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
      yield* db.delete({
        model: "graphql_source",
        where: [
          { field: "id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace, input.scope);
        yield* db.create({
          model: "graphql_source",
          data: {
            id: input.namespace,
            scope_id: input.scope,
            name: input.name,
            endpoint: input.endpoint,
            auth_kind: input.auth.kind,
            auth_connection_slot:
              input.auth.kind === "oauth2" ? input.auth.connectionSlot : undefined,
          },
          forceAllowId: true,
        });
        yield* replaceChildren(
          "graphql_source_header",
          input.namespace,
          input.scope,
          input.headers,
        );
        yield* replaceChildren(
          "graphql_source_query_param",
          input.namespace,
          input.scope,
          input.queryParams,
        );
        if (operations.length > 0) {
          yield* db.createMany({
            model: "graphql_operation",
            data: operations.map((op) => ({
              id: op.toolId,
              scope_id: input.scope,
              source_id: op.sourceId,
              binding: toJsonRecord(encodeBinding(op.binding)),
            })),
            forceAllowId: true,
          });
        }
      }),

    updateSourceMeta: (namespace, scope, patch) =>
      Effect.gen(function* () {
        const existing = yield* db.findOne({
          model: "graphql_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        });
        if (!existing) return;
        const update: Record<string, unknown> = {};
        if (patch.name !== undefined) update.name = patch.name;
        if (patch.endpoint !== undefined) update.endpoint = patch.endpoint;
        if (patch.auth !== undefined) {
          update.auth_kind = patch.auth.kind;
          update.auth_connection_slot =
            patch.auth.kind === "oauth2" ? patch.auth.connectionSlot : null;
        }
        if (Object.keys(update).length > 0) {
          yield* db.update({
            model: "graphql_source",
            where: [
              { field: "id", value: namespace },
              { field: "scope_id", value: scope },
            ],
            update,
          });
        }
        if (patch.headers !== undefined) {
          yield* replaceChildren("graphql_source_header", namespace, scope, patch.headers);
        }
        if (patch.queryParams !== undefined) {
          yield* replaceChildren("graphql_source_query_param", namespace, scope, patch.queryParams);
        }
      }),

    getSource: (namespace, scope) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "graphql_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        });
        if (!row) return null;
        return yield* rowToSourceWithChildren(row);
      }),

    listSources: () =>
      Effect.gen(function* () {
        const rows = yield* db.findMany({ model: "graphql_source" });
        return yield* Effect.forEach(rows, rowToSourceWithChildren, {
          concurrency: "unbounded",
        });
      }),

    getOperationByToolId: (toolId, scope) =>
      db
        .findOne({
          model: "graphql_operation",
          where: [
            { field: "id", value: toolId },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperationsBySource: (sourceId, scope) =>
      db
        .findMany({
          model: "graphql_operation",
          where: [
            { field: "source_id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.map((rows) => rows.map(rowToOperation))),

    removeSource: (namespace, scope) => deleteSource(namespace, scope),
  };
};
