import { ApiKeyId } from "../contracts/api-keys.ts";
import { browserPersonalTokenAccess, apiKeyAccess, requirePinnedOrganization } from "./api-keys.ts";
import { ApprovalMode, type ConnectionId, GrantId, mcpOAuthResources } from "@executor-js/mcp-auth";

/** Hosted membership composes with the shared OAuth grant lifecycle. */
import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { Effect, Option, Schema } from "effect";
import {
  grantOAuthPlugins,
  authCall,
  runAuth,
  type GrantAccess,
  type GrantOAuthOptions,
  type RefreshRejection,
  type OAuthResourceSeedContext,
} from "@executor-js/mcp-auth/oauth";
import { AuthenticationUnavailable } from "../contracts/auth.ts";
import {
  McpAccess,
  McpApprovalForbidden,
  McpUnauthorized,
  type McpConnectionStore,
} from "../contracts/mcp.ts";
import {
  Connection,
  ConnectionIdTaken,
  ConnectionNotFound,
  type ConnectionPolicy,
} from "@executor-js/mcp-auth/connections";
import { ConnectedAgent, ConnectedAgentNotFound } from "@executor-js/mcp-auth/agents";
import { OrganizationId, OrganizationRole, organizationOwner } from "../contracts/organization.ts";
const Member = Schema.Struct({ role: OrganizationRole });
const membership = (
  context: GenericEndpointContext["context"],
  userId: string,
  organization: OrganizationId,
) =>
  authCall(() =>
    context.adapter.findOne({
      model: "member",
      where: [
        { field: "userId", value: userId },
        { field: "organizationId", value: organization },
      ],
    }),
  ).pipe(
    Effect.flatMap((member) =>
      Schema.decodeUnknownEffect(Member)(member).pipe(
        Effect.mapError(
          () =>
            new APIError("FORBIDDEN", {
              message: "You no longer have access to this organization.",
            }),
        ),
      ),
    ),
  );

/**
 * The browser origin serves sign-in and consent; the resource origins name MCP and API audiences;
 * the issuer identifies the authorization server, possibly on another host.
 */
export type HostedOAuthOrigins = Pick<GrantOAuthOptions, "origin" | "resourceOrigins" | "issuer">;

export type { RefreshRejection };

/** The hosted grant's origins plus the observer told why a refresh grant was refused. */
export type HostedOAuthOptions = HostedOAuthOrigins & Pick<GrantOAuthOptions, "onRefreshRejected">;

const hostedGrantOAuth = ({
  origin,
  resourceOrigins,
  issuer,
  onRefreshRejected,
}: HostedOAuthOptions) =>
  grantOAuthPlugins({
    origin,
    resourceOrigins,
    issuer,
    onRefreshRejected,
    scopes: ["mcp", "executor", "offline_access"],
    resources: [
      ...mcpOAuthResources(resourceOrigins.mcp),
      ...resourceOrigins.api.map((resourceOrigin) => ({
        identifier: `${resourceOrigin}/api`,
        allowedScopes: ["executor", "offline_access"],
      })),
    ],
    selectResource: (ctx, userId, required) =>
      Effect.gen(function* () {
        const header = ctx.headers?.get("x-executor-organization") ?? undefined;
        // A connection belongs to one organization. The consent page may omit the choice,
        // but it cannot name a different organization.
        const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(
          required ?? header,
        ).pipe(Effect.mapError(() => new APIError("BAD_REQUEST")));
        if (required !== undefined && header !== undefined && header !== required)
          return yield* Effect.fail(
            new APIError("FORBIDDEN", {
              message: "This connection belongs to a different organization.",
            }),
          );
        yield* membership(ctx.context, userId, organization);
        return organization;
      }),
    checkResource: (ctx, userId, resource) =>
      Schema.decodeUnknownEffect(OrganizationId)(resource).pipe(
        Effect.mapError(() => new APIError("FORBIDDEN")),
        Effect.flatMap((organization) => membership(ctx.context, userId, organization)),
        Effect.asVoid,
      ),
  });

