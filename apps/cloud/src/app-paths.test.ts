import { describe, expect, it } from "@effect/vitest";

import { isAppOwnedPath, servedByAppPlane } from "./app-paths";

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

describe("app-plane dispatch", () => {
  // These two are the whole risk of dispatching `/api` before Start: both still
  // return a response if routed early, just the wrong one, so nothing else would
  // catch a regression here.
  it("leaves the Sentry tunnel POST to Start's middleware", () => {
    expect(servedByAppPlane("/api/sentry-tunnel", "POST")).toBe(false);
    // Only the POST is claimed; anything else under that path is ordinary API.
    expect(servedByAppPlane("/api/sentry-tunnel", "GET")).toBe(true);
  });

  it("leaves the OAuth callback to Start, for the signed-out redirect", () => {
    expect(servedByAppPlane("/api/oauth/callback", "GET")).toBe(false);
    expect(servedByAppPlane("/api/oauth/callback", "POST")).toBe(false);
  });

  const appPlane = [
    "/api/connections",
    "/api/tools",
    "/api/integrations",
    "/api/account/members",
    "/api/docs",
    "/api/billing/checkout",
  ];
  for (const pathname of appPlane) {
    it(`serves ${pathname} without entering Start`, () => {
      expect(servedByAppPlane(pathname, "GET")).toBe(true);
    });
  }

  it("never claims a non-API path, however app-owned", () => {
    expect(servedByAppPlane("/mcp", "POST")).toBe(false);
    expect(servedByAppPlane("/", "GET")).toBe(false);
    expect(servedByAppPlane("/.well-known/oauth-authorization-server", "GET")).toBe(false);
  });
});
