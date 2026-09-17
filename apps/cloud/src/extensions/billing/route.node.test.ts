import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { MemberDirectory } from "@executor-js/api/server";

import { UserStoreService } from "../../auth/context";
import { WorkOSClient, type WorkOSClientService } from "../../auth/workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "../../auth/workos-mirror";
import { resolveBillingOrganization } from "./route";

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

const MEMBER = "user_session";
const SESSION_ORG = "org_session";
const URL_ORG = "org_url";
const URL_SLUG = "acme";

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => {
      // Membership is read from the mirror, never from WorkOS.
      return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
    },
  }),
);

// MEMBER is active in both orgs, as the mirror reports it.
const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: (accountId, organizationId) =>
    Effect.succeed(
      accountId === MEMBER && (organizationId === SESSION_ORG || organizationId === URL_ORG)
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
  membershipById: () => Effect.die("billing auth does not look up by membership id"),
  membershipsOf: () => Effect.die("billing auth reads one membership, not the list"),
  members: () => Effect.die("billing auth does not list members"),
  membersById: () => Effect.die("billing auth does not batch members"),
  findByEmail: () => Effect.die("billing auth does not resolve emails"),
});

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
          id: slug === URL_SLUG ? URL_ORG : "org_outsider",
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

const run = (headers: Record<string, string>) =>
  resolveBillingOrganization(
    new Request("https://executor.test/api/billing/customer", { headers }),
    { userId: MEMBER },
  ).pipe(Effect.provide(Layer.mergeAll(stubWorkOS, stubUsers, stubDirectory, stubMirror)));

describe("billing route org selector", () => {
  it.effect("fails closed when no selector header is sent", () =>
    Effect.gen(function* () {
      // No fallback to the session org: the cookie's org is browser-global
      // and can name a different org than the tab's URL for a multi-org user.
      const error = yield* Effect.flip(run({}));
      expect(error).toMatchObject({ _tag: "HttpResponseError", status: 401 });
    }),
  );

  it.effect("scopes billing to the URL org selector", () =>
    Effect.gen(function* () {
      const org = yield* run({ "x-executor-organization": URL_SLUG });
      expect(org.id).toBe(URL_ORG);
    }),
  );

  it.effect("rejects a selector for an org the caller is not a member of", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run({ "x-executor-organization": "outsider-slug" }));
      expect(error).toMatchObject({ _tag: "HttpResponseError", status: 403 });
    }),
  );
});
