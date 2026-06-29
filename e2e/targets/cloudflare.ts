// The Cloudflare self-host app (apps/host-cloudflare) as a target: the REAL
// worker on workerd via Miniflare (wrangler `unstable_dev`) with a local D1 +
// R2, booted in setup/cloudflare.globalsetup.ts. Dev-auth is on, so every
// request is the fixed dev admin — no per-identity login and no MCP OAuth (the
// /mcp endpoint accepts the dev principal directly). Single-tenant, like
// self-host; per-test isolation is the next step here.
import { Effect } from "effect";

import { e2ePort } from "../src/ports";
import type { Identity, Target } from "../src/target";

// Offsets 0-4 are taken by cloud (0-3) and self-host (4); Cloudflare claims 5.
export const CLOUDFLARE_PORT = e2ePort("E2E_CLOUDFLARE_PORT", 5);
export const CLOUDFLARE_BASE_URL =
  process.env.E2E_CLOUDFLARE_URL ?? `http://127.0.0.1:${CLOUDFLARE_PORT}`;

export const cloudflareTarget = (): Target => ({
  name: "cloudflare",
  baseUrl: CLOUDFLARE_BASE_URL,
  mcpUrl: `${CLOUDFLARE_BASE_URL}/mcp`,
  // No "billing" and no setAccessTokenTtl (Cloudflare Access is the IdP; not
  // test-adjustable). "mcp-oauth" advertises that the MCP surface exists — but
  // dev-auth means it needs no consent flow, so `mcpConsent` is omitted and the
  // MCP client connects as the dev admin directly.
  capabilities: new Set(["api", "browser", "mcp-oauth"]),
  // Dev-auth: one fixed admin. Empty `headers` makes the API surface send no
  // auth (and skip the Better Auth sign-in path) — the worker resolves every
  // request to the dev admin. No cookie is needed for the browser either.
  newIdentity: () => Effect.succeed({ label: "dev-admin", headers: {} } satisfies Identity),
});
