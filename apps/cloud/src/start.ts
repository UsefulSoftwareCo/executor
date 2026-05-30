import { createMiddleware, createStart } from "@tanstack/react-start";

import { cloudApiHandler } from "./app";
import { marketingMiddleware, posthogProxyMiddleware, sentryTunnelMiddleware } from "./edge";
import { classifyMcpPath } from "./mcp/mount";

// ---------------------------------------------------------------------------
// The unified app web handler — `ExecutorApp.make`'s `toWebHandler` (app.ts).
// It serves EVERY app-owned path in one Effect HTTP layer: the `/api`-prefixed
// typed API (the protected plugin API + account + org + docs + autumn) AND the
// `/mcp` serving envelope + its `/.well-known/*` OAuth discovery docs — exactly
// like self-host's single `toWebHandler`. start.ts no longer hand-routes those
// surfaces; it only decides app-owned-vs-Start and forwards unmodified.
// ---------------------------------------------------------------------------

const app = cloudApiHandler();

// app-owned = the `/api`-prefixed API OR an MCP/OAuth-discovery path. The app
// handler serves these at their real paths (`mountPrefix: "/api"` mounts the
// typed API under `/api`; the MCP envelope mounts `/mcp` + the two discovery
// docs at root), so we forward the request UNMODIFIED — no path stripping.
const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");
const isAppOwned = (pathname: string) => isApiPath(pathname) || classifyMcpPath(pathname) !== null;

const appRequestMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (isAppOwned(pathname)) return app.handler(request);
    return next();
  },
);

// The edge concerns (marketing proxy, sentry tunnel, posthog proxy) live in
// `./edge`; they run before the app's own dispatch. Ordering is load-bearing:
// marketing first (production landing/page proxy), then the analytics tunnels,
// then the unified app plane (api + mcp).
export const startInstance = createStart(() => ({
  requestMiddleware: [
    marketingMiddleware,
    sentryTunnelMiddleware,
    posthogProxyMiddleware,
    appRequestMiddleware,
  ],
}));
