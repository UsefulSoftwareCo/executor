// ---------------------------------------------------------------------------
// Cloud MCP auth — the McpAuth / McpOrganizationAuth tags + their Live layers
// (the cloud McpAuthProvider resolves them; tests swap them), the API-key +
// JWT bearer dispatch, plus the typed auth-result discriminant the provider
// folds into the envelope's AuthOutcome.
//
// The JWT verify/classify lives in the `cloudflare:workers`-free `./jwt` leaf
// (the node-pool test imports it directly); this module reads `cloudflare:
// workers` env and depends on `./jwt`, never the other way around.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Context, Effect, Layer, Predicate } from "effect";

import { createCachedRemoteJWKSet } from "../auth/jwks-cache";
import { ApiKeyService } from "../auth/api-keys";
import { BEARER_PREFIX } from "../auth/bearer";
import { authorizeOrganization } from "../auth/organization";
import { UserStoreService } from "../auth/context";
import { CoreSharedServices } from "../auth/workos";
import { DbService } from "../db/db";
import { bearerChallenge } from "./responses";
import { McpJwtVerificationError, verifyWorkOSMcpAccessToken, type VerifiedToken } from "./jwt";

export {
  McpJwtVerificationError,
  verifyMcpAccessToken,
  verifyWorkOSMcpAccessToken,
  type VerifiedToken,
} from "./jwt";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AUTHKIT_DOMAIN = env.MCP_AUTHKIT_DOMAIN ?? "https://signin.executor.sh";
export const RESOURCE_ORIGIN = env.MCP_RESOURCE_ORIGIN ?? "https://executor.sh";
const WORKOS_CLIENT_ID = env.WORKOS_CLIENT_ID;

