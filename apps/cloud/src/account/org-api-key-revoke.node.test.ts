import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AccountProvider, MemberDirectory } from "@executor-js/api/server";
import { AccountError, AccountForbidden } from "@executor-js/api";

import { ApiKeyService, OrgApiKeyNotFound } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { ORG_SELECTOR_HEADER } from "../auth/organization";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { WorkOsMirror } from "../auth/workos-mirror";
import { AutumnService } from "../extensions/billing/service";
import { AccountCaller, workosAccountProvider } from "./workos-account-service";

// ---------------------------------------------------------------------------
// `DELETE /account/org-api-keys/:apiKeyId` at the PROVIDER boundary.
//
// An org key reads every user and connection in the tenant through `/admin/*`,
// so it is the most privileged credential the product issues. Two properties
// have to hold together, and only this seam sees both:
//
//   1. Revoke is gated on org ADMIN membership — the same gate as the mint. A
//      plain member calling it gets 403 and no delete goes out.
//   2. Revoke resolves ownership against the ORG's keys. `revokeApiKey` (the
//      personal path) checks the caller's OWN key list, so it can never revoke
//      an org key; conversely this path must never destroy a member's personal
//      key. The scope-blind `deleteApiKey` would do exactly that if handed a
//      user key id, so a wrong id has to fail cleanly instead.
//
// Ownership filtering itself is pinned per-shape in
// `auth/org-api-key-mint.node.test.ts`; here it is asserted end-to-end through
// the gate, on the provider the HTTP handler actually calls.
// ---------------------------------------------------------------------------

const ORG = "org_123";
const ADMIN = "user_admin";
const MEMBER = "user_member";
const ORG_KEY = "key_org_1";
const USER_KEY = "key_user_1";
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
const orgHeaders = { [ORG_SELECTOR_HEADER]: ORG };

const session = (accountId: string) => ({
  accountId,
  email: `${accountId}@example.test`,
  name: null,
  avatarUrl: null,
  organizationId: ORG,
  sealedSession: "sealed",
  refreshedSession: null,
});

