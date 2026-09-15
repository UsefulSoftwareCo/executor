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
//   - `inviteMember` mirrors the PENDING membership WorkOS created for the
//     invitee (found by email among the org's pending memberships), so the
//     member list shows the invite and can revoke it
//   - `removeMember` deletes the mirror row after the WorkOS delete
//   - `updateMemberRole` writes the role WorkOS returned
//   - the seat reporter pushes the active count only once the mirror's
//     backfill marker exists, and skips (never a partial count) before
//   - the backfill mirrors every org's members and counts what it wrote,
//     writes nothing on a dry run, converges on a re-run, and stamps the
//     backfill marker
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
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
import { forkReportMemberSeats } from "../extensions/billing/member-seats";
import { AutumnService } from "../extensions/billing/service";
import { ApiKeyService } from "./api-keys";
import { UserStoreService } from "./context";
import { CloudAuthPublicHandlers, CloudSessionAuthHandlers, NonProtectedApi } from "./handlers";
import { LAST_ORG_COOKIE } from "./last-org-cookie";
import { encodeLoginState } from "./login-state";
import { cloudMemberDirectoryLayer } from "./member-directory";
import { SessionAuthLive } from "./middleware-live";
import { ORG_SELECTOR_HEADER } from "./organization";
import { WorkOSClient, type WorkOSClientService } from "./workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "./workos-mirror";
import { backfillWorkOsMirror } from "./workos-mirror-backfill";
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

