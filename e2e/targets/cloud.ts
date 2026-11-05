// The cloud app as a target: its real dev server with the real WorkOS and
// Autumn SDKs pointed at emulators (WORKOS_API_URL / AUTUMN_API_URL — see
// setup/cloud.globalsetup.ts). Identities are minted through the REAL login
// flow: /api/auth/login → emulator hosted AuthKit (headless via login_hint) →
// /api/auth/callback → genuine sealed-session cookie. Isolation: every
// identity is a fresh user (and org) — no resets.
//
// v1 creates no organizations (new ones are created in Executor v2), so an
// identity's organization is seeded in WorkOS — the system of record v1
// mirrors at sign-in — exactly as every existing v1 organization lives there,
// and the sign-in lands the session in it.
import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import { connectEmulator } from "@executor-js/emulate";

import { e2ePort } from "../src/ports";
import type { Identity, Target } from "../src/target";

export const CLOUD_PORT = e2ePort("E2E_CLOUD_PORT", 0);
export const CLOUD_DB_PORT = e2ePort("E2E_CLOUD_DB_PORT", 1);
export const CLOUD_BASE_URL = process.env.E2E_CLOUD_URL ?? `http://localhost:${CLOUD_PORT}`;
export const WORKOS_EMULATOR_PORT = e2ePort("E2E_WORKOS_EMULATOR_PORT", 2);
export const AUTUMN_EMULATOR_PORT = e2ePort("E2E_AUTUMN_EMULATOR_PORT", 3);
export const E2E_WORKOS_CLIENT_ID = "client_e2e_emulate";
export const E2E_COOKIE_PASSWORD = "e2e_cookie_password_0123456789abcdef0123456789abcdef";

const cookiePair = (response: Response, name: string): string | undefined => {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    if (header.startsWith(`${name}=`)) return header.split(";")[0];
  }
  return undefined;
};

/** The WorkOS emulator the app's own WorkOS client talks to. */
const workosEmulator = () =>
  connectEmulator({ baseUrl: `http://127.0.0.1:${WORKOS_EMULATOR_PORT}` });

/**
 * An organization named `name` in WorkOS with `email` (created if new) as its
 * admin, through the emulator's seed. The app sees it at the user's next
 * sign-in, which mirrors every organization the user belongs to.
 */
export const seedOrganization = async (email: string, name: string): Promise<void> => {
  const workos = await workosEmulator();
  await workos.seed({ organizations: [{ name, members: [email] }] });
};

/**
 * The real product login, headless: login → hosted AuthKit → callback.
 * `returnTo` (an org's `/<slug>`) lands the session in that organization, as
 * the login the dashboard sends a signed-out visitor through does.
 */
export const signIn = async (email: string, returnTo?: string): Promise<string> => {
  const loginUrl = new URL("/api/auth/login", CLOUD_BASE_URL);
  if (returnTo !== undefined) loginUrl.searchParams.set("returnTo", returnTo);
  const login = await fetch(loginUrl, { redirect: "manual" });
  const stateCookie = cookiePair(login, "wos-login-state");
  const location = login.headers.get("location");
  if (!stateCookie || !location) {
    throw new Error(`cloud signIn: login did not redirect to AuthKit (${login.status})`);
  }
  const authorizeUrl = new URL(location);
  if (!authorizeUrl.searchParams.get("state")) {
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

/** The URL slug of the organization this session is signed in to. */
const sessionOrgSlug = async (session: string): Promise<string> => {
  const response = await fetch(new URL("/api/auth/me", CLOUD_BASE_URL), {
    headers: { cookie: session },
  });
  if (!response.ok) throw new Error(`cloud newIdentity: /api/auth/me failed (${response.status})`);
  const body = (await response.json()) as { organization: { slug: string } | null };
  if (!body.organization) throw new Error("cloud newIdentity: the session has no organization");
  return body.organization.slug;
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
      const workos = await workosEmulator();
      await workos.seed({ oauth: { default_access_token_ttl_seconds: seconds } });
    }),
  newIdentity: ({ org = true } = {}) =>
    Effect.promise(async (): Promise<Identity> => {
      const label = `user-${randomUUID().slice(0, 8)}`;
      const email = `${label}@e2e.test`;
      if (org) await seedOrganization(email, `Org ${label}`);
      // The seeded organization is the user's only membership, so the
      // sign-in lands the session in it.
      const session = await signIn(email);
      const orgSlug = org ? await sessionOrgSlug(session) : null;
      const [name, value] = session.split(/=(.*)/s);
      return {
        label: email,
        // The org selector header rides along exactly as the web client sends
        // it from the console URL's slug: org-scoped API reads fail closed
        // without it (no session-org fallback).
        headers: {
          cookie: session,
          ...(orgSlug ? { "x-executor-organization": orgSlug } : {}),
        },
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