// Membership is read from the mirror, never from WorkOS: revoke makes no
// WorkOS call at all.
const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`),
  }),
);

const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: async (id: string) => bareAccount(id),
        getAccount: async (id: string) => bareAccount(id),
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: org.id,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        getOrganization: async (id: string) => ({
          id,
          name: `Org ${id}`,
          slug: id,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        getOrganizationBySlug: async (slug: string) => ({
          id: slug,
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

// Revoke changes no membership, so the mirror is never written.
const stubMirror = Layer.succeed(WorkOsMirror)({
  upsertUser: () => Effect.die("revoke does not write the membership mirror"),
  upsertMembership: () => Effect.die("revoke does not write the membership mirror"),
  deleteMembership: () => Effect.die("revoke does not write the membership mirror"),
  deleteUser: () => Effect.die("revoke does not write the membership mirror"),
  getCursor: () => Effect.die("revoke does not read the events cursor"),
  applyPage: () => Effect.die("revoke does not move the events cursor"),
  applyOrganizationScan: () => Effect.die("revoke does not run the backfill"),
  replayBoundary: () => Effect.die("revoke does not run the reconciler"),
  setReplayBoundary: () => Effect.die("revoke does not run the backfill"),
  backfillCompletedAt: () => Effect.die("revoke does not check mirror readiness"),
  markBackfillCompleted: () => Effect.die("revoke does not run the backfill"),
  drainedAt: () => Effect.die("revoke does not check mirror readiness"),
  markDrained: () => Effect.die("revoke does not run the reconciler"),
  organizationBackfilledAt: () => Effect.die("revoke does not report seats"),
});

// The mirror as the directory reads it: both are active members of ORG, and
// only ADMIN carries the `admin` role. Revoke reads the caller's membership
// (the org check and the admin gate) and nothing else.
const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: (accountId, organizationId) =>
    Effect.succeed(
      organizationId === ORG
        ? {
            accountId,
            membershipId: `om_${accountId}`,
            organizationId,
            email: null,
            name: null,
            avatarUrl: null,
            role: accountId === ADMIN ? "admin" : "member",
            status: "active" as const,
            lastActiveAt: null,
          }
        : null,
    ),
  membershipById: () => Effect.die("revoke does not look up by membership id"),
  membershipsOf: () => Effect.die("revoke does not list the caller's memberships"),
  members: () => Effect.die("revoke does not list members"),
  membersById: () => Effect.die("revoke does not batch members"),
  findByEmail: () => Effect.die("revoke does not resolve emails"),
});

const stubAutumn = Layer.succeed(AutumnService)({
  use: () => Effect.die("revoke does not touch billing"),
  ensureCustomer: () => Effect.die("revoke does not touch billing"),
  checkExecutionBalance: () => Effect.die("revoke does not touch billing"),
  trackExecution: () => Effect.void,
  setMemberSeats: () => Effect.void,
});

/**
 * The provider under test, over an `ApiKeyService` whose org listing holds a
 * single org-owned key. Revoked ids land in `revoked` so "no delete happened"
 * is assertable, not merely inferred from the error.
 */
const providerWith = (accountId: string) => {
  const revoked: string[] = [];
  const stubApiKeys = Layer.succeed(ApiKeyService)({
    validate: () => Effect.die("revoke test does not validate keys"),
    listUserKeys: () => Effect.succeed([]),
    createUserKey: () => Effect.die("revoke test does not create user keys"),
    revokeUserKey: () => Effect.die("the ORG path must not call the personal revoke"),
    listOrgKeys: () => Effect.die("revoke test does not list org keys"),
    createOrgKey: () => Effect.die("revoke test does not create org keys"),
    revokeOrgKey: ({ keyId }) =>
      keyId === ORG_KEY
        ? Effect.sync(() => {
            revoked.push(keyId);
          })
        : Effect.fail(new OrgApiKeyNotFound({ keyId })),
  });

  const provider = AccountProvider.asEffect().pipe(
    Effect.provide(
      workosAccountProvider.pipe(
        Layer.provide(
          Layer.mergeAll(
            stubWorkOS,
            stubUsers,
            stubMirror,
            stubDirectory,
            stubApiKeys,
            stubAutumn,
            Layer.succeed(AccountCaller)({ session: session(accountId) }),
          ),
        ),
      ),
    ),
  );

  return { provider, revoked };
};

describe("revokeOrgApiKey · provider boundary", () => {
  it.effect("an org admin revokes an org-owned key", () =>
    Effect.gen(function* () {
      const { provider, revoked } = providerWith(ADMIN);
      const account = yield* provider;

      const result = yield* account.revokeOrgApiKey(orgHeaders, ORG_KEY);

      expect(result).toEqual({ success: true });
      expect(revoked, "the revoke reached the key service").toEqual([ORG_KEY]);
    }),
  );

  it.effect("a plain member is forbidden, and nothing is revoked", () =>
    Effect.gen(function* () {
      const { provider, revoked } = providerWith(MEMBER);
      const account = yield* provider;

      const error = yield* Effect.flip(account.revokeOrgApiKey(orgHeaders, ORG_KEY));

      expect(error, "same admin gate as the mint").toBeInstanceOf(AccountForbidden);
      expect(revoked, "the gate runs BEFORE the key service is touched").toEqual([]);
    }),
  );

  it.effect("a user-scoped key id fails cleanly through this path", () =>
    Effect.gen(function* () {
      // Not found — not a 500, and emphatically not a silent success that would
      // report a member's live personal credential as destroyed.
      const { provider, revoked } = providerWith(ADMIN);
      const account = yield* provider;

      const error = yield* Effect.flip(account.revokeOrgApiKey(orgHeaders, USER_KEY));

      expect(error).toBeInstanceOf(AccountError);
      expect(revoked).toEqual([]);
    }),
  );
});
