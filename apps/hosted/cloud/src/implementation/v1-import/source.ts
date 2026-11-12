/**
 * Read-only access to Executor v1 for the import: its WorkOS (membership and Vault), its Postgres
 * through the read-only role, its blobs and its Autumn plan. Errors never carry emails,
 * organization ids, secret values or response bodies.
 */
import { PgClient } from "@effect/sql-pg";
import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  type Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { AutumnClient, type AutumnOptions } from "../../contracts/autumn.ts";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";
import { autumnLive, autumnReads } from "../autumn-client.ts";
import {
  ArtifactRow,
  ArtifactSummary,
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
  ) => Effect.Effect<Option.Option<Uint8Array>, V1ImportUnavailable | V1ImportUnreadable>;
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
}

const User = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  email_verified: Schema.Boolean,
  first_name: Schema.optional(Schema.NullOr(Schema.String)),
  last_name: Schema.optional(Schema.NullOr(Schema.String)),
});
const ListMetadata = Schema.Struct({
  list_metadata: Schema.optional(
    Schema.Struct({ after: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
});
const Memberships = Schema.Struct({
  ...ListMetadata.fields,
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      user_id: Schema.String,
      organization_id: Schema.String,
      organization_name: Schema.optional(Schema.NullOr(Schema.String)),
      status: Schema.String,
      role: Schema.optional(Schema.NullOr(Schema.Struct({ slug: Schema.String }))),
    }),
  ),
});
const VaultObject = Schema.Struct({ value: Schema.String });
/** WorkOS SSO connections; only their state is read. */
const SsoConnections = Schema.Struct({
  ...ListMetadata.fields,
  data: Schema.Array(Schema.Struct({ id: Schema.String, state: Schema.String })),
});
/** An organization's WorkOS API keys; only their ids and names are read, never their values. */
const ApiKeys = Schema.Struct({
  ...ListMetadata.fields,
  data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) })),
});
const Organizations = Schema.Array(Schema.Struct({ name: Schema.String, slug: Schema.String }));
const OrganizationIds = Schema.Array(Schema.Struct({ id: Schema.String }));
const Values = Schema.Array(Schema.Struct({ value: Schema.String }));

/** The WorkOS membership states the import reads: only `active` members move. */
export const membershipStatuses = ["active", "pending", "inactive"] as const;
export type V1MembershipStatus = (typeof membershipStatuses)[number];

/**
 * A member of a v1 organization in WorkOS: the membership's id, a ULID that orders memberships by
 * age (v1's `created_at` was overwritten by a backfill), its role and its state.
 */
export interface V1Membership {
  readonly id: string;
  readonly user: string;
  readonly role: "admin" | "member";
  readonly status: V1MembershipStatus;
}

/** A WorkOS user. Only one whose email WorkOS verified is imported (decision 17). */
export type V1User = typeof User.Type;

/**
 * Everything an import plan reads about one v1 organization: org rows and the personal rows of
 * the members it imports (`subjects`). Former members' rows are never read.
 */
export interface V1Snapshot {
  readonly tenant: string;
  /** The WorkOS user ids whose personal rows are read: the members the import moves. */
  readonly subjects: readonly [string, ...string[]];
  /** Whether the workspace has more than one active member, which decides how rules move. */
  readonly multiMember: boolean;
  readonly organization: { readonly name: string; readonly slug: string };
  readonly integrations: readonly IntegrationRow[];
  readonly connections: readonly ConnectionRow[];
  readonly clients: readonly OAuthClientRow[];
  readonly policies: readonly PolicyRow[];
  readonly toolkits: readonly ToolkitRow[];
  /** Toolkits' connection and policy rules, in the same owner partitions as their toolkits. */
  readonly toolkitRules: readonly ToolkitRuleRow[];
}

/** The organization's tables a snapshot can read. A step reads only the ones it uses. */
export type V1SnapshotTable =
  | "integrations"
  | "connections"
  | "clients"
  | "policies"
  | "toolkits"
  | "toolkitRules";
export const allSnapshotTables = [
  "integrations",
  "connections",
  "clients",
  "policies",
  "toolkits",
  "toolkitRules",
] as const satisfies readonly V1SnapshotTable[];

