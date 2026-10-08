import { Effect, Layer } from "effect";

import { AccountProvider, type AccountHeaders } from "@executor-js/api/server";
import { AccountError, AccountNoOrganization, AccountUnauthorized } from "@executor-js/api";

import { BetterAuth } from "../auth/better-auth";
import { findInstanceMembership } from "../auth/membership";

// ---------------------------------------------------------------------------
// Self-host AccountProvider — implements the provider-neutral account surface
// over the Better Auth instance (auth.api.*). The shared AccountHandlers call
// this; cloud provides its own WorkOS-backed implementation of the same shape.
//
// Single-org instance: organization id/name come from the boot-seeded org.
// auth.api.* throws on failure; we map those to the neutral AccountError so the
// UI sees one shape. API keys returned by `list` only expose a masked value;
// the plaintext is returned once, by `create`.
// ---------------------------------------------------------------------------

const toHeaders = (headers: AccountHeaders): Headers => new Headers(headers);

const isoOrNull = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
};

const iso = (value: Date | string | null | undefined): string => isoOrNull(value) ?? "";

// Better Auth exposes only `start` (leading chars) for display once a key is
// stored; render it as a masked token.
const masked = (start: string | null | undefined): string => (start ? `${start}…` : "••••••••");

// Narrow a free-form role slug to the Better Auth organization role union
// (defaults to member). Returning literals — not a cast — keeps the types sound.
const orgRole = (slug: string | undefined): "owner" | "admin" | "member" =>
  slug === "owner" ? "owner" : slug === "admin" ? "admin" : "member";

