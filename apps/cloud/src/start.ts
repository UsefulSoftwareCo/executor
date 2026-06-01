import { createMiddleware, createStart } from "@tanstack/react-start";

import { cloudApiHandler } from "./app";
import { isAppOwnedPath } from "./app-paths";
import { prepareMcpOrgScope } from "./mcp/mount";
import { marketingMiddleware, posthogProxyMiddleware, sentryTunnelMiddleware } from "./edge";

// ---------------------------------------------------------------------------
// The unified app web handler — `ExecutorApp.make`'s `toWebHandler` (app.ts).
// It serves EVERY app-owned path in one Effect HTTP layer: everything under
// `/api/*` (the protected plugin API + account + org, plus the cloud
// `extensions.routes` — Swagger at `/api/docs`, the Autumn billing proxy at
// `/api/billing/*`), AND the `/mcp` serving envelope + its `/.well-known/*`
// OAuth discovery docs — exactly like self-host's single `toWebHandler`.
// start.ts no longer hand-routes those surfaces; it only decides
// app-owned-vs-Start and forwards (after normalizing org-scoped MCP paths).
// ---------------------------------------------------------------------------

// Instantiate the unified app handler LAZILY, on the first server request that
// needs it. This is load-bearing for the CLIENT bundle: TanStack Start bundles
// `start.ts` into the browser build but strips `.server()` callback *bodies*, so
// any symbol referenced only inside a server callback is tree-shaken out of the
// client. A module-top-level `cloudApiHandler()` would instead survive that
// stripping and drag `./app` → `observability/telemetry` → `cloudflare:workers`
// (a workerd-only virtual module) into the browser build, breaking it. Keeping
// the call inside the server callback mirrors how every other server concern
// here stays server-only.
let app: ReturnType<typeof cloudApiHandler> | undefined;
const getApp = () => (app ??= cloudApiHandler());

// app-owned = anything under `/api/*` (incl. the cloud extension routes) OR an
// MCP/OAuth-discovery path (see `./app-paths`). The app handler serves these at
// their real paths, so we forward unmodified — except `prepareMcpOrgScope`
// rewrites an org-scoped MCP path (`/org_xxx/mcp`) to the bare path the shared
// envelope routes, pinning the org in an internal header (a no-op for everything
// else, including `/api/*`).
const appRequestMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (isAppOwnedPath(pathname)) return getApp().handler(prepareMcpOrgScope(request));
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