/** A snapshot of these tables only; the type leaves out the others, which it did not read. */
export type V1SnapshotOf<T extends V1SnapshotTable> = Pick<
  V1Snapshot,
  "tenant" | "subjects" | "multiMember" | "organization" | T
>;

/**
 * v1's Vault kept failing a read (an outage or rate limit) after a few short retries. The secret
 * may exist; the item that needed it reports the failure instead of retrying its whole step.
 */
export class V1VaultUnavailable extends Schema.TaggedError<V1VaultUnavailable>()(
  "V1VaultUnavailable",
  {},
) {}

/**
 * v1 answered, but what it returned does not have the shape the import reads: a row of `read`
 * (a table or a WorkOS listing) failed to decode. Another attempt reads the same, so it is not
 * retried; the item or organization reports it. It names the read only, never the row's data.
 */
export class V1ImportUnreadable extends Schema.TaggedError<V1ImportUnreadable>()(
  "V1ImportUnreadable",
  { read: Schema.String },
) {}

/** The report's reason for a read that did not decode. */
export const unreadableReason = (error: V1ImportUnreadable) =>
  `v1's ${error.read} could not be read: they do not have the shape the import expects.`;

/** Decode `read`'s rows, failing with `V1ImportUnreadable` when they do not decode. */
const decodeRows =
  <S extends Schema.Top>(read: string, schema: S) =>
  (rows: unknown) =>
    Schema.decodeUnknownEffect(schema)(rows).pipe(
      Effect.mapError(() => new V1ImportUnreadable({ read })),
    );

/**
 * A read's failures: `V1ImportUnreadable` when what v1 returned does not decode, which retrying
 * does not change, and `V1ImportUnavailable` for every other failure, which may clear up. The log
 * names only the kind of read.
 */
const unavailable =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError(() => Effect.logWarning(`v1 import read failed: ${operation}`)),
      Effect.mapError((error) =>
        error instanceof V1ImportUnreadable
          ? error
          : Predicate.isTagged(error, "SchemaError")
            ? new V1ImportUnreadable({ read: operation })
            : new V1ImportUnavailable(),
      ),
    );

/** Org-owned rows and these members' own. */
const ownedBy = (sql: SqlClient.SqlClient, subjects: readonly [string, ...string[]]) =>
  sql`(owner = 'org' or (owner = 'user' and ${sql.in("subject", subjects)}))`;

/**
 * SQL reads of one v1 organization: its row and the tables listed. Every statement filters by
 * `tenant` and keeps only org rows and the imported members' own rows; other subjects' rows, such
 * as former members', are never read.
 */
