// ---------------------------------------------------------------------------
// The cloud membership mirror: `WorkOsMirror` (writes) + the cloud
// `MemberDirectory` (reads), against the real PGlite Postgres every cloud
// unit test runs on (scripts/test-globalsetup.ts), through the same
// `DbService.Live` the request path uses.
//
// What this pins:
//   - an older WorkOS payload never overwrites a newer row (replay-safe)
//   - a delete tombstones the row (inactive, `deleted_at` set) by IDENTITY:
//     no payload naming the deleted membership id ever reactivates it,
//     however it is stamped — not a stale one, not one stamped after the
//     removal — while a replacement under a NEW id takes the row over live;
//     every default read treats the tombstone as no membership
//   - a membership WorkOS merely deactivated (inactive, no `deleted_at`)
//     reactivates under the same id like any other update
//   - a delete of a membership or user the mirror has not seen yet leaves
//     the tombstone behind, so the backfill's older payload cannot insert
//     the row live afterwards
//   - a delete of a membership id the row does NOT hold (the member's row
//     still carries the id it was replaced from) is recorded all the same,
//     so a later, newer payload of the deleted id cannot take the row over
//   - a deleted user takes no membership at all, however the payload is
//     stamped: the account tombstone refuses the insert by identity — and a
//     membership write racing the deletion waits for its commit and sees
//     the tombstone, never inserting a live membership for a deleted user
//   - a delete with no WorkOS instant keeps the row's own WorkOS stamp, so
//     a replacement membership WorkOS created meanwhile is not refused,
//     while the removed membership's own payload still is
//   - the cursor advances only by compare-and-set (one owner per stream),
//     and a page that loses the CAS writes nothing
//   - a backfill scan is applied only if its listing is newer than the one
//     already applied to the organization (one owner per listing instant),
//     so an older listing cannot insert a membership the newer one lacked;
//     a deleted organization takes no scan
//   - a membership payload stamped before the organization's last scan is
//     refused (a login list fetched before a revocation the scan already
//     applied cannot reinstate it); one stamped at or after it is written —
//     and a write racing a scan waits for the scan's commit and sees its
//     mark, so it cannot insert a membership the scan just proved revoked
//   - the events replay boundary is recorded once and never advanced
//   - `members` searches email AND name case-insensitively, pages stably
//   - `findByEmail` ignores the casing WorkOS stored
//   - `membershipById` is org-scoped: another org's id resolves to null
//   - a membership arriving before its user still holds (FK via ensureAccount)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { eq, sql } from "drizzle-orm";
import { Context, Deferred, Duration, Effect, Fiber, Layer, Option } from "effect";

import { MemberDirectory } from "@executor-js/api/server";

import { DbService, makeDbLayer } from "../db/db";
import { accounts, organizations } from "../db/schema";
import { cloudMemberDirectoryLayer } from "./member-directory";
import { UserStoreService } from "./context";
import {
  WorkOsMirror,
  WorkOsMirrorWrite,
  type WorkOsMirrorMembership,
  type WorkOsMirrorUser,
} from "./workos-mirror";
import { makeWorkOsMirrorStore } from "./workos-mirror-store";
import {
  MIRROR_RECONCILER_LAG_BUDGET,
  MirrorReadinessState,
  mirrorReadinessFrom,
  readMirrorReadiness,
} from "./mirror-readiness-store";

const DbLive = DbService.Live;
const Services = Layer.mergeAll(
  WorkOsMirror.Live,
  cloudMemberDirectoryLayer,
  UserStoreService.Live,
).pipe(Layer.provideMerge(DbLive));

const run = <A, E>(
  body: Effect.Effect<A, E, WorkOsMirror | MemberDirectory | UserStoreService | DbService>,
) => Effect.runPromise(body.pipe(Effect.provide(Services), Effect.scoped));

/** The events row is instance-wide: drop it so a test starts as a never-backfilled database. */
const clearEventsRow = Effect.flatMap(DbService.asEffect(), ({ db }) =>
  Effect.promise(() => db.execute(sql`delete from workos_sync where id = 'events'`)),
);

const at = (iso: string) => new Date(iso);
const T1 = at("2026-01-01T00:00:00.000Z");
const T2 = at("2026-01-02T00:00:00.000Z");
const T3 = at("2026-01-03T00:00:00.000Z");
const T4 = at("2026-01-04T00:00:00.000Z");

// Every test mints its own org so the shared test database never couples
// them; ids are synthetic placeholders, never real identities.
const freshOrg = () =>
  Effect.gen(function* () {
    const id = `org_${crypto.randomUUID().replaceAll("-", "")}`;
    const store = yield* UserStoreService;
    yield* store.use("upsertOrganization", (s) =>
      s.upsertOrganization({ id, name: "Mirror Org", updatedAt: T1 }),
    );
    return id;
  });

const user = (id: string, overrides: Partial<WorkOsMirrorUser> = {}): WorkOsMirrorUser => ({
  id,
  email: `${id}@placeholder.test`,
  firstName: null,
  lastName: null,
  avatarUrl: null,
  lastSignInAt: null,
  updatedAt: T1,
  ...overrides,
});

const membership = (
  organizationId: string,
  accountId: string,
  overrides: Partial<WorkOsMirrorMembership> = {},
): WorkOsMirrorMembership => ({
  id: `om_${accountId}_${organizationId}`,
  accountId,
  organizationId,
  role: "member",
  status: "active",
  updatedAt: T1,
  ...overrides,
});

