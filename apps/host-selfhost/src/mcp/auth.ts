import { Effect, Layer } from "effect";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";

import { IdentityProvider } from "@executor-js/api/server";
import {
  authenticated,
  McpAuthProvider,
  unauthorized,
  type AuthOutcome,
  type McpDiscoveryRoute,
  type Principal,
} from "@executor-js/host-mcp";

import { BetterAuth } from "../auth/better-auth";
import { MCP_ORIGINAL_PATH_HEADER, mcpResourcePathFromOriginalPath } from "./org-path";

// ---------------------------------------------------------------------------
// Self-host McpAuthProvider adapter, backed by Better Auth's mcp() plugin.
//
// Responsibilities the envelope needs:
//
//  1. DECLARE the discovery routes it owns. MCP clients probe the true origin
//     ROOT, but Better Auth's handler only mounts the well-known docs under
//     /api/auth/.well-known/*, so we re-emit BOTH docs at the bare origin root
//     via the plugin's helpers. The envelope registers a GET for each declared
//     path.
//
//  2. `resourceMetadataUrl(request)` — the absolute `resource_metadata` URL the
//     401 challenge points at: the bare origin-root protected-resource doc
//     (`<origin>/.well-known/oauth-protected-resource`) UNLESS the request came
//     in org-scoped (`/<org>/mcp…`), in which case both this and the PRM
//     document's `resource` field must echo the org-scoped form back — the MCP
//     SDK client enforces that the advertised `resource` is a same-origin
//     path-prefix of the URL it actually dialed (RFC 9728). The strip
//     middleware (../serve.ts, ../../vite.config.ts) rewrites org-scoped
//     requests to the bare route before they reach here, so the org prefix is
//     recovered from MCP_ORIGINAL_PATH_HEADER, not the live request path.
//
//  3. `authenticate(request)` resolving an MCP principal as a typed AuthOutcome,
//     trying two credential shapes in order:
//       a. The mcp() OAuth opaque bearer (getMcpSession) — ONLY when an
//          `Authorization: Bearer …` header is present (avoids a getMcpSession
//          round-trip on every cookie request). getMcpSession does NOT validate
//          `accessTokenExpiresAt`, so we ENFORCE expiry ourselves before
//          accepting it, then enrich the bare {userId} into a full principal.
//       b. The existing IdentityProvider path (session cookie / bearer-session /
//          x-api-key) — preserves API-key Bearer access for the API + MCP.
//     Anything that fails or yields nothing collapses to `Unauthorized`; the
//     envelope renders the 401 + challenge. Self-host always has an org, so it
//     never returns Forbidden/Unavailable.
//
// The OAuth endpoints themselves (/api/auth/mcp/{register,authorize,token})
// stay on the Better Auth handler mounted at /api/auth — NOT in this seam.
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

/**
 * The admin plugin's `role` column is populated at runtime but isn't part of
 * Better Auth's static base-user type, so read it through a single typed view.
 */
const userRole = (user: object): string | null => {
  const role = (user as { readonly role?: unknown }).role;
  return typeof role === "string" ? role : null;
};

const hasBearer = (request: Request): boolean =>
  (request.headers.get("authorization") ?? "").startsWith("Bearer ");

/**
 * The org-scoped pathname the client actually dialed, recovered from the strip
 * middleware's header (see ./org-path.ts). `null` for a request that was never
 * org-scoped (already-bare `/mcp…`), OR whose header value isn't one the
 * middleware would itself have set — never trust an arbitrary client-supplied
 * string here, even though the middleware already strips a spoofed header at
 * its own boundary; this is a second, cheap check against reflecting garbage
 * into a security-relevant URL.
 */
const originalOrgScopedPathFor = (request: Request): string | null => {
  const header = request.headers.get(MCP_ORIGINAL_PATH_HEADER);
  return header ? mcpResourcePathFromOriginalPath(header) : null;
};

/** The pathname to derive the toolkit slug / resource path from: the
 * org-scoped original when the client dialed org-scoped, else the request's
 * own (already-bare) path. */
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

/**
 * Absolute protected-resource metadata URL for the 401 challenge. Derive the
 * origin from `baseURL` when set; otherwise from the live request so the URL is
 * never relative (cloud-drop-in: a self-host behind any host resolves right).
 * When the client dialed org-scoped, echo the org-scoped PRM path back (see
 * `mcpResourcePathFor`) so the MCP SDK's same-origin resource check passes.
 */
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

export const selfHostMcpAuth: Layer.Layer<McpAuthProvider, never, BetterAuth | IdentityProvider> =
  Layer.effect(
    McpAuthProvider,
    Effect.gen(function* () {
      const { auth, organizationId, organizationName, organizationSlug } = yield* BetterAuth;
      const fallback = yield* IdentityProvider;

      const asMetadata = oAuthDiscoveryMetadata(auth);
      const prMetadata = oAuthProtectedResourceMetadata(auth);

      const baseURL = auth.options.baseURL;
      const resourceMetadataUrl = (request: Request): string =>
        resourceMetadataUrlFor(baseURL, request);

      // RFC 9728 challenge string carried on the Unauthorized outcome. Same shape
      // as the envelope's default; we supply it explicitly to keep the 401's
      // `WWW-Authenticate` fully owned by the provider.
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

      // Resolved once; `internalAdapter.findUserById` enriches an OAuth userId.
      const context = yield* Effect.promise(() => auth.$context);

      /** Enrich a bare OAuth `userId` into the full provider-neutral principal. */
      const principalFromUserId = (userId: string): Effect.Effect<Principal | null> =>
        Effect.gen(function* () {
          const user = yield* Effect.promise(() => context.internalAdapter.findUserById(userId));
          if (!user) return null;
          return {
            accountId: user.id,
            // Single-org self-host: OAuth tokens carry no active org, so pin to
            // the seeded org (same default as the cookie/api-key path).
            organizationId,
            organizationName,
            organizationSlug,
            email: user.email ?? "",
            name: user.name ?? null,
            avatarUrl: user.image ?? null,
            roles: parseRoles(userRole(user)),
          } satisfies Principal;
        });

      /** (a) The mcp() OAuth opaque bearer, with self-enforced expiry. */
      const authenticateOAuthBearer = (request: Request): Effect.Effect<Principal | null> =>
        Effect.gen(function* () {
          const session = yield* Effect.promise(() =>
            auth.api.getMcpSession({ headers: request.headers }),
          );
          if (!session) return null;
          // GOTCHA: getMcpSession does NOT validate accessTokenExpiresAt — an
          // expired token still resolves. Reject it here.
          if (new Date(session.accessTokenExpiresAt).getTime() < Date.now()) return null;
          return yield* principalFromUserId(session.userId);
        }).pipe(Effect.orElseSucceed(() => null));

      /** (b) The existing cookie / bearer-session / x-api-key path. The fallback's
       * api `Principal` shape is byte-identical to host-mcp's `Principal`. */
      const authenticateSession = (request: Request): Effect.Effect<Principal | null> =>
        fallback.authenticate(request).pipe(
          Effect.catchTags({
            Unauthorized: () => Effect.succeed(null),
            NoOrganization: () => Effect.succeed(null),
          }),
        );

      /**
       * Try the OAuth bearer ONLY when a Bearer header is present (no
       * getMcpSession round-trip on cookie requests), then the cookie/api-key
       * fallback. Self-host always pins an org, so the outcome is always
       * Authenticated or Unauthorized.
       */
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
