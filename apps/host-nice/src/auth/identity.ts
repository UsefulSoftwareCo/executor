import { Effect, Layer } from "effect";

import { IdentityProvider, NoOrganization, Unauthorized } from "@executor-js/api/server";

import { BetterAuth, resolveActiveOrganizationId, type Auth } from "./better-auth";

/** Look up an organization's display name through Better Auth's adapter. */
const lookupOrgName = async (auth: Auth, organizationId: string): Promise<string | null> => {
  const { adapter } = await auth.$context;
  const org = await adapter.findOne<{ name: string }>({
    model: "organization",
    where: [{ field: "id", value: organizationId }],
  });
  return org?.name ?? null;
};

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
      const { auth, defaultOrganizationId } = yield* BetterAuth;
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
            // Multi-org: resolve the caller's active org from the session's
            // activeOrganizationId; fall back to their first membership, then to
            // the optional bootstrap default org. A valid user with no org at all
            // is a 403 (NoOrganization), not a 401.
            const resolvedOrganizationId = yield* Effect.promise(() =>
              resolveActiveOrganizationId(
                auth,
                resolved.user.id,
                resolved.session.activeOrganizationId,
                defaultOrganizationId,
              ),
            );
            if (!resolvedOrganizationId) return yield* new NoOrganization();
            const organizationName =
              (yield* Effect.promise(() => lookupOrgName(auth, resolvedOrganizationId))) ??
              resolvedOrganizationId;
            return {
              accountId: resolved.user.id,
              organizationId: resolvedOrganizationId,
              organizationName,
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