describe("WorkOsMirror upserts", () => {
  it("ignores a user payload older than the stored row, accepts a newer one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        yield* mirror.upsertMembership(membership(org, id));

        const first = yield* mirror.upsertUser(user(id, { firstName: "Ada", updatedAt: T2 }));
        const stale = yield* mirror.upsertUser(user(id, { firstName: "Stale", updatedAt: T1 }));
        const afterStale = yield* directory.membership(id, org);
        const newer = yield* mirror.upsertUser(user(id, { firstName: "Newer", updatedAt: T3 }));
        const afterNewer = yield* directory.membership(id, org);
        return { first, stale, newer, afterStale, afterNewer };
      }),
    );
    expect(result.first).toBe(true);
    expect(result.stale, "an older payload is reported as not written").toBe(false);
    expect(result.afterStale?.name, "and left the newer row untouched").toBe("Ada");
    expect(result.newer).toBe(true);
    expect(result.afterNewer?.name).toBe("Newer");
  });

  it("ignores a membership payload older than the stored row", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        yield* mirror.upsertUser(user(id));
        yield* mirror.upsertMembership(membership(org, id, { role: "admin", updatedAt: T2 }));
        const stale = yield* mirror.upsertMembership(
          membership(org, id, {
            role: "member",
            status: "inactive",
            updatedAt: T1,
          }),
        );
        const row = yield* directory.membership(id, org);
        const equal = yield* mirror.upsertMembership(
          membership(org, id, { role: "member", updatedAt: T2 }),
        );
        const afterEqual = yield* directory.membership(id, org);
        return { stale, row, equal, afterEqual };
      }),
    );
    expect(result.stale).toBe(false);
    expect(result.row?.role).toBe("admin");
    expect(result.row?.status).toBe("active");
    // Equal timestamps are accepted: the feeders replay the same payload and
    // must converge, not stall.
    expect(result.equal).toBe(true);
    expect(result.afterEqual?.role).toBe("member");
  });

  it("mints the account row when a membership arrives before its user", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        const written = yield* mirror.upsertMembership(membership(org, id));
        const bare = yield* directory.membership(id, org);
        // The bare row has no timestamp, so the first user payload — even an
        // "old" one — fills it.
        yield* mirror.upsertUser(user(id, { firstName: "Late", updatedAt: T1 }));
        const filled = yield* directory.membership(id, org);
        return { written, bare, filled };
      }),
    );
    expect(result.written).toBe(true);
    expect(result.bare).not.toBeNull();
    expect(result.bare?.email).toBeNull();
    expect(result.filled?.name).toBe("Late");
  });

  it("tombstones a deleted membership by identity: no payload of that id resurrects it, a replacement under a new id does", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        const membershipId = `om_${id}_${org}`;
        yield* mirror.upsertUser(user(id));
        yield* mirror.upsertMembership(membership(org, id, { id: membershipId, updatedAt: T1 }));

        const ref = { id: membershipId, accountId: id, organizationId: org };
        const removed = yield* mirror.deleteMembership(ref, T2);
        const removedAgain = yield* mirror.deleteMembership(ref, T2);
        const byDefault = yield* directory.membership(id, org);
        const listed = yield* directory.members(org);
        const asInactive = yield* directory.membership(id, org, ["inactive"]);

        // A feeder that fetched the membership BEFORE the deletion (login,
        // backfill) writes it after: the guard refuses it.
        const stale = yield* mirror.upsertMembership(
          membership(org, id, { id: membershipId, updatedAt: T1 }),
        );
        const afterStale = yield* directory.membership(id, org, ["inactive"]);
        // An active payload stamped the SAME instant as the deletion: the
        // tombstone wins, a deletion at T is never undone by a payload at T.
        const equal = yield* mirror.upsertMembership(
          membership(org, id, { id: membershipId, updatedAt: T2 }),
        );
        const afterEqual = yield* directory.membership(id, org, ["inactive"]);
        // A role change issued before the removal and delivered after it (a
        // stalled login list, a lagging feeder), stamped NEWER than anything
        // the row holds — the payload a timestamp guard would let through.
        // Same id: the membership is deleted, it never returns.
        const newerSameId = yield* mirror.upsertMembership(
          membership(org, id, {
            id: membershipId,
            role: "admin",
            updatedAt: T3,
          }),
        );
        const afterNewerSameId = yield* directory.membership(id, org, ["inactive"]);
        // The member re-added in WorkOS: a payload newer than the deletion,
        // under a new membership id (a deleted id is never reused).
        const readded = yield* mirror.upsertMembership(
          membership(org, id, { id: `${membershipId}_2`, updatedAt: T3 }),
        );
        const afterReadd = yield* directory.membership(id, org);
        // The OLD membership's deletion, replayed after the re-add: the
        // newer row, under its new id, stands.
        const lateDelete = yield* mirror.deleteMembership(ref, T2);
        const afterLateDelete = yield* directory.membership(id, org);
        // The same deletion stamped AFTER the replacement (a removal Executor
        // made whose clock was read once WorkOS had answered, by which time
        // the member had been re-added): the row is another membership, so
        // the timestamp does not make it deletable.
        const lateDeleteNewerStamp = yield* mirror.deleteMembership(ref, T4);
        const afterLateDeleteNewerStamp = yield* directory.membership(id, org);
        return {
          removed,
          removedAgain,
          byDefault,
          listed,
          asInactive,
          stale,
          afterStale,
          equal,
          afterEqual,
          newerSameId,
          afterNewerSameId,
          readded,
          afterReadd,
          lateDelete,
          afterLateDelete,
          lateDeleteNewerStamp,
          afterLateDeleteNewerStamp,
        };
      }),
    );
    expect(result.removed).toBe(true);
    expect(result.removedAgain, "a replayed delete changes nothing").toBe(false);
    expect(result.byDefault, "a tombstone reads as no membership").toBeNull();
    expect(result.listed, "and is not listed").toEqual([]);
    expect(result.asInactive, "but is still there when asked for").toMatchObject({
      status: "inactive",
      lastActiveAt: null,
    });
    expect(result.stale, "an upsert older than the deletion is refused").toBe(false);
    expect(result.afterStale?.status).toBe("inactive");
    expect(result.equal, "an upsert stamped AT the deletion is refused too").toBe(false);
    expect(result.afterEqual?.status).toBe("inactive");
    expect(
      result.newerSameId,
      "a payload of the deleted id stamped AFTER the removal is refused: identity, not time",
    ).toBe(false);
    expect(result.afterNewerSameId).toMatchObject({
      status: "inactive",
      role: "member",
    });
    expect(result.readded, "a replacement under a new id reactivates").toBe(true);
    expect(result.afterReadd?.status).toBe("active");
    expect(result.lateDelete, "a replayed deletion of the OLD id is refused").toBe(false);
    expect(result.afterLateDelete?.status).toBe("active");
    expect(
      result.lateDeleteNewerStamp,
      "a deletion of the OLD id stamped after the replacement is refused too: identity, not time",
    ).toBe(false);
    expect(result.afterLateDeleteNewerStamp).toMatchObject({
      status: "active",
      membershipId: `om_${result.afterLateDeleteNewerStamp?.accountId}_${result.afterLateDeleteNewerStamp?.organizationId}_2`,
    });
  });

  it("keeps the row's own WorkOS stamp on a delete with no instant, so a replacement created meanwhile is accepted and the removed payload is not", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        const membershipId = `om_${id}_${org}`;
        const ref = { id: membershipId, accountId: id, organizationId: org };
        yield* mirror.upsertUser(user(id));
        yield* mirror.upsertMembership(membership(org, id, { id: membershipId, updatedAt: T1 }));

        // Executor removes the member holding no WorkOS instant for it, so
        // the tombstone keeps T1, the last state WorkOS reported for it —
        // never the local clock, which is long past T2 here.
        const removed = yield* mirror.deleteMembership(ref, null);
        const removedAgain = yield* mirror.deleteMembership(ref, null);
        const tombstone = yield* directory.membership(id, org, ["inactive"]);
        // A login that fetched the membership before the removal: refused.
        const stale = yield* mirror.upsertMembership(
          membership(org, id, { id: membershipId, updatedAt: T1 }),
        );
        // The member re-added in WorkOS while the removal was in flight,
        // under a new id and stamped before any local clock could have
        // stamped the tombstone: accepted.
        const replaced = yield* mirror.upsertMembership(
          membership(org, id, { id: `${membershipId}_2`, updatedAt: T2 }),
        );
        const afterReplace = yield* directory.membership(id, org);
        // A tombstone minted for a row the mirror never held has no stamp
        // to keep; it is still a tombstone.
        const other = `user_${crypto.randomUUID()}`;
        const minted = yield* mirror.deleteMembership(
          { id: `om_${other}_${org}`, accountId: other, organizationId: org },
          null,
        );
        const mintedRow = yield* directory.membership(other, org, ["inactive"]);
        return {
          membershipId,
          removed,
          removedAgain,
          tombstone,
          stale,
          replaced,
          afterReplace,
          minted,
          mintedRow,
        };
      }),
    );
    expect(result.removed).toBe(true);
    expect(result.removedAgain, "a repeated removal changes nothing").toBe(false);
    expect(result.tombstone?.status).toBe("inactive");
    expect(result.stale, "the pre-removal payload is refused").toBe(false);
    expect(result.replaced, "a replacement newer than the row's stamp is accepted").toBe(true);
    expect(result.afterReplace).toMatchObject({
      status: "active",
      membershipId: `${result.membershipId}_2`,
    });
    expect(result.minted, "a row the mirror never held is still tombstoned").toBe(true);
    expect(result.mintedRow?.status).toBe("inactive");
  });

  it("tombstones a membership the mirror has not seen, so a later older payload cannot insert it live", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        const membershipId = `om_${id}_${org}`;
        const readdedId = `${membershipId}_2`;
        const ref = { id: membershipId, accountId: id, organizationId: org };

        // The reconciler applies the deletion before the backfill has
        // inserted the row (the user is unknown too).
        const removed = yield* mirror.deleteMembership(ref, T2);
        const removedAgain = yield* mirror.deleteMembership(ref, T2);
        const tombstone = yield* directory.membership(id, org, ["inactive"]);
        // The backfill, listing WorkOS as it was before the deletion, now
        // writes the membership: refused, the tombstone stands.
        const backfilled = yield* mirror.upsertMembership(
          membership(org, id, { id: membershipId, updatedAt: T1 }),
        );
        const afterBackfill = yield* directory.membership(id, org);
        // The user payload still fills the bare account row the tombstone
        // minted, so the inactive row reads with its profile.
        yield* mirror.upsertUser(user(id, { firstName: "Late", updatedAt: T1 }));
        const profiled = yield* directory.membership(id, org, ["inactive"]);
        // Re-added in WorkOS later under a NEW membership id.
        const readded = yield* mirror.upsertMembership(
          membership(org, id, { id: readdedId, updatedAt: T3 }),
        );
        const afterReadd = yield* directory.membership(id, org);
        return {
          readdedId,
          removed,
          removedAgain,
          tombstone,
          backfilled,
          afterBackfill,
          profiled,
          readded,
          afterReadd,
        };
      }),
    );
    expect(result.removed, "the delete leaves a tombstone behind").toBe(true);
    expect(result.removedAgain).toBe(false);
    expect(result.tombstone).toMatchObject({ status: "inactive", email: null });
    expect(result.backfilled, "the pre-deletion payload is refused").toBe(false);
    expect(result.afterBackfill, "and the member is not live").toBeNull();
    expect(result.profiled?.name).toBe("Late");
    expect(result.readded).toBe(true);
    expect(result.afterReadd).toMatchObject({
      status: "active",
      membershipId: result.readdedId,
    });
  });

  it("records a delete whose id the row does not hold, so a newer payload of that id cannot take the row over", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        const membershipA = `om_${id}_${org}_a`;
        const membershipB = `om_${id}_${org}_b`;
        yield* mirror.upsertUser(user(id));
        // The mirror holds A (a stale listing). In WorkOS, A was already
        // replaced by B (stamped T2), and B is then deleted (T3) before any
        // feeder wrote B here.
        yield* mirror.upsertMembership(membership(org, id, { id: membershipA, updatedAt: T1 }));
        const refB = { id: membershipB, accountId: id, organizationId: org };
        const deletedB = yield* mirror.deleteMembership(refB, T3);
        const deletedBAgain = yield* mirror.deleteMembership(refB, T3);
        const rowAfterDelete = yield* directory.membership(id, org);
        // A delayed scan, listed before B's deletion, now writes B: stamped
        // after A and under another id, exactly what the row guard lets
        // through — the ledger refuses it.
        const lateB = yield* mirror.upsertMembership(
          membership(org, id, { id: membershipB, updatedAt: T2 }),
        );
        const afterLateB = yield* directory.membership(id, org);
        // A's own deletion, applied later, tombstones the row it holds.
        const deletedA = yield* mirror.deleteMembership(
          { id: membershipA, accountId: id, organizationId: org },
          T3,
        );
        const afterDeleteA = yield* directory.membership(id, org);
        // The member re-added in WorkOS under a third id: accepted.
        const readded = yield* mirror.upsertMembership(
          membership(org, id, { id: `${membershipB}_c`, updatedAt: T4 }),
        );
        const afterReadd = yield* directory.membership(id, org);
        return {
          deletedB,
          deletedBAgain,
          rowAfterDelete,
          lateB,
          afterLateB,
          deletedA,
          afterDeleteA,
          readded,
          afterReadd,
          membershipA,
        };
      }),
    );
    expect(result.deletedB, "the delete is recorded even though the row holds another id").toBe(
      true,
    );
    expect(result.deletedBAgain, "a replayed delete records nothing new").toBe(false);
    expect(
      result.rowAfterDelete?.membershipId,
      "the row under A is not B's to tombstone and stands",
    ).toBe(result.membershipA);
    expect(result.lateB, "the newer payload of the deleted id is refused: identity, not time").toBe(
      false,
    );
    expect(result.afterLateB?.membershipId).toBe(result.membershipA);
    expect(result.deletedA).toBe(true);
    expect(result.afterDeleteA, "A's deletion tombstones the row").toBeNull();
    expect(result.readded, "a replacement under a fresh id reactivates").toBe(true);
    expect(result.afterReadd?.status).toBe("active");
  });

  it("reactivates a membership WorkOS deactivated under the same id: a deactivation is not a deletion", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        const membershipId = `om_${id}_${org}`;
        yield* mirror.upsertUser(user(id));
        yield* mirror.upsertMembership(membership(org, id, { id: membershipId, updatedAt: T1 }));
        // WorkOS deactivates the membership (an `organization_membership.updated`
        // with status inactive): the row is inactive but still WorkOS's, with
        // no `deleted_at` to protect it.
        const deactivated = yield* mirror.upsertMembership(
          membership(org, id, {
            id: membershipId,
            status: "inactive",
            updatedAt: T2,
          }),
        );
        const whileInactive = yield* directory.membership(id, org);
        // A payload older than the deactivation cannot undo it, nor one
        // stamped at the same instant.
        const older = yield* mirror.upsertMembership(
          membership(org, id, { id: membershipId, updatedAt: T1 }),
        );
        const equal = yield* mirror.upsertMembership(
          membership(org, id, { id: membershipId, updatedAt: T2 }),
        );
        // WorkOS reactivates it, same id, newer stamp: live again.
        const reactivated = yield* mirror.upsertMembership(
          membership(org, id, {
            id: membershipId,
            role: "admin",
            updatedAt: T3,
          }),
        );
        const afterReactivate = yield* directory.membership(id, org);
        return {
          membershipId,
          deactivated,
          whileInactive,
          older,
          equal,
          reactivated,
          afterReactivate,
        };
      }),
    );
    expect(result.deactivated).toBe(true);
    expect(result.whileInactive, "an inactive membership reads as no membership").toBeNull();
    expect(result.older, "an older payload cannot undo the deactivation").toBe(false);
    expect(result.equal, "nor one stamped at the deactivation").toBe(false);
    expect(result.reactivated, "a newer payload under the same id reactivates it").toBe(true);
    expect(result.afterReactivate).toMatchObject({
      status: "active",
      role: "admin",
      membershipId: result.membershipId,
    });
  });

  it("tombstones every membership of a deleted user and clears the profile, keeping the account row", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const orgA = yield* freshOrg();
        const orgB = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        yield* mirror.upsertUser(user(id, { firstName: "Gone", updatedAt: T1 }));
        yield* mirror.upsertMembership(membership(orgA, id));
        yield* mirror.upsertMembership(membership(orgB, id));

        const deleted = yield* mirror.deleteUser(id, T2);
        const deletedAgain = yield* mirror.deleteUser(id, T2);
        const inA = yield* directory.membership(id, orgA);
        const inB = yield* directory.membership(id, orgB, ["inactive"]);
        // A stale user payload cannot restore the profile, nor can one
        // stamped at the deletion itself. No membership of the deleted user
        // is written again — not the deleted id (a deleted membership id
        // never returns), and not one stamped after the deletion under a
        // NEW id, the payload a timestamp guard would let through: the user
        // is gone, and WorkOS never reuses the id.
        const staleUser = yield* mirror.upsertUser(user(id, { firstName: "Back", updatedAt: T1 }));
        const equalUser = yield* mirror.upsertUser(user(id, { firstName: "Same", updatedAt: T2 }));
        const sameId = yield* mirror.upsertMembership(membership(orgA, id, { updatedAt: T3 }));
        const rejoined = yield* mirror.upsertMembership(
          membership(orgA, id, { id: `om_${id}_${orgA}_2`, updatedAt: T3 }),
        );
        const afterRejoin = yield* directory.membership(id, orgA, ["inactive"]);
        // A user the mirror has never seen: the delete mints the account
        // tombstone, the backfill's older profile cannot fill it afterwards,
        // and a membership of the user the mirror has never seen — no row
        // for the membership guard to judge — is refused by the account
        // tombstone alone, whatever it is stamped.
        const unseen = `user_${crypto.randomUUID()}`;
        const unknown = yield* mirror.deleteUser(unseen, T2);
        const unseenProfile = yield* mirror.upsertUser(
          user(unseen, { firstName: "Ghost", updatedAt: T1 }),
        );
        const unseenMembership = yield* mirror.upsertMembership(
          membership(orgA, unseen, { updatedAt: T3 }),
        );
        const unseenRow = yield* directory.membership(unseen, orgA, [
          "active",
          "pending",
          "inactive",
        ]);
        return {
          deleted,
          deletedAgain,
          inA,
          inB,
          staleUser,
          equalUser,
          sameId,
          rejoined,
          afterRejoin,
          unknown,
          unseenProfile,
          unseenMembership,
          unseenRow,
        };
      }),
    );
    expect(result.deleted).toBe(true);
    expect(result.deletedAgain, "a replayed delete changes nothing").toBe(false);
    expect(result.inA, "the user's memberships are tombstoned").toBeNull();
    expect(result.inB).toMatchObject({
      status: "inactive",
      email: null,
      name: null,
    });
    expect(result.staleUser).toBe(false);
    expect(result.equalUser, "a profile stamped AT the deletion is refused").toBe(false);
    expect(result.sameId, "a deleted membership id never returns").toBe(false);
    expect(
      result.rejoined,
      "a membership of a deleted user is refused however it is stamped: identity, not time",
    ).toBe(false);
    expect(result.afterRejoin).toMatchObject({
      status: "inactive",
      name: null,
    });
    expect(result.unknown, "deleting an unseen user leaves a tombstone").toBe(true);
    expect(result.unseenProfile, "which the older profile cannot fill").toBe(false);
    expect(
      result.unseenMembership,
      "and a membership the mirror never held is not inserted for the deleted user",
    ).toBe(false);
    expect(result.unseenRow).toBeNull();
  });

  it("waits for a user deletion holding the account row before judging a membership write against its tombstone", async () => {
    // A feeder (a stalled login list, the backfill's older listing) writes a
    // membership of a user whose `user.deleted` the reconciler is applying
    // at this moment. The deletion locks the account row for the length of
    // its transaction; the feeder's write must wait for that commit, see the
    // tombstone, and refuse the payload — never insert a live membership
    // for a deleted user. The deletion runs on the test's shared connection;
    // the feeder runs the same store over a second one, so the two
    // transactions are real peers on the server.
    const result = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const org = yield* freshOrg();
          const gone = `user_${crypto.randomUUID()}`;
          const mirror = yield* WorkOsMirror;
          const { db: deleterDb } = yield* DbService;
          // The second connection is owned by this test body's scope.
          const feederDb = Context.get(yield* Layer.build(makeDbLayer()), DbService).db;
          const feeder = makeWorkOsMirrorStore(feederDb);
          const directory = yield* MemberDirectory;
          yield* mirror.upsertUser(user(gone, { firstName: "Gone" }));

          // The deletion's transaction: the account row is locked as
          // `deleteUser` locks it, and the transaction is held open until
          // `release` — the window a feeder can race. The tombstone itself
          // is written after the feeder has started waiting.
          const locked = yield* Deferred.make<void>();
          let release: () => void = () => undefined;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const deletion = yield* Effect.forkChild(
            Effect.promise(() =>
              deleterDb.transaction(async (tx) => {
                await tx
                  .select({ id: accounts.id })
                  .from(accounts)
                  .where(eq(accounts.id, gone))
                  .for("no key update");
                await Effect.runPromise(Deferred.succeed(locked, undefined));
                await held;
                await makeWorkOsMirrorStore(tx).deleteUser(gone, T2).pipe(Effect.runPromise);
              }),
            ),
            { startImmediately: true },
          );
          yield* Deferred.await(locked);

          // The feeder's write starts while the deletion holds the row.
          const written = yield* Deferred.make<boolean>();
          yield* Effect.forkChild(
            feeder
              .upsertMembership(membership(org, gone, { updatedAt: T3 }))
              .pipe(Effect.flatMap((wrote) => Deferred.succeed(written, wrote))),
            { startImmediately: true },
          );
          const beforeCommit = yield* Effect.timeoutOption(Deferred.await(written), "250 millis");
          release();
          yield* Fiber.join(deletion);
          const afterCommit = yield* Deferred.await(written);
          const row = yield* directory.membership(gone, org, ["active", "pending", "inactive"]);
          return { beforeCommit, afterCommit, row };
        }),
      ),
    );
    expect(
      Option.isNone(result.beforeCommit),
      "the write waits while the deletion holds the account row",
    ).toBe(true);
    expect(
      result.afterCommit,
      "once the deletion has committed, its tombstone refuses the payload",
    ).toBe(false);
    expect(result.row, "so no membership was inserted for the deleted user").toBeNull();
  });

  it("waits for a membership deletion holding the account row before judging a write of that id against the ledger", async () => {
    // Same race for a single membership: a feeder writes membership `om`
    // while the reconciler is applying its `organization_membership.deleted`.
    // The delete locks the account row for its transaction, so the feeder's
    // FOR SHARE read waits, then finds the ledger entry and refuses. Without
    // the lock the feeder could pass the ledger check first and insert the
    // deleted membership live after the delete committed.
    const result = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const org = yield* freshOrg();
          const id = `user_${crypto.randomUUID()}`;
          const mirror = yield* WorkOsMirror;
          const { db: deleterDb } = yield* DbService;
          const feederDb = Context.get(yield* Layer.build(makeDbLayer()), DbService).db;
          const feeder = makeWorkOsMirrorStore(feederDb);
          const directory = yield* MemberDirectory;
          yield* mirror.upsertUser(user(id));
          const gone = membership(org, id, { updatedAt: T3 });

          const locked = yield* Deferred.make<void>();
          let release: () => void = () => undefined;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const deletion = yield* Effect.forkChild(
            Effect.promise(() =>
              deleterDb.transaction(async (tx) => {
                await tx
                  .select({ id: accounts.id })
                  .from(accounts)
                  .where(eq(accounts.id, id))
                  .for("no key update");
                await Effect.runPromise(Deferred.succeed(locked, undefined));
                await held;
                await makeWorkOsMirrorStore(tx).deleteMembership(gone, T2).pipe(Effect.runPromise);
              }),
            ),
            { startImmediately: true },
          );
          yield* Deferred.await(locked);

          const written = yield* Deferred.make<boolean>();
          yield* Effect.forkChild(
            feeder
              .upsertMembership(gone)
              .pipe(Effect.flatMap((wrote) => Deferred.succeed(written, wrote))),
            { startImmediately: true },
          );
          const beforeCommit = yield* Effect.timeoutOption(Deferred.await(written), "250 millis");
          release();
          yield* Fiber.join(deletion);
          const afterCommit = yield* Deferred.await(written);
          const row = yield* directory.membership(id, org, ["active", "pending", "inactive"]);
          return { beforeCommit, afterCommit, status: row?.status ?? null };
        }),
      ),
    );
    expect(
      Option.isNone(result.beforeCommit),
      "the write waits while the deletion holds the account row",
    ).toBe(true);
    expect(result.afterCommit, "once the deletion has committed, the ledger refuses the id").toBe(
      false,
    );
    expect(result.status, "and the row is the tombstone, never live").toBe("inactive");
  });
});

