import { column, idColumn, table, type AnyColumn, type AnyTable } from "fumadb/schema";
import type { Condition, ConditionBuilder } from "fumadb/query";

import { StorageError, type FumaRow } from "./fuma-runtime";
import {
  assertOwnerPatch,
  assertOwnerWritable,
  executorOwnerPolicyName,
  executorTenantPolicyName,
  executorUnscopedPolicyName,
  ownerVisibilityCondition,
  type ExecutorOwnerPolicyContext,
} from "./owner-policy";

type UserColumns = Record<string, AnyColumn>;
type AnyConditionBuilder = ConditionBuilder<Record<string, AnyColumn>>;

// Column helpers. Index-participating columns use `varchar(255)` so unique
// indexes stay portable (TEXT can't be indexed without a prefix length on
// MySQL); free-form columns use `string` (TEXT).
export const textColumn = (name: string) => column(name, "string");
export const nullableTextColumn = (name: string) => column(name, "string").nullable();
export const keyColumn = (name: string) => column(name, "varchar(255)");
export const nullableKeyColumn = (name: string) => column(name, "varchar(255)").nullable();
export const boolColumn = (name: string, defaultValue: boolean) =>
  column(name, "bool").defaultTo(defaultValue);
export const bigintColumn = (name: string) => column(name, "bigint");
export const nullableBigintColumn = (name: string) => column(name, "bigint").nullable();
export const jsonColumn = (name: string) => column(name, "json");
export const nullableJsonColumn = (name: string) => column(name, "json").nullable();
export const dateColumn = (name: string) => column(name, "timestamp");

// The policy callback hands us a `ConditionBuilder` typed to the specific table's
// columns; it isn't assignable to the generic `Record<string, AnyColumn>` builder
// (column-name positions are contravariant), so accept it loosely and re-narrow.
const ownerVisibility = (builder: unknown, context: ExecutorOwnerPolicyContext) =>
  ownerVisibilityCondition(builder as AnyConditionBuilder, context) as Condition | boolean;

/** A truly global table (the blob store). Isolation is carried in the row's
 *  `namespace` (which encodes the owner partition + plugin id), not a policy. */
const unscopedExecutorTable = <const TColumns extends UserColumns>(
  name: string,
  columns: TColumns,
) => {
  const out = table(name, {
    ...columns,
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    id: keyColumn("id"),
  });
  out.unique(`${name}_id_uidx`, ["id"]);
  return out.policy({ name: executorUnscopedPolicyName });
};

/** A tenant-shared table (catalog / blobs) — partitioned only by `tenant`. */
const tenantExecutorTable = <const TColumns extends UserColumns>(
  name: string,
  columns: TColumns,
  uniqueKey: readonly string[],
) => {
  const out = table(name, {
    ...columns,
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    tenant: keyColumn("tenant"),
  });
  out.unique(`${name}_uidx`, [...uniqueKey]);
  return out.policy<ExecutorOwnerPolicyContext>({
    name: executorTenantPolicyName,
    onRead: ({ builder, context }) => builder("tenant", "=", context.tenant),
    onCreate: ({ values, context }) => {
      if (values.tenant !== context.tenant) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: FumaDB table policy callbacks are promise callbacks, not Effect effects
        throw new StorageError({
          message: `Storage write on table "${name}" is outside the executor tenant.`,
          cause: undefined,
        });
      }
    },
    onUpdate: ({ builder, context }) => builder("tenant", "=", context.tenant),
    onDelete: ({ builder, context }) => builder("tenant", "=", context.tenant),
  });
};

/** An owner-scoped table — partitioned by `(tenant, owner, subject)`, guarded by
 *  the executor owner policy. `uniqueKey` must include those three columns. */
