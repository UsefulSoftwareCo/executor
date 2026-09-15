import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";

import { MemberDirectory, NoOrganization } from "@executor-js/api/server";

import { ApiKeyService } from "./api-keys";
import { UserStoreService } from "./context";
import { MirrorReadiness, MirrorReadinessState } from "./mirror-readiness";
import { WorkOSClient, type WorkOSClientService } from "./workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "./workos-mirror";
import { isPlatformAuth, resolveApiKeyPrincipal, resolveBearerAuth } from "./workos-auth-provider";

// Groundwork for the PRIVILEGED, org-level API key: it resolves to the platform
// view (tenant-wide, read-only, NO acting member) rather than to a member
// `Principal`. The product surfaces must reject it outright rather than
// inventing a subject for it — that is the property these tests pin.

const createdAt = new Date("2026-01-01T00:00:00.000Z");

// The mirror's account row as `ensureAccount` mints it: id only, profile
// columns unfilled until a WorkOS user payload arrives.
const bareAccount = (id: string) => ({
  id,
  email: null,
  firstName: null,
  lastName: null,
  avatarUrl: null,
  workosUpdatedAt: null,
  lastSignInAt: null,
  createdAt,
});

const stubApiKeys = Layer.succeed(ApiKeyService)({
  validate: (value: string) => {
    if (value === "valid_org_key") {
      return Effect.succeed({
        scope: "org" as const,
        accountId: null,
        organizationId: "org_123",
        keyId: "api_key_org",
      });
    }
    if (value === "valid_user_key") {
      return Effect.succeed({
        scope: "user" as const,
        accountId: "user_123",
        organizationId: "org_123",
        keyId: "api_key_123",
      });
    }
    return Effect.succeed(null);
  },
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.die("org api key test does not create API keys"),
  revokeUserKey: () => Effect.void,
  listOrgKeys: () => Effect.die("auth resolution test does not list org API keys"),
  createOrgKey: () => Effect.die("auth resolution test does not create org API keys"),
  revokeOrgKey: () => Effect.die("auth resolution test does not revoke org API keys"),
});

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => {
      // Membership is read from the mirror, never from WorkOS; any WorkOS call
      // dies here.
      return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
    },
  }),
);

// The mirror as the directory reads it: user_123 holds an active membership in
// org_123 and nothing else. Membership is never read from WorkOS.
// The mirror is READY in these tests (backfill complete, reconciler caught
// up), so membership is read from the stubbed directory, never from WorkOS.
const stubReadiness = Layer.succeed(MirrorReadiness)({
  state: () => Effect.succeed(MirrorReadinessState.Ready()),
});

const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: (accountId, organizationId) =>
    Effect.succeed(
      accountId === "user_123" && organizationId === "org_123"
        ? {
            accountId,
            membershipId: `om_${accountId}_${organizationId}`,
            organizationId,
            email: null,
            name: null,
            avatarUrl: null,
            role: "member",
            status: "active" as const,
            lastActiveAt: null,
          }
        : null,
    ),
  membershipById: () => Effect.die("bearer resolution does not look up by membership id"),
  membershipsOf: () => Effect.die("bearer resolution reads one membership, not the list"),
  members: () => Effect.die("bearer resolution does not list members"),
  membersById: () => Effect.die("bearer resolution does not batch members"),
  findByEmail: () => Effect.die("bearer resolution does not resolve emails"),
});

const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: async (id: string) => bareAccount(id),
        getAccount: async (id: string) => bareAccount(id),
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: `org-slug-${org.id}`,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        getOrganization: async (id: string) => ({
          id,
          name: `Org ${id}`,
          slug: `org-slug-${id}`,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        getOrganizationBySlug: async (slug: string) => ({
          id: "org_by_slug",
          name: `Org ${slug}`,
          slug,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        markOrganizationDeleted: async () => null,
        deleteOrganizationCascade: async () => {},
      }),
    ),
});

// Authorization scans an organization the backfill never covered before it
// reads the mirror (`auth/organization.ts`); every org row above is marked
// backfilled, so the scan is never reached and the mirror is never written.
const stubMirror = Layer.succeed(
  WorkOsMirror,
  new Proxy({} as WorkOsMirrorShape, {
    get: (_target, prop) => () => Effect.die(`unexpected WorkOsMirror.${String(prop)} call`),
  }),
);

const layers = Layer.mergeAll(
  stubApiKeys,
  stubWorkOS,
  stubUsers,
  stubDirectory,
  stubMirror,
  stubReadiness,
);

const bearer = (token: string) =>
  new Request("https://executor.test/api/tools", {
    headers: { authorization: `Bearer ${token}` },
  });