export const betterAuthAccountProvider: Layer.Layer<AccountProvider, never, BetterAuth> =
  Layer.effect(AccountProvider)(
    Effect.gen(function* () {
      const betterAuth = yield* BetterAuth;
      const { auth, organizationId, organizationName, organizationSlug } = betterAuth;

      const getSession = (headers: AccountHeaders) =>
        Effect.tryPromise({
          try: () => auth.api.getSession({ headers: toHeaders(headers) }),
          catch: () => new AccountError({ message: "Failed to resolve session" }),
        }).pipe(Effect.orElseSucceed(() => null));

      // The account plane acts as the calling user with their own headers, so
      // Better Auth answers for any user with a live session — including one
      // whose membership was removed. Every self-serve route first requires a
      // CURRENT member row in the instance org (../auth/membership.ts): no
      // session is 401, a session without membership is 403. The member
      // management routes below are gated by the organization plugin itself,
      // which refuses callers who are not members of the org.
      const requireMember = (headers: AccountHeaders) =>
        Effect.gen(function* () {
          const resolved = yield* getSession(headers);
          if (!resolved) return yield* new AccountUnauthorized();
          const membership = yield* findInstanceMembership(
            betterAuth,
            resolved.user.id,
            resolved.session.activeOrganizationId ?? organizationId,
          );
          if (!membership) return yield* new AccountNoOrganization();
          return resolved;
        });

      // Run a Better Auth api call, mapping any rejection to a neutral
      // AccountError with a stable, user-facing message.
      const call = <A>(message: string, run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: () => new AccountError({ message }) });

      return AccountProvider.of({
        me: (headers) =>
          Effect.gen(function* () {
            // `me` declares no NoOrganization in its contract: a removed
            // member is simply no longer signed in to this instance (401).
            const resolved = yield* requireMember(headers).pipe(
              Effect.catchTag("AccountNoOrganization", () =>
                Effect.fail(new AccountUnauthorized()),
              ),
            );
            return {
              user: {
                id: resolved.user.id,
                email: resolved.user.email,
                name: resolved.user.name ?? null,
                avatarUrl: resolved.user.image ?? null,
              },
              organization: {
                id: resolved.session.activeOrganizationId ?? organizationId,
                name: organizationName,
                slug: organizationSlug,
              },
            };
          }),

        listApiKeys: (headers) =>
          requireMember(headers).pipe(
            Effect.andThen(
              call("Failed to list API keys", () =>
                auth.api.listApiKeys({ headers: toHeaders(headers) }),
              ),
            ),
            Effect.map((result) => ({
              apiKeys: result.apiKeys.map((key) => ({
                id: key.id,
                name: key.name ?? "API key",
                obfuscatedValue: masked(key.start),
                createdAt: iso(key.createdAt),
                updatedAt: iso(key.updatedAt),
                lastUsedAt: isoOrNull(key.lastRequest),
              })),
            })),
          ),

        createApiKey: (headers, name) =>
          requireMember(headers).pipe(
            Effect.andThen(
              call("Failed to create API key", () =>
                auth.api.createApiKey({ body: { name }, headers: toHeaders(headers) }),
              ),
            ),
            Effect.map((key) => ({
              id: key.id,
              name: key.name ?? name,
              obfuscatedValue: masked(key.start),
              createdAt: iso(key.createdAt),
              updatedAt: iso(key.updatedAt),
              lastUsedAt: isoOrNull(key.lastRequest),
              value: key.key,
            })),
          ),

        revokeApiKey: (headers, apiKeyId) =>
          requireMember(headers).pipe(
            Effect.andThen(
              call("Failed to revoke API key", () =>
                auth.api.deleteApiKey({ body: { keyId: apiKeyId }, headers: toHeaders(headers) }),
              ),
            ),
            Effect.as({ success: true }),
          ),

        // Better Auth has no organization-OWNED key concept: every key it
        // issues belongs to the user who created it. Rather than inventing one
        // (a shared key filed under whichever admin happened to click the
        // button is not an org key — it dies with that member), self-host
        // reports no org keys and refuses to mint. Self-host's own `/admin/*`
        // plane is gated on an owner/admin SESSION instead, which is the
        // credential a single-instance operator already has.
        listOrgApiKeys: () => Effect.succeed({ apiKeys: [] }),

        createOrgApiKey: () =>
          Effect.fail(
            new AccountError({
              message: "Organization API keys are not available on self-hosted instances",
            }),
          ),

        // Nothing to revoke: `listOrgApiKeys` is empty and `createOrgApiKey`
        // refuses, so any id reaching here names a key this instance never
        // issued. Refusing (rather than succeeding vacuously) keeps the console
        // from reporting a revoke that did not happen.
        revokeOrgApiKey: () =>
          Effect.fail(
            new AccountError({
              message: "Organization API keys are not available on self-hosted instances",
            }),
          ),

        listMembers: (headers) =>
          Effect.gen(function* () {
            const resolved = yield* getSession(headers);
            const currentUserId = resolved?.user.id;
            const result = yield* call("Failed to list members", () =>
              auth.api.listMembers({ headers: toHeaders(headers) }),
            ).pipe(
              Effect.catchTag("AccountError", () => Effect.succeed({ members: [], total: 0 })),
            );
            const members = result.members.map((member) => ({
              id: member.id,
              userId: member.userId,
              email: member.user?.email ?? null,
              name: member.user?.name ?? null,
              avatarUrl: member.user?.image ?? null,
              role: member.role,
              status: "active",
              lastActiveAt: null,
              isCurrentUser: member.userId === currentUserId,
            }));
            return {
              members,
              seats: { used: members.length, granted: members.length, unlimited: true },
            };
          }),

        // Better Auth's organization plugin ships fixed roles; expose the common
        // set so the invite/role UI has options on a single-team instance.
        listRoles: () =>
          Effect.succeed({
            roles: [
              { slug: "owner", name: "Owner" },
              { slug: "admin", name: "Admin" },
              { slug: "member", name: "Member" },
            ],
          }),

        inviteMember: (headers, body) =>
          call("Failed to invite member", () =>
            auth.api.createInvitation({
              // Narrow the free-form slug to the org plugin's role union (no cast).
              body: { email: body.email, role: orgRole(body.roleSlug) },
              headers: toHeaders(headers),
            }),
          ).pipe(Effect.map((invite) => ({ id: invite.id, email: invite.email }))),

        removeMember: (headers, membershipId) =>
          call("Failed to remove member", () =>
            auth.api.removeMember({
              body: { memberIdOrEmail: membershipId },
              headers: toHeaders(headers),
            }),
          ).pipe(Effect.as({ success: true })),

        updateMemberRole: (headers, membershipId, roleSlug) =>
          call("Failed to update member role", () =>
            auth.api.updateMemberRole({
              body: { memberId: membershipId, role: roleSlug },
              headers: toHeaders(headers),
            }),
          ).pipe(Effect.as({ success: true })),

        updateOrgName: (headers, name) =>
          call("Failed to update organization name", () =>
            auth.api.updateOrganization({
              body: { data: { name }, organizationId },
              headers: toHeaders(headers),
            }),
          ).pipe(Effect.as({ name })),
      });
    }),
  );
