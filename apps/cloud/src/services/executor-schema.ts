import {
  pgTable,
  text,
  boolean,
  timestamp,
  bigint,
  jsonb,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

export { blobTable as blob } from "@executor-js/storage-postgres";

export const source = pgTable(
  "source",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    url: text("url"),
    can_remove: boolean("can_remove").default(true).notNull(),
    can_refresh: boolean("can_refresh").default(false).notNull(),
    can_edit: boolean("can_edit").default(false).notNull(),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("source_scope_id_idx").on(table.scope_id),
    index("source_plugin_id_idx").on(table.plugin_id),
  ],
);

export const tool = pgTable(
  "tool",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    input_schema: jsonb("input_schema"),
    output_schema: jsonb("output_schema"),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("tool_scope_id_idx").on(table.scope_id),
    index("tool_source_id_idx").on(table.source_id),
    index("tool_plugin_id_idx").on(table.plugin_id),
  ],
);

export const definition = pgTable(
  "definition",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    name: text("name").notNull(),
    schema: jsonb("schema").notNull(),
    created_at: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("definition_scope_id_idx").on(table.scope_id),
    index("definition_source_id_idx").on(table.source_id),
    index("definition_plugin_id_idx").on(table.plugin_id),
  ],
);

export const secret = pgTable(
  "secret",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    owned_by_connection_id: text("owned_by_connection_id"),
    created_at: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("secret_scope_id_idx").on(table.scope_id),
    index("secret_provider_idx").on(table.provider),
    index("secret_owned_by_connection_id_idx").on(table.owned_by_connection_id),
  ],
);

export const connection = pgTable(
  "connection",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    provider: text("provider").notNull(),
    identity_label: text("identity_label"),
    access_token_secret_id: text("access_token_secret_id").notNull(),
    refresh_token_secret_id: text("refresh_token_secret_id"),
    expires_at: bigint("expires_at", { mode: "number" }),
    scope: text("scope"),
    provider_state: jsonb("provider_state"),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("connection_scope_id_idx").on(table.scope_id),
    index("connection_provider_idx").on(table.provider),
  ],
);

export const oauth2_session = pgTable(
  "oauth2_session",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    strategy: text("strategy").notNull(),
    connection_id: text("connection_id").notNull(),
    token_scope: text("token_scope").notNull(),
    redirect_url: text("redirect_url").notNull(),
    payload: jsonb("payload").notNull(),
    expires_at: bigint("expires_at", { mode: "number" }).notNull(),
    created_at: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("oauth2_session_scope_id_idx").on(table.scope_id),
    index("oauth2_session_plugin_id_idx").on(table.plugin_id),
    index("oauth2_session_connection_id_idx").on(table.connection_id),
  ],
);

export const credential_binding = pgTable(
  "credential_binding",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    source_id: text("source_id").notNull(),
    source_scope_id: text("source_scope_id").notNull(),
    slot_key: text("slot_key").notNull(),
    kind: text("kind").notNull(),
    text_value: text("text_value"),
    secret_id: text("secret_id"),
    secret_scope_id: text("secret_scope_id"),
    connection_id: text("connection_id"),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("credential_binding_scope_id_idx").on(table.scope_id),
    index("credential_binding_plugin_id_idx").on(table.plugin_id),
    index("credential_binding_source_id_idx").on(table.source_id),
    index("credential_binding_source_scope_id_idx").on(table.source_scope_id),
    index("credential_binding_slot_key_idx").on(table.slot_key),
    index("credential_binding_kind_idx").on(table.kind),
    index("credential_binding_secret_id_idx").on(table.secret_id),
    index("credential_binding_secret_scope_id_idx").on(table.secret_scope_id),
    index("credential_binding_connection_id_idx").on(table.connection_id),
  ],
);

export const tool_policy = pgTable(
  "tool_policy",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    pattern: text("pattern").notNull(),
    action: text("action").notNull(),
    position: text("position").notNull(),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("tool_policy_scope_id_position_idx").on(table.scope_id, table.position),
  ],
);

export const openapi_source = pgTable(
  "openapi_source",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    name: text("name").notNull(),
    spec: text("spec").notNull(),
    source_url: text("source_url"),
    base_url: text("base_url"),
    oauth2: jsonb("oauth2"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("openapi_source_scope_id_idx").on(table.scope_id),
  ],
);

export const openapi_operation = pgTable(
  "openapi_operation",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    binding: jsonb("binding").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("openapi_operation_scope_id_idx").on(table.scope_id),
    index("openapi_operation_source_id_idx").on(table.source_id),
  ],
);

export const openapi_source_header = pgTable(
  "openapi_source_header",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["text", "binding"] }).notNull(),
    text_value: text("text_value"),
    slot_key: text("slot_key"),
    prefix: text("prefix"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("openapi_source_header_scope_id_idx").on(table.scope_id),
    index("openapi_source_header_source_id_idx").on(table.source_id),
  ],
);

