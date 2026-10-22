import { Effect, Layer } from "effect";

import { IdentityProvider, Unauthorized } from "@executor-js/api/server";
import type { DelegationGrant, VerifiedDelegatedCredential } from "@executor-js/sdk";

import { isPrivileged } from "../admin/require-admin";
import { makeSelfHostDelegationServiceForHeaders } from "../account/delegation-provider";
import type { SelfHostConfig } from "../config";
import type { SelfHostDbHandle } from "../db/self-host-db";
import { BetterAuth, type BetterAuthHandle } from "./better-auth";

// ---------------------------------------------------------------------------
// The self-host identity seam — the production implementation of the shared
// `IdentityProvider` from `@executor-js/api/server`, which resolves an incoming
// request to a Principal. WorkOS (cloud) and Better Auth (self-host) are
// interchangeable implementations of the same tag; nothing downstream knows
// which is wired.
//
//   - succeeds with a Principal      -> authenticated
//   - fails Unauthorized             -> no/invalid credential (renders 401)
//   - fails NoOrganization           -> valid credential, no org (renders 403)
//
// The trivial fake identities tests inject live in `src/testing/test-app.ts`.
// ---------------------------------------------------------------------------

const bearerToken = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization");
  if (!authorization) return undefined;
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim() || undefined
    : undefined;
};

/**
 * Resolve workspace-write authority from the caller's current membership in
 * the self-host instance organization. Both ordinary API/MCP requests and the
 * browser-decision adapter use this exact lookup so a role change takes effect
 * at the mutation decision, without trusting the global Better Auth user role.
 * Lookup failures fail closed to member authority.
 */
export const resolveSelfHostOrgRole = (
  betterAuth: BetterAuthHandle,
  headers: Headers | Record<string, string>,
  organizationId: string,
): Effect.Effect<"admin" | "member"> =>
  Effect.tryPromise(() =>
    betterAuth.auth.api.getActiveMemberRole({
      headers,
      query: { organizationId },
    }),
  ).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((membership) => (membership && isPrivileged(membership.role) ? "admin" : "member")),
  );

const delegatedPrincipalFrom = (
  grant: DelegationGrant,
  betterAuth: BetterAuthHandle,
): import("@executor-js/api/server").Principal => ({
  kind: "delegated",
  accountId: String(grant.effectiveSubject),
  organizationId: betterAuth.organizationId,
  organizationName: betterAuth.organizationName,
  organizationSlug: betterAuth.organizationSlug,
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
  delegation: grant,
});

const bearerValue = (request: Request): string | undefined => {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim() || undefined;
  }
  return request.headers.get("x-api-key") ?? undefined;
};

// Core-issued keys are intentionally a reserved local format. Self-host uses
// Better Auth API keys as its provider credentials, so a malformed or revoked
// local key must not fall through to the cookie/session resolver.
const isReservedLocalIssuedKey = (token: string): boolean =>
  /^key_[0-9a-f]{32}\.[0-9a-f]{64}$/.test(token);

// An explicit x-api-key header is always an API-key attempt. A bearer paired
// with a browser cookie is also treated as an API-key attempt: this prevents a
// revoked provider key from falling through to the valid human cookie. Bare
// bearer tokens retain Better Auth session compatibility because Better Auth
// does not give session and API-key token strings distinct prefixes.
const isExplicitBetterAuthApiKey = (request: Request): boolean =>
  request.headers.has("x-api-key") || request.headers.has("cookie");

const isProviderIssuedDelegationKey = (metadata: unknown): boolean => {
  if (typeof metadata !== "object" || metadata === null) return false;
  const value = (metadata as Record<string, unknown>).executorDelegationCredentialId;
  return typeof value === "string" && value.length > 0;
};

