// ---------------------------------------------------------------------------
// The membership mirror's RECONCILER (`workos-events-sync.ts`) and the
// webhook that pokes it (`workos-webhook.ts`), against the real PGlite
// Postgres every cloud unit test runs on (scripts/test-globalsetup.ts).
// WorkOS is a fake `WorkOSClient` for the Events API (the emulator has no
// events route); the signature check runs the REAL client's verifier over a
// locally computed HMAC, because that check is the webhook's only
// authentication.
//
// What this pins:
//   - every followed event type lands in the mirror: user created/updated/
//     deleted, membership created/updated/deleted, organization renamed
//   - an older event never regresses a newer row (`stale`) — an older
//     organization rename included — a replayed delete is `absent`, and
//     `organization.deleted` MARKS the org deleted without purging anything;
//     replayed, or after cloud's own flow marked it first, it is `absent`
//   - `organization.deleted` for an org the mirror has never seen MINTS a
//     tombstone row, so a login that fetched a membership of it before the
//     deletion cannot mint the org or the membership afterwards
//   - a delete TOMBSTONES its row as of the event's `createdAt`, so an older
//     payload replayed after it is `stale` and the row stays inactive — even
//     when the delete arrives before the mirror has ever seen the membership
//     (the reconciler ahead of the backfill): the tombstone is minted, with
//     its organization, so the backfill cannot insert the row live
//   - a membership created or updated for a member the mirror holds no
//     profile for reads the profile from WorkOS (one `getUser`, only then),
//     so a pre-boundary user who joins a scanned org is searchable by name
//     and email; a member WorkOS no longer has is mirrored bare, and a
//     transient failure fails the run
//   - a membership for an organization the mirror has never seen mirrors
//     the org first (one WorkOS read), so the foreign key holds; one whose
//     org WorkOS no longer has marks the org deleted instead (minting the
//     tombstone) and the cursor still advances, while a transient WorkOS
//     failure still fails the run
//   - `organization.updated` never inserts an org the mirror does not hold
//   - a run with no cursor reads from the backfill's replay boundary, and
//     with no boundary either reads nothing (the backfill has not run)
//   - a run pages from the persisted cursor, commits after every page, and
//     STOPS when another run moves the cursor under it — with NOTHING from
//     the contended page written (a lagging run cannot resurrect a
//     membership the leading run already deleted)
//   - a run that reads the stream to its end records the drain as of its
//     start (the authorization path's caught-up check); a run that read
//     nothing, or yielded the stream, records none
//   - the webhook accepts only a genuinely signed delivery, never applies
//     it, and refuses everything when no signing secret is configured
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { sql } from "drizzle-orm";
import { Effect, Exit, Layer, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import type { Organization, OrganizationMembership, User } from "@workos-inc/node/worker";

import { MemberDirectory, type MemberStatus } from "@executor-js/api/server";

import { DbService } from "../db/db";
import { UserStoreService } from "./context";
import { WorkOSError } from "./errors";
import { cloudMemberDirectoryLayer } from "./member-directory";
import { mirrorSignIn } from "./mirror-feeders";
import { WorkOSClient, type WorkOSClientService, type WorkOSListEventsOptions } from "./workos";
import {
  planEvent,
  syncWorkOsEvents,
  type WorkOsEventOutcome,
  type WorkOsEventsSyncReport,
  type WorkOsMirroredEvent,
} from "./workos-events-sync";
import { WorkOsMirror, WorkOsMirrorWrite, mirrorMembershipFromWorkOs } from "./workos-mirror";
import { WORKOS_WEBHOOK_PATH, makeWorkOsWebhookRoute } from "./workos-webhook";

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";
const T3 = "2026-01-03T00:00:00.000Z";

// Synthetic identities only; every test mints its own ids so the shared test
// database never couples two tests.
const freshId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const workosUser = (id: string, overrides: Partial<User> = {}): User => ({
  object: "user",
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

const workosMembership = (
  userId: string,
  organizationId: string,
  overrides: Partial<OrganizationMembership> = {},
): OrganizationMembership => ({
  object: "organization_membership",
  id: `om_${userId}_${organizationId}`,
  userId,
  organizationId,
  organizationName: `Org ${organizationId}`,
  status: "active",
  directoryManaged: false,
  createdAt: T1,
  updatedAt: T1,
  customAttributes: {},
  role: { slug: "member" },
  ...overrides,
});

const workosOrganization = (id: string, name: string, updatedAt = T1): Organization => ({
  object: "organization",
  id,
  name,
  allowProfilesOutsideOrganization: false,
  domains: [],
  createdAt: T1,
  updatedAt,
  externalId: null,
  metadata: {},
});

const userEvent = (
  event: "user.created" | "user.updated" | "user.deleted",
  data: User,
  id = freshId("event"),
  createdAt = T1,
): WorkOsMirroredEvent => ({
  id,
  event,
  data,
  createdAt,
  context: undefined,
});

const membershipEvent = (
  event:
    | "organization_membership.created"
    | "organization_membership.updated"
    | "organization_membership.deleted",
  data: OrganizationMembership,
  id = freshId("event"),
  createdAt = T1,
): WorkOsMirroredEvent => ({
  id,
  event,
  data,
  createdAt,
  context: undefined,
});

const organizationEvent = (
  event: "organization.updated" | "organization.deleted",
  data: Organization,
  id = freshId("event"),
  createdAt = T1,
): WorkOsMirroredEvent => ({
  id,
  event,
  data,
  createdAt,
  context: undefined,
});

/**
 * A `WorkOSClient` whose every method is one of `methods`; anything else is
 * an unexpected call and dies, so a reconciler that silently adds a WorkOS
 * read fails the test instead of passing on a fake.
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

/**
 * `getUser` for every member a test's membership events name: the
 * reconciler reads a profile for a member the mirror holds none for, and
 * the strict stub above would die on it. Records each read in `reads`.
 */
const profiles = (reads: string[] = []): Partial<WorkOSClientService> => ({
  getUser: (userId) =>
    Effect.sync(() => {
      reads.push(userId);
      return workosUser(userId);
    }),
});

const DbLive = DbService.Live;
const MirrorServices = Layer.mergeAll(
  WorkOsMirror.Live,
  UserStoreService.Live,
  cloudMemberDirectoryLayer,
).pipe(Layer.provideMerge(DbLive));

type Services = WorkOsMirror | UserStoreService | MemberDirectory | DbService | WorkOSClient;

const run = <A, E>(
  body: Effect.Effect<A, E, Services>,
  workos: Layer.Layer<WorkOSClient> = stubWorkOS({}),
) =>
  Effect.runPromise(
    body.pipe(Effect.provide(Layer.mergeAll(MirrorServices, workos)), Effect.scoped),
  );

const seedOrganization = (id: string) =>
  Effect.flatMap(UserStoreService.asEffect(), (users) =>
    users.use("upsertOrganization", (s) =>
      s.upsertOrganization({ id, name: `Org ${id}`, updatedAt: new Date(T1) }),
    ),
  );

const readOrganization = (id: string) =>
  Effect.flatMap(UserStoreService.asEffect(), (users) =>
    users.use("getOrganization", (s) => s.getOrganization(id)),
  );

const readMembership = (
  accountId: string,
  organizationId: string,
  statuses?: readonly MemberStatus[],
) =>
  Effect.flatMap(MemberDirectory.asEffect(), (directory) =>
    directory.membership(accountId, organizationId, statuses),
  );

/**
 * Apply one event the way a run does — plan it, then apply it as a one-event
 * page under the cursor CAS — and report the event's outcome. The cursor is
 * instance-wide; each apply moves it to a fresh id, which is what a run does.
 */
const applyEvent = (event: WorkOsMirroredEvent) =>
  Effect.gen(function* () {
    const mirror = yield* WorkOsMirror;
    const write = yield* planEvent(event);
    const prev = yield* mirror.getCursor();
    const outcomes = yield* mirror.applyPage(prev, freshId("event"), [write]);
    expect(Option.isSome(outcomes), "no other run contends in a single-event apply").toBe(true);
    const outcome: WorkOsEventOutcome | undefined = Option.getOrElse(outcomes, () => [])[0];
    expect(outcome, "one write, one outcome").toBeDefined();
    return outcome ?? "absent";
  });

describe("applyEvent", () => {
  it("mirrors a user, refreshes it, refuses an older update, and deletes it", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const result = await run(
      Effect.gen(function* () {
        yield* seedOrganization(org);
        yield* applyEvent(
          membershipEvent("organization_membership.created", workosMembership(userId, org)),
        );

        const created = yield* applyEvent(
          userEvent("user.created", workosUser(userId, { firstName: "Grace", updatedAt: T2 })),
        );
        const afterCreate = yield* readMembership(userId, org);
        const updated = yield* applyEvent(
          userEvent("user.updated", workosUser(userId, { firstName: "Newer", updatedAt: T3 })),
        );
        const afterUpdate = yield* readMembership(userId, org);
        const stale = yield* applyEvent(
          userEvent("user.updated", workosUser(userId, { firstName: "Stale", updatedAt: T1 })),
        );
        const afterStale = yield* readMembership(userId, org);
        // The delete is stamped with the EVENT's time (T3), after every
        // payload above; the SDK payload's own `updatedAt` predates it.
        const deleted = yield* applyEvent(
          userEvent("user.deleted", workosUser(userId), freshId("event"), T3),
        );
        const afterDelete = yield* readMembership(userId, org);
        const tombstoned = yield* readMembership(userId, org, ["inactive"]);
        // A profile update that happened before the delete but lands after it.
        const lateUpdate = yield* applyEvent(
          userEvent("user.updated", workosUser(userId, { firstName: "Late", updatedAt: T2 })),
        );
        const afterLate = yield* readMembership(userId, org, ["inactive"]);
        return {
          created,
          afterCreate,
          updated,
          afterUpdate,
          stale,
          afterStale,
          deleted,
          afterDelete,
          tombstoned,
          lateUpdate,
          afterLate,
        };
      }),
      stubWorkOS(profiles()),
    );
    expect(result.created).toBe("applied");
    expect(result.afterCreate?.name).toBe("Grace Placeholder");
    expect(result.updated).toBe("applied");
    expect(result.afterUpdate?.name).toBe("Newer Placeholder");
    expect(result.stale, "an event older than the stored row is reported stale").toBe("stale");
    expect(result.afterStale?.name, "and leaves the newer row untouched").toBe("Newer Placeholder");
    expect(result.deleted).toBe("applied");
    expect(result.afterDelete, "deleting the user tombstones its membership").toBeNull();
    expect(result.tombstoned, "the row stays, inactive, with the profile cleared").toMatchObject({
      status: "inactive",
      name: null,
      email: null,
    });
    expect(result.lateUpdate, "a payload older than the deletion is refused").toBe("stale");
    expect(result.afterLate).toMatchObject({ status: "inactive", name: null });
  });

  it("mirrors a membership, updates its role, refuses an older update, and deletes it", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const result = await run(
      Effect.gen(function* () {
        yield* seedOrganization(org);
        const created = yield* applyEvent(
          membershipEvent(
            "organization_membership.created",
            workosMembership(userId, org, { status: "pending" }),
          ),
        );
        const afterCreate = yield* readMembership(userId, org);
        const updated = yield* applyEvent(
          membershipEvent(
            "organization_membership.updated",
            workosMembership(userId, org, {
              role: { slug: "admin" },
              updatedAt: T3,
            }),
          ),
        );
        const afterUpdate = yield* readMembership(userId, org);
        const stale = yield* applyEvent(
          membershipEvent(
            "organization_membership.updated",
            workosMembership(userId, org, {
              role: { slug: "member" },
              status: "inactive",
              updatedAt: T2,
            }),
          ),
        );
        const afterStale = yield* readMembership(userId, org);
        // The delete is stamped with the EVENT's time (T3), after every
        // payload above; the SDK payload's own `updatedAt` predates it.
        const deleted = yield* applyEvent(
          membershipEvent(
            "organization_membership.deleted",
            workosMembership(userId, org),
            freshId("event"),
            T3,
          ),
        );
        const afterDelete = yield* readMembership(userId, org);
        const deletedAgain = yield* applyEvent(
          membershipEvent(
            "organization_membership.deleted",
            workosMembership(userId, org),
            freshId("event"),
            T3,
          ),
        );
        // A membership update that happened before the delete but lands
        // after it (a lagging feeder, an out-of-order delivery): refused, the
        // tombstone stands.
        const lateUpdate = yield* applyEvent(
          membershipEvent(
            "organization_membership.updated",
            workosMembership(userId, org, {
              role: { slug: "admin" },
              updatedAt: T2,
            }),
          ),
        );
        const afterLate = yield* readMembership(userId, org, ["inactive"]);
        return {
          created,
          afterCreate,
          updated,
          afterUpdate,
          stale,
          afterStale,
          deleted,
          afterDelete,
          deletedAgain,
          lateUpdate,
          afterLate,
        };
      }),
      stubWorkOS(profiles()),
    );
    expect(result.created).toBe("applied");
    expect(result.afterCreate).toMatchObject({
      membershipId: `om_${userId}_${org}`,
      status: "pending",
      role: "member",
    });
    expect(result.updated).toBe("applied");
    expect(result.afterUpdate).toMatchObject({
      status: "active",
      role: "admin",
    });
    expect(result.stale).toBe("stale");
    expect(result.afterStale).toMatchObject({
      status: "active",
      role: "admin",
    });
    expect(result.deleted).toBe("applied");
    expect(result.afterDelete, "a tombstone reads as no membership").toBeNull();
    expect(result.deletedAgain, "a replayed delete changes nothing").toBe("absent");
    expect(result.lateUpdate, "a payload older than the deletion is refused").toBe("stale");
    expect(result.afterLate).toMatchObject({
      status: "inactive",
      role: "admin",
    });
  });

  it("tombstones a membership the mirror has never seen, mirroring its organization first, so the backfill cannot insert it live", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const reads: string[] = [];
    const result = await run(
      Effect.gen(function* () {
        // The deletion lands before any feeder wrote the membership or the
        // org; the org is read from WorkOS so the tombstone row can exist.
        const deleted = yield* applyEvent(
          membershipEvent(
            "organization_membership.deleted",
            workosMembership(userId, org),
            freshId("event"),
            T2,
          ),
        );
        const organization = yield* readOrganization(org);
        const tombstone = yield* readMembership(userId, org, ["inactive"]);
        // The backfill, listing WorkOS as it was before the deletion, writes
        // the membership afterwards: refused, the tombstone stands.
        const mirror = yield* WorkOsMirror;
        const backfilled = yield* mirror.upsertMembership(
          mirrorMembershipFromWorkOs(workosMembership(userId, org)),
        );
        const afterBackfill = yield* readMembership(userId, org);
        return { deleted, organization, tombstone, backfilled, afterBackfill };
      }),
      stubWorkOS({
        getOrganization: (id) => {
          reads.push(id);
          return Effect.succeed(workosOrganization(id, "Dashboard Org"));
        },
      }),
    );
    expect(reads, "exactly one WorkOS read, for the unknown org").toEqual([org]);
    expect(result.deleted, "the delete leaves a tombstone behind").toBe("applied");
    expect(result.organization?.name).toBe("Dashboard Org");
    expect(result.tombstone).toMatchObject({
      membershipId: `om_${userId}_${org}`,
      status: "inactive",
    });
    expect(result.backfilled, "the pre-deletion payload is refused").toBe(false);
    expect(result.afterBackfill, "and the member is not live").toBeNull();
  });

  it("mirrors the organization first when a membership names one the mirror has never seen", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const reads: string[] = [];
    const result = await run(
      Effect.gen(function* () {
        const outcome = yield* applyEvent(
          membershipEvent("organization_membership.created", workosMembership(userId, org)),
        );
        const organization = yield* readOrganization(org);
        const membership = yield* readMembership(userId, org);
        return { outcome, organization, membership };
      }),
      stubWorkOS({
        ...profiles(reads),
        getOrganization: (id) => {
          reads.push(id);
          return Effect.succeed(workosOrganization(id, "Dashboard Org"));
        },
      }),
    );
    expect(reads, "one WorkOS read for the unknown org, one for the unknown member").toEqual([
      org,
      userId,
    ]);
    expect(result.outcome).toBe("applied");
    expect(result.organization?.name).toBe("Dashboard Org");
    expect(result.membership?.membershipId).toBe(`om_${userId}_${org}`);
  });

  it("reads the member's profile from WorkOS when the mirror holds none, never when it does, and mirrors a member WorkOS no longer has bare", async () => {
    const org = freshId("org");
    const joiner = freshId("user");
    const known = freshId("user");
    const gone = freshId("user");
    const reads: string[] = [];
    const result = await run(
      Effect.gen(function* () {
        yield* seedOrganization(org);
        // `known` signed in before: the stream's own `user.created` for them
        // is behind the replay boundary, but the mirror holds their profile.
        yield* applyEvent(
          userEvent("user.created", workosUser(known, { firstName: "Known", updatedAt: T1 })),
        );
        const knownJoins = yield* applyEvent(
          membershipEvent("organization_membership.created", workosMembership(known, org)),
        );
        const knownRow = yield* readMembership(known, org);
        // `joiner` predates the mirror: no row, no profile event in the
        // stream, the org already scanned. The membership event alone
        // would leave them nameless.
        const joins = yield* applyEvent(
          membershipEvent("organization_membership.created", workosMembership(joiner, org)),
        );
        const joinerRow = yield* readMembership(joiner, org);
        // A later role change for the now-profiled member reads nothing.
        const promoted = yield* applyEvent(
          membershipEvent(
            "organization_membership.updated",
            workosMembership(joiner, org, { role: { slug: "admin" }, updatedAt: T2 }),
          ),
        );
        // A member WorkOS no longer has (their `user.deleted` is further down
        // the stream): mirrored without a profile, the run goes on.
        const goneJoins = yield* applyEvent(
          membershipEvent("organization_membership.created", workosMembership(gone, org)),
        );
        const goneRow = yield* readMembership(gone, org);
        return { knownJoins, knownRow, joins, joinerRow, promoted, goneJoins, goneRow };
      }),
      stubWorkOS({
        getUser: (userId) =>
          Effect.suspend(() => {
            reads.push(userId);
            return userId === gone
              ? Effect.fail(new WorkOSError({ status: 404 }))
              : Effect.succeed(workosUser(userId, { firstName: "Fetched" }));
          }),
      }),
    );
    expect(result.knownJoins).toBe("applied");
    expect(result.knownRow?.name, "a profiled member keeps the profile the mirror holds").toBe(
      "Known Placeholder",
    );
    expect(result.joins).toBe("applied");
    expect(result.joinerRow?.name, "an unprofiled member is mirrored WITH the profile").toBe(
      "Fetched Placeholder",
    );
    expect(result.joinerRow?.email).toBe(`${joiner}@placeholder.test`);
    expect(result.promoted).toBe("applied");
    expect(result.goneJoins, "a member WorkOS no longer has is still mirrored").toBe("applied");
    expect(result.goneRow).toMatchObject({ membershipId: `om_${gone}_${org}`, name: null });
    expect(reads, "one read per unprofiled member, none for a profiled one").toEqual([
      joiner,
      gone,
    ]);

    // A transient failure reading the profile fails the run (the event is
    // retried), exactly as for the organization read.
    const blip = await Effect.runPromiseExit(
      Effect.exit(
        planEvent(
          membershipEvent(
            "organization_membership.created",
            workosMembership(freshId("user"), org),
          ),
        ),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            MirrorServices,
            stubWorkOS({ getUser: () => Effect.fail(new WorkOSError({ status: 503 })) }),
          ),
        ),
        Effect.scoped,
      ),
    );
    expect(Exit.isSuccess(blip) && Exit.isFailure(blip.value), "a 5xx keeps the event").toBe(true);
  });

  it("marks the organization deleted for a membership whose organization WorkOS no longer has, but fails on a transient WorkOS failure", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const event = membershipEvent(
      "organization_membership.created",
      workosMembership(userId, org, { organizationName: "Gone Org" }),
      freshId("event"),
      T2,
    );
    const gone = await run(
      Effect.gen(function* () {
        const outcome = yield* applyEvent(event);
        const organization = yield* readOrganization(org);
        const membership = yield* readMembership(userId, org);
        // The org's own deletion event, further down the stream, finds the
        // mark already there.
        const deleted = yield* applyEvent(
          organizationEvent(
            "organization.deleted",
            workosOrganization(org, "Gone Org"),
            freshId("event"),
            T3,
          ),
        );
        return { outcome, organization, membership, deleted };
      }),
      stubWorkOS({
        getOrganization: () => Effect.fail(new WorkOSError({ status: 404 })),
      }),
    );
    expect(
      gone.outcome,
      "an org WorkOS has deleted marks the org deleted, not a failed run and not a dropped event",
    ).toBe("applied");
    expect(gone.organization, "a tombstone row is minted for it").toMatchObject({
      name: "Gone Org",
      deletedAt: new Date(T2),
    });
    expect(gone.membership, "and the membership is not written").toBeNull();
    expect(gone.deleted, "its own deletion event finds the mark").toBe("absent");

    // A transient failure resolving an org the mirror does not hold (the
    // tombstone above would answer the read locally).
    const unresolved = membershipEvent(
      "organization_membership.created",
      workosMembership(userId, freshId("org")),
    );
    const blip = await Effect.runPromiseExit(
      Effect.exit(planEvent(unresolved)).pipe(
        Effect.provide(
          Layer.mergeAll(
            MirrorServices,
            stubWorkOS({
              getOrganization: () => Effect.fail(new WorkOSError({ status: 503 })),
            }),
          ),
        ),
        Effect.scoped,
      ),
    );
    const unreachable = await Effect.runPromiseExit(
      Effect.exit(planEvent(unresolved)).pipe(
        Effect.provide(
          Layer.mergeAll(
            MirrorServices,
            stubWorkOS({
              getOrganization: () => Effect.fail(new WorkOSError({})),
            }),
          ),
        ),
        Effect.scoped,
      ),
    );
    expect(
      Exit.isSuccess(blip) && Exit.isFailure(blip.value),
      "a 5xx keeps the event for retry",
    ).toBe(true);
    expect(
      Exit.isSuccess(unreachable) && Exit.isFailure(unreachable.value),
      "a network failure keeps the event for retry",
    ).toBe(true);
  });

  it("does not create an organization row from organization.updated for an org the mirror has never seen", async () => {
    const org = freshId("org");
    const result = await run(
      Effect.gen(function* () {
        const outcome = yield* applyEvent(
          organizationEvent("organization.updated", workosOrganization(org, "Purged Org")),
        );
        const organization = yield* readOrganization(org);
        return { outcome, organization };
      }),
    );
    expect(result.outcome, "a rename of an unmirrored org is reported absent").toBe("absent");
    expect(
      result.organization,
      "and mints no row (no resurrection after cloud's purge)",
    ).toBeNull();
  });

  it("mints a tombstone on organization.deleted for an org the mirror has never seen, so a delayed login cannot create it", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const result = await run(
      Effect.gen(function* () {
        // The org was created, populated, and deleted in the WorkOS
        // dashboard before anyone signed in: the mirror has no row for it.
        const deleted = yield* applyEvent(
          organizationEvent(
            "organization.deleted",
            workosOrganization(org, "Never Mirrored"),
            freshId("event"),
            T2,
          ),
        );
        const tombstone = yield* readOrganization(org);
        // A login that fetched its membership list at T1, before the
        // deletion, and stalled past it now writes what it holds.
        yield* mirrorSignIn(
          workosUser(userId),
          [workosMembership(userId, org, { organizationName: "Never Mirrored" })],
          new Date(T1),
        );
        const afterLogin = yield* readOrganization(org);
        const membership = yield* readMembership(userId, org, ["active", "pending", "inactive"]);
        const replayed = yield* applyEvent(
          organizationEvent(
            "organization.deleted",
            workosOrganization(org, "Never Mirrored"),
            freshId("event"),
            T3,
          ),
        );
        return { deleted, tombstone, afterLogin, membership, replayed };
      }),
    );
    expect(result.deleted, "the deletion is applied, not dropped for want of a row").toBe(
      "applied",
    );
    expect(result.tombstone).toMatchObject({
      name: "Never Mirrored",
      deletedAt: new Date(T2),
    });
    expect(result.tombstone?.slug, "the tombstone is a slugged row like any other").toMatch(
      /^never-mirrored/,
    );
    expect(result.afterLogin?.deletedAt, "the delayed login does not revive the org").toEqual(
      new Date(T2),
    );
    expect(result.membership, "nor write the membership").toBeNull();
    expect(result.replayed, "a replayed deletion changes nothing").toBe("absent");
  });

  it("renames the organization on organization.updated, refuses an older rename, and marks it deleted on organization.deleted, purging nothing", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const result = await run(
      Effect.gen(function* () {
        const seeded = yield* seedOrganization(org);
        yield* applyEvent(
          membershipEvent("organization_membership.created", workosMembership(userId, org)),
        );
        const renamed = yield* applyEvent(
          organizationEvent("organization.updated", workosOrganization(org, "Renamed Org", T2)),
        );
        const afterRename = yield* readOrganization(org);
        // A rename event older than the name the row holds (replayed, or
        // behind a sign-in that already carried the newer name).
        const olderRename = yield* applyEvent(
          organizationEvent("organization.updated", workosOrganization(org, "Older Name", T1)),
        );
        const afterOlderRename = yield* readOrganization(org);
        const deleted = yield* applyEvent(
          organizationEvent(
            "organization.deleted",
            workosOrganization(org, "Renamed Org"),
            freshId("event"),
            T2,
          ),
        );
        const orgAfterDelete = yield* readOrganization(org);
        const membershipAfterDelete = yield* readMembership(userId, org);
        const deletedAgain = yield* applyEvent(
          organizationEvent(
            "organization.deleted",
            workosOrganization(org, "Renamed Org"),
            freshId("event"),
            T3,
          ),
        );
        const renamedAfterDelete = yield* applyEvent(
          organizationEvent("organization.updated", workosOrganization(org, "Late Rename", T3)),
        );
        const orgAfterReplay = yield* readOrganization(org);
        return {
          seeded,
          renamed,
          afterRename,
          olderRename,
          afterOlderRename,
          deleted,
          orgAfterDelete,
          membershipAfterDelete,
          deletedAgain,
          renamedAfterDelete,
          orgAfterReplay,
        };
      }),
      stubWorkOS(profiles()),
    );
    expect(result.renamed).toBe("applied");
    expect(result.afterRename?.name).toBe("Renamed Org");
    expect(result.afterRename?.slug, "the slug is stable across renames").toBe(result.seeded.slug);
    expect(result.olderRename, "an older rename is refused").toBe("stale");
    expect(result.afterOlderRename?.name).toBe("Renamed Org");
    expect(result.deleted, "organization.deleted marks the org").toBe("applied");
    expect(result.orgAfterDelete?.deletedAt, "as of the event").toEqual(new Date(T2));
    expect(result.orgAfterDelete?.name, "the row is kept, not purged").toBe("Renamed Org");
    expect(result.membershipAfterDelete, "and so is the membership row").not.toBeNull();
    expect(result.deletedAgain, "a replayed deletion changes nothing").toBe("absent");
    expect(result.renamedAfterDelete, "a deleted org is never renamed").toBe("absent");
    expect(result.orgAfterReplay?.deletedAt, "the first mark stands").toEqual(new Date(T2));
    expect(result.orgAfterReplay?.name).toBe("Renamed Org");
  });
});

