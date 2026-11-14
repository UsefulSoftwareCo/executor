import { ApiKeyId } from "../contracts/api-keys.ts";
import {
  apiKeys,
  browserPersonalTokenAccess,
  apiKeyAccess,
  requirePinnedOrganization,
} from "./api-keys.ts";
import {
  ApprovalMode,
  ConnectionId as ConnectionIdSchema,
  type ConnectionId,
  GrantId,
  type GrantPolicy,
  mcpOAuthResources,
} from "@executor-js/mcp-auth";

/** Hosted membership composes with the shared OAuth grant lifecycle. */
import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
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
  ConnectionPolicy,
  connectionGrantPolicy,
} from "@executor-js/mcp-auth/connections";
import { ConnectedAgent, ConnectedAgentNotFound } from "@executor-js/mcp-auth/agents";
import { ConnectionKeyNotFound, ConnectionKeySummary } from "../contracts/mcp-connections.ts";
import { OrganizationId, OrganizationRole, organizationOwner } from "../contracts/organization.ts";
const Member = Schema.Struct({ role: OrganizationRole });
/** The user's email for `ctx.approvedBy` on the browser approval page; null when unreadable. */
const userEmail = (context: GenericEndpointContext["context"], userId: string) =>
  authCall(() =>
    context.adapter.findOne({
      model: "user",
      where: [{ field: "id", value: userId }],
      select: ["email"],
    }),
  ).pipe(
    Effect.map((row) =>
      Schema.decodeUnknownOption(Schema.Struct({ email: Schema.String }))(row).pipe(
        Option.match({ onNone: () => null, onSome: ({ email }) => email }),
      ),
    ),
    Effect.orElseSucceed(() => null),
  );

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

/**
 * What a host observes about grants (why a refresh was refused and which grants were approved), and
 * how it binds grants for legacy MCP URLs it serves.
 */
export type GrantObservers = Pick<
  GrantOAuthOptions,
  "onRefreshRejected" | "onGrantCreated" | "resolveResource"
>;

/** The hosted grant's origins plus the host's grant observers. */
export type HostedOAuthOptions = HostedOAuthOrigins & GrantObservers;

