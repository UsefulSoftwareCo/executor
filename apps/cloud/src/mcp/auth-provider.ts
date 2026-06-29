// ---------------------------------------------------------------------------
// Cloud McpAuthProvider adapter — the cloud analog of selfHostMcpAuthProviderLayer.
//
// Folds the entire cloud edge auth/authz surface (WorkOS JWT verify + API-key
// bearer + per-request org-liveness check + the two OAuth discovery docs) into
// ONE `McpAuthProvider` Layer behind the shared host-mcp envelope.
//
// `authenticate(request)` runs on EVERY /mcp request and resolves a typed
// AuthOutcome:
//   - missing bearer       -> Unauthorized (challenge: Bearer resource_metadata=…)
//   - invalid token/api key -> Unauthorized (challenge: Bearer error="invalid_token" …)
//   - transient JWKS infra  -> Unavailable (caught here; envelope renders 503 -32001)
//   - no org / revoked org  -> Forbidden ("No organization in session …", -32001).
//       Because authenticate reads the mcp-session-id header to do the live org
//       check, the envelope's dispose-on-Forbidden-with-sessionId path reproduces
//       the old inline clearExistingSession.
//   - verified + org allowed -> Authenticated(principal)
//
// The rich `mcp.request.annotate` client-fingerprint span (cloud-specific, no
// envelope seam) is emitted from here so telemetry parity is preserved.
//
// The OAuth endpoints (/authorize, /token, /register) are NOT cloud's — they
// live at WorkOS/AuthKit (external); only the two discovery docs are mounted.
// ---------------------------------------------------------------------------

import { Cause, Effect, Layer, Predicate, Result } from "effect";

import {
  authenticated,
  forbidden,
  unauthorized,
  unavailable,
  McpAuthProvider,
  type AuthOutcome,
  type McpDiscoveryRoute,
  type Principal,
} from "@executor-js/host-mcp";

import { ApiKeyService } from "../auth/api-keys";
import { CoreSharedServices } from "../auth/workos";
import {
  bearerChallengeFor,
  mcpOrganizationFromRequest,
  protectedResourceMetadataUrlFor,
  PROTECTED_RESOURCE_METADATA_PATH,
  toolkitSlugFromRequest,
  McpAuth,
  McpAuthLive,
  McpOrganizationAuth,
  McpOrganizationAuthLive,
  type McpAuthResult,
  type VerifiedToken,
} from "./auth";
import { annotateMcpRequest } from "./telemetry";
import {
  authorizationServerMetadataResponse,
  protectedResourceMetadataResponse,
} from "./oauth-metadata";

