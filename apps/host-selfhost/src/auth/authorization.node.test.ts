import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";
import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import { mintInviteCode } from "../testing/mint-invite";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-authorization-"));
process.env.BETTER_AUTH_SECRET = "authorization-secret-0123456789-abcdefghij";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@authorization.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";
process.env.EXECUTOR_ORG_NAME = "Original Team";
process.env.EXECUTOR_ORG_SLUG = "real-team";

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

const signIn = async (email: string, password: string) => {
  const response = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");
  return { token, cookie: response.headers.get("set-cookie") ?? "" };
};

const signUp = async (email: string) => {
  const inviteCode = await mintInviteCode(handler);
  const response = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "member-password-123",
        name: email,
        inviteCode,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");
  return { token, cookie: response.headers.get("set-cookie") ?? "" };
};

const bearerHeaders = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

const protectedRequest = (token: string, extra: Record<string, string> = {}) =>
  handler(
    new Request(`${BASE}/api/connections`, {
      headers: bearerHeaders(token, extra),
    }),
  );

const initializeMcp = (token: string, path = "/mcp") =>
  handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        ...bearerHeaders(token),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "authorization-test", version: "1" },
        },
      }),
    }),
  );

test("live organization authorization rejects stale membership and bogus URL scopes", async () => {
  const admin = await signIn("admin@authorization.test", "admin-pass-123456");
  const member = await signUp("removed-member@authorization.test");

  const initialMe = await handler(
    new Request(`${BASE}/api/account/me`, { headers: bearerHeaders(member.token) }),
  );
  expect(initialMe.status).toBe(200);
  const initialMeBody = (await json(initialMe)) as {
    organization: { id: string; name: string; slug: string } | null;
  };
  expect(initialMeBody.organization).toMatchObject({ name: "Original Team", slug: "real-team" });
  const organizationId = initialMeBody.organization?.id ?? "";
  expect(organizationId).not.toBe("");

  const rename = await handler(
    new Request(`${BASE}/api/account/name`, {
      method: "PATCH",
      headers: bearerHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Renamed Team" }),
    }),
  );
  expect(rename.status).toBe(200);

  const renamedMe = await handler(
    new Request(`${BASE}/api/account/me`, { headers: bearerHeaders(member.token) }),
  );
  expect(renamedMe.status).toBe(200);
  const renamedMeBody = (await json(renamedMe)) as {
    organization: { id: string; name: string; slug: string } | null;
  };
  expect(renamedMeBody.organization).toMatchObject({ name: "Renamed Team", slug: "real-team" });

  const validScope = await protectedRequest(member.token, {
    [EXECUTOR_ORG_SELECTOR_HEADER]: "real-team",
  });
  expect(validScope.status).toBe(200);

  const validIdScope = await protectedRequest(member.token, {
    [EXECUTOR_ORG_SELECTOR_HEADER]: organizationId,
  });
  expect(validIdScope.status).toBe(200);

  expect((await initializeMcp(member.token, "/real-team/mcp")).status).toBe(200);
  expect((await initializeMcp(member.token, `/${organizationId}/mcp`)).status).toBe(200);
  expect((await initializeMcp(member.token, "/not-this-team/mcp")).status).toBe(404);

  const bogusMe = await handler(
    new Request(`${BASE}/api/account/me`, {
      headers: bearerHeaders(member.token, {
        [EXECUTOR_ORG_SELECTOR_HEADER]: "not-this-team",
      }),
    }),
  );
  expect(bogusMe.status).toBe(200);
  expect((await json(bogusMe)).organization).toBeNull();

  const bogusProtected = await protectedRequest(member.token, {
    [EXECUTOR_ORG_SELECTOR_HEADER]: "not-this-team",
  });
  expect(bogusProtected.status).toBe(403);

  const unauthenticatedRoles = await handler(new Request(`${BASE}/api/account/roles`));
  expect(unauthenticatedRoles.status).toBe(401);

  const roles = await handler(
    new Request(`${BASE}/api/account/roles`, { headers: bearerHeaders(member.token) }),
  );
  expect(roles.status).toBe(200);

  const createKey = await handler(
    new Request(`${BASE}/api/account/api-keys`, {
      method: "POST",
      headers: bearerHeaders(member.token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Surviving key" }),
    }),
  );
  expect(createKey.status).toBe(200);
  const key = (await json(createKey)) as { id: string; value: string };
  expect((await protectedRequest(key.value)).status).toBe(200);

  const listMembers = await handler(
    new Request(`${BASE}/api/account/members`, { headers: bearerHeaders(admin.token) }),
  );
  expect(listMembers.status).toBe(200);
  const listMembersBody = (await json(listMembers)) as {
    members: ReadonlyArray<{ id: string; email: string }>;
  };
  const membership = listMembersBody.members.find(
    (candidate) => candidate.email === "removed-member@authorization.test",
  );
  expect(membership).toBeDefined();

  const remove = await handler(
    new Request(`${BASE}/api/account/members/${membership?.id ?? "missing"}`, {
      method: "DELETE",
      headers: bearerHeaders(admin.token),
    }),
  );
  expect(remove.status).toBe(200);

  expect((await protectedRequest(member.token)).status).toBe(403);
  expect((await protectedRequest(key.value)).status).toBe(403);

  const removedMembers = await handler(
    new Request(`${BASE}/api/account/members`, { headers: bearerHeaders(member.token) }),
  );
  expect(removedMembers.status).toBe(403);

  const removedRoles = await handler(
    new Request(`${BASE}/api/account/roles`, { headers: bearerHeaders(member.token) }),
  );
  expect(removedRoles.status).toBe(403);

  const removedMe = await handler(
    new Request(`${BASE}/api/account/me`, { headers: bearerHeaders(member.token) }),
  );
  expect(removedMe.status).toBe(200);
  expect((await json(removedMe)).organization).toBeNull();

  const approval = await handler(
    new Request(`${BASE}/api/mcp-sessions/not-a-session`, {
      headers: { cookie: member.cookie },
    }),
  );
  expect(approval.status).toBe(401);
  expect((await initializeMcp(member.token)).status).toBe(401);
});

test("server-side API key and session revocation take effect on the next request", async () => {
  const member = await signUp("revoked-credential@authorization.test");

  const createKey = await handler(
    new Request(`${BASE}/api/account/api-keys`, {
      method: "POST",
      headers: bearerHeaders(member.token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Short lived key" }),
    }),
  );
  expect(createKey.status).toBe(200);
  const key = (await json(createKey)) as { id: string; value: string };
  expect((await protectedRequest(key.value)).status).toBe(200);

  const revokeKey = await handler(
    new Request(`${BASE}/api/account/api-keys/${key.id}`, {
      method: "DELETE",
      headers: bearerHeaders(member.token),
    }),
  );
  expect(revokeKey.status).toBe(200);
  expect((await protectedRequest(key.value)).status).toBe(401);

  const revokeSessions = await handler(
    new Request(`${BASE}/api/auth/revoke-sessions`, {
      method: "POST",
      headers: bearerHeaders(member.token),
    }),
  );
  expect(revokeSessions.status).toBe(200);
  expect((await protectedRequest(member.token)).status).toBe(401);
});
