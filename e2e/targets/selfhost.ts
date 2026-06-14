// The self-host app as a target: its real dev server (`bunx --bun vite dev`)
// on a throwaway data dir, with Better Auth + the bootstrap admin. MCP OAuth is
// headless via `forcedMcpConsent` below. Boot lives in
// setup/selfhost.globalsetup.ts.
import { Effect } from "effect";

import { e2ePort } from "../src/ports";
import type { Identity, Target } from "../src/target";

export const SELFHOST_PORT = e2ePort("E2E_SELFHOST_PORT", 4);
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
export const signInSession = async (
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

// Headless MCP OAuth consent. The self-host serving layer forces
// `prompt=consent` on every MCP authorize (src/auth/force-mcp-consent), so an
// authenticated authorize no longer redirects straight to the callback with a
// `code` — it stops on the `/mcp-consent` approval screen with a `consent_code`.
// mcporter's `cookieConsentStrategy` only handles the old direct-code redirect,
// so this completes the screen the way the page does: sign in, drive authorize,
// then POST the same `/api/auth/oauth2/consent` grant the Allow button fires.
const forcedMcpConsent =
  (baseUrl: string, credentials: { readonly email: string; readonly password: string }) =>
  async ({ authorizationUrl }: { authorizationUrl: string }): Promise<{ code: string }> => {
    const origin = new URL(baseUrl).origin;
    const { cookieHeader } = await signInSession(baseUrl, credentials);

    const authorize = await fetch(authorizationUrl, {
      headers: { cookie: cookieHeader },
      redirect: "manual",
    });
    const location = authorize.headers.get("location");
    if (!location) {
      throw new Error(`forcedMcpConsent: authorize did not redirect (status ${authorize.status})`);
    }
    // The consent redirect is relative (`/mcp-consent?...`) — resolve it against
    // the instance origin. If the server issued a code directly (consent not
    // forced), use it; otherwise complete the forced approval below.
    const redirect = new URL(location, baseUrl);
    const direct = redirect.searchParams.get("code");
    if (direct) return { code: direct };
    const consentCode = redirect.searchParams.get("consent_code");
    if (!consentCode) {
      throw new Error(`forcedMcpConsent: no consent_code in authorize redirect: ${location}`);
    }

    const decision = await fetch(new URL("/api/auth/oauth2/consent", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie: cookieHeader },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    });
    if (!decision.ok) {
      throw new Error(`forcedMcpConsent: consent grant failed (status ${decision.status})`);
    }
    const body = (await decision.json()) as { redirectURI?: string };
    const code = body.redirectURI ? new URL(body.redirectURI).searchParams.get("code") : null;
    if (!code) {
      throw new Error(
        `forcedMcpConsent: no code in consent redirect: ${body.redirectURI ?? "(none)"}`,
      );
    }
    return { code };
  };

export const selfhostTarget = (): Target => ({
  name: "selfhost",
  baseUrl: SELFHOST_BASE_URL,
  mcpUrl: `${SELFHOST_BASE_URL}/mcp`,
  // No "billing" (no limits) and no setAccessTokenTtl yet (Better Auth is the
  // authorization server; its token TTL isn't test-adjustable, so token-expiry
  // scenarios skip here). Identity is the bootstrap admin for now —
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
    forcedMcpConsent(SELFHOST_BASE_URL, {
      email: identity.credentials?.email ?? SELFHOST_ADMIN.email,
      password: identity.credentials?.password ?? SELFHOST_ADMIN.password,
    }),
});
