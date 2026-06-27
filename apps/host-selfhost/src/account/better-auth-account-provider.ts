import { Effect, Layer } from "effect";

import { AccountProvider, type AccountHeaders } from "@executor-js/api/server";
import { AccountError, AccountNoOrganization, AccountUnauthorized } from "@executor-js/api";
import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import { BetterAuth } from "../auth/better-auth";
import { resolveSelfHostAuthorization } from "../auth/identity";

// ---------------------------------------------------------------------------
// Self-host AccountProvider — implements the provider-neutral account surface
// over the Better Auth instance (auth.api.*). The shared AccountHandlers call
// this; cloud provides its own WorkOS-backed implementation of the same shape.
//
// Single-org instance: the id is boot-seeded, while membership and display
// fields are read live for each request.
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
      const { auth, organizationId } = betterAuth;

      // Run a Better Auth api call, mapping any rejection to a neutral
      // AccountError with a stable, user-facing message.
      const call = <A>(message: string, run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: () => new AccountError({ message }) });

      const getSession = (headers: AccountHeaders) =>
        call("Failed to resolve session", () =>
          auth.api.getSession({ headers: toHeaders(headers) }),
        );

      const requireSession = (headers: AccountHeaders) =>
        Effect.gen(function* () {
          const resolved = yield* getSession(headers);
          if (!resolved) return yield* new AccountUnauthorized();
          return resolved;
        });

      const authorize = (
        headers: AccountHeaders,
        resolved: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>,
      ) =>
        call("Failed to authorize organization", () =>
          resolveSelfHostAuthorization(
            betterAuth,
            resolved.user.id,
            headers[EXECUTOR_ORG_SELECTOR_HEADER] ??
              resolved.session.activeOrganizationId ??
              organizationId,
          ),
        );

      const requireOrganization = (headers: AccountHeaders) =>
        Effect.gen(function* () {
          const resolved = yield* requireSession(headers);
          const authorization = yield* authorize(headers, resolved);
          if (!authorization) return yield* new AccountNoOrganization();
          return { resolved, authorization };
        });

      return AccountProvider.of({
        me: (headers) =>
          Effect.gen(function* () {
            const resolved = yield* requireSession(headers);
            const authorization = yield* authorize(headers, resolved);
            return {
              user: {
                id: resolved.user.id,
                email: resolved.user.email,
                name: resolved.user.name ?? null,
                avatarUrl: resolved.user.image ?? null,
              },
              organization: authorization
                ? {
                    id: authorization.organization.id,
                    name: authorization.organization.name,
                    slug: authorization.organization.slug,
                  }
                : null,
            };
          }),

        listApiKeys: (headers) =>
          Effect.gen(function* () {
            yield* requireOrganization(headers);
            const result = yield* call("Failed to list API keys", () =>
              auth.api.listApiKeys({ headers: toHeaders(headers) }),
            );
            return {
              apiKeys: result.apiKeys.map((key) => ({
                id: key.id,
                name: key.name ?? "API key",
                obfuscatedValue: masked(key.start),
                createdAt: iso(key.createdAt),
                updatedAt: iso(key.updatedAt),
                lastUsedAt: isoOrNull(key.lastRequest),
              })),
            };
          }),

        createApiKey: (headers, name) =>
          Effect.gen(function* () {
            yield* requireOrganization(headers);
            const key = yield* call("Failed to create API key", () =>
              auth.api.createApiKey({ body: { name }, headers: toHeaders(headers) }),
            );
            return {
              id: key.id,
              name: key.name ?? name,
              obfuscatedValue: masked(key.start),
              createdAt: iso(key.createdAt),
              updatedAt: iso(key.updatedAt),
              lastUsedAt: isoOrNull(key.lastRequest),
              value: key.key,
            };
          }),

        revokeApiKey: (headers, apiKeyId) =>
          Effect.gen(function* () {
            yield* requireOrganization(headers);
            yield* call("Failed to revoke API key", () =>
              auth.api.deleteApiKey({ body: { keyId: apiKeyId }, headers: toHeaders(headers) }),
            );
            return { success: true };
          }),

        listMembers: (headers) =>
          Effect.gen(function* () {
            const { resolved } = yield* requireOrganization(headers);
            const result = yield* call("Failed to list members", () =>
              auth.api.listMembers({
                query: { organizationId },
                headers: toHeaders(headers),
              }),
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
              isCurrentUser: member.userId === resolved.user.id,
            }));
            return {
              members,
              seats: { used: members.length, granted: members.length, unlimited: true },
            };
          }),

        // Better Auth's organization plugin ships fixed roles; expose the common
        // set so the invite/role UI has options on a single-team instance.
        listRoles: (headers) =>
          Effect.gen(function* () {
            yield* requireOrganization(headers);
            return {
              roles: [
                { slug: "owner", name: "Owner" },
                { slug: "admin", name: "Admin" },
                { slug: "member", name: "Member" },
              ],
            };
          }),

        inviteMember: (headers, body) =>
          Effect.gen(function* () {
            yield* requireOrganization(headers);
            const invite = yield* call("Failed to invite member", () =>
              auth.api.createInvitation({
                // Narrow the free-form slug to the org plugin's role union (no cast).
                body: { email: body.email, role: orgRole(body.roleSlug), organizationId },
                headers: toHeaders(headers),
              }),
            );
            return { id: invite.id, email: invite.email };
          }),

        removeMember: (headers, membershipId) =>
          Effect.gen(function* () {
            yield* requireOrganization(headers);
            yield* call("Failed to remove member", () =>
              auth.api.removeMember({
                body: { memberIdOrEmail: membershipId, organizationId },
                headers: toHeaders(headers),
              }),
            );
            return { success: true };
          }),

        updateMemberRole: (headers, membershipId, roleSlug) =>
          Effect.gen(function* () {
            yield* requireOrganization(headers);
            yield* call("Failed to update member role", () =>
              auth.api.updateMemberRole({
                body: { memberId: membershipId, role: roleSlug, organizationId },
                headers: toHeaders(headers),
              }),
            );
            return { success: true };
          }),

        updateOrgName: (headers, name) =>
          Effect.gen(function* () {
            yield* requireOrganization(headers);
            yield* call("Failed to update organization name", () =>
              auth.api.updateOrganization({
                body: { data: { name }, organizationId },
                headers: toHeaders(headers),
              }),
            );
            return { name };
          }),
      });
    }),
  );