export const PatGrant = Schema.Struct({
  token: ApiKeyId,
  organization: OrganizationId,
  mode: ApprovalMode,
});
const patGrantPrefix = "pat:";
/** The PAT a synthetic grant ID names, or none for an OAuth grant ID. */
export const patGrantOf = (id: string) =>
  id.startsWith(patGrantPrefix)
    ? Schema.decodeUnknownOption(Schema.fromJsonString(PatGrant))(
        (() => {
          try {
            return decodeURIComponent(id.slice(patGrantPrefix.length));
          } catch {
            return "";
          }
        })(),
      )
    : Option.none();
export const patGrantId = (value: typeof PatGrant.Type) =>
  GrantId.make(patGrantPrefix + encodeURIComponent(JSON.stringify(value)));
const parsePatGrant = (id: GrantId) =>
  Effect.try({
    try: () => decodeURIComponent(id.slice(patGrantPrefix.length)),
    catch: () => new APIError("UNAUTHORIZED"),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PatGrant))),
    Effect.mapError(() => new APIError("UNAUTHORIZED")),
  );
/** Stable metadata identifies the PAT/organization/mode partition; it is never a credential. */
const projectPatAccess = (
  ctx: GenericEndpointContext,
  identity: Effect.Success<ReturnType<typeof apiKeyAccess>>,
  organization: OrganizationId,
  mode: ApprovalMode,
) =>
  Effect.gen(function* () {
    yield* requirePinnedOrganization(identity, organization);
    const member = yield* membership(ctx.context, identity.userId, organization);
    return McpAccess.make({
      userId: identity.userId,
      clientId: `pat:${identity.key.id}`,
      grant: {
        id: patGrantId({ token: identity.key.id, organization, mode }),
        policy: { kind: "all" },
        target: { kind: "mcp", mode },
      },
      access: { organization, owner: organizationOwner(organization), role: member.role },
    });
  });

/** Provision the host's fixed resources before serving OAuth requests. */
export const provisionHostedOAuthResources = (
  origins: HostedOAuthOrigins,
  context: OAuthResourceSeedContext,
) => hostedGrantOAuth(origins).provisionResources(context);

/**
 * Insert one existing connection's missing resources at every resource origin, as a new
 * connection gets them. Existing resource rows are never changed.
 */
export const provisionHostedConnectionResources = (
  origins: HostedOAuthOrigins,
  context: OAuthResourceSeedContext,
  connection: ConnectionId,
) => hostedGrantOAuth(origins).provisionConnectionResources(context, connection);

/** A consent binds a new grant to the selected organization; refresh retains its identity. */
export const mcpOAuthPlugins = (options: HostedOAuthOptions) => {
  const oauth = hostedGrantOAuth(options);
  const projectAccess = (ctx: GenericEndpointContext, grant: GrantAccess) =>
    Effect.gen(function* () {
      const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(grant.resource).pipe(
        Effect.mapError(() => new APIError("FORBIDDEN")),
      );
      const member = yield* membership(ctx.context, grant.userId, organization);
      return McpAccess.make({
        userId: grant.userId,
        clientId: grant.clientId,
        grant: grant.grant,
        access: { organization, owner: organizationOwner(organization), role: member.role },
      });
    });
  const hosted = {
    id: "executor-hosted-grants",
    endpoints: {
      getMcpBrowserAccess: createAuthEndpoint(
        "/mcp/browser-access",
        {
          method: "POST",
          requireHeaders: true,
          body: Schema.toStandardSchemaV1(Schema.Struct({ id: GrantId })),
          metadata: { SERVER_ONLY: true },
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              if (!ctx.body.id.startsWith(patGrantPrefix))
                return yield* oauth
                  .lookupBrowser(ctx)
                  .pipe(Effect.flatMap((grant) => projectAccess(ctx, grant)));
              const target = yield* parsePatGrant(ctx.body.id);
              const identity = yield* browserPersonalTokenAccess(ctx, options.origin, target.token);
              return yield* projectPatAccess(ctx, identity, target.organization, target.mode);
            }),
          ),
      ),
    },
  } satisfies BetterAuthPlugin;
  return [...oauth.plugins, hosted] as const;
};

