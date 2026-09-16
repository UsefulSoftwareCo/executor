import { describe, expect, it } from "@effect/vitest";
import type { Autumn } from "autumn-js";
import { Effect, Layer } from "effect";

import { AccountProvider } from "@executor-js/api/server";
import { AccountError } from "@executor-js/api";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { WorkOSError } from "../auth/errors";
import { ORG_SELECTOR_HEADER } from "../auth/organization";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { AutumnError, AutumnService } from "../extensions/billing/service";
import { AccountCaller, workosAccountProvider } from "./workos-account-service";

// ---------------------------------------------------------------------------
// `GET /api/account/members` at the PROVIDER boundary.
//
// This endpoint used to run strictly sequentially: `getMemberSeats` (Autumn
// getOrCreate, then WorkOS `listOrgMembers`, then WorkOS
// `listPendingInvitations`), THEN a SECOND `listOrgMembers` call for the same
// org, then a per-member `getUser` fan-out. That is the p95 4.4s the
// concurrency rework here fixes. Two properties have to hold for the rework to
// be safe, and only this seam sees both:
//
//   1. `listOrgMembers` is now fetched ONCE and shared between the seat count
//      and the member rows — asserted below by counting calls.
//   2. Failure semantics stay split: an Autumn (or listPendingInvitations)
//      failure degrades seats to safe defaults but still returns the member
//      list; a `listOrgMembers` failure fails the whole request as an
//      `AccountError`, exactly as it did when it had its own dedicated call.
// ---------------------------------------------------------------------------

const ORG = "org_123";
const USER = "user_admin";
const createdAt = new Date("2026-01-01T00:00:00.000Z");
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

const membership = (userId: string, status: "active" | "pending" = "active") => ({
  id: `om_${userId}`,
  userId,
  organizationId: ORG,
  status,
  role: { slug: "member" },
});

const user = (userId: string) => ({
  id: userId,
  email: `${userId}@example.test`,
  firstName: "First",
  lastName: "Last",
  profilePictureUrl: null,
  lastSignInAt: null,
});

/**
 * Stub WorkOS client whose `listOrgMembers` and `getUser` calls are counted,
 * so the shared-fetch behavior is asserted directly rather than inferred.
 */
const stubWorkOS = (members: ReadonlyArray<ReturnType<typeof membership>>) => {
  const calls = { listOrgMembers: 0, getUser: 0, listPendingInvitations: 0 };
  const layer = Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (prop === "listUserMemberships") {
          return (userId: string) =>
            Effect.succeed({ data: [{ userId, organizationId: ORG, status: "active" }] });
        }
        if (prop === "listOrgMembers") {
          return () => {
            calls.listOrgMembers += 1;
            return Effect.succeed({ data: members });
          };
        }
        if (prop === "listPendingInvitations") {
          return () => {
            calls.listPendingInvitations += 1;
            return Effect.succeed({ data: [] });
          };
        }
        if (prop === "getUser") {
          return (userId: string) => {
            calls.getUser += 1;
            return Effect.succeed(user(userId));
          };
        }
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );
  return { layer, calls };
};

const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: async (id: string) => ({ id, createdAt }),
        getAccount: async (id: string) => ({ id, createdAt }),
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: org.id,
          createdAt,
        }),
        getOrganization: async (id: string) => ({
          id,
          name: `Org ${id}`,
          slug: id,
          createdAt,
        }),
        getOrganizationBySlug: async (slug: string) => ({
          id: slug,
          name: `Org ${slug}`,
          slug,
          createdAt,
        }),
        deleteOrganizationCascade: async () => {},
      }),
    ),
});

const stubApiKeys = Layer.succeed(ApiKeyService)({
  validate: () => Effect.die("listMembers does not validate keys"),
  listUserKeys: () => Effect.die("listMembers does not touch api keys"),
  createUserKey: () => Effect.die("listMembers does not touch api keys"),
  revokeUserKey: () => Effect.die("listMembers does not touch api keys"),
  listOrgKeys: () => Effect.die("listMembers does not touch api keys"),
  createOrgKey: () => Effect.die("listMembers does not touch api keys"),
  revokeOrgKey: () => Effect.die("listMembers does not touch api keys"),
});

