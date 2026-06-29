import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";
import { connectionIdentifier } from "@executor-js/sdk/shared";

import { mintInviteCode } from "./testing/mint-invite";

// Real Better Auth path with multiple accounts.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-multi-"));
process.env.BETTER_AUTH_SECRET = "multi-user-secret-0123456789-abcdefghij-klmn";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@multi.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("./app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";
const connectionName = (name: string): string => String(connectionIdentifier(name));

const TINY_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Tiny", version: "1.0.0" },
  servers: [{ url: "https://httpbin.org" }],
  paths: {
    "/get": {
      get: {
        operationId: "httpGet",
        summary: "GET",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const signUp = async (email: string): Promise<string> => {
  const inviteCode = await mintInviteCode(handler);
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "password-12345678",
        name: email,
        inviteCode,
      }),
    }),
  );
  expect(res.status).toBe(200);
  const token = res.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");
  return token;
};

const orgIdOf = async (token: string): Promise<string> => {
  const res = await handler(
    new Request(`${BASE}/api/account/me`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { organization: { id: string } };
  return body.organization.id;
};

const addIntegration = (token: string, slug: string) =>
  handler(
    new Request(`${BASE}/api/openapi/specs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spec: { kind: "blob", value: TINY_SPEC },
        slug,
        baseUrl: "",
      }),
    }),
  );

const createConnection = (
  token: string,
  body: {
    owner: "org" | "user";
    name: string;
    integration: string;
    template: string;
    value: string;
  },
) =>
  handler(
    new Request(`${BASE}/api/connections`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

const connectionAddresses = async (token: string): Promise<string[]> => {
  const res = await handler(
    new Request(`${BASE}/api/connections`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as ReadonlyArray<{ address: string }>;
  return body.map((c) => c.address);
};

const runCode = async (token: string, code: string) => {
  const res = await handler(
    new Request(`${BASE}/api/executions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code }),
    }),
  );
  return res;
};

test("multiple accounts share one org but isolate per-user connections", async () => {
  const alice = await signUp("alice@multi.test");
  const bob = await signUp("bob@multi.test");

  // Same single org for both members.
  const aliceOrg = await orgIdOf(alice);
  const bobOrg = await orgIdOf(bob);
  expect(aliceOrg).toBe(bobOrg);

  // The integration is tenant-scoped; register it once.
  expect((await addIntegration(alice, "tiny")).status).toBe(200);

  // Alice attaches a USER-owned connection (private to her) and an ORG-owned
  // connection (shared across the tenant).
  expect(
    (
      await createConnection(alice, {
        owner: "user",
        name: "alice-private",
        integration: "tiny",
        template: "bearer",
        value: "alice-token",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await createConnection(alice, {
        owner: "org",
        name: "team-shared",
        integration: "tiny",
        template: "bearer",
        value: "shared-token",
      })
    ).status,
  ).toBe(200);

  // Alice sees both her user connection and the org connection.
  const aliceConns = await connectionAddresses(alice);
  expect(
    aliceConns.some((a) => a.includes("user") && a.includes(connectionName("alice-private"))),
  ).toBe(true);
  expect(
    aliceConns.some((a) => a.includes("org") && a.includes(connectionName("team-shared"))),
  ).toBe(true);

  // Bob — a different user in the SAME org — sees the org connection but NOT
  // Alice's user-owned one.
  const bobConns = await connectionAddresses(bob);
  expect(bobConns.some((a) => a.includes("org") && a.includes(connectionName("team-shared")))).toBe(
    true,
  );
  expect(bobConns.some((a) => a.includes(connectionName("alice-private")))).toBe(false);
});

test("each account can execute code in its own scoped sandbox", async () => {
  const carol = await signUp("carol@multi.test");
  const res = await runCode(carol, "export default 21 * 2");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; text: string };
  expect(body.status).toBe("completed");
  expect(body.text).toBe("42");
});
