// ---------------------------------------------------------------------------
// The cloud membership mirror: `WorkOsMirror` (writes) + the cloud
// `MemberDirectory` (reads), against the real PGlite Postgres every cloud
// unit test runs on (scripts/test-globalsetup.ts), through the same
// `DbService.Live` the request path uses.
//
// What this pins:
//   - an older WorkOS payload never overwrites a newer row (replay-safe)
//   - the cursor advances only by compare-and-set (one owner per stream)
//   - `members` searches email AND name case-insensitively, pages stably
//   - `findByEmail` ignores the casing WorkOS stored
//   - a membership arriving before its user still holds (FK via ensureAccount)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { MemberDirectory } from "@executor-js/api/server";

import { DbService } from "../db/db";
import { cloudMemberDirectoryLayer } from "./member-directory";
import { UserStoreService } from "./context";
import { WorkOsMirror, type WorkOsMirrorMembership, type WorkOsMirrorUser } from "./workos-mirror";

const DbLive = DbService.Live;
const Services = Layer.mergeAll(
  WorkOsMirror.Live,
  cloudMemberDirectoryLayer,
  UserStoreService.Live,
).pipe(Layer.provideMerge(DbLive));

const run = <A, E>(body: Effect.Effect<A, E, WorkOsMirror | MemberDirectory | UserStoreService>) =>
  Effect.runPromise(body.pipe(Effect.provide(Services), Effect.scoped));

const at = (iso: string) => new Date(iso);
const T1 = at("2026-01-01T00:00:00.000Z");
const T2 = at("2026-01-02T00:00:00.000Z");
const T3 = at("2026-01-03T00:00:00.000Z");

// Every test mints its own org so the shared test database never couples
// them; ids are synthetic placeholders, never real identities.
const freshOrg = () =>
  Effect.gen(function* () {
    const id = `org_${crypto.randomUUID().replaceAll("-", "")}`;
    const store = yield* UserStoreService;
    yield* store.use("upsertOrganization", (s) => s.upsertOrganization({ id, name: "Mirror Org" }));
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
          membership(org, id, { role: "member", status: "inactive", updatedAt: T1 }),
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

  it("deletes by WorkOS membership id and by account id, reporting absence honestly", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const a = `user_${crypto.randomUUID()}`;
        const b = `user_${crypto.randomUUID()}`;
        yield* mirror.upsertUser(user(a));
        yield* mirror.upsertUser(user(b));
        yield* mirror.upsertMembership(membership(org, a, { id: "om_a" + a }));
        yield* mirror.upsertMembership(membership(org, b));

        const removed = yield* mirror.deleteMembership("om_a" + a);
        const removedAgain = yield* mirror.deleteMembership("om_a" + a);
        const aAfter = yield* directory.membership(a, org);
        const userGone = yield* mirror.deleteUser(b);
        const bAfter = yield* directory.membership(b, org);
        return { removed, removedAgain, aAfter, userGone, bAfter };
      }),
    );
    expect(result.removed).toBe(true);
    expect(result.removedAgain).toBe(false);
    expect(result.aAfter).toBeNull();
    expect(result.userGone).toBe(true);
    expect(result.bAfter, "deleting the account cascades its membership").toBeNull();
  });
});

describe("WorkOsMirror cursor", () => {
  it("advances only by compare-and-set", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mirror = yield* WorkOsMirror;
        // The cursor is instance-wide; read whatever a previous test left so
        // this test's expectations are relative, not absolute.
        const before = yield* mirror.getCursor();
        const first = yield* mirror.setCursor(before, "event_1");
        const wrongPrev = yield* mirror.setCursor(before === null ? "event_0" : null, "event_x");
        const afterWrong = yield* mirror.getCursor();
        const right = yield* mirror.setCursor("event_1", "event_2");
        const after = yield* mirror.getCursor();
        return { first, wrongPrev, afterWrong, right, after };
      }),
    );
    expect(result.first).toBe(true);
    expect(result.wrongPrev, "a run holding a stale prev cannot move the cursor").toBe(false);
    expect(result.afterWrong).toBe("event_1");
    expect(result.right).toBe(true);
    expect(result.after).toBe("event_2");
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
        user(ids.linus, { email: "linus@placeholder.test", firstName: "Linus", lastName: null }),
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
        const inactive = yield* directory.members(org, { statuses: ["inactive"] });
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
        const byName = yield* directory.members(org, { search: "  grace hop " });
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

  it("resolves a normalized email regardless of stored casing, and batches by id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const directory = yield* MemberDirectory;
        const org = yield* freshOrg();
        const other = yield* freshOrg();
        const ids = yield* seed(org);
        const found = yield* directory.findByEmail(org, "ada.lovelace@placeholder.test");
        const inactive = yield* directory.findByEmail(org, "gone@placeholder.test");
        const wrongOrg = yield* directory.findByEmail(other, "ada.lovelace@placeholder.test");
        const batch = yield* directory.membersById(org, [ids.ada, ids.gone, "user_unknown"]);
        const empty = yield* directory.membersById(org, []);
        return { ids, found, inactive, wrongOrg, batch, empty };
      }),
    );
    expect(result.found?.accountId).toBe(result.ids.ada);
    expect(result.inactive?.status, "findByEmail reports any status").toBe("inactive");
    expect(result.wrongOrg).toBeNull();
    expect([...result.batch.keys()].sort()).toEqual([result.ids.ada, result.ids.gone].sort());
    expect(result.empty.size).toBe(0);
  });
});
