import { Effect, Layer } from "effect";

import { IdentityProvider, NoOrganization, Unauthorized } from "@executor-js/api/server";

import { bearerShapeMemoFor, bearerTokenOf } from "./bearer-shape";
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
//     A bearer that last resolved this way is remembered (./bearer-shape) and
//     tried as an API key first next time, skipping the session lookup that
//     cannot match it; the key is still verified on every request.
// Single-org instance, so organizationName is the boot-cached org name.
// ---------------------------------------------------------------------------

export const betterAuthIdentityLayer: Layer.Layer<IdentityProvider, never, BetterAuth> =
  Layer.effect(IdentityProvider)(
    Effect.gen(function* () {
      const betterAuth = yield* BetterAuth;
      const { auth, organizationId, organizationName, organizationSlug } = betterAuth;
      const bearerShapes = bearerShapeMemoFor(auth);

      type Resolved = Awaited<ReturnType<typeof auth.api.getSession>>;
      const sessionFor = (headers: Headers): Effect.Effect<Resolved> =>
        Effect.promise(() => auth.api.getSession({ headers })).pipe(
          Effect.withSpan("selfhost.identity.session"),
        );
      const apiKeySessionFor = (token: string): Effect.Effect<Resolved> =>
        Effect.tryPromise({
          try: () => auth.api.getSession({ headers: { "x-api-key": token } }),
          catch: () => "api-key session lookup failed",
        }).pipe(
          Effect.orElseSucceed(() => null),
          Effect.tap((resolved) =>
            Effect.sync(() => {
              if (resolved) bearerShapes.rememberApiKey(token);
              else bearerShapes.forget(token);
            }),
          ),
          Effect.withSpan("selfhost.identity.api_key_session"),
        );

      return IdentityProvider.of({
        authenticate: (request) =>
          Effect.gen(function* () {
            const token = bearerTokenOf(request.headers);
            // A bearer that last resolved as an API key goes straight to the
            // key lookup. Should the key no longer resolve, the memo forgets
            // it and the full order below runs unchanged.
            let resolved: Resolved =
              token !== undefined && bearerShapes.isApiKey(token)
                ? yield* apiKeySessionFor(token)
                : null;
            if (!resolved) resolved = yield* sessionFor(request.headers);
            if (!resolved && token !== undefined) resolved = yield* apiKeySessionFor(token);
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
            ).pipe(Effect.withSpan("selfhost.identity.org_role"));
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
