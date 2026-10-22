import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { createInviteMinter } from "../testing/mint-invite";

// Real Better Auth path: set a secret + bootstrap admin before importing.
// Better Auth skips origin checks in test mode by default; this suite exercises
// the production check so the trusted-origin cases below cover the real path.
process.env.NODE_ENV = "production";
process.env.TEST = "false";
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-auth-"));
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-abcdefghijklmnop-qrstuv";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@test.local";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-password-123";
process.env.EXECUTOR_DISABLE_AUTH_RATE_LIMIT = "true";
process.env.EXECUTOR_WEB_BASE_URL = "https://executor.example.com";
process.env.EXECUTOR_TRUSTED_ORIGINS = "http://executor.home.arpa:4788";
process.env.EXECUTOR_DELEGATED_CREDENTIAL_ISSUANCE = "true";

const { makeSelfHostApiHandler } = await import("../app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

// Keep one admin session across invitation setup; production login limits stay enabled.
const mintInvite = await createInviteMinter(handler);

const BASE = "http://localhost:4788";

test("an HTTP trusted alias receives a usable session cookie with an HTTPS canonical URL", async () => {
  const alias = "http://executor.home.arpa:4788";
  const signIn = await handler(
    new Request(`${alias}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: alias,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        email: "admin@test.local",
        password: "admin-password-123",
      }),
    }),
  );
  expect(signIn.status).toBe(200);
  const sessionCookie = signIn.headers.get("set-cookie");
  expect(sessionCookie).toContain("better-auth.session_token=");
  expect(sessionCookie).not.toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
  expect(sessionCookie).not.toContain("__Secure-");
});

test("an explicitly trusted browser alias can sign up without changing the canonical base URL", async () => {
  const alias = "http://executor.home.arpa:4788";
  const inviteCode = await mintInvite();
  const signUp = await handler(
    new Request(`${alias}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: alias,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        email: "trusted-alias@test.local",
        password: "member-password-123",
        name: "Trusted Alias",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
});

test("an unlisted browser alias remains blocked", async () => {
  const alias = "http://untrusted.home.arpa:4788";
  const inviteCode = await mintInvite();
  const signUp = await handler(
    new Request(`${alias}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: alias,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        email: "untrusted-alias@test.local",
        password: "member-password-123",
        name: "Untrusted Alias",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(403);
});

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
  const inviteCode = await mintInvite();
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
  const humanBearerTools = await handler(
    new Request(`${BASE}/api/tools`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(humanBearerTools.status).toBe(200);
});

test("self-host API keys are not capped by Better Auth's default request limit", async () => {
  // This test exercises API-key requests, so use the seeded account instead
  // of consuming another sign-up attempt in the production rate-limit window.
  const signIn = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@test.local", password: "admin-password-123" }),
    }),
  );
  expect(signIn.status).toBe(200);
  const token = signIn.headers.get("set-auth-token");
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

test("delegation scope options return a target-scoped named catalog", async () => {
  const origin = "http://executor.home.arpa:4788";
  const signIn = await handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "admin@test.local", password: "admin-password-123" }),
    }),
  );
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const response = await handler(
    new Request(`${origin}/api/account/delegated-credentials/scope-options`, {
      headers: { cookie: cookie!, origin },
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    actions: string[];
    toolkits: Array<{ id: string; slug: string; name: string }>;
    connections: Array<{
      id: string;
      label: string;
      description: string | null;
      toolkitIds: string[];
    }>;
    maxExpiresAt: string;
  };
  expect(body.actions).toEqual(["discover", "invoke"]);
  expect(body.toolkits).toEqual(expect.any(Array));
  expect(body.connections).toEqual(expect.any(Array));
  expect(Number.isFinite(Date.parse(body.maxExpiresAt))).toBe(true);
  expect(Date.parse(body.maxExpiresAt)).toBeGreaterThan(Date.now());
});

test("origin-less browser reads can list delegation targets while mutations stay CSRF-bound", async () => {
  const origin = "http://executor.home.arpa:4788";
  const signIn = await handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "admin@test.local", password: "admin-password-123" }),
    }),
  );
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();

  const targets = await handler(
    new Request(`${origin}/api/account/delegated-credentials/targets`, {
      headers: { cookie: cookie! },
    }),
  );
  expect(targets.status).toBe(200);

  const mutation = await handler(
    new Request(`${origin}/api/account/delegated-credentials/keys`, {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({
        label: "originless mutation",
        target: { kind: "verified-human", id: "self" },
        scope: { scopes: ["discover"], toolkitIds: [], connectionIds: [] },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    }),
  );
  expect(mutation.status).toBe(403);
});

test("an admin-issued provider key is owned by the selected member", async () => {
  const origin = "http://executor.home.arpa:4788";
  const signIn = await handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "admin@test.local", password: "admin-password-123" }),
    }),
  );
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const humanHeaders = { cookie: cookie!, origin, "content-type": "application/json" };
  const targetsResponse = await handler(
    new Request(`${origin}/api/account/delegated-credentials/targets`, {
      headers: humanHeaders,
    }),
  );
  expect(targetsResponse.status).toBe(200);
  const targets = (await targetsResponse.json()) as {
    targets: Array<{ id: string; email: string; isCurrentUser: boolean }>;
  };
  const member = targets.targets.find((target) => target.email === "member@test.local");
  expect(member).toBeTruthy();

  const scope = { scopes: ["discover", "invoke"], toolkitIds: [], connectionIds: [] } as const;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const createdResponse = await handler(
    new Request(`${origin}/api/account/delegated-credentials/keys`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({
        label: "member-admin-issued-machine",
        target: { kind: "verified-human", id: member!.id },
        scope,
        expiresAt,
      }),
    }),
  );
  expect(createdResponse.status).toBe(200);
  const created = (await createdResponse.json()) as {
    credential: { id: string };
    value: string;
  };
  expect(created.value).toBeTruthy();

  const { createClient } = await import("@libsql/client");
  const db = createClient({
    url: `file:${join(process.env.EXECUTOR_DATA_DIR!, "data.db")}`,
  });
  const rows = (
    await db.execute({
      sql: "SELECT referenceId, metadata FROM apikey WHERE metadata LIKE ?",
      args: [`%${created.credential.id}%`],
    })
  ).rows.flatMap((row) => {
    const referenceId = row.referenceId;
    if (typeof referenceId !== "string") return [];
    const metadata = row.metadata;
    return [{ referenceId, metadata: typeof metadata === "string" ? metadata : null }];
  });
  const bound = rows.find((row) => row.metadata?.includes(created.credential.id));
  expect(bound?.referenceId).toBe(member!.id);
  const notifications = (
    await db.execute({
      sql: "SELECT target_subject FROM delegation_notification WHERE credential_id = ?",
      args: [created.credential.id],
    })
  ).rows.flatMap((row) => {
    const targetSubject = row.target_subject;
    return typeof targetSubject === "string" ? [targetSubject] : [];
  });
  expect(notifications).toContain(member!.id);
  db.close();

  const revoke = await handler(
    new Request(`${origin}/api/account/delegated-credentials/${created.credential.id}`, {
      method: "DELETE",
      headers: humanHeaders,
    }),
  );
  expect(revoke.status).toBe(200);
});

test("a Better Auth API key completes delegated proof, scopes HTTP, and revokes live", async () => {
  const origin = "http://executor.home.arpa:4788";
  const signIn = await handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "admin@test.local", password: "admin-password-123" }),
    }),
  );
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const humanHeaders = {
    cookie: cookie!,
    origin,
    "content-type": "application/json",
  };
  const keyResponse = await handler(
    new Request(`${origin}/api/account/api-keys`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ name: "delegation-machine" }),
    }),
  );
  expect(keyResponse.status).toBe(200);
  const keyBody = (await keyResponse.json()) as { value: string };
  const scope = { scopes: ["discover", "invoke"], toolkitIds: [], connectionIds: [] } as const;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const start = await handler(
    new Request(`${origin}/api/account/delegated-credentials/challenges`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({
        adapter: "better-auth-api-key",
        label: "delegation-machine",
        target: { kind: "self" },
        scope,
        expiresAt,
      }),
    }),
  );
  expect(start.status).toBe(200);
  const challenge = (await start.json()) as { id: string; nonce: string };
  const machineHeaders = {
    authorization: `Bearer ${keyBody.value}`,
    "content-type": "application/json",
  };
  const proof = await handler(
    new Request(`${origin}/api/account/delegated-credentials/challenges/${challenge.id}/proof`, {
      method: "POST",
      headers: machineHeaders,
      body: JSON.stringify({ nonce: challenge.nonce, proofType: "api-key" }),
    }),
  );
  expect(proof.status).toBe(200);
  const consent = await handler(
    new Request(`${origin}/api/account/delegated-credentials/challenges/${challenge.id}/consent`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ scope, expiresAt }),
    }),
  );
  expect(consent.status).toBe(200);

  // Proof-bound ordinary Better Auth PATs keep their existing token format.
  // They still must not become the owner's unrestricted Better Auth session at
  // raw auth routes when a valid browser cookie is present.
  const boundRawApiKeyCreate = await handler(
    new Request(`${origin}/api/auth/api-key/create`, {
      method: "POST",
      headers: {
        ...machineHeaders,
        cookie: cookie!,
      },
      body: JSON.stringify({ name: "bound-must-not-mint" }),
    }),
  );
  expect(boundRawApiKeyCreate.status).toBe(403);
  const boundRawOrganizationUpdate = await handler(
    new Request(`${origin}/api/auth/organization/update`, {
      method: "POST",
      headers: { ...machineHeaders, cookie: cookie! },
      body: JSON.stringify({ data: { name: "bound-must-not-update" } }),
    }),
  );
  expect(boundRawOrganizationUpdate.status).toBe(403);

  // Better Auth returns `{ valid: false, key: null }` for a disabled key. An
  // explicit invalid bearer must fail closed at every management boundary;
  // otherwise the valid browser cookie would become an unrestricted fallback.
  const providerKeyList = await handler(
    new Request(`${origin}/api/auth/api-key/list`, { headers: { cookie: cookie!, origin } }),
  );
  expect(providerKeyList.status).toBe(200);
  const providerKey = (
    (await providerKeyList.json()) as { apiKeys: Array<{ id: string; name: string }> }
  ).apiKeys.find((key) => key.name === "delegation-machine");
  expect(providerKey).toBeTruthy();
  const providerKeyId = providerKey!.id;
  const disableProviderKey = await handler(
    new Request(`${origin}/api/auth/api-key/update`, {
      method: "POST",
      headers: { cookie: cookie!, origin, "content-type": "application/json" },
      body: JSON.stringify({ keyId: providerKeyId, enabled: false }),
    }),
  );
  expect(disableProviderKey.status).toBe(200);
  const disabledRawApiKeyCreate = await handler(
    new Request(`${origin}/api/auth/api-key/create`, {
      method: "POST",
      headers: { ...machineHeaders, cookie: cookie! },
      body: JSON.stringify({ name: "disabled-bound-must-not-mint" }),
    }),
  );
  expect(disabledRawApiKeyCreate.status).toBe(403);
  const disabledRawOrganizationUpdate = await handler(
    new Request(`${origin}/api/auth/organization/update`, {
      method: "POST",
      headers: { ...machineHeaders, cookie: cookie! },
      body: JSON.stringify({ data: { name: "disabled-bound-must-not-update" } }),
    }),
  );
  expect(disabledRawOrganizationUpdate.status).toBe(403);
  const disabledAccountApiKeyCreate = await handler(
    new Request(`${origin}/api/account/api-keys`, {
      method: "POST",
      headers: { ...machineHeaders, cookie: cookie!, origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "disabled-bound-must-not-mint-account" }),
    }),
  );
  // The account router reports a denied bearer as 401; it must not use the
  // valid cookie to mint a new unrestricted key.
  expect(disabledAccountApiKeyCreate.status).toBe(401);
  const disabledBareTools = await handler(
    new Request(`${origin}/api/tools`, { headers: machineHeaders }),
  );
  expect(disabledBareTools.status).toBe(401);
  const enableProviderKey = await handler(
    new Request(`${origin}/api/auth/api-key/update`, {
      method: "POST",
      headers: { cookie: cookie!, origin, "content-type": "application/json" },
      body: JSON.stringify({ keyId: providerKeyId, enabled: true }),
    }),
  );
  expect(enableProviderKey.status).toBe(200);

  // `/tools` is an explicitly delegated execution path; integrations is a
  // management path and must be refused before its handler runs.
  const tools = await handler(new Request(`${origin}/api/tools`, { headers: machineHeaders }));
  expect(tools.status).toBe(200);
  const integrations = await handler(
    new Request(`${origin}/api/integrations`, { headers: machineHeaders }),
  );
  expect(integrations.status).toBe(403);

  const credentials = await handler(
    new Request(`${origin}/api/account/delegated-credentials`, { headers: humanHeaders }),
  );
  expect(credentials.status).toBe(200);
  const credentialBody = (await credentials.json()) as {
    credentials: Array<{ id: string }>;
  };
  expect(credentialBody.credentials).toHaveLength(1);
  const revoke = await handler(
    new Request(
      `${origin}/api/account/delegated-credentials/${credentialBody.credentials[0]!.id}`,
      { method: "DELETE", headers: humanHeaders },
    ),
  );
  expect(revoke.status).toBe(200);
  const revokedRawApiKeyCreate = await handler(
    new Request(`${origin}/api/auth/api-key/create`, {
      method: "POST",
      headers: {
        ...machineHeaders,
        cookie: cookie!,
      },
      body: JSON.stringify({ name: "revoked-bound-must-not-mint" }),
    }),
  );
  expect(revokedRawApiKeyCreate.status).toBe(403);
  const revokedRawOrganizationUpdate = await handler(
    new Request(`${origin}/api/auth/organization/update`, {
      method: "POST",
      headers: { ...machineHeaders, cookie: cookie! },
      body: JSON.stringify({ data: { name: "revoked-bound-must-not-update" } }),
    }),
  );
  expect(revokedRawOrganizationUpdate.status).toBe(403);
  const afterRevoke = await handler(
    new Request(`${origin}/api/tools`, { headers: { ...machineHeaders, cookie: cookie! } }),
  );
  expect(afterRevoke.status).toBe(401);
  const afterRevokeBare = await handler(
    new Request(`${origin}/api/tools`, { headers: machineHeaders }),
  );
  expect(afterRevokeBare.status).toBe(401);

  // Deleting the provider row produces the same invalid verifier result as a
  // disabled key. It must remain unable to fall through to this valid cookie.
  const deleteProviderKey = await handler(
    new Request(`${origin}/api/auth/api-key/delete`, {
      method: "POST",
      headers: { cookie: cookie!, origin, "content-type": "application/json" },
      body: JSON.stringify({ keyId: providerKeyId }),
    }),
  );
  expect(deleteProviderKey.status).toBe(200);
  const deletedRawApiKeyCreate = await handler(
    new Request(`${origin}/api/auth/api-key/create`, {
      method: "POST",
      headers: { ...machineHeaders, cookie: cookie! },
      body: JSON.stringify({ name: "deleted-bound-must-not-mint" }),
    }),
  );
  expect(deletedRawApiKeyCreate.status).toBe(403);
  const deletedAccountApiKeyCreate = await handler(
    new Request(`${origin}/api/account/api-keys`, {
      method: "POST",
      headers: { ...machineHeaders, cookie: cookie!, origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "deleted-bound-must-not-mint-account" }),
    }),
  );
  expect(deletedAccountApiKeyCreate.status).toBe(401);
  const deletedBareTools = await handler(
    new Request(`${origin}/api/tools`, { headers: machineHeaders }),
  );
  expect(deletedBareTools.status).toBe(401);
});

test("a provider-issued Better Auth delegation key reaches HTTP and revokes without fallback", async () => {
  const origin = "http://executor.home.arpa:4788";
  const signIn = await handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "admin@test.local", password: "admin-password-123" }),
    }),
  );
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const humanHeaders = { cookie: cookie!, origin, "content-type": "application/json" };
  const scope = { scopes: ["discover", "invoke"], toolkitIds: [], connectionIds: [] } as const;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const createdResponse = await handler(
    new Request(`${origin}/api/account/delegated-credentials/keys`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({
        label: "provider-issued-machine",
        target: { kind: "self" },
        scope,
        expiresAt,
      }),
    }),
  );
  expect(createdResponse.status).toBe(200);
  const created = (await createdResponse.json()) as {
    credential: { id: string; reference?: { kind?: string } };
    value: string;
  };
  expect(created.value).toBeTruthy();
  expect(created.credential.reference?.kind).toBe("local-key");
  const machineHeaders = { authorization: `Bearer ${created.value}` };

  const rawApiKeyCreate = await handler(
    new Request(`${origin}/api/auth/api-key/create`, {
      method: "POST",
      headers: {
        ...machineHeaders,
        cookie: humanHeaders.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "must-not-mint" }),
    }),
  );
  expect(rawApiKeyCreate.status).toBe(403);

  const rawOrganizationUpdate = await handler(
    new Request(`${origin}/api/auth/organization/update`, {
      method: "POST",
      headers: { ...machineHeaders, "content-type": "application/json" },
      body: JSON.stringify({ data: { name: "must-not-update" } }),
    }),
  );
  expect(rawOrganizationUpdate.status).toBe(403);

  const accountApiKeyCreate = await handler(
    new Request(`${origin}/api/account/api-keys`, {
      method: "POST",
      headers: { ...machineHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "must-not-mint-account" }),
    }),
  );
  expect(accountApiKeyCreate.status).toBe(401);

  expect(
    (await handler(new Request(`${origin}/api/tools`, { headers: machineHeaders }))).status,
  ).toBe(200);
  expect(
    (await handler(new Request(`${origin}/api/integrations`, { headers: machineHeaders }))).status,
  ).toBe(403);

  const revoked = await handler(
    new Request(`${origin}/api/account/delegated-credentials/${created.credential.id}`, {
      method: "DELETE",
      headers: humanHeaders,
    }),
  );
  expect(revoked.status).toBe(200);
  expect(
    (
      await handler(
        new Request(`${origin}/api/tools`, { headers: { ...machineHeaders, cookie: cookie! } }),
      )
    ).status,
  ).toBe(401);
  const revokedRawAuth = await handler(
    new Request(`${origin}/api/auth/api-key/create`, {
      method: "POST",
      headers: {
        ...machineHeaders,
        cookie: cookie!,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "revoked-must-not-mint" }),
    }),
  );
  expect(revokedRawAuth.status).toBe(403);
});

test("a current member can invoke its own delegated grant", async () => {
  // The preceding sign-up test creates this non-admin member. Keeping this
  // path separate from the bootstrap-admin flow proves the machine actor is
  // resolved to its live API-key owner before self-authorization is decided.
  const origin = "http://executor.home.arpa:4788";
  const signIn = await handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "member@test.local", password: "member-password-123" }),
    }),
  );
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const humanHeaders = { cookie: cookie!, origin, "content-type": "application/json" };
  const keyResponse = await handler(
    new Request(`${origin}/api/account/api-keys`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ name: "member-delegation-machine" }),
    }),
  );
  expect(keyResponse.status).toBe(200);
  const keyBody = (await keyResponse.json()) as { value: string };
  const scope = { scopes: ["discover", "invoke"], toolkitIds: [], connectionIds: [] } as const;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const start = await handler(
    new Request(`${origin}/api/account/delegated-credentials/challenges`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({
        adapter: "better-auth-api-key",
        label: "member-delegation-machine",
        target: { kind: "self" },
        scope,
        expiresAt,
      }),
    }),
  );
  expect(start.status).toBe(200);
  const challenge = (await start.json()) as { id: string; nonce: string };
  const machineHeaders = { authorization: `Bearer ${keyBody.value}` };
  const proof = await handler(
    new Request(`${origin}/api/account/delegated-credentials/challenges/${challenge.id}/proof`, {
      method: "POST",
      headers: { ...machineHeaders, "content-type": "application/json" },
      body: JSON.stringify({ nonce: challenge.nonce, proofType: "api-key" }),
    }),
  );
  expect(proof.status).toBe(200);
  const consent = await handler(
    new Request(`${origin}/api/account/delegated-credentials/challenges/${challenge.id}/consent`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ scope, expiresAt }),
    }),
  );
  expect(consent.status).toBe(200);
  expect(
    (await handler(new Request(`${origin}/api/tools`, { headers: machineHeaders }))).status,
  ).toBe(200);
});

test("a reserved local key cannot fall through to a browser session", async () => {
  const origin = "http://executor.home.arpa:4788";
  const signIn = await handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "admin@test.local", password: "admin-password-123" }),
    }),
  );
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const reservedKey = `key_${"0".repeat(32)}.${"0".repeat(64)}`;
  const response = await handler(
    new Request(`${origin}/api/tools`, {
      headers: { authorization: `Bearer ${reservedKey}`, cookie: cookie! },
    }),
  );
  expect(response.status).toBe(401);

  const keyResponse = await handler(
    new Request(`${origin}/api/account/api-keys`, {
      method: "POST",
      headers: { cookie: cookie!, origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "revoked-provider-key" }),
    }),
  );
  expect(keyResponse.status).toBe(200);
  const keyBody = (await keyResponse.json()) as { id: string; value: string };
  const revoke = await handler(
    new Request(`${origin}/api/account/api-keys/${keyBody.id}`, {
      method: "DELETE",
      headers: { cookie: cookie!, origin },
    }),
  );
  expect(revoke.status).toBe(200);
  const revokedResponse = await handler(
    new Request(`${origin}/api/tools`, {
      headers: { authorization: `Bearer ${keyBody.value}`, cookie: cookie! },
    }),
  );
  expect(revokedResponse.status).toBe(401);
});

test("an unauthenticated request is rejected with 401", async () => {
  const res = await handler(new Request("http://localhost/api/account/me"));
  expect(res.status).toBe(401);
});