const delegatedApiKey = (
  request: Request,
  betterAuth: BetterAuthHandle,
  service: ReturnType<typeof makeSelfHostDelegationServiceForHeaders>,
): Effect.Effect<import("@executor-js/api/server").Principal | null, Unauthorized> => {
  const token = bearerValue(request);
  if (!token) return Effect.succeed(null);
  if (isReservedLocalIssuedKey(token)) return Effect.fail(new Unauthorized());
  const explicitApiKey = isExplicitBetterAuthApiKey(request);
  // Keep the verifier failure boundary separate from delegation resolution.
  // A verifier result with no key is the compatibility case for a normal
  // Better Auth session bearer. Once a key tuple has resolved, however, any
  // revoked/expired/tuple-mismatched/storage failure must remain Unauthorized;
  // swallowing that failure for a bare bearer would let getSession turn the
  // revoked provider key back into its owner's unrestricted member session.
  const verify = Effect.tryPromise({
    try: () =>
      betterAuth.auth.api.verifyApiKey({
        body: { key: token },
        headers: request.headers,
      }),
    catch: () => new Unauthorized(),
  });
  return verify.pipe(
    Effect.flatMap((result) => {
      if (!result?.valid || !result.key) {
        return explicitApiKey ? Effect.fail(new Unauthorized()) : Effect.succeed(null);
      }
      const credential: VerifiedDelegatedCredential = {
        kind: isProviderIssuedDelegationKey(result.key.metadata) ? "issued-key" : "external",
        adapter: "better-auth-api-key",
        issuer: betterAuth.auth.options.baseURL,
        audience: betterAuth.organizationId,
        subject: result.key.referenceId,
        credentialRef: result.key.id,
      };
      return service.resolve(credential).pipe(
        Effect.map((grant) => delegatedPrincipalFrom(grant, betterAuth)),
        Effect.catchTags({
          DelegationDeniedError: (error) =>
            error.reason === "unmapped" ? Effect.succeed(null) : Effect.fail(new Unauthorized()),
        }),
        Effect.mapError(() => new Unauthorized()),
      );
    }),
  );
};

/** Identity seam with the live delegated external-credential resolver. */
export const makeBetterAuthDelegatingIdentityLayer = (
  db: SelfHostDbHandle,
  config: SelfHostConfig,
): Layer.Layer<IdentityProvider, never, BetterAuth> =>
  Layer.effect(IdentityProvider)(
    Effect.gen(function* () {
      const betterAuth = yield* BetterAuth;
      const { auth, organizationId, organizationName, organizationSlug } = betterAuth;
      return IdentityProvider.of({
        authenticate: (request) =>
          Effect.gen(function* () {
            const delegated = yield* delegatedApiKey(
              request,
              betterAuth,
              makeSelfHostDelegationServiceForHeaders(db, betterAuth, config, request.headers),
            );
            if (delegated) return delegated;
            let resolved = yield* Effect.promise(() =>
              auth.api.getSession({ headers: request.headers }),
            );
            let sessionHeaders: Headers | Record<string, string> = request.headers;
            if (!resolved) {
              const token = bearerToken(request.headers);
              if (token) {
                const apiKeyHeaders = { "x-api-key": token };
                resolved = yield* Effect.tryPromise({
                  try: () => auth.api.getSession({ headers: apiKeyHeaders }),
                  catch: () => "api-key session lookup failed",
                }).pipe(Effect.orElseSucceed(() => null));
                sessionHeaders = apiKeyHeaders;
              }
            }
            if (!resolved) return yield* new Unauthorized();
            const resolvedOrganizationId = resolved.session.activeOrganizationId ?? organizationId;
            const orgRole = yield* resolveSelfHostOrgRole(
              betterAuth,
              sessionHeaders,
              resolvedOrganizationId,
            );
            return {
              kind: "member" as const,
              accountId: resolved.user.id,
              organizationId: resolvedOrganizationId,
              organizationName,
              organizationSlug,
              email: resolved.user.email,
              name: resolved.user.name ?? null,
              avatarUrl: resolved.user.image ?? null,
              roles: (resolved.user.role ?? "user")
                .split(",")
                .map((role) => role.trim())
                .filter((role) => role.length > 0),
              orgRoleModel: "organization" as const,
              orgRole,
            };
          }),
      });
    }),
  );
