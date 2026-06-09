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

export const selfhostTarget = (): Target => ({
  name: "selfhost",
  baseUrl: SELFHOST_BASE_URL,
  mcpUrl: `${SELFHOST_BASE_URL}/mcp`,
  // No "billing" (no limits) and no "browser" yet (cookie injection for the
  // Better Auth session isn't wired). Identity is the bootstrap admin for now —
  // single-tenant; per-test invite-signup isolation is the next step here.
  capabilities: new Set(["api", "mcp-oauth"]),
  newIdentity: () =>
    Effect.succeed<Identity>({
      label: SELFHOST_ADMIN.email,
      credentials: SELFHOST_ADMIN,
    }),
  mcpConsent: (identity: Identity) =>
    cookieConsentStrategy({
      appBaseUrl: SELFHOST_BASE_URL,
      email: identity.credentials?.email ?? SELFHOST_ADMIN.email,
      password: identity.credentials?.password ?? SELFHOST_ADMIN.password,
    }),
});