describe("WorkOsMirror cursor", () => {
  it("advances only by compare-and-set, and a page that loses the CAS writes nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        // The cursor is instance-wide; read whatever a previous test left so
        // this test's expectations are relative, not absolute.
        const before = yield* mirror.getCursor();
        const first = yield* mirror.applyPage(before, "event_1", []);
        const wrongPrev = yield* mirror.applyPage(before === null ? "event_0" : null, "event_x", [
          WorkOsMirrorWrite.UpsertUser({ user: user(id) }),
          WorkOsMirrorWrite.UpsertMembership({
            membership: membership(org, id),
          }),
        ]);
        const afterWrong = yield* mirror.getCursor();
        const notWritten = yield* directory.membership(id, org);
        const right = yield* mirror.applyPage("event_1", "event_2", [
          WorkOsMirrorWrite.UpsertUser({ user: user(id) }),
          WorkOsMirrorWrite.UpsertMembership({
            membership: membership(org, id),
          }),
          // A rename of an org the mirror has never seen: nothing to write.
          WorkOsMirrorWrite.RenameOrganization({
            organizationId: "org_nobody",
            name: "Nobody",
            updatedAt: T1,
          }),
        ]);
        const after = yield* mirror.getCursor();
        const written = yield* directory.membership(id, org);
        return {
          id,
          org,
          first,
          wrongPrev,
          afterWrong,
          notWritten,
          right,
          after,
          written,
        };
      }),
    );
    expect(Option.isSome(result.first)).toBe(true);
    expect(
      Option.isNone(result.wrongPrev),
      "a run holding a stale prev cannot move the cursor",
    ).toBe(true);
    expect(result.afterWrong).toBe("event_1");
    expect(result.notWritten, "and none of its page's writes land").toBeNull();
    expect(result.right).toEqual(Option.some(["applied", "applied", "absent"]));
    expect(result.after).toBe("event_2");
    expect(result.written?.membershipId).toBe(`om_${result.id}_${result.org}`);
  });
});

