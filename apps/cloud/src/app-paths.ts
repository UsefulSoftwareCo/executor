import { classifyMcpPath } from "./mcp/mount";

// ---------------------------------------------------------------------------
// Single source of truth for "does the unified app handler own this path?" —
// the decision `start.ts` makes per request (app handler vs TanStack Start).
//
// The app handler (`ExecutorApp.make`'s `toWebHandler`) serves everything under
// `/api/*` — the typed API plus the cloud `extensions.routes` (the Autumn billing
// proxy at `/api/billing/*` and Swagger at `/api/docs` both live under `/api`) —
// plus the `/mcp` serving envelope and its `/.well-known/*` OAuth discovery docs.
// The dispatcher forwards those UNMODIFIED; anything else falls through to the
// Start router. Keeping every served route under `/api` (no separate top-level
// namespace) is what keeps this gate a simple two-prefix check.
// ---------------------------------------------------------------------------

export const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

export const isAppOwnedPath = (pathname: string) =>
  isApiPath(pathname) || classifyMcpPath(pathname) !== null;

// ---------------------------------------------------------------------------
// Which plane serves an app-owned path: the Effect app directly, or TanStack
// Start's middleware chain.
//
// Everything under `/api` is pure Effect and touches no part of the router,
// React, or SSR — so `server.ts` dispatches it at the Worker entry and skips
// Start's lazy `loadEntries` import entirely. Two paths must NOT take that
// shortcut, because Start's request middleware claims them BEFORE the app
// handler would ever see them:
//
//   POST /api/sentry-tunnel  - `sentryTunnelMiddleware` forwards the envelope
//                              to Sentry; the app has no such route.
//   /api/oauth/callback      - `oauthCallbackSignInMiddleware` redirects a
//                              signed-out visitor to /login, and start.ts
//                              rewrites the org-scoped `state` before handing
//                              off. Routing it early would drop both.
//
// Getting this wrong is silent: the request still gets a response, just the
// wrong one, which is why it is classified here and tested rather than being
// an inline condition at the dispatch site.
// ---------------------------------------------------------------------------

export const isStartOwnedApiPath = (pathname: string, method: string): boolean =>
  (pathname === "/api/sentry-tunnel" && method === "POST") || pathname === "/api/oauth/callback";

export const servedByAppPlane = (pathname: string, method: string): boolean =>
  isApiPath(pathname) && !isStartOwnedApiPath(pathname, method);
