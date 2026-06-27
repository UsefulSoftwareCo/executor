// The Cloudflare self-host app (apps/host-cloudflare) as a target: the REAL
// worker on workerd via Miniflare (wrangler `unstable_dev`) with a local D1 +
// R2, booted in setup/cloudflare.globalsetup.ts. A loopback Access issuer signs
// application JWTs and serves the team JWKS, so every surface exercises the
// production Access verifier without a Cloudflare account.
import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import {
  accessAssertionHeaders,
  issueCloudflareAccessToken,
} from "../src/cloudflare-access-emulator";
import { e2ePort } from "../src/ports";
import type { Target } from "../src/target";

// Offsets 0-5 are taken by cloud (0-3), self-host (4), and its Docker image (5).
// This target owns the worker at 6 and its Access issuer at 7.
export const CLOUDFLARE_PORT = e2ePort("E2E_CLOUDFLARE_PORT", 6);
export const CLOUDFLARE_BASE_URL =
  process.env.E2E_CLOUDFLARE_URL ?? `http://127.0.0.1:${CLOUDFLARE_PORT}`;
export const CLOUDFLARE_ACCESS_PORT = e2ePort("E2E_CLOUDFLARE_ACCESS_PORT", 7);
export const CLOUDFLARE_ACCESS_BASE_URL =
  process.env.E2E_CLOUDFLARE_ACCESS_URL ?? `http://127.0.0.1:${CLOUDFLARE_ACCESS_PORT}`;

export const makeCloudflareAccessIdentity = async () => {
  const id = randomUUID();
  const email = "admin@e2e.test";
  const token =
    process.env.E2E_CLOUDFLARE_ACCESS_TOKEN ??
    (await issueCloudflareAccessToken(CLOUDFLARE_ACCESS_BASE_URL, {
      kind: "human",
      subject: `user-${id}`,
      email,
      name: `Access user ${id.slice(0, 8)}`,
      groups: ["member"],
    }));
  return {
    label: email,
    headers: accessAssertionHeaders(token),
    cookies: [{ name: "CF_Authorization", value: token }],
  };
};

export const cloudflareTarget = (): Target => ({
  name: "cloudflare",
  baseUrl: CLOUDFLARE_BASE_URL,
  mcpUrl: `${CLOUDFLARE_BASE_URL}/mcp`,
  // No "billing" and no setAccessTokenTtl (Cloudflare Access is the IdP).
  // "mcp-oauth" advertises that the protected MCP surface exists. Access has
  // already authenticated the assertion, so there is no app OAuth consent.
  capabilities: new Set(["api", "browser", "mcp-oauth"]),
  newIdentity: () => Effect.promise(makeCloudflareAccessIdentity),
});