export const readSnapshot = <T extends V1SnapshotTable>(
  tenant: string,
  subjects: readonly [string, ...string[]],
  multiMember: boolean,
  tables: readonly T[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const visible = ownedBy(sql, subjects);
    const reads: ReadonlySet<V1SnapshotTable> = new Set(tables);
    const organization = yield* sql`
      select name, slug from organizations where id = ${tenant} and deleted_at is null
    `.pipe(Effect.flatMap(decodeRows("organizations", Organizations)));
    const found = organization[0];
    if (found === undefined) return yield* new V1ImportUnavailable();
    const integrations = reads.has("integrations")
      ? yield* sql`
          select row_id, slug, plugin_id, name, config, health_check,
            config_revised_at::float8 as config_revised_at,
            (extract(epoch from created_at) * 1000)::float8 as created_ms
          from integration where tenant = ${tenant} order by created_at, slug
        `.pipe(Effect.flatMap(decodeRows("integration rows", Schema.Array(IntegrationRow))))
      : [];
    const connections = reads.has("connections")
      ? yield* sql`
          select row_id, owner, subject, integration, name, template, provider, item_ids,
            oauth_client, oauth_client_owner, refresh_item_id, expires_at::float8 as expires_at,
            oauth_scope, oauth_token_url,
            (extract(epoch from created_at) * 1000)::float8 as created_ms
          from connection where tenant = ${tenant} and ${visible}
          order by created_at, row_id
        `.pipe(Effect.flatMap(decodeRows("connection rows", Schema.Array(ConnectionRow))))
      : [];
    const clients = reads.has("clients")
      ? yield* sql`
          select row_id, owner, subject, slug, authorization_url, token_url, "grant", client_id,
            client_secret_item_id, token_endpoint_auth_method, resource, origin_kind, origin_issuer,
            origin_redirect_uri
          from oauth_client where tenant = ${tenant} and ${visible}
        `.pipe(Effect.flatMap(decodeRows("oauth_client rows", Schema.Array(OAuthClientRow))))
      : [];
    const policies = reads.has("policies")
      ? yield* sql`
          select row_id, owner, subject, id, pattern, action, position
          from tool_policy where tenant = ${tenant} and ${visible}
          order by owner, position, id
        `.pipe(Effect.flatMap(decodeRows("tool_policy rows", Schema.Array(PolicyRow))))
      : [];
    const toolkits = reads.has("toolkits")
      ? yield* sql`
          select row_id, owner, subject, key, data from plugin_storage
          where tenant = ${tenant} and plugin_id = 'toolkits' and collection = 'toolkits'
            and ${visible}
          order by key
        `.pipe(Effect.flatMap(decodeRows("toolkit rows", Schema.Array(ToolkitRow))))
      : [];
    const toolkitRules = reads.has("toolkitRules")
      ? yield* sql`
          select owner, subject, collection, data from plugin_storage
          where tenant = ${tenant} and plugin_id = 'toolkits'
            and collection in ('toolkitConnections', 'toolkitPolicies') and ${visible}
          order by key
        `.pipe(Effect.flatMap(decodeRows("toolkit rule rows", Schema.Array(ToolkitRuleRow))))
      : [];
    const snapshot: V1Snapshot = {
      tenant,
      subjects,
      multiMember,
      organization: found,
      integrations,
      connections,
      clients,
      policies,
      toolkits,
      toolkitRules,
    };
    // The tables not read are empty; the type leaves them out.
    const read: V1SnapshotOf<T> = snapshot;
    return read;
  });

/**
 * The organization's artifacts without their code, among the org's and these members' own. Their
 * code can be large, and only the artifact steps read it (`readArtifacts`).
 */
export const readArtifactSummaries = (tenant: string, subjects: readonly [string, ...string[]]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      select row_id, owner, subject, id, title, description, bindings from artifact
      where tenant = ${tenant} and ${ownedBy(sql, subjects)} order by created_at, id
    `.pipe(Effect.flatMap(decodeRows("artifact rows", Schema.Array(ArtifactSummary))));
  });

/**
 * The ids of the other live v1 organizations whose slug is exactly `slug`, with whether each was
 * created before this one by id. The dry run's slug plan reserves a v2 slug such an organization
 * takes when it moves.
 */
export const readSlugHolders = (organization: string, slug: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select id from organizations where slug = ${slug} and id <> ${organization}
        and deleted_at is null
    `.pipe(Effect.flatMap(decodeRows("organizations", OrganizationIds)));
    return rows.map((row) => row.id);
  });

/** Some of the organization's artifacts with their code, among the org's and these members' own. */
export const readArtifacts = (
  tenant: string,
  subjects: readonly [string, ...string[]],
  rows: readonly [string, ...string[]],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      select row_id, owner, subject, id, title, description, code, bindings from artifact
      where tenant = ${tenant} and ${ownedBy(sql, subjects)} and ${sql.in("row_id", rows)}
      order by created_at, id
    `.pipe(Effect.flatMap(decodeRows("artifact rows", Schema.Array(ArtifactRow))));
  });

/** Live v1 organization ids after `after`, in id order: one page of a batch over every org. */
export const readOrganizationIds = (after: string, limit: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select id from organizations where deleted_at is null and id > ${after}
      order by id limit ${limit}
    `.pipe(Effect.flatMap(decodeRows("organizations", OrganizationIds)));
    return rows.map((row) => row.id);
  });

/**
 * The tools v1 last listed for an integration's org connections and the imported members' own,
 * with the MCP server's own names and when v1 listed each connection's tools.
 */
