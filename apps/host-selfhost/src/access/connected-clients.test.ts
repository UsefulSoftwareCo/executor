import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

// ---------------------------------------------------------------------------
// The connected-clients plane lists and revokes the credentials that act as a
// user — so its refusals matter more than its answers. Boots the real app:
// real Better Auth, real MCP OAuth tokens, real sessions.
// ---------------------------------------------------------------------------

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-access-"));
process.env.BETTER_AUTH_SECRET = "access-secret-0123456789-abcdefghij-klmnopq";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "owner@access.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "owner-pass-123456";

let handler!: (request: Request) => Promise<Response>;
let dispose: () => Promise<void> = async () => {};

beforeAll(async () => {
  const { makeSelfHostApiHandler } = await import("../app");
  const app = await makeSelfHostApiHandler();
  handler = app.handler;
  dispose = app.dispose;
});
afterAll(() => dispose());

const BASE = "http://localhost:4788";
const REDIRECT = "http://localhost:9999/callback";

interface Login {
  readonly cookie: string;
  readonly token: string;
}

const firstCookie = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

const signIn = async (email: string, password: string): Promise<Login> => {
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(res.status).toBe(200);
  return { cookie: firstCookie(res), token: res.headers.get("set-auth-token") ?? "" };
};

const signUpMember = async (email: string): Promise<Login> => {
  const inviteCode = await mintInviteCode(handler, "member");
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: "member-pass-123456", name: email, inviteCode }),
    }),
  );
  expect(res.status).toBe(200);
  return { cookie: firstCookie(res), token: res.headers.get("set-auth-token") ?? "" };
};

const b64url = (buf: Uint8Array): string =>
  btoa(String.fromCharCode(...buf))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** Register an MCP client and walk the real OAuth + consent flow as `cookie`. */
