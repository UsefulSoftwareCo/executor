// ---------------------------------------------------------------------------
// Realistic reachability smoke test for the composed cloud handler.
//
// Boots the ACTUAL `cloudApiHandler` — `ExecutorApp.make`'s `toWebHandler`, the
// exact handler `start.ts` forwards app-owned requests to — and drives it with
// raw `Request`s to prove every served surface is REACHED, not dropped into a
// 404 / the SPA fallback. This is the integration complement to
// `app-paths.test.ts` (which guards the `start.ts` dispatch decision): together
// they cover both halves of the billing-404 class —
//   - app-paths.test.ts: "does start.ts forward the /api surface to the handler?"
//   - this file:          "does the handler actually serve billing + docs?"
//
// It catches a route being dropped from `makeCloudExtensionRoutes`, the Autumn
// proxy / Swagger being unmounted, the `/api` prefix wiring regressing, etc.
//
// Runs in the workers pool (real workerd) because the composed app transitively
// imports `agents/mcp` (the MCP envelope), which is workerd-only. The asserted
// surfaces short-circuit before any real network I/O: the billing proxy 401s
// before calling Autumn, the protected API 401/403s at the auth gate, and the
// spec / Swagger / discovery docs are static.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

import { cloudApiHandler } from "./app";

const handler = cloudApiHandler().handler;

const call = (method: string, path: string, init: RequestInit = {}) =>
  handler(new Request(`http://test.local${path}`, { method, ...init }));

describe("cloud composed-handler reachability", () => {
  it("serves the Autumn billing proxy (401 JSON, NOT a 404 SPA fallback)", async () => {
    const res = await call("POST", "/api/billing/customer", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // The regression returned the TanStack SPA fallback (200 text/html). The real
    // handler reaches the billing route and rejects the unauthenticated call.
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Unauthorized", code: "unauthorized" });
  });

  it("serves Swagger UI at /api/docs", async () => {
    const res = await call("GET", "/api/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await res.text()).toLowerCase()).toContain("swagger");
  });

  it("serves the OpenAPI spec at /api/openapi.json", async () => {
    const res = await call("GET", "/api/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const spec = (await res.json()) as { paths?: Record<string, unknown> };
    expect(spec.paths).toBeDefined();
    // The spec is prefixed with /api, so a real route like scope is present.
    expect(Object.keys(spec.paths ?? {}).some((p) => p.includes("/scope"))).toBe(true);
  });

  it("reaches the protected API auth gate at /api/scope (error JSON, NOT SPA HTML)", async () => {
    const res = await call("GET", "/api/scope");
    expect([401, 403]).toContain(res.status);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toHaveProperty("code");
  });

  // (The MCP envelope + its /.well-known/* discovery docs are exercised by the
  // mcp-flow / mcp-miniflare suites; the dispatch half is pinned in
  // app-paths.test.ts. They proxy to WorkOS, unreachable from this isolate, so
  // they are not re-asserted here.)
});
