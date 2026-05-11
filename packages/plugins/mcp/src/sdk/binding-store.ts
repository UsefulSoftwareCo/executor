// ---------------------------------------------------------------------------
// MCP plugin storage — four tables:
//   - mcp_source: per-source structural data (transport, endpoint,
//     stdio command/args/env, etc.) plus the auth flattened into
//     columns so source-owned credential slots are queryable. The non-ref
//     structural data still lives in `config` as JSON because it's
//     plugin-private and varies by transport (`remote` vs `stdio`
//     have different shapes).
//   - mcp_source_header / mcp_source_query_param: child tables for
//     remote sources' headers and query_params SecretBackedMap entries.
//   - mcp_binding: per-tool McpToolBinding (toolId/toolName/description/
//     input+output schemas/annotations). Stays JSON: it carries no
//     refs, and `inputSchema` / `outputSchema` are arbitrary
//     user-supplied JSON Schemas — a legitimate JSON case.
// OAuth session storage lives at the core level in `oauth2_session`
// and is owned by `ctx.oauth`.
// ---------------------------------------------------------------------------

import { Effect, Option, Schema } from "effect";

import {
  ConfiguredCredentialBinding,
  defineSchema,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import {
  McpToolBinding,
  McpStoredSourceData,
  type McpConnectionAuth,
  type ConfiguredMcpCredentialValue,
} from "./types";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const mcpSchema = defineSchema({
  mcp_source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      // Plugin-private structural data minus the ref-bearing fields
      // (auth, headers, queryParams). For remote sources: transport,
      // endpoint, remoteTransport. For stdio: transport, command,
      // args, env, cwd.
      config: { type: "json", required: true },
      // Flattened McpConnectionAuth. The stored source only names slots;
      // concrete per-user/per-workspace values live in core credential_binding.
      auth_kind: {
        type: ["none", "header", "oauth2"],
        required: true,
        defaultValue: "none",
      },
      // Header-auth fields.
      auth_header_name: { type: "string", required: false },
      auth_header_slot: { type: "string", required: false },
      auth_header_prefix: { type: "string", required: false },
      // OAuth2 auth fields.
      auth_connection_slot: { type: "string", required: false },
      auth_client_id_slot: {
        type: "string",
        required: false,
      },
      auth_client_secret_slot: {
        type: "string",
        required: false,
      },
      created_at: { type: "date", required: true },
    },
  },
  mcp_source_header: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      kind: { type: ["text", "binding"], required: true },
      text_value: { type: "string", required: false },
      slot_key: { type: "string", required: false },
      prefix: { type: "string", required: false },
    },
  },
  mcp_source_query_param: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      kind: { type: ["text", "binding"], required: true },
      text_value: { type: "string", required: false },
      slot_key: { type: "string", required: false },
      prefix: { type: "string", required: false },
    },
  },
  mcp_binding: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      binding: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
});

export type McpSchema = typeof mcpSchema;

// ---------------------------------------------------------------------------
// Serialization helpers — JSON columns round-trip through the adapter as
// either plain objects or serialized strings depending on the backend.
// ---------------------------------------------------------------------------

const decodeSourceData = Schema.decodeUnknownSync(McpStoredSourceData);
const encodeSourceData = Schema.encodeSync(McpStoredSourceData);

const decodeBinding = Schema.decodeUnknownSync(McpToolBinding);
const encodeBinding = Schema.encodeSync(McpToolBinding);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const coerceJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return Option.getOrElse(decodeJson(value), () => value);
};

// --- auth column packing/unpacking ------------------------------------------

interface AuthColumns {
  readonly auth_kind: "none" | "header" | "oauth2";
  readonly auth_header_name?: string;
  readonly auth_header_slot?: string;
  readonly auth_header_prefix?: string;
  readonly auth_connection_slot?: string;
  readonly auth_client_id_slot?: string;
  readonly auth_client_secret_slot?: string;
}

const authToColumns = (auth: McpConnectionAuth): AuthColumns => {
  if (auth.kind === "header") {
    return {
      auth_kind: "header",
      auth_header_name: auth.headerName,
      auth_header_slot: auth.secretSlot,
      auth_header_prefix: auth.prefix,
    };
  }
  if (auth.kind === "oauth2") {
    return {
      auth_kind: "oauth2",
      auth_connection_slot: auth.connectionSlot,
      auth_client_id_slot: auth.clientIdSlot,
      auth_client_secret_slot: auth.clientSecretSlot,
    };
  }
  return { auth_kind: "none" };
};

const columnsToAuth = (row: Record<string, unknown>): McpConnectionAuth => {
  const kind = row.auth_kind;
  if (kind === "header" && typeof row.auth_header_slot === "string") {
    const prefix = row.auth_header_prefix as string | null | undefined;
    return {
      kind: "header",
      headerName: (row.auth_header_name as string | null) ?? "",
      secretSlot: row.auth_header_slot,
      ...(prefix ? { prefix } : {}),
    };
  }
  if (kind === "oauth2" && typeof row.auth_connection_slot === "string") {
    const cid = row.auth_client_id_slot as string | null | undefined;
    const csec = row.auth_client_secret_slot as string | null | undefined;
    return {
      kind: "oauth2",
      connectionSlot: row.auth_connection_slot,
      ...(cid ? { clientIdSlot: cid } : {}),
      ...(csec ? { clientSecretSlot: csec } : {}),
    };
  }
  return { kind: "none" };
};

