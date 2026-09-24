import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { MemberDirectory } from "@executor-js/api/server";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "../auth/workos-mirror";
import { resolveProtectedPrincipal } from "./protected";

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
  validate: (value: string) =>
    Effect.succeed(
      value === "valid_user_key"
        ? {
            scope: "user" as const,
            accountId: "user_123",
            organizationId: "org_123",
            keyId: "api_key_123",
          }
        : null,
    ),
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.die("protected API auth test does not create API keys"),
  revokeUserKey: () => Effect.void,
  listOrgKeys: () => Effect.die("auth resolution test does not list org API keys"),
  createOrgKey: () => Effect.die("auth resolution test does not create org API keys"),
  revokeOrgKey: () => Effect.die("auth resolution test does not revoke org API keys"),
});

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => {
      return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
    },
  }),
);

// The mirror as the directory reads it: user_123 holds an active membership in
// org_123 and nothing else. Membership is always read from the mirror, never
// from WorkOS.
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

const run = (request: Request) =>
  resolveProtectedPrincipal(request).pipe(
    Effect.provide(Layer.mergeAll(stubApiKeys, stubWorkOS, stubUsers, stubDirectory, stubMirror)),
  );

describe("protected API key auth", () => {
  it.effect("resolves a valid bearer API key into protected identity", () =>
    Effect.gen(function* () {
      const identity = yield* run(
        new Request("https://executor.test/api/tools", {
          headers: { authorization: "Bearer valid_user_key" },
        }),
      );

      expect(identity).toEqual({
        kind: "member",
        accountId: "user_123",
        organizationId: "org_123",
        organizationName: "Org org_123",
        organizationSlug: "org-slug-org_123",
        email: "",
        name: null,
        avatarUrl: null,
        roles: [],
        // The stub membership carries no role slug — normalization FAILS
        // CLOSED to plain member, so the executor binds workspace writes off.
        orgRoleModel: "organization",
        orgRole: "member",
      });
    }),
  );

  it.effect("rejects invalid bearer API keys", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run(
          new Request("https://executor.test/api/tools", {
            headers: { authorization: "Bearer invalid_user_key" },
          }),
        ),
      );

      // The resolver now raises the SHARED `Unauthorized` carrying the same
      // machine code; cloud's failure strategy renders it as the byte-identical
      // 401 `{ error: "Invalid API key", code: "invalid_api_key" }`.
      expect(error).toMatchObject({
        _tag: "Unauthorized",
        code: "invalid_api_key",
        message: "Invalid API key",
      });
    }),
  );
});