const ownedExecutorTable = <const TColumns extends UserColumns>(
  name: string,
  columns: TColumns,
  uniqueKey: readonly string[],
) => {
  const out = table(name, {
    ...columns,
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    tenant: keyColumn("tenant"),
    owner: keyColumn("owner"),
    subject: keyColumn("subject"),
  });
  out.unique(`${name}_uidx`, [...uniqueKey]);
  return out.policy<ExecutorOwnerPolicyContext>({
    name: executorOwnerPolicyName,
    onRead: ({ builder, context }) => ownerVisibility(builder, context),
    onCreate: ({ values, context }) => assertOwnerWritable(name, values, context),
    onUpdate: ({ builder, set, create, context }) => {
      assertOwnerPatch(name, set, context);
      assertOwnerPatch(name, create, context);
      return ownerVisibility(builder, context);
    },
    onDelete: ({ builder, context }) => ownerVisibility(builder, context),
  });
};

const defineTables = <const TTables extends Record<string, AnyTable>>(tables: TTables): TTables =>
  tables;

export const coreTables = defineTables({
  // The catalog — tenant-shared integration definitions. `config` is the owning
  // plugin's opaque blob (openapi auth templates + spec; mcp url). Core never
  // parses it.
  integration: tenantExecutorTable(
    "integration",
    {
      slug: keyColumn("slug"),
      plugin_id: textColumn("plugin_id"),
      description: textColumn("description"),
      config: nullableJsonColumn("config"),
      can_remove: boolColumn("can_remove", true),
      can_refresh: boolColumn("can_refresh", false),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "slug"],
  ),

  // THE saved credential, one per (owner, integration, name). Resolves each named
  // input via `provider` + the `item_ids` map (variable → provider item id). A
  // single-secret connection is `{ "token": <id> }`; an apiKey method with two
  // distinct inputs (e.g. Datadog) carries one entry per variable. All of a
  // connection's inputs share the one `provider`. OAuth fields null for static.
  connection: ownedExecutorTable(
    "connection",
    {
      integration: keyColumn("integration"),
      name: keyColumn("name"),
      template: textColumn("template"),
      provider: textColumn("provider"),
      item_ids: jsonColumn("item_ids"),
      identity_label: nullableTextColumn("identity_label"),
      oauth_client: nullableTextColumn("oauth_client"),
      // The OWNER of `oauth_client` (a Personal connection may be minted through
      // a shared Workspace app), set together with `oauth_client`; null for
      // static creds. Stored so every deref (refresh/complete/reconnect) reads it
      // verbatim instead of re-deriving it via a sharing rule.
      oauth_client_owner: nullableTextColumn("oauth_client_owner"),
      refresh_item_id: nullableTextColumn("refresh_item_id"),
      expires_at: nullableBigintColumn("expires_at"),
      oauth_scope: nullableTextColumn("oauth_scope"),
      provider_state: nullableJsonColumn("provider_state"),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "owner", "subject", "integration", "name"],
  ),

  // A registered OAuth app — owner-scoped (shared org app or a member's BYO app).
  // A registered OAuth app — pure app identity (id/secret + endpoints). It carries
  // NO scopes: what to request is the integration's concern, so the same app can
  // back any integration. The granted scope is recorded per-connection
  // (`connection.oauth_scope`).
  oauth_client: ownedExecutorTable(
    "oauth_client",
    {
      slug: keyColumn("slug"),
      authorization_url: textColumn("authorization_url"),
      token_url: textColumn("token_url"),
      grant: textColumn("grant"),
      client_id: textColumn("client_id"),
      // The client secret is NOT stored inline — it's a provider `item_id` that
      // resolves to the value via the default writable credential provider
      // (WorkOS Vault on cloud, the local store on desktop). Null for public /
      // PKCE clients (no secret). Keeps secrets out of plaintext columns.
      client_secret_item_id: nullableTextColumn("client_secret_item_id"),
      // RFC 8707 Resource Indicator (MCP). Sent on the refresh request so the
      // re-minted access token stays bound to the same resource. Null when the
      // provider doesn't use resource indicators.
      resource: nullableTextColumn("resource"),
      // Where this oauth_client came from. Null in old databases is treated as
      // "manual" by the service layer.
      origin_kind: nullableTextColumn("origin_kind"),
      origin_integration: nullableTextColumn("origin_integration"),
      created_at: dateColumn("created_at"),
    },
    ["tenant", "owner", "subject", "slug"],
  ),

  // In-flight OAuth authorization-code flow, keyed by the minted `state`.
  oauth_session: ownedExecutorTable(
    "oauth_session",
    {
      state: keyColumn("state"),
      client_slug: textColumn("client_slug"),
      integration: textColumn("integration"),
      name: textColumn("name"),
      template: textColumn("template"),
      redirect_url: textColumn("redirect_url"),
      pkce_verifier: nullableTextColumn("pkce_verifier"),
      identity_label: nullableTextColumn("identity_label"),
      payload: jsonColumn("payload"),
      expires_at: bigintColumn("expires_at"),
      created_at: dateColumn("created_at"),
    },
    ["tenant", "state"],
  ),

  // Persisted, per-connection tools (option C). Address is derived from
  // (integration, owner, connection, name).
  tool: ownedExecutorTable(
    "tool",
    {
      integration: keyColumn("integration"),
      connection: keyColumn("connection"),
      plugin_id: textColumn("plugin_id"),
      name: keyColumn("name"),
      description: textColumn("description"),
      input_schema: nullableJsonColumn("input_schema"),
      output_schema: nullableJsonColumn("output_schema"),
      annotations: nullableJsonColumn("annotations"),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "owner", "subject", "integration", "connection", "name"],
  ),

  // Shared JSON-schema $defs, per-connection (mirrors `tool`).
  definition: ownedExecutorTable(
    "definition",
    {
      integration: keyColumn("integration"),
      connection: keyColumn("connection"),
      plugin_id: textColumn("plugin_id"),
      name: keyColumn("name"),
      schema: jsonColumn("schema"),
      created_at: dateColumn("created_at"),
    },
    ["tenant", "owner", "subject", "integration", "connection", "name"],
  ),

  // User-authored tool policies (approve / require_approval / block).
  tool_policy: ownedExecutorTable(
    "tool_policy",
    {
      id: keyColumn("id"),
      pattern: textColumn("pattern"),
      action: textColumn("action"),
      position: textColumn("position"),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "owner", "subject", "id"],
  ),

  // Host-owned plugin storage (shared `plugin_storage` table, owner-scoped).
  plugin_storage: ownedExecutorTable(
    "plugin_storage",
    {
      plugin_id: keyColumn("plugin_id"),
      collection: keyColumn("collection"),
      key: keyColumn("key"),
      data: jsonColumn("data"),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "owner", "subject", "plugin_id", "collection", "key"],
  ),

  // Opaque blob store, global. Isolation is carried in `namespace` (which
  // encodes the owner partition + plugin id), so this table is unscoped.
  blob: unscopedExecutorTable("blob", {
    namespace: keyColumn("namespace"),
    key: keyColumn("key"),
    value: textColumn("value"),
  }),
});

export const coreSchema = coreTables;
export type CoreSchema = typeof coreTables;

export type IntegrationRow = FumaRow<CoreSchema["integration"]>;
export type ConnectionRow = FumaRow<CoreSchema["connection"]>;
export type OAuthClientRow = FumaRow<CoreSchema["oauth_client"]>;
export type OAuthSessionRow = FumaRow<CoreSchema["oauth_session"]>;
export type ToolRow = FumaRow<CoreSchema["tool"]>;
export type DefinitionRow = FumaRow<CoreSchema["definition"]>;
export type ToolPolicyRow = FumaRow<CoreSchema["tool_policy"]>;
export type PluginStorageRow = FumaRow<CoreSchema["plugin_storage"]>;
export type BlobRow = FumaRow<CoreSchema["blob"]>;

export type ToolPolicyAction = "approve" | "require_approval" | "block";

export const TOOL_POLICY_ACTIONS = [
  "approve",
  "require_approval",
  "block",
] as const satisfies readonly ToolPolicyAction[];

export const isToolPolicyAction = (value: unknown): value is ToolPolicyAction =>
  typeof value === "string" && (TOOL_POLICY_ACTIONS as readonly string[]).includes(value);