const connectOAuthClient = async (
  cookie: string,
  clientName: string,
): Promise<{
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}> => {
  const reg = await handler(
    new Request(`${BASE}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect([200, 201]).toContain(reg.status);
  const clientId = String(((await reg.json()) as { client_id: string }).client_id);

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const authorizeUrl = new URL(`${BASE}/api/auth/mcp/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid offline_access",
  }).toString();
  const authorize = await handler(
    new Request(authorizeUrl, { headers: { cookie }, redirect: "manual" }),
  );
  expect(authorize.status).toBe(302);
  const consentCode =
    new URL(authorize.headers.get("location") ?? "", BASE).searchParams.get("consent_code") ?? "";
  const consent = await handler(
    new Request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    }),
  );
  expect(consent.status).toBe(200);
  const redirectURI = String(((await consent.json()) as { redirectURI: string }).redirectURI);
  const code = new URL(redirectURI).searchParams.get("code") ?? "";

  const token = await handler(
    new Request(`${BASE}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    }),
  );
  expect(token.status).toBe(200);
  const tokens = (await token.json()) as { access_token: string; refresh_token?: string };
  return { clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? "" };
};

/** An MCP `initialize` with the token — 200 while it is valid, 401 once revoked. */
const mcpInitialize = (accessToken: string) =>
  handler(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
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
          clientInfo: { name: "t", version: "1" },
        },
      }),
    }),
  );

const listClients = (headers: Record<string, string>) =>
  handler(new Request(`${BASE}/api/access/clients`, { headers }));

const revoke = (path: string, headers: Record<string, string>) =>
  handler(new Request(`${BASE}/api/access/${path}`, { method: "DELETE", headers }));

interface Listing {
  readonly oauthClients: readonly {
    readonly clientId: string;
    readonly name: string | null;
    readonly activeTokens: number;
  }[];
  readonly sessions: readonly { readonly id: string; readonly current: boolean }[];
}

const OWNER = () => signIn("owner@access.test", "owner-pass-123456");

test("lists the signed-in user's MCP clients and sessions — never a secret", async () => {
  const owner = await OWNER();
  const client = await connectOAuthClient(owner.cookie, "Claude Code");

  const res = await listClients({ cookie: owner.cookie });
  expect(res.status).toBe(200);
  const text = await res.clone().text();
  const listing = (await res.json()) as Listing;

  const listed = listing.oauthClients.find((entry) => entry.clientId === client.clientId);
  expect(listed?.name).toBe("Claude Code");
  expect(listed?.activeTokens).toBeGreaterThan(0);
  expect(listing.sessions.some((session) => session.current)).toBe(true);

  // No bearer material of any kind reaches the browser: not the client's
  // tokens, not the session token, not the cookie value.
  const secrets = [
    client.accessToken,
    client.refreshToken,
    owner.token,
    owner.cookie.split("=")[1] ?? "",
  ].filter((secret) => secret.length > 0);
  expect(secrets.length).toBeGreaterThanOrEqual(3);
  for (const secret of secrets) expect(text).not.toContain(secret);
});

test("answers only the browser session — never an agent credential", async () => {
  const owner = await OWNER();
  const client = await connectOAuthClient(owner.cookie, "Cursor");

  // No credential at all.
  expect((await listClients({})).status).toBe(401);
  // A bearer session (the CLI's shape) and an MCP OAuth token: both refused,
  // even though each authenticates the rest of the API.
  expect((await listClients({ authorization: `Bearer ${owner.token}` })).status).toBe(403);
  expect((await listClients({ authorization: `Bearer ${client.accessToken}` })).status).toBe(403);
  // An API key header, even alongside a valid cookie.
  expect((await listClients({ cookie: owner.cookie, "x-api-key": "anything" })).status).toBe(403);
});

test("revoking an MCP client cuts off its token at once, open session included", async () => {
  const owner = await OWNER();
  const client = await connectOAuthClient(owner.cookie, "Codex");
  expect((await mcpInitialize(client.accessToken)).status).toBe(200);

  const res = await revoke(`oauth-clients/${encodeURIComponent(client.clientId)}`, {
    cookie: owner.cookie,
    origin: BASE,
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { revoked: number }).revoked).toBeGreaterThan(0);

  // The same token no longer opens anything.
  expect((await mcpInitialize(client.accessToken)).status).toBe(401);
  const listing = (await (await listClients({ cookie: owner.cookie })).json()) as Listing;
  expect(listing.oauthClients.some((entry) => entry.clientId === client.clientId)).toBe(false);
});

test("refuses a revoke from another origin, or with none", async () => {
  const owner = await OWNER();
  const client = await connectOAuthClient(owner.cookie, "Cross-origin target");
  const path = `oauth-clients/${encodeURIComponent(client.clientId)}`;

  expect(
    (await revoke(path, { cookie: owner.cookie, origin: "https://evil.example" })).status,
  ).toBe(403);
  expect((await revoke(path, { cookie: owner.cookie })).status).toBe(403);
  // Still connected.
  expect((await mcpInitialize(client.accessToken)).status).toBe(200);
});

test("revokes another session, but not the one making the request", async () => {
  const first = await OWNER();
  const second = await OWNER();
  const listing = (await (await listClients({ cookie: first.cookie })).json()) as Listing;
  const current = listing.sessions.find((session) => session.current);
  const other = listing.sessions.find((session) => !session.current);
  expect(current).toBeDefined();
  expect(other).toBeDefined();

  expect(
    (await revoke(`sessions/${current?.id}`, { cookie: first.cookie, origin: BASE })).status,
  ).toBe(403);

  // Revoke every OTHER session; the second browser is among them.
  for (const session of listing.sessions.filter((s) => !s.current)) {
    const res = await revoke(`sessions/${session.id}`, { cookie: first.cookie, origin: BASE });
    expect(res.status).toBe(200);
  }
  expect((await listClients({ cookie: second.cookie })).status).toBe(401);
  expect((await listClients({ cookie: first.cookie })).status).toBe(200);
});

test("another user's client reads as not found — and stays connected", async () => {
  const bob = await signUpMember("bob@access.test");
  const bobClient = await connectOAuthClient(bob.cookie, "Bob's agent");
  const owner = await OWNER();

  const res = await revoke(`oauth-clients/${encodeURIComponent(bobClient.clientId)}`, {
    cookie: owner.cookie,
    origin: BASE,
  });
  expect(res.status).toBe(404);
  expect((await mcpInitialize(bobClient.accessToken)).status).toBe(200);

  const listing = (await (await listClients({ cookie: owner.cookie })).json()) as Listing;
  expect(listing.oauthClients.some((entry) => entry.clientId === bobClient.clientId)).toBe(false);
});
