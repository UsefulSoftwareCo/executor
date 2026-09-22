import { ApiKeyId } from "../contracts/api-keys.ts";
import { grantAuthorization } from "@executor-js/mcp-auth";
import {
  browserPersonalTokenAccess,
  apiKeyAccess,
  isApiKey,
  requirePinnedOrganization,
} from "./api-keys.ts";
import { resolveOrganizationReference } from "./organization-reference.ts";
import { ApprovalMode, GrantId, mcpOAuthResources } from "@executor-js/mcp-auth";

/** Hosted membership composes with the shared OAuth grant lifecycle. */
import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { Effect, Redacted, Schema } from "effect";
import {
  grantOAuthPlugins,
  authCall,
  runAuth,
  type GrantAccess,
  type OAuthResourceSeedContext,
} from "@executor-js/mcp-auth/oauth";
import { AuthenticationUnavailable, Unauthorized } from "../contracts/auth.ts";
import { McpAccess, McpForbidden, McpUnauthorized } from "../contracts/mcp.ts";
import {
  OrganizationForbidden,
  OrganizationId,
  OrganizationRole,
  OrganizationReference,
  organizationOwner,
} from "../contracts/organization.ts";
const resolveReference = (
  context: GenericEndpointContext["context"],
  reference: typeof OrganizationReference.Type,
) =>
  resolveOrganizationReference(context.adapter, reference).pipe(
    Effect.catchTags({
      OrganizationForbidden: () => Effect.fail(new APIError("FORBIDDEN")),
      AuthenticationUnavailable: () => Effect.fail(new APIError("SERVICE_UNAVAILABLE")),
    }),
  );
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

const hostedGrantOAuth = (origin: string) =>
  grantOAuthPlugins({
    origin,
    scopes: ["mcp", "executor", "offline_access"],
    resources: [
      ...mcpOAuthResources(origin),
      { identifier: `${origin}/api`, allowedScopes: ["executor", "offline_access"] },
    ],
    selectResource: (ctx, userId) =>
      Effect.gen(function* () {
        const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(
          ctx.headers?.get("x-executor-organization"),
        ).pipe(Effect.mapError(() => new APIError("BAD_REQUEST")));
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

const PatGrant = Schema.Struct({
  token: ApiKeyId,
  organization: OrganizationId,
  mode: ApprovalMode,
});
const patGrantPrefix = "pat:";
const patGrantId = (value: typeof PatGrant.Type) =>
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
export const provisionHostedOAuthResources = (origin: string, context: OAuthResourceSeedContext) =>
  hostedGrantOAuth(origin).provisionResources(context);

/** A consent binds a new grant to the selected organization; refresh retains its identity. */
export const mcpOAuthPlugins = (origin: string) => {
  const oauth = hostedGrantOAuth(origin);
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
  const access = (ctx: GenericEndpointContext, kind: "mcp" | "api") =>
    oauth.authenticate(ctx, kind).pipe(Effect.flatMap((grant) => projectAccess(ctx, grant)));
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
              const identity = yield* browserPersonalTokenAccess(ctx, origin, target.token);
              return yield* projectPatAccess(ctx, identity, target.organization, target.mode);
            }),
          ),
      ),
      getMcpAccess: createAuthEndpoint(
        "/mcp/access",
        {
          method: "GET",
          requireHeaders: true,
          metadata: { SERVER_ONLY: true },
          query: Schema.toStandardSchemaV1(
            Schema.optional(Schema.Struct({ mode: Schema.optional(ApprovalMode) })),
          ),
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const token = ctx.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
              if (token === undefined || !isApiKey(token)) return yield* access(ctx, "mcp");
              const identity = yield* apiKeyAccess(ctx, Redacted.make(token));
              const reference = yield* Schema.decodeUnknownEffect(OrganizationReference)(
                ctx.headers.get("x-executor-organization"),
              ).pipe(
                Effect.mapError(
                  () =>
                    new APIError("FORBIDDEN", {
                      message:
                        "Set X-Executor-Organization when using a personal access token with MCP.",
                    }),
                ),
              );
              const organization = yield* resolveReference(ctx.context, reference);
              return yield* projectPatAccess(
                ctx,
                identity,
                organization,
                ctx.query?.mode ?? "model",
              );
            }),
          ),
      ),
      getApiAccess: createAuthEndpoint(
        "/executor-api/access",
        {
          method: "GET",
          requireHeaders: true,
          metadata: { SERVER_ONLY: true },
          query: Schema.toStandardSchemaV1(
            Schema.Struct({ organization: Schema.optional(OrganizationReference) }),
          ),
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const token = ctx.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
              const identity = yield* Effect.gen(function* () {
                if (token !== undefined && isApiKey(token)) {
                  const identity = yield* apiKeyAccess(ctx, Redacted.make(token));
                  const reference = yield* Schema.decodeUnknownEffect(OrganizationReference)(
                    ctx.query.organization ?? ctx.headers.get("x-executor-organization"),
                  ).pipe(Effect.mapError(() => new APIError("FORBIDDEN")));
                  const organization = yield* resolveReference(ctx.context, reference);
                  yield* requirePinnedOrganization(identity, organization);
                  const member = yield* membership(ctx.context, identity.userId, organization);
                  return {
                    userId: identity.userId,
                    key: identity.key,
                    policy: identity.policy,
                    access: {
                      organization,
                      owner: organizationOwner(organization),
                      role: member.role,
                    },
                  };
                }
                const grant = yield* access(ctx, "api");
                if (
                  ctx.query.organization !== undefined &&
                  grant.access.organization !==
                    (yield* resolveReference(ctx.context, ctx.query.organization))
                )
                  return yield* Effect.fail(new APIError("FORBIDDEN"));
                return {
                  userId: grant.userId,
                  access: grant.access,
                  policy: grantAuthorization(grant.grant.policy),
                };
              });
              const value = yield* authCall(() =>
                ctx.context.adapter.findOne({
                  model: "organization",
                  where: [{ field: "id", value: identity.access.organization }],
                }),
              );
              const organization = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ slug: Schema.NonEmptyString }),
              )(value).pipe(Effect.mapError(() => new APIError("FORBIDDEN")));
              return { ...identity, organizationSlug: organization.slug };
            }),
          ),
      ),
    },
  } satisfies BetterAuthPlugin;
  return [...oauth.plugins, hosted] as const;
};

/** Preserve invalid grants, denied membership, and storage outages as different outcomes. */
export const mcpAuthenticationError = (cause: unknown) =>
  isAPIError(cause) && cause.statusCode === 403
    ? new McpForbidden()
    : isAPIError(cause) && (cause.statusCode === 400 || cause.statusCode === 401)
      ? new McpUnauthorized()
      : new AuthenticationUnavailable();

/** Translate native API grant failures into the existing HTTP permission contracts. */
export const apiAuthenticationError = (cause: unknown) =>
  isAPIError(cause) && cause.statusCode === 403
    ? new OrganizationForbidden()
    : isAPIError(cause) && (cause.statusCode === 400 || cause.statusCode === 401)
      ? new Unauthorized()
      : new AuthenticationUnavailable();
