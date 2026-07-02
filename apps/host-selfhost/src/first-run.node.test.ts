import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

// Fully zero-config boot: NO BETTER_AUTH_SECRET and NO bootstrap admin env, so
// the secret is generated + persisted and the org is created with no members —
// the turnkey first-run path.
const DATA_DIR = mkdtempSync(join(tmpdir(), "eh-firstrun-"));
process.env.EXECUTOR_DATA_DIR = DATA_DIR;
delete process.env.BETTER_AUTH_SECRET;
delete process.env.AUTH_SECRET;
delete process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL;
delete process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD;

const { makeSelfHostApiHandler } = await import("./app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";
const get = (path: string) => handler(new Request(`${BASE}${path}`));
const signUp = (body: Record<string, unknown>) =>
  handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("zero-config boot generates and persists a session secret in the data dir", () => {
  expect(existsSync(join(DATA_DIR, "auth-secret.key"))).toBe(true);
});

test("health endpoint reports ok", async () => {
  const res = await get("/api/health");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe("ok");
});

test("a fresh instance needs setup, admits the first signup as owner, then gates the rest", async () => {
  // Before anyone signs up, the org has zero members.
  const before = await get("/api/setup-status");
  expect(before.status).toBe(200);
  expect(((await before.json()) as { needsSetup: boolean }).needsSetup).toBe(true);

  // The first signup needs NO invite code and claims the org.
  const first = await signUp({
    email: "owner@firstrun.test",
    password: "password-12345678",
    name: "Owner",
  });
  expect(first.status).toBe(200);
  const token = first.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");

  // Setup is now complete.
  const after = await get("/api/setup-status");
  expect(((await after.json()) as { needsSetup: boolean }).needsSetup).toBe(false);

  // The first user is the owner: the admin API admits them.
  const invites = await handler(
    new Request(`${BASE}/api/admin/invites`, { headers: { authorization: `Bearer ${token}` } }),
  );
  expect(invites.status).toBe(200);

  // A second signup with no code is now rejected — the invite gate is in force.
  const second = await signUp({
    email: "intruder@firstrun.test",
    password: "password-12345678",
    name: "Intruder",
  });
  expect(second.status).not.toBe(200);
});
