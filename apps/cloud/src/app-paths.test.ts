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
    "/api/billing/customer", // AutumnProvider pathPrefix — the billing UI
    "/api/billing/attach",
    "/api/docs", // Swagger UI
    "/mcp",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
  ];
  for (const pathname of appOwned) {
    it(`forwards ${pathname} to the app handler`, () => {
      expect(isAppOwnedPath(pathname)).toBe(true);
    });
  }

  // Start-owned: the React shell + its routes. Note `/billing` (the React page)
  // is distinct from `/api/billing/*` (the proxy) — only the latter is app-owned.
  const startOwned = ["/", "/policies", "/login", "/billing", "/org", "/assets/app.js"];
  for (const pathname of startOwned) {
    it(`leaves ${pathname} to the Start router`, () => {
      expect(isAppOwnedPath(pathname)).toBe(false);
    });
  }
});
