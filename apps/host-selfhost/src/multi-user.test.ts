import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

// Real Better Auth path with multiple accounts.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-multi-"));
process.env.BETTER_AUTH_SECRET = "multi-user-secret-0123456789-abcdefghij-klmn";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@multi.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("./app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

const signUp = async (email: string): Promise<string> => {
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-12345678", name: email }),
    }),
  );
  expect(res.status).toBe(200);
  const token = res.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");
  return token;
};

const scopeOf = async (token: string): Promise<{ userScope: string; orgScope: string }> => {
  const res = await handler(
    new Request(`${BASE}/api/scope`, { headers: { authorization: `Bearer ${token}` } }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { stack: ReadonlyArray<{ id: string }> };
  return { userScope: body.stack[0]!.id, orgScope: body.stack[1]!.id };
};

const setSecret = (token: string, scopeId: string, id: string, value: string) =>
  handler(
    new Request(`${BASE}/api/scopes/${scopeId}/secrets`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id, name: id, value }),
    }),
  );

const secretResolves = async (token: string, scopeId: string, id: string): Promise<boolean> => {
  const res = await handler(
    new Request(`${BASE}/api/scopes/${scopeId}/secrets/${id}/status`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  if (res.status !== 200) return false;
  const body = (await res.json()) as { status: string };
  return body.status === "resolved";
};

const runCode = async (token: string, code: string) => {
  const res = await handler(
    new Request(`${BASE}/api/executions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  );
  return res;
};

test("multiple accounts share one org but isolate per-user secrets", async () => {
  const alice = await signUp("alice@multi.test");
  const bob = await signUp("bob@multi.test");

  const a = await scopeOf(alice);
  const b = await scopeOf(bob);

  // Same single org, distinct personal (user-org) scopes.
  expect(a.orgScope).toBe(b.orgScope);
  expect(a.userScope).not.toBe(b.userScope);

  // Alice stores a personal secret on her user-org scope.
  expect((await setSecret(alice, a.userScope, "gh", "alice-token")).status).toBe(200);

  // Alice can resolve her own personal secret; Bob cannot see it.
  expect(await secretResolves(alice, a.userScope, "gh")).toBe(true);
  expect(await secretResolves(bob, a.userScope, "gh")).toBe(false);

  // Org-scoped secrets ARE shared across members of the one org.
  expect((await setSecret(alice, a.orgScope, "org-key", "shared-value")).status).toBe(200);
  expect(await secretResolves(bob, a.orgScope, "org-key")).toBe(true);
});

test("each account can execute code in its own scoped sandbox", async () => {
  const carol = await signUp("carol@multi.test");
  const res = await runCode(carol, "export default 21 * 2");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; text: string };
  expect(body.status).toBe("completed");
  expect(body.text).toBe("42");
});
