/**
 * Executor v1's MCP URLs, served by v2 on `executor.sh` once v1 shuts down
 * (`notes/v1-shutdown.md`): `/<v1 slug or org_ id>/mcp`, `/mcp/toolkits/<t>`,
 * `/<selector>/mcp/toolkits/<t>` and their discovery documents. Bare `/mcp` is an ordinary MCP
 * origin and needs nothing here.
 *
 * A selector resolves only through `private_v1_legacy_org`, never through v2's slugs. Each URL is its
 * own OAuth resource (RFC 9728): its discovery document names it and v2's issuer, and a grant made
 * for it is bound to the URL's organization and, for a toolkit, to the caller's own copy
 * (`resolveLegacyResource`). A request is rewritten to `/org/<v2 organization id>/mcp` and served
 * by v2's MCP; a toolkit URL also carries {@link legacyToolkitHeader}, which authentication uses
 * to narrow the caller's access to their copy (`legacyToolkitAccess`).
 */
import {
  AuthenticationUnavailable,
  McpAccess,
  McpAuthentication,
  McpForbidden,
  McpUnauthorized,
  OrganizationId,
  patGrantId,
  patGrantOf,
  recordAuthFailure,
} from "@executor-js/hosted-server";
import {
  ConnectionId,
  legacyMcpPath,
  legacyMcpResource,
  legacyMcpResourceMetadataUrl,
  legacyMcpTarget,
  requestedMcpAddress,
  namedApprovalMode,
  type LegacyMcpPath,
  type ResourceOrigins,
} from "@executor-js/mcp-auth";
import { ConnectionPolicy, connectionGrantPolicy } from "@executor-js/mcp-auth/connections";
import { ApprovalMode } from "@executor-js/mcp-auth/grants";
import { APIError } from "better-auth/api";
import { Clock, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";

export const legacyToolkitHeader = "x-executor-v1-toolkit";

const LegacyToolkit = Schema.fromJsonString(
  Schema.Tuple([Schema.NullOr(Schema.NonEmptyString), Schema.NonEmptyString]),
);

const Organizations = Schema.Array(
  Schema.Struct({ v1_org_id: Schema.String, v2_org_id: OrganizationId }),
);

export const legacyOrganization = (selector: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = selector.startsWith("org_")
      ? yield* sql`select v1_org_id, v2_org_id from private_v1_legacy_org where v1_org_id = ${selector}`
      : yield* sql`select v1_org_id, v2_org_id from private_v1_legacy_org where v1_slug = ${selector}`;
    const found = (yield* Schema.decodeUnknownEffect(Organizations)(rows))[0];
    return found === undefined
      ? Option.none()
      : Option.some({ v1: found.v1_org_id, v2: found.v2_org_id });
  });

const Copies = Schema.Array(Schema.Struct({ connection_id: ConnectionId }));

export const legacyToolkitCopy = (input: {
  readonly v1Organization: string | null;
  readonly v2Organization: string;
  readonly toolkit: string;
  readonly user: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select t.connection_id from private_v1_legacy_toolkit t
      join private_v1_legacy_org o on o.v1_org_id = t.v1_org_id
      where o.v2_org_id = ${input.v2Organization} and t.toolkit_slug = ${input.toolkit}
        and t.v2_user_id = ${input.user}
        and (${input.v1Organization}::text is null or t.v1_org_id = ${input.v1Organization})
      limit 2
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Copies)));
    const [only, another] = rows;
    return only === undefined || another !== undefined
      ? Option.none()
      : Option.some(only.connection_id);
  });

