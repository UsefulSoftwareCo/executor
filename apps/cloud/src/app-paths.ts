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

// ---------------------------------------------------------------------------
// Which paths the AUTH plane serves (`app-auth.ts`), ahead of the app plane.
//
// The app plane is `ExecutorApp.make`'s single handler: one `HttpApiBuilder`
// router built in one pass, so the first `/api/*` request in an isolate
// evaluates the plugin + OpenAPI + MCP + GraphQL catalogs, the execution
// substrate and Swagger — cold p50 ~2.2s against ~120ms warm, on ~31% of
// requests. The session routes need none of that, so they get their own small
// handler and `server.ts` tries this classifier first.
//
// It is an EXACT allowlist rather than an `/api/auth/` prefix test, because the
// two planes 404 differently: a path this claims but `app-auth.ts` does not
// mount would answer from the wrong router. Every entry below is a route
// `makeSessionRoutes` / `makeOrgRoutes` register — keep them in step.
// ---------------------------------------------------------------------------

// A Map, not an object literal: the method comes off the wire, and an object
// would resolve `constructor` (a legal HTTP token) to `Object` and then throw.
const AUTH_PLANE_EXACT_PATHS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // CloudAuthPublicApi (no session required) + the read side of CloudAuthApi.
  [
    "GET",
    new Set([
      "/api/auth/login",
      "/api/auth/callback",
      "/api/auth/cli-login",
      "/api/auth/me",
      "/api/auth/organizations",
      "/api/auth/pending-invitations",
      "/api/org/domains",
    ]),
  ],
  [
    "POST",
    new Set([
      "/api/auth/logout",
      "/api/auth/create-organization",
      "/api/auth/delete-organization",
      "/api/auth/accept-invitation",
      "/api/org/domains/verify-link",
    ]),
  ],
]);

// The parameterised routes. `:mcpSessionId` / `:executionId` / `:domainId` are
// single path segments, so an anchored one-segment match is the same grammar
// the Effect router applies.
const MCP_APPROVAL_GET = /^\/api\/mcp-sessions\/[^/]+\/executions\/[^/]+$/;
const MCP_APPROVAL_RESUME = /^\/api\/mcp-sessions\/[^/]+\/executions\/[^/]+\/resume$/;
const ORG_DOMAIN_DELETE = /^\/api\/org\/domains\/[^/]+$/;

/**
 * Does the small auth-plane handler serve this request?
 *
 * Gated on `servedByAppPlane` first so the Start-owned `/api` paths keep their
 * route no matter what this list says — the auth plane must never be a second
 * way to lose `sentryTunnelMiddleware` or the signed-out OAuth redirect.
 */
export const servedByAuthPlane = (pathname: string, method: string): boolean => {
  if (!servedByAppPlane(pathname, method)) return false;
  if (AUTH_PLANE_EXACT_PATHS.get(method)?.has(pathname) === true) return true;
  if (method === "GET") return MCP_APPROVAL_GET.test(pathname);
  if (method === "POST") return MCP_APPROVAL_RESUME.test(pathname);
  if (method === "DELETE") return ORG_DOMAIN_DELETE.test(pathname);
  return false;
};
