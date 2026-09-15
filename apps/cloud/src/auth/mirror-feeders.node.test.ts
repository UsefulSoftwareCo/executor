// ---------------------------------------------------------------------------
// The membership mirror's FEEDERS, end to end through the code that runs in
// production, against the real PGlite Postgres every cloud unit test runs on
// (scripts/test-globalsetup.ts). WorkOS is a fake `WorkOSClient` (the
// emulator has no list-users / events routes); the mirror, the user store,
// and the directory read are the live layers over `DbService.Live`.
//
// What this pins:
//   - the login callback records the signed-in user and EVERY membership
//     WorkOS lists (active and pending), with the org row minted so the FK
//     holds — from the one membership list it already fetches
//   - the callback picks the landing org from that same list: a returnTo
//     slug or last-org cookie lands only in an ACTIVE membership, an unknown
//     or pending one falls through
//   - `removeMember` tombstones the mirror row after the WorkOS delete,
//     stamped with the membership's last WorkOS state (never a local clock),
//     so a replay of the membership as it was before the delete cannot
//     restore it while a replacement WorkOS created meanwhile is accepted
//   - `updateMemberRole` writes the role WorkOS returned
//   - the backfill mirrors every org's members and counts what it wrote,
//     writes nothing on a dry run, converges on a re-run, tombstones a
//     membership WorkOS no longer lists — but never one written after its
//     listing was taken — marks each org backfilled as of its listing, and
//     records the events replay boundary BEFORE its first listing and only
//     ONCE: a run that fails part-way keeps the marks of the orgs it
//     finished and the boundary it recorded, and its retry (like any later
//     run) keeps that first boundary — so a user deleted between the failed
//     attempt and the retry is still inside the events replay, and the
//     reconciler clears their profile
//   - two scans of one org that overlap cannot resurrect a membership: a scan
//     that listed it, stalled, and resumed after a later listing (which no
//     longer had it) was applied is refused whole
//   - a login whose membership list was fetched BEFORE the org was purged and
//     written after cannot re-mint the org or its membership, one fetched
//     before a rename cannot revert the rename, and one fetched before a
//     revocation the backfill has since scanned cannot reinstate the
//     membership
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { sql } from "drizzle-orm";
import { Effect, Exit, Fiber, Latch, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  AccountProvider,
  MemberDirectory,
  RouterConfigLive,
  requestScopedMiddleware,
} from "@executor-js/api/server";

import { AccountCaller, workosAccountProvider } from "../account/workos-account-service";
import { RequestScopedServicesLive } from "../api/layers";
import { DbService } from "../db/db";
import { AutumnService } from "../extensions/billing/service";
import { ApiKeyService } from "./api-keys";
import { UserStoreService } from "./context";
import { WorkOSError } from "./errors";
import { CloudAuthPublicHandlers, CloudSessionAuthHandlers, NonProtectedApi } from "./handlers";
import { LAST_ORG_COOKIE } from "./last-org-cookie";
import { encodeLoginState } from "./login-state";
import { cloudMemberDirectoryLayer } from "./member-directory";
import { SessionAuthLive } from "./middleware-live";
import { mirrorSignIn } from "./mirror-feeders";
import { ORG_SELECTOR_HEADER } from "./organization";
import { WorkOSClient, type WorkOSClientService } from "./workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "./workos-mirror";
import { backfillOrganization, backfillWorkOsMirror } from "./workos-mirror-backfill";
import type { WorkOsMembershipPayload, WorkOsUserPayload } from "./workos-mirror-store";

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";

// Synthetic identities only. Every test mints its own org ids so the shared
// test database never couples two tests.
const freshId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const workosUser = (id: string, overrides: Partial<WorkOsUserPayload> = {}) => ({
  object: "user" as const,
  id,
  email: `${id}@placeholder.test`,
  emailVerified: true,
  firstName: "Ada",
  lastName: "Placeholder",
  profilePictureUrl: null,
  lastSignInAt: T1,
  locale: null,
  createdAt: T1,
  updatedAt: T1,
  externalId: null,
  metadata: {},
  ...overrides,
});

interface FakeMembership extends WorkOsMembershipPayload {
  readonly organizationName: string;
}

const workosMembership = (
  userId: string,
  organizationId: string,
  overrides: Partial<FakeMembership> = {},
): FakeMembership => ({
  id: `om_${userId}_${organizationId}`,
  userId,
  organizationId,
  organizationName: `Org ${organizationId}`,
  role: { slug: "member" },
  status: "active",
  updatedAt: T1,
  ...overrides,
});

/** Mirrored rows for one org, read through the live cloud `MemberDirectory`. */
const readMembers = (organizationId: string) =>
  Effect.runPromise(
    Effect.flatMap(MemberDirectory.asEffect(), (directory) =>
      directory.members(organizationId, {
        statuses: ["active", "pending", "inactive"],
      }),
    ).pipe(
      Effect.provide(cloudMemberDirectoryLayer.pipe(Layer.provide(DbService.Live))),
      Effect.scoped,
    ),
  );