/** Autumn stub whose `getOrCreate` either succeeds with a plan or fails. */
const stubAutumn = (mode: "ok" | "fail") =>
  Layer.succeed(AutumnService)({
    use: <A>(fn: (client: Autumn) => Promise<A>) =>
      mode === "fail"
        ? Effect.fail(new AutumnError({ message: "autumn unreachable" }))
        : Effect.promise(() =>
            fn(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub narrows the SDK client to what getMemberSeats actually calls
              { customers: { getOrCreate: async () => ({ subscriptions: [] }) } } as any,
            ),
          ),
    ensureCustomer: () => Effect.void,
    checkExecutionBalance: () => Effect.die("listMembers does not check execution balance"),
    trackExecution: () => Effect.void,
    setMemberSeats: () => Effect.void,
  });

const providerWith = (
  members: ReadonlyArray<ReturnType<typeof membership>>,
  autumnMode: "ok" | "fail",
) => {
  const { layer: workosLayer, calls } = stubWorkOS(members);
  const provider = AccountProvider.asEffect().pipe(
    Effect.provide(
      workosAccountProvider.pipe(
        Layer.provide(
          Layer.mergeAll(
            workosLayer,
            stubUsers,
            stubApiKeys,
            stubAutumn(autumnMode),
            Layer.succeed(AccountCaller)({ session: session(USER) }),
          ),
        ),
      ),
    ),
  );
  return { provider, calls };
};

describe("listMembers · provider boundary", () => {
  it.effect("fetches listOrgMembers ONCE and shares it between seats and rows", () =>
    Effect.gen(function* () {
      const { provider, calls } = providerWith([membership(USER), membership("user_2")], "ok");
      const account = yield* provider;

      const result = yield* account.listMembers(orgHeaders);

      expect(result.members).toHaveLength(2);
      expect(calls.listOrgMembers, "listOrgMembers must be shared, not fetched twice").toBe(1);
      expect(calls.getUser).toBe(2);
    }),
  );

  it.effect("an Autumn failure degrades seats to defaults but still returns members", () =>
    Effect.gen(function* () {
      const { provider, calls } = providerWith([membership(USER)], "fail");
      const account = yield* provider;

      const result = yield* account.listMembers(orgHeaders);

      expect(result.members).toHaveLength(1);
      expect(result.seats).toEqual({ used: 0, granted: 0, unlimited: false });
      expect(calls.listOrgMembers, "still only one shared fetch despite the Autumn failure").toBe(
        1,
      );
    }),
  );

  it.effect("a listOrgMembers failure fails the whole request, not just seats", () =>
    Effect.gen(function* () {
      const failingWorkOS = Layer.succeed(
        WorkOSClient,
        new Proxy({} as WorkOSClientService, {
          get: (_target, prop) => {
            if (prop === "listUserMemberships") {
              return (userId: string) =>
                Effect.succeed({ data: [{ userId, organizationId: ORG, status: "active" }] });
            }
            if (prop === "listOrgMembers") {
              return () => Effect.fail(new WorkOSError({ status: 500 }));
            }
            if (prop === "listPendingInvitations") {
              return () => Effect.succeed({ data: [] });
            }
            return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
          },
        }),
      );

      const provider = AccountProvider.asEffect().pipe(
        Effect.provide(
          workosAccountProvider.pipe(
            Layer.provide(
              Layer.mergeAll(
                failingWorkOS,
                stubUsers,
                stubApiKeys,
                stubAutumn("ok"),
                Layer.succeed(AccountCaller)({ session: session(USER) }),
              ),
            ),
          ),
        ),
      );
      const account = yield* provider;

      const error = yield* Effect.flip(account.listMembers(orgHeaders));

      expect(error).toBeInstanceOf(AccountError);
    }),
  );
});
