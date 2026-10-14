/**
 * Read-only access to Executor v1 for the import: its WorkOS (membership and Vault), its Postgres
 * through the read-only role, its blobs and its Autumn plan. Errors never carry emails,
 * organization ids, secret values or response bodies.
 */
import { PgClient } from "@effect/sql-pg";
import { Effect, Option, type Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { AutumnClient, type AutumnOptions } from "../../contracts/autumn.ts";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";
import { autumnLive, autumnReads } from "../autumn-client.ts";
import { freePlans } from "../v1-membership.ts";
import {
  ArtifactRow,
  ConnectionRow,
  IntegrationRow,
  OAuthClientRow,
  OpenApiBindingRow,
  OpenApiOperationRow,
  PolicyRow,
  ToolkitRow,
  ToolkitRuleRow,
  ToolRow,
  blobKey,
  vaultObjectName,
} from "./formats.ts";

/** Where v1 kept plugin blobs: R2 in production, or its Postgres `blob` table without R2. */
export interface V1Blobs {
  /** The item's failure reason when a blob is absent. */
  readonly missing: string;
  /** The blob's stored bytes. */
  readonly get: (
    key: ReturnType<typeof blobKey>,
  ) => Effect.Effect<Option.Option<Uint8Array>, V1ImportUnavailable>;
}

export interface V1SourceSettings {
  /** v1's WorkOS API origin, or an emulator instance in tests. */
  readonly workosUrl: string;
  /** v1's WorkOS key, with Vault read access. */
  readonly workosKey: Redacted.Redacted<string>;
  /** v1's Postgres through the read-only role. */
  readonly database: Redacted.Redacted<string>;
  /** The Autumn account that bills v1, keyed by WorkOS organization id. */
  readonly billing: AutumnOptions;
  /** `postgres` reads v1's `blob` table, as v1 does without an R2 binding. */
  readonly blobs: "postgres" | V1Blobs;
  /** v1's dashboard origin. v1 serves an organization's dashboard at `<origin>/<slug>`. */
  readonly dashboardOrigin: string;
}

const Users = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const Memberships = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      user_id: Schema.String,
      organization_id: Schema.String,
      organization_name: Schema.optional(Schema.NullOr(Schema.String)),
      status: Schema.String,
    }),
  ),
});
const VaultObject = Schema.Struct({ value: Schema.String });
const Organizations = Schema.Array(Schema.Struct({ name: Schema.String, slug: Schema.String }));
const OrganizationSlugs = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));
const Values = Schema.Array(Schema.Struct({ value: Schema.String }));

/** Everything an import plan reads about one v1 organization, for its single member. */
export interface V1Snapshot {
  readonly tenant: string;
  readonly member: string;
  readonly organization: { readonly name: string; readonly slug: string };
  readonly integrations: readonly IntegrationRow[];
  readonly connections: readonly ConnectionRow[];
  readonly clients: readonly OAuthClientRow[];
  readonly policies: readonly PolicyRow[];
  readonly toolkits: readonly ToolkitRow[];
  /** Toolkits' connection and policy rules, in the same owner partitions as their toolkits. */
  readonly toolkitRules: readonly ToolkitRuleRow[];
  readonly artifacts: readonly ArtifactRow[];
}

/** Every read failure is `V1ImportUnavailable`; the log names only the kind of read. */
const unavailable =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError(() => Effect.logWarning(`v1 import read failed: ${operation}`)),
      Effect.mapError(() => new V1ImportUnavailable()),
    );

/** The rows visible to the organization's single member: org-owned and that member's own. */
const ownedBy = (sql: SqlClient.SqlClient, member: string) =>
  sql`(owner = 'org' or (owner = 'user' and subject = ${member}))`;

/**
 * SQL reads of one v1 organization. Every statement filters by `tenant` and keeps only org rows
 * and the member's own rows; other subjects' rows are never read.
 */