export const readTools = (
  tenant: string,
  subjects: readonly [string, ...string[]],
  integration: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      select owner, subject, connection, name,
        annotations::jsonb -> 'mcp' ->> 'toolName' as upstream,
        coalesce(annotations::jsonb -> 'requiresApproval' = 'true'::jsonb, false)
          as requires_approval,
        (select listed.tools_synced_at::float8 from connection listed
          where listed.tenant = tool.tenant and listed.integration = tool.integration
            and listed.owner = tool.owner and listed.subject = tool.subject
            and listed.name = tool.connection limit 1) as listed_at
      from tool where tenant = ${tenant} and integration = ${integration}
        and ${ownedBy(sql, subjects)}
    `.pipe(Effect.flatMap(decodeRows("tool rows", Schema.Array(ToolRow))));
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
    `.pipe(Effect.flatMap(decodeRows("openapi operation rows", Schema.Array(OpenApiOperationRow))));
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
    `.pipe(Effect.flatMap(decodeRows("openapi binding rows", Schema.Array(OpenApiBindingRow))));
    return rows[0]?.binding;
  });

/** Transient Vault answers: an outage or a rate limit, which a later read may not repeat. */
const vaultRetry = { schedule: Schedule.exponential("1 second"), times: 4 } as const;

/**
 * The only request that reads with POST: Autumn's `customers.get`, which, unlike
 * `customers.get_or_create`, never creates a customer.
 */
const autumnCustomerRead = /\/v1\/customers\.get$/u;

/**
 * Stop any request that could write to v1's WorkOS or Autumn: everything but GET and Autumn's
 * customer read. The importer sends none; this keeps a future change from sending one.
 */
const readOnly = (request: HttpClientRequest.HttpClientRequest) =>
  request.method === "GET" ||
  (request.method === "POST" &&
    autumnCustomerRead.test(new URL(request.url, "http://relative.invalid").pathname))
    ? Effect.succeed(request)
    : Effect.die(new Error(`The v1 import reads v1 only; it refused a ${request.method} request.`));

/** The largest specification the import fetches, as large as an OpenAPI app's router downloads. */
const maxSpecificationBytes = 40_000_000;

/**
 * Why the document at a specification URL could not be fetched. It never names the URL, which can
 * carry a key in its user, host, port, path or query.
 */
export class SpecificationUnavailable extends Schema.TaggedError<SpecificationUnavailable>()(
  "SpecificationUnavailable",
  { reason: Schema.String },
) {}

/**
 * The document at the URL v1 stored as an integration's specification, fetched once, as v1 fetched
 * it when the integration was added: a GET without the integration's credentials, within 60
 * seconds, of at most `maxSpecificationBytes`. Redirects are followed, as v1 followed them.
 */
export const fetchSpecification = (http: HttpClient.HttpClient, url: string) =>
  Effect.gen(function* () {
    const unavailable = (why: string) =>
      new SpecificationUnavailable({
        reason: `v1 stored its specification as a URL, and ${why}.`,
      });
    const response = yield* http
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader(
            "accept",
            "application/json, application/yaml, text/yaml, */*",
          ),
        ),
      )
      .pipe(Effect.mapError(() => unavailable("fetching it failed")));
    if (response.status < 200 || response.status >= 300)
      return yield* unavailable(`fetching it answered HTTP ${response.status}`);
    const chunks = yield* response.stream.pipe(
      Stream.mapError(() => unavailable("reading its document failed")),
      Stream.limitBytes(maxSpecificationBytes, () =>
        Stream.fail(unavailable(`its document is larger than ${maxSpecificationBytes} bytes`)),
      ),
      Stream.runCollect,
    );
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(
          new SpecificationUnavailable({
            reason: "v1 stored its specification as a URL, and fetching it took over 60 seconds.",
          }),
        ),
    }),
  );

/**
 * v1's state for one step: WorkOS, Vault, Postgres, blobs and billing. The scope is the step's: it
 * holds the one read-only Postgres client every read of the step shares, opened on the first, and
 * the step's tool listings, which several items read.
 */
export const makeV1Source = (settings: V1SourceSettings) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.mapRequestEffect(readOnly));
    const scope = yield* Scope.Scope;
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
    /** Every page of a WorkOS list, following `list_metadata.after`. */
    const pages = <A, E, R>(
      page: (after: string | undefined) => Effect.Effect<
        {
          readonly data: readonly A[];
          readonly list_metadata?: { readonly after?: string | null | undefined } | undefined;
        },
        E,
        R
      >,
    ) =>
      Effect.gen(function* () {
        const all: A[] = [];
        let after: string | undefined;
        do {
          const read = yield* page(after);
          all.push(...read.data);
          after = read.list_metadata?.after ?? undefined;
        } while (after !== undefined);
        return all;
      });
    /**
     * One connection for the whole step, opened by its first read and closed with the step, so a
     * step never holds more than one of v1's connections. The v1 sign-in check opens its own.
     */
    const client = yield* Effect.cached(
      Layer.buildWithScope(
        PgClient.layer({
          url: settings.database,
          maxConnections: 1,
          prepare: false,
          connectTimeout: "5 seconds",
        }),
        scope,
      ).pipe(Effect.map(Context.get(SqlClient.SqlClient))),
    );
    /** Each read is its own read-only transaction on the step's connection. */
    const database = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.gen(function* () {
        const sql = yield* client;
        return yield* sql
          .withTransaction(sql`set transaction read only`.pipe(Effect.andThen(work)))
          .pipe(Effect.provideService(SqlClient.SqlClient, sql));
      });
    /** An integration's tool listing, read once per step however many items need it. */
    const listings = new Map<
      string,
      Effect.Effect<readonly ToolRow[], V1ImportUnavailable | V1ImportUnreadable>
    >();
    const tools = (tenant: string, subjects: readonly [string, ...string[]], integration: string) =>
      Effect.gen(function* () {
        const key = JSON.stringify([tenant, subjects, integration]);
        const known = listings.get(key);
        if (known !== undefined) return yield* known;
        const read = yield* Effect.cached(
          database(readTools(tenant, subjects, integration)).pipe(unavailable("tools")),
        );
        listings.set(key, read);
        return yield* read;
      });
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
            `.pipe(Effect.flatMap(decodeRows("blob rows", Values)));
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
      /**
       * The organization's active, pending and inactive memberships, oldest first, from every page.
       * WorkOS lists only active ones unless asked, so each state is its own listing.
       */
      members: (organization: string) =>
        Effect.forEach(membershipStatuses, (status) =>
          pages((after) =>
            get(
              "/user_management/organization_memberships",
              {
                organization_id: organization,
                statuses: status,
                limit: "100",
                ...(after === undefined ? {} : { after }),
              },
              Memberships,
            ),
          ),
        ).pipe(
          Effect.map((listed) => {
            const byId = new Map<string, V1Membership>();
            for (const membership of listed.flat()) {
              const status = membershipStatuses.find((known) => known === membership.status);
              if (status === undefined) continue;
              byId.set(membership.id, {
                id: membership.id,
                user: membership.user_id,
                role: membership.role?.slug === "admin" ? "admin" : "member",
                status,
              });
            }
            return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          }),
          unavailable("workos members"),
        ),
      /** Whether the organization has an active WorkOS SSO connection. */
      sso: (organization: string) =>
        pages((after) =>
          get(
            "/connections",
            {
              organization_id: organization,
              limit: "100",
              ...(after === undefined ? {} : { after }),
            },
            SsoConnections,
          ),
        ).pipe(
          Effect.map((connections) =>
            connections.some((connection) => connection.state === "active"),
          ),
          unavailable("workos sso"),
        ),
      /**
       * The organization's own WorkOS API keys, by id and name. Their values are never read: a key
       * is checked with WorkOS on its first use in v2 (decision 12).
       */
      apiKeys: (organization: string) =>
        pages((after) =>
          get(
            `/organizations/${encodeURIComponent(organization)}/api_keys`,
            { limit: "100", ...(after === undefined ? {} : { after }) },
            ApiKeys,
          ),
        ).pipe(unavailable("workos api keys")),
      /** A WorkOS user, with whether WorkOS verified their email. */
      user: (id: string) =>
        get(`/user_management/users/${encodeURIComponent(id)}`, {}, User).pipe(
          unavailable("workos user"),
        ),
      /**
       * The v1 plans Autumn bills the organization on: its subscriptions that have not expired. No
       * customer means none, which is v1's free plan.
       */
      plans: (organization: string) =>
        autumn.pipe(
          Effect.flatMap((billing) => billing.getCustomer({ customerId: organization })),
          Effect.map((customer) =>
            customer === null
              ? []
              : customer.subscriptions
                  .filter((subscription) => subscription.status !== "expired")
                  .map((subscription) => subscription.planId),
          ),
          unavailable("billing"),
        ),
      /**
       * The organization's Autumn customer with each subscription's dates and the plan version it
       * bills, for a paid organization whose subscription carries over (`billing.ts`).
       */
      customerPlans: (organization: string) =>
        autumn.pipe(
          Effect.flatMap((billing) =>
            billing.getCustomerPlans({
              customerId: organization,
              expand: ["subscriptions.plan"],
            }),
          ),
          unavailable("billing"),
        ),
      /** The organization's row and these of its tables, as `readSnapshot` reads them. */
      snapshot: <T extends V1SnapshotTable>(
        tenant: string,
        subjects: readonly [string, ...string[]],
        multiMember: boolean,
        tables: readonly T[],
      ) =>
        database(readSnapshot(tenant, subjects, multiMember, tables)).pipe(unavailable("snapshot")),
      /** The organization's artifacts without their code. */
      artifactSummaries: (tenant: string, subjects: readonly [string, ...string[]]) =>
        database(readArtifactSummaries(tenant, subjects)).pipe(unavailable("artifact rows")),
      /** The other live v1 organizations whose slug is exactly `slug`. */
      slugHolders: (organization: string, slug: string) =>
        database(readSlugHolders(organization, slug)).pipe(unavailable("organizations")),
      /** The live v1 organizations after `after` in id order, at most `limit`, for a batch. */
      organizations: (after: string, limit: number) =>
        database(readOrganizationIds(after, limit)).pipe(unavailable("organizations")),
      /** These artifacts with their code, which the snapshot leaves out. */
      artifacts: (
        tenant: string,
        subjects: readonly [string, ...string[]],
        rows: readonly [string, ...string[]],
      ) => database(readArtifacts(tenant, subjects, rows)).pipe(unavailable("artifacts")),
      tools,
      openApiOperations: (tenant: string, integration: string) =>
        database(readOpenApiOperations(tenant, integration)).pipe(unavailable("operations")),
      openApiBinding: (tenant: string, integration: string, tool: string) =>
        database(readOpenApiBinding(tenant, integration, tool)).pipe(unavailable("binding")),
      blob: (tenant: string, plugin: string, key: string) =>
        blobs.get(blobKey(tenant, plugin, key)),
      blobMissing: blobs.missing,
      specification: (url: string) => fetchSpecification(http, url),
      /**
       * A secret value from v1's Vault. Undefined when the object is missing (WorkOS answers 404,
       * or 400 for a name it rejects). An outage or rate limit (5xx, 429 or no answer) is retried
       * a few times, then fails with `V1VaultUnavailable`. The value never enters errors or logs.
       */
      secret: (input: {
        readonly tenant: string;
        readonly subject: string;
        readonly itemId: string;
      }) =>
        Effect.gen(function* () {
          const name = yield* vaultObjectName(input).pipe(unavailable("vault"));
          const response = yield* workos
            .execute(HttpClientRequest.get(`/vault/v1/kv/name/${encodeURIComponent(name)}`))
            .pipe(
              Effect.flatMap((answered) =>
                answered.status >= 500 || answered.status === 429
                  ? Effect.fail(new V1VaultUnavailable())
                  : Effect.succeed(answered),
              ),
              Effect.catchTag("HttpClientError", () => Effect.fail(new V1VaultUnavailable())),
              Effect.retry(vaultRetry),
              Effect.tapError(() => Effect.logWarning("v1 import read failed: vault")),
            );
          if (response.status === 404 || response.status === 400) return undefined;
          if (response.status !== 200) return yield* new V1ImportUnavailable();
          const object = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(VaultObject)),
            unavailable("vault"),
          );
          return object.value;
        }),
    };
  });

export type V1Source = Effect.Success<ReturnType<typeof makeV1Source>>;