describe("mirror readiness", () => {
  const now = T4;
  const budget = Duration.toMillis(MIRROR_RECONCILER_LAG_BUDGET);
  const within = new Date(now.getTime() - budget);
  const tooOld = new Date(now.getTime() - budget - 1);

  it("is ready only when the backfill has completed AND the reconciler drained within the budget", () => {
    expect(mirrorReadinessFrom(null, now), "no events row: never backfilled").toEqual(
      MirrorReadinessState.BackfillPending(),
    );
    expect(mirrorReadinessFrom({ backfillCompletedAt: null, drainedAt: within }, now)).toEqual(
      MirrorReadinessState.BackfillPending(),
    );
    expect(
      mirrorReadinessFrom({ backfillCompletedAt: T1, drainedAt: null }, now),
      "backfilled but the reconciler has never drained",
    ).toEqual(MirrorReadinessState.ReconcilerStale({ drainedAt: null }));
    expect(
      mirrorReadinessFrom({ backfillCompletedAt: T1, drainedAt: tooOld }, now),
      "a drain older than the budget is stale",
    ).toEqual(MirrorReadinessState.ReconcilerStale({ drainedAt: tooOld }));
    expect(
      mirrorReadinessFrom({ backfillCompletedAt: T1, drainedAt: within }, now),
      "a drain exactly at the budget is still ready",
    ).toEqual(MirrorReadinessState.Ready());
    expect(mirrorReadinessFrom({ backfillCompletedAt: T1, drainedAt: now }, now)).toEqual(
      MirrorReadinessState.Ready(),
    );
  });

  it("reads the live row the backfill and the reconciler write", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const { db } = yield* DbService;
        const readiness = () => Effect.promise(() => readMirrorReadiness(db, new Date()));
        yield* clearEventsRow;
        const noRow = yield* readiness();
        yield* mirror.setReplayBoundary(T1);
        yield* mirror.markBackfillCompleted(T1);
        const backfilledOnly = yield* readiness();
        // A drain as of now: what a reconciler run that just read the stream
        // to its end records.
        const drainedAt = new Date();
        yield* mirror.markDrained(drainedAt);
        const ready = yield* readiness();
        return { noRow, backfilledOnly, ready };
      }),
    );
    expect(result.noRow).toEqual(MirrorReadinessState.BackfillPending());
    expect(result.backfilledOnly).toEqual(
      MirrorReadinessState.ReconcilerStale({ drainedAt: null }),
    );
    expect(result.ready).toEqual(MirrorReadinessState.Ready());
  });
});

