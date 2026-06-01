import { createMiddleware, createStart } from "@tanstack/react-start";

import { cloudApiHandler } from "./app";
import { isAppOwnedPath } from "./app-paths";
import { marketingMiddleware, posthogProxyMiddleware, sentryTunnelMiddleware } from "./edge";

// ---------------------------------------------------------------------------
// The unified app web handler — `ExecutorApp.make`'s `toWebHandler` (app.ts).
// It serves EVERY app-owned path in one Effect HTTP layer: everything under
// `/api/*` (the protected plugin API + account + org, plus the cloud
// `extensions.routes` — Swagger at `/api/docs`, the Autumn billing proxy at
// `/api/billing/*`), AND the `/mcp` serving envelope + its `/.well-known/*`
// OAuth discovery docs — exactly like self-host's single `toWebHandler`.
// start.ts no longer hand-routes those surfaces; it only decides
// app-owned-vs-Start and forwards unmodified.
// ---------------------------------------------------------------------------

const app = cloudApiHandler();

// app-owned = anything under `/api/*` (incl. the cloud extension routes) OR an
// MCP/OAuth-discovery path (see `./app-paths`). The app handler serves these at
// their real paths, so we forward the request UNMODIFIED — no path stripping.
const appRequestMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (isAppOwnedPath(pathname)) return app.handler(request);
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
