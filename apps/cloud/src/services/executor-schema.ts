import { pgTable, text, boolean, timestamp, varchar, uniqueIndex, json, bigint } from "drizzle-orm/pg-core"
import { createId } from "fumadb/cuid"

export const source = pgTable("source", {
  plugin_id: text("plugin_id").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  url: text("url"),
  can_remove: boolean("can_remove").notNull().default(true),
  can_refresh: boolean("can_refresh").notNull().default(false),
  can_edit: boolean("can_edit").notNull().default(false),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull(),
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("source_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const tool = pgTable("tool", {
  source_id: text("source_id").notNull(),
  plugin_id: text("plugin_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  input_schema: json("input_schema"),
  output_schema: json("output_schema"),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull(),
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("tool_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const definition = pgTable("definition", {
  source_id: text("source_id").notNull(),
  plugin_id: text("plugin_id").notNull(),
  name: text("name").notNull(),
  schema: json("schema").notNull(),
  created_at: timestamp("created_at").notNull(),
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("definition_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const secret = pgTable("secret", {
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  owned_by_connection_id: text("owned_by_connection_id"),
  created_at: timestamp("created_at").notNull(),
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("secret_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const connection = pgTable("connection", {
  provider: text("provider").notNull(),
  identity_label: text("identity_label"),
  access_token_secret_id: text("access_token_secret_id").notNull(),
  refresh_token_secret_id: text("refresh_token_secret_id"),
  expires_at: bigint("expires_at", { mode: "bigint" }),
  scope: text("scope"),
  provider_state: json("provider_state"),
  identity_override: json("identity_override"),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull(),
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("connection_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const oauth2_session = pgTable("oauth2_session", {
  plugin_id: text("plugin_id").notNull(),
  strategy: text("strategy").notNull(),
  connection_id: text("connection_id").notNull(),
  token_scope: text("token_scope").notNull(),
  redirect_url: text("redirect_url").notNull(),
  payload: json("payload").notNull(),
  expires_at: bigint("expires_at", { mode: "bigint" }).notNull(),
  created_at: timestamp("created_at").notNull(),
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("oauth2_session_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const credential_binding = pgTable("credential_binding", {
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
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("credential_binding_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const plugin_storage = pgTable("plugin_storage", {
  plugin_id: text("plugin_id").notNull(),
  collection: text("collection").notNull(),
  key: text("key").notNull(),
  data: json("data").notNull(),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull(),
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("plugin_storage_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const tool_policy = pgTable("tool_policy", {
  pattern: text("pattern").notNull(),
  action: text("action").notNull(),
  position: text("position").notNull(),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull(),
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("tool_policy_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const blob = pgTable("blob", {
  namespace: text("namespace").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("blob_id_uidx").on(table.id)
])

export const private_executor_cloud_settings = pgTable("private_executor_cloud_settings", {
  id: varchar("id", { length: 255 }).primaryKey().notNull(),
  version: varchar("version", { length: 255 }).notNull().default("1.0.0")
})