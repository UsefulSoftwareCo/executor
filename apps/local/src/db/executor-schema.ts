// ---------------------------------------------------------------------------
// Drizzle schema for the v2 executor core tables.
//
// This file exists ONLY to drive `drizzle-kit generate` for the committed
// migration baseline (`apps/local/drizzle`). It is NOT used at runtime: the
// local server brings its SQLite schema up directly from the FumaDB
// `coreTables` definition via `createDrizzleRuntimeSchemaSqlFromTables`
// (see `./sqlite-fumadb.ts`). It mirrors the column set FumaDB derives from
// `@executor-js/sdk`'s `coreTables` so the generated baseline matches the
// runtime schema. Keep it in sync if `coreTables` changes.
// ---------------------------------------------------------------------------

import { sqliteTable, text, integer, blob, uniqueIndex } from "drizzle-orm/sqlite-core";

export const integration = sqliteTable(
  "integration",
  {
    slug: text("slug").notNull(),
    plugin_id: text("plugin_id").notNull(),
    description: text("description").notNull(),
    config: text("config"),
    can_remove: integer("can_remove").notNull().default(1),
    can_refresh: integer("can_refresh").notNull().default(0),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
  },
  (table) => [uniqueIndex("integration_uidx").on(table.tenant, table.slug)],
);

export const connection = sqliteTable(
  "connection",
  {
    integration: text("integration").notNull(),
    name: text("name").notNull(),
    template: text("template").notNull(),
    provider: text("provider").notNull(),
    item_ids: text("item_ids").notNull(),
    identity_label: text("identity_label"),
    oauth_client: text("oauth_client"),
    oauth_client_owner: text("oauth_client_owner"),
    refresh_item_id: text("refresh_item_id"),
    expires_at: blob("expires_at"),
    oauth_scope: text("oauth_scope"),
    oauth_token_url: text("oauth_token_url"),
    provider_state: text("provider_state"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("connection_uidx").on(
      table.tenant,
      table.owner,
      table.subject,
      table.integration,
      table.name,
    ),
  ],
);

export const oauth_client = sqliteTable(
  "oauth_client",
  {
    slug: text("slug").notNull(),
    authorization_url: text("authorization_url").notNull(),
    token_url: text("token_url").notNull(),
    grant: text("grant").notNull(),
    client_id: text("client_id").notNull(),
    client_secret_item_id: text("client_secret_item_id"),
    resource: text("resource"),
    origin_kind: text("origin_kind"),
    origin_integration: text("origin_integration"),
    created_at: integer("created_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("oauth_client_uidx").on(table.tenant, table.owner, table.subject, table.slug),
  ],
);

export const oauth_session = sqliteTable(
  "oauth_session",
  {
    state: text("state").notNull(),
    client_slug: text("client_slug").notNull(),
    integration: text("integration").notNull(),
    name: text("name").notNull(),
    template: text("template").notNull(),
    redirect_url: text("redirect_url").notNull(),
    pkce_verifier: text("pkce_verifier"),
    identity_label: text("identity_label"),
    payload: text("payload").notNull(),
    expires_at: blob("expires_at").notNull(),
    created_at: integer("created_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [uniqueIndex("oauth_session_uidx").on(table.tenant, table.state)],
);

export const tool = sqliteTable(
  "tool",
  {
    integration: text("integration").notNull(),
    connection: text("connection").notNull(),
    plugin_id: text("plugin_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    input_schema: text("input_schema"),
    output_schema: text("output_schema"),
    annotations: text("annotations"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("tool_uidx").on(
      table.tenant,
      table.owner,
      table.subject,
      table.integration,
      table.connection,
      table.name,
    ),
  ],
);

export const definition = sqliteTable(
  "definition",
  {
    integration: text("integration").notNull(),
    connection: text("connection").notNull(),
    plugin_id: text("plugin_id").notNull(),
    name: text("name").notNull(),
    schema: text("schema").notNull(),
    created_at: integer("created_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("definition_uidx").on(
      table.tenant,
      table.owner,
      table.subject,
      table.integration,
      table.connection,
      table.name,
    ),
  ],
);

export const tool_policy = sqliteTable(
  "tool_policy",
  {
    id: text("id").notNull(),
    pattern: text("pattern").notNull(),
    action: text("action").notNull(),
    position: text("position").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("tool_policy_uidx").on(table.tenant, table.owner, table.subject, table.id),
  ],
);

export const plugin_storage = sqliteTable(
  "plugin_storage",
  {
    plugin_id: text("plugin_id").notNull(),
    collection: text("collection").notNull(),
    key: text("key").notNull(),
    data: text("data").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    tenant: text("tenant").notNull(),
    owner: text("owner").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    uniqueIndex("plugin_storage_uidx").on(
      table.tenant,
      table.owner,
      table.subject,
      table.plugin_id,
      table.collection,
      table.key,
    ),
  ],
);

export const blob_table = sqliteTable(
  "blob",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    row_id: text("row_id").primaryKey().notNull(),
    id: text("id").notNull(),
  },
  (table) => [uniqueIndex("blob_id_uidx").on(table.id)],
);
