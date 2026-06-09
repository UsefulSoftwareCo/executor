import {
  pgTable,
  varchar,
  text,
  json,
  boolean,
  timestamp,
  uniqueIndex,
  bigint,
} from "drizzle-orm/pg-core";
import { createId } from "fumadb/cuid";

export const integration = pgTable(
  "integration",
  {
    slug: varchar("slug", { length: 255 }).notNull(),
    plugin_id: text("plugin_id").notNull(),
    description: text("description").notNull(),
    config: json("config"),
    can_remove: boolean("can_remove").notNull().default(true),
    can_refresh: boolean("can_refresh").notNull().default(false),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
  },
  (table) => [uniqueIndex("integration_uidx").on(table.tenant, table.slug)],
);

export const connection = pgTable(
  "connection",
  {
    integration: varchar("integration", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    template: text("template").notNull(),
    provider: text("provider").notNull(),
    item_ids: json("item_ids").notNull(),
    identity_label: text("identity_label"),
    oauth_client: text("oauth_client"),
    oauth_client_owner: text("oauth_client_owner"),
    refresh_item_id: text("refresh_item_id"),
    expires_at: bigint("expires_at", { mode: "bigint" }),
    oauth_scope: text("oauth_scope"),
    provider_state: json("provider_state"),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
    owner: varchar("owner", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
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

export const oauth_client = pgTable(
  "oauth_client",
  {
    slug: varchar("slug", { length: 255 }).notNull(),
    authorization_url: text("authorization_url").notNull(),
    token_url: text("token_url").notNull(),
    grant: text("grant").notNull(),
    client_id: text("client_id").notNull(),
    client_secret_item_id: text("client_secret_item_id"),
    resource: text("resource"),
    origin_kind: text("origin_kind"),
    origin_integration: text("origin_integration"),
    created_at: timestamp("created_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
    owner: varchar("owner", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
  },
  (table) => [
    uniqueIndex("oauth_client_uidx").on(table.tenant, table.owner, table.subject, table.slug),
  ],
);

export const oauth_session = pgTable(
  "oauth_session",
  {
    state: varchar("state", { length: 255 }).notNull(),
    client_slug: text("client_slug").notNull(),
    integration: text("integration").notNull(),
    name: text("name").notNull(),
    template: text("template").notNull(),
    redirect_url: text("redirect_url").notNull(),
    pkce_verifier: text("pkce_verifier"),
    identity_label: text("identity_label"),
    payload: json("payload").notNull(),
    expires_at: bigint("expires_at", { mode: "bigint" }).notNull(),
    created_at: timestamp("created_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
    owner: varchar("owner", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
  },
  (table) => [uniqueIndex("oauth_session_uidx").on(table.tenant, table.state)],
);

export const tool = pgTable(
  "tool",
  {
    integration: varchar("integration", { length: 255 }).notNull(),
    connection: varchar("connection", { length: 255 }).notNull(),
    plugin_id: text("plugin_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull(),
    input_schema: json("input_schema"),
    output_schema: json("output_schema"),
    annotations: json("annotations"),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
    owner: varchar("owner", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
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

export const definition = pgTable(
  "definition",
  {
    integration: varchar("integration", { length: 255 }).notNull(),
    connection: varchar("connection", { length: 255 }).notNull(),
    plugin_id: text("plugin_id").notNull(),
    name: text("name").notNull(),
    schema: json("schema").notNull(),
    created_at: timestamp("created_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
    owner: varchar("owner", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
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

export const tool_policy = pgTable(
  "tool_policy",
  {
    id: varchar("id", { length: 255 }).notNull(),
    pattern: text("pattern").notNull(),
    action: text("action").notNull(),
    position: text("position").notNull(),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
    owner: varchar("owner", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
  },
  (table) => [
    uniqueIndex("tool_policy_uidx").on(table.tenant, table.owner, table.subject, table.id),
  ],
);

export const plugin_storage = pgTable(
  "plugin_storage",
  {
    plugin_id: varchar("plugin_id", { length: 255 }).notNull(),
    collection: varchar("collection", { length: 255 }).notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    data: json("data").notNull(),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
    owner: varchar("owner", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
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

export const blob = pgTable(
  "blob",
  {
    namespace: varchar("namespace", { length: 255 }).notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    value: text("value").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    id: varchar("id", { length: 255 }).notNull(),
  },
  (table) => [uniqueIndex("blob_id_uidx").on(table.id)],
);

export const private_executor_cloud_settings = pgTable("private_executor_cloud_settings", {
  id: varchar("id", { length: 255 }).primaryKey().notNull(),
  version: varchar("version", { length: 255 }).notNull().default("1.0.0"),
});