// --- ConfiguredCredentialValue map <-> child rows ---------------------------

interface ConfiguredCredentialRow {
  readonly id: string;
  readonly scope_id: string;
  readonly source_id: string;
  readonly name: string;
  readonly kind: "text" | "binding";
  readonly text_value?: string;
  readonly slot_key?: string;
  readonly prefix?: string;
  readonly [k: string]: unknown;
}

const valueMapToRows = (
  sourceId: string,
  scope: string,
  values: Record<string, ConfiguredMcpCredentialValue> | undefined,
): readonly ConfiguredCredentialRow[] => {
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
  });
};

const rowsToValueMap = (
  rows: readonly Record<string, unknown>[],
): Record<string, ConfiguredMcpCredentialValue> => {
  const out: Record<string, ConfiguredMcpCredentialValue> = {};
  for (const row of rows) {
    if (typeof row.name !== "string") continue;
    const name = row.name;
    if (row.kind === "binding" && typeof row.slot_key === "string") {
      const prefix = row.prefix as string | undefined | null;
      out[name] = prefix
        ? new ConfiguredCredentialBinding({ kind: "binding", slot: row.slot_key, prefix })
        : new ConfiguredCredentialBinding({ kind: "binding", slot: row.slot_key });
    } else if (row.kind === "text" && typeof row.text_value === "string") {
      out[name] = row.text_value;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Stored source (decoded) — what callers see
// ---------------------------------------------------------------------------

export interface McpStoredSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads return whichever scope's row the adapter's
   *  fall-through walk surfaced first. */
  readonly scope: string;
  readonly name: string;
  readonly config: McpStoredSourceData;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

// Every method routes through the typed adapter (`ctx.storage.adapter`)
// so the typed error channel is `StorageFailure`. Schema-decode failures
// inside `Effect.gen` land as defects, not typed errors, and are caught
// by the HTTP edge's observability middleware.
//
// Every read/write that targets a single row pins BOTH the natural id
// (namespace, toolId, sessionId) AND the owning `scope_id`. The store
// runs behind the scoped adapter (which auto-injects `scope_id IN
// (stack)`), so a bare `{id}` filter resolves to any matching row in
// the stack in adapter-iteration order. For shadowed rows (same id at
// multiple scopes — e.g. an org-level MCP source with a per-user
// override), that's a scope-isolation bug: updates and deletes can
// land on the wrong scope's row. Callers thread the resolved scope in
// (typically `path.scopeId` for HTTP, `toolRow.scope_id` /
// `input.scope` for invokeTool/lifecycle) so every keyed mutation
// targets exactly one row.
export interface McpBindingStore {
  readonly listBindingsBySource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly toolId: string;
      readonly binding: McpToolBinding;
    }>,
    StorageFailure
  >;

  readonly getBinding: (
    toolId: string,
    scope: string,
  ) => Effect.Effect<
    { readonly binding: McpToolBinding; readonly namespace: string } | null,
    StorageFailure
  >;

  readonly putBindings: (
    namespace: string,
    scope: string,
    entries: ReadonlyArray<{
      readonly toolId: string;
      readonly binding: McpToolBinding;
    }>,
  ) => Effect.Effect<void, StorageFailure>;

  readonly removeBindingsByNamespace: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;

  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<McpStoredSource | null, StorageFailure>;
  readonly getSourceConfig: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<McpStoredSourceData | null, StorageFailure>;
  readonly putSource: (source: McpStoredSource) => Effect.Effect<void, StorageFailure>;
  readonly removeSource: (namespace: string, scope: string) => Effect.Effect<void, StorageFailure>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const makeMcpStore = ({ adapter: db }: StorageDeps<McpSchema>): McpBindingStore => {
  return {
    listBindingsBySource: (namespace, scope) =>
      Effect.gen(function* () {
        const rows = yield* db.findMany({
          model: "mcp_binding",
          where: [
            { field: "source_id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        });
        return rows.map((row) => ({
          toolId: row.id,
          binding: decodeBinding(coerceJson(row.binding)),
        }));
      }),

    getBinding: (toolId, scope) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "mcp_binding",
          where: [
            { field: "id", value: toolId },
            { field: "scope_id", value: scope },
          ],
        });
        if (!row) return null;
        const binding = decodeBinding(coerceJson(row.binding));
        return { binding, namespace: row.source_id };
      }),

    putBindings: (namespace, scope, entries) =>
      Effect.gen(function* () {
        if (entries.length === 0) return;
        const now = new Date();
        yield* db.createMany({
          model: "mcp_binding",
          data: entries.map((e) => ({
            id: e.toolId,
            scope_id: scope,
            source_id: namespace,
            binding: encodeBinding(e.binding),
            created_at: now,
          })),
          forceAllowId: true,
        });
      }),

    removeBindingsByNamespace: (namespace, scope) =>
      db
        .deleteMany({
          model: "mcp_binding",
          where: [
            { field: "source_id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.asVoid),

    getSource: (namespace, scope) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "mcp_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        });
        if (!row) return null;
        return {
          namespace: row.id,
          scope: row.scope_id,
          name: row.name,
          config: yield* hydrateSourceData(row, namespace, scope),
        };
      }),

    getSourceConfig: (namespace, scope) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "mcp_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        });
        if (!row) return null;
        return yield* hydrateSourceData(row, namespace, scope);
      }),

    putSource: (source) =>
      Effect.gen(function* () {
        const now = new Date();
        // Drop the source row and its child rows; recreate. Two-step
        // matches the existing put-overwrites-existing semantic.
        yield* db.delete({
          model: "mcp_source",
          where: [
            { field: "id", value: source.namespace },
            { field: "scope_id", value: source.scope },
          ],
        });
        yield* deleteSourceChildren(source.namespace, source.scope);

        const auth: McpConnectionAuth =
          source.config.transport === "remote" ? source.config.auth : { kind: "none" };
        const authCols = authToColumns(auth);
        const headers = source.config.transport === "remote" ? source.config.headers : undefined;
        const queryParams =
          source.config.transport === "remote" ? source.config.queryParams : undefined;

        // The encoded config keeps every plugin-private field but
        // strips auth/headers/queryParams — those moved to columns/
        // child tables. We round-trip through encodeSourceData so the
        // remaining fields stay in the same JSON shape decode expects.
        const encodedConfig = stripExtractedFields(
          encodeSourceData(source.config) as Record<string, unknown>,
        );

        yield* db.create({
          model: "mcp_source",
          data: {
            id: source.namespace,
            scope_id: source.scope,
            name: source.name,
            config: encodedConfig,
            created_at: now,
            ...authCols,
          },
          forceAllowId: true,
        });

        const headerRows = valueMapToRows(source.namespace, source.scope, headers);
        if (headerRows.length > 0) {
          yield* db.createMany({
            model: "mcp_source_header",
            data: headerRows,
            forceAllowId: true,
          });
        }
        const paramRows = valueMapToRows(source.namespace, source.scope, queryParams);
        if (paramRows.length > 0) {
          yield* db.createMany({
            model: "mcp_source_query_param",
            data: paramRows,
            forceAllowId: true,
          });
        }
      }),

    removeSource: (namespace, scope) =>
      Effect.gen(function* () {
        yield* db.deleteMany({
          model: "mcp_binding",
          where: [
            { field: "source_id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        });
        yield* deleteSourceChildren(namespace, scope);
        yield* db.delete({
          model: "mcp_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        });
      }),
  };

  // ---------------------------------------------------------------------
  // Private helpers — depend on `db` so they live inside the closure.
  // ---------------------------------------------------------------------

  function deleteSourceChildren(namespace: string, scope: string) {
    return Effect.gen(function* () {
      for (const model of ["mcp_source_header", "mcp_source_query_param"] as const) {
        yield* db.deleteMany({
          model,
          where: [
            { field: "source_id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        });
      }
    });
  }

  function hydrateSourceData(
    row: Record<string, unknown>,
    namespace: string,
    scope: string,
  ): Effect.Effect<McpStoredSourceData, StorageFailure> {
    return Effect.gen(function* () {
      // The stored JSON has auth/headers/queryParams stripped (those
      // moved to columns / child tables). We must rehydrate the full
      // shape BEFORE handing it to the schema decoder, because
      // `McpRemoteSourceData.auth` is required.
      const partial = coerceJson(row.config) as Record<string, unknown>;
      if (partial.transport !== "remote") {
        // stdio sources have no extracted fields — decode as-is.
        return decodeSourceData(partial);
      }
      const headerRows = yield* db.findMany({
        model: "mcp_source_header",
        where: [
          { field: "source_id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
      const paramRows = yield* db.findMany({
        model: "mcp_source_query_param",
        where: [
          { field: "source_id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
      const headers = rowsToValueMap(headerRows);
      const queryParams = rowsToValueMap(paramRows);
      const reassembled = {
        ...partial,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
        auth: columnsToAuth(row),
      };
      return decodeSourceData(reassembled);
    });
  }
};

// Strip auth/headers/queryParams from the encoded source-data shape.
// Keeps the remaining structural fields (transport, endpoint, etc.) in
// the JSON config column. Per-transport: only the remote variant has
// these fields, so this is a no-op for stdio.
const stripExtractedFields = (encoded: Record<string, unknown>): Record<string, unknown> => {
  if (encoded.transport !== "remote") return encoded;
  const { auth, headers, queryParams, ...rest } = encoded;
  void auth;
  void headers;
  void queryParams;
  return rest;
};
