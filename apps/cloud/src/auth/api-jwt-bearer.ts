// ---------------------------------------------------------------------------
// The `/api/*` plane's WorkOS JWT bearer config.
//
// The protected HTTP API accepts THREE credential forms on the `Authorization`
// header, in this precedence: a WorkOS access-token JWT (CLI device-login,
// `executor login`), then a WorkOS API key, then — with no header — the
// sealed-session cookie. This module supplies the JWT-verification config
// (JWKS + issuer + audience) the JWT branch needs.
//
// It mirrors the MCP plane's setup (`mcp/auth.ts`): the SAME AuthKit JWKS,
// issuer (`MCP_AUTHKIT_DOMAIN`), and audience (`WORKOS_CLIENT_ID`). A device
// access token minted by AuthKit is byte-for-byte the same kind of token the
// MCP plane already verifies, so a CLI can hold ONE credential for both planes.
//
// This is the `cloudflare:workers`-reading leaf; `workos-auth-provider.ts`
// stays env-free and receives this config as a plain value, so its node-pool
// resolver tests can inject a local JWKS instead.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";

import { createCachedRemoteJWKSet } from "./jwks-cache";
import type { JwtBearerConfig } from "./workos-auth-provider";

const AUTHKIT_DOMAIN = env.MCP_AUTHKIT_DOMAIN ?? "https://signin.executor.sh";

// Module-scope cache, same rationale as `mcp/auth.ts`: one JWKS fetch per
// isolate-hour rather than one per cold isolate. The two caches (here + MCP)
// are independent module scopes hitting the same upstream; the 1h TTL keeps
// the duplication cheap.
export const workosApiJwtBearerConfig: JwtBearerConfig = {
  jwks: createCachedRemoteJWKSet(new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`)),
  issuer: AUTHKIT_DOMAIN,
  audience: env.WORKOS_CLIENT_ID,
};