const hostedGrantOAuth = ({
  origin,
  resourceOrigins,
  issuer,
  onRefreshRejected,
  onGrantCreated,
  resolveResource,
}: HostedOAuthOptions) =>
  grantOAuthPlugins({
    origin,
    resourceOrigins,
    issuer,
    onRefreshRejected,
    onGrantCreated,
    resolveResource,
    scopes: ["mcp", "executor", "offline_access"],
    // The CLI signs in on machines without a browser, approving on the dashboard's device page.
    deviceAuthorization: true,
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
  /** The scoped connection whose URL the PAT was used at; its policy narrows the PAT's. */
  connection: Schema.optionalKey(ConnectionIdSchema),
  /**
   * When that connection was made, in epoch milliseconds. A revoked connection's ID can name a
   * new connection; a grant ID from the revoked one must not resolve to it.
   */
  generation: Schema.optionalKey(Schema.Number),
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
/** A stored connection as the browser page reads it; its policy may arrive as JSON text or as JSON. */
const StoredConnection = Schema.Struct({
  userId: Schema.String,
  resource: Schema.String,
  revoked: Schema.Boolean,
  policy: Schema.Unknown,
  createdAt: Schema.Date,
});
const ConnectionPolicyJson = Schema.Union([
  ConnectionPolicy,
  Schema.fromJsonString(ConnectionPolicy),
]);
/** A key's stored metadata, as JSON text or JSON, naming the connection it is bound to. */
const BoundKeyMetadata = Schema.Union([
  Schema.Struct({ connection: Schema.String }),
  Schema.fromJsonString(Schema.Struct({ connection: Schema.String })),
]);
/** The owner's standing connection, or NOT_FOUND for a revoked one or another user's. */
const requireStandingConnection = async (
  context: GenericEndpointContext["context"],
  owner: { readonly userId: string; readonly resource: string; readonly id: string },
) => {
  const row = await context.adapter.findOne({
    model: "mcpConnection",
    where: [{ field: "id", value: owner.id }],
  });
  const stored = Schema.decodeUnknownOption(StoredConnection)(row).pipe(
    Option.filter(
      (connection) =>
        connection.revoked === false &&
        connection.userId === owner.userId &&
        connection.resource === owner.resource,
    ),
  );
  if (Option.isNone(stored)) throw new APIError("NOT_FOUND");
};
/** A stored key row's non-secret fields. */
interface StoredKey {
  readonly id: string;
  readonly name?: string | null;
  readonly start?: string | null;
  readonly createdAt?: unknown;
  readonly expiresAt?: unknown;
  readonly lastRequest?: unknown;
  readonly metadata: unknown;
}
/** The user's keys whose metadata binds them to this connection. */
const boundKeys = async (
  context: GenericEndpointContext["context"],
  userId: string,
  connection: string,
) => {
  const keys = await context.adapter.findMany<StoredKey>({
    model: "apikey",
    where: [{ field: "referenceId", value: userId }],
  });
  return keys.filter((key) =>
    Option.match(Schema.decodeUnknownOption(BoundKeyMetadata)(key.metadata), {
      onNone: () => false,
      onSome: (metadata) => metadata.connection === connection,
    }),
  );
};
/** A stored timestamp as ISO text; adapters return Dates or their text. */
const isoTime = (value: unknown) => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : undefined;
  return date === undefined || Number.isNaN(date.getTime()) ? null : date.toISOString();
};
/** Stable metadata identifies the PAT/organization/mode partition; it is never a credential. */
const projectPatAccess = (
  ctx: GenericEndpointContext,
  identity: Effect.Success<ReturnType<typeof apiKeyAccess>>,
  organization: OrganizationId,
  mode: ApprovalMode,
  connection?: ConnectionId,
  generation?: number,
) =>
  Effect.gen(function* () {
    yield* requirePinnedOrganization(identity, organization);
    const member = yield* membership(ctx.context, identity.userId, organization);
    // A PAT used at a connection's URL has that connection's policy, while the connection stands.
    const policy: GrantPolicy =
      connection === undefined
        ? { kind: "all" }
        : yield* authCall(() =>
            ctx.context.adapter.findOne({
              model: "mcpConnection",
              where: [{ field: "id", value: connection }],
            }),
          ).pipe(
            Effect.map((row) =>
              Schema.decodeUnknownOption(StoredConnection)(row).pipe(
                Option.filter(
                  (stored) =>
                    stored.revoked === false &&
                    stored.userId === identity.userId &&
                    stored.resource === organization &&
                    (generation === undefined || generation === stored.createdAt.getTime()),
                ),
                Option.flatMap((stored) =>
                  Schema.decodeUnknownOption(ConnectionPolicyJson)(stored.policy),
                ),
                Option.map(connectionGrantPolicy),
              ),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new APIError("UNAUTHORIZED")),
                onSome: Effect.succeed,
              }),
            ),
          );
    return McpAccess.make({
      userId: identity.userId,
      email: yield* userEmail(ctx.context, identity.userId),
      clientId: `pat:${identity.key.id}`,
      grant: {
        id: patGrantId({
          token: identity.key.id,
          organization,
          mode,
          ...(connection === undefined ? {} : { connection }),
          ...(generation === undefined ? {} : { generation }),
        }),
        policy,
        target: { kind: "mcp", mode, ...(connection === undefined ? {} : { connection }) },
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
        email: yield* userEmail(ctx.context, grant.userId),
        clientId: grant.clientId,
        grant: grant.grant,
        access: { organization, owner: organizationOwner(organization), role: member.role },
      });
    });
  const hosted = {
    id: "executor-hosted-grants",
    endpoints: {
      // Approval links name their grant by an opaque reference sealed with the instance secret, so
      // a link, or a log or history that saw it, never shows the grant or its API key's ID.
      sealMcpGrantRef: createAuthEndpoint(
        "/mcp/grant-ref/seal",
        {
          method: "POST",
          body: Schema.toStandardSchemaV1(Schema.Struct({ id: GrantId })),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => ({
          ref: await symmetricEncrypt({ key: ctx.context.secret, data: ctx.body.id }),
        }),
      ),
      openMcpGrantRef: createAuthEndpoint(
        "/mcp/grant-ref/open",
        {
          method: "POST",
          body: Schema.toStandardSchemaV1(Schema.Struct({ ref: Schema.String })),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const id = await symmetricDecrypt({ key: ctx.context.secret, data: ctx.body.ref }).catch(
            () => undefined,
          );
          const decoded = Schema.decodeUnknownOption(GrantId)(id);
          if (Option.isNone(decoded)) throw new APIError("UNAUTHORIZED");
          return { id: decoded.value };
        },
      ),
      // A key bound to one scoped connection, minted for its owner while it stands. Its metadata
      // pins the organization and the connection; bearer checks refuse it anywhere else.
      mintMcpConnectionKey: createAuthEndpoint(
        "/mcp/connection-keys/mint",
        {
          method: "POST",
          body: Schema.toStandardSchemaV1(
            Schema.Struct({
              userId: Schema.String,
              resource: OrganizationId,
              id: ConnectionIdSchema,
              name: Schema.String,
              expiresIn: Schema.Number,
            }),
          ),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          await requireStandingConnection(ctx.context, ctx.body);
          const created = await apiKeys.endpoints.createApiKey({
            context: ctx.context,
            body: {
              userId: ctx.body.userId,
              name: ctx.body.name,
              expiresIn: ctx.body.expiresIn,
              metadata: { organization: ctx.body.resource, connection: ctx.body.id },
            },
          });
          if (!(created.expiresAt instanceof Date)) throw new APIError("INTERNAL_SERVER_ERROR");
          return { id: created.id, key: created.key, expiresAt: created.expiresAt.toISOString() };
        },
      ),
      // Revoking a connection deletes the keys bound to it; bearer checks already refuse them. A
      // connection made again with a revoked one's ID keeps only keys minted for the new one.
      revokeMcpConnectionKeys: createAuthEndpoint(
        "/mcp/connection-keys/revoke",
        {
          method: "POST",
          body: Schema.toStandardSchemaV1(
            Schema.Struct({
              userId: Schema.String,
              resource: Schema.String,
              id: ConnectionIdSchema,
            }),
          ),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const connection = Schema.decodeUnknownOption(StoredConnection)(
            await ctx.context.adapter.findOne({
              model: "mcpConnection",
              where: [{ field: "id", value: ctx.body.id }],
            }),
          ).pipe(
            Option.filter(
              (stored) =>
                stored.revoked === false &&
                stored.userId === ctx.body.userId &&
                stored.resource === ctx.body.resource,
            ),
          );
          const keys = await ctx.context.adapter.findMany<{
            id: string;
            metadata: unknown;
            createdAt: unknown;
          }>({
            model: "apikey",
            where: [{ field: "referenceId", value: ctx.body.userId }],
          });
          const bound = keys.filter(
            (key) =>
              Option.match(Schema.decodeUnknownOption(BoundKeyMetadata)(key.metadata), {
                onNone: () => false,
                onSome: (metadata) => metadata.connection === ctx.body.id,
              }) &&
              Option.match(connection, {
                onNone: () => true,
                onSome: (current) =>
                  !(key.createdAt instanceof Date) ||
                  key.createdAt.getTime() < current.createdAt.getTime(),
              }),
          );
          for (const key of bound)
            await ctx.context.adapter.delete({
              model: "apikey",
              where: [{ field: "id", value: key.id }],
            });
          return { deleted: bound.length };
        },
      ),
      // The keys bound to one of the owner's standing connections. Never their secrets or hashes.
      listMcpConnectionKeys: createAuthEndpoint(
        "/mcp/connection-keys/list",
        {
          method: "POST",
          body: Schema.toStandardSchemaV1(
            Schema.Struct({
              userId: Schema.String,
              resource: Schema.String,
              id: ConnectionIdSchema,
            }),
          ),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          await requireStandingConnection(ctx.context, ctx.body);
          const bound = await boundKeys(ctx.context, ctx.body.userId, ctx.body.id);
          return bound
            .map((key) => ({
              id: key.id,
              name: key.name ?? null,
              start: key.start ?? null,
              createdAt: isoTime(key.createdAt) ?? new Date(0).toISOString(),
              expiresAt: isoTime(key.expiresAt),
              lastRequest: isoTime(key.lastRequest),
            }))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        },
      ),
      // Delete one key bound to one of the owner's standing connections. The connection and its
      // other keys stay; bearer checks read the key row, so the deleted key is refused at once.
      revokeMcpConnectionKey: createAuthEndpoint(
        "/mcp/connection-keys/revoke-one",
        {
          method: "POST",
          body: Schema.toStandardSchemaV1(
            Schema.Struct({
              userId: Schema.String,
              resource: Schema.String,
              id: ConnectionIdSchema,
              key: Schema.String,
            }),
          ),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          await requireStandingConnection(ctx.context, ctx.body);
          const bound = await boundKeys(ctx.context, ctx.body.userId, ctx.body.id);
          if (!bound.some((key) => key.id === ctx.body.key)) return { revoked: false };
          await ctx.context.adapter.delete({
            model: "apikey",
            where: [{ field: "id", value: ctx.body.key }],
          });
          return { revoked: true };
        },
      ),
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
              return yield* projectPatAccess(
                ctx,
                identity,
                target.organization,
                target.mode,
                target.connection,
                target.generation,
              );
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
  readonly mintMcpConnectionKey: (input: {
    body: { userId: string; resource: string; id: string; name: string; expiresIn: number };
  }) => Promise<unknown>;
  readonly revokeMcpConnectionKeys: (input: {
    body: { userId: string; resource: string; id: string };
  }) => Promise<unknown>;
  readonly listMcpConnectionKeys: (input: {
    body: { userId: string; resource: string; id: string };
  }) => Promise<unknown>;
  readonly revokeMcpConnectionKey: (input: {
    body: { userId: string; resource: string; id: string; key: string };
  }) => Promise<unknown>;
}
/** A minted connection key: the only response that contains its secret. */
const MintedConnectionKey = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  expiresAt: Schema.String,
});
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
        // A revoked connection's ID may name the new one. Delete keys left from the revoked one,
        // which bearer checks already refuse, as revoking it would have.
        Effect.tap(() =>
          request(
            (api) => api.revokeMcpConnectionKeys({ body: { ...owner, id: input.id } }),
            Schema.Struct({ deleted: Schema.Number }),
          ),
        ),
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
    // A revocation's steps run in Better Auth, which a cancelled request does not stop, so the
    // call is awaited for its stored outcome.
    revoke: (owner, id) =>
      request(
        (api) => api.revokeMcpConnection({ body: { ...owner, id } }),
        Schema.Struct({ revoked: Schema.Literal(true), id: ConnectionIdSchema }),
      ).pipe(
        // Delete bound keys before acknowledging the completed revocation to the audit.
        Effect.tap(() =>
          request(
            (api) => api.revokeMcpConnectionKeys({ body: { ...owner, id } }),
            Schema.Struct({ deleted: Schema.Number }),
          ),
        ),
        Effect.map((revoked) => revoked.id),
        Effect.uninterruptible,
        Effect.mapError((status) =>
          status === 404
            ? new ConnectionNotFound({ connection: id })
            : new AuthenticationUnavailable(),
        ),
      ),
    mintKey: (owner, input) =>
      request(
        (api) => api.mintMcpConnectionKey({ body: { ...owner, ...input } }),
        MintedConnectionKey,
      ).pipe(
        Effect.mapError((status) =>
          status === 404
            ? new ConnectionNotFound({ connection: input.id })
            : new AuthenticationUnavailable(),
        ),
      ),
    keys: (owner, id) =>
      request(
        (api) => api.listMcpConnectionKeys({ body: { ...owner, id } }),
        Schema.Array(ConnectionKeySummary),
      ).pipe(
        Effect.mapError((status) =>
          status === 404
            ? new ConnectionNotFound({ connection: id })
            : new AuthenticationUnavailable(),
        ),
      ),
    revokeKey: (owner, input) =>
      request(
        (api) => api.revokeMcpConnectionKey({ body: { ...owner, ...input } }),
        Schema.Struct({ revoked: Schema.Boolean }),
      ).pipe(
        Effect.mapError((status) =>
          status === 404
            ? new ConnectionNotFound({ connection: input.id })
            : new AuthenticationUnavailable(),
        ),
        Effect.flatMap(({ revoked }) =>
          revoked ? Effect.void : Effect.fail(new ConnectionKeyNotFound({ key: input.key })),
        ),
      ),
    agents: (owner) =>
      request((api) => api.listMcpAgents({ body: owner }), Schema.Array(ConnectedAgent)).pipe(
        Effect.mapError(unavailable),
      ),
    revokeAgent: (owner, id) =>
      request(
        (api) => api.revokeMcpAgent({ body: { ...owner, id } }),
        Schema.Struct({ revoked: Schema.Literal(true), id: GrantId }),
      ).pipe(
        Effect.map((revoked) => revoked.id),
        Effect.uninterruptible,
        Effect.mapError((status) =>
          status === 404
            ? new ConnectedAgentNotFound({ agent: id })
            : new AuthenticationUnavailable(),
        ),
      ),
  };
};
