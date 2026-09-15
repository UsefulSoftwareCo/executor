import { describe, it, expect } from "@effect/vitest";
import { Data, Effect, Layer } from "effect";

import {
  AuthContext,
  MemberDirectory,
  MemberDirectoryError,
  type DirectoryMember,
} from "@executor-js/api/server";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { Forbidden } from "./api";
import { assertDomainInSessionOrg, requireAdmin } from "./handlers";

// ---------------------------------------------------------------------------
// Domain-handler guards. The member / role / invite / org-name endpoints moved
// to the shared WorkOS `AccountProvider` (covered by
// `workos-account-service.test.ts`); this group now serves only the WorkOS
// domain-verification endpoints. These tests pin the two guards those handlers
// share — the REAL `requireAdmin` and `assertDomainInSessionOrg` exported from
// `org/handlers.ts`, so a change to the gate cannot pass on a stale copy.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub needs wide function types
type StubFn = (...args: never[]) => Effect.Effect<any, any>;

type StubOverrides = {
  getOrganizationDomain?: StubFn;
  getOrganization?: StubFn;
  deleteOrganizationDomain?: StubFn;
};

class UnstubbedWorkOSMethod extends Data.TaggedError("UnstubbedWorkOSMethod")<{
  method: string;
}> {}

const stubWorkOS = (overrides: StubOverrides = {}) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (typeof prop === "string" && prop in overrides) {
          return overrides[prop as keyof StubOverrides];
        }
        return () =>
          Effect.fail(
            new UnstubbedWorkOSMethod({
              method: typeof prop === "string" ? prop : (prop.description ?? "symbol"),
            }),
          );
      },
    }),
  );

const adminAuth = {
  accountId: "user_admin",
  organizationId: "org_1",
  email: "admin@test.com",
  name: "Admin",
  avatarUrl: null,
  roles: [],
};

const memberAuth = {
  accountId: "user_member",
  organizationId: "org_1",
  email: "member@test.com",
  name: "Member",
  avatarUrl: null,
  roles: [],
};

// The mirror as the directory reads it for org_1: user_admin is an active
// admin, user_member an active member, and user_invited_admin holds an admin
// role that is still pending.
const mirroredMembership = (
  accountId: string,
  overrides: Partial<DirectoryMember> = {},
): DirectoryMember => ({
  accountId,
  membershipId: `mem_${accountId}`,
  organizationId: "org_1",
  email: null,
  name: null,
  avatarUrl: null,
  role: "member",
  status: "active",
  lastActiveAt: null,
  ...overrides,
});
const memberships = new Map<string, DirectoryMember>([
  ["user_admin", mirroredMembership("user_admin", { role: "admin" })],
  ["user_member", mirroredMembership("user_member")],
  [
    "user_invited_admin",
    mirroredMembership("user_invited_admin", {
      role: "admin",
      status: "pending",
    }),
  ],
]);
const unreadDirectory = (why: string) => () => Effect.die(why);
const stubDirectory = (
  membership: (
    accountId: string,
    organizationId: string,
  ) => Effect.Effect<DirectoryMember | null, MemberDirectoryError> = (accountId, organizationId) =>
    Effect.succeed(organizationId === "org_1" ? (memberships.get(accountId) ?? null) : null),
) =>
  Layer.succeed(MemberDirectory)({
    membership,
    membershipById: unreadDirectory("the domain handlers do not look up by membership id"),
    membershipsOf: unreadDirectory("the domain handlers read one membership, not the list"),
    members: unreadDirectory("the domain handlers do not list members"),
    membersById: unreadDirectory("the domain handlers do not batch members"),
    findByEmail: unreadDirectory("the domain handlers do not resolve emails"),
  });

const provide = (
  auth: typeof adminAuth,
  workosOverrides: StubOverrides = {},
  directory: Layer.Layer<MemberDirectory> = stubDirectory(),
) => Layer.mergeAll(Layer.succeed(AuthContext)(auth), stubWorkOS(workosOverrides), directory);

const invitedAdminAuth = {
  ...memberAuth,
  accountId: "user_invited_admin",
  email: "invited@test.com",
  name: "Invited",
};

describe("Org domain handlers", () => {
  describe("requireAdmin", () => {
    it.effect("passes for an admin caller", () =>
      requireAdmin.pipe(Effect.provide(provide(adminAuth))),
    );

    it.effect("rejects a non-admin caller with Forbidden", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(requireAdmin);
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(Effect.provide(provide(memberAuth))),
    );

    it.effect("rejects a pending admin invite with Forbidden", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(requireAdmin);
        expect(error, "an admin role that is still pending is not an admin").toBeInstanceOf(
          Forbidden,
        );
      }).pipe(Effect.provide(provide(invitedAdminAuth))),
    );

    it.effect("surfaces a directory read failure as MemberDirectoryError, not Forbidden", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(requireAdmin);
        expect(
          error,
          "a storage fault is a 500 for an actual admin, never a refusal",
        ).toBeInstanceOf(MemberDirectoryError);
      }).pipe(
        Effect.provide(
          provide(
            adminAuth,
            {},
            stubDirectory(() =>
              Effect.fail(new MemberDirectoryError({ message: "directory unavailable" })),
            ),
          ),
        ),
      ),
    );
  });

  describe("assertDomainInSessionOrg", () => {
    it.effect("passes when the domain belongs to the session org", () =>
      assertDomainInSessionOrg("dom_1").pipe(
        Effect.provide(
          provide(adminAuth, {
            getOrganizationDomain: () =>
              Effect.succeed({ id: "dom_1", organizationId: "org_1", domain: "acme.test" }),
          }),
        ),
      ),
    );

    it.effect("rejects a domain owned by a different org with Forbidden", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(assertDomainInSessionOrg("dom_other"));
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(
        Effect.provide(
          provide(adminAuth, {
            getOrganizationDomain: () =>
              Effect.succeed({ id: "dom_other", organizationId: "org_2", domain: "evil.test" }),
          }),
        ),
      ),
    );

    it.effect("rejects (Forbidden) when the domain lookup fails — never leaks existence", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(assertDomainInSessionOrg("dom_missing"));
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(
        Effect.provide(
          provide(adminAuth, {
            getOrganizationDomain: () => Effect.fail(new UnstubbedWorkOSMethod({ method: "boom" })),
          }),
        ),
      ),
    );
  });
});
