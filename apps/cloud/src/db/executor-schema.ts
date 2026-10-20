import {
  pgTable,
  varchar,
  text,
  json,
  bigint,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId } from "@executor-js/fumadb/cuid";

export const integration = pgTable(
  "integration",
  {
    slug: varchar("slug", { length: 255 }).notNull(),
    plugin_id: text("plugin_id").notNull(),
    name: text("name"),
    description: text("description"),
    config: json("config"),
    health_check: json("health_check"),
    config_revised_at: bigint("config_revised_at", { mode: "bigint" }),
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

export const subject = pgTable(
  "subject",
  {
    external_id: varchar("external_id", { length: 255 }).notNull(),
    created_at: timestamp("created_at").notNull(),
    last_seen_at: bigint("last_seen_at", { mode: "bigint" }),
    status: text("status"),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
  },
  (table) => [uniqueIndex("subject_uidx").on(table.tenant, table.external_id)],
);

export const credential_delegation = pgTable(
  "credential_delegation",
  {
    id: varchar("id", { length: 255 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    created_by: varchar("created_by", { length: 255 }).notNull(),
    credential_id: varchar("credential_id", { length: 255 }).notNull(),
    credential_kind: varchar("credential_kind", { length: 255 }).notNull(),
    adapter: varchar("adapter", { length: 255 }).notNull(),
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    credential_subject: text("credential_subject").notNull(),
    credential_ref: varchar("credential_ref", { length: 255 }).notNull(),
    issued_key_ref: varchar("issued_key_ref", { length: 255 }),
    key_hash: varchar("key_hash", { length: 255 }),
    actor_subject: varchar("actor_subject", { length: 255 }).notNull(),
    effective_subject: varchar("effective_subject", { length: 255 }).notNull(),
    toolkit_membership: json("toolkit_membership").notNull(),
    scope: json("scope").notNull(),
    scope_version: varchar("scope_version", { length: 255 }).notNull(),
    expires_at: bigint("expires_at", { mode: "bigint" }).notNull(),
    revoked_at: bigint("revoked_at", { mode: "bigint" }),
    revoke_reason: text("revoke_reason"),
    created_at: timestamp("created_at").notNull(),
    last_used_at: bigint("last_used_at", { mode: "bigint" }),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
  },
  (table) => [
    uniqueIndex("credential_delegation_uidx").on(table.tenant, table.id),
    uniqueIndex("credential_delegation_binding_uidx").on(
      table.tenant,
      table.adapter,
      table.issuer,
      table.audience,
      table.credential_subject,
      table.credential_ref,
    ),
    uniqueIndex("credential_delegation_issued_key_ref_uidx").on(table.tenant, table.issued_key_ref),
  ],
);

export const delegation_challenge = pgTable(
  "delegation_challenge",
  {
    id: varchar("id", { length: 255 }).notNull(),
    created_by: varchar("created_by", { length: 255 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    credential_id: varchar("credential_id", { length: 255 }),
    credential_kind: varchar("credential_kind", { length: 255 }),
    adapter: varchar("adapter", { length: 255 }).notNull(),
    issuer: text("issuer"),
    audience: text("audience"),
    credential_subject: text("credential_subject"),
    credential_ref: varchar("credential_ref", { length: 255 }),
    actor_subject: varchar("actor_subject", { length: 255 }),
    effective_subject: varchar("effective_subject", { length: 255 }).notNull(),
    scope: json("scope").notNull(),
    proof_hash: varchar("proof_hash", { length: 255 }).notNull(),
    expires_at: bigint("expires_at", { mode: "bigint" }).notNull(),
    grant_expires_at: bigint("grant_expires_at", { mode: "bigint" }).notNull(),
    proof_consumed_at: bigint("proof_consumed_at", { mode: "bigint" }),
    consent_consumed_at: bigint("consent_consumed_at", { mode: "bigint" }),
    created_at: timestamp("created_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
  },
  (table) => [uniqueIndex("delegation_challenge_uidx").on(table.tenant, table.id)],
);

export const delegation_audit = pgTable(
  "delegation_audit",
  {
    id: varchar("id", { length: 255 }).notNull(),
    grant_id: varchar("grant_id", { length: 255 }),
    credential_id: varchar("credential_id", { length: 255 }),
    actor_subject: varchar("actor_subject", { length: 255 }).notNull(),
    effective_subject: varchar("effective_subject", { length: 255 }).notNull(),
    action: varchar("action", { length: 255 }).notNull(),
    tool: text("tool"),
    outcome: varchar("outcome", { length: 255 }).notNull(),
    request_id: text("request_id"),
    execution_id: text("execution_id"),
    occurred_at: timestamp("occurred_at").notNull(),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
  },
  (table) => [uniqueIndex("delegation_audit_uidx").on(table.tenant, table.id)],
);

export const delegation_notification = pgTable(
  "delegation_notification",
  {
    id: varchar("id", { length: 255 }).notNull(),
    grant_id: varchar("grant_id", { length: 255 }).notNull(),
    credential_id: varchar("credential_id", { length: 255 }).notNull(),
    created_by: varchar("created_by", { length: 255 }).notNull(),
    target_subject: varchar("target_subject", { length: 255 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    credential_kind: varchar("credential_kind", { length: 255 }).notNull(),
    created_at: timestamp("created_at").notNull(),
    read_at: bigint("read_at", { mode: "bigint" }),
    row_id: varchar("row_id", { length: 255 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => createId()),
    tenant: varchar("tenant", { length: 255 }).notNull(),
  },
  (table) => [
    uniqueIndex("delegation_notification_uidx").on(table.tenant, table.id),
    uniqueIndex("delegation_notification_grant_target_uidx").on(
      table.tenant,
      table.grant_id,
      table.target_subject,
    ),
  ],
);

export const connection = pgTable(
  "connection",
  {
    integration: varchar("integration", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    template: text("template").notNull(),
    provider: text("provider").notNull(),
    item_ids: json("item_ids").notNull(),
    credential_write: json("credential_write"),
    identity_label: text("identity_label"),
    description: text("description"),
    last_health: json("last_health"),
    tools_synced_at: bigint("tools_synced_at", { mode: "bigint" }),
    oauth_client: text("oauth_client"),
    oauth_client_owner: text("oauth_client_owner"),
    refresh_item_id: text("refresh_item_id"),
    expires_at: bigint("expires_at", { mode: "bigint" }),
    oauth_scope: text("oauth_scope"),
    oauth_token_url: text("oauth_token_url"),
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
    credential_write: json("credential_write"),
    token_endpoint_auth_method: text("token_endpoint_auth_method"),
    resource: text("resource"),
    origin_kind: text("origin_kind"),
    origin_integration: text("origin_integration"),
    origin_issuer: text("origin_issuer"),
    origin_redirect_uri: text("origin_redirect_uri"),
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

export const artifact = pgTable(
  "artifact",
  {
    id: varchar("id", { length: 255 }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    code: text("code").notNull(),
    bindings: json("bindings"),
    preview: text("preview"),
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
  (table) => [uniqueIndex("artifact_uidx").on(table.tenant, table.owner, table.subject, table.id)],
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
