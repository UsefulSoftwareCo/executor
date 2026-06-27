import { Effect, Layer } from "effect";

import { IdentityProvider, NoOrganization, Unauthorized } from "@executor-js/api/server";
import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

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
 * Resolve the instance's one organization and verify that the user is still a
 * member. The optional selector comes from the console URL header (or a
 * credential's active organization) and must match the live organization id or
 * slug. Reading through Better Auth's database adapter keeps membership
 * removal and organization renames visible on the very next request.
 */
export const resolveSelfHostAuthorization = async (
  betterAuth: BetterAuthHandle,
  userId: string,
  selector?: string | null,
) => {
  const context = await betterAuth.auth.$context;
  const organization = await context.adapter.findOne<{
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  }>({
    model: "organization",
    where: [{ field: "id", value: betterAuth.organizationId }],
  });
  if (!organization) return null;
  if (selector && selector !== organization.id && selector !== organization.slug) return null;

  const member = await context.adapter.findOne<{
    readonly id: string;
    readonly userId: string;
    readonly organizationId: string;
    readonly role: string;
  }>({
    model: "member",
    where: [
      { field: "userId", value: userId },
      { field: "organizationId", value: organization.id },
    ],
  });
  return member ? { member, organization } : null;
};

// ---------------------------------------------------------------------------
// The production IdentityProvider: resolve a request to a Better Auth session
// and map it to a neutral Principal. Three credential shapes resolve here:
//   - session cookie (browser SPA)
//   - Bearer session token (bearer plugin)
//   - Bearer API key — the apiKey plugin reads `x-api-key`, so when the normal
//     resolution fails we retry with the Bearer value as x-api-key, which (with
//     enableSessionForAPIKeys) mints the owner's session. This is what lets a
//     generated API key authenticate the API + MCP endpoint as a Bearer token.
// The live organization row is resolved after the credential on every request.
// ---------------------------------------------------------------------------

export const betterAuthIdentityLayer: Layer.Layer<IdentityProvider, never, BetterAuth> =
  Layer.effect(IdentityProvider)(
    Effect.gen(function* () {
      const betterAuth = yield* BetterAuth;
      const { auth, organizationId } = betterAuth;
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

            const selector =
              request.headers.get(EXECUTOR_ORG_SELECTOR_HEADER) ??
              resolved.session.activeOrganizationId ??
              organizationId;
            const authorization = yield* Effect.promise(() =>
              resolveSelfHostAuthorization(betterAuth, resolved.user.id, selector),
            );
            if (!authorization) return yield* new NoOrganization();

            return {
              accountId: resolved.user.id,
              organizationId: authorization.organization.id,
              organizationName: authorization.organization.name,
              organizationSlug: authorization.organization.slug,
              email: resolved.user.email,
              name: resolved.user.name ?? null,
              avatarUrl: resolved.user.image ?? null,
              roles: (resolved.user.role ?? "user")
                .split(",")
                .map((role) => role.trim())
                .filter((role) => role.length > 0),
            };
          }),
      });
    }),
  );