describe("WorkOsMirror backfill sync state", () => {
  it("records the replay boundary and the backfill completion once each, and the drained mark forward only, without touching the cursor", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        // The events row is instance-wide (migration 0019 seeds it on the
        // empty test database, other tests may have written it): start from
        // no row, as a database that has never been backfilled has.
        yield* clearEventsRow;
        // No events row yet: nothing has been drained, and nothing is minted.
        const drainedWithoutRow = yield* mirror.markDrained(T1);
        const first = yield* mirror.setReplayBoundary(T2);
        const boundary = yield* mirror.replayBoundary();
        const cursorAfterBoundary = yield* mirror.getCursor();
        // A later completed backfill: its boundary is not recorded.
        const again = yield* mirror.setReplayBoundary(T3);
        const afterAgain = yield* mirror.replayBoundary();
        // Nor once the stream is being followed.
        const cursorBefore = yield* mirror.getCursor();
        yield* mirror.applyPage(cursorBefore, "event_boundary", []);
        const afterCursor = yield* mirror.setReplayBoundary(T1);
        const boundaryWithCursor = yield* mirror.replayBoundary();
        const cursor = yield* mirror.getCursor();
        // The completion mark: absent until a run covers every organization,
        // then written once, beside the boundary and the cursor.
        const notCompleted = yield* mirror.backfillCompletedAt();
        const completed = yield* mirror.markBackfillCompleted(T3);
        const completedAgain = yield* mirror.markBackfillCompleted(T4);
        const completedAt = yield* mirror.backfillCompletedAt();
        const boundaryAfterCompletion = yield* mirror.replayBoundary();
        const cursorAfterCompletion = yield* mirror.getCursor();
        // The drained mark moves forward only, on the row the stream owns.
        const notDrained = yield* mirror.drainedAt();
        const drainedFirst = yield* mirror.markDrained(T3);
        const drainedBackwards = yield* mirror.markDrained(T2);
        const drainedForward = yield* mirror.markDrained(T4);
        const drainedAt = yield* mirror.drainedAt();
        return {
          drainedWithoutRow,
          notDrained,
          drainedFirst,
          drainedBackwards,
          drainedForward,
          drainedAt,
          first,
          boundary,
          cursorAfterBoundary,
          again,
          afterAgain,
          afterCursor,
          boundaryWithCursor,
          cursor,
          notCompleted,
          completed,
          completedAgain,
          completedAt,
          boundaryAfterCompletion,
          cursorAfterCompletion,
        };
      }),
    );
    expect(result.first, "the first boundary is recorded").toBe(true);
    expect(result.boundary, "and reads back as written").toEqual(T2);
    expect(result.cursorAfterBoundary, "writing the boundary mints no cursor").toBeNull();
    expect(result.again, "a later run's boundary is refused").toBe(false);
    expect(result.afterAgain, "the first stands").toEqual(T2);
    expect(result.afterCursor).toBe(false);
    expect(result.boundaryWithCursor).toEqual(T2);
    expect(result.cursor, "and the cursor is untouched").toBe("event_boundary");
    expect(result.notCompleted, "no completion until a run covers every org").toBeNull();
    expect(result.completed, "the first completion is recorded").toBe(true);
    expect(result.completedAgain, "a later one is refused").toBe(false);
    expect(result.completedAt, "the first stands").toEqual(T3);
    expect(result.boundaryAfterCompletion, "the boundary is untouched").toEqual(T2);
    expect(result.cursorAfterCompletion, "and so is the cursor").toBe("event_boundary");
    expect(result.drainedWithoutRow, "no row, nothing drained: nothing written").toBe(false);
    expect(result.notDrained, "no drain recorded until a run drains").toBeNull();
    expect(result.drainedFirst).toBe(true);
    expect(result.drainedBackwards, "an earlier run finishing later cannot move it back").toBe(
      false,
    );
    expect(result.drainedForward).toBe(true);
    expect(result.drainedAt).toEqual(T4);
  });

  it("refuses a membership payload stamped before the organization's last scan, and accepts one stamped at or after it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const revoked = `user_${crypto.randomUUID()}`;
        const kept = `user_${crypto.randomUUID()}`;
        const joined = `user_${crypto.randomUUID()}`;
        // A login fetched its membership list at T1, while `revoked` was a
        // member, then stalled. WorkOS revoked them, and the backfill scanned
        // the org at T2 without them — nothing to tombstone, the row was
        // never there.
        yield* mirror.applyOrganizationScan({
          organizationId: org,
          listedAt: T2,
          members: [
            {
              user: user(kept),
              membership: membership(org, kept, { updatedAt: T1 }),
            },
          ],
        });
        // The stalled login resumes and writes what it holds: refused, the
        // revocation predates the scan and nothing would ever undo the row.
        const stale = yield* mirror.upsertMembership(membership(org, revoked, { updatedAt: T1 }));
        const staleRow = yield* directory.membership(revoked, org, [
          "active",
          "pending",
          "inactive",
        ]);
        // The same list's payload for a member the scan kept: refused too —
        // it changes nothing, the scan already wrote that state.
        const repeated = yield* mirror.upsertMembership(membership(org, kept, { updatedAt: T1 }));
        const keptRow = yield* directory.membership(kept, org);
        // A membership WorkOS created after the scan (its event, or a login
        // after it): stamped past the mark, written.
        const later = yield* mirror.upsertMembership(membership(org, joined, { updatedAt: T3 }));
        const atMark = yield* mirror.upsertMembership(
          membership(org, kept, { role: "admin", updatedAt: T2 }),
        );
        const keptAfter = yield* directory.membership(kept, org);
        return { stale, staleRow, repeated, keptRow, later, atMark, keptAfter };
      }),
    );
    expect(result.stale, "a payload older than the scan is refused").toBe(false);
    expect(result.staleRow, "and no row is minted for the revoked member").toBeNull();
    expect(result.repeated, "even for a member the scan kept").toBe(false);
    expect(result.keptRow?.status).toBe("active");
    expect(result.later, "a payload newer than the scan is written").toBe(true);
    expect(result.atMark, "as is one stamped at the scan's instant").toBe(true);
    expect(result.keptAfter?.role).toBe("admin");
  });

  it("waits for a scan holding the organization row before judging a payload against the scan's mark", async () => {
    // A feeder (a login) writes a membership it fetched at T1 while a scan
    // listed at T2 — which no longer contains that membership — is being
    // applied. The scan claims the organization row for the length of its
    // transaction; the feeder's write must wait for that commit, observe
    // the mark, and refuse the payload — never insert the membership the
    // scan proved revoked. The scan holds the test's shared connection; the
    // feeder runs the same store over a second one, so the two transactions
    // are real peers on the server.
    const result = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const org = yield* freshOrg();
          const revoked = `user_${crypto.randomUUID()}`;
          const { db: scanDb } = yield* DbService;
          // The second connection is owned by this test body's scope.
          const feederDb = Context.get(yield* Layer.build(makeDbLayer()), DbService).db;
          const feeder = makeWorkOsMirrorStore(feederDb);
          const directory = yield* MemberDirectory;

          // The scan's transaction: its claim (the `backfilled_at` CAS, an
          // UPDATE that locks the row) is done, and the transaction is held
          // open until `release` — the window a feeder can race.
          const claimed = yield* Deferred.make<void>();
          let release: () => void = () => undefined;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const scan = yield* Effect.forkChild(
            Effect.promise(() =>
              scanDb.transaction(async (tx) => {
                await tx
                  .update(organizations)
                  .set({ backfilledAt: T2 })
                  .where(eq(organizations.id, org));
                await Effect.runPromise(Deferred.succeed(claimed, undefined));
                await held;
              }),
            ),
            { startImmediately: true },
          );
          yield* Deferred.await(claimed);

          // The feeder's write starts while the scan holds the row.
          const written = yield* Deferred.make<boolean>();
          yield* Effect.forkChild(
            feeder
              .upsertMembership(membership(org, revoked, { updatedAt: T1 }))
              .pipe(Effect.flatMap((wrote) => Deferred.succeed(written, wrote))),
            { startImmediately: true },
          );
          const beforeCommit = yield* Effect.timeoutOption(Deferred.await(written), "250 millis");
          release();
          yield* Fiber.join(scan);
          const afterCommit = yield* Deferred.await(written);
          const row = yield* directory.membership(revoked, org, ["active", "pending", "inactive"]);
          return { beforeCommit, afterCommit, row };
        }),
      ),
    );
    expect(
      Option.isNone(result.beforeCommit),
      "the write waits while the scan holds the organization row",
    ).toBe(true);
    expect(result.afterCommit, "once the scan has committed, its mark refuses the payload").toBe(
      false,
    );
    expect(result.row, "so the revoked membership was never inserted").toBeNull();
  });

  it("applies a scan only when its listing is newer than the one already applied, and never to a deleted or unknown organization", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const store = yield* UserStoreService;
        const scanned = yield* freshOrg();
        const untouched = yield* freshOrg();
        const staying = `user_${crypto.randomUUID()}`;
        const leaving = `user_${crypto.randomUUID()}`;
        const member = (id: string) => ({
          user: user(id),
          membership: membership(scanned, id),
        });

        const before = yield* mirror.organizationBackfilledAt(scanned);
        // The later listing (T2) no longer contains `leaving`; applied first.
        const later = yield* mirror.applyOrganizationScan({
          organizationId: scanned,
          listedAt: T2,
          members: [member(staying)],
        });
        const afterLater = yield* mirror.organizationBackfilledAt(scanned);
        // The earlier listing (T1) still contains `leaving`: refused whole.
        const earlier = yield* mirror.applyOrganizationScan({
          organizationId: scanned,
          listedAt: T1,
          members: [member(staying), member(leaving)],
        });
        const afterEarlier = yield* mirror.organizationBackfilledAt(scanned);
        const leavingRow = yield* directory.membership(leaving, scanned, [
          "active",
          "pending",
          "inactive",
        ]);
        // The same instant is not newer either: a replayed listing writes nothing.
        const same = yield* mirror.applyOrganizationScan({
          organizationId: scanned,
          listedAt: T2,
          members: [],
        });
        const stayingRow = yield* directory.membership(staying, scanned);
        const other = yield* mirror.organizationBackfilledAt(untouched);
        const unknown = yield* mirror.applyOrganizationScan({
          organizationId: "org_never_mirrored",
          listedAt: T3,
          members: [],
        });
        yield* store.use("deleteOrganizationCascade", (s) =>
          s.deleteOrganizationCascade(untouched, T3),
        );
        const deleted = yield* mirror.applyOrganizationScan({
          organizationId: untouched,
          listedAt: T4,
          members: [{ user: user(staying), membership: membership(untouched, staying) }],
        });
        const deletedRow = yield* directory.membership(staying, untouched);
        return {
          before,
          later,
          afterLater,
          earlier,
          afterEarlier,
          leavingRow,
          same,
          stayingRow,
          other,
          unknown,
          deleted,
          deletedRow,
        };
      }),
    );
    expect(result.before, "a freshly mirrored organization is unscanned").toBeNull();
    expect(result.later).toEqual(
      Option.some({
        usersWritten: 1,
        membershipsWritten: 1,
        membershipsTombstoned: 0,
      }),
    );
    expect(result.afterLater, "the scan marks the organization as of its listing").toEqual(T2);
    expect(result.earlier, "an older listing is refused whole").toEqual(Option.none());
    expect(result.afterEarlier, "and the mark never moves backwards").toEqual(T2);
    expect(
      result.leavingRow,
      "the membership only the older listing held was never written",
    ).toBeNull();
    expect(result.same, "a listing at the recorded instant is refused too").toEqual(Option.none());
    expect(result.stayingRow?.status, "so it tombstones nothing the newer one wrote").toBe(
      "active",
    );
    expect(result.other, "another organization's mark is its own").toBeNull();
    expect(result.unknown, "an organization the mirror does not hold takes no scan").toEqual(
      Option.none(),
    );
    expect(result.deleted, "nor does a deleted one, however new the listing").toEqual(
      Option.none(),
    );
    expect(result.deletedRow).toBeNull();
  });
});