export const readSnapshot = (tenant: string, member: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const visible = ownedBy(sql, member);
    const organization = yield* sql`
      select name, slug from organizations where id = ${tenant} and deleted_at is null
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Organizations)));
    const found = organization[0];
    if (found === undefined) return yield* new V1ImportUnavailable();
    const integrations = yield* sql`
      select row_id, slug, plugin_id, name, config, health_check,
        (extract(epoch from created_at) * 1000)::float8 as created_ms
      from integration where tenant = ${tenant} order by created_at, slug
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(IntegrationRow))));
    const connections = yield* sql`
      select row_id, owner, subject, integration, name, template, provider, item_ids,
        oauth_client, oauth_client_owner, refresh_item_id, expires_at::float8 as expires_at,
        oauth_scope, oauth_token_url,
        (extract(epoch from created_at) * 1000)::float8 as created_ms
      from connection where tenant = ${tenant} and ${visible}
      order by created_at, row_id
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConnectionRow))));
    const clients = yield* sql`
      select row_id, owner, subject, slug, authorization_url, token_url, "grant", client_id,
        client_secret_item_id, token_endpoint_auth_method, resource, origin_kind, origin_issuer,
        origin_redirect_uri
      from oauth_client where tenant = ${tenant} and ${visible}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OAuthClientRow))));
    const policies = yield* sql`
      select row_id, owner, subject, id, pattern, action, position
      from tool_policy where tenant = ${tenant} and ${visible}
      order by owner, position, id
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PolicyRow))));
    const toolkits = yield* sql`
      select row_id, owner, subject, key, data from plugin_storage
      where tenant = ${tenant} and plugin_id = 'toolkits' and collection = 'toolkits' and ${visible}
      order by key
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ToolkitRow))));
    const toolkitRules = yield* sql`
      select owner, subject, collection, data from plugin_storage
      where tenant = ${tenant} and plugin_id = 'toolkits'
        and collection in ('toolkitConnections', 'toolkitPolicies') and ${visible}
      order by key
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ToolkitRuleRow))));
    const artifacts = yield* sql`
      select row_id, owner, subject, id, title, description, code, bindings from artifact
      where tenant = ${tenant} and ${visible} order by created_at, id
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ArtifactRow))));
    return {
      tenant,
      member,
      organization: found,
      integrations,
      connections,
      clients,
      policies,
      toolkits,
      toolkitRules,
      artifacts,
    } satisfies V1Snapshot;
  });

/** The slugs of these live v1 organizations, by WorkOS id. Deleted ones are absent. */
export const readSlugs = (organizations: readonly [string, ...string[]]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select id, slug from organizations
      where ${sql.in("id", organizations)} and deleted_at is null
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrganizationSlugs)));
    return new Map(rows.map((row) => [row.id, row.slug]));
  });

/** The tools v1 last listed for an integration, with the MCP server's own names. */
export const readTools = (tenant: string, member: string, integration: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      select owner, connection, name, annotations::jsonb -> 'mcp' ->> 'toolName' as upstream
      from tool where tenant = ${tenant} and integration = ${integration} and ${ownedBy(sql, member)}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ToolRow))));
  });

/** The OpenAPI operations v1 compiled for an integration: tool name, method and path. */
export const readOpenApiOperations = (tenant: string, integration: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      select data::jsonb ->> 'toolName' as tool,
        data::jsonb -> 'binding' ->> 'method' as method,
        data::jsonb -> 'binding' ->> 'pathTemplate' as path
      from plugin_storage
      where tenant = ${tenant} and owner = 'org' and plugin_id = 'openapi'
        and collection = 'operation' and data::jsonb ->> 'integration' = ${integration}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OpenApiOperationRow))));
  });

/** The binding v1 stored for one OpenAPI tool of an integration, which v1 invokes. */
export const readOpenApiBinding = (tenant: string, integration: string, tool: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select data::jsonb -> 'binding' as binding
      from plugin_storage
      where tenant = ${tenant} and owner = 'org' and plugin_id = 'openapi'
        and collection = 'operation' and data::jsonb ->> 'integration' = ${integration}
        and data::jsonb ->> 'toolName' = ${tool}
      limit 1
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OpenApiBindingRow))));
    return rows[0]?.binding;
  });

