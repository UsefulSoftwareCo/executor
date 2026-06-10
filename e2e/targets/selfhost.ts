// The self-host app as a target: its real dev server (`bunx --bun vite dev`)
// on a throwaway data dir, with Better Auth + the bootstrap admin. MCP OAuth
// is fully headless via the mcporter fork's cookieConsentStrategy. Boot lives
// in setup/selfhost.globalsetup.ts.
import { Effect } from "effect";

import { cookieConsentStrategy } from "../../vendor/mcporter/dist/index.js";

import type { Identity, Target } from "../src/target";

export const SELFHOST_PORT = Number(process.env.E2E_SELFHOST_PORT ?? 4799);
export const SELFHOST_BASE_URL =
  process.env.E2E_SELFHOST_URL ?? `http://localhost:${SELFHOST_PORT}`;

export const SELFHOST_ADMIN = {
  email: process.env.E2E_SELFHOST_ADMIN_EMAIL ?? "admin@e2e.test",
  password: process.env.E2E_SELFHOST_ADMIN_PASSWORD ?? "e2e-admin-password-123",
};

// Sign the bootstrap admin in via Better Auth email and return the session
// cookie in both shapes we need: the `Cookie` header the API surface attaches,
// and the {name,value} list Playwright injects into a browser context. The
// `origin` header is required — Better Auth rejects state-changing requests
// without it.
const signInSession = async (
  baseUrl: string,
  credentials: { readonly email: string; readonly password: string },
): Promise<{
  readonly cookieHeader: string;
  readonly cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}> => {
  const response = await fetch(new URL("/api/auth/sign-in/email", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(baseUrl).origin },
    body: JSON.stringify(credentials),
    redirect: "manual",
  });
  const pairs = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]!.trim());
  if (pairs.length === 0) throw new Error(`selfhost: sign-in set no cookie (${response.status})`);
  const cookies = pairs.map((pair) => {
    const eq = pair.indexOf("=");
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
  });
  return { cookieHeader: pairs.join("; "), cookies };
};

export const selfhostTarget = (): Target => ({
  name: "selfhost",
  baseUrl: SELFHOST_BASE_URL,
  mcpUrl: `${SELFHOST_BASE_URL}/mcp`,
  // No "billing" (no limits). Identity is the bootstrap admin for now —
  // single-tenant; per-test invite-signup isolation is the next step here, so
  // browser scenarios must prefix the resources they create.
  capabilities: new Set(["api", "browser", "mcp-oauth"]),
  newIdentity: () =>
    Effect.promise(async (): Promise<Identity> => {
      // Sign in once and carry the session in both shapes: `headers` for the
      // API surface, `cookies` for an injectable logged-in browser context.
      const { cookieHeader, cookies } = await signInSession(SELFHOST_BASE_URL, SELFHOST_ADMIN);
      return {
        label: SELFHOST_ADMIN.email,
        credentials: SELFHOST_ADMIN,
        headers: { cookie: cookieHeader },
        cookies,
      };
    }),
  mcpConsent: (identity: Identity) =>
    cookieConsentStrategy({
      appBaseUrl: SELFHOST_BASE_URL,
      email: identity.credentials?.email ?? SELFHOST_ADMIN.email,
      password: identity.credentials?.password ?? SELFHOST_ADMIN.password,
    }),
});