describe("cloud MemberDirectory", () => {
  const seed = (org: string) =>
    Effect.gen(function* () {
      const mirror = yield* WorkOsMirror;
      const ids = {
        ada: `user_${crypto.randomUUID()}`,
        grace: `user_${crypto.randomUUID()}`,
        linus: `user_${crypto.randomUUID()}`,
        gone: `user_${crypto.randomUUID()}`,
      };
      yield* mirror.upsertUser(
        user(ids.ada, {
          email: "Ada.Lovelace@Placeholder.test",
          firstName: "Ada",
          lastName: "Lovelace",
          lastSignInAt: T2,
        }),
      );
      yield* mirror.upsertUser(
        user(ids.grace, {
          email: "grace@placeholder.test",
          firstName: "Grace",
          lastName: "Hopper",
        }),
      );
      yield* mirror.upsertUser(
        user(ids.linus, {
          email: "linus@placeholder.test",
          firstName: "Linus",
          lastName: null,
        }),
      );
      yield* mirror.upsertUser(user(ids.gone, { email: "gone@placeholder.test" }));
      yield* mirror.upsertMembership(membership(org, ids.ada, { role: "admin" }));
      yield* mirror.upsertMembership(membership(org, ids.grace, { status: "pending" }));
      yield* mirror.upsertMembership(membership(org, ids.linus));
      yield* mirror.upsertMembership(membership(org, ids.gone, { status: "inactive" }));
      return ids;
    });

  it("lists active + pending members by default, ordered by email, and pages stably", async () => {
    const result = await run(
      Effect.gen(function* () {
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const ids = yield* seed(org);
        const all = yield* directory.members(org);
        const page1 = yield* directory.members(org, { limit: 2, offset: 0 });
        const page2 = yield* directory.members(org, { limit: 2, offset: 2 });
        const inactive = yield* directory.members(org, {
          statuses: ["inactive"],
        });
        return { ids, all, page1, page2, inactive };
      }),
    );
    expect(result.all.map((m) => m.email)).toEqual([
      "Ada.Lovelace@Placeholder.test",
      "grace@placeholder.test",
      "linus@placeholder.test",
    ]);
    expect(result.all.find((m) => m.accountId === result.ids.ada)).toMatchObject({
      role: "admin",
      status: "active",
      name: "Ada Lovelace",
      lastActiveAt: T2.getTime(),
    });
    expect(result.all.find((m) => m.accountId === result.ids.linus)?.name).toBe("Linus");
    expect([...result.page1, ...result.page2].map((m) => m.accountId)).toEqual(
      result.all.map((m) => m.accountId),
    );
    expect(result.inactive.map((m) => m.accountId)).toEqual([result.ids.gone]);
  });

  it("searches email and name case-insensitively, escaping LIKE wildcards", async () => {
    const result = await run(
      Effect.gen(function* () {
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const ids = yield* seed(org);
        const byEmail = yield* directory.members(org, { search: "LOVELACE@" });
        const byName = yield* directory.members(org, {
          search: "  grace hop ",
        });
        const nothing = yield* directory.members(org, { search: "nobody" });
        const blank = yield* directory.members(org, { search: "   " });
        const wildcard = yield* directory.members(org, { search: "%" });
        return { ids, byEmail, byName, nothing, blank, wildcard };
      }),
    );
    expect(result.byEmail.map((m) => m.accountId)).toEqual([result.ids.ada]);
    expect(result.byName.map((m) => m.accountId)).toEqual([result.ids.grace]);
    expect(result.nothing).toEqual([]);
    expect(result.blank.length, "a blank term is no filter").toBe(3);
    expect(result.wildcard, "a literal % matches nothing rather than everything").toEqual([]);
  });

  it("lists one account's memberships across orgs, active + pending by default", async () => {
    const result = await run(
      Effect.gen(function* () {
        const directory = yield* MemberDirectory;
        const mirror = yield* WorkOsMirror;
        const active = yield* freshOrg();
        const pending = yield* freshOrg();
        const inactive = yield* freshOrg();
        const id = `user_${crypto.randomUUID()}`;
        yield* mirror.upsertUser(user(id));
        yield* mirror.upsertMembership(membership(active, id, { role: "admin" }));
        yield* mirror.upsertMembership(membership(pending, id, { status: "pending" }));
        yield* mirror.upsertMembership(membership(inactive, id, { status: "inactive" }));
        const defaults = yield* directory.membershipsOf(id);
        const activeOnly = yield* directory.membershipsOf(id, ["active"]);
        const nobody = yield* directory.membershipsOf(`user_${crypto.randomUUID()}`);
        return { active, pending, inactive, defaults, activeOnly, nobody };
      }),
    );
    expect(result.defaults.map((m) => m.organizationId)).toEqual(
      [result.active, result.pending].sort(),
    );
    expect(result.defaults.find((m) => m.organizationId === result.active)?.role).toBe("admin");
    expect(result.activeOnly.map((m) => m.organizationId)).toEqual([result.active]);
    expect(result.nobody).toEqual([]);
  });

  it("resolves a normalized email regardless of stored casing, and batches by id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const other = yield* freshOrg();
        const ids = yield* seed(org);
        const found = yield* directory.findByEmail(org, "ada.lovelace@placeholder.test");
        const inactive = yield* directory.findByEmail(org, "gone@placeholder.test");
        const inactiveAsked = yield* directory.findByEmail(org, "gone@placeholder.test", [
          "inactive",
        ]);
        const wrongOrg = yield* directory.findByEmail(other, "ada.lovelace@placeholder.test");
        const batch = yield* directory.membersById(org, [ids.ada, ids.gone, "user_unknown"]);
        const batchAll = yield* directory.membersById(
          org,
          [ids.ada, ids.gone],
          ["active", "pending", "inactive"],
        );
        const empty = yield* directory.membersById(org, []);
        const byId = yield* directory.membershipById(org, `om_${ids.gone}_${org}`);
        const byIdForeign = yield* directory.membershipById(other, `om_${ids.gone}_${org}`);
        const byIdUnknown = yield* directory.membershipById(org, "om_unknown");
        return {
          ids,
          found,
          inactive,
          inactiveAsked,
          wrongOrg,
          batch,
          batchAll,
          empty,
          byId,
          byIdForeign,
          byIdUnknown,
        };
      }),
    );
    expect(result.found?.accountId).toBe(result.ids.ada);
    expect(result.inactive, "an inactive member is not found by default").toBeNull();
    expect(result.inactiveAsked?.status, "but is when asked for").toBe("inactive");
    expect(result.wrongOrg).toBeNull();
    expect([...result.batch.keys()], "a batch excludes inactive by default").toEqual([
      result.ids.ada,
    ]);
    expect([...result.batchAll.keys()].sort()).toEqual([result.ids.ada, result.ids.gone].sort());
    expect(result.empty.size).toBe(0);
    expect(result.byId, "membershipById reports any status").toMatchObject({
      accountId: result.ids.gone,
      status: "inactive",
    });
    expect(result.byIdForeign, "an id from another org is not this org's").toBeNull();
    expect(result.byIdUnknown).toBeNull();
  });
});