const toolkitExists = (v1Organization: string | null, toolkit: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select 1 from private_v1_legacy_toolkit
      where toolkit_slug = ${toolkit}
        and (${v1Organization}::text is null or v1_org_id = ${v1Organization})
      limit 1
    `;
    return rows.length > 0;
  });

const resolvePath = (path: LegacyMcpPath) =>
  Effect.gen(function* () {
    const organization =
      path.selector === undefined ? Option.none() : yield* legacyOrganization(path.selector);
    if (path.selector !== undefined && Option.isNone(organization)) return Option.none();
    const v1 = Option.getOrNull(Option.map(organization, (found) => found.v1));
    if (path.toolkit !== undefined && !(yield* toolkitExists(v1, path.toolkit)))
      return Option.none();
    return Option.some({ organization });
  });

const seedResources = (identifiers: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const existing = yield* sql<{ readonly identifier: string }>`
      select identifier from "oauthResource" where ${sql.in("identifier", identifiers)}`;
    const missing = identifiers.filter(
      (identifier) => !existing.some((row) => row.identifier === identifier),
    );
    if (missing.length === 0) return;
    const now = new Date(yield* Clock.currentTimeMillis);
    const scopes = JSON.stringify(["mcp", "offline_access"]);
    for (const identifier of missing)
      yield* sql`insert into "oauthResource" (id, identifier, name, "allowedScopes",
          "dpopBoundAccessTokensRequired", disabled, "policyVersion", "createdAt", "updatedAt")
        values (${crypto.randomUUID()}, ${identifier}, ${identifier}, ${scopes}, false, false, 1,
          ${now}, ${now})
        on conflict (identifier) do nothing`;
  });

const notFound = HttpServerResponse.jsonUnsafe(
  { error: "This Executor v1 URL names nothing that moved to Executor." },
  { status: 404, headers: { "cache-control": "no-store" } },
);
const mcpNotFound = HttpServerResponse.jsonUnsafe(
  {
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message:
        "This Executor v1 MCP URL names no organization or toolkit that moved to Executor. Connect at https://mcp.executor.sh/mcp instead.",
    },
    id: null,
  },
  { status: 404, headers: { "cache-control": "no-store" } },
);

export type WithSql = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => Effect.Effect<A, E>;

const lookup = <A, E>(withSql: WithSql, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  withSql(effect).pipe(Effect.mapError(() => new AuthenticationUnavailable()));

/**
 * `GET /.well-known/oauth-protected-resource/<legacy path>`: RFC 9728 metadata naming the legacy URL
 * as the resource, for the URL's approval mode, and v2's issuer. Inserts the URL's resource rows.
 */
export const legacyProtectedResource = (withSql: WithSql) =>
  Effect.gen(function* () {
    const { issuer } = yield* McpAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.originalUrl);
    const prefix = "/.well-known/oauth-protected-resource";
    const path = legacyMcpPath(url.pathname.slice(prefix.length));
    const address = requestedMcpAddress(url);
    if (path === undefined || address === undefined) return notFound;
    if (Option.isNone(yield* lookup(withSql, resolvePath(path)))) return notFound;
    yield* lookup(
      withSql,
      seedResources(ApprovalMode.literals.map((mode) => legacyMcpResource(url.origin, path, mode))),
    );
    return HttpServerResponse.jsonUnsafe({
      resource: legacyMcpResource(url.origin, path, address.mode),
      authorization_servers: [issuer],
      scopes_supported: ["mcp", "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "Executor",
    });
  });

export const legacyMcp = <E, R>(
  withSql: WithSql,
  mcp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.originalUrl);
    const path = legacyMcpPath(url.pathname);
    const address = requestedMcpAddress(url);
    if (path === undefined) return mcpNotFound;
    if (address === undefined)
      return HttpServerResponse.jsonUnsafe(
        { error: "Unsupported elicitation_mode or connection." },
        { status: 400 },
      );
    const resolved = yield* lookup(withSql, resolvePath(path));
    if (Option.isNone(resolved)) return mcpNotFound;
    const organization = resolved.value.organization;
    const named = namedApprovalMode(url);
    const query = named === undefined ? "" : `?elicitation_mode=${named}`;
    const target = Option.match(organization, {
      onNone: () => `/mcp${query}`,
      onSome: (found) => `/org/${encodeURIComponent(found.v2)}/mcp${query}`,
    });
    const web = yield* HttpServerRequest.toWeb(request).pipe(
      Effect.mapError(() => new AuthenticationUnavailable()),
    );
    const headers = new Headers(web.headers);
    headers.delete(legacyToolkitHeader);
    if (path.toolkit !== undefined)
      headers.set(
        legacyToolkitHeader,
        JSON.stringify([
          Option.getOrNull(Option.map(organization, (found) => found.v1)),
          path.toolkit,
        ]),
      );
    const rewritten = HttpServerRequest.fromWeb(
      new Request(new URL(target, url.origin), {
        method: web.method,
        headers,
        ...(web.body === null ? {} : { body: web.body, duplex: "half" }),
        signal: web.signal,
      }),
    );
    const response = yield* mcp.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, rewritten),
    );
    return response.status === 401
      ? HttpServerResponse.setHeader(
          response,
          "www-authenticate",
          `Bearer resource_metadata="${legacyMcpResourceMetadataUrl(url.origin, path, address.mode)}", scope="mcp offline_access"`,
        )
      : response;
  });

const ConnectionRow = Schema.Struct({
  userId: Schema.String,
  resource: Schema.NullOr(Schema.String),
  policy: Schema.String,
  revoked: Schema.Boolean,
});

export const legacyToolkitAccess = (headers: Headers, access: McpAccess) =>
  Effect.gen(function* () {
    const header = headers.get(legacyToolkitHeader);
    if (header === null) return access;
    const refuse = Effect.andThen(
      recordAuthFailure("wrong_resource"),
      Effect.fail(new McpForbidden({ reason: "toolkit" })),
    );
    const named = Schema.decodeUnknownOption(LegacyToolkit)(header);
    if (Option.isNone(named)) return yield* refuse;
    const [v1Organization, toolkit] = named.value;
    const copy = yield* legacyToolkitCopy({
      v1Organization,
      v2Organization: access.access.organization,
      toolkit,
      user: access.userId,
    });
    if (Option.isNone(copy)) return yield* refuse;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select "userId", resource, policy, revoked from "mcpConnection" where id = ${copy.value}`;
    const row = (yield* Schema.decodeUnknownEffect(Schema.Array(ConnectionRow))(rows))[0];
    if (
      row === undefined ||
      row.revoked ||
      row.userId !== access.userId ||
      row.resource !== access.access.organization
    )
      return yield* refuse;
    const target = access.grant.target;
    const pat = patGrantOf(access.grant.id);
    if (Option.isNone(pat)) {
      if (target.kind === "mcp" && target.connection === copy.value) return access;
      return yield* Effect.andThen(
        recordAuthFailure("wrong_resource"),
        Effect.fail(new McpUnauthorized()),
      );
    }
    const mode = target.kind === "mcp" ? target.mode : "model";
    return McpAccess.make({
      ...access,
      grant: {
        id: patGrantId({ ...pat.value, connection: copy.value }),
        policy: connectionGrantPolicy(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectionPolicy))(row.policy),
        ),
        target: { kind: "mcp", mode, connection: copy.value },
      },
    });
  }).pipe(
    Effect.catchTags({
      SqlError: () => Effect.fail(new AuthenticationUnavailable()),
      SchemaError: () => Effect.fail(new AuthenticationUnavailable()),
    }),
  );

