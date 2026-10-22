import { Effect, Layer } from "effect";

import {
  authenticated,
  McpAuthProvider,
  unauthorized,
  type McpDiscoveryRoute,
  type Principal,
} from "@executor-js/host-mcp";
import { type DelegationGrant, makeVerifiedHumanSubjectRegistry } from "@executor-js/sdk";

import {
  classifyAccessClaims,
  delegatedCredentialFromAccessClaims,
  makeAccessVerifier,
} from "../auth/cloudflare-access";
import {
  makeCloudflareDelegationAuthority,
  makeCloudflareDelegationService,
} from "../auth/delegation";
import { createD1ExecutorDb } from "../db/d1";
import type { CloudflareConfig, CloudflareEnv } from "../config";

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const MCP_PROTECTED_RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}/mcp`;
const TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH = `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/:toolkitSlug`;

const toolkitSlugFromPath = (pathname: string): string | undefined => {
  const mcpPrefix = "/mcp/toolkits/";
  if (pathname.startsWith(mcpPrefix)) {
    const slug = pathname.slice(mcpPrefix.length).split("/", 1)[0];
    return slug ? decodeURIComponent(slug) : undefined;
  }
  const metadataPrefix = `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/`;
  if (pathname.startsWith(metadataPrefix)) {
    const slug = pathname.slice(metadataPrefix.length).split("/", 1)[0];
    return slug ? decodeURIComponent(slug) : undefined;
  }
  return undefined;
};

const toolkitPath = (slug: string): string => `/mcp/toolkits/${encodeURIComponent(slug)}`;

const resourcePathForRequest = (request: Request): string => {
  const slug = toolkitSlugFromPath(new URL(request.url).pathname);
  return slug ? toolkitPath(slug) : "/mcp";
};

const metadataPathForRequest = (request: Request): string => {
  const slug = toolkitSlugFromPath(new URL(request.url).pathname);
  return slug
    ? `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/${encodeURIComponent(slug)}`
    : MCP_PROTECTED_RESOURCE_METADATA_PATH;
};

const protectedResourceMetadataResponse = (request: Request): Response => {
  const url = new URL(request.url);
  return new Response(
    JSON.stringify({
      resource: new URL(resourcePathForRequest(request), url.origin).toString(),
      authorization_servers: [],
    }),
    { headers: { "content-type": "application/json" } },
  );
};

/** Rebuild the neutral delegated principal only after the current Access JWT
 * and the durable grant both resolve. The MCP worker is a separate entrypoint
 * from the HTTP app, so it opens the request's D1 handle here and closes it
 * before forwarding to the session DO. `unmapped` is the one compatibility
 * case: a valid, previously unseen Access service token remains an ordinary
 * machine principal. Every mapped failure (revoked, expired, mismatched, or
 * storage failure) returns null and therefore 401s; it never falls back. */
const delegatedPrincipalFrom = (grant: DelegationGrant, config: CloudflareConfig): Principal => ({
  kind: "delegated",
  accountId: String(grant.effectiveSubject),
  organizationId: config.organizationId,
  organizationName: config.organizationName,
  organizationSlug: config.organizationSlug,
  email: "",
  name: null,
  avatarUrl: null,
  roles: [],
  orgRoleModel: "organization",
  orgRole: "member",
  tenant: String(grant.tenant),
  grantId: String(grant.grantId),
  credentialId: String(grant.credentialId),
  credentialRef: grant.credentialRef,
  actorSubject: String(grant.actorSubject),
  effectiveSubject: String(grant.effectiveSubject),
  scopeVersion: String(grant.scopeVersion),
});

export const resolveCloudflareAccessMcpPrincipal = (
  request: Request,
  env: CloudflareEnv,
  config: CloudflareConfig,
): Effect.Effect<Principal | null> =>
  Effect.gen(function* () {
    const { verifyWithClaims } = makeAccessVerifier(config);
    const verified = yield* verifyWithClaims(request);
    if (verified === null) return null;
    if (classifyAccessClaims(verified.claims) !== "service-token") return verified.principal;

    const credential = delegatedCredentialFromAccessClaims(verified.claims, config);
    if (credential === null) return null;

    const dbHandle = yield* Effect.tryPromise({
      try: () => createD1ExecutorDb(env.DB, env.BLOBS),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    if (dbHandle === null) return null;

    const registry = makeVerifiedHumanSubjectRegistry(dbHandle.db);
    const service = makeCloudflareDelegationService(
      dbHandle,
      config,
      makeCloudflareDelegationAuthority(config, registry, request),
    );
    return yield* Effect.acquireUseRelease(
      Effect.succeed(dbHandle),
      () =>
        service.resolve(credential).pipe(
          Effect.map((grant) => delegatedPrincipalFrom(grant, config)),
          Effect.catchTag("DelegationDeniedError", (error) =>
            error.reason === "unmapped" ? Effect.succeed(verified.principal) : Effect.succeed(null),
          ),
          Effect.catch(() => Effect.succeed(null)),
        ),
      (handle) => Effect.promise(() => handle.close()),
    );
  });

/** Access MCP auth with the same delegated resolver used by the HTTP identity
 * cheap generic verifier while the actual MCP worker request performs the
 * durable grant lookup and live revalidation. */
export const cloudflareDelegatedAccessMcpAuth = (
  config: CloudflareConfig,
  env: CloudflareEnv,
): Layer.Layer<McpAuthProvider> => {
  const discoveryRoutes: ReadonlyArray<McpDiscoveryRoute> = [
    {
      path: PROTECTED_RESOURCE_METADATA_PATH,
      handler: (request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    },
    {
      path: MCP_PROTECTED_RESOURCE_METADATA_PATH,
      handler: (request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    },
    {
      path: TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH,
      handler: (request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    },
  ];
  return Layer.succeed(McpAuthProvider)({
    discoveryRoutes,
    resourceMetadataUrl: (request) =>
      new URL(metadataPathForRequest(request), new URL(request.url).origin).toString(),
    authenticate: (request) =>
      resolveCloudflareAccessMcpPrincipal(request, env, config).pipe(
        Effect.map((principal) => (principal ? authenticated(principal) : unauthorized())),
      ),
  });
};
