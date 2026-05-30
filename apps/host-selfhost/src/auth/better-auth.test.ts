import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

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
  const db = createClient({ url: `file:${join(process.env.EXECUTOR_DATA_DIR!, "data.db")}` });
  const names = (await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(
    // oxlint-disable-next-line executor/no-redundant-primitive-cast -- boundary: sqlite_master.name is TEXT; narrow libSQL's SQLValue to string for the table-name list
    (r) => r.name as string,
  );
  // Better Auth tables
  for (const t of ["user", "session", "account", "organization", "member"]) {
    expect(names).toContain(t);
  }
  // FumaDB executor tables coexist in the same file
  expect(names).toContain("secret");

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

test("sign-up issues a bearer token and resolves to a per-user org-pinned scope", async () => {
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@test.local",
        password: "member-password-123",
        name: "Member",
      }),
    }),
  );
  expect(signUp.status).toBe(200);
  const token = signUp.headers.get("set-auth-token");
  expect(token).toBeTruthy();

  const scoped = await handler(
    new Request("http://localhost/api/scope", { headers: { authorization: `Bearer ${token}` } }),
  );
  expect(scoped.status).toBe(200);
  const body = (await scoped.json()) as { id: string; stack: ReadonlyArray<{ id: string }> };
  expect(body.stack.length).toBe(2);
  const inner = body.stack[0]!;
  const outer = body.stack[1]!;
  expect(outer.id).toBe(body.id);
  expect(inner.id.startsWith("user-org:")).toBe(true);
  expect(inner.id.endsWith(`:${outer.id}`)).toBe(true);
});

test("an unauthenticated request is rejected with 401", async () => {
  const res = await handler(new Request("http://localhost/api/scope"));
  expect(res.status).toBe(401);
});