/** Browser approval pages state no cause, so every refusal there is one outcome. */
export const mcpBrowserGrantError = (cause: unknown) =>
  isAPIError(cause) && cause.statusCode === 403
    ? new McpApprovalForbidden()
    : isAPIError(cause) && (cause.statusCode === 400 || cause.statusCode === 401)
      ? new McpUnauthorized()
      : new AuthenticationUnavailable();

type ConnectionBody = {
  userId: string;
  resource: string;
  id: string;
  name: string;
  policy: typeof ConnectionPolicy.Encoded;
};
/** The server-only Better Auth endpoints that store connections. */
export interface McpConnectionApi {
  readonly listMcpConnections: (input: {
    body: { userId: string; resource: string };
  }) => Promise<unknown>;
  readonly createMcpConnection: (input: { body: ConnectionBody }) => Promise<unknown>;
  readonly updateMcpConnection: (input: { body: ConnectionBody }) => Promise<unknown>;
  readonly revokeMcpConnection: (input: {
    body: { userId: string; resource: string; id: string };
  }) => Promise<unknown>;
  readonly listMcpAgents: (input: {
    body: { userId: string; resource: string };
  }) => Promise<unknown>;
  readonly revokeMcpAgent: (input: {
    body: { userId: string; resource: string; id: string };
  }) => Promise<unknown>;
}
const storeFailure = (cause: unknown) =>
  isAPIError(cause) ? cause.statusCode : ("unavailable" as const);
/**
 * Adapt a host's native auth instance to the connection store. Results cross the Better Auth
 * boundary and are parsed again; missing records and storage outages stay distinct.
 */
export const mcpConnectionStore = (
  call: <A>(run: (api: McpConnectionApi) => Promise<A>) => Effect.Effect<A, unknown>,
): McpConnectionStore => {
  const request = <A>(
    run: (api: McpConnectionApi) => Promise<unknown>,
    schema: Schema.Decoder<A>,
  ) =>
    call(run).pipe(
      Effect.mapError(storeFailure),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(() => "unavailable" as const),
        ),
      ),
    );
  const unavailable = () => new AuthenticationUnavailable();
  return {
    list: (owner) =>
      request((api) => api.listMcpConnections({ body: owner }), Schema.Array(Connection)).pipe(
        Effect.mapError(unavailable),
      ),
    create: (owner, input) =>
      request((api) => api.createMcpConnection({ body: { ...owner, ...input } }), Connection).pipe(
        Effect.mapError((status) =>
          status === 409
            ? new ConnectionIdTaken({ connection: input.id })
            : new AuthenticationUnavailable(),
        ),
      ),
    update: (owner, input) =>
      request((api) => api.updateMcpConnection({ body: { ...owner, ...input } }), Connection).pipe(
        Effect.mapError((status) =>
          status === 404
            ? new ConnectionNotFound({ connection: input.id })
            : new AuthenticationUnavailable(),
        ),
      ),
    revoke: (owner, id) =>
      request(
        (api) => api.revokeMcpConnection({ body: { ...owner, id } }),
        Schema.Struct({ revoked: Schema.Literal(true) }),
      ).pipe(
        Effect.asVoid,
        Effect.mapError((status) =>
          status === 404
            ? new ConnectionNotFound({ connection: id })
            : new AuthenticationUnavailable(),
        ),
      ),
    agents: (owner) =>
      request((api) => api.listMcpAgents({ body: owner }), Schema.Array(ConnectedAgent)).pipe(
        Effect.mapError(unavailable),
      ),
    revokeAgent: (owner, id) =>
      request(
        (api) => api.revokeMcpAgent({ body: { ...owner, id } }),
        Schema.Struct({ revoked: Schema.Literal(true) }),
      ).pipe(
        Effect.asVoid,
        Effect.mapError((status) =>
          status === 404
            ? new ConnectedAgentNotFound({ agent: id })
            : new AuthenticationUnavailable(),
        ),
      ),
  };
};
