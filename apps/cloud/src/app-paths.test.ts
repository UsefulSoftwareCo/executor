import { describe, expect, it } from "@effect/vitest";

import { isAppOwnedPath, servedByAppPlane, servedByAuthPlane } from "./app-paths";

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

// The auth plane (`app-auth.ts`) is dispatched BEFORE the app plane, so this
// list is load-bearing twice over: a path it claims but the auth handler does
// not mount answers 404 from the wrong router, and a session path it misses
// keeps paying the full app-graph cold start it exists to avoid.
describe("auth-plane dispatch", () => {
  const authPlane = [
    ["GET", "/api/auth/login"],
    ["POST", "/api/auth/logout"],
    ["GET", "/api/auth/callback"],
    ["GET", "/api/auth/cli-login"],
    ["GET", "/api/auth/me"],
    ["GET", "/api/auth/organizations"],
    ["POST", "/api/auth/create-organization"],
    ["POST", "/api/auth/delete-organization"],
    ["GET", "/api/auth/pending-invitations"],
    ["POST", "/api/auth/accept-invitation"],
    ["GET", "/api/mcp-sessions/sess_1/executions/exec_1"],
    ["POST", "/api/mcp-sessions/sess_1/executions/exec_1/resume"],
    ["GET", "/api/org/domains"],
    ["POST", "/api/org/domains/verify-link"],
    ["DELETE", "/api/org/domains/dom_1"],
  ] as const;
  for (const [method, pathname] of authPlane) {
    it(`serves ${method} ${pathname} on the auth plane`, () => {
      expect(servedByAuthPlane(pathname, method)).toBe(true);
      // Still app-owned: the auth plane is a subset of `/api`, not a new namespace.
      expect(servedByAppPlane(pathname, method)).toBe(true);
    });
  }

  // Everything else under `/api` stays on the full app plane. `/api/account/*`
  // is the closest neighbour — it is the shared account API behind the WorkOS
  // AccountProvider, NOT a session route, and it is not mounted here.
  const appPlaneOnly = [
    ["GET", "/api/account/members"],
    ["GET", "/api/connections"],
    ["GET", "/api/docs"],
    ["GET", "/api/openapi.json"],
    ["POST", "/api/billing/attach"],
    ["POST", "/api/webhooks/workos"],
    ["GET", "/api/admin/users"],
  ] as const;
  for (const [method, pathname] of appPlaneOnly) {
    it(`leaves ${method} ${pathname} to the app plane`, () => {
      expect(servedByAuthPlane(pathname, method)).toBe(false);
    });
  }

  it("matches the method as well as the path", () => {
    // `logout` is POST-only; a GET to it is not a route either plane mounts,
    // and must not be claimed by the auth plane's router.
    expect(servedByAuthPlane("/api/auth/logout", "GET")).toBe(false);
    expect(servedByAuthPlane("/api/auth/me", "POST")).toBe(false);
    expect(servedByAuthPlane("/api/org/domains", "DELETE")).toBe(false);
  });

  it("claims no unlisted path under /api/auth", () => {
    expect(servedByAuthPlane("/api/auth/switch-organization", "POST")).toBe(false);
    expect(servedByAuthPlane("/api/auth", "GET")).toBe(false);
  });

  it("matches one segment per route parameter", () => {
    expect(servedByAuthPlane("/api/mcp-sessions/a/executions/b/c", "GET")).toBe(false);
    expect(servedByAuthPlane("/api/org/domains/a/b", "DELETE")).toBe(false);
  });

  it("never overrides a Start-owned path", () => {
    expect(servedByAuthPlane("/api/oauth/callback", "GET")).toBe(false);
    expect(servedByAuthPlane("/api/sentry-tunnel", "POST")).toBe(false);
    expect(servedByAuthPlane("/", "GET")).toBe(false);
    expect(servedByAuthPlane("/mcp", "POST")).toBe(false);
  });
});