describe("org-level API keys", () => {
  it.effect("resolve to the platform view with no acting member", () =>
    Effect.gen(function* () {
      const auth = yield* resolveBearerAuth(bearer("valid_org_key")).pipe(Effect.provide(layers));

      expect(isPlatformAuth(auth)).toBe(true);
      expect(auth).toEqual({
        kind: "platform",
        organizationId: "org_123",
        organizationName: "Org org_123",
        organizationSlug: "org-slug-org_123",
        keyId: "api_key_org",
      });
      // No `accountId` anywhere in the shape: nothing downstream can bind a
      // subject from it by accident.
      expect(auth).not.toHaveProperty("accountId");
    }),
  );

  it.effect("are refused once the org is marked deleted", () =>
    Effect.gen(function* () {
      const deletedOrgUsers = Layer.succeed(UserStoreService)({
        use: (_op, fn) =>
          Effect.promise(() =>
            fn({
              ensureAccount: async (id: string) => bareAccount(id),
              getAccount: async (id: string) => bareAccount(id),
              upsertOrganization: async (org: { id: string; name: string }) => ({
                ...org,
                slug: `org-slug-${org.id}`,
                backfilledAt: createdAt,
                deletedAt: createdAt,
                workosUpdatedAt: null,
                createdAt,
              }),
              getOrganization: async (id: string) => ({
                id,
                name: `Org ${id}`,
                slug: `org-slug-${id}`,
                backfilledAt: createdAt,
                deletedAt: createdAt,
                workosUpdatedAt: null,
                createdAt,
              }),
              getOrganizationBySlug: async (slug: string) => ({
                id: "org_by_slug",
                name: `Org ${slug}`,
                slug,
                backfilledAt: createdAt,
                deletedAt: createdAt,
                workosUpdatedAt: null,
                createdAt,
              }),
              markOrganizationDeleted: async () => null,
              deleteOrganizationCascade: async () => {},
            }),
          ),
      });
      const exit = yield* Effect.exit(
        resolveBearerAuth(bearer("valid_org_key")).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubApiKeys,
              stubWorkOS,
              deletedOrgUsers,
              stubDirectory,
              stubMirror,
              stubReadiness,
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : null,
        "the key outlives the org until the purge; a marked org refuses it",
      ).toBeInstanceOf(NoOrganization);
    }),
  );

  it.effect("user keys still resolve to a bound member principal", () =>
    Effect.gen(function* () {
      const auth = yield* resolveBearerAuth(bearer("valid_user_key")).pipe(Effect.provide(layers));

      expect(isPlatformAuth(auth)).toBe(false);
      expect(auth).toMatchObject({
        accountId: "user_123",
        organizationId: "org_123",
      });
    }),
  );

  it.effect("resolve on the product surface as a platform principal, never a subject", () =>
    Effect.gen(function* () {
      // THE security property of the api-key half, updated for platform reads:
      // a product request carrying an org key resolves to the NEUTRAL platform
      // shape — which the shared middleware routes to the subject-less,
      // GET-only platform executor — and must never carry an accountId a
      // handler could bind as an acting member.
      const principal = yield* resolveApiKeyPrincipal(bearer("valid_org_key")).pipe(
        Effect.provide(layers),
      );

      expect(principal).toEqual({
        kind: "platform",
        organizationId: "org_123",
        organizationName: "Org org_123",
        organizationSlug: "org-slug-org_123",
        keyId: "api_key_org",
      });
      expect(principal).not.toHaveProperty("accountId");
    }),
  );

  it.effect("do not trigger a user membership check", () =>
    Effect.gen(function* () {
      // `authorizeOrganization` checks a USER's membership; there is no user
      // here. A directory whose `membership` dies proves the org branch never
      // asked.
      const noMembershipReads = Layer.succeed(MemberDirectory)({
        membership: () => Effect.die("an org key must not trigger a membership check"),
        membershipById: () => Effect.die("an org key must not trigger a membership check"),
        membershipsOf: () => Effect.die("an org key must not trigger a membership check"),
        members: () => Effect.die("an org key must not trigger a membership check"),
        membersById: () => Effect.die("an org key must not trigger a membership check"),
        findByEmail: () => Effect.die("an org key must not trigger a membership check"),
      });
      const auth = yield* resolveBearerAuth(bearer("valid_org_key")).pipe(
        Effect.provide(
          Layer.mergeAll(
            stubApiKeys,
            stubWorkOS,
            stubUsers,
            noMembershipReads,
            stubMirror,
            stubReadiness,
          ),
        ),
      );

      expect(isPlatformAuth(auth)).toBe(true);
    }),
  );
});
