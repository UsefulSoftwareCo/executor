import { Effect, Layer } from "effect";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";

import { IdentityProvider, isPlatformPrincipal } from "../server/identity";
import {
  authenticated,
  McpAuthProvider,
  unauthorized,
  type AuthOutcome,
  type McpDiscoveryRoute,
  type Principal,
} from "@executor-js/host-mcp";

import { BetterAuth } from "./identity";

// ---------------------------------------------------------------------------
// Org-path segment stripping and recovery helpers.
// Re-homed and bundled here so the shared Better Auth MCP auth provider is
// self-contained.
// ---------------------------------------------------------------------------

const PRM_PREFIX = "/.well-known/oauth-protected-resource";
export const MCP_ORIGINAL_PATH_HEADER = "x-executor-mcp-original-path";

export const stripMcpOrgSegment = (pathname: string): string | null => {
  if (pathname.startsWith(`${PRM_PREFIX}/`)) {
    const rest = pathname
      .slice(PRM_PREFIX.length + 1)
      .split("/")
      .filter((segment) => segment.length > 0);
    if (rest.length === 2 && rest[1] === "mcp") return PRM_PREFIX;
    if (rest.length === 4 && rest[1] === "mcp" && rest[2] === "toolkits") {
      return `${PRM_PREFIX}/mcp/toolkits/${rest[3]}`;
    }
    return null;
  }
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 2 && segments[1] === "mcp") return "/mcp";
  if (segments.length === 4 && segments[1] === "mcp" && segments[2] === "toolkits") {
    return `/mcp/toolkits/${segments[3]}`;
  }
  return null;
};

export const isRecognizedMcpOrgPath = (pathname: string): boolean =>
  stripMcpOrgSegment(pathname) !== null;

export const mcpResourcePathFromOriginalPath = (pathname: string): string | null => {
  if (!isRecognizedMcpOrgPath(pathname)) return null;
  return pathname.startsWith(`${PRM_PREFIX}/`) ? pathname.slice(PRM_PREFIX.length) : pathname;
};