/** Mirror an org row (named as of T1) and return the URL slug the store minted for it. */
const seedOrganization = (id: string) =>
  Effect.runPromise(
    Effect.flatMap(UserStoreService.asEffect(), (users) =>
      users.use("upsertOrganization", (s) =>
        s.upsertOrganization({
          id,
          name: `Org ${id}`,
          updatedAt: new Date(T1),
        }),
      ),
    ).pipe(
      Effect.map((org) => org.slug),
      Effect.provide(UserStoreService.Live.pipe(Layer.provide(DbService.Live))),
      Effect.scoped,
    ),
  );

const stubAutumn = Layer.succeed(AutumnService)({
  use: () => Effect.die("feeders do not read billing"),
  ensureCustomer: () => Effect.void,
  checkExecutionBalance: () => Effect.die("feeders do not check balances"),
  trackExecution: () => Effect.void,
  setMemberSeats: () => Effect.void,
});

/**
 * A `WorkOSClient` whose every method is one of `methods`; anything else is
 * an unexpected call and dies, so a feeder that silently adds a WorkOS read
 * fails the test instead of passing on a fake.
 */
const stubWorkOS = (methods: Partial<WorkOSClientService>) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) =>
        (methods as Record<PropertyKey, unknown>)[prop] ??
        (() => Effect.die(`unexpected WorkOSClient.${String(prop)} call`)),
    }),
  );

describe("login callback", () => {
  const callbackHandler = (workos: Layer.Layer<WorkOSClient>) =>
    HttpRouter.toWebHandler(
      HttpApiBuilder.layer(NonProtectedApi).pipe(
        Layer.provide(Layer.mergeAll(CloudAuthPublicHandlers, CloudSessionAuthHandlers)),
        Layer.provide(requestScopedMiddleware(RequestScopedServicesLive).layer),
        Layer.provideMerge(SessionAuthLive),
        Layer.provideMerge(stubAutumn),
        Layer.provideMerge(workos),
        Layer.provideMerge(HttpServer.layerServices),
        Layer.provideMerge(RouterConfigLive),
      ),
      { disableLogger: true },
    ).handler;

  const STATE_COOKIE = "wos-login-state";

  /**
   * A callback handler over a fake WorkOS that authenticates `user` with the
   * memberships `listed`, recording every WorkOS read (`calls`) and every
   * session refresh (`refreshedInto`, the org ids) so the landing-org choice
   * is assertable from the outside.
   */
  const signIn = (user: ReturnType<typeof workosUser>, listed: readonly FakeMembership[]) => {
    const calls: string[] = [];
    const refreshedInto: (string | undefined)[] = [];
    const handler = callbackHandler(
      stubWorkOS({
        authenticateWithCode: () =>
          Effect.succeed({
            user,
            organizationId: undefined,
            accessToken: "access",
            refreshToken: "refresh",
            sealedSession: "sealed",
          }),
        listUserMemberships: (id) => {
          calls.push(`listUserMemberships:${id}`);
          return Effect.succeed({
            object: "list" as const,
            data: listed as never[],
            listMetadata: { before: null, after: null },
          });
        },
        // The forked seat recount after login.
        listOrgMembers: () =>
          Effect.succeed({
            object: "list" as const,
            data: [] as never[],
            listMetadata: { before: null, after: null },
          }),
        refreshSession: (_sealed, organizationId) => {
          refreshedInto.push(organizationId);
          return Effect.succeed("sealed-refreshed");
        },
      }),
    );
    return { handler, calls, refreshedInto };
  };

  /**
   * `GET /auth/callback` with the CSRF-matched login `state` (the callback
   * refuses any request without one) and any extra cookies; `returnTo`
   * rides inside the state as /login mints it.
   */
  const callbackRequest = (options: { returnTo?: string; cookies?: Record<string, string> }) => {
    const url = new URL("http://test.local/auth/callback");
    url.searchParams.set("code", "code_1");
    const state = encodeLoginState({
      nonce: "nonce",
      ...(options.returnTo === undefined ? {} : { returnTo: options.returnTo }),
    });
    url.searchParams.set("state", state);
    const cookies = { ...options.cookies, [STATE_COOKIE]: state };
    const cookie = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    return new Request(url, { headers: cookie ? { cookie } : {} });
  };

  it("records the user and every listed membership from the one list it already fetches", async () => {
    const userId = freshId("user");
    const activeOrg = freshId("org");
    const pendingOrg = freshId("org");
    const { handler, calls } = signIn(
      workosUser(userId, {
        firstName: "Grace",
        lastName: "Hopper",
        updatedAt: T2,
      }),
      [
        workosMembership(userId, activeOrg, {
          role: { slug: "admin" },
          updatedAt: T2,
        }),
        workosMembership(userId, pendingOrg, { status: "pending" }),
      ],
    );

    const response = await handler(callbackRequest({}));

    expect(response.status).toBe(302);
    expect(calls, "one membership list for the whole callback").toEqual([
      `listUserMemberships:${userId}`,
    ]);

    const active = await readMembers(activeOrg);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      accountId: userId,
      membershipId: `om_${userId}_${activeOrg}`,
      email: `${userId}@placeholder.test`,
      name: "Grace Hopper",
      role: "admin",
      status: "active",
      lastActiveAt: new Date(T1).getTime(),
    });
    const pending = await readMembers(pendingOrg);
    expect(
      pending.map((m) => m.status),
      "pending memberships are mirrored too",
    ).toEqual(["pending"]);
  });

  describe("lands in the org the returnTo slug names", () => {
    it("when the user holds an active membership there", async () => {
      const userId = freshId("user");
      const requested = freshId("org");
      const other = freshId("org");
      const slug = await seedOrganization(requested);
      const { handler, refreshedInto } = signIn(workosUser(userId), [
        workosMembership(userId, other),
        workosMembership(userId, requested),
      ]);

      const response = await handler(callbackRequest({ returnTo: `/${slug}/settings` }));

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/${slug}/settings`);
      expect(refreshedInto, "the session is switched into the requested org").toEqual([requested]);
    });

    it("never when the membership there is only pending", async () => {
      const userId = freshId("user");
      const requested = freshId("org");
      const other = freshId("org");
      const slug = await seedOrganization(requested);
      const { handler, refreshedInto } = signIn(workosUser(userId), [
        workosMembership(userId, other),
        workosMembership(userId, requested, { status: "pending" }),
      ]);

      const response = await handler(callbackRequest({ returnTo: `/${slug}` }));

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/${slug}`);
      expect(
        refreshedInto,
        "a pending membership is not a landing candidate, and an explicit slug does not fall back to another org",
      ).toEqual([]);
    });
  });

  describe("without a returnTo org", () => {
    it("lands in the last-org cookie's org when the user is active there", async () => {
      const userId = freshId("user");
      const last = freshId("org");
      const other = freshId("org");
      const slug = await seedOrganization(last);
      const { handler, refreshedInto } = signIn(workosUser(userId), [
        workosMembership(userId, other),
        workosMembership(userId, last),
      ]);

      const response = await handler(callbackRequest({ cookies: { [LAST_ORG_COOKIE]: slug } }));

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
      expect(refreshedInto).toEqual([last]);
    });

    it("falls through an unknown last-org slug to the first active membership", async () => {
      const userId = freshId("user");
      const pendingOrg = freshId("org");
      const activeOrg = freshId("org");
      const { handler, refreshedInto } = signIn(workosUser(userId), [
        workosMembership(userId, pendingOrg, { status: "pending" }),
        workosMembership(userId, activeOrg),
      ]);

      const response = await handler(
        // Valid slug grammar, never minted: the store finds no org for it.
        callbackRequest({ cookies: { [LAST_ORG_COOKIE]: "no-such-org-slug" } }),
      );

      expect(response.status).toBe(302);
      expect(refreshedInto).toEqual([activeOrg]);
    });
  });
});