const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}/toolkits/:toolkitSlug`;

const NO_ORGANIZATION_MESSAGE = "No organization in session — log in via the web app first";

/**
 * Enrich a cloud {@link VerifiedToken} (which carries only accountId +
 * organizationId) into the full {@link Principal} the seam validates. The
 * envelope only uses `accountId` + `organizationId` for ownership; cloud
 * resolves org name/email inside the DO, so the cosmetic identity fields carry
 * empty placeholders. `organizationId` is guaranteed non-null here because the
 * Forbidden branch already rejected the no-org case before Authenticated.
 */
const principalFromToken = (token: VerifiedToken, organizationId: string): Principal => ({
  accountId: token.accountId,
  organizationId,
  organizationName: "",
  email: "",
  name: null,
  avatarUrl: null,
  roles: [],
});

export const cloudMcpAuthProviderLayer: Layer.Layer<
  McpAuthProvider,
  never,
  McpAuth | McpOrganizationAuth
> = Layer.effect(
  McpAuthProvider,
  Effect.gen(function* () {
    const auth = yield* McpAuth;
    const orgAuth = yield* McpOrganizationAuth;

    const discoveryRoutes: ReadonlyArray<McpDiscoveryRoute> = [
      {
        path: PROTECTED_RESOURCE_METADATA_PATH,
        // The bare path is the only one mounted; `prepareMcpOrgScope` rewrites an
        // org-scoped discovery doc onto it and pins the org in the header we read.
        handler: (request) =>
          Effect.succeed(
            protectedResourceMetadataResponse(
              mcpOrganizationFromRequest(request),
              toolkitSlugFromRequest(request),
            ),
          ),
      },
      {
        path: TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH,
        handler: (request) =>
          Effect.succeed(
            protectedResourceMetadataResponse(
              mcpOrganizationFromRequest(request),
              toolkitSlugFromRequest(request),
            ),
          ),
      },
      {
        path: AUTHORIZATION_SERVER_METADATA_PATH,
        handler: () => authorizationServerMetadataResponse,
      },
    ];

    const resourceMetadataUrl = (request: Request): string =>
      protectedResourceMetadataUrlFor(
        mcpOrganizationFromRequest(request),
        toolkitSlugFromRequest(request),
      );

    /**
     * Resolve a verified bearer to a final AuthOutcome by running the live org
     * check. Mirrors the old `authorizeMcpOrganization`: no org -> Forbidden;
     * revoked live org -> Forbidden (the envelope disposes the session when a
     * session-id is present). Telemetry-annotates before returning so even 401s
     * and 403s carry the client fingerprint.
     */
    const finishAuthorized = (request: Request, token: VerifiedToken): Effect.Effect<AuthOutcome> =>
      Effect.gen(function* () {
        // OLD `mcpApp` annotated with parseBody = (POST && isAuthorized) BEFORE
        // org-authz, so a verified-but-no/revoked-org POST still captured
        // mcp.rpc.method/id. The body is read via `request.clone().text()`
        // (annotateMcpRequest -> readJsonRpcEnvelope), so it never consumes the
        // original stream a downstream dispatch reads — safe on every path,
        // including the Forbidden short-circuit. Keep parseBody keyed on POST,
        // not on the org outcome, to preserve that telemetry.
        const parseBody = request.method === "POST";

        // URL is the source of truth for the active org when pinned — the org's
        // slug (`/acme/mcp`, what the install card prints) or a legacy org id
        // (`/org_xxx/mcp`), carried in the header by `prepareMcpOrgScope`; the
        // bare `/mcp` falls back to the token's `org_id`. Either way
        // `orgAuth.authorize` resolves the selector and re-checks live WorkOS
        // membership below, so the URL is a selector, not a trust boundary.
        const organizationSelector = mcpOrganizationFromRequest(request) ?? token.organizationId;
        if (!organizationSelector) {
          yield* annotateMcpRequest(request, { token, parseBody });
          return forbidden(NO_ORGANIZATION_MESSAGE, -32001);
        }

        const organizationId = yield* orgAuth.authorize(token.accountId, organizationSelector).pipe(
          Effect.catchCause((error) =>
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({
                "mcp.auth.organization_authorize_error": Cause.pretty(error),
              });
              return null;
            }),
          ),
          Effect.withSpan("mcp.auth.authorize_organization", {
            attributes: { "mcp.auth.organization_selector": organizationSelector },
          }),
        );

        yield* annotateMcpRequest(request, { token, parseBody });

        if (!organizationId) return forbidden(NO_ORGANIZATION_MESSAGE, -32001);
        return authenticated(principalFromToken(token, organizationId));
      });

    const toOutcome = (request: Request, result: McpAuthResult): Effect.Effect<AuthOutcome> => {
      if (Predicate.isTagged(result, "Authorized")) {
        return finishAuthorized(request, result.token);
      }
      return annotateMcpRequest(request, { token: null, parseBody: false }).pipe(
        Effect.as(
          unauthorized(
            bearerChallengeFor(
              result,
              mcpOrganizationFromRequest(request),
              toolkitSlugFromRequest(request),
            ),
          ),
        ),
      );
    };

    /**
     * Never fails: a transient JWKS-infra failure (the McpJwtVerificationError
     * the old `mcpApp` caught and turned into a 503) is caught HERE and mapped
     * to Unavailable so the envelope renders the retryable 503 -32001.
     */
    const authenticate = (request: Request): Effect.Effect<AuthOutcome> =>
      auth.verifyBearer(request).pipe(
        Effect.result,
        Effect.flatMap((result) =>
          Result.isFailure(result)
            ? annotateMcpRequest(request, { token: null, parseBody: false }).pipe(
                Effect.flatMap(() =>
                  Effect.annotateCurrentSpan({
                    "mcp.auth.outcome": "system_error",
                    "mcp.auth.system_error.reason": result.failure.reason,
                    "mcp.auth.system_error.message": String(result.failure.cause).slice(0, 500),
                  }),
                ),
                Effect.as(unavailable("Authentication temporarily unavailable - please retry")),
              )
            : toOutcome(request, result.success),
        ),
        Effect.withSpan("mcp.request"),
      );

    return {
      discoveryRoutes,
      resourceMetadataUrl,
      authenticate,
    };
  }),
);

// ---------------------------------------------------------------------------
// The cloud MCP auth seam fed to `ExecutorApp.make`'s `mcp.auth` slot.
//
// `make`'s MCP seam contract is generic over the auth seam's residual
// (`Layer<McpAuthProvider, never, RMcpAuth>`). Cloud's MCP auth is a SEPARATE
// credential plane (WorkOS JWT + API-key bearer, no cookie session), so it does
// NOT read the neutral `IdentityProvider` fallback the way self-host does; it
// provides its own `McpAuth` + `McpOrganizationAuth` seams INTERNALLY (the
// production WorkOS JWT verify over `ApiKeyService.WorkOS` + live org-liveness),
// so `RMcpAuth = never` — no phantom requirement, no cast. (Self-host's seam
// genuinely requires `IdentityProvider`, so its `RMcpAuth = IdentityProvider`.)
// ---------------------------------------------------------------------------
export const cloudMcpAuth: Layer.Layer<McpAuthProvider> = cloudMcpAuthProviderLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAuthLive.pipe(Layer.provide(ApiKeyService.WorkOS.pipe(Layer.provide(CoreSharedServices)))),
      McpOrganizationAuthLive,
    ),
  ),
  // A boot-time WorkOS misconfiguration (the `WorkOSClient.Default` config error)
  // is unrecoverable; die rather than leak it into the seam's channel.
  // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: a boot-time WorkOS misconfiguration is unrecoverable
  Layer.orDie,
);