describe("syncWorkOsEvents", () => {
  /** Pin the instance-wide cursor to a fresh known value, whatever it was. */
  const pinCursor = (value: string) =>
    Effect.gen(function* () {
      const mirror = yield* WorkOsMirror;
      const before = yield* mirror.getCursor();
      const moved = yield* mirror.applyPage(before, value, []);
      expect(Option.isSome(moved)).toBe(true);
      return value;
    });

  type Page = {
    readonly data: readonly WorkOsMirroredEvent[];
    readonly after: string | null;
  };

  /**
   * A fake Events API serving `pages` in order, recording every request's
   * paging options; `onPage` runs before the nth page is returned (the CAS
   * contention test moves the cursor from there). `methods` adds any other
   * WorkOS call the run under test is allowed to make.
   */
  const eventsApi = (
    pages: readonly Page[],
    requests: WorkOSListEventsOptions[],
    onPage: (index: number) => Effect.Effect<void, unknown, WorkOsMirror> = () => Effect.void,
    methods: Partial<WorkOSClientService> = {},
  ) =>
    Effect.map(WorkOsMirror.asEffect(), (mirror) =>
      stubWorkOS({
        ...methods,
        listEvents: (options) =>
          Effect.gen(function* () {
            const index = requests.length;
            requests.push(options);
            yield* onPage(index).pipe(Effect.provideService(WorkOsMirror, mirror), Effect.orDie);
            const page = pages[index] ?? { data: [], after: null };
            return {
              object: "list" as const,
              data: [...page.data],
              listMetadata: { before: null, after: page.after },
            };
          }),
      }),
    );

  const sync = (
    workos: Layer.Layer<WorkOSClient>,
  ): Effect.Effect<WorkOsEventsSyncReport, unknown, Services> =>
    syncWorkOsEvents().pipe(Effect.provide(workos));

  it("pages from the persisted cursor, applies every event, and commits the last id of each page", async () => {
    const org = freshId("org");
    const a = freshId("user");
    const b = freshId("user");
    const requests: WorkOSListEventsOptions[] = [];
    const profileReads: string[] = [];
    const result = await run(
      Effect.gen(function* () {
        yield* seedOrganization(org);
        const start = yield* pinCursor(freshId("event"));
        const startedAt = Date.now();
        const pages: Page[] = [
          {
            data: [
              userEvent("user.created", workosUser(a), `${start}_1`),
              membershipEvent(
                "organization_membership.created",
                workosMembership(a, org),
                `${start}_2`,
              ),
            ],
            after: `${start}_2`,
          },
          {
            data: [
              membershipEvent(
                "organization_membership.created",
                workosMembership(b, org),
                `${start}_3`,
              ),
              organizationEvent(
                "organization.deleted",
                workosOrganization(org, "Gone"),
                `${start}_4`,
              ),
            ],
            after: null,
          },
        ];
        const workos = yield* eventsApi(pages, requests, () => Effect.void, profiles(profileReads));
        const report = yield* sync(workos);
        const mirror = yield* WorkOsMirror;
        const cursor = yield* mirror.getCursor();
        const members = yield* Effect.flatMap(MemberDirectory.asEffect(), (d) => d.members(org));
        const drainedAt = yield* mirror.drainedAt();
        return { start, startedAt, report, cursor, members, drainedAt };
      }),
    );
    expect(requests.map((r) => r.after)).toEqual([result.start, `${result.start}_2`]);
    expect(requests[0]).toMatchObject({ order: "asc", limit: 100 });
    expect(requests[0]?.rangeStart, "a run with a cursor never sends rangeStart").toBeUndefined();
    expect(result.report).toMatchObject({
      pages: 2,
      events: 4,
      applied: 4,
      stopped: "drained",
      cursor: `${result.start}_4`,
    });
    expect(result.cursor).toBe(`${result.start}_4`);
    expect(result.members.map((m) => m.accountId).sort()).toEqual([a, b].sort());
    expect(
      profileReads,
      "only the member whose profile the stream did not carry is read from WorkOS",
    ).toEqual([b]);
    expect(
      result.drainedAt,
      "a run that reads the stream to its end records the drain",
    ).not.toBeNull();
    expect(
      result.drainedAt!.getTime(),
      "as of the run's start, so it never post-dates an event the run did not see",
    ).toBeGreaterThanOrEqual(result.startedAt - 1000);
    expect(result.drainedAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  /** The sync row is instance-wide: clear it so the run under test is a first run. */
  const clearSyncRow = Effect.flatMap(DbService.asEffect(), ({ db }) =>
    Effect.promise(() => db.execute(sql`delete from workos_sync where id = 'events'`)),
  );

  it("starts from the backfill's replay boundary when no cursor exists", async () => {
    const requests: WorkOSListEventsOptions[] = [];
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        yield* clearSyncRow;
        yield* mirror.setReplayBoundary(new Date(T2));
        const start = freshId("event");
        const workos = yield* eventsApi(
          [
            {
              data: [userEvent("user.created", workosUser(freshId("user")), start)],
              after: null,
            },
          ],
          requests,
        );
        const report = yield* sync(workos);
        const cursor = yield* mirror.getCursor();
        return { report, cursor, start };
      }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.after).toBeUndefined();
    expect(
      requests[0]?.rangeStart,
      "the first read starts exactly where the backfill began reading WorkOS",
    ).toBe(T2);
    expect(result.report.stopped).toBe("drained");
    expect(result.cursor, "the first run mints the cursor").toBe(result.start);
  });

  it("reads nothing while neither a cursor nor a replay boundary exists", async () => {
    const requests: WorkOSListEventsOptions[] = [];
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        yield* clearSyncRow;
        const workos = yield* eventsApi(
          [
            {
              data: [userEvent("user.created", workosUser(freshId("user")))],
              after: null,
            },
          ],
          requests,
        );
        const report = yield* sync(workos);
        const cursor = yield* mirror.getCursor();
        const drainedAt = yield* mirror.drainedAt();
        return { report, cursor, drainedAt };
      }),
    );
    expect(requests, "no wall-clock guess is ever sent to WorkOS").toHaveLength(0);
    expect(result.report).toMatchObject({
      pages: 0,
      events: 0,
      stopped: "awaiting_backfill",
    });
    expect(result.cursor, "and no cursor is minted").toBeNull();
    expect(result.drainedAt, "nor is a drain recorded: nothing was read").toBeNull();
  });

  it("stops when another run moves the cursor under it, writing nothing from the contended page", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const requests: WorkOSListEventsOptions[] = [];
    const result = await run(
      Effect.gen(function* () {
        yield* seedOrganization(org);
        const mirror = yield* WorkOsMirror;
        const start = yield* pinCursor(freshId("event"));
        const intruder = `${start}_intruder`;
        // This run's page carries a membership update that the leading run
        // has already applied AND deleted (the member was revoked). If the
        // lagging run's page landed, the revoked member would be back.
        const pages: Page[] = [
          {
            data: [
              membershipEvent(
                "organization_membership.updated",
                workosMembership(userId, org, { role: { slug: "admin" } }),
                `${start}_1`,
              ),
            ],
            after: `${start}_1`,
          },
          {
            data: [userEvent("user.created", workosUser(freshId("user")), `${start}_2`)],
            after: null,
          },
        ];
        // While this run is reading its first page, "another run" applies the
        // same page, then the membership's deletion, and commits both.
        const workos = yield* eventsApi(
          pages,
          requests,
          (index) =>
            index === 0
              ? Effect.gen(function* () {
                  const leading = yield* WorkOsMirror;
                  yield* leading.applyPage(start, `${start}_1`, [
                    WorkOsMirrorWrite.UpsertMembership({
                      membership: mirrorMembershipFromWorkOs(workosMembership(userId, org)),
                    }),
                  ]);
                  yield* leading.applyPage(`${start}_1`, intruder, [
                    WorkOsMirrorWrite.DeleteMembership({
                      membership: {
                        id: `om_${userId}_${org}`,
                        accountId: userId,
                        organizationId: org,
                      },
                      deletedAt: new Date(T2),
                    }),
                  ]);
                })
              : Effect.void,
          profiles(),
        );
        const drainedBefore = yield* mirror.drainedAt();
        const report = yield* sync(workos);
        const cursor = yield* mirror.getCursor();
        const membership = yield* readMembership(userId, org);
        const drainedAfter = yield* mirror.drainedAt();
        return { report, cursor, intruder, membership, drainedBefore, drainedAfter };
      }),
    );
    expect(requests, "the second page is never read").toHaveLength(1);
    expect(result.report).toMatchObject({
      pages: 1,
      events: 1,
      applied: 0,
      stopped: "cursor_contended",
    });
    expect(result.cursor, "the other run's cursor stands").toBe(result.intruder);
    expect(result.membership, "the revoked membership is not resurrected").toBeNull();
    expect(
      result.drainedAfter,
      "a run that yielded the stream drained nothing and records no drain",
    ).toEqual(result.drainedBefore);
  });

  it("advances the cursor past a membership event whose organization WorkOS no longer has, marking the org deleted", async () => {
    const org = freshId("org");
    const userId = freshId("user");
    const requests: WorkOSListEventsOptions[] = [];
    const result = await run(
      Effect.gen(function* () {
        const start = yield* pinCursor(freshId("event"));
        const workos = yield* eventsApi(
          [
            {
              data: [
                membershipEvent(
                  "organization_membership.created",
                  workosMembership(userId, org),
                  `${start}_1`,
                ),
                organizationEvent(
                  "organization.deleted",
                  workosOrganization(org, "Gone"),
                  `${start}_2`,
                ),
              ],
              after: null,
            },
          ],
          requests,
          () => Effect.void,
          {
            getOrganization: () => Effect.fail(new WorkOSError({ status: 404 })),
          },
        );
        const report = yield* sync(workos);
        const mirror = yield* WorkOsMirror;
        const cursor = yield* mirror.getCursor();
        const organization = yield* readOrganization(org);
        return { start, report, cursor, organization };
      }),
    );
    expect(result.report).toMatchObject({
      pages: 1,
      events: 2,
      applied: 1,
      absent: 1,
      stopped: "drained",
      cursor: `${result.start}_2`,
    });
    expect(result.cursor, "the stream is not stalled on the gone org").toBe(`${result.start}_2`);
    expect(result.organization?.deletedAt, "the org is left as a tombstone").not.toBeNull();
  });
});

