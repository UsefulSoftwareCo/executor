import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { MemberDirectory } from "@executor-js/api/server";

// The self-host `MemberDirectory` over REAL Better Auth: the org plugin's
// `member` rows joined to `user` rows through Better Auth's own adapter, the
// same read `mcp/auth.ts` makes for an OAuth token's role.
//
// Members are created server-side (`createUser` + `addMember`, no session —
// the same calls the bootstrap seed makes), so this pins the adapter read
// itself rather than the sign-up flow.

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-member-directory-"));
process.env.BETTER_AUTH_SECRET = "member-directory-secret-0123456789-abcdefghij";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "owner@placeholder.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "owner-pass-123456";

const { makeSelfHostApp } = await import("../app");
const { BetterAuth } = await import("./better-auth");
const { betterAuthMemberDirectoryLayer } = await import("./member-directory");

const app = await makeSelfHostApp();
afterAll(() => app.closeDb());

const { auth, organizationId } = app.betterAuth;
const directoryLayer = betterAuthMemberDirectoryLayer.pipe(
  Layer.provide(Layer.succeed(BetterAuth)(app.betterAuth)),
);
const run = <A, E>(body: Effect.Effect<A, E, MemberDirectory>) =>
  Effect.runPromise(body.pipe(Effect.provide(directoryLayer)));

const addMember = async (email: string, name: string, role: "admin" | "member") => {
  const created = await auth.api.createUser({ body: { email, name, password: "pw-12345678" } });
  await auth.api.addMember({ body: { userId: created.user.id, role, organizationId } });
  return created.user.id;
};

// Better Auth lower-cases the email it stores; the mixed case here proves the
// directory does not depend on that.
const ada = await addMember("Ada.Lovelace@Placeholder.test", "Ada Lovelace", "admin");
const grace = await addMember("grace@placeholder.test", "Grace Hopper", "member");
const linus = await addMember("linus@placeholder.test", "Linus", "member");
// A user who is NOT a member of the org: must never be reported.
const outsider = await auth.api.createUser({
  body: { email: "outsider@placeholder.test", name: "Outsider", password: "pw-12345678" },
});

describe("self-host MemberDirectory", () => {
  it("reports the org's members with Better Auth roles, ordered by email", async () => {
    const members = await run(
      Effect.flatMap(MemberDirectory.asEffect(), (d) => d.members(organizationId)),
    );
    const emails = members.map((m) => m.email);
    expect(emails).toEqual([
      "ada.lovelace@placeholder.test",
      "grace@placeholder.test",
      "linus@placeholder.test",
      "owner@placeholder.test",
    ]);
    const first = members.find((m) => m.accountId === ada);
    expect(first).toMatchObject({
      organizationId,
      role: "admin",
      status: "active",
      name: "Ada Lovelace",
      lastActiveAt: null,
    });
    expect(first?.membershipId, "membershipId is the member ROW id, not the user id").not.toBe(ada);
    expect(members.find((m) => m.email === "owner@placeholder.test")?.role).toBe("owner");
    expect(members.some((m) => m.accountId === outsider.user.id)).toBe(false);
  });

  it("searches email and name case-insensitively and pages stably", async () => {
    const result = await run(
      Effect.gen(function* () {
        const d = yield* MemberDirectory;
        return {
          byEmail: yield* d.members(organizationId, { search: "LOVELACE@" }),
          byName: yield* d.members(organizationId, { search: " grace hop " }),
          nothing: yield* d.members(organizationId, { search: "nobody" }),
          page1: yield* d.members(organizationId, { limit: 2, offset: 0 }),
          page2: yield* d.members(organizationId, { limit: 2, offset: 2 }),
          inactive: yield* d.members(organizationId, { statuses: ["inactive"] }),
          all: yield* d.members(organizationId),
        };
      }),
    );
    expect(result.byEmail.map((m) => m.accountId)).toEqual([ada]);
    expect(result.byName.map((m) => m.accountId)).toEqual([grace]);
    expect(result.nothing).toEqual([]);
    // Two pages of two, concatenated, are the whole ordered list.
    const paged = [...result.page1, ...result.page2].map((m) => m.accountId);
    expect(paged).toEqual(result.all.map((m) => m.accountId));
    expect(result.page1.length + result.page2.length).toBe(4);
    expect(result.inactive, "Better Auth members are always active").toEqual([]);
  });

  it("resolves one membership, a batch by id, and an email in any casing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const d = yield* MemberDirectory;
        return {
          one: yield* d.membership(grace, organizationId),
          none: yield* d.membership(outsider.user.id, organizationId),
          batch: yield* d.membersById(organizationId, [ada, linus, outsider.user.id, "nobody"]),
          byEmail: yield* d.findByEmail(organizationId, "ada.lovelace@placeholder.test"),
          unknown: yield* d.findByEmail(organizationId, "outsider@placeholder.test"),
        };
      }),
    );
    expect(result.one?.role).toBe("member");
    expect(result.none).toBeNull();
    expect([...result.batch.keys()].sort()).toEqual([ada, linus].sort());
    expect(result.byEmail?.accountId).toBe(ada);
    expect(result.unknown, "a user with no membership is not a member").toBeNull();
  });
});