describe("a delayed sign-in feeder", () => {
  /** The live mirror, user store, and directory over one test-db socket. */
  const Services = Layer.mergeAll(
    UserStoreService.Live,
    WorkOsMirror.Live,
    cloudMemberDirectoryLayer,
  ).pipe(Layer.provideMerge(DbService.Live));

  const run = <A, E>(
    body: Effect.Effect<A, E, UserStoreService | WorkOsMirror | MemberDirectory | DbService>,
  ) => Effect.runPromise(body.pipe(Effect.provide(Services), Effect.scoped));

  const readOrganization = (org: string) =>
    Effect.flatMap(UserStoreService.asEffect(), (users) =>
      users.use("getOrganization", (s) => s.getOrganization(org)),
    );

  const readMembership = (userId: string, org: string) =>
    Effect.flatMap(MemberDirectory.asEffect(), (directory) =>
      directory.membership(userId, org, ["active", "pending", "inactive"]),
    );

  it("cannot re-mint a purged organization or its membership from a list fetched before the purge", async () => {
    const userId = freshId("user");
    const org = freshId("org");
    await seedOrganization(org);
    const result = await run(
      Effect.gen(function* () {
        const users = yield* UserStoreService;
        // The login fetched its membership list at T1, while the org lived...
        const fetchedAt = new Date(T1);
        const listed = [workosMembership(userId, org)];
        // ...then stalled while cloud's deletion flow purged the org at T2.
        yield* users.use("deleteOrganizationCascade", (s) =>
          s.deleteOrganizationCascade(org, new Date(T2)),
        );
        // The stalled login resumes and writes what it holds.
        yield* mirrorSignIn(workosUser(userId), listed, fetchedAt);
        return {
          organization: yield* readOrganization(org),
          membership: yield* readMembership(userId, org),
        };
      }),
    );
    expect(result.organization?.deletedAt, "the org stays a deleted tombstone").toEqual(
      new Date(T2),
    );
    expect(result.membership, "and holds no membership: nothing to authorize").toBeNull();
  });

  it("cannot reinstate a membership from a list fetched before a revocation the backfill has since scanned", async () => {
    const userId = freshId("user");
    const org = freshId("org");
    await seedOrganization(org);
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        // The login fetched its membership list at T1, while the user was
        // a member, then stalled...
        const fetchedAt = new Date(T1);
        const listed = [workosMembership(userId, org)];
        // ...WorkOS revoked the membership before the mirror was ever
        // backfilled, and the backfill then scanned the org at T2 without
        // it: no tombstone, the row was never there — and the revocation
        // predates the events replay boundary, so no event will land it.
        yield* mirror.applyOrganizationScan({
          organizationId: org,
          listedAt: new Date(T2),
          members: [],
        });
        // The stalled login resumes and writes what it holds.
        yield* mirrorSignIn(workosUser(userId), listed, fetchedAt);
        const membership = yield* readMembership(userId, org);
        // A login after the scan, carrying a membership WorkOS created
        // since (stamped past the scan), is recorded.
        const rejoinedAt = "2026-01-03T00:00:00.000Z";
        yield* mirrorSignIn(
          workosUser(userId),
          [workosMembership(userId, org, { id: `om_${userId}_${org}_2`, updatedAt: rejoinedAt })],
          new Date(rejoinedAt),
        );
        return { membership, rejoined: yield* readMembership(userId, org) };
      }),
    );
    expect(result.membership, "the pre-scan list reinstates nothing").toBeNull();
    expect(result.rejoined?.membershipId, "a membership newer than the scan is recorded").toBe(
      `om_${userId}_${org}_2`,
    );
  });

  it("cannot revert a rename from a list fetched before it, and applies a newer name", async () => {
    const userId = freshId("user");
    const org = freshId("org");
    await seedOrganization(org);
    const result = await run(
      Effect.gen(function* () {
        const users = yield* UserStoreService;
        // The org is renamed through Executor (write-through of the WorkOS
        // organization payload, stamped T2)...
        yield* users.use("upsertOrganization", (s) =>
          s.upsertOrganization({
            id: org,
            name: "Renamed Org",
            updatedAt: new Date(T2),
          }),
        );
        // ...after a login had fetched a list still carrying the old name at T1.
        yield* mirrorSignIn(
          workosUser(userId),
          [workosMembership(userId, org, { organizationName: `Org ${org}` })],
          new Date(T1),
        );
        const afterStale = yield* readOrganization(org);
        // A login whose list was fetched after the rename carries the new name.
        yield* mirrorSignIn(
          workosUser(userId),
          [
            workosMembership(userId, org, {
              organizationName: "Renamed Again",
            }),
          ],
          new Date("2026-01-03T00:00:00.000Z"),
        );
        const afterNewer = yield* readOrganization(org);
        return {
          afterStale,
          afterNewer,
          membership: yield* readMembership(userId, org),
        };
      }),
    );
    expect(result.afterStale?.name, "the stale list does not revert the rename").toBe(
      "Renamed Org",
    );
    expect(result.afterStale?.slug, "and the slug is untouched").toBe(result.afterNewer?.slug);
    expect(result.afterNewer?.name, "a list fetched after the rename is applied").toBe(
      "Renamed Again",
    );
    expect(result.membership?.status, "the membership itself is recorded either way").toBe(
      "active",
    );
  });
});

