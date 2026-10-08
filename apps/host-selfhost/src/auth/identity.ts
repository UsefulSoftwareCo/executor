import { Effect, Layer } from "effect";

import { IdentityProvider, NoOrganization, Unauthorized } from "@executor-js/api/server";

import { BetterAuth, type BetterAuthHandle } from "./better-auth";
import { findInstanceMembership, type InstanceOrgRole } from "./membership";

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
 * Require the caller's CURRENT membership in the self-host instance
 * organization and resolve workspace-write authority from it. Ordinary
 * API/MCP requests and the browser-decision adapter use this exact lookup, so
 * removing a member denies their next request and a role change takes effect
 * at the next mutation decision, without trusting the global Better Auth user
 * role. A missing row — and a lookup failure — fails `NoOrganization` (403).
 */
export const requireInstanceMembership = (
  betterAuth: BetterAuthHandle,
  userId: string,
  organizationId: string,
): Effect.Effect<InstanceOrgRole, NoOrganization> =>
  findInstanceMembership(betterAuth, userId, organizationId).pipe(
    Effect.flatMap((membership) =>
      membership ? Effect.succeed(membership.role) : Effect.fail(new NoOrganization()),
    ),
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
            if (!resolved) {
              const token = bearerToken(request.headers);
              if (token) {
                resolved = yield* Effect.tryPromise({
                  try: () => auth.api.getSession({ headers: { "x-api-key": token } }),
                  catch: () => "api-key session lookup failed",
                }).pipe(Effect.orElseSucceed(() => null));
              }
            }
            // No session resolved from any credential shape -> unauthenticated.
            // The middleware's failure strategy renders this as a 401.
            if (!resolved) return yield* new Unauthorized();
            // Single-org instance: every authenticated user belongs to the one
            // seeded org. Cookie/bearer-session logins are pinned to it by the
            // session hook; API-key-minted sessions carry no active org, so we
            // default to the seeded org. Whether the user STILL belongs to it
            // is decided below, on every request.
            const resolvedOrganizationId = resolved.session.activeOrganizationId ?? organizationId;
            // The credential names a user; the member row names a member. A
            // user with no row in the INSTANCE org (removed, or never added) is
            // refused with NoOrganization (403) — a removed member loses API
            // and MCP access on their next request, whichever credential they
            // hold. The workspace role comes from the same row, resolved
            // against the instance org exactly as the admin gate does
            // (require-admin.ts). Lookup failures fail closed to a refusal.
            const orgRole = yield* requireInstanceMembership(
              betterAuth,
              resolved.user.id,
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
