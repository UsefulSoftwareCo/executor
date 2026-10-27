import { column, idColumn, table, type AnyColumn, type AnyTable } from "@executor-js/fumadb/schema";
import type { Condition, ConditionBuilder } from "@executor-js/fumadb/query";

import { StorageError, type FumaRow } from "./fuma-runtime";
import {
  assertOwnerPatch,
  assertOwnerWritable,
  assertReachReadOnly,
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
      // Tenant-scoped reads are already tenant-wide, so reach doesn't widen
      // them — but the platform view must stay read-only on EVERY table it can
      // reach, and `subject` is one of these.
      assertReachReadOnly(name, "write", context);
      if (values.tenant !== context.tenant) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: FumaDB table policy callbacks are promise callbacks, not Effect effects
        throw new StorageError({
          message: `Storage write on table "${name}" is outside the executor tenant.`,
          cause: undefined,
        });
      }
    },
    onUpdate: ({ builder, context }) => {
      assertReachReadOnly(name, "write", context);
      return builder("tenant", "=", context.tenant);
    },
    onDelete: ({ builder, context }) => {
      assertReachReadOnly(name, "delete", context);
      return builder("tenant", "=", context.tenant);
    },
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
    // A delete carries no values to assert against, so the reach guard is the
    // ONLY thing standing between a widened (platform-view) context and a
    // tenant-wide delete — `ownerVisibility` would happily match every row.
    onDelete: ({ builder, context }) => {
      assertReachReadOnly(name, "delete", context);
      return ownerVisibility(builder, context);
    },
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
      // Display name. The pre-split field: `description` used to hold the
      // name, so cloud backfills `name` from it (migration 0006) and other
      // hosts fall back at read time (see rowToIntegration). Nullable because
      // SQLite boot-ensure hosts cannot add a NOT NULL column to existing
      // tables, so the column stays nullable even though it is always present
      // in practice.
      name: nullableTextColumn("name"),
      // Actual prose description, now distinct from the name. Nullable: absent
      // until a user/spec supplies one (cloud clears the old duplicated title
      // to NULL in 0006).
      description: nullableTextColumn("description"),
      config: nullableJsonColumn("config"),
      // The declared health check (HealthCheckSpec JSON): which authenticated
      // operation a connection runs to prove its credential is alive and whose
      // account it is. CORE-owned, deliberately NOT inside `config`, so no
      // plugin's config decode/re-encode cycle can silently strip it and no
      // plugin schema has to declare it. Null = no check declared.
      health_check: nullableJsonColumn("health_check"),
      // Epoch ms of the last tool-affecting config change (spec update, auth
      // template edit). Compared against each connection's `tools_synced_at`
      // so OTHER subjects' connections — whose tool rows the updater cannot
      // write under the owner policy — lazily rebuild on their next read.
      config_revised_at: nullableBigintColumn("config_revised_at"),
      can_remove: boolColumn("can_remove", true),
      can_refresh: boolColumn("can_refresh", false),
      created_at: dateColumn("created_at"),
      updated_at: dateColumn("updated_at"),
    },
    ["tenant", "slug"],
  ),

  // The join between a host's identity system (WorkOS accounts, Better Auth
  // members, the local single-user sentinel) and the `subject` partition key
  // smeared across the owned tables. NOT an identity system of its own: the
  // hosts stay authoritative for names, emails, and membership. This table
  // only records that a principal has been seen under this tenant, so a user
  // who has no connection row is still answerable.
  //
  // Tenant-scoped, not owner-scoped, on purpose: any executor bound to the
  // tenant may read it, which is what an operator-level (cross-subject) view
  // needs, and it costs zero policy changes.
  subject: tenantExecutorTable(
    "subject",
    {
      // The host-auth principal id (cloud: the WorkOS accountId). Opaque here
      // — it also carries host sentinels like "local", so nothing may parse it.
      external_id: keyColumn("external_id"),
      created_at: dateColumn("created_at"),
      // Epoch ms of the last sighting on the request path. Nullable so a row
      // can be created (e.g. at connection-create) before any sighting is
      // recorded; bigint rather than a timestamp to match the other
      // "last X happened at" columns here (`tools_synced_at`, `expires_at`).
      last_seen_at: nullableBigintColumn("last_seen_at"),
      // Subject lifecycle. Left as an unconstrained nullable string until the
      // lifecycle values are actually defined; null means "no state recorded".
      status: nullableTextColumn("status"),
    },
    ["tenant", "external_id"],
  ),

  // Delegated credentials are deliberately tenant-scoped and are only exposed
  // through the delegation service. They are not owner rows: the row belongs
  // to the grant, while the effective subject is an immutable field inside it.
  // `scope` contains the exact consent snapshot; it is never re-expanded from
  // mutable toolkit rows during dispatch.
  credential_delegation: (() => {
    const out = tenantExecutorTable(
      "credential_delegation",
      {
        id: keyColumn("id"),
        label: keyColumn("label"),
        created_by: keyColumn("created_by"),
        credential_id: keyColumn("credential_id"),
        credential_kind: keyColumn("credential_kind"),
        adapter: keyColumn("adapter"),
        issuer: textColumn("issuer"),
        audience: textColumn("audience"),
        credential_subject: textColumn("credential_subject"),
        credential_ref: keyColumn("credential_ref"),
        issued_key_ref: nullableKeyColumn("issued_key_ref"),
        key_hash: nullableKeyColumn("key_hash"),
        actor_subject: keyColumn("actor_subject"),
        effective_subject: keyColumn("effective_subject"),
        toolkit_membership: jsonColumn("toolkit_membership"),
        scope: jsonColumn("scope"),
        scope_version: keyColumn("scope_version"),
        expires_at: bigintColumn("expires_at"),
        revoked_at: nullableBigintColumn("revoked_at"),
        revoke_reason: nullableTextColumn("revoke_reason"),
        created_at: dateColumn("created_at"),
        last_used_at: nullableBigintColumn("last_used_at"),
      },
      ["tenant", "id"],
    );
    out.unique("credential_delegation_binding_uidx", [
      "tenant",
      "adapter",
      "issuer",
      "audience",
      "credential_subject",
      "credential_ref",
    ]);
    // Provider/local key references are the durable revocation and rotation
    // handle. Keep them unique inside a tenant even when a malformed adapter
    // attempts to present the same reference under a different tuple.
    out.unique("credential_delegation_issued_key_ref_uidx", ["tenant", "issued_key_ref"]);
    return out;
  })(),

  // Single-use proof challenges. Only the digest is persisted; proof material
  // is supplied by the host adapter and is never written to this table.
  delegation_challenge: tenantExecutorTable(
    "delegation_challenge",
    {
      id: keyColumn("id"),
      created_by: keyColumn("created_by"),
      label: keyColumn("label"),
      credential_id: nullableKeyColumn("credential_id"),
      credential_kind: nullableKeyColumn("credential_kind"),
      adapter: keyColumn("adapter"),
      issuer: nullableTextColumn("issuer"),
      audience: nullableTextColumn("audience"),
      credential_subject: nullableTextColumn("credential_subject"),
      credential_ref: nullableKeyColumn("credential_ref"),
      actor_subject: nullableKeyColumn("actor_subject"),
      effective_subject: keyColumn("effective_subject"),
      scope: jsonColumn("scope"),
      proof_hash: keyColumn("proof_hash"),
      expires_at: bigintColumn("expires_at"),
      grant_expires_at: bigintColumn("grant_expires_at"),
      proof_consumed_at: nullableBigintColumn("proof_consumed_at"),
      consent_consumed_at: nullableBigintColumn("consent_consumed_at"),
      created_at: dateColumn("created_at"),
    },
    ["tenant", "id"],
  ),

  // Append-only operational audit. The service accepts identifiers and
  // outcomes only; arguments, results, tokens, and authorization headers are
  // intentionally absent from this schema.
  delegation_audit: tenantExecutorTable(
    "delegation_audit",
    {
      id: keyColumn("id"),
      grant_id: nullableKeyColumn("grant_id"),
      credential_id: nullableKeyColumn("credential_id"),
      actor_subject: keyColumn("actor_subject"),
      effective_subject: keyColumn("effective_subject"),
      action: keyColumn("action"),
      tool: nullableTextColumn("tool"),
      outcome: keyColumn("outcome"),
      request_id: nullableTextColumn("request_id"),
      execution_id: nullableTextColumn("execution_id"),
      occurred_at: dateColumn("occurred_at"),
    },
    ["tenant", "id"],
  ),

  // Durable target-owned notices for grants created by another subject. The
  // service writes these in the same transaction as the grant, so a notice
  // failure cannot leave an active delegated credential without a notification.
  delegation_notification: (() => {
    const out = tenantExecutorTable(
      "delegation_notification",
      {
        id: keyColumn("id"),
        grant_id: keyColumn("grant_id"),
        credential_id: keyColumn("credential_id"),
        created_by: keyColumn("created_by"),
        target_subject: keyColumn("target_subject"),
        label: keyColumn("label"),
        credential_kind: keyColumn("credential_kind"),
        created_at: dateColumn("created_at"),
        read_at: nullableBigintColumn("read_at"),
      },
      ["tenant", "id"],
    );
    out.unique("delegation_notification_grant_target_uidx", [
      "tenant",
      "grant_id",
      "target_subject",
    ]);
    return out;
  })(),

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
      // Executor ownership for this row's credential references, as JSON
      // `{ runtimeId: string, attemptId: string }` (see
      // credential-item-reference.ts). Null means every provider item id is
      // external/legacy and therefore opaque to core — never repairable.
      credential_write: nullableJsonColumn("credential_write"),
      identity_label: nullableTextColumn("identity_label"),
      // User-curated, agent-visible "what is this connection for". Settable at
      // create, editable after; never reset by OAuth re-mints.
      description: nullableTextColumn("description"),
      // Last health-check outcome (HealthCheckResult JSON: status, httpStatus,
      // checkedAt, identity, detail). Written by every checkHealth run so the
      // accounts list shows alive/expired AT A GLANCE (the customer ask)
      // instead of only after a per-row manual probe. Null = never checked.
      last_health: nullableJsonColumn("last_health"),
      // Epoch ms of the last tool (re)production for this connection. Stale
      // vs the integration's `config_revised_at` → re-produced on next read.
      tools_synced_at: nullableBigintColumn("tools_synced_at"),
      oauth_client: nullableTextColumn("oauth_client"),
      // The OWNER of `oauth_client` (a Personal connection may be minted through
      // a shared Workspace app), set together with `oauth_client`; null for
      // static creds. Stored so every deref (refresh/complete/reconnect) reads it
      // verbatim instead of re-deriving it via a sharing rule.
      oauth_client_owner: nullableTextColumn("oauth_client_owner"),
      refresh_item_id: nullableTextColumn("refresh_item_id"),
      expires_at: nullableBigintColumn("expires_at"),
      oauth_scope: nullableTextColumn("oauth_scope"),
      // Per-connection token endpoint override. Set only when the code was
      // redeemed at a region other than the oauth_client's configured token host
      // (multi-site providers like Datadog signal the org's region on the
      // callback). Null means refresh uses the oauth_client's `token_url`.
      oauth_token_url: nullableTextColumn("oauth_token_url"),
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
      // Executor ownership for `client_secret_item_id`, as JSON
      // `{ runtimeId: string, attemptId: string }` (see
      // credential-item-reference.ts). Null means the provider reference is
      // external/legacy and therefore opaque to core — never repairable.
      credential_write: nullableJsonColumn("credential_write"),
      // Null in old rows means client_secret_post (the existing default).
      // Stored values are "body" or "basic" and are validated on read.
      token_endpoint_auth_method: nullableTextColumn("token_endpoint_auth_method"),
      // RFC 8707 Resource Indicator (MCP). Sent on the refresh request so the
      // re-minted access token stays bound to the same resource. Null when the
      // provider doesn't use resource indicators.
      resource: nullableTextColumn("resource"),
      // Where this oauth_client came from. Null in old databases is treated as
      // "manual" by the service layer.
      origin_kind: nullableTextColumn("origin_kind"),
      origin_integration: nullableTextColumn("origin_integration"),
      // Authorization-server issuer that owns a DCR client, keying per-AS reuse.
      // For a NEW DCR registration this is the DISCOVERED OIDC issuer (real
      // information from the AS metadata, which can legitimately differ from what
      // token_url would suggest). For a BACKFILLED legacy row it is instead a
      // derived registrable-origin of token_url (a cache of the pure
      // `registrableOriginOfUrl`, since no discovered issuer was ever recorded).
      // Null for manual clients and legacy rows not yet backfilled.
      origin_issuer: nullableTextColumn("origin_issuer"),
      // The redirect URI a DCR client registered with the authorization server
      // (RFC 7591 `redirect_uris`, always the single flow callback here).
      // Strict servers reject an authorize request whose redirect_uri differs
      // from the registration, so DCR reuse compares this against the current
      // flow callback and re-registers on mismatch. Null for manual clients and
      // for DCR rows written before this column existed — treated as matching,
      // since re-registering every legacy client on upgrade would churn
      // providers for the majority whose callback never changed.
      origin_redirect_uri: nullableTextColumn("origin_redirect_uri"),
      // The space-delimited scopes a DCR registration asked for (RFC 7591
      // `scope`); empty when it sent none. Reuse picks a client only when the
      // scopes it asked for cover the request, so a server that has since
      // added scopes gets a new registration rather than refusing every
      // reconnect through the old client. Null for manual clients and for DCR
      // rows written before this column existed: unlike the redirect URI, a
      // missing record is not treated as covering.
      origin_requested_scopes: nullableTextColumn("origin_requested_scopes"),
      // The space-delimited scopes the server registered the client for, from
      // the registration response's `scope` (RFC 7591 §3.2.1; the server may
      // narrow what was asked for). A server may refuse an authorize request
      // for a scope outside them, so start never asks for more. Null when the
      // response did not say, for manual clients and for older rows.
      origin_scopes: nullableTextColumn("origin_scopes"),
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
      // text, NOT keyColumn: $def names exceed 255 chars in production (deep
      // OpenAPI component paths), and the live cloud column has been TEXT
      // since the baseline was patched for it. A varchar(255) here re-emits a
      // narrowing ALTER on every drizzle-kit generate, which fails on real
      // rows (22001) — that drift broke cloud migration 0013 once already.
      name: textColumn("name"),
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

  // A saved generative-UI artifact — the JSX source a model produced, kept so
  // it can be re-rendered later and matched by title/description from any MCP
  // client. Owner-scoped like every other personal row: artifacts are created
  // at the `user` tier, and the `org` tier the table already carries is what
  // sharing will use later without new machinery.
  artifact: ownedExecutorTable(
    "artifact",
    {
      id: keyColumn("id"),
      title: textColumn("title"),
      // Model-supplied prose the agent matches against ("my active users
      // dashboard"). Nullable: the title alone is enough to save one.
      description: nullableTextColumn("description"),
      // The JSX source. Free-form TEXT, never indexed.
      code: textColumn("code"),
      // `role -> { integration, owner, connection }`: which connection each
      // integration role in `code` resolves to. Artifact source addresses
      // integrations, not connections (`tools.vercel.domains.getDomains`), so
      // the account identity lives HERE, out of the source, where rebinding a
      // shared artifact is a row update rather than a rewrite.
      //
      // Nullable for the artifacts saved before this contract existed: their
      // code carries full five-segment paths and runs as written. See
      // `resolveCallAddress` in `@executor-js/host-mcp`.
      bindings: nullableJsonColumn("bindings"),
      // What the gallery shows instead of a schematic: sanitized markup from
      // the create-time smoke render, or a raster snapshot captured once the
      // artifact has been opened and settled. Discriminated by shape — a data
      // URL is the image, anything else is markup. See `artifact-preview.ts`
      // for the sanitizer and for why the markup carries no live data.
      //
      // Nullable, and every reader falls back: artifacts saved before this
      // column existed have none, and so does one whose render was too large,
      // failed open, or has never been opened.
      preview: nullableTextColumn("preview"),
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
export type SubjectRow = FumaRow<CoreSchema["subject"]>;
export type CredentialDelegationRow = FumaRow<CoreSchema["credential_delegation"]>;
export type DelegationChallengeRow = FumaRow<CoreSchema["delegation_challenge"]>;
export type DelegationAuditRow = FumaRow<CoreSchema["delegation_audit"]>;
export type DelegationNotificationRow = FumaRow<CoreSchema["delegation_notification"]>;
export type ConnectionRow = FumaRow<CoreSchema["connection"]>;
export type OAuthClientRow = FumaRow<CoreSchema["oauth_client"]>;
export type OAuthSessionRow = FumaRow<CoreSchema["oauth_session"]>;
export type ToolRow = FumaRow<CoreSchema["tool"]>;
/** The tool-row projection the invoke/list hot paths load: everything except
 *  the heavy `input_schema`/`output_schema` JSON, which only `tools.schema`
 *  (describe) needs. Plugin `invokeTool` receives this shape — operation
 *  details ride in plugin storage or `annotations`, not the row schemas. */
export type ToolInvocationRow = Omit<ToolRow, "input_schema" | "output_schema">;
/** The columns backing {@link ToolInvocationRow}, for `select` projections. */
export const TOOL_INVOCATION_COLUMNS = [
  "tenant",
  "owner",
  "subject",
  "integration",
  "connection",
  "plugin_id",
  "name",
  "description",
  "annotations",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof ToolRow)[];
export type DefinitionRow = FumaRow<CoreSchema["definition"]>;
export type ToolPolicyRow = FumaRow<CoreSchema["tool_policy"]>;
export type ArtifactRow = FumaRow<CoreSchema["artifact"]>;
/**
 * The columns a list projects — everything except the JSX source, which only a
 * full read needs.
 *
 * `preview` is here on purpose, and it is the one heavy-ish column that earns
 * its place: the gallery IS the list, so a preview fetched anywhere else would
 * be a second round trip per card to render the thing the card is made of.
 * It is bounded at
 * {@link ARTIFACT_PREVIEW_MARKUP_LIMIT} precisely so this projection stays
 * affordable — `code` has no such bound, which is why it stays out.
 */
export const ARTIFACT_SUMMARY_COLUMNS = [
  "owner",
  "id",
  "title",
  "description",
  "preview",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof ArtifactRow)[];
/** The artifact-row projection {@link ARTIFACT_SUMMARY_COLUMNS} selects. */
export type ArtifactSummaryRow = Pick<ArtifactRow, (typeof ARTIFACT_SUMMARY_COLUMNS)[number]>;
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
