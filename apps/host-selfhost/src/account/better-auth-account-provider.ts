import { Effect, Layer } from "effect";

import { AccountProvider, type AccountHeaders } from "@executor-js/api/server";
import { AccountError, AccountUnauthorized } from "@executor-js/api";

import { BetterAuth } from "../auth/better-auth";

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
      const { auth, organizationId, organizationName, organizationSlug } = yield* BetterAuth;

      const getSession = (headers: AccountHeaders) =>
        Effect.tryPromise({
          try: () => auth.api.getSession({ headers: toHeaders(headers) }),
          catch: () => new AccountError({ message: "Failed to resolve session" }),
        }).pipe(Effect.orElseSucceed(() => null));

      // Run a Better Auth api call, mapping any rejection to a neutral
      // AccountError with a stable, user-facing message.
      const call = <A>(message: string, run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: () => new AccountError({ message }) });

      return AccountProvider.of({
        me: (headers) =>
          Effect.gen(function* () {
            const resolved = yield* getSession(headers);
            if (!resolved) return yield* new AccountUnauthorized();
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
          call("Failed to list API keys", () =>
            auth.api.listApiKeys({ headers: toHeaders(headers) }),
          ).pipe(
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
          call("Failed to create API key", () =>
            auth.api.createApiKey({ body: { name }, headers: toHeaders(headers) }),
          ).pipe(
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
          call("Failed to revoke API key", () =>
            auth.api.deleteApiKey({ body: { keyId: apiKeyId }, headers: toHeaders(headers) }),
          ).pipe(Effect.as({ success: true })),

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
              email: member.user?.email ?? "",
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
