// The cloud app as a target: its real dev server with the real WorkOS and
// Autumn SDKs pointed at emulators (WORKOS_API_URL / AUTUMN_API_URL — see
// setup/cloud.globalsetup.ts). Identities are minted through the REAL login
// flow: /api/auth/login → emulator hosted AuthKit (headless via login_hint) →
// /api/auth/callback → genuine sealed-session cookie. Isolation: every
// identity is a fresh user (and org) — no resets.
import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import type { Identity, Target } from "../src/target";

export const CLOUD_PORT = Number(process.env.E2E_CLOUD_PORT ?? 4798);
export const CLOUD_DB_PORT = Number(process.env.E2E_CLOUD_DB_PORT ?? 5436);
export const CLOUD_BASE_URL = process.env.E2E_CLOUD_URL ?? `http://127.0.0.1:${CLOUD_PORT}`;
export const WORKOS_EMULATOR_PORT = Number(process.env.E2E_WORKOS_EMULATOR_PORT ?? 4914);
export const AUTUMN_EMULATOR_PORT = Number(process.env.E2E_AUTUMN_EMULATOR_PORT ?? 4915);
export const E2E_WORKOS_CLIENT_ID = "client_e2e_emulate";
export const E2E_COOKIE_PASSWORD = "e2e_cookie_password_0123456789abcdef0123456789abcdef";

const cookiePair = (response: Response, name: string): string | undefined => {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    if (header.startsWith(`${name}=`)) return header.split(";")[0];
  }
  return undefined;
};

/** The real product login, headless: login → hosted AuthKit → callback. */
const signIn = async (email: string): Promise<string> => {
  const login = await fetch(new URL("/api/auth/login", CLOUD_BASE_URL), { redirect: "manual" });
  const stateCookie = cookiePair(login, "wos-login-state");
  const authorizeUrl = new URL(login.headers.get("location") ?? "");
  if (!stateCookie || !authorizeUrl.searchParams.get("state")) {
    throw new Error(`cloud signIn: login did not redirect to AuthKit (${login.status})`);
  }
  // The emulator's hosted login signs in headlessly via login_hint (creating
  // the user if new) and redirects back with a code.
  authorizeUrl.searchParams.set("login_hint", email);
  const consent = await fetch(authorizeUrl, { redirect: "manual" });
  const callbackUrl = consent.headers.get("location");
  if (consent.status !== 302 || !callbackUrl) {
    throw new Error(`cloud signIn: AuthKit emulator did not redirect (${consent.status})`);
  }
  const callback = await fetch(callbackUrl, {
    redirect: "manual",
    headers: { cookie: stateCookie },
  });
  const session = cookiePair(callback, "wos-session");
  if (!session) throw new Error(`cloud signIn: callback set no session (${callback.status})`);
  return session; // "wos-session=<sealed>"
};

export const cloudTarget = (): Target => ({
  name: "cloud",
  baseUrl: CLOUD_BASE_URL,
  mcpUrl: `${CLOUD_BASE_URL}/mcp`,
  capabilities: new Set(["api", "browser", "billing", "mcp-oauth"]),
  // Cloud's authorization server is the WorkOS emulator, so token-expiry
  // scenarios can compress the lifecycle (the TtlControl service).
  setAccessTokenTtl: (seconds) =>
    Effect.promise(async () => {
      const response = await fetch(`http://127.0.0.1:${WORKOS_EMULATOR_PORT}/_emulate/seed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oauth: { default_access_token_ttl_seconds: seconds } }),
      });
      if (!response.ok) throw new Error(`seeding emulator TTL failed (${response.status})`);
    }),
  newIdentity: ({ org = true } = {}) =>
    Effect.promise(async (): Promise<Identity> => {
      const label = `user-${randomUUID().slice(0, 8)}`;
      const email = `${label}@e2e.test`;
      let session = await signIn(email);
      if (org) {
        // The real create-organization flow; the refreshed sealed session in
        // the response carries the new org.
        const response = await fetch(new URL("/api/auth/create-organization", CLOUD_BASE_URL), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: new URL(CLOUD_BASE_URL).origin,
            cookie: session,
          },
          body: JSON.stringify({ name: `Org ${label}` }),
        });
        if (!response.ok) {
          throw new Error(`cloud newIdentity: create-organization failed (${response.status})`);
        }
        session = cookiePair(response, "wos-session") ?? session;
      }
      const [name, value] = session.split(/=(.*)/s);
      return {
        label: email,
        headers: { cookie: session },
        cookies: [{ name: name!, value: value! }],
        credentials: { email, password: "emulated" },
      };
    }),
  // MCP OAuth against the emulator's authorization server: complete the
  // hosted flow headlessly as this identity.
  mcpConsent: (identity) => async (request) => {
    const authorizeUrl = new URL(request.authorizationUrl);
    authorizeUrl.searchParams.set("login_hint", identity.credentials?.email ?? "mcp@e2e.test");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status !== 302 || !location) {
      throw new Error(`cloud mcpConsent: authorize did not redirect (${response.status})`);
    }
    const code = new URL(location).searchParams.get("code");
    if (!code) throw new Error("cloud mcpConsent: no code in redirect");
    return { code };
  },
});