// ---------------------------------------------------------------------------
// Better Auth MCP Auth Provider Seam implementation.
// ---------------------------------------------------------------------------

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}/mcp/toolkits/:toolkitSlug`;
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const TOOLKIT_MCP_SEGMENT = "/mcp/toolkits/";

const parseRoles = (role: string | null | undefined): ReadonlyArray<string> =>
  (role ?? "user")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

const userRole = (user: object): string | null => {
  const role = (user as { readonly role?: unknown }).role;
  return typeof role === "string" ? role : null;
};

const hasBearer = (request: Request): boolean =>
  (request.headers.get("authorization") ?? "").startsWith("Bearer ");

const originalOrgScopedPathFor = (request: Request): string | null => {
  const header = request.headers.get(MCP_ORIGINAL_PATH_HEADER);
  return header ? mcpResourcePathFromOriginalPath(header) : null;
};

const effectivePathnameFor = (request: Request): string =>
  originalOrgScopedPathFor(request) ?? new URL(request.url).pathname;

const toolkitSlugFromRequest = (request: Request): string | null => {
  const pathname = effectivePathnameFor(request);
  const index = pathname.indexOf(TOOLKIT_MCP_SEGMENT);
  if (index < 0) return null;
  const slug = pathname.slice(index + TOOLKIT_MCP_SEGMENT.length).split("/", 1)[0];
  return slug && slug.length > 0 ? slug : null;
};

const mcpResourcePathFor = (request: Request): string => {
  const orgScoped = originalOrgScopedPathFor(request);
  if (orgScoped) return orgScoped;
  const toolkitSlug = toolkitSlugFromRequest(request);
  return toolkitSlug ? `/mcp/toolkits/${toolkitSlug}` : "/mcp";
};

const resourceMetadataUrlFor = (baseURL: string | undefined, request: Request): string => {
  const origin = baseURL && baseURL.length > 0 ? baseURL : new URL(request.url).origin;
  const orgScoped = originalOrgScopedPathFor(request);
  if (orgScoped) return `${origin}${PROTECTED_RESOURCE_METADATA_PATH}${orgScoped}`;
  const toolkitSlug = toolkitSlugFromRequest(request);
  return toolkitSlug
    ? `${origin}${PROTECTED_RESOURCE_METADATA_PATH}/mcp/toolkits/${toolkitSlug}`
    : `${origin}${PROTECTED_RESOURCE_METADATA_PATH}`;
};

const resourceUrlFor = (baseURL: string | undefined, request: Request): string => {
  const origin = baseURL && baseURL.length > 0 ? baseURL : new URL(request.url).origin;
  return `${origin}${mcpResourcePathFor(request)}`;
};

const toolkitProtectedResourceMetadata = (
  request: Request,
  response: Response,
  baseURL: string | undefined,
): Effect.Effect<Response> => {
  const toolkitSlug = toolkitSlugFromRequest(request);
  if (!toolkitSlug) return Effect.succeed(response);
  return Effect.promise(async () => {
    const body = (await response.json()) as Record<string, unknown>;
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ ...body, resource: resourceUrlFor(baseURL, request) }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
};

export const betterAuthMcpAuth: Layer.Layer<McpAuthProvider, never, BetterAuth | IdentityProvider> =
  Layer.effect(
    McpAuthProvider,
    Effect.gen(function* () {
      const { auth, organizationId, organizationName, organizationSlug } = yield* BetterAuth;
      const fallback = yield* IdentityProvider;

      const asMetadata = oAuthDiscoveryMetadata(auth);
      const prMetadata = oAuthProtectedResourceMetadata(auth);

      const baseURL = (auth.options as any).baseURL;
      const resourceMetadataUrl = (request: Request): string =>
        resourceMetadataUrlFor(baseURL, request);

      const challengeFor = (request: Request): string =>
        `Bearer resource_metadata="${resourceMetadataUrl(request)}"`;

      const discoveryRoutes: ReadonlyArray<McpDiscoveryRoute> = [
        {
          path: PROTECTED_RESOURCE_METADATA_PATH,
          handler: (request) =>
            Effect.promise(() => prMetadata(request)).pipe(
              Effect.flatMap((response) =>
                toolkitProtectedResourceMetadata(request, response, baseURL),
              ),
            ),
        },
        {
          path: TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH,
          handler: (request) =>
            Effect.promise(() => prMetadata(request)).pipe(
              Effect.flatMap((response) =>
                toolkitProtectedResourceMetadata(request, response, baseURL),
              ),
            ),
        },
        {
          path: AUTHORIZATION_SERVER_METADATA_PATH,
          handler: (request) => Effect.promise(() => asMetadata(request)),
        },
      ];

      const context = yield* Effect.promise(() => auth.$context);

      const principalFromUserId = (userId: string): Effect.Effect<Principal | null> =>
        Effect.gen(function* () {
          const user = yield* Effect.promise(() => context.internalAdapter.findUserById(userId));
          if (!user) return null;
          return {
            accountId: user.id,
            organizationId,
            organizationName,
            organizationSlug,
            email: user.email ?? "",
            name: user.name ?? null,
            avatarUrl: user.image ?? null,
            roles: parseRoles(userRole(user)),
          } satisfies Principal;
        });

      const authenticateOAuthBearer = (request: Request): Effect.Effect<Principal | null> =>
        Effect.gen(function* () {
          const session = yield* Effect.promise(() =>
            auth.api.getMcpSession({ headers: request.headers }),
          );
          if (!session) return null;
          if (new Date(session.accessTokenExpiresAt).getTime() < Date.now()) return null;
          return yield* principalFromUserId(session.userId);
        }).pipe(Effect.orElseSucceed(() => null));

      const authenticateSession = (request: Request): Effect.Effect<Principal | null> =>
        fallback.authenticate(request).pipe(
          Effect.map((principal) => (isPlatformPrincipal(principal) ? null : principal)),
          Effect.catchTags({
            Unauthorized: () => Effect.succeed(null),
            NoOrganization: () => Effect.succeed(null),
            ReadOnlyCredential: () => Effect.succeed(null),
          }),
        );

      const authenticate = (request: Request): Effect.Effect<AuthOutcome> =>
        (hasBearer(request)
          ? authenticateOAuthBearer(request).pipe(
              Effect.flatMap((principal) =>
                principal ? Effect.succeed(principal) : authenticateSession(request),
              ),
            )
          : authenticateSession(request)
        ).pipe(
          Effect.map((principal) =>
            principal ? authenticated(principal) : unauthorized(challengeFor(request)),
          ),
        );

      return {
        discoveryRoutes,
        resourceMetadataUrl,
        authenticate,
      };
    }),
  );
