import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-signup-race-"));
process.env.BETTER_AUTH_SECRET = "signup-race-secret-0123456789-abcdefghij";
delete process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL;
delete process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD;

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";
const PASSWORD = "password-12345678";

const bearerHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

const signUp = (email: string, inviteCode?: string) =>
  handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: PASSWORD,
        name: email,
        ...(inviteCode ? { inviteCode } : {}),
      }),
    }),
  );

const signIn = (email: string) =>
  handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );

const createInvite = async (ownerToken: string) => {
  const response = await handler(
    new Request(`${BASE}/api/admin/invites`, {
      method: "POST",
      headers: { ...bearerHeaders(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { code: string };
};

const listMembers = async (token: string) => {
  const response = await handler(
    new Request(`${BASE}/api/account/members`, { headers: bearerHeaders(token) }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    members: ReadonlyArray<{ email: string; role: string }>;
  };
};

const listInvites = async (token: string) => {
  const response = await handler(
    new Request(`${BASE}/api/admin/invites`, { headers: bearerHeaders(token) }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    invites: ReadonlyArray<{
      code: string;
      usedAt: string | null;
      usedByEmail: string | null;
    }>;
  };
};

test("signup claims serialize the first owner and each single-use invite", async () => {
  const ownerEmails = ["owner-a@race.test", "owner-b@race.test"] as const;
  const ownerAttempts = await Promise.all(
    ownerEmails.map(async (email) => ({ email, response: await signUp(email) })),
  );
  const ownerWinners = ownerAttempts.filter(({ response }) => response.status === 200);
  const ownerLosers = ownerAttempts.filter(({ response }) => response.status !== 200);
  expect(ownerWinners).toHaveLength(1);
  expect(ownerLosers).toHaveLength(1);

  const ownerToken = ownerWinners[0]?.response.headers.get("set-auth-token") ?? "";
  expect(ownerToken).not.toBe("");
  const membersAfterOwnerRace = await listMembers(ownerToken);
  expect(membersAfterOwnerRace.members).toHaveLength(1);
  expect(membersAfterOwnerRace.members[0]).toMatchObject({
    email: ownerWinners[0]?.email,
    role: "owner",
  });
  expect((await signIn(ownerLosers[0]?.email ?? "missing@race.test")).status).not.toBe(200);

  const { code } = await createInvite(ownerToken);
  const memberEmails = ["member-a@race.test", "member-b@race.test"] as const;
  const memberAttempts = await Promise.all(
    memberEmails.map(async (email) => ({ email, response: await signUp(email, code) })),
  );
  const memberWinners = memberAttempts.filter(({ response }) => response.status === 200);
  const memberLosers = memberAttempts.filter(({ response }) => response.status !== 200);
  expect(memberWinners).toHaveLength(1);
  expect(memberLosers).toHaveLength(1);

  const membersAfterInviteRace = await listMembers(ownerToken);
  expect(membersAfterInviteRace.members).toHaveLength(2);
  const racingMembers = membersAfterInviteRace.members.filter(({ email }) =>
    memberEmails.some((candidate) => candidate === email),
  );
  expect(racingMembers).toHaveLength(1);
  expect(racingMembers[0]).toMatchObject({ email: memberWinners[0]?.email, role: "member" });
  expect((await signIn(memberLosers[0]?.email ?? "missing@race.test")).status).not.toBe(200);

  const invitesAfterRace = await listInvites(ownerToken);
  expect(invitesAfterRace.invites.find((invite) => invite.code === code)).toMatchObject({
    usedByEmail: memberWinners[0]?.email,
  });
  expect(invitesAfterRace.invites.find((invite) => invite.code === code)?.usedAt).not.toBeNull();
});

test("a failed concurrent signup leaves its invite redeemable", async () => {
  const owner = await signIn("owner-a@race.test");
  const alternateOwner = await signIn("owner-b@race.test");
  const ownerResponse = owner.status === 200 ? owner : alternateOwner;
  expect(ownerResponse.status).toBe(200);
  const ownerToken = ownerResponse.headers.get("set-auth-token") ?? "";
  expect(ownerToken).not.toBe("");

  const inviteA = await createInvite(ownerToken);
  const inviteB = await createInvite(ownerToken);
  const duplicateEmail = "duplicate@race.test";
  const duplicateAttempts = await Promise.all([
    signUp(duplicateEmail, inviteA.code),
    signUp(duplicateEmail, inviteB.code),
  ]);
  expect(duplicateAttempts.filter(({ status }) => status === 200)).toHaveLength(1);
  expect(duplicateAttempts.filter(({ status }) => status !== 200)).toHaveLength(1);

  const invites = await listInvites(ownerToken);
  const duplicateInvites = invites.invites.filter(
    ({ code }) => code === inviteA.code || code === inviteB.code,
  );
  expect(duplicateInvites.filter(({ usedAt }) => usedAt !== null)).toHaveLength(1);
  const reusableCode = duplicateInvites.find(({ usedAt }) => usedAt === null)?.code ?? "";
  expect(reusableCode).not.toBe("");

  const recovered = await signUp("recovered@race.test", reusableCode);
  expect(recovered.status).toBe(200);
});