describe("workos webhook", () => {
  const SECRET = "whsec_placeholder_signing_secret";

  const handlerFor = (deps: {
    readonly secret: string | undefined;
    readonly detached: Promise<void>[];
    readonly synced: number[];
  }) =>
    HttpRouter.toWebHandler(
      makeWorkOsWebhookRoute({
        secret: deps.secret,
        detach: (work) => {
          deps.detached.push(work);
        },
        sync: () => {
          deps.synced.push(1);
          return Promise.resolve();
        },
      }).pipe(
        // The REAL client: its `webhooks.constructEvent` is the signature check
        // under test. The api key / client id it reads are the vitest env's.
        Layer.provideMerge(WorkOSClient.Default),
        Layer.provideMerge(HttpServer.layerServices),
      ),
      { disableLogger: true },
    ).handler;

  const delivery = {
    id: "event_placeholder",
    event: "user.created",
    created_at: T1,
    context: {},
    data: {
      object: "user",
      id: "user_placeholder",
      email: "member@placeholder.test",
      email_verified: true,
      first_name: "Ada",
      last_name: "Placeholder",
      profile_picture_url: null,
      last_sign_in_at: T1,
      locale: null,
      created_at: T1,
      updated_at: T1,
      external_id: null,
      metadata: {},
    },
  };

  /** The `WorkOS-Signature` header WorkOS sends: `t=<ms>, v1=<hmac-sha256 hex>`. */
  const signature = (body: string, secret: string, timestamp = Date.now()) =>
    `t=${timestamp}, v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

  const post = (body: string, headers: Record<string, string>) =>
    new Request(`http://test.local${WORKOS_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  const deps = (secret: string | undefined) => ({
    secret,
    detached: [] as Promise<void>[],
    synced: [] as number[],
  });

  it("accepts a genuinely signed delivery and pokes the reconciler past the response", async () => {
    const d = deps(SECRET);
    const body = JSON.stringify(delivery);
    const response = await handlerFor(d)(
      post(body, { "workos-signature": signature(body, SECRET) }),
    );
    expect(response.status).toBe(200);
    expect(d.synced, "one reconciler pass").toHaveLength(1);
    expect(d.detached, "handed to the platform, not awaited in the response").toHaveLength(1);
  });

  it("rejects a delivery signed with another secret, a tampered body, and a missing header", async () => {
    const d = deps(SECRET);
    const handler = handlerFor(d);
    const body = JSON.stringify(delivery);

    const wrongSecret = await handler(
      post(body, { "workos-signature": signature(body, "whsec_other") }),
    );
    const tampered = await handler(
      post(body.replace("user_placeholder", "user_tampered"), {
        "workos-signature": signature(body, SECRET),
      }),
    );
    const unsigned = await handler(post(body, {}));
    const notJson = await handler(
      post("not json", { "workos-signature": signature("not json", SECRET) }),
    );
    const expired = await handler(
      post(body, {
        "workos-signature": signature(body, SECRET, Date.now() - 10 * 60 * 1000),
      }),
    );

    expect([
      wrongSecret.status,
      tampered.status,
      unsigned.status,
      notJson.status,
      expired.status,
    ]).toEqual([400, 400, 400, 400, 400]);
    expect(d.synced, "nothing is poked").toEqual([]);
  });

  it("refuses every delivery while no signing secret is configured", async () => {
    const d = deps(undefined);
    const body = JSON.stringify(delivery);
    const response = await handlerFor(d)(
      post(body, { "workos-signature": signature(body, SECRET) }),
    );
    expect(response.status).toBe(503);
    expect(d.synced).toEqual([]);
  });
});
