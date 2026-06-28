import { describe, expect, it } from "@effect/vitest";

import { isAppOwnedPath } from "./app-paths";

// Guards the start.ts dispatch decision: every surface the unified app handler
// serves must be classified app-owned (forwarded to `app.handler`), and Start's
// own routes must NOT be. The billing proxy + Swagger live under `/api`
// (`/api/billing/*`, `/api/docs`) — the React app posts to `/api/billing/*` via
// <AutumnProvider> — so a request there must reach the handler, not the SPA.
describe("isAppOwnedPath", () => {
  const appOwned = [
    "/api",
    "/api/executions",
    "/api/auth/me",
    "/api/openapi.json",
    "/api/oauth/client-id-metadata/default.json",
    "/api/billing/customer", // AutumnProvider pathPrefix — the billing UI
    "/api/billing/attach",
    "/api/docs", // Swagger UI
    "/mcp",
    "/mcp/toolkits/deploy-kit",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/mcp/toolkits/deploy-kit",
    "/.well-known/oauth-authorization-server",
    // Org-pinned MCP: the org's URL slug (what the install card prints) and
    // the legacy WorkOS org-id form both select an org on the MCP plane.
    "/acme-corp/mcp",
    "/acme-corp/mcp/toolkits/deploy-kit",
    "/org_01ABCDEF/mcp",
    "/org_01ABCDEF/mcp/toolkits/deploy-kit",
    "/.well-known/oauth-protected-resource/acme-corp/mcp",
    "/.well-known/oauth-protected-resource/acme-corp/mcp/toolkits/deploy-kit",
    "/.well-known/oauth-protected-resource/org_01ABCDEF/mcp",
    "/.well-known/oauth-protected-resource/org_01ABCDEF/mcp/toolkits/deploy-kit",
  ];
  for (const pathname of appOwned) {
    it(`forwards ${pathname} to the app handler`, () => {
      expect(isAppOwnedPath(pathname)).toBe(true);
    });
  }

  // Start-owned: the React shell + its routes. Note `/billing` (the React page)
  // is distinct from `/api/billing/*` (the proxy) — only the latter is app-owned.
  // `/settings/mcp` guards the slug-selector grammar: a RESERVED first segment
  // can never be an org slug, so console-route-shaped paths ending in /mcp fall
  // through to the SPA instead of being swallowed by the MCP plane.
  const startOwned = [
    "/",
    "/policies",
    "/login",
    "/billing",
    "/org",
    "/assets/app.js",
    "/settings/mcp",
    "/settings/mcp/toolkits/deploy-kit",
    "/integrations/mcp",
    "/integrations/mcp/toolkits/deploy-kit",
  ];
  for (const pathname of startOwned) {
    it(`leaves ${pathname} to the Start router`, () => {
      expect(isAppOwnedPath(pathname)).toBe(false);
    });
  }
});
