import { Effect, Layer } from "effect";

import { IdentityProvider, Unauthorized } from "@executor-js/api/server";

import { isPrivileged } from "../admin/require-admin";
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
// `betterAuthIdentityLayer` is the only production provider. The trivial fake
// identities tests inject live in `src/testing/test-app.ts`.
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

// ---------------------------------------------------------------------------
// The production IdentityProvider: resolve a request to a Better Auth session
// and map it to a neutral Principal. Three credential shapes resolve here:
//   - session cookie (browser SPA)
//   - Bearer session token (bearer plugin)
//   - Bearer API key — the apiKey plugin reads `x-api-key`, so when the normal
//     resolution fails we retry with the Bearer value as x-api-key, which (with
//     enableSessionForAPIKeys) mints the owner's session. This is what lets a
//     generated API key authenticate the API + MCP endpoint as a Bearer token.
// Single-org instance, so organizationName is the boot-cached org name.
// ---------------------------------------------------------------------------

export const betterAuthIdentityLayer: Layer.Layer<IdentityProvider, never, BetterAuth> =
  Layer.effect(IdentityProvider)(
    Effect.gen(function* () {
      const betterAuth = yield* BetterAuth;
      const { auth, organizationId, organizationName, organizationSlug } = betterAuth;
      return IdentityProvider.of({
        authenticate: (request) =>
          Effect.gen(function* () {
            let resolved = yield* Effect.promise(() =>
              auth.api.getSession({ headers: request.headers }),
            );
            // The credential shape that resolved the session — the SAME headers
            // are what the membership-role lookup below must present.
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
            // No session resolved from any credential shape -> unauthenticated.
            // The middleware's failure strategy renders this as a 401.
            if (!resolved) return yield* new Unauthorized();
            // Single-org instance: every authenticated user belongs to the one
            // seeded org. Cookie/bearer-session logins are pinned to it by the
            // session hook; API-key-minted sessions carry no active org, so we
            // default to the seeded org rather than rejecting with NoOrganization.
            const resolvedOrganizationId = resolved.session.activeOrganizationId ?? organizationId;
            // The workspace role, resolved against the INSTANCE org exactly as
            // the admin gate does (require-admin.ts): the explicit
            // `organizationId` query keeps a caller-controlled active org from
            // answering for an org they own elsewhere. FAIL CLOSED to "member"
            // — an infra fault demotes rather than escalates.
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
              orgRoleModel: "organization",
              orgRole,
            };
          }),
      });
    }),
  );
