import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

// Real Better Auth path: set a secret + bootstrap admin before importing.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-auth-"));
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-abcdefghijklmnop-qrstuv";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@test.local";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-password-123";

const { makeSelfHostApiHandler } = await import("../app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

test("migrations create both the Better Auth and FumaDB executor schema regions", async () => {
  // Open a SEPARATE libSQL connection to the same file Better Auth (via its own
  // LibsqlDialect connection) and the FumaDB drizzle client wrote to. That this
  // connection can read Better Auth's tables AND rows proves the cross-connection
  // invariant: there is no shared in-process handle anymore, yet a row Better
  // Auth wrote is immediately visible here on the same file: URL.
  const { createClient } = await import("@libsql/client");
  const db = createClient({
    url: `file:${join(process.env.EXECUTOR_DATA_DIR!, "data.db")}`,
  });
  const names = (await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(
    // oxlint-disable-next-line executor/no-redundant-primitive-cast -- boundary: sqlite_master.name is TEXT; narrow libSQL's SQLValue to string for the table-name list
    (r) => r.name as string,
  );
  // Better Auth tables
  for (const t of ["user", "session", "account", "organization", "member"]) {
    expect(names).toContain(t);
  }
  // FumaDB executor tables coexist in the same file (v2: a connection IS the
  // credential, so the `connection` table replaces the v1 `secret` table).
  expect(names).toContain("connection");

  // CROSS-CONNECTION PROOF: the bootstrap admin Better Auth wrote through its
  // LibsqlDialect connection is readable through this independent connection.
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the SELECT column is the schema contract for the Better Auth `user` row read off this independent libSQL connection
  const admin = (
    await db.execute({
      sql: "SELECT email FROM user WHERE email = ?",
      args: ["admin@test.local"],
    })
  ).rows[0] as unknown as { email: string } | undefined;
  expect(admin?.email).toBe("admin@test.local");
  db.close();
});

test("sign-up issues a bearer token and resolves to a per-user org-pinned identity", async () => {
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@test.local",
        password: "member-password-123",
        name: "Member",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
  const token = signUp.headers.get("set-auth-token");
  expect(token).toBeTruthy();

  // The bearer token resolves to the user pinned to their own org (the v2 binding
  // is `{ tenant: org, subject: user }`; `/api/account/me` reflects both).
  const me = await handler(
    new Request("http://localhost/api/account/me", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(me.status).toBe(200);
  const body = (await me.json()) as {
    user: { id: string; email: string };
    organization: { id: string; name: string } | null;
  };
  expect(body.user.email).toBe("member@test.local");
  expect(body.organization).not.toBeNull();
  expect(body.organization!.id).toBeTruthy();
});

test("self-host API keys are not capped by Better Auth's default request limit", async () => {
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "key-user@test.local",
        password: "member-password-123",
        name: "Key User",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
  const token = signUp.headers.get("set-auth-token");
  expect(token).toBeTruthy();

  const createKey = await handler(
    new Request(`${BASE}/api/account/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "MCP bootstrap" }),
    }),
  );
  expect(createKey.status).toBe(200);
  const keyBody = (await createKey.json()) as { value: string };

  for (let i = 0; i < 12; i++) {
    const me = await handler(
      new Request(`${BASE}/api/account/me`, {
        headers: { "x-api-key": keyBody.value },
      }),
    );
    expect(me.status).toBe(200);
  }
});

test("an unauthenticated request is rejected with 401", async () => {
  const res = await handler(new Request("http://localhost/api/account/me"));
  expect(res.status).toBe(401);
});
