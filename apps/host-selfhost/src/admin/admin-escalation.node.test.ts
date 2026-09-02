import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

// ---------------------------------------------------------------------------
// THE ESCALATION, performed rather than asserted about.
//
// `admin-users.node.test.ts` already asserts a plain member gets a 403, and it
// PASSED while the instance was fully bypassable — because it only ever asked
// the question one way. A member who simply calls the admin plane is refused;
// a member who first arranges to be an owner OF SOMETHING is a different
// caller, and the old gate could not tell the difference: it read the role from
// `session.activeOrganizationId`, which the caller controls, while the reads
// underneath stayed scoped to the instance's boot-seeded org.
//
// So this file does not test the label ("members are refused"). It runs the
// actual attack an invited member can run with nothing but their own session
// and the auth routes Better Auth mounts:
//
//   1. POST /api/auth/organization/create  → become `owner` of a new org
//   2. POST /api/auth/organization/set-active → point the session at it
//   3. call the admin planes                → must STILL be refused
//
// and asserts the refusal survives every step, on BOTH planes. The users plane
// leaks the instance's whole user directory and connection inventory; the
// invite plane is worse, because a `role: "admin"` invite code is durable
// escalation that outlives the session. Step 1 is now refused outright
// (`allowUserToCreateOrganization: false`), so the test asserts what it can at
// each step and never lets a blocked earlier step silently excuse a later one —
// steps 2 and 3 run regardless of whether step 1 succeeded.
//
// MUTATION-CHECKED, both directions:
//   - gate reverted to a session-scoped role lookup + org creation re-opened:
//     FAILS with "/api/admin/users refuses the escalated member: expected 200
//     to be 403". The escalation really is reachable, and this test really does
//     catch it.
//   - gate fixed, org creation re-opened: every admin-plane assertion above
//     PASSES and only the final defense-in-depth line fails. That is the
//     evidence that the gate — not the flag — is what closes the hole.
// ---------------------------------------------------------------------------

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-admin-escalation-"));
process.env.BETTER_AUTH_SECRET = "admin-escalation-secret-0123456789-abcdefg";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@escalation.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

const asMember = (token: string) => ({ authorization: `Bearer ${token}` });

const post = (path: string, token: string, body: unknown) =>
  handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...asMember(token) },
      body: JSON.stringify(body),
    }),
  );

const get = (path: string, token: string) =>
  handler(new Request(`${BASE}${path}`, { headers: asMember(token) }));

/** Join the instance for real: mint an invite as the bootstrap admin, redeem it.
 *  This is a legitimate, fully authenticated member of the instance org — the
 *  weakest principal that has any standing at all, which is precisely the
 *  attacker this gate has to hold against. */
const joinAsMember = async (email: string): Promise<string> => {
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-12345678", name: "Member", inviteCode }),
    }),
  );
  expect(signUp.status, "the member joined through the real invite flow").toBe(200);
  const token = signUp.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");
  return token;
};

test("a member cannot escalate by owning an organization of their own", async () => {
  const memberToken = await joinAsMember("climber@escalation.test");

  // Baseline: the ordinary refusal the old test already covered. If this were
  // ever a 200 the rest of the file would be meaningless, so it is asserted
  // first rather than assumed.
  expect((await get("/api/admin/users", memberToken)).status, "a plain member is refused").toBe(
    403,
  );

  // -- Step 1: become an owner. ---------------------------------------------
  // With `allowUserToCreateOrganization: false` this is refused outright. Its
  // status is RECORDED, not asserted here: the security property this test
  // exists for is "the admin plane stays shut", and asserting the block at step
  // 1 would abort the run before step 3 ever asserts it. So the attack proceeds
  // as far as it can either way, the planes are checked, and only then is the
  // defense-in-depth flag asserted at the bottom.
  const created = await post("/api/auth/organization/create", memberToken, {
    name: "Climber Org",
    slug: "climber-org",
  });
  const createdOrgId = created.ok ? ((await created.json()) as { id?: string }).id : undefined;

  // -- Step 2: point the session at an org the caller owns. ------------------
  // The cheaper repeat path. Attempted against the created org when step 1
  // somehow succeeded, and unconditionally against the slug either way.
  if (createdOrgId) {
    await post("/api/auth/organization/set-active", memberToken, {
      organizationId: createdOrgId,
    });
  }
  await post("/api/auth/organization/set-active", memberToken, {
    organizationSlug: "climber-org",
  });

  // -- Step 3: the planes must still refuse. ---------------------------------
  // Every admin users route, not just the list: a gate applied at four call
  // sites can be fixed at three.
  for (const path of [
    "/api/admin/users",
    "/api/admin/users/with-connections",
    "/api/admin/users/user_anyone/connections",
    "/api/admin/users/user_anyone",
    `/api/admin/users/${encodeURIComponent("admin@escalation.test")}`,
  ]) {
    const response = await get(path, memberToken);
    expect(response.status, `${path} refuses the escalated member`).toBe(403);
    // A refusal that leaked the answer in its body would be no refusal at all.
    expect(await response.text(), `${path} discloses nothing`).not.toContain(
      "admin@escalation.test",
    );
  }

  // The invite plane shares the gate, and a bypass there is DURABLE: a
  // `role: "admin"` code redeems into a real admin membership that outlives
  // this session. Read and write are both checked — listing invite codes is
  // itself a disclosure (a live code is a credential).
  expect((await get("/api/admin/invites", memberToken)).status, "invite list refused").toBe(403);

  const minted = await post("/api/admin/invites", memberToken, { role: "admin" });
  expect(minted.status, "an admin invite cannot be minted by a member").toBe(403);
  expect(await minted.text(), "and no code came back").not.toContain("code");

  const revoked = await handler(
    new Request(`${BASE}/api/admin/invites/some-invite-id`, {
      method: "DELETE",
      headers: asMember(memberToken),
    }),
  );
  expect(revoked.status, "revoking someone else's invite is refused too").toBe(403);

  // The instance's real admin is unaffected — the gate closed the hole, it did
  // not close the door. Without this, every assertion above would also pass if
  // the admin plane were simply broken for everyone.
  const adminList = await get("/api/admin/users", await signInAdmin());
  expect(adminList.status, "the real instance admin still gets in").toBe(200);

  // Defense in depth, asserted LAST so it can never mask the assertions above:
  // step 1 of the attack is itself closed on a single-org instance.
  expect(created.status, "org creation is closed on a single-org instance").not.toBe(200);
});

const signInAdmin = async (): Promise<string> => {
  const response = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
      }),
    }),
  );
  return response.headers.get("set-auth-token") ?? "";
};
