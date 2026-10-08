// Membership is required on every authenticated request. Removing a member
// from the instance organization denies their very next request on the API
// plane, the account plane, the browser-approval plane, an OPEN MCP session
// and a NEW MCP session — for every credential shape self-host accepts: API
// key bearer, bearer session token, session cookie, and mcp() OAuth access
// token. Re-adding the member restores access on the next request, and a role
// change (admin -> member) takes effect on the next request.
//
// The first test is the release gate written by the security review of PR #21
// (carlsonhouse-mcp #39), kept verbatim in its six denial assertions.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-member-revocation-"));
process.env.BETTER_AUTH_SECRET = "member-revocation-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@revocation.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

// Built from `makeSelfHostApp` (not `makeSelfHostApiHandler`) so the test can
// re-add a removed member through Better Auth's server-only `addMember`.
const { makeSelfHostApp } = await import("../app");
const app = await makeSelfHostApp();
const web = app.toWebHandler();
const handler = web.handler;
afterAll(async () => {
  await web.dispose();
  await app.closeDb();
});

const BASE = "http://localhost:4788";
const DENIED = [401, 403];

interface Identity {
  readonly token: string;
  readonly cookie: string;
}

const identityFrom = (res: Response): Identity => ({
  token: res.headers.get("set-auth-token") ?? "",
  cookie: res.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
});

const signUp = async (email: string): Promise<Identity> => {
  const inviteCode = await mintInviteCode(handler);
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-12345678", name: email, inviteCode }),
    }),
  );
  expect(res.status).toBe(200);
  return identityFrom(res);
};

const signInBootstrap = async (): Promise<Identity> => {
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
      }),
    }),
  );
  expect(res.status).toBe(200);
  return identityFrom(res);
};

const withAuth = (token: string, path: string, init?: RequestInit) =>
  handler(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        authorization: `Bearer ${token}`,
      },
    }),
  );

const withCookie = (cookie: string, path: string, init?: RequestInit) =>
  handler(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie },
    }),
  );

const status = async (pending: Response | Promise<Response>): Promise<number> => {
  const res = await pending;
  await res.text();
  return res.status;
};

/** Identity-seam probe on the API plane (execution-stack middleware). */
const apiProbe = (token: string) => status(withAuth(token, "/api/policies"));

/** Org-write gate: POST /api/policies with owner=org needs orgRole admin. */
const orgWriteProbe = (token: string, pattern: string) =>
  status(
    withAuth(token, "/api/policies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "org", pattern, action: "block" }),
    }),
  );

const createKey = async (token: string, name: string) => {
  const res = await withAuth(token, "/api/account/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; value: string };
};

const mcp = (headers: Record<string, string>, body: unknown, sessionId?: string) =>
  handler(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "member-revocation", version: "1" },
  },
};

const initSession = async (headers: Record<string, string>): Promise<string> => {
  const res = await mcp(headers, initBody);
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id") ?? "";
  expect(sessionId).not.toBe("");
  await res.text();
  await status(mcp(headers, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId));
  return sessionId;
};

const listTools = (headers: Record<string, string>, sessionId: string) =>
  status(mcp(headers, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId));

const newSession = (headers: Record<string, string>) => status(mcp(headers, initBody));

const members = async (adminToken: string) => {
  const res = await withAuth(adminToken, "/api/account/members");
  expect(res.status).toBe(200);
  return (await res.json()) as {
    members: ReadonlyArray<{ id: string; userId: string; email: string; role: string }>;
  };
};

const memberRow = async (adminToken: string, email: string) => {
  const row = (await members(adminToken)).members.find((m) => m.email === email);
  expect(row).toBeDefined();
  return row!;
};

const removeMember = async (adminToken: string, membershipId: string) => {
  const res = await withAuth(
    adminToken,
    `/api/account/members/${encodeURIComponent(membershipId)}`,
    {
      method: "DELETE",
    },
  );
  expect(await status(res)).toBe(200);
};

const setRole = async (adminToken: string, membershipId: string, roleSlug: "admin" | "member") => {
  const res = await withAuth(
    adminToken,
    `/api/account/members/${encodeURIComponent(membershipId)}/role`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleSlug }),
    },
  );
  expect(await status(res)).toBe(200);
};

/** Re-add a removed user through Better Auth's server-only route (no session). */
const reAddMember = async (userId: string) => {
  await app.betterAuth.auth.api.addMember({
    body: { userId, organizationId: app.betterAuth.organizationId, role: "member" },
  });
};

const b64url = (buf: Uint8Array): string =>
  btoa(String.fromCharCode(...buf))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