export const openapi_source_query_param = pgTable(
  "openapi_source_query_param",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["text", "binding"] }).notNull(),
    text_value: text("text_value"),
    slot_key: text("slot_key"),
    prefix: text("prefix"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("openapi_source_query_param_scope_id_idx").on(table.scope_id),
    index("openapi_source_query_param_source_id_idx").on(table.source_id),
  ],
);

export const openapi_source_spec_fetch_header = pgTable(
  "openapi_source_spec_fetch_header",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["text", "binding"] }).notNull(),
    text_value: text("text_value"),
    slot_key: text("slot_key"),
    prefix: text("prefix"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("openapi_source_spec_fetch_header_scope_id_idx").on(table.scope_id),
    index("openapi_source_spec_fetch_header_source_id_idx").on(table.source_id),
  ],
);

export const openapi_source_spec_fetch_query_param = pgTable(
  "openapi_source_spec_fetch_query_param",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["text", "binding"] }).notNull(),
    text_value: text("text_value"),
    slot_key: text("slot_key"),
    prefix: text("prefix"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("openapi_source_spec_fetch_query_param_scope_id_idx").on(table.scope_id),
    index("openapi_source_spec_fetch_query_param_source_id_idx").on(table.source_id),
  ],
);

export const mcp_source = pgTable(
  "mcp_source",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    auth_kind: text("auth_kind", { enum: ["none", "header", "oauth2"] })
      .default("none")
      .notNull(),
    auth_header_name: text("auth_header_name"),
    auth_header_slot: text("auth_header_slot"),
    auth_header_prefix: text("auth_header_prefix"),
    auth_connection_slot: text("auth_connection_slot"),
    auth_client_id_slot: text("auth_client_id_slot"),
    auth_client_secret_slot: text("auth_client_secret_slot"),
    created_at: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("mcp_source_scope_id_idx").on(table.scope_id),
  ],
);

export const mcp_source_header = pgTable(
  "mcp_source_header",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["text", "binding"] }).notNull(),
    text_value: text("text_value"),
    slot_key: text("slot_key"),
    prefix: text("prefix"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("mcp_source_header_scope_id_idx").on(table.scope_id),
    index("mcp_source_header_source_id_idx").on(table.source_id),
  ],
);

export const mcp_source_query_param = pgTable(
  "mcp_source_query_param",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["text", "binding"] }).notNull(),
    text_value: text("text_value"),
    slot_key: text("slot_key"),
    prefix: text("prefix"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("mcp_source_query_param_scope_id_idx").on(table.scope_id),
    index("mcp_source_query_param_source_id_idx").on(table.source_id),
  ],
);

export const mcp_binding = pgTable(
  "mcp_binding",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    binding: jsonb("binding").notNull(),
    created_at: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("mcp_binding_scope_id_idx").on(table.scope_id),
    index("mcp_binding_source_id_idx").on(table.source_id),
  ],
);

export const graphql_source = pgTable(
  "graphql_source",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    name: text("name").notNull(),
    endpoint: text("endpoint").notNull(),
    auth_kind: text("auth_kind", { enum: ["none", "oauth2"] })
      .default("none")
      .notNull(),
    auth_connection_slot: text("auth_connection_slot"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("graphql_source_scope_id_idx").on(table.scope_id),
  ],
);

export const graphql_source_header = pgTable(
  "graphql_source_header",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["text", "binding"] }).notNull(),
    text_value: text("text_value"),
    slot_key: text("slot_key"),
    prefix: text("prefix"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("graphql_source_header_scope_id_idx").on(table.scope_id),
    index("graphql_source_header_source_id_idx").on(table.source_id),
  ],
);

export const graphql_source_query_param = pgTable(
  "graphql_source_query_param",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["text", "binding"] }).notNull(),
    text_value: text("text_value"),
    slot_key: text("slot_key"),
    prefix: text("prefix"),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("graphql_source_query_param_scope_id_idx").on(table.scope_id),
    index("graphql_source_query_param_source_id_idx").on(table.source_id),
  ],
);

export const graphql_operation = pgTable(
  "graphql_operation",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    source_id: text("source_id").notNull(),
    binding: jsonb("binding").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("graphql_operation_scope_id_idx").on(table.scope_id),
    index("graphql_operation_source_id_idx").on(table.source_id),
  ],
);

export const workos_vault_metadata = pgTable(
  "workos_vault_metadata",
  {
    id: text("id").notNull(),
    scope_id: text("scope_id").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose"),
    created_at: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index("workos_vault_metadata_scope_id_idx").on(table.scope_id),
  ],
);