describe("account service writes through to the mirror", () => {
  const ADMIN = freshId("user");
  const TARGET = freshId("user");

  const session = (accountId: string) => ({
    accountId,
    email: `${accountId}@placeholder.test`,
    name: null,
    avatarUrl: null,
    organizationId: null,
    sealedSession: "sealed",
    refreshedSession: null,
  });

  const stubApiKeys = Layer.succeed(ApiKeyService)({
    validate: () => Effect.die("membership writes do not validate keys"),
    listUserKeys: () => Effect.die("membership writes do not list keys"),
    createUserKey: () => Effect.die("membership writes do not create keys"),
    revokeUserKey: () => Effect.die("membership writes do not revoke keys"),
    listOrgKeys: () => Effect.die("membership writes do not list keys"),
    createOrgKey: () => Effect.die("membership writes do not create keys"),
    revokeOrgKey: () => Effect.die("membership writes do not revoke keys"),
  });

  /**
   * The provider layer over the LIVE mirror + user store (test db) and a fake
   * WorkOS in which ADMIN administers `org` and TARGET is a plain member.
   * `deleted` records the WorkOS-side deletes so "WorkOS first" is assertable.
   * Provided around the WHOLE test body so the postgres socket outlives the
   * provider call under test.
   */
  const providerLayer = (org: string, deleted: string[]) => {
    const list = (data: readonly unknown[]) =>
      Effect.succeed({
        object: "list" as const,
        data: data as never[],
        listMetadata: { before: null, after: null },
      });
    const workos = stubWorkOS({
      listUserMemberships: (userId) => list([workosMembership(userId, org)]),
      getUserOrgMembership: (organizationId, userId) =>
        Effect.succeed(
          workosMembership(userId, organizationId, {
            role: { slug: userId === ADMIN ? "admin" : "member" },
          }) as never,
        ),
      getOrgMembership: (membershipId) =>
        Effect.succeed(workosMembership(TARGET, org, { id: membershipId }) as never),
      deleteOrgMembership: (membershipId) =>
        Effect.sync(() => {
          deleted.push(membershipId);
        }),
      updateOrgMembershipRole: (membershipId, roleSlug) =>
        Effect.succeed(
          workosMembership(TARGET, org, {
            id: membershipId,
            role: { slug: roleSlug },
            updatedAt: T2,
          }) as never,
        ),
      listOrgMembers: () => list([]),
    });
    // The test database serves ONE connection at a time, so the seed, the
    // provider, and the directory read all share this layer's socket.
    const stores = Layer.mergeAll(
      UserStoreService.Live,
      WorkOsMirror.Live,
      cloudMemberDirectoryLayer,
    );
    return workosAccountProvider.pipe(
      Layer.provide(
        Layer.mergeAll(
          workos,
          stubApiKeys,
          stubAutumn,
          Layer.succeed(AccountCaller)({ session: session(ADMIN) }),
        ),
      ),
      Layer.provideMerge(stores),
      Layer.provide(DbService.Live),
    );
  };

  // TARGET as an existing member of `org`, seeded through the live mirror.
  const seedTarget = (org: string) =>
    Effect.gen(function* () {
      const users = yield* UserStoreService;
      const mirror = yield* WorkOsMirror;
      yield* users.use("upsertOrganization", (s) =>
        s.upsertOrganization({
          id: org,
          name: `Org ${org}`,
          updatedAt: new Date(T1),
        }),
      );
      yield* mirror.upsertMembership({
        id: `om_${TARGET}_${org}`,
        accountId: TARGET,
        organizationId: org,
        role: "member",
        status: "active",
        updatedAt: new Date(T1),
      });
    });

  const membersOf = (org: string) =>
    Effect.flatMap(MemberDirectory.asEffect(), (directory) => directory.members(org));

  it.effect("removeMember tombstones the mirror row after the WorkOS delete", () => {
    const org = freshId("org");
    const deleted: string[] = [];
    return Effect.gen(function* () {
      yield* seedTarget(org);
      const account = yield* AccountProvider;

      const result = yield* account.removeMember(
        { [ORG_SELECTOR_HEADER]: org },
        `om_${TARGET}_${org}`,
      );

      expect(result).toEqual({ success: true });
      expect(deleted, "WorkOS is the authority and is written first").toEqual([
        `om_${TARGET}_${org}`,
      ]);
      const members = yield* membersOf(org);
      expect(members.map((m) => m.accountId)).not.toContain(TARGET);

      // A login or backfill that listed TARGET's membership BEFORE the
      // removal writes it afterwards: the tombstone refuses it.
      const mirror = yield* WorkOsMirror;
      const replayed = yield* mirror.upsertMembership({
        id: `om_${TARGET}_${org}`,
        accountId: TARGET,
        organizationId: org,
        role: "member",
        status: "active",
        updatedAt: new Date(T1),
      });
      expect(replayed, "the pre-removal payload is refused").toBe(false);
      expect((yield* membersOf(org)).map((m) => m.accountId)).not.toContain(TARGET);

      // The tombstone carries the membership's last WorkOS stamp (T1), not
      // the wall clock at the delete: a replacement membership WorkOS
      // created for TARGET while the removal was in flight — stamped T2,
      // long before any clock this test runs under — is accepted.
      const replaced = yield* mirror.upsertMembership({
        id: `om_${TARGET}_${org}_2`,
        accountId: TARGET,
        organizationId: org,
        role: "member",
        status: "active",
        updatedAt: new Date(T2),
      });
      expect(replaced, "a replacement newer than the removed state is accepted").toBe(true);
      expect((yield* membersOf(org)).map((m) => m.accountId)).toContain(TARGET);
    }).pipe(Effect.provide(providerLayer(org, deleted)));
  });

  it.effect("updateMemberRole writes the role WorkOS returned", () => {
    const org = freshId("org");
    return Effect.gen(function* () {
      yield* seedTarget(org);
      const account = yield* AccountProvider;

      const result = yield* account.updateMemberRole(
        { [ORG_SELECTOR_HEADER]: org },
        `om_${TARGET}_${org}`,
        "admin",
      );

      expect(result).toEqual({ success: true });
      const members = yield* membersOf(org);
      expect(members.find((m) => m.accountId === TARGET)?.role).toBe("admin");
    }).pipe(Effect.provide(providerLayer(org, [])));
  });
});

