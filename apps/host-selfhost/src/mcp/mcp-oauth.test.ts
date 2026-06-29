import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-env-"));
process.env.BETTER_AUTH_SECRET = "env-test-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@env.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

test("serves OAuth Authorization Server metadata at the origin root", async () => {
  const res = await handler(new Request(`${BASE}/.well-known/oauth-authorization-server`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.issuer).toBeDefined();
  // mcp() advertises its DCR + authorize + token endpoints under /api/auth/mcp.
  expect(String(body.authorization_endpoint)).toContain("/api/auth/mcp/authorize");
  expect(String(body.token_endpoint)).toContain("/api/auth/mcp/token");
  expect(String(body.registration_endpoint)).toContain("/api/auth/mcp/register");
});

test("serves OAuth Protected Resource metadata at the origin root", async () => {
  const res = await handler(new Request(`${BASE}/.well-known/oauth-protected-resource`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.resource).toBeDefined();
  expect(Array.isArray(body.authorization_servers)).toBe(true);
});

test("serves OAuth Protected Resource metadata for a toolkit MCP resource", async () => {
  const res = await handler(
    new Request(`${BASE}/.well-known/oauth-protected-resource/mcp/toolkits/deploy`),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.resource).toBe(`${BASE}/mcp/toolkits/deploy`);
  expect(Array.isArray(body.authorization_servers)).toBe(true);
});

test("an unauthenticated /mcp request returns 401 with a WWW-Authenticate challenge", async () => {
  const res = await handler(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }),
  );
  expect(res.status).toBe(401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  expect(challenge).toContain("Bearer");
  expect(challenge).toContain("resource_metadata=");
});

test("an unauthenticated toolkit MCP request challenges with toolkit metadata", async () => {
  const res = await handler(
    new Request(`${BASE}/mcp/toolkits/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }),
  );
  expect(res.status).toBe(401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  expect(challenge).toContain("Bearer");
  expect(challenge).toContain(
    `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/toolkits/deploy"`,
  );
});

// --- End-to-end MCP OAuth: DCR -> authorize -> token -> /mcp with bearer ---
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

const signUp = async (email: string): Promise<string> => {
  const inviteCode = await mintInviteCode(handler);
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-12345678", name: email, inviteCode }),
    }),
  );
  expect(res.status).toBe(200);
  // The session cookie lets /mcp/authorize skip the interactive login.
  return res.headers.get("set-cookie") ?? "";
};

const b64url = (buf: Uint8Array): string =>
  btoa(String.fromCharCode(...buf))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

test("MCP OAuth opaque-bearer flow authenticates /mcp end-to-end", async () => {
  const cookie = await signUp("oauth@env.test");

  // 1. Dynamic client registration (public/PKCE client).
  const reg = await handler(
    new Request(`${BASE}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "test-client",
        redirect_uris: ["http://localhost:9999/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    }),
  );
  expect([200, 201]).toContain(reg.status);
  const clientId = String((await json(reg)).client_id);

  // 2. PKCE authorize with the signed-in session cookie. Self-host forces an
  // approval screen (prompt=consent injected by the serving layer), so authorize
  // does NOT redirect straight to the client callback — it redirects to the
  // relative /mcp-consent page carrying a consent_code. A real client's browser
  // lands there and the user clicks Allow; we drive that POST directly.
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const codeChallenge = b64url(challengeBytes);
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
  // Resolve against BASE — the consent redirect is a relative app path.
  const consentRedirect = new URL(authorize.headers.get("location") ?? "", BASE);
  expect(consentRedirect.pathname).toBe("/mcp-consent");
  const consentCode = consentRedirect.searchParams.get("consent_code") ?? "";
  expect(consentCode).not.toBe("");

  // 2b. Approve on the consent screen — the same POST the /mcp-consent page makes.
  // It returns { redirectURI } back to the client's callback carrying the code.
  const consent = await handler(
    new Request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    }),
  );
  expect(consent.status).toBe(200);
  const redirectURI = String((await json(consent)).redirectURI ?? "");
  const code = new URL(redirectURI).searchParams.get("code") ?? "";
  expect(code).not.toBe("");

  // 3. Token exchange.
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
  const accessToken = String((await json(token)).access_token);
  expect(accessToken).not.toBe("");

  // 4. The opaque access token authenticates /mcp (initialize succeeds).
  const init = await handler(
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
  expect(init.status).toBe(200);
  expect(init.headers.get("mcp-session-id")).not.toBe(null);
});