/** v1's state for one request: WorkOS, Vault, Postgres, blobs and billing. */
export const makeV1Source = (settings: V1SourceSettings) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const workos = http.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(settings.workosUrl),
          HttpClientRequest.bearerToken(settings.workosKey),
          HttpClientRequest.acceptJson,
        ),
      ),
    );
    const checked = workos.pipe(HttpClient.filterStatusOk);
    const get = <S extends Schema.Top>(path: string, params: Record<string, string>, schema: S) =>
      checked
        .execute(HttpClientRequest.get(path).pipe(HttpClientRequest.setUrlParams(params)))
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        );
    /** One read-only SQL client per call, as the membership check uses v1's database. */
    const database = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(
          sql`set transaction read only`.pipe(Effect.andThen(work)),
        );
      }).pipe(
        Effect.provide(
          PgClient.layer({
            url: settings.database,
            maxConnections: 1,
            prepare: false,
            connectTimeout: "5 seconds",
          }),
        ),
      );
    /**
     * v1's Postgres `blob` table, which v1 uses when it has no R2 binding. Its `value` is `text` in a
     * UTF-8 database, so the stored bytes are the value's UTF-8 encoding.
     */
    const postgresBlobs: V1Blobs = {
      missing: "v1's stored specification is missing.",
      get: (key) =>
        database(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql`
              select value from blob where namespace = ${key.namespace} and key = ${key.key}
            `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Values)));
            return Option.fromNullishOr(rows[0]?.value).pipe(
              Option.map((value) => new TextEncoder().encode(value)),
            );
          }),
        ).pipe(unavailable("blob")),
    };
    const blobs = settings.blobs === "postgres" ? postgresBlobs : settings.blobs;
    const autumn = AutumnClient.pipe(
      Effect.provide(autumnLive(settings.billing, autumnReads.patient)),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    return {
      /** The WorkOS user with this email and its active v1 organizations, with their names. */
      memberships: (email: string) =>
        Effect.gen(function* () {
          const users = yield* get("/user_management/users", { email }, Users);
          // WorkOS emails are unique, so this is at most one user.
          const user = users.data[0];
          if (user === undefined) return { user: undefined, organizations: [] };
          const memberships = yield* get(
            "/user_management/organization_memberships",
            { user_id: user.id, statuses: "active", limit: "100" },
            Memberships,
          );
          return {
            user: user.id,
            organizations: memberships.data
              .filter((membership) => membership.status === "active")
              .map((membership) => ({
                id: membership.organization_id,
                name: membership.organization_name ?? "",
              })),
          };
        }).pipe(unavailable("workos memberships")),
      /** The organization's active members' WorkOS user ids. */
      members: (organization: string) =>
        get(
          "/user_management/organization_memberships",
          { organization_id: organization, statuses: "active", limit: "100" },
          Memberships,
        ).pipe(
          Effect.map((memberships) =>
            memberships.data
              .filter((membership) => membership.status === "active")
              .map((membership) => membership.user_id),
          ),
          unavailable("workos members"),
        ),
      /** Whether Autumn bills the organization on a paid v1 plan. No customer means free. */
      paid: (organization: string) =>
        autumn.pipe(
          Effect.flatMap((billing) => billing.getCustomer({ customerId: organization })),
          Effect.map(
            (customer) =>
              customer !== null &&
              customer.subscriptions.some(
                (subscription) =>
                  !freePlans.includes(subscription.planId) && subscription.status !== "expired",
              ),
          ),
          unavailable("billing"),
        ),
      /** Each organization's v1 dashboard, by WorkOS id; absent when v1 has no live row. */
      dashboards: (organizations: readonly string[]) =>
        Effect.gen(function* () {
          const [first, ...rest] = organizations;
          if (first === undefined) return new Map<string, string>();
          const slugs = yield* database(readSlugs([first, ...rest]));
          return new Map(
            [...slugs].map(([id, slug]) => [
              id,
              new URL(`/${encodeURIComponent(slug)}`, settings.dashboardOrigin).href,
            ]),
          );
        }).pipe(unavailable("slugs")),
      snapshot: (tenant: string, member: string) =>
        database(readSnapshot(tenant, member)).pipe(unavailable("snapshot")),
      tools: (tenant: string, member: string, integration: string) =>
        database(readTools(tenant, member, integration)).pipe(unavailable("tools")),
      openApiOperations: (tenant: string, integration: string) =>
        database(readOpenApiOperations(tenant, integration)).pipe(unavailable("operations")),
      openApiBinding: (tenant: string, integration: string, tool: string) =>
        database(readOpenApiBinding(tenant, integration, tool)).pipe(unavailable("binding")),
      blob: (tenant: string, plugin: string, key: string) =>
        blobs.get(blobKey(tenant, plugin, key)),
      blobMissing: blobs.missing,
      /**
       * A secret value from v1's Vault. Undefined when the object is missing (WorkOS answers 404,
       * or 400 for a name it rejects). The value never enters errors or logs.
       */
      secret: (input: {
        readonly tenant: string;
        readonly subject: string;
        readonly itemId: string;
      }) =>
        Effect.gen(function* () {
          const name = yield* vaultObjectName(input);
          const response = yield* workos.execute(
            HttpClientRequest.get(`/vault/v1/kv/name/${encodeURIComponent(name)}`),
          );
          if (response.status === 404 || response.status === 400) return undefined;
          if (response.status !== 200) return yield* new V1ImportUnavailable();
          const object = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(VaultObject)),
          );
          return object.value;
        }).pipe(unavailable("vault")),
    };
  });

export type V1Source = Effect.Success<ReturnType<typeof makeV1Source>>;