// Module-scope cache survives across MCP requests within the same worker
// isolate. AuthKit's JWKS rotates on the order of hours/days, so a 1h TTL
// dominates the upstream cooldown without sacrificing rotation safety —
// `createCachedRemoteJWKSet` force-refreshes on key-not-found inside its
// resolver. Production telemetry showed ~222 fetches/8h with p99 1.7s on
// the previous default-cooldown setup; this collapses that to ~1 per
// isolate-hour.
const jwks = createCachedRemoteJWKSet(new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`));

const MCP_PATH = "/mcp";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
export const PROTECTED_RESOURCE_METADATA_URL = `${RESOURCE_ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}`;
export const RESOURCE_URL = `${RESOURCE_ORIGIN}${MCP_PATH}`;

// ---------------------------------------------------------------------------
// Org-scoped MCP (the URL pins an org: `/org_xxx/mcp`)
// ---------------------------------------------------------------------------
//
// An MCP client can pin a specific organization in the URL instead of relying on
// the token's `org_id` claim. start.ts / the test worker rewrite `/org_xxx/mcp`
// (and the org-scoped discovery doc) to the bare path the shared envelope routes
// and stash the URL-pinned org in this INTERNAL header; the provider reads it
// back. The org is re-checked against live WorkOS membership per request
// (`McpOrganizationAuth.authorize`), so the header — like the URL it came from —
// is a SELECTOR, not a trust boundary.
export const MCP_ORGANIZATION_HEADER = "x-executor-mcp-organization";

/** The URL-pinned org for an MCP request, or `null` for the bare `/mcp`. */
export const mcpOrganizationFromRequest = (request: Request): string | null =>
  request.headers.get(MCP_ORGANIZATION_HEADER);

/** The MCP resource URL for an org (`…/org_xxx/mcp`), or the bare resource. */
export const resourceUrlFor = (organizationId: string | null): string =>
  organizationId ? `${RESOURCE_ORIGIN}/${organizationId}${MCP_PATH}` : RESOURCE_URL;

/** The protected-resource-metadata URL for an org, or the bare one. */
export const protectedResourceMetadataUrlFor = (organizationId: string | null): string =>
  organizationId
    ? `${RESOURCE_ORIGIN}/.well-known/oauth-protected-resource/${organizationId}/mcp`
    : PROTECTED_RESOURCE_METADATA_URL;

type McpUnauthorizedReason = "missing_bearer" | "invalid_token";

type McpAuthorizedResult = {
  readonly _tag: "Authorized";
  readonly token: VerifiedToken;
};

type McpUnauthorizedResult = {
  readonly _tag: "Unauthorized";
  readonly reason: McpUnauthorizedReason;
  readonly description?: string;
};

export type McpAuthResult = McpAuthorizedResult | McpUnauthorizedResult;

export const mcpAuthorized = (token: VerifiedToken): McpAuthorizedResult => ({
  _tag: "Authorized",
  token,
});

export const mcpUnauthorized = (
  reason: McpUnauthorizedReason,
  description?: string,
): McpUnauthorizedResult => ({
  _tag: "Unauthorized",
  reason,
  description,
});

/**
 * Reason-sensitive RFC 9728 challenge for an Unauthorized auth result. The
 * challenge points at the org-scoped resource metadata when the request pinned
 * an org in the URL (`/org_xxx/mcp`), else the bare document.
 */
export const bearerChallengeFor = (
  result: McpUnauthorizedResult,
  organizationId: string | null = null,
): string =>
  bearerChallenge(
    { reason: result.reason, description: result.description },
    protectedResourceMetadataUrlFor(organizationId),
  );

// ---------------------------------------------------------------------------
// Auth tags + Live layers
// ---------------------------------------------------------------------------

export class McpAuth extends Context.Service<
  McpAuth,
  {
    readonly verifyBearer: (
      request: Request,
    ) => Effect.Effect<McpAuthResult, McpJwtVerificationError>;
  }
>()("@executor-js/cloud/McpAuth") {}

export class McpOrganizationAuth extends Context.Service<
  McpOrganizationAuth,
  {
    readonly authorize: (
      accountId: string,
      organizationId: string,
    ) => Effect.Effect<boolean, unknown>;
  }
>()("@executor-js/cloud/McpOrganizationAuth") {}

const verifyJwt = (token: string) =>
  verifyWorkOSMcpAccessToken(token, jwks, {
    issuer: AUTHKIT_DOMAIN,
    audience: WORKOS_CLIENT_ID,
  });

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
const McpOrganizationAuthServices = Layer.mergeAll(DbLive, UserStoreLive, CoreSharedServices);

export const McpOrganizationAuthLive = Layer.succeed(McpOrganizationAuth)({
  authorize: (accountId, organizationId) =>
    authorizeOrganization(accountId, organizationId).pipe(
      Effect.map((org) => org !== null),
      Effect.provide(McpOrganizationAuthServices),
    ),
});

const looksLikeJwt = (token: string): boolean => token.split(".").length === 3;

export const McpAuthLive = Layer.effect(
  McpAuth,
  Effect.gen(function* () {
    const apiKeys = yield* ApiKeyService;

    const verifyApiKey = Effect.fn("mcp.auth.verify_api_key")(function* (token: string) {
      const principal = yield* apiKeys.validate(token).pipe(
        Effect.catchTag("ApiKeyValidationError", (error) =>
          Effect.fail(
            new McpJwtVerificationError({
              cause: error.cause,
              reason: "system",
            }),
          ),
        ),
      );
      if (!principal) {
        yield* Effect.annotateCurrentSpan({
          "mcp.auth.outcome": "invalid",
          "mcp.auth.invalid_reason": "api_key",
        });
        return mcpUnauthorized("invalid_token", "The API key is invalid");
      }

      yield* Effect.annotateCurrentSpan({
        "mcp.auth.outcome": "verified",
        "mcp.auth.credential_type": "api_key",
        "mcp.auth.has_organization": true,
      });
      return mcpAuthorized({
        accountId: principal.accountId,
        organizationId: principal.organizationId,
      });
    });

    const verifyJwtBearer = Effect.fn("mcp.auth.verify_jwt_bearer")(function* (token: string) {
      const verified = yield* verifyJwt(token).pipe(
        Effect.catchTag("McpJwtVerificationError", (error) => {
          if (error.reason === "system") return Effect.fail(error);
          return Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan({
              "mcp.auth.outcome": "invalid",
              "mcp.auth.invalid_reason": error.reason,
            });
            return mcpUnauthorized(
              "invalid_token",
              error.reason === "expired"
                ? "The access token expired"
                : "The access token is invalid",
            );
          });
        }),
      );
      if (!verified) return mcpUnauthorized("invalid_token", "The access token is invalid");
      if (Predicate.isTagged(verified, "Unauthorized")) return verified;
      if (!verified.accountId) {
        yield* Effect.annotateCurrentSpan({ "mcp.auth.outcome": "missing_subject" });
        return mcpUnauthorized("invalid_token", "The access token is invalid");
      }
      yield* Effect.annotateCurrentSpan({
        "mcp.auth.outcome": "verified",
        "mcp.auth.credential_type": "jwt",
        "mcp.auth.has_organization": !!verified.organizationId,
      });
      return mcpAuthorized(verified);
    });

    return {
      verifyBearer: Effect.fn("mcp.auth.verify_bearer")(function* (request) {
        const authHeader = request.headers.get("authorization");
        if (!authHeader?.startsWith(BEARER_PREFIX)) {
          yield* Effect.annotateCurrentSpan({ "mcp.auth.outcome": "missing_bearer" });
          return mcpUnauthorized("missing_bearer");
        }
        const token = authHeader.slice(BEARER_PREFIX.length).trim();
        if (!token) return mcpUnauthorized("invalid_token", "The bearer token is invalid");
        return yield* looksLikeJwt(token) ? verifyJwtBearer(token) : verifyApiKey(token);
      }),
    };
  }),
);