/** Mirror an org row and return the URL slug the store minted for it. */
const seedOrganization = (id: string) =>
  Effect.runPromise(
    Effect.flatMap(UserStoreService.asEffect(), (users) =>
      users.use("upsertOrganization", (s) => s.upsertOrganization({ id, name: `Org ${id}` })),
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
        refreshSession: (_sealed, organizationId) => {
          refreshedInto.push(organizationId);
          return Effect.succeed("sealed-refreshed");
        },
      }),
    );
    return { handler, calls, refreshedInto };
  };

  /** `GET /auth/callback` with the CSRF-matched login `state` and any extra cookies. */
  const callbackRequest = (options: { returnTo?: string; cookies?: Record<string, string> }) => {
    const url = new URL("http://test.local/auth/callback");
    url.searchParams.set("code", "code_1");
    const cookies = { ...options.cookies };
    if (options.returnTo !== undefined) {
      const state = encodeLoginState({
        nonce: "nonce",
        returnTo: options.returnTo,
      });
      url.searchParams.set("state", state);
      cookies[STATE_COOKIE] = state;
    }
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
  const providerLayer = (
    org: string,
    deleted: string[],
    options: {
      readonly workos?: Partial<WorkOSClientService>;
      readonly autumn?: Layer.Layer<AutumnService>;
    } = {},
  ) => {
    const list = (data: readonly unknown[]) =>
      Effect.succeed({
        object: "list" as const,
        data: data as never[],
        listMetadata: { before: null, after: null },
      });
    const workos = stubWorkOS({
      ...options.workos,
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
          options.autumn ?? stubAutumn,
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
        s.upsertOrganization({ id: org, name: `Org ${org}` }),
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

  it.effect("inviteMember mirrors the pending membership WorkOS created for the invitee", () => {
    const org = freshId("org");
    // Two people are already invited; the new invitee is a third pending
    // membership, and only their user carries the invited address — with
    // different casing than the admin typed, as WorkOS may store it.
    const earlier = [freshId("user"), freshId("user")];
    const invitee = freshId("user");
    const invitedEmail = `${invitee}@placeholder.test`;
    const userCalls: string[] = [];
    // The plan gate reads the customer's plan before inviting: an unlimited
    // plan so the seat cap never interferes with what is under test.
    const teamAutumn = Layer.succeed(AutumnService)({
      use: () => Effect.succeed({ subscriptions: [{ planId: "team", status: "active" }] } as never),
      ensureCustomer: () => Effect.void,
      checkExecutionBalance: () => Effect.die("invite does not check balances"),
      trackExecution: () => Effect.void,
      setMemberSeats: () => Effect.void,
    });
    const layer = providerLayer(org, [], {
      autumn: teamAutumn,
      workos: {
        listPendingInvitations: () =>
          Effect.succeed({
            object: "list" as const,
            data: [] as never[],
            listMetadata: { before: null, after: null },
          }),
        sendInvitation: ({ email }) =>
          Effect.succeed({ id: `invitation_${invitee}`, email: email.toUpperCase() } as never),
        listOrgMembers: (organizationId, statuses) => {
          expect(organizationId).toBe(org);
          expect(statuses, "only the pending set is listed").toEqual(["pending"]);
          return Effect.succeed({
            object: "list" as const,
            data: [...earlier, invitee].map((userId) =>
              workosMembership(userId, org, { status: "pending" }),
            ) as never[],
            listMetadata: { before: null, after: null },
          });
        },
        getUser: (userId) =>
          Effect.sync(() => {
            userCalls.push(userId);
            return workosUser(userId, { firstName: "Invited", lastName: "Person" }) as never;
          }),
      },
    });
    return Effect.gen(function* () {
      yield* seedTarget(org);
      const account = yield* AccountProvider;

      const result = yield* account.inviteMember(
        { [ORG_SELECTOR_HEADER]: org },
        { email: invitedEmail },
      );

      expect(result.id).toBe(`invitation_${invitee}`);
      const members = yield* membersOf(org);
      const pending = members.find((m) => m.status === "pending");
      expect(pending, "the invitee appears as a pending member").toMatchObject({
        accountId: invitee,
        membershipId: `om_${invitee}_${org}`,
        email: invitedEmail,
        name: "Invited Person",
        role: "member",
      });
      expect(
        members.filter((m) => m.status === "pending"),
        "only the invitee's pending membership is mirrored, not the other pending ones",
      ).toHaveLength(1);
      expect(
        userCalls.sort(),
        "one getUser per pending membership, bounded to the pending set",
      ).toEqual([...earlier, invitee].sort());
    }).pipe(Effect.provide(layer));
  });

  it.effect("removeMember deletes the mirror row after the WorkOS delete", () => {
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

describe("seat reporter", () => {
  /** A `WorkOsMirror` whose only answer is the backfill marker. */
  const mirrorWithMarker = (backfilledAt: Date | null) =>
    Layer.succeed(WorkOsMirror)({
      upsertUser: () => Effect.die("the seat reporter does not write"),
      upsertMembership: () => Effect.die("the seat reporter does not write"),
      deleteMembership: () => Effect.die("the seat reporter does not write"),
      deleteUser: () => Effect.die("the seat reporter does not write"),
      getCursor: () => Effect.die("the seat reporter does not read the cursor"),
      applyPage: () => Effect.die("the seat reporter does not move the cursor"),
      backfillCompletedAt: () => Effect.succeed(backfilledAt),
      markBackfillComplete: () => Effect.die("the seat reporter does not run the backfill"),
    } satisfies WorkOsMirrorShape);

  /** A directory holding `active` active members and one pending one. */
  const directoryWith = (org: string, active: number) =>
    Layer.succeed(MemberDirectory)({
      membership: () => Effect.die("the seat reporter lists, it does not look up"),
      membersById: () => Effect.die("the seat reporter lists, it does not look up"),
      findByEmail: () => Effect.die("the seat reporter lists, it does not look up"),
      members: (organizationId, query) => {
        expect(organizationId).toBe(org);
        expect(query?.statuses, "billed seats are active members only").toEqual(["active"]);
        return Effect.succeed(
          Array.from({ length: active }, (_, i) => ({
            accountId: `user_${i}`,
            membershipId: `om_${i}`,
            organizationId,
            email: null,
            name: null,
            avatarUrl: null,
            role: "member",
            status: "active" as const,
            lastActiveAt: null,
          })),
        );
      },
    });

  const report = (org: string, backfilledAt: Date | null, active: number) =>
    Effect.gen(function* () {
      const reported: { organizationId: string; seats: number }[] = [];
      const recording = Layer.succeed(AutumnService)({
        use: () => Effect.die("the seat reporter sets seats, it does not read"),
        ensureCustomer: () => Effect.void,
        checkExecutionBalance: () => Effect.die("the seat reporter does not check balances"),
        trackExecution: () => Effect.void,
        setMemberSeats: (organizationId, seats) =>
          Effect.sync(() => {
            reported.push({ organizationId, seats });
          }),
      });
      yield* forkReportMemberSeats(org).pipe(
        Effect.provide(
          Layer.mergeAll(mirrorWithMarker(backfilledAt), directoryWith(org, active), recording),
        ),
      );
      // The Autumn call is forked; it is synchronous here, so it has landed.
      return reported;
    });

  it.effect("skips the Autumn write while the mirror has not been backfilled", () => {
    const org = freshId("org");
    return Effect.gen(function* () {
      const reported = yield* report(org, null, 2);
      expect(reported, "a partial count is never pushed to billing").toEqual([]);
    });
  });

  it.effect("sets the active member count once the backfill marker exists", () => {
    const org = freshId("org");
    return Effect.gen(function* () {
      const reported = yield* report(org, new Date(T1), 3);
      expect(reported).toEqual([{ organizationId: org, seats: 3 }]);
    });
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

  const backfillMarker = () =>
    Effect.runPromise(
      Effect.flatMap(WorkOsMirror.asEffect(), (mirror) => mirror.backfillCompletedAt()).pipe(
        Effect.provide(WorkOsMirror.Live.pipe(Layer.provide(DbService.Live))),
        Effect.scoped,
      ),
    );

  const runBackfill = (
    orgs: ReadonlyMap<string, readonly FakeMembership[]>,
    dryRun: boolean,
    userCalls: string[] = [],
  ) =>
    Effect.runPromise(
      Effect.flatMap(WorkOsMirror.asEffect(), (mirror) =>
        backfillWorkOsMirror(source(orgs, userCalls), mirror, {
          dryRun,
          log: () => undefined,
        }),
      ).pipe(Effect.provide(WorkOsMirror.Live.pipe(Layer.provide(DbService.Live))), Effect.scoped),
    );

  it("mirrors every organization's members, counts the writes, and converges on a re-run", async () => {
    const orgA = freshId("org");
    const orgB = freshId("org");
    await seedOrganization(orgA);
    await seedOrganization(orgB);
    const shared = freshId("user");
    const orgs = new Map([
      [orgA, [workosMembership(shared, orgA), workosMembership(freshId("user"), orgA)]],
      [orgB, [workosMembership(shared, orgB, { status: "pending" })]],
    ]);

    const dry = await runBackfill(orgs, true);
    expect(dry).toEqual({
      organizations: 2,
      memberships: 3,
      usersWritten: 0,
      membershipsWritten: 0,
    });
    expect(await readMembers(orgA), "a dry run writes nothing").toEqual([]);

    const userCalls: string[] = [];
    // The marker is instance-wide (migration 0019 seeds it on the empty test
    // database), so assert the stamp relative to what is there.
    const markerBefore = (await backfillMarker())?.getTime() ?? 0;
    const first = await runBackfill(orgs, false, userCalls);
    const markerAfter = await backfillMarker();
    expect(markerAfter, "a completed run stamps the backfill marker").not.toBeNull();
    expect(markerAfter!.getTime()).toBeGreaterThanOrEqual(markerBefore);
    expect(first).toEqual({
      organizations: 2,
      memberships: 3,
      usersWritten: 3,
      membershipsWritten: 3,
    });
    expect(userCalls, "one getUser per membership").toHaveLength(3);
    expect((await readMembers(orgA)).map((m) => m.status)).toEqual(["active", "active"]);
    expect((await readMembers(orgB)).map((m) => m.status)).toEqual(["pending"]);

    // Same payloads again: the `updatedAt` guard lets equal payloads through
    // (replays converge), so the counts report the rows re-written, and the
    // directory reads identically.
    const again = await runBackfill(orgs, false);
    expect(again.memberships).toBe(3);
    expect((await readMembers(orgA)).map((m) => m.accountId).sort()).toEqual(
      orgs
        .get(orgA)!
        .map((m) => m.userId)
        .sort(),
    );
  });
});
