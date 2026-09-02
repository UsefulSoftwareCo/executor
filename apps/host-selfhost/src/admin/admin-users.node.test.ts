import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

// The self-host admin users plane (`/api/admin/users*`), over the REAL booted
// app: Better Auth, the libSQL store, and the mounted route layer.
//
// Self-host has no organization-owned api key (Better Auth keys always belong
// to the user who made one), so the credential here is the operator's own
// owner/admin session — the same gate the invite-code admin API uses. What this
// pins is that the mount is live, that the owner/admin gate actually refuses a
// plain member, and that a member who has used the instance shows up in the
// owner's view without their credential coming with them.

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-admin-users-"));
process.env.BETTER_AUTH_SECRET = "admin-users-test-secret-0123456789-abcdefghij";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@admin-users.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

const signIn = async (email: string, password: string): Promise<string> => {
  const response = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  return response.headers.get("set-auth-token") ?? "";
};

const adminUsers = (token?: string, path = "/api/admin/users") =>
  handler(
    new Request(`${BASE}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );

test("the owner sees who uses the instance; a plain member cannot look", async () => {
  const adminToken = await signIn(
    process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL!,
    process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD!,
  );
  expect(adminToken).not.toBe("");

  // A second person joins through the real invite flow and uses the instance.
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@admin-users.test",
        password: "password-12345678",
        name: "Member",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
  const memberToken = signUp.headers.get("set-auth-token") ?? "";
  expect(memberToken).not.toBe("");

  // A user earns their row the first time they touch the EXECUTOR plane, so
  // have both make one product read before looking at the admin view.
  for (const token of [adminToken, memberToken]) {
    const integrations = await handler(
      new Request(`${BASE}/api/integrations`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(integrations.status).toBe(200);
  }

  // The owner's view reports both people.
  const response = await adminUsers(adminToken);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    users: ReadonlyArray<{
      externalId: string;
      lastSeenAt: number | null;
      email: string | null;
      displayName: string | null;
    }>;
  };
  expect(body.users.length, "both the owner and the invited member are reported").toBe(2);
  expect(typeof body.users[0]?.lastSeenAt, "last-seen crosses the wire as a number").toBe("number");

  // THE JOIN KEY, proven against real Better Auth rather than assumed.
  //
  // `auth/identity.ts` binds `session.user.id` as the accountId, so that is what
  // the subject table records in `external_id` — and it is the member list's
  // `userId`, NOT its `id` (the organization `member` ROW id). The two look
  // alike and only one joins, so this asserts the actual emails land on the
  // actual rows: a mismatch would leave every user unnamed while the counts
  // above still passed.
  const byEmail = new Map(body.users.map((user) => [user.email, user.externalId]));
  expect(
    [...byEmail.keys()].sort(),
    "each user carries the email Better Auth holds for them",
  ).toEqual(["admin@admin-users.test", "member@admin-users.test"]);
  expect(
    body.users.every((user) => user.externalId.length > 0),
    "and the id space still lines up — nobody was named by matching nothing",
  ).toBe(true);
  expect(
    body.users.find((user) => user.email === "member@admin-users.test")?.displayName,
    "the sign-up name comes through as the display name",
  ).toBe("Member");

  // The joined view is mounted too, and carries the same identity.
  const joined = await adminUsers(adminToken, "/api/admin/users/with-connections");
  expect(joined.status).toBe(200);
  const joinedBody = (await joined.json()) as {
    users: ReadonlyArray<{
      externalId: string;
      email: string | null;
      connections: readonly unknown[];
    }>;
  };
  expect(joinedBody.users.length).toBe(2);
  expect(
    joinedBody.users.every((user) => Array.isArray(user.connections)),
    "every user carries a connections array",
  ).toBe(true);
  expect(
    joinedBody.users.map((user) => [user.externalId, user.email]).sort(),
    "the joined view reports the same identities, keyed the same way",
  ).toEqual(body.users.map((user) => [user.externalId, user.email]).sort());

  // -------------------------------------------------------------------------
  // The single-user read, by opaque id and by email.
  // -------------------------------------------------------------------------

  const memberId = byEmail.get("member@admin-users.test")!;

  type UserBody = {
    user: {
      externalId: string;
      email: string | null;
      displayName: string | null;
      connections: readonly unknown[];
    };
  };

  const single = await adminUsers(adminToken, `/api/admin/users/${memberId}`);
  expect(single.status).toBe(200);
  const singleBody = (await single.json()) as UserBody;
  expect(singleBody.user.externalId).toBe(memberId);
  expect(singleBody.user.email).toBe("member@admin-users.test");
  expect(singleBody.user.displayName).toBe("Member");
  expect(
    Array.isArray(singleBody.user.connections),
    "identity and connections arrive in ONE call",
  ).toBe(true);

  // The same person by email, in three casings. Better Auth stores emails
  // lower-cased, so this proves the QUERY side is normalized against a real
  // directory rather than against a fixture that happens to agree.
  for (const spelling of [
    "member@admin-users.test",
    "Member@Admin-Users.Test",
    "MEMBER@ADMIN-USERS.TEST",
  ]) {
    const byEmailResponse = await adminUsers(
      adminToken,
      `/api/admin/users/${encodeURIComponent(spelling)}`,
    );
    expect(byEmailResponse.status, `${spelling} resolves`).toBe(200);
    expect(((await byEmailResponse.json()) as UserBody).user.externalId).toBe(memberId);
  }

  // An email nobody in the directory holds.
  const unknownEmail = await adminUsers(
    adminToken,
    `/api/admin/users/${encodeURIComponent("nobody@admin-users.test")}`,
  );
  expect(unknownEmail.status, "unknown email → 404").toBe(404);
  // Asserted on the encoded body — the distinct error is what lets a caller
  // tell "no footprint" from "bad credential" without parsing a message.
  expect(await unknownEmail.text()).toContain("AdminUserNotFound");

  // An id that names no subject row.
  const unknownId = await adminUsers(adminToken, "/api/admin/users/user_does_not_exist");
  expect(unknownId.status, "unknown id → 404").toBe(404);

  // The bulk `?email=` filter, over the same real directory.
  const filtered = await adminUsers(
    adminToken,
    `/api/admin/users?email=${encodeURIComponent("MEMBER@admin-users.test")}`,
  );
  expect(filtered.status).toBe(200);
  const filteredBody = (await filtered.json()) as { users: ReadonlyArray<{ externalId: string }> };
  expect(
    filteredBody.users.map((user) => user.externalId),
    "the filter selects exactly the one member, case-insensitively",
  ).toEqual([memberId]);

  const filteredUnknown = await adminUsers(
    adminToken,
    `/api/admin/users?email=${encodeURIComponent("nobody@admin-users.test")}`,
  );
  expect(
    ((await filteredUnknown.json()) as { users: readonly unknown[] }).users,
    "an unknown email is an EMPTY page, never the unfiltered tenant",
  ).toEqual([]);

  // The router-ordering invariant against the real mount: the static segment
  // must still beat `/:identifier`.
  const stillTheList = await adminUsers(adminToken, "/api/admin/users/with-connections");
  expect(stillTheList.status).toBe(200);
  expect(((await stillTheList.json()) as { users: readonly unknown[] }).users.length).toBe(2);

  // The gate: a plain member may not read the instance-wide view.
  const asMember = await adminUsers(memberToken);
  expect(asMember.status, "a member is refused").toBe(403);

  // And an anonymous caller has no session at all.
  const anonymous = await adminUsers();
  expect(anonymous.status, "no session → unauthorized").toBe(401);

  // The single-user read refuses on the same terms — and refuses BEFORE
  // looking, so a refused caller cannot probe which users exist.
  expect((await adminUsers(memberToken, `/api/admin/users/${memberId}`)).status).toBe(403);
  expect((await adminUsers(memberToken, "/api/admin/users/user_nobody")).status).toBe(403);
  expect((await adminUsers(undefined, `/api/admin/users/${memberId}`)).status).toBe(401);
});