/** A real mcp() OAuth access token: register -> authorize -> consent -> token. */
const oauthToken = async (cookie: string): Promise<string> => {
  const reg = await handler(
    new Request(`${BASE}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "member-revocation",
        redirect_uris: ["http://localhost:9999/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    }),
  );
  expect([200, 201]).toContain(reg.status);
  const clientId = String((await json(reg)).client_id);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const authorizeUrl = new URL(`${BASE}/api/auth/mcp/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://localhost:9999/callback",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "openid",
  }).toString();
  const authorize = await handler(
    new Request(authorizeUrl, { headers: { cookie }, redirect: "manual" }),
  );
  expect(authorize.status).toBe(302);
  const consentRedirect = new URL(authorize.headers.get("location") ?? "", BASE);
  const consentCode = consentRedirect.searchParams.get("consent_code") ?? "";
  expect(consentCode).not.toBe("");
  const consent = await handler(
    new Request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    }),
  );
  expect(consent.status).toBe(200);
  const code =
    new URL(String((await json(consent)).redirectURI ?? "")).searchParams.get("code") ?? "";
  const token = await handler(
    new Request(`${BASE}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:9999/callback",
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    }),
  );
  expect(token.status).toBe(200);
  return String((await json(token)).access_token);
};

// ---------------------------------------------------------------------------

test("release gate: removed members lose API and existing/new MCP access immediately", async () => {
  const admin = await signInBootstrap();
  const email = "removed-release-gate@revocation.test";
  const member = await signUp(email);
  const key = await createKey(member.token, "release gate");
  const row = await memberRow(admin.token, email);
  const credentials = [
    { label: "apiKey", token: key.value, sid: await initSession(bearer(key.value)) },
    { label: "session", token: member.token, sid: await initSession(bearer(member.token)) },
  ];
  for (const credential of credentials) {
    expect(await apiProbe(credential.token)).toBe(200);
    expect(await listTools(bearer(credential.token), credential.sid)).toBe(200);
  }
  await removeMember(admin.token, row.id);
  for (const credential of credentials) {
    const apiStatus = await apiProbe(credential.token);
    const existingStatus = await listTools(bearer(credential.token), credential.sid);
    const freshStatus = await newSession(bearer(credential.token));
    expect.soft(DENIED, `${credential.label}: API access after removal`).toContain(apiStatus);
    expect
      .soft(DENIED, `${credential.label}: existing MCP access after removal`)
      .toContain(existingStatus);
    expect.soft(DENIED, `${credential.label}: new MCP access after removal`).toContain(freshStatus);
  }
  // Re-adding the member restores access on the next request, with the SAME
  // credentials: nothing was revoked, membership alone decides.
  await reAddMember(row.userId);
  for (const credential of credentials) {
    expect(await apiProbe(credential.token)).toBe(200);
    expect(await newSession(bearer(credential.token))).toBe(200);
  }
});

test("session cookie: removal denies the API, account, approval and MCP planes; re-add restores", async () => {
  const admin = await signInBootstrap();
  const email = "cookie@revocation.test";
  const member = await signUp(email);
  const row = await memberRow(admin.token, email);
  const headers = { cookie: member.cookie };
  const sid = await initSession(headers);

  expect(await status(withCookie(member.cookie, "/api/policies"))).toBe(200);
  expect(await status(withCookie(member.cookie, "/api/account/me"))).toBe(200);
  expect(await status(withCookie(member.cookie, "/api/account/api-keys"))).toBe(200);
  expect(await status(withCookie(member.cookie, "/api/mcp-sessions/none/paused"))).toBe(404);
  expect(await listTools(headers, sid)).toBe(200);

  await removeMember(admin.token, row.id);

  expect(DENIED).toContain(await status(withCookie(member.cookie, "/api/policies")));
  expect(await status(withCookie(member.cookie, "/api/account/me"))).toBe(401);
  expect(await status(withCookie(member.cookie, "/api/account/api-keys"))).toBe(403);
  expect(
    await status(
      withCookie(member.cookie, "/api/account/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "after removal" }),
      }),
    ),
  ).toBe(403);
  expect(await status(withCookie(member.cookie, "/api/mcp-sessions/none/paused"))).toBe(403);
  expect(DENIED).toContain(await listTools(headers, sid));
  expect(DENIED).toContain(await newSession(headers));

  await reAddMember(row.userId);
  expect(await status(withCookie(member.cookie, "/api/policies"))).toBe(200);
  expect(await status(withCookie(member.cookie, "/api/account/me"))).toBe(200);
  expect(await newSession(headers)).toBe(200);
});

test("OAuth bearer: removal denies the open and new MCP sessions; re-add restores", async () => {
  const admin = await signInBootstrap();
  const email = "oauth@revocation.test";
  const member = await signUp(email);
  const row = await memberRow(admin.token, email);
  const headers = bearer(await oauthToken(member.cookie));
  const sid = await initSession(headers);
  expect(await listTools(headers, sid)).toBe(200);

  await removeMember(admin.token, row.id);
  expect(DENIED).toContain(await listTools(headers, sid));
  expect(DENIED).toContain(await newSession(headers));

  await reAddMember(row.userId);
  expect(await newSession(headers)).toBe(200);
});

test("role change admin -> member takes effect on the next request for every credential", async () => {
  const admin = await signInBootstrap();
  const email = "downgrade@revocation.test";
  const member = await signUp(email);
  const key = await createKey(member.token, "downgrade");
  const row = await memberRow(admin.token, email);

  expect(await orgWriteProbe(member.token, "downgrade-before.*")).toBe(403);
  await setRole(admin.token, row.id, "admin");
  expect(await orgWriteProbe(member.token, "downgrade-session.*")).toBe(200);
  expect(await orgWriteProbe(key.value, "downgrade-key.*")).toBe(200);
  await setRole(admin.token, row.id, "member");
  expect(await orgWriteProbe(member.token, "downgrade-after-session.*")).toBe(403);
  expect(await orgWriteProbe(key.value, "downgrade-after-key.*")).toBe(403);
  // Still a member: reads keep working.
  expect(await apiProbe(member.token)).toBe(200);
  expect(await apiProbe(key.value)).toBe(200);
});
