import { describe, expect, it } from "@effect/vitest";

import { isAppOwnedPath } from "./app-paths";

// Guards the start.ts dispatch decision: every surface the unified app handler
// serves must be classified app-owned (forwarded to `app.handler`), and Start's
// own routes must NOT be. The `/extensions/*` cases are the regression: the
// React app posts billing calls to `/extensions/billing/route/*` and Swagger
// lives at `/extensions/docs`; both 404 if the dispatcher drops `/extensions/*`.
describe("isAppOwnedPath", () => {
  const appOwned = [
    "/api",
    "/api/executions",
    "/api/auth/me",
    "/api/openapi.json",
    "/extensions/billing/route/customer", // AutumnProvider pathPrefix — the billing UI
    "/extensions/billing/route/attach",
    "/extensions/docs", // Swagger UI
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
  // is distinct from `/extensions/billing/route/*` (the proxy) — only the latter
  // is app-owned.
  const startOwned = ["/", "/policies", "/login", "/billing", "/org", "/assets/app.js"];
  for (const pathname of startOwned) {
    it(`leaves ${pathname} to the Start router`, () => {
      expect(isAppOwnedPath(pathname)).toBe(false);
    });
  }
});
