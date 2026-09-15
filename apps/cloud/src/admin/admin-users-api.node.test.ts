import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AdminUsersForbidden } from "@executor-js/api";
import { MemberDirectory, type DirectoryMember } from "@executor-js/api/server";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { MirrorReadiness, MirrorReadinessState } from "../auth/mirror-readiness";
import { ORG_SELECTOR_HEADER } from "../auth/organization";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "../auth/workos-mirror";
import { authorizeTenant } from "./admin-users-api";

// ---------------------------------------------------------------------------
// The admin plane's SESSION credential: an admin member of the selected org,
// resolved against the membership mirror through the shared `MemberDirectory`.
// The org-key credential is pinned in `auth/org-api-key-auth.node.test.ts`;
// this file pins the session branch of `authorizeTenant`:
//   - an ACTIVE `admin` membership yields the tenant id
//   - an active plain member is refused
//   - a pending admin invite is refused (not an admin until accepted)
//   - no WorkOS call is made past session authentication
// ---------------------------------------------------------------------------

const ORG = "org_tenant";
const createdAt = new Date("2026-01-01T00:00:00.000Z");

const mirrored = (
  accountId: string,
  overrides: Partial<DirectoryMember> = {},
): DirectoryMember => ({
  accountId,
  membershipId: `om_${accountId}`,
  organizationId: ORG,
  email: null,
  name: null,
  avatarUrl: null,
  role: "member",
  status: "active",
  lastActiveAt: null,
  ...overrides,
});

// The mirror as the directory reads it for ORG.
const memberships = new Map<string, DirectoryMember>([
  ["user_admin", mirrored("user_admin", { role: "admin" })],
  ["user_member", mirrored("user_member")],
  ["user_invited_admin", mirrored("user_invited_admin", { role: "admin", status: "pending" })],
]);

// The mirror is READY in these tests (backfill complete, reconciler caught
// up), so membership is read from the stubbed directory, never from WorkOS.
const stubReadiness = Layer.succeed(MirrorReadiness)({
  state: () => Effect.succeed(MirrorReadinessState.Ready()),
});

const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: (accountId, organizationId) =>
    Effect.succeed(organizationId === ORG ? (memberships.get(accountId) ?? null) : null),
  membershipById: () => Effect.die("tenant authorization does not look up by membership id"),
  membershipsOf: () => Effect.die("tenant authorization reads one membership, not the list"),
  members: () => Effect.die("tenant authorization does not list members"),
  membersById: () => Effect.die("tenant authorization does not batch members"),
  findByEmail: () => Effect.die("tenant authorization does not resolve emails"),
});

// No Authorization header in these tests: the api-key path falls through to
// the session path without validating anything.
const stubApiKeys = Layer.succeed(ApiKeyService)({
  validate: () => Effect.die("no bearer credential is presented"),
  listUserKeys: () => Effect.die("tenant authorization does not list keys"),
  createUserKey: () => Effect.die("tenant authorization does not create keys"),
  revokeUserKey: () => Effect.die("tenant authorization does not revoke keys"),
  listOrgKeys: () => Effect.die("tenant authorization does not list keys"),
  createOrgKey: () => Effect.die("tenant authorization does not create keys"),
  revokeOrgKey: () => Effect.die("tenant authorization does not revoke keys"),
});

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

// The selector is an org id, so only `getOrganization` is reached; the org
// row is already mirrored.
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

// Authorization scans an organization the backfill never covered before it
// reads the mirror (`auth/organization.ts`); every org row above is marked
// backfilled, so the scan is never reached and the mirror is never written.
const stubMirror = Layer.succeed(
  WorkOsMirror,
  new Proxy({} as WorkOsMirrorShape, {
    get: (_target, prop) => () => Effect.die(`unexpected WorkOsMirror.${String(prop)} call`),
  }),
);

// Only session authentication is served; membership is read from the mirror,
// so any other WorkOS call fails the test.
const stubWorkOS = (userId: string) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (prop === "authenticateRequest") {
          return () =>
            Effect.succeed({ userId, email: `${userId}@placeholder.test`, organizationId: null });
        }
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );

const authorizeAs = (userId: string) =>
  authorizeTenant(
    new Request("https://admin.invalid", {
      headers: { cookie: "wos-session=sealed", [ORG_SELECTOR_HEADER]: ORG },
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        stubDirectory,
        stubApiKeys,
        stubUsers,
        stubWorkOS(userId),
        stubMirror,
        stubReadiness,
      ),
    ),
  );

describe("authorizeTenant · admin session", () => {
  it.effect("an active admin resolves the selected org as the tenant", () =>
    Effect.gen(function* () {
      const tenant = yield* authorizeAs("user_admin");
      expect(tenant).toBe(ORG);
    }),
  );

  it.effect("an active plain member is forbidden", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(authorizeAs("user_member"));
      expect(error, "this plane serves the whole tenant; a member is not enough").toBeInstanceOf(
        AdminUsersForbidden,
      );
    }),
  );

  it.effect("a pending admin invite is forbidden", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(authorizeAs("user_invited_admin"));
      expect(error, "an admin role that is still pending is not an admin").toBeInstanceOf(
        AdminUsersForbidden,
      );
    }),
  );
});