describe("backfill", () => {
  /** A fake WorkOS holding `orgs` → members, counting `getUser` calls. */
  const source = (orgs: ReadonlyMap<string, readonly FakeMembership[]>, userCalls: string[]) => ({
    listOrganizationIds: () => Effect.succeed([...orgs.keys()]),
    listOrgMembers: (organizationId: string) => Effect.succeed(orgs.get(organizationId) ?? []),
    getUser: (userId: string) =>
      Effect.sync(() => {
        userCalls.push(userId);
        return workosUser(userId);
      }),
  });

  const withMirror = <A, E>(body: (mirror: WorkOsMirrorShape) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.flatMap(WorkOsMirror.asEffect(), body).pipe(
        Effect.provide(WorkOsMirror.Live.pipe(Layer.provide(DbService.Live))),
        Effect.scoped,
      ),
    );

  const runBackfill = (
    orgs: ReadonlyMap<string, readonly FakeMembership[]>,
    dryRun: boolean,
    userCalls: string[] = [],
  ) =>
    withMirror((mirror) =>
      backfillWorkOsMirror(source(orgs, userCalls), mirror, {
        dryRun,
        log: () => undefined,
      }),
    );

  /** The instance-wide replay boundary a completed run records. */
  const syncState = () => withMirror((mirror) => mirror.replayBoundary());

  /** When a run first covered every organization, or null: the authorization gate's first half. */
  const completedAt = () => withMirror((mirror) => mirror.backfillCompletedAt());

  /** Drop the instance-wide events row, so the run under test is the first ever. */
  const clearEventsRow = () =>
    Effect.runPromise(
      Effect.flatMap(DbService.asEffect(), ({ db }) =>
        Effect.promise(() => db.execute(sql`delete from workos_sync where id = 'events'`)),
      ).pipe(Effect.provide(DbService.Live), Effect.scoped),
    );

  const backfilledAt = (org: string) =>
    withMirror((mirror) => mirror.organizationBackfilledAt(org));

  it("records the replay boundary at its start, marks and mirrors every organization's members, counts the writes, converges and repairs on a re-run", async () => {
    const orgA = freshId("org");
    const orgB = freshId("org");
    await seedOrganization(orgA);
    await seedOrganization(orgB);
    const shared = freshId("user");
    const leaving = freshId("user");
    const orgs = new Map([
      [orgA, [workosMembership(shared, orgA), workosMembership(leaving, orgA)]],
      [orgB, [workosMembership(shared, orgB, { status: "pending" })]],
    ]);

    // The boundary is instance-wide (migration 0019 seeds it on the empty
    // test database, other tests may have written it): start as a database
    // that has never been backfilled.
    await clearEventsRow();
    const startedAt = Date.now();

    const dry = await runBackfill(orgs, true);
    expect(dry).toEqual({
      organizations: 2,
      memberships: 3,
      usersWritten: 0,
      membershipsWritten: 0,
      membershipsTombstoned: 0,
    });
    expect(await readMembers(orgA), "a dry run writes nothing").toEqual([]);
    expect(await syncState(), "a dry run records no boundary").toBeNull();
    expect(await completedAt(), "nor a completion").toBeNull();
    expect(await backfilledAt(orgA), "and marks nothing").toBeNull();

    const userCalls: string[] = [];
    const first = await runBackfill(orgs, false, userCalls);
    expect(first).toEqual({
      organizations: 2,
      memberships: 3,
      usersWritten: 3,
      membershipsWritten: 3,
      membershipsTombstoned: 0,
    });
    expect(userCalls, "one getUser per membership").toHaveLength(3);
    expect((await readMembers(orgA)).map((m) => m.status)).toEqual(["active", "active"]);
    expect((await readMembers(orgB)).map((m) => m.status)).toEqual(["pending"]);
    const after = await syncState();
    expect(after, "the run records where the events replay starts").not.toBeNull();
    const firstCompletion = await completedAt();
    expect(firstCompletion, "and that every organization is now covered").not.toBeNull();
    expect(firstCompletion!.getTime()).toBeGreaterThanOrEqual(after!.getTime());
    expect(after!.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(
      after!.getTime(),
      "the boundary is the instant the run began reading, before any listing",
    ).toBeLessThanOrEqual(startedAt + 60 * 1000);
    for (const org of [orgA, orgB]) {
      const marked = await backfilledAt(org);
      expect(marked, "each scanned organization is marked as of its listing").not.toBeNull();
      expect(marked!.getTime()).toBeGreaterThanOrEqual(after!.getTime());
    }

    // Same payloads again, minus one member WorkOS no longer lists: the
    // `updatedAt` guard lets equal payloads through (replays converge), and
    // the missing membership is tombstoned — a re-run repairs a stale row.
    orgs.set(orgA, [workosMembership(shared, orgA)]);
    const again = await runBackfill(orgs, false);
    expect(again).toMatchObject({ memberships: 2, membershipsTombstoned: 1 });
    expect(
      await syncState(),
      "the re-run keeps the first boundary: an org rename or user deletion between the two runs is only in the events stream",
    ).toEqual(after);
    expect(await completedAt(), "and the first completion").toEqual(firstCompletion);
    expect(new Map((await readMembers(orgA)).map((m) => [m.accountId, m.status]))).toEqual(
      new Map([
        [shared, "active"],
        [leaving, "inactive"],
      ]),
    );
    expect(
      (await readMembers(orgB)).map((m) => m.status),
      "the other org is untouched",
    ).toEqual(["pending"]);
    // The tombstone is keyed to the deleted membership id, so the member's
    // pre-removal payload (as a late login or event would carry) is refused.
    const replayed = await withMirror((mirror) =>
      mirror.upsertMembership({
        id: `om_${leaving}_${orgA}`,
        accountId: leaving,
        organizationId: orgA,
        role: "member",
        status: "active",
        updatedAt: new Date(T1),
      }),
    );
    expect(replayed).toBe(false);
  });

  it("keeps a membership WorkOS merely deactivated as inactive, not tombstoned, so a later reactivation lands", async () => {
    const org = freshId("org");
    await seedOrganization(org);
    const paused = freshId("user");
    // Mirrored while active (a sign-in), then deactivated in WorkOS: the
    // listing carries the membership under the SAME id with its real status.
    await withMirror((mirror) =>
      mirror.upsertMembership({
        id: `om_${paused}_${org}`,
        accountId: paused,
        organizationId: org,
        role: "member",
        status: "active",
        updatedAt: new Date(T1),
      }),
    );

    const counts = await runBackfill(
      new Map([[org, [workosMembership(paused, org, { status: "inactive", updatedAt: T2 })]]]),
      false,
    );
    expect(counts, "the deactivated membership is written, not tombstoned").toMatchObject({
      memberships: 1,
      membershipsWritten: 1,
      membershipsTombstoned: 0,
    });
    expect((await readMembers(org)).map((m) => [m.accountId, m.status])).toEqual([
      [paused, "inactive"],
    ]);

    // WorkOS reactivates it under the same id AFTER the scan (so the payload
    // is stamped past the org's `backfilled_at`): an ordinary newer payload,
    // which a tombstone keyed to that id would have refused for good.
    const reactivated = await withMirror((mirror) =>
      mirror.upsertMembership({
        id: `om_${paused}_${org}`,
        accountId: paused,
        organizationId: org,
        role: "member",
        status: "active",
        updatedAt: new Date(Date.now() + 60 * 1000),
      }),
    );
    expect(reactivated).toBe(true);
    expect((await readMembers(org)).map((m) => m.status)).toEqual(["active"]);
  });

  it("leaves a membership written after its listing alone when tombstoning what the listing lacks", async () => {
    const org = freshId("org");
    await seedOrganization(org);
    const listed = freshId("user");
    const stale = freshId("user");
    const joinedMeanwhile = freshId("user");
    // Both rows are absent from the listing below. `stale` is stamped before
    // the listing (a genuine leaver); `joinedMeanwhile` carries a stamp AFTER
    // any listing this run can take — the membership WorkOS created between
    // the listing and the cleanup, whose own event lands via the reconciler.
    const afterListing = new Date(Date.now() + 60 * 60 * 1000);
    await withMirror((mirror) =>
      Effect.all([
        mirror.upsertMembership({
          id: `om_${stale}_${org}`,
          accountId: stale,
          organizationId: org,
          role: "member",
          status: "active",
          updatedAt: new Date(T1),
        }),
        mirror.upsertMembership({
          id: `om_${joinedMeanwhile}_${org}`,
          accountId: joinedMeanwhile,
          organizationId: org,
          role: "member",
          status: "active",
          updatedAt: afterListing,
        }),
      ]),
    );

    const counts = await runBackfill(new Map([[org, [workosMembership(listed, org)]]]), false);

    expect(counts).toMatchObject({ memberships: 1, membershipsTombstoned: 1 });
    expect(new Map((await readMembers(org)).map((m) => [m.accountId, m.status]))).toEqual(
      new Map([
        [listed, "active"],
        [stale, "inactive"],
        [joinedMeanwhile, "active"],
      ]),
    );
  });

  it("keeps the boundary a run that fails part-way recorded, so a user deleted before the retry is still the reconciler's to clear", async () => {
    const orgA = freshId("org");
    const orgB = freshId("org");
    await seedOrganization(orgA);
    await seedOrganization(orgB);
    const staying = freshId("user");
    const deletedMeanwhile = freshId("user");
    await clearEventsRow();

    // Attempt A mirrors both users of orgA, then fails on orgB's listing.
    const attemptA = new Map([
      [orgA, [workosMembership(staying, orgA), workosMembership(deletedMeanwhile, orgA)]],
      [orgB, [workosMembership(staying, orgB)]],
    ]);
    const failing = {
      ...source(attemptA, []),
      listOrgMembers: (organizationId: string) =>
        organizationId === orgB
          ? Effect.fail(new WorkOSError({ status: 503 }))
          : Effect.succeed(attemptA.get(organizationId) ?? []),
    };
    const exit = await withMirror((mirror) =>
      Effect.exit(
        backfillWorkOsMirror(failing, mirror, {
          dryRun: false,
          log: () => undefined,
        }),
      ),
    );
    expect(Exit.isFailure(exit), "the run fails rather than skipping the org").toBe(true);
    const boundary = await syncState();
    expect(boundary, "the failed attempt already fixed the replay boundary").not.toBeNull();
    expect(await backfilledAt(orgA), "the org it finished is marked").not.toBeNull();
    expect(await backfilledAt(orgB), "the org it did not reach is not").toBeNull();
    expect(
      await completedAt(),
      "no completion mark: the failed attempt did not cover every organization",
    ).toBeNull();
    expect(
      (await readMembers(orgA)).find((m) => m.accountId === deletedMeanwhile)?.email,
      "the user's profile is mirrored",
    ).toBe(`${deletedMeanwhile}@placeholder.test`);

    // WorkOS deletes `deletedMeanwhile` between the attempts. Its
    // `user.deleted` event is stamped AFTER the boundary attempt A recorded.
    const deletedAt = new Date(boundary!.getTime() + 1);

    // Retry B lists WorkOS without the deleted user and succeeds.
    const attemptB = new Map([
      [orgA, [workosMembership(staying, orgA)]],
      [orgB, [workosMembership(staying, orgB)]],
    ]);
    const retried = await runBackfill(attemptB, false);
    expect(retried).toMatchObject({ organizations: 2, membershipsTombstoned: 1 });
    expect(
      await syncState(),
      "the retry keeps the first attempt's boundary instead of taking a later one",
    ).toEqual(boundary);
    expect(
      await backfilledAt(orgB),
      "and finishes the org the first attempt did not",
    ).not.toBeNull();
    expect(
      await completedAt(),
      "the retry is the first run to cover every organization, so it records the completion",
    ).not.toBeNull();
    // The scan tombstoned the membership, but the account profile is not
    // the scan's to clear: that is the `user.deleted` event's job, which is
    // exactly why the boundary must not move past it.
    const tombstoned = (await readMembers(orgA)).find((m) => m.accountId === deletedMeanwhile);
    expect(tombstoned?.status).toBe("inactive");
    expect(tombstoned?.email, "the profile is still there for the event to clear").not.toBeNull();

    // The reconciler's first run reads from the kept boundary, so the
    // deletion (stamped after it) is inside the replay and clears the row.
    expect(deletedAt.getTime()).toBeGreaterThan(boundary!.getTime());
    const cleared = await withMirror((mirror) => mirror.deleteUser(deletedMeanwhile, deletedAt));
    expect(cleared).toBe(true);
    expect(
      (await readMembers(orgA)).find((m) => m.accountId === deletedMeanwhile)?.email,
      "the deleted user's profile is gone from the directory",
    ).toBeNull();
  });

  it("scans one organization on demand and marks only that one", async () => {
    const org = freshId("org");
    const other = freshId("org");
    await seedOrganization(org);
    await seedOrganization(other);
    const member = freshId("user");
    const orgs = new Map([
      [org, [workosMembership(member, org)]],
      [other, [workosMembership(member, other)]],
    ]);

    const counts = await withMirror((mirror) =>
      backfillOrganization(source(orgs, []), mirror, org, { dryRun: false }),
    );

    expect(counts).toEqual({
      applied: true,
      memberships: 1,
      usersWritten: 1,
      membershipsWritten: 1,
      membershipsTombstoned: 0,
    });
    expect((await readMembers(org)).map((m) => m.accountId)).toEqual([member]);
    expect(await backfilledAt(org)).not.toBeNull();
    expect(await readMembers(other), "the other organization is not scanned").toEqual([]);
    expect(await backfilledAt(other), "nor marked").toBeNull();
  });

  it("refuses a scan that stalled while a later scan found a membership gone, so the revoked member stays revoked", async () => {
    const org = freshId("org");
    await seedOrganization(org);
    const staying = freshId("user");
    const leaving = freshId("user");
    const result = await withMirror((mirror) =>
      Effect.gen(function* () {
        // Scan A lists the org while `leaving` is still a member, then
        // stalls (its listing is held behind the latch)...
        const listedByA = yield* Latch.make(false);
        const stalled = {
          ...source(new Map(), []),
          listOrgMembers: () =>
            listedByA.await.pipe(
              Effect.as([workosMembership(staying, org), workosMembership(leaving, org)]),
            ),
        };
        const scanA = yield* Effect.forkChild(
          backfillOrganization(stalled, mirror, org, { dryRun: false }),
          { startImmediately: true },
        );
        // ...WorkOS removes `leaving`, and scan B lists and applies the
        // org without them — no tombstone, the row was never there...
        const b = yield* backfillOrganization(
          source(new Map([[org, [workosMembership(staying, org)]]]), []),
          mirror,
          org,
          { dryRun: false },
        );
        // ...then A resumes with its older listing.
        yield* listedByA.open;
        const a = yield* Fiber.join(scanA);
        return { a, b };
      }),
    );
    expect(result.b).toMatchObject({ applied: true, membershipsWritten: 1 });
    expect(result.a, "the older listing is refused whole").toMatchObject({
      applied: false,
      memberships: 2,
      usersWritten: 0,
      membershipsWritten: 0,
      membershipsTombstoned: 0,
    });
    expect(
      new Map((await readMembers(org)).map((m) => [m.accountId, m.status])),
      "the member the later listing no longer had was never inserted",
    ).toEqual(new Map([[staying, "active"]]));
  });
});
