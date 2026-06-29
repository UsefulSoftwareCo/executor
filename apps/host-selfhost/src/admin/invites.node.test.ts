import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

// Real Better Auth path: signup must be invite-gated.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-invite-"));
process.env.BETTER_AUTH_SECRET = "invite-test-secret-0123456789-abcdefghij-klmn";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@invite.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

const signUp = (body: Record<string, unknown>) =>
  handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("open signup is closed: a signup without a valid invite code is rejected", async () => {
  const res = await signUp({
    email: "intruder@invite.test",
    password: "password-12345678",
    name: "Intruder",
  });
  expect(res.status).not.toBe(200);

  const badCode = await signUp({
    email: "intruder2@invite.test",
    password: "password-12345678",
    name: "Intruder",
    inviteCode: "AAAA-BBBB-CCCC",
  });
  expect(badCode.status).not.toBe(200);
});

test("a code minted via the admin API redeems into a real org membership", async () => {
  // Minted through the TYPED admin HttpApi client (see mint-invite.ts).
  const inviteCode = await mintInviteCode(handler);

  const res = await signUp({
    email: "member@invite.test",
    password: "password-12345678",
    name: "Member",
    inviteCode,
  });
  expect(res.status).toBe(200);
  const token = res.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");

  // The new user resolves to a real org membership (the bound tenant).
  const me = await handler(
    new Request(`${BASE}/api/account/me`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(me.status).toBe(200);
  const meBody = (await me.json()) as { organization: { id: string } | null };
  expect(meBody.organization?.id).toBeTruthy();

  // The single-use code is now spent: reusing it is rejected.
  const reuse = await signUp({
    email: "second@invite.test",
    password: "password-12345678",
    name: "Second",
    inviteCode,
  });
  expect(reuse.status).not.toBe(200);
});