export const resolveLegacyResource = (
  origins: ResourceOrigins,
  input: {
    readonly userId: string;
    readonly resource: string;
    readonly organization: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const legacy = legacyMcpTarget(origins, input.resource);
    if (legacy === undefined) return yield* Effect.fail(new APIError("BAD_REQUEST"));
    const resolved = yield* resolvePath(legacy.path);
    if (Option.isNone(resolved))
      return yield* Effect.fail(
        new APIError("NOT_FOUND", {
          message: "This Executor v1 URL names nothing that moved to Executor.",
        }),
      );
    const selected = resolved.value.organization;
    const organization = Option.isSome(selected) ? selected.value.v2 : input.organization;
    if (organization === undefined)
      return yield* Effect.fail(
        new APIError("BAD_REQUEST", { message: "Choose an organization." }),
      );
    if (legacy.path.toolkit === undefined) return { organization };
    const copy = yield* legacyToolkitCopy({
      v1Organization: Option.getOrNull(Option.map(selected, (found) => found.v1)),
      v2Organization: organization,
      toolkit: legacy.path.toolkit,
      user: input.userId,
    });
    if (Option.isNone(copy))
      return yield* Effect.fail(
        new APIError("FORBIDDEN", {
          message: "You have no copy of this toolkit in that organization.",
        }),
      );
    return { organization, connection: copy.value };
  }).pipe(
    Effect.catchTags({
      SqlError: () => Effect.fail(new APIError("SERVICE_UNAVAILABLE")),
      SchemaError: () => Effect.fail(new APIError("SERVICE_UNAVAILABLE")),
    }),
  );
