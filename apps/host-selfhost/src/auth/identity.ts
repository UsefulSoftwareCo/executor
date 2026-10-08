import { Effect, Layer } from "effect";

import { IdentityProvider, Unauthorized } from "@executor-js/api/server";

import { isPrivileged } from "../admin/require-admin";
import { bearerShapeMemoFor, bearerTokenOf } from "./bearer-shape";
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

/**
 * Resolve workspace-write authority from the caller's current membership in
 * the self-host instance organization. Both ordinary API/MCP requests and the
 * browser-decision adapter use this exact lookup so a role change takes effect
 * at the mutation decision, without trusting the global Better Auth user role.
 * Lookup failures fail closed to member authority.
 *
 * This reads the `member` row directly — the same row, by the same
 * `(userId, organizationId)` key, that the organization plugin's
 * `getActiveMemberRole` endpoint answers from. That endpoint sits behind the
 * session middleware, so calling it with the request's credential verified
 * the credential a second time on every request: for an API key, a second
 * hash, lookup and `lastRequest` write. The caller already holds the
 * authenticated user id, so the row is read once and the credential once.
 */
export const resolveSelfHostOrgRole = (
  betterAuth: BetterAuthHandle,
  userId: string,
  organizationId: string,
): Effect.Effect<"admin" | "member"> =>
  Effect.tryPromise(async () => {
    const context = await betterAuth.auth.$context;
    return context.adapter.findOne<{ readonly role?: string | null }>({
      model: "member",
      where: [
        { field: "userId", value: userId },
        { field: "organizationId", value: organizationId },
      ],
    });
  }).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((membership) =>
      membership?.role != null && isPrivileged(membership.role) ? "admin" : "member",
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
            // default to the seeded org rather than rejecting with NoOrganization.
            const resolvedOrganizationId = resolved.session.activeOrganizationId ?? organizationId;
            // The workspace role, resolved against the INSTANCE org exactly as
            // the admin gate does (require-admin.ts): the explicit
            // `organizationId` query keeps a caller-controlled active org from
            // answering for an org they own elsewhere. FAIL CLOSED to "member"
            // — an infra fault demotes rather than escalates.
            const orgRole = yield* resolveSelfHostOrgRole(
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
