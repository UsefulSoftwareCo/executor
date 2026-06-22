// ---------------------------------------------------------------------------
// The `/api/*` plane's WorkOS device-login (user_management) JWT bearer config.
//
// The protected HTTP API accepts THREE credential forms on the `Authorization`
// header, in this precedence: a WorkOS device-login access token (JWT, from
// `executor login`), then a WorkOS API key, then, with no header, the
// sealed-session cookie. This module supplies the JWKS the JWT branch verifies
// against.
//
// CRITICAL: a device-login token is a WorkOS *user_management* access token,
// signed by the SSO keyset served at `<workos-api>/sso/jwks/<clientId>` with NO
// audience and a user_management issuer. That is a DIFFERENT key domain than the
// MCP `/oauth2` tokens (verified via the AuthKit `/oauth2/jwks`): the device
// token's key is not in the oauth2 JWKS, so we must verify it against the
// client-scoped SSO JWKS instead (signature + expiry; see
// `verifyWorkosUserManagementToken`). `WORKOS_API_URL` is api.workos.com in
// production and the WorkOS emulator in tests.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";

import { createCachedRemoteJWKSet } from "./jwks-cache";
import type { JwtBearerConfig } from "./workos-auth-provider";

const WORKOS_API_BASE = (env.WORKOS_API_URL ?? "https://api.workos.com").replace(/\/+$/, "");

// Module-scope cache, same rationale as `mcp/auth.ts`: one JWKS fetch per
// isolate-hour rather than one per cold isolate.
export const workosApiJwtBearerConfig: JwtBearerConfig = {
  jwks: createCachedRemoteJWKSet(new URL(`${WORKOS_API_BASE}/sso/jwks/${env.WORKOS_CLIENT_ID}`)),
};
